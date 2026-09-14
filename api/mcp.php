<?php
require_once __DIR__ . '/../includes/helpers.php';
oc_boot();

// ═══════════════════════════════════════════════════════════════
// Omni Code — MCP（Model Context Protocol）代理
// ═══════════════════════════════════════════════════════════════
// 契約見 docs/ARCHITECTURE.md §7。伺服器設定存於 data/config.json 的 mcpServers：
//   "filesystem": {"type":"stdio","command":"npx","args":[…],"env":{},"enabled":true}
//   "docs":       {"type":"http","url":"http://localhost:3001/mcp","headers":{},"enabled":true}
//
// stdio：每次呼叫以 proc_open 啟動程序，JSON-RPC 以「一行一個 JSON 物件」溝通
//        initialize → notifications/initialized → tools/list | tools/call → terminate
// http ：POST JSON-RPC 到 url，回應可能是純 JSON 或 SSE（data: 行）
//
// 對外工具名一律前綴 mcp__<server>__<tool>；工具清單快取於 data/mcp-cache.json。
// ═══════════════════════════════════════════════════════════════

define('OC_MCP_CACHE_TTL', 600);                       // 工具清單快取有效期（秒）
define('OC_MCP_CACHE_FILE', OC_DATA . '/mcp-cache.json');
define('OC_MCP_PROTOCOL', '2025-06-18');

$action = oc_arg('action', '');

switch ($action) {
    case 'servers': oc_mcp_act_servers(); break;
    case 'tools':   oc_mcp_act_tools();   break;
    case 'call':    oc_mcp_act_call();    break;
    case 'save':    oc_mcp_act_save();    break;
    case 'test':    oc_mcp_act_test();    break;

    default:
        oc_fail('未知的 action: ' . $action, 404);
}

// ═══════════════════════════════════════════════════════════════
// 設定讀取
// ═══════════════════════════════════════════════════════════════

// mcpServers 可能是空的 stdClass（預設值）→ 一律轉成 assoc array
function oc_mcp_servers() {
    $cfg  = oc_cfg();
    $srvs = $cfg['mcpServers'] ?? [];
    if (is_object($srvs)) $srvs = (array)$srvs;
    if (!is_array($srvs)) $srvs = [];
    $out = [];
    foreach ($srvs as $name => $s) {
        $name = trim((string)$name);
        if ($name === '') continue;
        if (is_object($s)) $s = (array)$s;
        if (!is_array($s)) continue;
        $out[$name] = $s;
    }
    return $out;
}

function oc_mcp_enabled($srv) {
    if (!array_key_exists('enabled', $srv)) return true;      // 未指定視為啟用
    $v = $srv['enabled'];
    if (is_string($v)) return !in_array(strtolower($v), ['0', 'false', 'no', 'off', ''], true);
    return (bool)$v;
}

// 型別正規化：只有 stdio 與 http 兩種（sse 視為 http）
function oc_mcp_type($srv) {
    $t = strtolower(trim((string)($srv['type'] ?? '')));
    if ($t === '') $t = !empty($srv['url']) ? 'http' : 'stdio';
    if ($t === 'sse' || $t === 'streamable-http' || $t === 'https') $t = 'http';
    return $t === 'stdio' ? 'stdio' : 'http';
}

// 取得指定伺服器設定，找不到就 404
function oc_mcp_need($name) {
    $name = trim((string)$name);
    if ($name === '') oc_fail('缺少 server 參數', 400);
    $all = oc_mcp_servers();
    if (!isset($all[$name])) oc_fail('找不到 MCP 伺服器：' . $name, 404);
    return $all[$name];
}

// ═══════════════════════════════════════════════════════════════
// 快取（data/mcp-cache.json）
// ═══════════════════════════════════════════════════════════════

function oc_mcp_cache_read() {
    $c = oc_read_json(OC_MCP_CACHE_FILE, []);
    if (!isset($c['servers']) || !is_array($c['servers'])) $c['servers'] = [];
    return $c;
}

function oc_mcp_cache_write($entries) {
    oc_write_json(OC_MCP_CACHE_FILE, ['servers' => $entries, 'updated' => time()]);
}

function oc_mcp_cache_clear() {
    if (is_file(OC_MCP_CACHE_FILE)) @unlink(OC_MCP_CACHE_FILE);
}

// ═══════════════════════════════════════════════════════════════
// JSON-RPC 共用
// ═══════════════════════════════════════════════════════════════

function oc_mcp_init_params() {
    return [
        'protocolVersion' => OC_MCP_PROTOCOL,
        'capabilities'    => new stdClass(),
        'clientInfo'      => ['name' => 'omni-code', 'version' => '1.0'],
    ];
}

// 從回應本文解出 JSON-RPC 物件：支援純 JSON 與 SSE（取最後一個可解析且含 result/error 的 data: 行）
function oc_mcp_parse_rpc($body) {
    $body = trim((string)$body);
    if ($body === '') return null;

    $j = json_decode($body, true);
    if (is_array($j)) {
        if (array_key_exists('result', $j) || array_key_exists('error', $j)) return $j;
        // 批次回應：取第一個帶 result/error 的元素
        foreach ($j as $it) {
            if (is_array($it) && (array_key_exists('result', $it) || array_key_exists('error', $it))) return $it;
        }
    }

    // SSE：逐行找 data:
    if (stripos($body, 'data:') !== false) {
        $found = null;
        foreach (oc_split_lines($body) as $line) {
            $line = ltrim($line);
            if (stripos($line, 'data:') !== 0) continue;
            $d = trim(substr($line, 5));
            if ($d === '' || $d === '[DONE]') continue;
            $o = json_decode($d, true);
            if (is_array($o) && (array_key_exists('result', $o) || array_key_exists('error', $o))) $found = $o;
        }
        if ($found !== null) return $found;
    }

    return is_array($j) ? $j : null;
}

// JSON-RPC error 物件 → 可讀訊息
function oc_mcp_err_msg($err) {
    if (is_string($err)) return $err;
    if (!is_array($err)) return oc_json_encode($err);
    $msg = (string)($err['message'] ?? '未知的 JSON-RPC 錯誤');
    if (isset($err['code'])) $msg .= '（code ' . $err['code'] . '）';
    if (isset($err['data'])) $msg .= '：' . (is_string($err['data']) ? $err['data'] : oc_json_encode($err['data']));
    return $msg;
}

// 對單一伺服器發一次請求（method = tools/list | tools/call）
// 成功回傳 JSON-RPC 回應陣列；失敗擲出 RuntimeException（訊息為繁中）
function oc_mcp_request($name, $srv, $method, $params) {
    if (oc_mcp_type($srv) === 'stdio') return oc_mcp_stdio($name, $srv, $method, $params);
    return oc_mcp_http($name, $srv, $method, $params);
}

// ═══════════════════════════════════════════════════════════════
// http 傳輸
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// 保險庫代號代入（{{VAULT:key}} / 相容舊 {{SECRET:key}}）
// ═══════════════════════════════════════════════════════════════
// 只用在「真正要送出的那一刻」：http headers 與 stdio env。
// 設定檔（config.json / mcp-cache.json）與前端拿到的永遠是代號原文 ——
// 值只活在這次請求的記憶體裡，絕不落盤、不進稽核。
function oc_mcp_vault_fill($s) {
    $s = (string)$s;
    if (strpos($s, '{{VAULT:') === false && strpos($s, '{{SECRET:') === false) return $s;
    $vault = is_file(OC_DATA . '/vault.json') ? oc_read_json(OC_DATA . '/vault.json', []) : [];
    if (!is_array($vault)) $vault = [];
    $secrets = is_file(OC_DATA . '/secrets.json') ? oc_read_json(OC_DATA . '/secrets.json', []) : [];
    if (!is_array($secrets)) $secrets = [];
    $s = preg_replace_callback('/\{\{VAULT:([A-Za-z0-9_.-]+)\}\}/', function ($m) use ($vault) {
        return (string)($vault[$m[1]] ?? '');
    }, $s);
    $s = preg_replace_callback('/\{\{SECRET:([A-Za-z0-9_.-]+)\}\}/', function ($m) use ($secrets, $vault) {
        $k = $m[1];
        if (array_key_exists($k, $vault)) return (string)$vault[$k];
        return (string)($secrets[$k] ?? '');
    }, $s);
    return $s;
}

// 單次 POST；$respHeaders 以小寫 key 回填
function oc_mcp_http_post($name, $url, $headers, $payload, &$respHeaders) {
    $respHeaders = [];
    $ch = @curl_init($url);
    if ($ch === false) throw new RuntimeException('無法初始化 curl（伺服器「' . $name . '」）');

    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => oc_json_encode($payload),
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => OC_MCP_TIMEOUT,
        CURLOPT_CONNECTTIMEOUT => min(10, OC_MCP_TIMEOUT),
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS      => 3,
        // 本機 MCP 伺服器常用自簽憑證，XAMPP 又未必帶 CA bundle
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_SSL_VERIFYHOST => 0,
        CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$respHeaders) {
            $p = strpos($line, ':');
            if ($p !== false) {
                $k = strtolower(trim(substr($line, 0, $p)));
                if ($k !== '') $respHeaders[$k] = trim(substr($line, $p + 1));
            }
            return strlen($line);
        },
    ]);

    $body = curl_exec($ch);
    $err  = curl_error($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($body === false) {
        throw new RuntimeException('無法連線到 MCP 伺服器「' . $name . '」：' . ($err !== '' ? $err : '未知的網路錯誤'));
    }
    return ['status' => $code, 'body' => (string)$body];
}

function oc_mcp_http($name, $srv, $method, $params) {
    $url = trim((string)($srv['url'] ?? ''));
    if ($url === '') throw new RuntimeException('MCP 伺服器「' . $name . '」未設定 url');
    if (!preg_match('#^https?://#i', $url)) {
        throw new RuntimeException('MCP 伺服器「' . $name . '」的 url 必須是 http(s)://：' . $url);
    }

    $headers = ['Content-Type: application/json', 'Accept: application/json, text/event-stream'];
    $extra   = $srv['headers'] ?? [];
    if (is_object($extra)) $extra = (array)$extra;
    if (is_array($extra)) {
        foreach ($extra as $k => $v) {
            $k = trim((string)$k);
            if ($k === '') continue;
            // 保險庫代號在真正送出前才代入 —— 設定檔與前端拿到的永遠是 {{VAULT:x}}
            $headers[] = $k . ': ' . oc_mcp_vault_fill((string)$v);
        }
    }

    // 1) initialize —— streamable-HTTP 伺服器多半要求先握手（失敗則直接嘗試正式請求）
    $rh = [];
    try {
        $init = oc_mcp_http_post($name, $url, $headers, [
            'jsonrpc' => '2.0', 'id' => 1, 'method' => 'initialize', 'params' => oc_mcp_init_params(),
        ], $rh);
        $initRpc = oc_mcp_parse_rpc($init['body']);
        if (is_array($initRpc) && isset($initRpc['result'])) {
            if (!empty($rh['mcp-session-id'])) $headers[] = 'Mcp-Session-Id: ' . $rh['mcp-session-id'];
            // 2) initialized 通知（無 id，不等回應）
            $rh2 = [];
            try {
                oc_mcp_http_post($name, $url, $headers, [
                    'jsonrpc' => '2.0', 'method' => 'notifications/initialized',
                ], $rh2);
            } catch (RuntimeException $e) { /* 通知失敗不影響後續 */ }
        }
    } catch (RuntimeException $e) {
        // 握手失敗：可能是無狀態伺服器，繼續送正式請求
    }

    // 3) 正式請求
    $rh3  = [];
    $resp = oc_mcp_http_post($name, $url, $headers, [
        'jsonrpc' => '2.0', 'id' => 2, 'method' => $method, 'params' => $params,
    ], $rh3);

    $rpc = oc_mcp_parse_rpc($resp['body']);
    if ($rpc === null) {
        $snip = substr(trim($resp['body']), 0, 300);
        throw new RuntimeException(
            'MCP 伺服器「' . $name . '」回應無法解析（HTTP ' . $resp['status'] . '）' . ($snip !== '' ? '：' . $snip : '')
        );
    }
    if ($resp['status'] >= 400 && !isset($rpc['result']) && !isset($rpc['error'])) {
        throw new RuntimeException('MCP 伺服器「' . $name . '」回應 HTTP ' . $resp['status']);
    }
    return $rpc;
}

// ═══════════════════════════════════════════════════════════════
// stdio 傳輸
// ═══════════════════════════════════════════════════════════════

// Windows 命令列參數引號處理
function oc_mcp_quote_win($arg) {
    $arg = (string)$arg;
    if ($arg === '') return '""';
    if (!preg_match('/[\s"^&|<>()%!]/', $arg)) return $arg;
    return '"' . str_replace('"', '\\"', $arg) . '"';
}

// 組出可直接執行的命令列
function oc_mcp_cmdline($srv) {
    $command = trim((string)($srv['command'] ?? ''));
    $args    = $srv['args'] ?? [];
    if (is_object($args)) $args = (array)$args;
    if (is_string($args)) $args = preg_split('/\s+/', trim($args), -1, PREG_SPLIT_NO_EMPTY);
    if (!is_array($args)) $args = [];

    if (oc_is_win()) {
        $parts = [oc_mcp_quote_win($command)];
        foreach ($args as $a) $parts[] = oc_mcp_quote_win((string)$a);
        // cmd /d 略過 AutoRun、/s 保留內層引號、/c 執行後結束
        return 'cmd /d /s /c "' . implode(' ', $parts) . '"';
    }
    $parts = [escapeshellarg($command)];
    foreach ($args as $a) $parts[] = escapeshellarg((string)$a);
    return implode(' ', $parts);
}

// 送一個 JSON-RPC 訊息（一行一個物件）
function oc_mcp_send($pipe, $obj) {
    @fwrite($pipe, oc_json_encode($obj) . "\n");
    @fflush($pipe);
}

// 追讀「正在被子程序寫入的檔案」：每次都重新 fseek，才能清掉先前的 EOF 旗標。
//
// ⚠ Windows 的程序 pipe 不支援真正的非阻塞讀取：stream_set_blocking($pipe,false)
//   對它無效，fread 會一路擋到 EOF —— 於是下面的 deadline 判斷永遠跑不到，
//   逾時形同虛設，MCP 伺服器沒回應就會把整個請求卡死並留下孤兒程序。
//   exec.php 已經踩過同一個坑，這裡沿用相同的暫存檔作法。
function oc_mcp_tail($fh, $file, &$off) {
    if (!is_resource($fh)) return '';
    clearstatcache(true, $file);
    $size = (int)@filesize($file);
    $out  = '';
    while ($size > $off) {
        if (@fseek($fh, $off) !== 0) break;
        $b = @fread($fh, (int)min(65536, $size - $off));
        if ($b === false || $b === '') break;
        $off += strlen($b);
        $out .= $b;
    }
    return $out;
}

// 讀取 stdout 直到收到指定 id 的回應
// 回傳：array=成功 / false=逾時 / null=程序已結束
function oc_mcp_read_until(&$io, $wantId, $deadline, &$buf, &$errBuf) {
    while (true) {
        $chunk = oc_mcp_tail($io['fo'], $io['out'], $io['offOut']);
        if ($chunk !== '') {
            $buf .= $chunk;
            while (($p = strpos($buf, "\n")) !== false) {
                $line = trim(substr($buf, 0, $p));
                $buf  = substr($buf, $p + 1);
                if ($line === '' || $line[0] !== '{') continue;      // 跳過非 JSON 雜訊
                $o = json_decode($line, true);
                if (!is_array($o)) continue;
                if (array_key_exists('id', $o) && (string)$o['id'] === (string)$wantId) return $o;
            }
            continue;                                               // 有資料就繼續讀，不睡
        }

        // 收集 stderr（僅供錯誤訊息用，保留末端 8KB）
        $e = oc_mcp_tail($io['fe'], $io['err'], $io['offErr']);
        if ($e !== '') {
            $errBuf .= $e;
            if (strlen($errBuf) > 8192) $errBuf = substr($errBuf, -8192);
            continue;
        }

        // 逾時判斷必須在「不會阻塞的讀取」之後才有意義
        if (microtime(true) > $deadline) return false;

        $st = @proc_get_status($io['proc']);
        if (is_array($st) && empty($st['running'])) {
            // 程序結束後再撈一次殘留輸出，避免最後一行回應被丟掉
            $tail = oc_mcp_tail($io['fo'], $io['out'], $io['offOut']);
            if ($tail !== '') { $buf .= $tail; continue; }
            return null;
        }
        usleep(20000);
    }
}

function oc_mcp_stdio($name, $srv, $method, $params) {
    $command = trim((string)($srv['command'] ?? ''));
    if ($command === '') throw new RuntimeException('MCP 伺服器「' . $name . '」未設定 command');

    $cmd = oc_mcp_cmdline($srv);
    // stdout / stderr 導向暫存檔（原因見 oc_mcp_tail 的說明）；stdin 仍用 pipe
    $mid     = oc_id('mcp-');
    $outFile = OC_SHELLS . '/' . $mid . '.out';
    $errFile = OC_SHELLS . '/' . $mid . '.err';
    if (!is_dir(OC_SHELLS)) @mkdir(OC_SHELLS, 0777, true);
    $desc = [0 => ['pipe', 'r'], 1 => ['file', $outFile, 'w'], 2 => ['file', $errFile, 'w']];

    // 環境變數：繼承目前環境後再套用設定值
    $env = $srv['env'] ?? [];
    if (is_object($env)) $env = (array)$env;
    if (is_array($env) && $env) {
        $base = function_exists('getenv') ? getenv() : [];
        if (!is_array($base)) $base = [];
        $merged = $base;
        // 保險庫代號在子程序啟動前才代入 —— 設定檔裡永遠是 {{VAULT:x}}
        foreach ($env as $k => $v) $merged[(string)$k] = oc_mcp_vault_fill((string)$v);
        $env = $merged;
    } else {
        $env = null;                                                // null = 完全繼承
    }

    $cwd  = isset($srv['cwd']) && $srv['cwd'] !== '' ? str_replace('\\', '/', (string)$srv['cwd']) : null;
    if ($cwd !== null && !is_dir($cwd)) $cwd = null;

    // Windows 下 bypass_shell 讓我們自己組的 cmd 行原樣送進 CreateProcess，避免雙層 shell
    $opts = oc_is_win() ? ['bypass_shell' => true] : [];
    $proc = @proc_open($cmd, $desc, $pipes, $cwd, $env, $opts);
    if (!is_resource($proc)) {
        throw new RuntimeException('無法啟動 MCP 伺服器「' . $name . '」：' . $command . '（請確認命令存在且可執行）');
    }

    $io = [
        'proc'   => $proc,
        'out'    => $outFile, 'err' => $errFile,
        'fo'     => @fopen($outFile, 'rb'), 'fe' => @fopen($errFile, 'rb'),
        'offOut' => 0, 'offErr' => 0,
    ];

    $buf      = '';
    $errBuf   = '';
    $deadline = microtime(true) + OC_MCP_TIMEOUT;

    $cleanup = function () use ($proc, &$pipes, &$io, $outFile, $errFile) {
        foreach ($pipes as $p) { if (is_resource($p)) @fclose($p); }
        if (is_resource($io['fo'])) @fclose($io['fo']);
        if (is_resource($io['fe'])) @fclose($io['fe']);
        @proc_terminate($proc);
        @proc_close($proc);
        @unlink($outFile);
        @unlink($errFile);
    };

    // 1) initialize
    oc_mcp_send($pipes[0], [
        'jsonrpc' => '2.0', 'id' => 1, 'method' => 'initialize', 'params' => oc_mcp_init_params(),
    ]);
    $init = oc_mcp_read_until($io, 1, $deadline, $buf, $errBuf);
    if ($init === false) {
        $cleanup();
        throw new RuntimeException('MCP 伺服器「' . $name . '」握手逾時（' . OC_MCP_TIMEOUT . ' 秒未回應 initialize）'
            . ($errBuf !== '' ? '：' . trim($errBuf) : ''));
    }
    if ($init === null) {
        $cleanup();
        throw new RuntimeException('MCP 伺服器「' . $name . '」啟動後隨即結束'
            . ($errBuf !== '' ? '：' . trim($errBuf) : '（沒有輸出，請檢查 command / args）'));
    }
    if (isset($init['error'])) {
        $cleanup();
        throw new RuntimeException('MCP 伺服器「' . $name . '」initialize 失敗：' . oc_mcp_err_msg($init['error']));
    }

    // 2) initialized 通知（無 id、不等回應）
    oc_mcp_send($pipes[0], ['jsonrpc' => '2.0', 'method' => 'notifications/initialized']);

    // 3) 正式請求
    oc_mcp_send($pipes[0], ['jsonrpc' => '2.0', 'id' => 2, 'method' => $method, 'params' => $params]);
    $resp = oc_mcp_read_until($io, 2, $deadline, $buf, $errBuf);
    $cleanup();

    if ($resp === false) {
        throw new RuntimeException('MCP 伺服器「' . $name . '」逾時（' . OC_MCP_TIMEOUT . ' 秒內未回應 ' . $method . '）'
            . ($errBuf !== '' ? '：' . trim($errBuf) : ''));
    }
    if ($resp === null) {
        throw new RuntimeException('MCP 伺服器「' . $name . '」在回應 ' . $method . ' 前就結束了'
            . ($errBuf !== '' ? '：' . trim($errBuf) : ''));
    }
    return $resp;
}

// ═══════════════════════════════════════════════════════════════
// 工具清單
// ═══════════════════════════════════════════════════════════════

// input_schema 正規化（空 properties 要保持物件形狀，供應商 schema 驗證才過得了）
function oc_mcp_schema($s) {
    if (is_object($s)) $s = (array)$s;
    if (!is_array($s) || !$s) return ['type' => 'object', 'properties' => new stdClass()];
    if (!isset($s['type'])) $s['type'] = 'object';
    if (!isset($s['properties']) || (is_array($s['properties']) && !$s['properties'])) {
        $s['properties'] = new stdClass();
    }
    return $s;
}

// 呼叫 tools/list，回傳 [{name,description,input_schema}]
function oc_mcp_list_tools($name, $srv) {
    $resp = oc_mcp_request($name, $srv, 'tools/list', new stdClass());
    if (isset($resp['error'])) {
        throw new RuntimeException('MCP 伺服器「' . $name . '」列出工具失敗：' . oc_mcp_err_msg($resp['error']));
    }
    $result = $resp['result'] ?? [];
    if (is_object($result)) $result = (array)$result;
    $raw = (is_array($result) && isset($result['tools']) && is_array($result['tools'])) ? $result['tools'] : [];

    $tools = [];
    foreach ($raw as $t) {
        if (is_object($t)) $t = (array)$t;
        if (!is_array($t)) continue;
        $tn = trim((string)($t['name'] ?? ''));
        if ($tn === '') continue;
        $tools[] = [
            'name'         => $tn,
            'description'  => (string)($t['description'] ?? ''),
            'input_schema' => oc_mcp_schema($t['inputSchema'] ?? ($t['input_schema'] ?? null)),
        ];
    }
    return $tools;
}

// 快取項 → 對外工具項
function oc_mcp_expose($server, $t) {
    $raw = (string)($t['name'] ?? '');
    return [
        'server'       => $server,
        'name'         => 'mcp__' . $server . '__' . $raw,
        'raw_name'     => $raw,
        'description'  => (string)($t['description'] ?? ''),
        'input_schema' => oc_mcp_schema($t['input_schema'] ?? null),
    ];
}

// ═══════════════════════════════════════════════════════════════
// Actions
// ═══════════════════════════════════════════════════════════════

// GET servers —— 只讀設定與快取，絕不啟動任何程序（必須夠快）
function oc_mcp_act_servers() {
    $cache   = oc_mcp_cache_read();
    $entries = $cache['servers'];
    $out     = [];

    foreach (oc_mcp_servers() as $name => $srv) {
        $ent     = isset($entries[$name]) && is_array($entries[$name]) ? $entries[$name] : null;
        $error   = $ent && !empty($ent['error']) ? (string)$ent['error'] : '';
        $tools   = $ent && isset($ent['tools']) && is_array($ent['tools']) ? $ent['tools'] : [];
        $enabled = oc_mcp_enabled($srv);

        $status = 'unknown';
        if ($enabled && $ent) $status = $error !== '' ? 'error' : 'ok';

        $out[$name] = [
            'type'       => oc_mcp_type($srv),
            'enabled'    => $enabled,
            'status'     => $status,
            'tool_count' => count($tools),
            'error'      => $error !== '' ? $error : null,
            'checked'    => $ent ? (int)($ent['ts'] ?? 0) : 0,
            'target'     => oc_mcp_type($srv) === 'http'
                            ? (string)($srv['url'] ?? '')
                            : trim((string)($srv['command'] ?? '')),
        ];
    }

    oc_ok(['servers' => $out ? $out : new stdClass()]);
}

// GET tools —— 聚合所有啟用中的伺服器（10 分鐘快取，refresh=1 強制更新）
function oc_mcp_act_tools() {
    $only    = trim((string)oc_arg('server', ''));
    $refresh = oc_bool('refresh', false);

    $cache   = oc_mcp_cache_read();
    $entries = $cache['servers'];
    $tools   = [];
    $errors  = [];
    $dirty   = false;
    $now     = time();

    foreach (oc_mcp_servers() as $name => $srv) {
        if ($only !== '' && $only !== $name) continue;
        if (!oc_mcp_enabled($srv)) continue;

        $ent   = isset($entries[$name]) && is_array($entries[$name]) ? $entries[$name] : null;
        $fresh = $ent !== null && !$refresh && ($now - (int)($ent['ts'] ?? 0)) < OC_MCP_CACHE_TTL;

        if ($fresh) {
            if (!empty($ent['error'])) $errors[$name] = (string)$ent['error'];
            foreach (($ent['tools'] ?? []) as $t) {
                if (is_array($t)) $tools[] = oc_mcp_expose($name, $t);
            }
            continue;
        }

        try {
            $list = oc_mcp_list_tools($name, $srv);
            $entries[$name] = ['ts' => $now, 'type' => oc_mcp_type($srv), 'tools' => $list, 'error' => null];
            foreach ($list as $t) $tools[] = oc_mcp_expose($name, $t);
        } catch (Throwable $e) {
            $msg = $e->getMessage();
            $entries[$name] = ['ts' => $now, 'type' => oc_mcp_type($srv), 'tools' => [], 'error' => $msg];
            $errors[$name]  = $msg;
            oc_log('mcp', 'tools/list ' . $name . ' 失敗：' . $msg);
        }
        $dirty = true;
    }

    if ($dirty) oc_mcp_cache_write($entries);

    oc_ok([
        'tools'  => $tools,
        'errors' => $errors ? $errors : new stdClass(),
        'cached' => !$dirty,
    ]);
}

// POST call —— {server, name, arguments}
function oc_mcp_act_call() {
    $server = trim((string)oc_arg('server', ''));
    $name   = trim((string)oc_arg('name', ''));
    if ($name === '') oc_fail('缺少工具名稱 name', 400);

    // 名稱可能是 mcp__<server>__<tool> 前綴形式
    if ($server === '' && preg_match('/^mcp__(.+?)__(.+)$/', $name, $m)) {
        $server = $m[1];
        $name   = $m[2];
    }
    $prefix = 'mcp__' . $server . '__';
    if ($server !== '' && strpos($name, $prefix) === 0) $name = substr($name, strlen($prefix));
    if ($name === '') oc_fail('工具名稱解析後為空', 400);

    $srv = oc_mcp_need($server);
    if (!oc_mcp_enabled($srv)) oc_fail('MCP 伺服器「' . $server . '」已停用', 400);

    $args = oc_arg('arguments', null);
    if (is_object($args)) $args = (array)$args;
    if (!is_array($args)) $args = [];

    try {
        $resp = oc_mcp_request($server, $srv, 'tools/call', [
            'name'      => $name,
            'arguments' => $args ? $args : new stdClass(),
        ]);
    } catch (Throwable $e) {
        oc_log('mcp', 'tools/call ' . $server . '__' . $name . ' 失敗：' . $e->getMessage());
        oc_fail('MCP 工具呼叫失敗：' . $e->getMessage(), 502);
    }

    // JSON-RPC 層級錯誤：回成 isError 結果，讓模型看得到原文並自我修正
    if (isset($resp['error'])) {
        oc_ok(['result' => [
            'content' => [['type' => 'text', 'text' => oc_mcp_err_msg($resp['error'])]],
            'isError' => true,
        ], 'server' => $server, 'tool' => $name]);
    }

    oc_ok([
        'result' => oc_mcp_normalize_result($resp['result'] ?? null),
        'server' => $server,
        'tool'   => $name,
    ]);
}

// 把任意回傳值正規化成 {content:[{type,text}], isError}
function oc_mcp_normalize_result($result) {
    if (is_object($result)) $result = (array)$result;

    if (is_array($result) && isset($result['content']) && is_array($result['content'])) {
        $blocks = [];
        foreach ($result['content'] as $b) {
            if (is_object($b)) $b = (array)$b;
            if (is_string($b)) { $blocks[] = ['type' => 'text', 'text' => $b]; continue; }
            if (!is_array($b)) { $blocks[] = ['type' => 'text', 'text' => oc_json_encode($b)]; continue; }
            if (!isset($b['type'])) $b['type'] = isset($b['text']) ? 'text' : 'unknown';
            if ($b['type'] === 'text' && !isset($b['text'])) $b['text'] = '';
            if ($b['type'] === 'text' && !is_string($b['text'])) $b['text'] = oc_json_encode($b['text']);
            $blocks[] = $b;
        }
        if (!$blocks) $blocks = [['type' => 'text', 'text' => '（工具沒有回傳內容）']];
        return ['content' => $blocks, 'isError' => !empty($result['isError'])];
    }

    if ($result === null) {
        return ['content' => [['type' => 'text', 'text' => '（工具沒有回傳內容）']], 'isError' => false];
    }

    $text = is_string($result) ? $result : oc_json_encode($result);
    return ['content' => [['type' => 'text', 'text' => $text]], 'isError' => false];
}

// POST save —— {servers}
function oc_mcp_act_save() {
    $servers = oc_arg('servers', null);
    if (is_object($servers)) $servers = (array)$servers;
    if ($servers === null || !is_array($servers)) oc_fail('缺少 servers（需為物件）', 400);

    $clean = [];
    foreach ($servers as $name => $srv) {
        $name = trim((string)$name);
        if ($name === '') continue;
        if (!preg_match('/^[A-Za-z0-9_.\-]{1,64}$/', $name)) {
            oc_fail('MCP 伺服器名稱不合法：' . $name . '（僅允許英數字、底線、句點、連字號）', 400);
        }
        if (is_object($srv)) $srv = (array)$srv;
        if (!is_array($srv)) oc_fail('MCP 伺服器「' . $name . '」設定格式錯誤', 400);

        $type  = oc_mcp_type($srv);
        $entry = ['type' => $type, 'enabled' => oc_mcp_enabled($srv)];

        if ($type === 'http') {
            $url = trim((string)($srv['url'] ?? ''));
            if (!preg_match('#^https?://#i', $url)) {
                oc_fail('MCP 伺服器「' . $name . '」的 url 必須是 http(s):// 開頭', 400, $url);
            }
            $entry['url'] = $url;
            $h = $srv['headers'] ?? [];
            if (is_object($h)) $h = (array)$h;
            $entry['headers'] = is_array($h) && $h ? array_map('strval', $h) : new stdClass();
        } else {
            $command = trim((string)($srv['command'] ?? ''));
            if ($command === '') oc_fail('MCP 伺服器「' . $name . '」缺少 command', 400);
            $args = $srv['args'] ?? [];
            if (is_object($args)) $args = (array)$args;
            if (is_string($args)) $args = preg_split('/\s+/', trim($args), -1, PREG_SPLIT_NO_EMPTY);
            if (!is_array($args)) $args = [];
            $env = $srv['env'] ?? [];
            if (is_object($env)) $env = (array)$env;

            $entry['command'] = $command;
            $entry['args']    = array_values(array_map('strval', $args));
            $entry['env']     = is_array($env) && $env ? array_map('strval', $env) : new stdClass();
            if (!empty($srv['cwd'])) $entry['cwd'] = str_replace('\\', '/', (string)$srv['cwd']);
        }

        $clean[$name] = $entry;
    }

    oc_cfg_save(['mcpServers' => $clean ? $clean : new stdClass()]);
    oc_mcp_cache_clear();                                   // 設定變了，快取一律作廢

    oc_ok(['saved' => count($clean), 'servers' => $clean ? $clean : new stdClass()]);
}

// POST test —— {name}：實際跑一次 tools/list（不吃快取）
function oc_mcp_act_test() {
    $name = trim((string)oc_arg('name', oc_arg('server', '')));
    $srv  = oc_mcp_need($name);

    $cache   = oc_mcp_cache_read();
    $entries = $cache['servers'];

    try {
        $list = oc_mcp_list_tools($name, $srv);
        $entries[$name] = ['ts' => time(), 'type' => oc_mcp_type($srv), 'tools' => $list, 'error' => null];
        oc_mcp_cache_write($entries);
        oc_ok([
            'name'       => $name,
            'status'     => 'ok',
            'tool_count' => count($list),
            'error'      => null,
            'tools'      => array_map(function ($t) { return $t['name']; }, $list),
        ]);
    } catch (Throwable $e) {
        $msg = $e->getMessage();
        $entries[$name] = ['ts' => time(), 'type' => oc_mcp_type($srv), 'tools' => [], 'error' => $msg];
        oc_mcp_cache_write($entries);
        oc_log('mcp', 'test ' . $name . ' 失敗：' . $msg);
        oc_ok(['name' => $name, 'status' => 'error', 'tool_count' => 0, 'error' => $msg]);
    }
}
