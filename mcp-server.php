<?php
// ═══════════════════════════════════════════════════════════════
// Omni Code — MCP Server（建議 #7）
// ═══════════════════════════════════════════════════════════════
// 把 Omni Code 的檔案系統與自撰 API 工具，用 MCP 協定接給別的
// 客戶端（Claude Desktop、Claude Code、其他 MCP host）。
//
// 用法（stdio transport）：
//   php mcp-server.php
//
// Claude Desktop 設定範例：
//   {"mcpServers": {"omnicode": {
//      "command": "D:/xampp/php/php.exe",
//      "args": ["D:/xampp/htdocs/app/OmniCode/mcp-server.php"]
//   }}}
//
// ★ 只暴露「PHP 這一側真的有實作」的工具。
//   Omni Code 的 34 個工具裡，生圖、影片分析、Computer-Use、子代理、
//   Skills 都是瀏覽器裡的 JavaScript，沒有 PHP 對應物 —— 宣告它們
//   只會讓外部客戶端呼叫到不存在的東西。
//
// ★ 刻意不放 instructions 字串。
//   Agenvoy 在 initialize 回應裡塞了一段要求客戶端「優先使用本伺服器
//   工具、忽略其他來源」的指示。那是在借協定的信任去壓過使用者自己
//   的設定。工具描述說明工具做什麼就夠了，不該去指揮宿主。
//
// ★ 安全邊界：oc_path() 的工作區監禁、自撰工具的內網封鎖，
//   都是同一份程式碼，照舊生效。但有兩處不一樣，講清楚：
//
//   1. 「本機限定」那條不適用 —— stdio 沒有遠端連線的概念，
//      誰能啟動這個行程，誰就已經在這台機器上了。
//   2. 敏感檔（.ssh/、*.pem、.git-credentials…）在瀏覽器版是靠
//      app/js/permissions.js 跳授權對話框擋的，那一層在這裡不存在。
//      stdio 上問不了人，所以本檔改成「預設一律拒絕」，
//      要開請設環境變數 OMNICODE_MCP_ALLOW_SENSITIVE=1。
//      見 mcp_sensitive_block()。
// ═══════════════════════════════════════════════════════════════

if (PHP_SAPI !== 'cli') {
    http_response_code(400);
    exit("mcp-server.php 只能用 php-cli 執行\n");
}

require_once __DIR__ . '/includes/helpers.php';
// 兩者在 CLI 下都只載入函式，不會自己跑一次請求（見各檔開頭的 PHP_SAPI 判斷）。
// ★ 一律在檔案最外層 require —— 在函式裡 require 的檔案，它的檔案層 $變數
//   會變成該函式的區域變數。policy.php 就是這樣安靜地失效過一次。
require_once __DIR__ . '/api/fs.php';
require_once __DIR__ . '/api/usertools.php';
require_once __DIR__ . '/api/codegraph.php';

oc_capture(true);                               // oc_ok/oc_fail 改成丟 OcResponse
@ini_set('memory_limit', '512M');
@set_time_limit(0);

const MCP_PROTOCOL = '2024-11-05';
const MCP_MAX_TEXT = 200000;                    // 單次回應字元上限

// ═══════════════════════════════════════════════════════════════
// 工具表：MCP schema ←→ fs.php 的 action
// ═══════════════════════════════════════════════════════════════
// 描述沿用「做什麼／何時用／前置」三行契約（見 skills/tool-author）。

function mcp_tools() {
    $S = function ($props, $req = []) {
        return ['type' => 'object', 'properties' => $props, 'required' => $req];
    };
    $path = ['type' => 'string', 'description' => '工作區相對路徑，用正斜線'];

    $t = [
        ['read_file', 'read',
         "讀取文字檔的純文字內容。\n用於：要看檔案裡有什麼、或改檔案之前先確認現況。\n前置：無。",
         $S(['path' => $path,
             'offset' => ['type' => 'integer', 'description' => '起始行（1 起算），大檔可分段讀'],
             'limit'  => ['type' => 'integer', 'description' => '讀幾行，預設 2000']], ['path'])],

        ['write_file', 'write',
         "把內容整份寫進檔案（會覆蓋原有內容）。\n用於：建立新檔，或整份重寫。\n前置：要改既有檔案的一小部分請改用 edit_file。",
         $S(['path' => $path, 'content' => ['type' => 'string']], ['path', 'content'])],

        ['edit_file', 'edit',
         "把檔案裡的一段文字換成另一段。\n用於：修改既有檔案的局部內容。\n前置：old 必須在檔案中唯一出現，否則會失敗。",
         $S(['path'        => $path,
             'old_string'  => ['type' => 'string', 'description' => '要被取代的原文，必須完全一致'],
             'new_string'  => ['type' => 'string', 'description' => '取代成的新內容'],
             'replace_all' => ['type' => 'boolean', 'description' => 'true = 取代全部出現處']],
            ['path', 'old_string', 'new_string'])],

        ['list_dir', 'list',
         "列出一層目錄的內容。\n用於：想知道某個資料夾裡有什麼。\n前置：無。",
         $S(['path' => $path], [])],

        ['project_tree', 'tree',
         "遞迴列出目錄樹。\n用於：第一次接觸專案、想快速掌握結構時。\n前置：無。",
         $S(['path' => $path,
             'depth' => ['type' => 'integer', 'description' => '最大深度，預設 3']], [])],

        ['glob', 'glob',
         "用萬用字元樣式找檔案，例如 **/*.php。\n用於：知道檔名長相、不知道放在哪。\n前置：無。",
         $S(['pattern' => ['type' => 'string', 'description' => '例如 src/**/*.js'],
             'path'    => $path,
             'limit'   => ['type' => 'integer']], ['pattern'])],

        ['grep', 'grep',
         "在檔案內容中搜尋正規表示式。\n用於：知道要找什麼字串／符號，不知道在哪個檔。\n前置：無。",
         $S(['pattern'     => ['type' => 'string', 'description' => 'PCRE 正規表示式'],
             'path'        => $path,
             'glob'        => ['type' => 'string', 'description' => '只搜尋符合此樣式的檔案'],
             'mode'        => ['type' => 'string', 'enum' => ['content', 'files', 'count']],
             'ignore_case' => ['type' => 'boolean'],
             'literal'     => ['type' => 'boolean', 'description' => 'true = 當成純字串，不是正規表示式'],
             'context'     => ['type' => 'integer', 'description' => '前後各顯示幾行，0–20'],
             'limit'       => ['type' => 'integer']], ['pattern'])],

        ['file_stat', 'stat',
         "查一個檔案或目錄的中繼資料：大小、行數、修改時間、類型。\n用於：讀檔之前先確認它多大、是不是二進位。\n前置：無。",
         $S(['path' => $path], ['path'])],

        ['make_dir', 'mkdir',
         "建立目錄（含中間層）。\n用於：寫檔之前目標資料夾還不存在時。\n前置：無。",
         $S(['path' => $path], ['path'])],

        ['move_path', 'move',
         "移動或重新命名檔案／目錄。\n用於：搬檔案、改檔名。\n前置：目標位置不能已經有東西。",
         $S(['from' => $path, 'to' => $path], ['from', 'to'])],

        ['copy_path', 'copy',
         "複製檔案或目錄。\n用於：要保留原檔又需要一份副本時。\n前置：無。",
         $S(['from' => $path, 'to' => $path], ['from', 'to'])],

        ['delete_path', 'delete',
         "刪除檔案或目錄。\n用於：確定不要的檔案。\n前置：這個動作無法復原，刪之前請先確認。",
         $S(['path' => $path,
             'recursive' => ['type' => 'boolean', 'description' => '刪目錄時必須為 true']], ['path'])],

        ['repo_map', 'map',
         "結構化程式碼圖譜：專案第一眼（目錄聚類＋熱點符號，按被引用數排序）。\n用於：剛接觸專案、想知道哪裡是核心時。\n前置：無。",
         $S(['path' => $path,
             'no_refresh' => ['type' => 'boolean', 'description' => 'true = 直接讀快取']],
            []), '_cg'],

        ['file_api', 'file_api',
         "結構化程式碼圖譜：某檔案的全部簽名（無函式體），約 1/10 token 拿到 API 面。\n用於：要呼叫某檔的函式但不想整檔讀進來。\n前置：無。",
         $S(['path' => $path], ['path']), '_cg'],

        ['trace_calls', 'trace',
         "結構化程式碼圖譜：查某符號誰在用（in）或它依賴誰（out），改簽名前看影響範圍。\n用於：改函式、刪函式、評估重構影響。\n前置：無。",
         $S(['symbol' => ['type' => 'string', 'description' => '符號名，例如 oc_path'],
             'direction' => ['type' => 'string', 'enum' => ['in', 'out']],
             'depth' => ['type' => 'integer', 'description' => '追幾層，1–5']], ['symbol']), '_cg'],

        ['find_refs', 'search',
         "結構化程式碼圖譜：找某字串的每個出現處，按包圍符號分組排序。\n用於：「每個出現處都要改」類任務。\n前置：無。",
         $S(['pattern' => ['type' => 'string', 'description' => 'PCRE 正規表示式'],
             'path' => $path,
             'literal' => ['type' => 'boolean', 'description' => 'true = 當純字串'],
             'ignore_case' => ['type' => 'boolean'],
             'limit' => ['type' => 'integer']], ['pattern']), '_cg'],

        ['get_architecture', 'architecture',
         "結構化程式碼圖譜：5 分鐘心智地圖（語言、入口、路由、套件邊界、hotspots、目錄分佈）。\n用於：剛接手陌生專案、想 30 秒知道這是什麼樣的程式庫。\n前置：無。",
         $S(['no_refresh' => ['type' => 'boolean', 'description' => 'true = 直接讀快取']], []), '_cg'],

        ['detect_changes', 'detect_changes',
         "結構化程式碼圖譜：把 git diff 對應到被影響的符號 + 風險分級 + blast radius。\n用於：改完想發 PR 前，確認這次改了會炸到誰。\n前置：工作區必須是 git repo（或允許退到 mtime 近似）。",
         $S(['no_refresh' => ['type' => 'boolean'],
             'limit' => ['type' => 'integer', 'description' => '每個高風險符號最多列幾個呼叫者，預設 30'],
             'max_risk' => ['type' => 'integer', 'description' => '受影響符號清單上限，預設 20']], []), '_cg'],
    ];

    $out = [];
    foreach ($t as $row) {
        [$name, $action, $desc, $schema] = $row;
        $cg = ($row[4] ?? '') === '_cg';
        $out[] = ['name' => $name, 'description' => $desc,
                  'inputSchema' => $schema,
                  $cg ? '_cg_action' : '_action' => $action];
    }

    // 使用者自撰的 API 工具（建議 #4）—— 同一份定義，兩個地方共用
    foreach (@glob(OC_DATA . '/tools/api/*.json') ?: [] as $f) {
        $u = oc_read_json($f, null);
        if (!is_array($u) || empty($u['name'])) continue;
        $out[] = [
            'name'        => $u['name'],
            'description' => '[自訂 API 工具] ' . ($u['description'] ?? ''),
            'inputSchema' => is_array($u['params'] ?? null) ? $u['params']
                                                            : ['type' => 'object', 'properties' => []],
            '_usertool'   => $u['name'],
        ];
    }
    return $out;
}

// ═══════════════════════════════════════════════════════════════
// 呼叫
// ═══════════════════════════════════════════════════════════════

/**
 * 敏感檔閘門。
 *
 * ★ 這一段在瀏覽器版是 app/js/permissions.js 做的（讀 stat 回傳的
 *   sensitive 欄位，跳出授權對話框）。走 MCP 時那一層根本不存在 ——
 *   oc_path() 只管工作區邊界，不管工作區「裡面」的 .ssh/、.pem、
 *   .git-credentials。所以這裡必須自己擋，否則 #3 的清單在 MCP
 *   這條路上等於沒有。
 *
 * 沒有互動式授權可用（stdio 上問不了人），所以只能二選一：
 * 預設拒絕，要開就設環境變數 OMNICODE_MCP_ALLOW_SENSITIVE=1。
 */
function mcp_sensitive_block($args) {
    if (getenv('OMNICODE_MCP_ALLOW_SENSITIVE') === '1') return '';
    foreach (['path', 'from', 'to'] as $k) {
        if (!isset($args[$k]) || !is_string($args[$k])) continue;
        $why = oc_path_sensitivity($args[$k]);
        if ($why !== '') {
            return "拒絕存取「{$args[$k]}」：{$why}。
"
                 . '這類檔案通常含有金鑰或憑證。MCP 這條路徑沒有互動式授權可用，'
                 . '所以預設一律拒絕。確實需要時，請在啟動 mcp-server.php 的環境裡'
                 . '設定 OMNICODE_MCP_ALLOW_SENSITIVE=1。';
        }
    }
    return '';
}

function mcp_call($name, $args) {
    if (!is_array($args)) $args = [];
    $tool = null;
    foreach (mcp_tools() as $t) if ($t['name'] === $name) { $tool = $t; break; }
    if (!$tool) return mcp_text("沒有這個工具：{$name}", true);

    $blocked = mcp_sensitive_block($args);
    if ($blocked !== '') return mcp_text($blocked, true);

    try {
        if (isset($tool['_usertool'])) {
            // 自撰工具走 usertools.php 的執行器（含內網封鎖與金鑰代入）
            oc_input_set(['action' => 'run', 'name' => $tool['_usertool'], 'args' => $args]);
            oc_ut_run($tool['_usertool'], $args);
            return mcp_text('(no output)');       // oc_ut_run 一定會丟 OcResponse
        }
        if (isset($tool['_cg_action'])) {
            oc_input_set(array_merge(['action' => $tool['_cg_action']], $args));
            oc_cg_dispatch($tool['_cg_action']);
        } else {
            oc_input_set(array_merge(['action' => $tool['_action']], $args));
            oc_fs_dispatch($tool['_action']);
        }
        return mcp_text('(no output)');
    } catch (OcResponse $r) {
        $p = $r->payload;
        if (!empty($p['ok'])) {
            if (isset($tool['_usertool'])) {
                // 自撰工具：攤成「HTTP 狀態 + 回應內容」，跟瀏覽器版一致
                return mcp_text('HTTP ' . ($p['status'] ?? '?') . '（' . ($p['ms'] ?? '?') . "ms）
"
                    . (string)($p['body'] ?? '')
                    . (!empty($p['truncated']) ? "
…（回應過大已截斷）" : ''),
                    ($p['status'] ?? 0) < 200 || ($p['status'] ?? 0) >= 400);
            }
            return mcp_text(mcp_render($tool['_cg_action'] ?? $tool['_action'] ?? '', $p));
        }
        return mcp_text('錯誤：' . ($p['error'] ?? '未知錯誤')
                        . (isset($p['detail']) ? "\n" . $p['detail'] : ''), true);
    } catch (Throwable $e) {
        return mcp_text('伺服器內部錯誤：' . $e->getMessage(), true);
    }
}

/** 把 fs.php 的 JSON 回應攤成人／模型好讀的文字 */
function mcp_render($action, $p) {
    // codegraph 查詢的回應形狀是 {text}，直接攤出（同 read 的 content）
    if (isset($p['text']) && in_array($action, ['map', 'file_api', 'trace', 'search', 'build'], true)) {
        return (string)$p['text'];
    }
    switch ($action) {
        case 'read':
            if (!empty($p['binary'])) return "（二進位檔，{$p['size']} bytes，無法以文字顯示）";
            $s = (string)($p['content'] ?? '');
            if (!empty($p['truncated'])) {
                $s .= "\n\n…（只顯示 {$p['lines']} / {$p['total_lines']} 行，"
                    . '用 offset 參數繼續讀）';
            }
            return $s;

        case 'list':
            $rows = [];
            foreach ($p['entries'] ?? [] as $e) {
                $rows[] = (($e['type'] ?? '') === 'dir' ? '[DIR]  ' : '       ') . $e['name']
                        . (($e['type'] ?? '') === 'dir' ? '/' : '  (' . ($e['size'] ?? 0) . ' bytes)');
            }
            return $rows ? implode("
", $rows) : '（空目錄）';

        case 'tree':
            $lines = [];
            $walk = function ($n, $ind) use (&$walk, &$lines) {
                $lines[] = str_repeat('  ', $ind) . ($n['name'] ?? '?')
                         . (isset($n['children']) ? '/' : '');
                foreach ($n['children'] ?? [] as $c) $walk($c, $ind + 1);
            };
            $walk($p['tree'] ?? [], 0);
            if (!empty($p['truncated'])) $lines[] = '…（節點數超過上限，只顯示部分）';
            return implode("
", $lines);

        case 'glob':
            $f = $p['files'] ?? [];
            return $f ? implode("
", $f) . "

共 " . count($f) . ' 個檔案'
                      : '（沒有符合的檔案）';

        case 'grep':
            // 三種 mode 三種回應形狀，各自攤平
            if (isset($p['matches'])) {
                if (!$p['matches']) return '（沒有符合的內容）';
                $rows = [];
                foreach ($p['matches'] as $m) {
                    foreach ($m['before'] ?? [] as $b) $rows[] = '  ' . $m['file'] . '- ' . $b;
                    $rows[] = $m['file'] . ':' . $m['line'] . ': ' . $m['text'];
                    foreach ($m['after'] ?? [] as $a) $rows[] = '  ' . $m['file'] . '- ' . $a;
                }
                $s = implode("
", $rows) . "

共 " . $p['count'] . ' 處';
                if (!empty($p['hint'])) $s .= "
⚠ " . $p['hint'];
                return $s;
            }
            if (isset($p['files']))  return implode("
", $p['files']) . "

共 " . $p['count'] . ' 個檔案';
            if (isset($p['counts'])) {
                $rows = [];
                foreach ($p['counts'] as $c) $rows[] = $c['count'] . "	" . $c['file'];
                return implode("
", $rows) . "

總計 " . $p['total'] . ' 處';
            }
            break;

        default: break;
    }
    unset($p['ok']);
    return oc_json_encode($p);
}

function mcp_text($s, $isError = false) {
    $s = (string)$s;
    if (strlen($s) > MCP_MAX_TEXT) {
        $s = substr($s, 0, MCP_MAX_TEXT) . "\n\n…（回應過長已截斷）";
    }
    $r = ['content' => [['type' => 'text', 'text' => $s]]];
    if ($isError) $r['isError'] = true;
    return $r;
}

// ═══════════════════════════════════════════════════════════════
// JSON-RPC over stdio
// ═══════════════════════════════════════════════════════════════

function mcp_send($msg) {
    $out = oc_json_encode($msg);
    fwrite(STDOUT, $out . "\n");
    fflush(STDOUT);
}

function mcp_handle($req) {
    $id     = $req['id'] ?? null;
    $method = (string)($req['method'] ?? '');
    $params = is_array($req['params'] ?? null) ? $req['params'] : [];

    // 通知（沒有 id）不需要回覆
    $isNotify = !array_key_exists('id', $req);

    switch ($method) {
        case 'initialize':
            return $isNotify ? null : ['jsonrpc' => '2.0', 'id' => $id, 'result' => [
                'protocolVersion' => MCP_PROTOCOL,
                'capabilities'    => ['tools' => ['listChanged' => false]],
                'serverInfo'      => ['name' => 'omnicode', 'version' => '1.0.0'],
                // 這裡刻意沒有 instructions —— 見檔頭說明
            ]];

        case 'notifications/initialized':
        case 'notifications/cancelled':
            return null;

        case 'ping':
            return $isNotify ? null : ['jsonrpc' => '2.0', 'id' => $id, 'result' => new stdClass()];

        case 'tools/list':
            $list = [];
            foreach (mcp_tools() as $t) {
                unset($t['_action'], $t['_usertool']);
                $list[] = $t;
            }
            return ['jsonrpc' => '2.0', 'id' => $id, 'result' => ['tools' => $list]];

        case 'tools/call':
            $r = mcp_call((string)($params['name'] ?? ''), $params['arguments'] ?? []);
            return ['jsonrpc' => '2.0', 'id' => $id, 'result' => $r];

        default:
            if ($isNotify) return null;
            return ['jsonrpc' => '2.0', 'id' => $id,
                    'error' => ['code' => -32601, 'message' => '不支援的方法：' . $method]];
    }
}

// ─── 主迴圈 ─────────────────────────────────────────────────────
// 逐行 JSON（stdio transport 的標準做法）。
while (($line = fgets(STDIN)) !== false) {
    $line = trim($line);
    if ($line === '') continue;
    $req = json_decode($line, true);
    if (!is_array($req)) {
        mcp_send(['jsonrpc' => '2.0', 'id' => null,
                  'error' => ['code' => -32700, 'message' => 'JSON 解析失敗']]);
        continue;
    }
    try {
        $res = mcp_handle($req);
    } catch (Throwable $e) {
        $res = ['jsonrpc' => '2.0', 'id' => $req['id'] ?? null,
                'error' => ['code' => -32603, 'message' => $e->getMessage()]];
    }
    if ($res !== null) mcp_send($res);
}
