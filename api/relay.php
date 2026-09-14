<?php
require_once __DIR__ . '/../includes/helpers.php';
oc_boot(false);   // 不預先設定 Content-Type：chat 要送 SSE，其餘 action 自行宣告 JSON

// ═══════════════════════════════════════════════════════════════
// Omni Code — AI 中繼 / 網路（ARCHITECTURE.md §5）
// ═══════════════════════════════════════════════════════════════
// 為什麼需要這支中繼？前端預設是 direct 直連供應商（最快、金鑰不離開瀏覽器），
// 但有三件事瀏覽器自己做不到或做不好：
//
//  1. CORS —— Gemini / OpenAI / OpenRouter / Anthropic 的端點未必允許
//     從 http://localhost 的 XHR 讀取回應；WebFetch / WebSearch 抓的一般網站
//     更是幾乎全部擋 CORS。走本機 PHP 就沒有同源限制。
//  2. 統一串流 —— 四家供應商的 SSE 位元組流在這裡「原樣直通」（不解析、不重組），
//     前端 api.js 只需要一套 sseEvents() 解析器；同時由後端負責關閉所有輸出
//     緩衝（PHP ob / zlib / proxy），確保 token 是逐塊即時抵達而非整包才吐。
//  3. 供應商錯誤外顯 —— 上游若回 4xx/5xx，body 是 JSON 而不是 SSE，
//     直通會讓前端解析器啞掉。這裡改為緩衝後包成單一 `event: oc_error`
//     事件送出，前端就能把供應商的原始錯誤訊息（額度用盡、金鑰無效…）
//     直接顯示給使用者。
//
// 安全：chat / json 的 url 主機必須落在 $OC_API_HOSTS 或 config 的
// extraApiHosts，避免這支端點變成開放代理。fetch / search 不限網域，
// 但擋掉私有網段（§5）。整支服務另有 oc_guard_local() 只收本機連線。
// ═══════════════════════════════════════════════════════════════

define('OC_RELAY_MAX_FETCH_BYTES', 5 * 1024 * 1024);   // fetch 單頁抓取上限 5MB
define('OC_RELAY_UA', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                    . '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');

$action = oc_arg('action', '');

// chat 以外的 action 一律回 JSON 封套（因為 oc_boot(false) 沒有預設標頭）
if ($action !== 'chat') header('Content-Type: application/json; charset=utf-8');

switch ($action) {

    // ─── AI 串流直通（SSE，不套 JSON 封套）────────────────────
    case 'chat':   oc_act_chat();   break;

    // ─── AI 非串流（上游 JSON 原樣回傳）───────────────────────
    case 'json':   oc_act_json();   break;

    // ─── WebFetch：抓網頁轉純文字 / markdown ──────────────────
    case 'fetch':  oc_act_fetch();  break;

    // ─── WebSearch：DuckDuckGo ────────────────────────────────
    case 'search': oc_act_search(); break;

    default:
        oc_fail('未知的 action: ' . $action, 404);
}

// ═══════════════════════════════════════════════════════════════
// 共用：URL 與網域驗證
// ═══════════════════════════════════════════════════════════════

// 取出並驗證 url 參數（必須是 http/https 絕對網址）
function oc_relay_url($key = 'url') {
    $url = trim((string)oc_arg($key, ''));
    if ($url === '') oc_fail('缺少必要參數 url', 400);
    if (!preg_match('#^https?://#i', $url)) oc_fail('url 必須是 http:// 或 https:// 開頭', 400);
    $host = parse_url($url, PHP_URL_HOST);
    if (!$host) oc_fail('無法解析的 url：' . $url, 400);
    return $url;
}

// chat / json 專用：主機必須在供應商白名單內，避免變成開放代理
function oc_relay_guard_host($url) {
    global $OC_API_HOSTS;
    $host = strtolower((string)parse_url($url, PHP_URL_HOST));
    $allow = is_array($OC_API_HOSTS) ? $OC_API_HOSTS : [];
    $extra = oc_cfg()['extraApiHosts'] ?? [];
    if (is_array($extra)) $allow = array_merge($allow, $extra);
    foreach ($allow as $h) {
        if (!is_string($h) || $h === '') continue;
        if (strcasecmp($host, trim($h)) === 0) return $host;
    }
    oc_fail('不允許的 API 網域: ' . $host, 403,
            '可於 data/config.json 的 extraApiHosts 加入此網域');
}

// fetch / search 的基本 SSRF 防護：擋掉迴圈位址與私有網段（§5）
// oc_relay_guard_public 已搬到 includes/helpers.php（usertools.php 也要用）

// 把 {"K":"V"} 轉成 curl 需要的 ["K: V", …]，並確保帶上必要標頭
function oc_relay_headers($headers, $extra = []) {
    $out  = [];
    $seen = [];
    if (is_array($headers)) {
        foreach ($headers as $k => $v) {
            if (!is_string($k) || $k === '') continue;
            if (is_array($v) || is_object($v)) continue;
            // 擋掉會破壞 curl 傳輸的逐跳標頭
            $lk = strtolower($k);
            if (in_array($lk, ['host', 'content-length', 'connection', 'transfer-encoding'], true)) continue;
            $seen[$lk] = true;
            $out[] = $k . ': ' . (string)$v;
        }
    }
    foreach ($extra as $k => $v) {
        if (isset($seen[strtolower($k)])) continue;   // 使用者已自行指定就不重複
        $out[] = $k . ': ' . $v;
    }
    return $out;
}

// ═══════════════════════════════════════════════════════════════
// action=chat —— SSE 直通
// ═══════════════════════════════════════════════════════════════
function oc_act_chat() {
    $url  = oc_relay_url('url');
    oc_relay_guard_host($url);
    $body    = oc_arg('body', []);
    $headers = oc_arg('headers', []);

    // ─── 打開水龍頭：關閉所有可能造成緩衝的機制 ───
    header('Content-Type: text/event-stream; charset=utf-8');
    header('Cache-Control: no-cache, no-transform');
    header('X-Accel-Buffering: no');          // nginx / 反向代理不要緩衝
    header('Connection: keep-alive');
    @ini_set('output_buffering', '0');
    @ini_set('zlib.output_compression', '0');
    @ini_set('implicit_flush', '1');
    ob_implicit_flush(true);
    while (ob_get_level() > 0) @ob_end_flush();
    ignore_user_abort(false);                 // 使用者關閉分頁 → 一起中止上游

    $status  = 0;      // 上游 HTTP 狀態
    $errBuf  = '';     // 上游 >=400 時改為緩衝（那不是 SSE，直通會讓前端解析器啞掉）

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => oc_json_encode($body),
        CURLOPT_HTTPHEADER     => oc_relay_headers($headers, [
            'Content-Type' => 'application/json',
            'Accept'       => 'text/event-stream',
        ]),
        CURLOPT_TIMEOUT        => 0,          // 串流不設總逾時（長回應可能好幾分鐘）
        CURLOPT_CONNECTTIMEOUT => 20,
        // XAMPP 預設常缺 CA bundle（cacert.pem），驗證會直接讓所有請求失敗。
        // 本服務僅接受本機連線且對象是固定白名單網域，故關閉憑證驗證。
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_SSL_VERIFYHOST => 0,
        CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$status) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m)) $status = (int)$m[1];
            return strlen($line);
        },
        CURLOPT_WRITEFUNCTION  => function ($ch, $chunk) use (&$status, &$errBuf) {
            if ($status >= 400) { $errBuf .= $chunk; return strlen($chunk); }
            echo $chunk;
            @flush();
            return strlen($chunk);
        },
    ]);

    $okExec = curl_exec($ch);
    $errNo  = curl_errno($ch);
    $errMsg = curl_error($ch);
    curl_close($ch);

    if ($okExec === false && $errNo !== 0) {
        oc_relay_sse_error('連線 AI 供應商失敗：' . $errMsg, $status, 'curl errno ' . $errNo);
    } elseif ($status >= 400) {
        oc_relay_sse_error(
            'AI 供應商回應錯誤（HTTP ' . $status . '）：' . oc_relay_provider_msg($errBuf),
            $status,
            mb_substr($errBuf, 0, 4000)
        );
    }
    exit;
}

// 送出單一 SSE 錯誤事件（前端 api.js 認得 event: oc_error）
function oc_relay_sse_error($msg, $status = 0, $detail = null) {
    $payload = ['error' => $msg];
    if ($status) $payload['status'] = $status;
    if ($detail !== null && $detail !== '') $payload['detail'] = $detail;
    // oc_json_encode 會把換行逃逸成 \n，所以永遠是安全的單行 data
    echo "event: oc_error\n";
    echo 'data: ' . oc_json_encode($payload) . "\n\n";
    @flush();
}

// 從供應商錯誤 body 裡挖出人看得懂的訊息
function oc_relay_provider_msg($raw) {
    $raw = trim((string)$raw);
    if ($raw === '') return '（上游未提供內容）';
    $j = json_decode($raw, true);
    if (is_array($j)) {
        $m = $j['error']['message'] ?? $j['error'] ?? $j['message'] ?? null;
        if (is_string($m) && $m !== '') return $m;
        if (is_array($m)) return oc_json_encode($m);
    }
    return mb_substr($raw, 0, 500);
}

// ═══════════════════════════════════════════════════════════════
// action=json —— 非串流，上游 JSON 原樣回傳（含 HTTP 狀態碼）
// ═══════════════════════════════════════════════════════════════
function oc_act_json() {
    $url = oc_relay_url('url');
    oc_relay_guard_host($url);
    $body    = oc_arg('body', []);
    $headers = oc_arg('headers', []);

    $status = 0;
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => oc_json_encode($body),
        CURLOPT_HTTPHEADER     => oc_relay_headers($headers, [
            'Content-Type' => 'application/json',
            'Accept'       => 'application/json',
        ]),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 300,
        CURLOPT_CONNECTTIMEOUT => 20,
        CURLOPT_SSL_VERIFYPEER => false,   // 同上：XAMPP 常缺 CA bundle
        CURLOPT_SSL_VERIFYHOST => 0,
        CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$status) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m)) $status = (int)$m[1];
            return strlen($line);
        },
    ]);
    $out    = curl_exec($ch);
    $errNo  = curl_errno($ch);
    $errMsg = curl_error($ch);
    curl_close($ch);

    if ($out === false || $errNo !== 0) {
        oc_fail('連線 AI 供應商失敗：' . $errMsg, 502, 'curl errno ' . $errNo);
    }
    // 前端解析的是供應商的原生 JSON，這裡不套 oc_ok 封套
    http_response_code($status > 0 ? $status : 200);
    echo $out;
    exit;
}

// ═══════════════════════════════════════════════════════════════
// 共用：HTTP 抓取（GET / POST 表單），含大小上限與編碼正規化
// 回傳 [status, body, ctype, errno, error]
// ═══════════════════════════════════════════════════════════════
function oc_relay_http($url, $postFields = null, $extraHeaders = [], $timeout = null, $maxBytes = null) {
    $timeout  = $timeout  ?: OC_FETCH_TIMEOUT;
    $maxBytes = $maxBytes ?: OC_RELAY_MAX_FETCH_BYTES;
    $buf = '';
    $status = 0;
    $ctype  = '';

    $headers = array_merge([
        'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language: zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    ], $extraHeaders);

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_USERAGENT      => OC_RELAY_UA,        // 瀏覽器式 UA，避免被當成爬蟲擋掉
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS      => 5,
        CURLOPT_TIMEOUT        => $timeout,
        CURLOPT_CONNECTTIMEOUT => 15,
        CURLOPT_ENCODING       => '',                 // 自動處理 gzip / deflate / br
        CURLOPT_SSL_VERIFYPEER => false,              // XAMPP 常缺 CA bundle
        CURLOPT_SSL_VERIFYHOST => 0,
        CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$status, &$ctype) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m)) $status = (int)$m[1];
            if (stripos($line, 'content-type:') === 0) $ctype = trim(substr($line, 13));
            return strlen($line);
        },
        CURLOPT_WRITEFUNCTION  => function ($ch, $chunk) use (&$buf, $maxBytes) {
            $buf .= $chunk;
            // 超過上限就回傳 0 讓 curl 主動中止（errno 23 = CURLE_WRITE_ERROR，視為正常截斷）
            if (strlen($buf) > $maxBytes) { $buf = substr($buf, 0, $maxBytes); return 0; }
            return strlen($chunk);
        },
    ]);
    if ($postFields !== null) {
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $postFields);
    }
    curl_exec($ch);
    $errNo  = curl_errno($ch);
    $errMsg = curl_error($ch);
    curl_close($ch);

    // 23 = 寫入回呼中止（我們自己觸發的大小截斷），不算失敗
    if ($errNo === 23) { $errNo = 0; $errMsg = ''; }

    return [
        'status' => $status,
        'body'   => oc_relay_to_utf8($buf, $ctype),
        'ctype'  => $ctype,
        'errno'  => $errNo,
        'error'  => $errMsg,
    ];
}

// 把非 UTF-8 的網頁轉成 UTF-8（先看 Content-Type，再看 <meta charset>）
function oc_relay_to_utf8($body, $ctype) {
    if ($body === '') return '';
    $cs = '';
    if (preg_match('#charset\s*=\s*["\']?([A-Za-z0-9_\-]+)#i', (string)$ctype, $m)) $cs = $m[1];
    if ($cs === '' && preg_match('#<meta[^>]+charset\s*=\s*["\']?([A-Za-z0-9_\-]+)#i', substr($body, 0, 4096), $m)) $cs = $m[1];
    $cs = strtoupper($cs);
    if ($cs === '' || $cs === 'UTF-8' || $cs === 'UTF8') {
        return mb_check_encoding($body, 'UTF-8') ? $body : mb_convert_encoding($body, 'UTF-8', 'UTF-8');
    }
    $conv = @mb_convert_encoding($body, 'UTF-8', $cs);
    return $conv === false ? $body : $conv;
}

// ═══════════════════════════════════════════════════════════════
// action=fetch —— 抓網頁並轉成純文字 / markdown
// ═══════════════════════════════════════════════════════════════
function oc_act_fetch() {
    $url = oc_relay_url('url');
    oc_relay_guard_public($url);
    $maxChars = oc_int('max_chars', 100000);
    if ($maxChars <= 0) $maxChars = 100000;
    $format = strtolower((string)oc_arg('format', 'text'));
    if (!in_array($format, ['text', 'html', 'markdown'], true)) $format = 'text';

    $via = 'direct';
    $res = oc_relay_http($url);
    // ① 直連失敗（連線錯／4xx+）→ ② Jina Reader 降級（免費、免 key 的可讀代理）。
    // 反爬嚴的站兩條都會掛 —— 那是網站不給讀，不是我們沒試過，錯誤訊息要說清楚。
    $jinaDbg = null;
    if ($res['errno'] !== 0 || $res['status'] >= 400) {
        $jina = oc_relay_jina($url);
        if ($jina !== null) {
            $res = $jina;
            $via = 'jina-reader';
        }
    }
    if ($res['errno'] !== 0) {
        oc_fail('抓取網頁失敗（已試直連＋Jina 降級）：' . $res['error'], 502, 'curl errno ' . $res['errno'] . ' / ' . $url);
    }
    if ($res['status'] >= 400) {
        oc_fail('抓取網頁失敗，伺服器回應 HTTP ' . $res['status'] . '（已試直連＋Jina 降級）', 502, $url);
    }

    $raw   = $res['body'];
    $bytes = strlen($raw);
    $title = oc_relay_title($raw);

    // 非 HTML（純文字 / JSON / markdown…）直接使用原文
    $isHtml = stripos($res['ctype'], 'html') !== false
              || preg_match('#<\s*(html|body|div|p|head)\b#i', substr($raw, 0, 4096)) === 1;

    if ($format === 'html' || !$isHtml) {
        $content = $format === 'html' ? $raw : oc_relay_tidy_text($raw);
    } else {
        $content = oc_relay_html_to_text($raw, $format);
    }

    // 截斷（以字元計，避免切壞多位元組字元）
    $truncated = false;
    if (mb_strlen($content, 'UTF-8') > $maxChars) {
        $content   = mb_substr($content, 0, $maxChars, 'UTF-8');
        $truncated = true;
    }

    oc_ok([
        'url'       => $url,
        'status'    => $res['status'],
        'title'     => $title,
        'content'   => $content,
        'truncated' => $truncated,
        'bytes'     => $bytes,
        'via'       => $via,
    ]);
}

// 取 <title>
function oc_relay_title($html) {
    if (preg_match('#<title[^>]*>(.*?)</title>#is', $html, $m)) {
        $t = html_entity_decode(strip_tags($m[1]), ENT_QUOTES | ENT_HTML5, 'UTF-8');
        return trim(preg_replace('/\s+/u', ' ', $t));
    }
    return '';
}

// HTML → 純文字 / markdown
function oc_relay_html_to_text($html, $format = 'text') {
    // 1) 註解與非內容區塊（DOCTYPE 等殘留交給 strip_tags）
    $html = preg_replace('#<!--.*?-->#s', ' ', $html);
    // <head> 整塊移除：title 已由 oc_relay_title() 單獨取出，留著只會混進正文
    $html = preg_replace('#<head\b[^>]*>.*?</head\s*>#is', ' ', $html);
    // 注意 \b 讓 header 不會誤吃 <head>
    $html = preg_replace('#<(script|style|noscript|svg|iframe|nav|footer|header)\b[^>]*>.*?</\1\s*>#is', ' ', $html);
    // 未正確閉合的殘骸也一併清掉
    $html = preg_replace('#<(script|style|noscript|svg|iframe)\b[^>]*>#is', ' ', $html);

    if ($format === 'markdown') {
        // 2a) 標題 → # 前綴（必須在 strip_tags 之前做）
        $html = preg_replace_callback('#<h([1-6])\b[^>]*>(.*?)</h\1\s*>#is', function ($m) {
            $txt = trim(preg_replace('/\s+/u', ' ', strip_tags($m[2])));
            if ($txt === '') return "\n";
            return "\n\n" . str_repeat('#', (int)$m[1]) . ' ' . $txt . "\n\n";
        }, $html);
        // 2b) 連結 → [文字](網址)
        $html = preg_replace_callback('#<a\b[^>]*\bhref\s*=\s*["\']([^"\']*)["\'][^>]*>(.*?)</a\s*>#is', function ($m) {
            $href = trim($m[1]);
            $txt  = trim(preg_replace('/\s+/u', ' ', strip_tags($m[2])));
            if ($txt === '') return ' ';
            if ($href === '' || $href === '#' || stripos($href, 'javascript:') === 0) return $txt;
            return '[' . $txt . '](' . $href . ')';
        }, $html);
        // 2c) 清單項目 → "- " 前綴
        $html = preg_replace('#<li\b[^>]*>#i', "\n- ", $html);
    }

    // 3) 區塊級標籤 → 換行
    $html = preg_replace('#<br\s*/?>#i', "\n", $html);
    $html = preg_replace('#</(p|div|li|tr|section|article|blockquote|h[1-6])\s*>#i', "\n", $html);
    $html = preg_replace('#</(td|th)\s*>#i', "\t", $html);

    // 4) 去標籤 → 解實體
    $text = strip_tags($html);
    $text = html_entity_decode($text, ENT_QUOTES | ENT_HTML5, 'UTF-8');

    return oc_relay_tidy_text($text);
}

// 收斂空白：統一換行、去除不斷行空白、逐行 trim、連續空行壓成一行
function oc_relay_tidy_text($text) {
    $text = str_replace("\xC2\xA0", ' ', $text);         // &nbsp;
    $text = str_replace(["\r\n", "\r"], "\n", $text);     // Windows / 舊 Mac 換行
    $lines = explode("\n", $text);
    foreach ($lines as $i => $ln) {
        // 行內連續空白壓成單一空格，再去頭尾
        $lines[$i] = trim(preg_replace('/[ \t\x0B\f]+/u', ' ', $ln));
    }
    $text = implode("\n", $lines);
    $text = preg_replace('/\n{3,}/', "\n\n", $text);      // 3 個以上換行 → 2
    return trim($text);
}

// Jina Reader 降級：免費免 key 的可讀代理（https://r.jina.ai/<原文url>）。
// 只包「公網原文」—— 目標 url 進來前已過 guard，這裡不再重驗 r.jina.ai 本身。
// 回傳同 oc_relay_http 形狀的陣列；拿不到內容回 null（呼叫端繼續報直連的錯）。
// 反爬驗證頁（Just a moment / captcha）視為失敗，不要把驗證文字當內文回傳。
function oc_relay_jina($url) {
    $res = oc_relay_http('https://r.jina.ai/' . $url, null, ['Accept: text/plain'], 45);
    if ($res['errno'] !== 0 || $res['status'] >= 400 || trim($res['body']) === '') return null;
    $head = strtolower(substr($res['body'], 0, 4096));
    $antibot = (strpos($head, 'requiring captcha') !== false)
        || (strpos($head, 'just a moment') !== false)
        || (strpos($head, 'attention required') !== false && strpos($head, 'cloudflare') !== false)
        // Jina 明說目標站回錯（Warning: Target URL returned error 4xx/5xx）——
        // 有標題沒內文，交出去等於拿錯誤訊息當答案
        || (strpos($head, 'target url returned error') !== false)
        // Jina 偶爾原樣吐回整頁 HTML 驗證頁（Cloudflare challenge）——
        // 看 ctype 更準：正常回應是 text/markdown，text/html 代表 Jina 自己也被擋
        || (stripos($res['ctype'], 'html') !== false);
    if ($antibot) return null;
    // Jina 已是乾淨 markdown，不走 html_to_text（避免把連結語法洗掉）
    $res['ctype'] = 'text/markdown';
    return $res;
}

// ═══════════════════════════════════════════════════════════════
// action=search —— DuckDuckGo HTML → lite → Bing RSS 降級
// ═══════════════════════════════════════════════════════════════
function oc_act_search() {
    $query = trim((string)oc_arg('query', ''));
    if ($query === '') oc_fail('缺少必要參數 query', 400);
    $limit = oc_int('limit', 5);
    if ($limit <= 0) $limit = 5;
    if ($limit > 15) $limit = 15;

    // ① DuckDuckGo HTML（POST 表單，結果最完整）
    $results = oc_search_ddg_html($query, $limit);
    $engine  = 'duckduckgo-html';

    // ② 降級：DuckDuckGo Lite
    if (!$results) {
        $results = oc_search_ddg_lite($query, $limit);
        $engine  = 'duckduckgo-lite';
    }

    // ③ 再降級：Bing RSS（免 key 的公開搜尋 feed；DDG 全掛時的保底）
    if (!$results) {
        $results = oc_search_bing_rss($query, $limit);
        $engine  = 'bing-rss';
    }

    if (!$results) {
        oc_fail('網路搜尋失敗，所有搜尋引擎皆無回應', 502, 'query=' . $query);
    }

    oc_ok([
        'results' => array_slice($results, 0, $limit),
        'engine'  => $engine,
        'query'   => $query,
    ]);
}

function oc_search_ddg_html($query, $limit) {
    $res = oc_relay_http(
        'https://html.duckduckgo.com/html/',
        http_build_query(['q' => $query, 'kl' => 'wt-wt']),
        ['Content-Type: application/x-www-form-urlencoded', 'Referer: https://html.duckduckgo.com/'],
        20
    );
    if ($res['errno'] !== 0 || $res['status'] >= 400 || $res['body'] === '') return [];
    $html = $res['body'];

    // 標題 + 連結：<a class="result__a" href="…">標題</a>
    preg_match_all('#<a\b([^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*)>(.*?)</a\s*>#is', $html, $am, PREG_SET_ORDER);
    // 摘要：<a|div|td class="result__snippet">…</…>
    preg_match_all('#<(a|div|td)\b[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>(.*?)</\1\s*>#is', $html, $sm, PREG_SET_ORDER);

    $out  = [];
    $seen = [];
    foreach ($am as $i => $a) {
        if (!preg_match('#\bhref\s*=\s*["\']([^"\']+)["\']#i', $a[1], $hm)) continue;
        $url = oc_search_clean_url($hm[1]);
        if ($url === '' || isset($seen[$url])) continue;
        $seen[$url] = true;
        $out[] = [
            'title'   => oc_search_clean_text($a[2]),
            'url'     => $url,
            'snippet' => isset($sm[$i][2]) ? oc_search_clean_text($sm[$i][2]) : '',
        ];
        if (count($out) >= $limit) break;
    }
    return $out;
}

function oc_search_ddg_lite($query, $limit) {
    $res = oc_relay_http(
        'https://lite.duckduckgo.com/lite/?q=' . rawurlencode($query),
        null,
        ['Referer: https://lite.duckduckgo.com/'],
        20
    );
    if ($res['errno'] !== 0 || $res['status'] >= 400 || $res['body'] === '') return [];
    $html = $res['body'];

    preg_match_all('#<a\b([^>]*\bclass="[^"]*\bresult-link\b[^"]*"[^>]*)>(.*?)</a\s*>#is', $html, $am, PREG_SET_ORDER);
    preg_match_all('#<td\b[^>]*\bclass="[^"]*\bresult-snippet\b[^"]*"[^>]*>(.*?)</td\s*>#is', $html, $sm, PREG_SET_ORDER);

    $out  = [];
    $seen = [];
    foreach ($am as $i => $a) {
        if (!preg_match('#\bhref\s*=\s*["\']([^"\']+)["\']#i', $a[1], $hm)) continue;
        $url = oc_search_clean_url($hm[1]);
        if ($url === '' || isset($seen[$url])) continue;
        $seen[$url] = true;
        $out[] = [
            'title'   => oc_search_clean_text($a[2]),
            'url'     => $url,
            'snippet' => isset($sm[$i][1]) ? oc_search_clean_text($sm[$i][1]) : '',
        ];
        if (count($out) >= $limit) break;
    }
    return $out;
}

// ③ Bing RSS 保底：https://www.bing.com/search?q=…&format=rss
// 公開 feed、免 key；<item> 有 title/link/description，直接可用。
function oc_search_bing_rss($query, $limit) {
    $res = oc_relay_http(
        'https://www.bing.com/search?q=' . rawurlencode($query) . '&format=rss',
        null, [], 20, 1024 * 1024
    );
    if ($res['errno'] !== 0 || $res['status'] >= 400 || $res['body'] === '') return [];
    $xml = @simplexml_load_string($res['body']);
    if ($xml === false) return [];
    $out  = [];
    $seen = [];
    foreach ($xml->channel->item ?? [] as $it) {
        $url = trim((string)($it->link ?? ''));
        if (!preg_match('#^https?://#i', $url) || isset($seen[$url])) continue;
        $seen[$url] = true;
        $out[] = [
            'title'   => trim((string)($it->title ?? '')),
            'url'     => $url,
            'snippet' => mb_substr(trim(strip_tags((string)($it->description ?? ''))), 0, 300),
        ];
        if (count($out) >= $limit) break;
    }
    return $out;
}

// DDG 的 href 是轉址：//duckduckgo.com/l/?uddg=<urlencoded>&rut=…
function oc_search_clean_url($href) {
    $href = html_entity_decode(trim($href), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    if ($href === '' || $href === '#') return '';
    if (preg_match('#[?&]uddg=([^&]+)#i', $href, $m)) $href = urldecode($m[1]);
    if (strpos($href, '//') === 0) $href = 'https:' . $href;          // 協定相對
    if (!preg_match('#^https?://#i', $href)) return '';
    return $href;
}

function oc_search_clean_text($html) {
    $t = html_entity_decode(strip_tags($html), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $t = str_replace("\xC2\xA0", ' ', $t);
    return trim(preg_replace('/\s+/u', ' ', $t));
}
