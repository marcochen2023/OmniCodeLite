<?php
// ═══════════════════════════════════════════════════════════════
// Omni Code — 共用函式庫
// ═══════════════════════════════════════════════════════════════
// 所有 api/*.php 的第一行都應是：
//   require_once __DIR__ . '/../includes/helpers.php';
//   oc_boot();
// oc_boot() 會設定標頭、處理 OPTIONS、守門本機連線、建立資料目錄。
// ═══════════════════════════════════════════════════════════════

require_once __DIR__ . '/config.php';

// ─── 啟動 ───────────────────────────────────────────────────────
function oc_boot($json = true) {
    @ini_set('display_errors', '0');
    error_reporting(E_ALL & ~E_DEPRECATED & ~E_NOTICE & ~E_WARNING);
    @set_time_limit(0);
    @ini_set('memory_limit', '512M');
    if ($json) header('Content-Type: application/json; charset=utf-8');
    oc_cors();
    oc_guard_local();
    foreach ([OC_DATA, OC_SESSIONS, OC_SHELLS, OC_MEMORY, OC_LOGS] as $d) {
        if (!is_dir($d)) @mkdir($d, 0777, true);
    }
    set_exception_handler(function ($e) {
        oc_fail('伺服器內部錯誤：' . $e->getMessage(), 500, $e->getFile() . ':' . $e->getLine());
    });
}

function oc_cors() {
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With');
    header('Access-Control-Max-Age: 86400');
    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') { http_response_code(204); exit; }
}

// 僅允許本機存取 —— 這是 Omni Code 唯一的網路安全邊界。
function oc_guard_local() {
    if (!OC_LOCAL_ONLY) return;
    $ip = $_SERVER['REMOTE_ADDR'] ?? '';
    $ok = in_array($ip, ['127.0.0.1', '::1', 'localhost', '0.0.0.0', ''], true)
          || strpos($ip, '127.') === 0;
    if (!$ok) {
        http_response_code(403);
        echo json_encode(['ok' => false, 'error' => 'Omni Code 僅接受本機連線'], JSON_UNESCAPED_UNICODE);
        exit;
    }
}

// ─── 輸入 / 輸出 ────────────────────────────────────────────────
function oc_input_set($args) {
    // MCP 模式：一個行程要跑很多次請求，每次換掉輸入。
    $GLOBALS['__oc_input_override'] = is_array($args) ? $args : [];
}

function oc_input() {
    if (isset($GLOBALS['__oc_input_override'])) return $GLOBALS['__oc_input_override'];
    static $cache = null;
    if ($cache !== null) return $cache;
    $raw  = file_get_contents('php://input');
    $body = $raw ? json_decode($raw, true) : null;
    if (!is_array($body)) $body = [];
    $cache = array_merge($_GET, $body);
    return $cache;
}

function oc_arg($key, $default = null) {
    $in = oc_input();
    return array_key_exists($key, $in) ? $in[$key] : $default;
}

function oc_bool($key, $default = false) {
    $v = oc_arg($key, $default);
    if (is_bool($v)) return $v;
    if (is_string($v)) return in_array(strtolower($v), ['1', 'true', 'yes', 'on'], true);
    return (bool)$v;
}

function oc_int($key, $default = 0) {
    $v = oc_arg($key, $default);
    return is_numeric($v) ? (int)$v : $default;
}

function oc_json_encode($data) {
    $flags = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR;
    if (defined('JSON_INVALID_UTF8_SUBSTITUTE')) $flags |= JSON_INVALID_UTF8_SUBSTITUTE;
    return json_encode($data, $flags);
}

// ─── 攔截模式 ───────────────────────────────────────────────────
// HTTP 端點的 oc_ok()/oc_fail() 是「印出來然後結束行程」。
// mcp-server.php 要在同一個行程裡連續處理很多個請求，不能讓它們 exit。
// 打開攔截模式後兩者改成丟 OcResponse，由呼叫端接住 —— 端點程式碼
// 一行都不用改，這是刻意的：改動 18 個 case 的回應方式風險太高。
class OcResponse extends Exception {
    public $payload;
    public $status;
    public function __construct($payload, $status = 200) {
        parent::__construct(is_array($payload) ? ($payload['error'] ?? 'ok') : 'ok');
        $this->payload = $payload;
        $this->status  = $status;
    }
}

function oc_capture($on = null) {
    static $flag = false;
    if ($on !== null) $flag = (bool)$on;
    return $flag;
}

function oc_ok($payload = []) {
    $out = array_merge(['ok' => true], $payload);
    if (oc_capture()) throw new OcResponse($out, 200);
    echo oc_json_encode($out);
    exit;
}

function oc_fail($msg, $code = 400, $detail = null) {
    $out = ['ok' => false, 'error' => $msg];
    if ($detail !== null) $out['detail'] = $detail;
    if (oc_capture()) throw new OcResponse($out, $code);
    http_response_code($code);
    echo oc_json_encode($out);
    exit;
}

// 敏感資源政策。★ 一定要在檔案最外層載入 ——
// 在函式裡 require 的話，policy.php 的 $OC_DENIED_* 會變成該函式的
// 區域變數，oc_policy_is_sensitive() 裡的 global 全部拿到 null，
// 整份敏感檔清單會「安靜地」失效（warning 被 oc_boot 關掉了）。
require_once __DIR__ . '/policy.php';

// ─── 設定檔 ─────────────────────────────────────────────────────
function oc_cfg_defaults() {
    return [
        'workspace'      => OC_DEFAULT_WORKSPACE,
        'permissionMode' => 'default',       // plan | default | acceptEdits | full
        // Effort（推理強度）—— 等級名稱沿用 Claude Code
        'effortLevel'    => 'high',          // off | low | medium | high | xhigh | max
        'thinkingLevel'  => null,            // 舊鍵，只在前端遷移時讀一次
        'transport'      => 'direct',        // direct | relay
        'model'          => 'claude-sonnet-5',
        'imageModel'     => 'gemini-3.1-flash-image',
        'autoCompactAt'  => 0.75,
        'maxTurns'       => 40,
        'thinking'       => false,
        'theme'          => 'dark',
        'locale'         => 'en',           // 介面語系預設英文：en | zh-TW | zh-CN | ja | ko
        'mcpServers'     => new stdClass(),
        'extraApiHosts'  => [],
        'allowRules'     => [],
        'denyRules'      => [],
        'sentinel'       => true,            // Sentinel 獨立監控總開關（契約 §13.5）
        'sentinelNetAsk' => true,            // default 模式下對外連線每會話問一次
        'scopeRules'     => new stdClass(),  // 工具名 => allow|ask|deny（只針對 act 範圍）
        'privacyTrain'   => false,           // 對話是否可用於訓練（預設否；純宣告，給未來的 relay 用）
        'keys'           => new stdClass(),  // provider => key（選擇性伺服器端保存）
        'recentWorkspaces' => [],
        // 目前會話掛載的額外工作資料夾（跟著對話走，由 loadSession 同步進來）。
        // 後端 oc_path() 的放行依據：[{alias, path}]，上限見 OC_EXTRA_ROOTS_MAX。
        // 會話檔各記一份（extraRoots），這裡是「作用中」的那一份。
        'activeExtraRoots' => [],
    ];
}

// 額外工作資料夾上限（跟著對話走，一次最多掛幾個）
define('OC_EXTRA_ROOTS_MAX', 5);

function oc_cfg($fresh = false) {
    static $cfg = null;
    if ($cfg !== null && !$fresh) return $cfg;
    $defaults = oc_cfg_defaults();
    $cfg = $defaults;
    if (is_file(OC_CONFIG_FILE)) {
        $raw = @file_get_contents(OC_CONFIG_FILE);
        $j   = $raw ? json_decode($raw, true) : null;
        if (is_array($j)) $cfg = array_merge($defaults, $j);
    }
    if (empty($cfg['workspace'])) $cfg['workspace'] = OC_DEFAULT_WORKSPACE;
    $cfg['workspace'] = oc_norm_slashes($cfg['workspace']);
    return $cfg;
}

function oc_cfg_save($cfg) {
    $cfg = array_merge(oc_cfg(), $cfg);
    if (!is_dir(OC_DATA)) @mkdir(OC_DATA, 0777, true);
    $r = @file_put_contents(OC_CONFIG_FILE, oc_json_encode($cfg), LOCK_EX);
    if ($r === false) oc_fail('無法寫入設定檔 data/config.json', 500);
    oc_cfg(true);
    return $cfg;
}

// ─── 路徑安全 ───────────────────────────────────────────────────
function oc_norm_slashes($p) {
    $p = str_replace('\\', '/', (string)$p);
    $p = preg_replace('#/+#', '/', $p);
    if (strlen($p) > 1) $p = rtrim($p, '/');
    // 保留 "D:/" 這種磁碟根
    if (preg_match('#^[A-Za-z]:$#', $p)) $p .= '/';
    return $p;
}

// 工作區絕對路徑（正規化、斜線統一）
function oc_ws() {
    static $ws = null;
    if ($ws !== null) return $ws;
    $cfg  = oc_cfg();
    $path = $cfg['workspace'];
    $real = @realpath($path);
    $ws   = oc_norm_slashes($real !== false ? $real : $path);
    return $ws;
}

// 作用中的額外工作資料夾（跟著對話走，由 loadSession 經 settings 同步）。
// [{alias, path}]，path 為正規化後的絕對路徑。oc_path() 的放行依據。
function oc_extra_roots() {
    static $roots = null;
    if ($roots !== null) return $roots;
    $roots = [];
    $cfg = oc_cfg();
    $list = $cfg['activeExtraRoots'] ?? [];
    if (!is_array($list)) return $roots;
    foreach (array_slice($list, 0, OC_EXTRA_ROOTS_MAX) as $it) {
        if (!is_array($it)) continue;
        $alias = trim((string)($it['alias'] ?? ''));
        $path  = oc_norm_slashes((string)($it['path'] ?? ''));
        if ($alias === '' || $path === '') continue;
        if (!preg_match('/^[A-Za-z0-9_-]{1,32}$/', $alias)) continue;
        $real = @realpath($path);
        if ($real === false || !is_dir($real)) continue;
        $roots[] = ['alias' => $alias, 'path' => oc_norm_slashes($real)];
    }
    return $roots;
}

// 依 alias 找額外根；找不到回 null
function oc_extra_root($alias) {
    foreach (oc_extra_roots() as $r) {
        if (strcasecmp($r['alias'], (string)$alias) === 0) return $r;
    }
    return null;
}

// 逐段清洗相對路徑：拒絕 NUL、磁碟前綴、絕對路徑、'..'
// 接受 extra:<alias>/… 前綴（額外工作資料夾，見 oc_path）
function oc_clean_rel($rel) {
    $rel = (string)$rel;
    if ($rel === '' || $rel === '.' || $rel === './') return '';
    if (strpos($rel, "\0") !== false) oc_fail('路徑含非法字元', 400);
    $rel = str_replace('\\', '/', $rel);
    // extra:<alias>/…：alias 限英數字底線連字號，後面一律是該根下的相對路徑
    if (preg_match('#^extra:([A-Za-z0-9_-]{1,32})(?:/(.*))?$#', $rel, $m)) {
        $root = oc_extra_root($m[1]);
        if ($root === null) oc_fail('未掛載的額外資料夾：' . $m[1], 403);
        $rest = (string)($m[2] ?? '');
        $parts = [];
        foreach (explode('/', $rest) as $seg) {
            if ($seg === '' || $seg === '.') continue;
            if ($seg === '..') oc_fail('路徑不得包含 ".."（超出授權範圍）', 403);
            $parts[] = $seg;
        }
        return 'extra:' . $root['alias'] . (count($parts) ? '/' . implode('/', $parts) : '');
    }
    if (preg_match('#^[A-Za-z]:#', $rel)) {
        // 允許使用者/模型誤傳絕對路徑，只要它落在工作區「或已掛載的額外根」內就自動轉相對
        $abs = oc_norm_slashes($rel);
        $ws  = oc_ws();
        if (stripos($abs, $ws . '/') === 0) { $rel = substr($abs, strlen($ws) + 1); }
        elseif (strcasecmp($abs, $ws) === 0) { return ''; }
        else {
            foreach (oc_extra_roots() as $r) {
                if (stripos($abs, $r['path'] . '/') === 0) return 'extra:' . $r['alias'] . substr($abs, strlen($r['path']));
                if (strcasecmp($abs, $r['path']) === 0) return 'extra:' . $r['alias'];
            }
            oc_fail('路徑超出工作區範圍：' . $rel, 403);
        }
    }
    $rel   = ltrim($rel, '/');
    $parts = [];
    foreach (explode('/', $rel) as $seg) {
        if ($seg === '' || $seg === '.') continue;
        if ($seg === '..') oc_fail('路徑不得包含 ".."（超出工作區）', 403);
        $parts[] = $seg;
    }
    return implode('/', $parts);
}

// 工作區相對路徑 → 絕對路徑（含越界檢查）。
// extra:<alias>/… 走掛載的額外根（跟著對話走），其餘走工作區。
function oc_path($rel, $mustExist = false) {
    $ws    = oc_ws();
    $clean = oc_clean_rel($rel);
    if (strncmp($clean, 'extra:', 6) === 0) {
        $alias = substr($clean, 6);
        $slash = strpos($alias, '/');
        $rest  = '';
        if ($slash !== false) { $rest = substr($alias, $slash + 1); $alias = substr($alias, 0, $slash); }
        $root = oc_extra_root($alias);
        if ($root === null) oc_fail('未掛載的額外資料夾：' . $alias, 403);
        $abs = $rest === '' ? $root['path'] : ($root['path'] . '/' . $rest);
        // 第二道防線：realpath 必須仍落在該根之下（擋符號連結逃逸）
        $probe = $abs;
        $guard = 0;
        while (!file_exists($probe) && $guard++ < 64) {
            $parent = dirname($probe);
            if ($parent === $probe) break;
            $probe = $parent;
        }
        $realProbe = @realpath($probe);
        if ($realProbe !== false) {
            $realProbe = oc_norm_slashes($realProbe);
            $realRoot  = oc_norm_slashes(@realpath($root['path']) ?: $root['path']);
            if (strcasecmp($realProbe, $realRoot) !== 0 && stripos($realProbe, $realRoot . '/') !== 0) {
                oc_fail('路徑超出授權範圍', 403);
            }
        }
        if ($mustExist && !file_exists($abs)) oc_fail('路徑不存在：' . $clean, 404);
        return $abs;
    }
    $abs   = $clean === '' ? $ws : ($ws . '/' . $clean);
    // 第二道防線：對「已存在的最深祖先」做 realpath 前綴比對，擋掉符號連結逃逸
    $probe = $abs;
    $guard = 0;
    while (!file_exists($probe) && $guard++ < 64) {
        $parent = dirname($probe);
        if ($parent === $probe) break;
        $probe = $parent;
    }
    $realProbe = @realpath($probe);
    if ($realProbe !== false) {
        $realProbe = oc_norm_slashes($realProbe);
        $realWs    = oc_norm_slashes(@realpath($ws) ?: $ws);
        if (strcasecmp($realProbe, $realWs) !== 0 && stripos($realProbe, $realWs . '/') !== 0) {
            oc_fail('路徑超出工作區範圍', 403);
        }
    }
    if ($mustExist && !file_exists($abs)) oc_fail('路徑不存在：' . $clean, 404);
    return $abs;
}

/** 這條路徑是否碰到敏感資源？回傳說明字串（空 = 不敏感）。
 *  刻意「不」在這裡直接 403：授權是使用者的決定，不是後端的。
 *  前端的 checkPermission 拿這個結果把操作升級成「需要授權」。 */
// 擋掉本機與私有網段 —— relay 與使用者自撰工具共用。
// 讓 agent 定義的工具去打 192.168.* 或 localhost，等於給它一條
// 繞過所有邊界的路。
function oc_relay_guard_public($url) {
    $host = strtolower((string)parse_url($url, PHP_URL_HOST));
    $host = trim($host, '[]');   // IPv6 字面量
    $blocked =
        $host === 'localhost' || $host === '::1' || $host === '0.0.0.0'
        || substr($host, -6) === '.local'
        || preg_match('#^127\.#', $host)
        || preg_match('#^10\.#', $host)
        || preg_match('#^192\.168\.#', $host)
        || preg_match('#^169\.254\.#', $host)
        || preg_match('#^172\.(1[6-9]|2[0-9]|3[01])\.#', $host)
        || preg_match('#^(fc|fd)[0-9a-f]{2}:#i', $host);
    if ($blocked) oc_fail('不允許抓取本機或私有網段位址: ' . $host, 403);
    return $host;
}

function oc_path_sensitivity($rel) {
    return oc_policy_is_sensitive($rel);
}

function oc_rel($abs) {
    $ws  = oc_ws();
    $abs = oc_norm_slashes($abs);
    if (stripos($abs, $ws . '/') === 0) return substr($abs, strlen($ws) + 1);
    if (strcasecmp($abs, $ws) === 0) return '';
    // 落在已掛載的額外根之下 → 回 extra:<alias>/…（顯示與回寫用）
    foreach (oc_extra_roots() as $r) {
        if (stripos($abs, $r['path'] . '/') === 0) return 'extra:' . $r['alias'] . substr($abs, strlen($r['path']));
        if (strcasecmp($abs, $r['path']) === 0) return 'extra:' . $r['alias'];
    }
    return $abs;
}

// ─── 檔案判斷 ───────────────────────────────────────────────────
function oc_ext($path) {
    $b = basename($path);
    if (strpos($b, '.') === false) return strtolower($b);   // Makefile / Dockerfile
    return strtolower(pathinfo($b, PATHINFO_EXTENSION));
}

function oc_is_image($path) {
    global $OC_IMAGE_EXT;
    return in_array(oc_ext($path), $OC_IMAGE_EXT, true);
}

function oc_is_text($abs) {
    global $OC_TEXT_EXT;
    $ext = oc_ext($abs);
    if (in_array($ext, $OC_TEXT_EXT, true)) return true;
    if (oc_is_image($abs)) return false;
    if (!is_file($abs)) return false;
    $fh = @fopen($abs, 'rb');
    if (!$fh) return false;
    $chunk = fread($fh, 8192);
    fclose($fh);
    if ($chunk === '' || $chunk === false) return true;
    if (strpos($chunk, "\0") !== false) return false;
    // 非可列印字元比例過高 → 視為二進位
    $bad = preg_match_all('/[^\x09\x0A\x0D\x20-\x{10FFFF}]/u', $chunk);
    return $bad === false ? true : ($bad / max(1, strlen($chunk))) < 0.1;
}

function oc_mime($abs) {
    static $map = [
        'html'=>'text/html','htm'=>'text/html','css'=>'text/css','js'=>'text/javascript',
        'mjs'=>'text/javascript','json'=>'application/json','xml'=>'application/xml',
        'svg'=>'image/svg+xml','png'=>'image/png','jpg'=>'image/jpeg','jpeg'=>'image/jpeg',
        'gif'=>'image/gif','webp'=>'image/webp','avif'=>'image/avif','bmp'=>'image/bmp',
        'ico'=>'image/x-icon','pdf'=>'application/pdf','zip'=>'application/zip',
        'md'=>'text/markdown','txt'=>'text/plain','csv'=>'text/csv','php'=>'text/x-php',
        'woff'=>'font/woff','woff2'=>'font/woff2','ttf'=>'font/ttf','mp4'=>'video/mp4',
        'mp3'=>'audio/mpeg','wav'=>'audio/wav',
    ];
    $e = oc_ext($abs);
    return $map[$e] ?? 'application/octet-stream';
}

function oc_ignored($name) {
    global $OC_IGNORE;
    return in_array($name, $OC_IGNORE, true);
}

// ─── 雜項 ───────────────────────────────────────────────────────
function oc_id($prefix = '') {
    return $prefix . base_convert((string)round(microtime(true) * 1000), 10, 36)
           . substr(str_shuffle('abcdefghijklmnopqrstuvwxyz0123456789'), 0, 4);
}

function oc_valid_id($id) {
    return is_string($id) && preg_match('/^[A-Za-z0-9_.\-]{1,96}$/', $id) === 1;
}

function oc_read_json($file, $default = []) {
    if (!is_file($file)) return $default;
    $raw = @file_get_contents($file);
    if ($raw === false || $raw === '') return $default;
    $j = json_decode($raw, true);
    return is_array($j) ? $j : $default;
}

function oc_write_json($file, $data) {
    $dir = dirname($file);
    if (!is_dir($dir)) @mkdir($dir, 0777, true);
    return @file_put_contents($file, oc_json_encode($data), LOCK_EX) !== false;
}

function oc_log($chan, $msg) {
    if (!is_dir(OC_LOGS)) @mkdir(OC_LOGS, 0777, true);
    @file_put_contents(
        OC_LOGS . '/' . preg_replace('/[^a-z0-9_\-]/i', '', $chan) . '.log',
        date('Y-m-d H:i:s') . ' ' . (is_string($msg) ? $msg : oc_json_encode($msg)) . PHP_EOL,
        FILE_APPEND | LOCK_EX
    );
}

// 是否為 Windows
function oc_is_win() {
    return strtoupper(substr(PHP_OS_FAMILY, 0, 3)) === 'WIN' || DIRECTORY_SEPARATOR === '\\';
}

// 統一的行分割（處理 CRLF / CR / LF）
function oc_split_lines($content) {
    return preg_split("/\r\n|\n|\r/", $content);
}

// 偵測換行風格，寫回時保持一致
function oc_detect_eol($content) {
    if (strpos($content, "\r\n") !== false) return "\r\n";
    if (strpos($content, "\r") !== false && strpos($content, "\n") === false) return "\r";
    return "\n";
}
