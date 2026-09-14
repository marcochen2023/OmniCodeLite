<?php
require_once __DIR__ . '/../includes/helpers.php';
// CLI（mcp-server.php）只是要 include 進來用 oc_ut_run()，
// 不該送 HTTP 標頭，也不該在檔尾自己跑一次路由。
if (PHP_SAPI !== 'cli') oc_boot();

// ═══════════════════════════════════════════════════════════════
// Omni Code — 使用者／Agent 自撰的 API 工具（建議 #4）
// ═══════════════════════════════════════════════════════════════
// Agenvoy 讓 agent 自己寫工具、沙箱測試、修好再用。這裡「只做宣告式
// 那一半」：工具是一份描述 HTTP 請求的 JSON，由 PHP 用 curl 執行。
//
// ★ 為什麼不做腳本工具：
//   Agenvoy 敢讓 agent 寫可執行程式碼，是因為它有 bwrap / sandbox-exec
//   把每個子行程關起來。Windows + XAMPP 沒有對等物。沒有沙箱卻讓
//   agent 寫程式碼再執行，等於把「模型寫錯一行」變成「主機被改壞」。
//   宣告式的請求描述沒有這個問題 —— 它能做的事被 schema 限死了。
//
// 工具格式（data/tools/api/<name>.json）：
// {
//   "name": "get_weather",
//   "description": "查詢城市天氣。\n用於：使用者問某地天氣時。\n前置：無。",
//   "params": { JSON Schema },
//   "request": {
//     "method": "GET",
//     "url": "https://api.example.com/weather?city={city}",
//     "headers": { "Authorization": "Bearer {{SECRET:weather_key}}" },
//     "body": null,
//     "timeout": 30
//   }
// }
// {name} 從參數代入（URL 會做 urlencode）；{{SECRET:x}} 從 data/secrets.json
// 取出 —— 金鑰不會出現在工具定義裡，也不會被模型看到。
// ═══════════════════════════════════════════════════════════════

define('OC_USERTOOLS', OC_DATA . '/tools/api');
define('OC_SECRETS',   OC_DATA . '/secrets.json');
const OC_UT_MAX_BODY = 2 * 1024 * 1024;      // 回應上限，避免把上下文塞爆

function oc_ut_dir() {
    if (!is_dir(OC_USERTOOLS)) @mkdir(OC_USERTOOLS, 0777, true);
    return OC_USERTOOLS;
}

function oc_ut_valid_name($n) {
    // snake_case 動詞+名詞。擋掉 Agenvoy 也擋的那些沒有資訊量的動詞。
    if (!preg_match('/^[a-z][a-z0-9_]{2,39}$/', (string)$n)) return '名稱只能用小寫英數與底線，3–40 字元';
    foreach (['process_', 'handle_', 'manage_', 'execute_', 'do_', 'run_'] as $bad) {
        if (strpos($n, $bad) === 0) return "「{$bad}*」這種動詞沒有說明工具實際做什麼，換一個具體的動詞";
    }
    return '';
}

function oc_ut_path($name) {
    return oc_ut_dir() . '/' . $name . '.json';
}

/** 已註冊的工具清單 */
function oc_ut_list() {
    $out = [];
    foreach (@glob(oc_ut_dir() . '/*.json') ?: [] as $f) {
        $t = oc_read_json($f, null);
        if (is_array($t) && !empty($t['name'])) $out[] = $t;
    }
    usort($out, function ($a, $b) { return strcmp($a['name'], $b['name']); });
    oc_ok(['tools' => $out]);
}

/** 結構檢查。回傳錯誤字串，空 = 通過。 */
function oc_ut_validate($t) {
    if (!is_array($t)) return '工具定義必須是物件';
    $err = oc_ut_valid_name($t['name'] ?? '');
    if ($err !== '') return $err;

    $d = trim((string)($t['description'] ?? ''));
    if (mb_strlen($d) < 30) return '描述太短：至少要說明「做什麼／何時用／前置條件」三件事';

    if (!isset($t['params']) || !is_array($t['params'])) return '缺少 params（JSON Schema 物件）';
    $r = $t['request'] ?? null;
    if (!is_array($r)) return '缺少 request 物件';

    $m = strtoupper((string)($r['method'] ?? 'GET'));
    if (!in_array($m, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], true)) return 'method 不合法';

    $u = (string)($r['url'] ?? '');
    if ($u === '') return 'request.url 不能是空的';
    // 代入樣板之前先檢查 scheme —— 樣板值不該有機會把 https 換掉
    if (!preg_match('#^https?://#i', $u)) return 'request.url 必須是 http(s) 開頭';
    return '';
}

function oc_ut_save() {
    $t = oc_arg('tool', null);
    $err = oc_ut_validate($t);
    if ($err !== '') oc_fail('工具定義不合格：' . $err, 400);

    $t['updated'] = time();
    if (!oc_write_json(oc_ut_path($t['name']), $t)) oc_fail('無法寫入工具定義', 500);
    oc_ok(['saved' => $t['name'], 'path' => 'data/tools/api/' . $t['name'] . '.json']);
}

function oc_ut_remove() {
    $n = (string)oc_arg('name', '');
    if (oc_ut_valid_name($n) !== '') oc_fail('名稱不合法', 400);
    $p = oc_ut_path($n);
    if (!is_file($p)) oc_fail('找不到工具：' . $n, 404);
    if (!@unlink($p)) oc_fail('無法刪除', 500);
    oc_ok(['removed' => $n]);
}

/** {name}、{{VAULT:key}} 與 {{SECRET:key}} 代入 */
function oc_ut_fill($tpl, $args, $urlEncode) {
    $secrets = oc_read_json(OC_SECRETS, []);
    $vault = is_file(OC_DATA . '/vault.json') ? oc_read_json(OC_DATA . '/vault.json', []) : [];
    if (!is_array($vault)) $vault = [];
    // 保險庫優先：同名時以 vault 為準（通用庫凌駕舊金鑰庫，遷移期兩邊都認）
    $out = preg_replace_callback('/\{\{VAULT:([A-Za-z0-9_.-]+)\}\}/', function ($m) use ($vault) {
        return (string)($vault[$m[1]] ?? '');
    }, (string)$tpl);
    $out = preg_replace_callback('/\{\{SECRET:([A-Za-z0-9_.-]+)\}\}/', function ($m) use ($secrets, $vault) {
        $k = $m[1];
        if (array_key_exists($k, $vault)) return (string)$vault[$k];
        return (string)($secrets[$k] ?? '');
    }, $out);
    return preg_replace_callback('/\{([A-Za-z0-9_]+)\}/', function ($m) use ($args, $urlEncode) {
        $v = $args[$m[1]] ?? '';
        if (is_array($v) || is_object($v)) $v = oc_json_encode($v);
        return $urlEncode ? rawurlencode((string)$v) : (string)$v;
    }, $out);
}

/**
 * 執行一個工具。$dryTool 有值時用它而不是讀檔 ——
 * test_tool 就是靠這個「在還沒入庫之前先測」，
 * 否則壞工具的第一次真實使用就是它的第一次測試。
 */
function oc_ut_run($name = null, $args = null, $dryTool = null) {
    $name = $name ?? (string)oc_arg('name', '');
    $args = $args ?? oc_arg('args', []);
    if (!is_array($args)) $args = [];

    if (is_array($dryTool)) {
        $t = $dryTool;
        $err = oc_ut_validate($t);
        if ($err !== '') oc_fail('工具定義不合格：' . $err, 400);
    } else {
        if (oc_ut_valid_name($name) !== '') oc_fail('名稱不合法', 400);
        $t = oc_read_json(oc_ut_path($name), null);
        if (!is_array($t)) oc_fail('找不到工具：' . $name, 404);
    }

    $r   = $t['request'];
    $m   = strtoupper((string)($r['method'] ?? 'GET'));
    $url = oc_ut_fill($r['url'], $args, true);
    if (!preg_match('#^https?://#i', $url)) oc_fail('代入後的網址不是 http(s)', 400);
    // 內網與本機一律擋掉 —— 這是本機服務，讓 agent 定義的工具去打
    // 192.168.* 或 localhost 等於給它一條繞過所有邊界的路
    oc_relay_guard_public($url);

    $headers = [];
    foreach ((array)($r['headers'] ?? []) as $k => $v) {
        $headers[] = $k . ': ' . oc_ut_fill($v, $args, false);
    }
    $body = null;
    if (isset($r['body']) && $r['body'] !== null && $m !== 'GET') {
        $body = is_string($r['body']) ? oc_ut_fill($r['body'], $args, false)
                                      : oc_ut_fill(oc_json_encode($r['body']), $args, false);
        if (!array_filter($headers, function ($h) { return stripos($h, 'content-type:') === 0; })) {
            $headers[] = 'Content-Type: application/json';
        }
    }

    $t0 = microtime(true);
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST  => $m,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => max(5, min((int)($r['timeout'] ?? 30), 120)),
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_FOLLOWLOCATION => false,        // 別讓 302 把請求帶到別的主機去
    ]);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    $out = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $cerr = curl_error($ch);
    curl_close($ch);

    if ($out === false) oc_fail('請求失敗：' . $cerr, 502);
    $truncated = false;
    if (strlen($out) > OC_UT_MAX_BODY) { $out = substr($out, 0, OC_UT_MAX_BODY); $truncated = true; }

    oc_ok([
        'status'    => $status,
        'body'      => $out,
        'truncated' => $truncated,
        'ms'        => (int)round((microtime(true) - $t0) * 1000),
        'url'       => preg_replace('/([?&](key|token|api_?key)=)[^&]*/i', '$1<redacted>', $url),
    ]);
}

function oc_ut_secret_set() {
    $k = (string)oc_arg('key', '');
    $v = (string)oc_arg('value', '');
    if (!preg_match('/^[A-Za-z0-9_.-]{1,64}$/', $k)) oc_fail('key 不合法', 400);
    $s = oc_read_json(OC_SECRETS, []);
    if ($v === '') unset($s[$k]); else $s[$k] = $v;
    if (!oc_write_json(OC_SECRETS, $s)) oc_fail('無法寫入', 500);
    // 絕不回傳值本身
    oc_ok(['keys' => array_keys($s)]);
}

function oc_ut_secret_list() {
    oc_ok(['keys' => array_keys(oc_read_json(OC_SECRETS, []))]);
}

// ═══════════════════════════════════════════════════════════════

if (PHP_SAPI !== 'cli') switch (oc_arg('action', '')) {
    case 'list':        oc_ut_list();        break;
    case 'save':        oc_ut_save();        break;
    case 'remove':      oc_ut_remove();      break;
    case 'run':         oc_ut_run();         break;
    case 'test':        oc_ut_run(null, oc_arg('args', []), oc_arg('tool', null)); break;
    case 'secret_set':  oc_ut_secret_set();  break;
    case 'secret_list': oc_ut_secret_list(); break;
    default: oc_fail('未知的 action', 404);
}
