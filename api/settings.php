<?php
require_once __DIR__ . '/../includes/helpers.php';
oc_boot();

// ═══════════════════════════════════════════════════════════════
// Omni Code — api/settings.php
// ═══════════════════════════════════════════════════════════════
// 設定讀寫、磁碟瀏覽（工作區選擇器）、工作區切換、伺服器端金鑰。
// 契約見 docs/ARCHITECTURE.md §8。
//
// 安全要點：
//   1. browse 是「唯一」不受 oc_path() 工作區限制的端點 —— 它的用途
//      就是讓使用者在整台機器上挑選工作區。它只列出「目錄名稱」，
//      不讀取任何檔案內容，且 oc_guard_local() 已擋掉非本機連線。
//   2. config['keys'] 內的金鑰原文「永不」離開伺服器：所有回應一律
//      經 oc_redact_cfg() 轉成 true/false。
// ═══════════════════════════════════════════════════════════════

$action = oc_arg('action', '');

switch ($action) {
    case 'get':           oc_settings_get();        break;
    case 'set':           oc_settings_set();        break;
    case 'browse':        oc_settings_browse();     break;
    case 'set_workspace': oc_settings_set_ws();     break;
    case 'extra_add':     oc_settings_extra_add();  break;
    case 'extra_remove':  oc_settings_extra_rm();   break;
    case 'extra_sync':    oc_settings_extra_sync(); break;
    case 'keys_set':      oc_settings_keys_set();   break;
    case 'keys_status':   oc_settings_keys_status();break;
    case 'models_get':    oc_models_get();          break;
    case 'models_save':   oc_models_save();         break;
    case 'audit':         oc_settings_audit();      break;
    case 'audit_list':    oc_settings_audit_list(); break;
    default:
        oc_fail('未知的 action: ' . $action, 404);
}

// ═══════════════════════════════════════════════════════════════
// 共用工具
// ═══════════════════════════════════════════════════════════════

// 允許伺服器端保存金鑰的供應商
function oc_key_providers() {
    // hf_token／civitai_key 是 ComfyUI 模型下載用的，不是 AI 供應商 ——
    // 但沿用同一套「只存後端、只回布林值」機制，不另開通道。
    return ['gemini', 'openai', 'anthropic', 'openrouter', 'hf_token', 'civitai_key'];
}

// 判斷一把金鑰是否「真的存在」（非空字串才算）
function oc_key_present($v) {
    return is_string($v) && trim($v) !== '';
}

// 把設定物件裡的金鑰換成 true/false —— 對外輸出一律先過這裡
function oc_redact_cfg($cfg) {
    $keys  = isset($cfg['keys']) ? (array)$cfg['keys'] : [];
    $flags = [];
    foreach (oc_key_providers() as $p) {
        $flags[$p] = oc_key_present($keys[$p] ?? null);
    }
    // 使用者若手動加了其他供應商，同樣只回布林值
    foreach ($keys as $p => $v) {
        if (!array_key_exists($p, $flags)) $flags[$p] = oc_key_present($v);
    }
    $cfg['keys']         = (object)$flags;
    $cfg['keysOnServer'] = (object)$flags;   // §8 契約用的別名

    // 空的 mcpServers 要維持 JSON 物件 {}，不能變成陣列 []
    if (isset($cfg['mcpServers']) && is_array($cfg['mcpServers']) && count($cfg['mcpServers']) === 0) {
        $cfg['mcpServers'] = new stdClass();
    }
    // 這幾個一定要是 JSON 陣列
    foreach (['extraApiHosts', 'allowRules', 'denyRules', 'recentWorkspaces', 'activeExtraRoots'] as $k) {
        $cfg[$k] = isset($cfg[$k]) && is_array($cfg[$k]) ? array_values($cfg[$k]) : [];
    }
    return $cfg;
}

// 執行環境概況（給前端 /doctor 與設定面板顯示）
function oc_env_info() {
    $ws = oc_ws();
    return [
        'php'                => PHP_VERSION,
        'os'                 => PHP_OS_FAMILY,
        'workspace'          => $ws,
        'root'               => OC_ROOT,          // Omni Code 自己的安裝目錄（自我提升模式的工作區）
        'workspace_exists'   => is_dir($ws),
        'workspace_writable' => is_dir($ws) && is_writable($ws),
        'data_writable'      => is_dir(OC_DATA) && is_writable(OC_DATA),
        'curl'               => function_exists('curl_init'),
        'memory_limit'       => (string)ini_get('memory_limit'),
        'php_bin'            => oc_php_binary(),
    ];
}

// 找出可用來執行 CLI 的 php 執行檔。
// XAMPP 預設不會把 php.exe 加進系統 PATH，所以直接下 `php -l` 會失敗——
// 那會讓語法檢查對正確的檔案回報「失敗」，比不檢查更糟。
// 回傳空字串代表真的找不到，呼叫端必須據此說「無法檢查」而不是「檢查失敗」。
function oc_php_binary(): string {
    static $cached = null;
    if ($cached !== null) return $cached;

    $cands = [];
    // mod_php 下 PHP_BINARY 會是 httpd.exe，所以要挑掉
    if (defined('PHP_BINARY') && PHP_BINARY && preg_match('/php(\.exe)?$/i', PHP_BINARY)) {
        $cands[] = PHP_BINARY;
    }
    if (oc_is_win()) {
        // 從本檔案位置往回推 XAMPP 根目錄，比寫死 D:\xampp 可靠
        $root = dirname(dirname(dirname(dirname(__DIR__))));   // …/xampp/htdocs/app/OmniCode/api → …/xampp
        $cands[] = $root . '/php/php.exe';
        $cands[] = 'C:/xampp/php/php.exe';
        $cands[] = 'D:/xampp/php/php.exe';
    } else {
        $cands[] = '/usr/bin/php';
        $cands[] = '/usr/local/bin/php';
    }

    foreach ($cands as $c) {
        $c = oc_norm_slashes($c);
        if (@is_file($c)) return $cached = $c;
    }
    // 最後試試 PATH 上有沒有
    $probe = oc_is_win() ? 'where php 2>NUL' : 'command -v php 2>/dev/null';
    $out = @shell_exec($probe);
    if ($out && trim($out)) {
        $first = oc_norm_slashes(trim(explode("\n", trim($out))[0]));
        if (@is_file($first)) return $cached = $first;
    }
    return $cached = '';
}

// 列出 Windows 磁碟機（POSIX 回空陣列）
function oc_list_drives() {
    if (!oc_is_win()) return [];
    $out = [];
    foreach (range('A', 'Z') as $letter) {
        $root = $letter . ':/';
        if (@is_dir($root)) $out[] = ['name' => $letter . ':', 'path' => $root];
    }
    return $out;
}

// 是否為磁碟根（Windows "D:/"）或檔案系統根（POSIX "/"）
function oc_is_fs_root($p) {
    return $p === '/' || $p === '' || preg_match('#^[A-Za-z]:/?$#', $p) === 1;
}

// 上層目錄；已在根目錄時回 null
function oc_parent_dir($cwd) {
    if (oc_is_fs_root($cwd)) return null;
    $parent = oc_norm_slashes(dirname($cwd));
    if ($parent === '' || strcasecmp($parent, $cwd) === 0) return null;
    return $parent;
}

// ═══════════════════════════════════════════════════════════════
// action: get —— 目前設定 + 執行環境
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// 模型管理設定：data/models.json
// ═══════════════════════════════════════════════════════════════
// 從 config.json 的 modelConfig 鍵搬出來獨立成檔的理由：
//   1. 模型清單／價格是「資料」，跟工作區、權限模式那種「偏好」性質不同，
//      混在同一個檔裡，改一個模型價格就要整包重寫 config.json。
//   2. 使用者可以直接編輯／備份／版本控管 models.json，不會誤觸其他設定。
// 每次開啟模型管理面板都重讀這個檔，所以在外部編輯後回到面板就會看到。

function oc_models_default() {
    // models / imageModels 給 null：PHP 這邊不知道出廠清單長什麼樣
    //（它在 app/js/config.js），前端第一次載入時會用內建清單種入並回存。
    return [
        'version'           => 2,
        'primaryImageModel' => '',
        'models'            => null,
        'imageModels'       => null,
        'providers'         => (object)[],
        'customProviders'   => [],
    ];
}

/** 一個模型項目的最低要求：id 是非空字串。其他欄位由前端決定，這裡不限制。 */
function oc_models_check_list($list, $label) {
    if (!is_array($list)) oc_fail("models.{$label} 必須是陣列", 400);
    $seen = [];
    foreach ($list as $i => $m) {
        if (!is_array($m)) oc_fail("models.{$label}[{$i}] 必須是物件", 400);
        $id = $m['id'] ?? null;
        if (!is_string($id) || trim($id) === '') oc_fail("models.{$label}[{$i}] 缺少 id", 400);
        if (preg_match('/\s/', $id)) oc_fail("models.{$label}[{$i}] 的 id 不能含空白：" . $id, 400);
        if (isset($seen[$id])) oc_fail("models.{$label} 有重複的 id：" . $id, 400);
        $seen[$id] = true;
    }
}

function oc_models_get() {
    $mc = oc_read_json(OC_MODELS, null);

    // 首次讀取：若還沒有 models.json，就把舊的 config.json → modelConfig 搬過來。
    // 舊鍵留在 config.json 裡不動（oc_cfg_save 是 array_merge，本來也刪不掉），
    // 但之後一律以 models.json 為準。
    $migrated = false;
    if (!is_array($mc)) {
        $cfg = oc_cfg();
        $old = $cfg['modelConfig'] ?? null;
        if (is_array($old) && $old) { $mc = $old; $migrated = true; }
        else $mc = oc_models_default();
        oc_write_json(OC_MODELS, $mc);
    }
    // json_decode(…, true) 會把磁碟上的 {} 讀成 []；回給前端前修回物件，
    // 讓 API 回應的形狀跟磁碟上、跟宣告的一致（前端 normalize 也會擋，這裡是第一道）
    if (isset($mc['providers']) && is_array($mc['providers']) && !$mc['providers']) $mc['providers'] = (object)[];
    oc_ok(['models' => $mc, 'migrated' => $migrated, 'path' => 'data/models.json']);
}

function oc_models_save() {
    $in = oc_arg('models', null);
    if (!is_array($in)) oc_fail('缺少 models 物件', 400);

    // v2：完整清單。舊的 v1（overrides/custom…）只在讀取時由前端轉換，
    // 存回來的一定是 v2 —— 這裡直接拒絕 v1，免得兩種格式在磁碟上混著。
    if ((int)($in['version'] ?? 0) !== 2) oc_fail('models.version 必須是 2（完整清單格式）', 400);
    oc_models_check_list($in['models'] ?? null, 'models');
    oc_models_check_list($in['imageModels'] ?? null, 'imageModels');
    if (!is_string($in['primaryImageModel'] ?? '')) oc_fail('models.primaryImageModel 必須是字串', 400);
    if (!is_array($in['customProviders'] ?? [])) oc_fail('models.customProviders 必須是陣列', 400);
    if (isset($in['providers']) && !is_array($in['providers'])) oc_fail('models.providers 必須是物件', 400);

    // 主要繪圖模型必須真的在清單裡（空字串 = 沒有繪圖模型，允許）
    $pid = (string)($in['primaryImageModel'] ?? '');
    if ($pid !== '') {
        $ok = false;
        foreach ($in['imageModels'] as $m) if (($m['id'] ?? '') === $pid) { $ok = true; break; }
        if (!$ok) oc_fail('primaryImageModel 指向不存在的繪圖模型：' . $pid, 400);
    }

    // 只留已知的頂層鍵，v1 殘留鍵不落地
    $out = [
        'version'           => 2,
        'primaryImageModel' => $pid,
        'models'            => array_values($in['models']),
        'imageModels'       => array_values($in['imageModels']),
        // 空的 PHP 陣列會被 json_encode 成 []，前端讀回來會把物件欄位當成陣列。
        // 這裡強制成物件，磁碟上的形狀才跟宣告的一致。
        'providers'         => (object)($in['providers'] ?? []),
        'customProviders'   => array_values($in['customProviders'] ?? []),
    ];
    if (!oc_write_json(OC_MODELS, $out)) oc_fail('無法寫入 data/models.json', 500);
    oc_ok(['saved' => true, 'path' => 'data/models.json', 'bytes' => @filesize(OC_MODELS) ?: 0,
           'models' => count($out['models']), 'imageModels' => count($out['imageModels'])]);
}

function oc_settings_get() {
    oc_ok([
        'config' => oc_redact_cfg(oc_cfg()),
        'env'    => oc_env_info(),
    ]);
}

// ═══════════════════════════════════════════════════════════════
// action: set —— 淺層合併設定
// ═══════════════════════════════════════════════════════════════
function oc_settings_set() {
    $in = oc_arg('config', null);
    if (!is_array($in)) oc_fail('缺少 config 物件', 400);

    // 金鑰只能透過 keys_set 修改，絕不允許被這裡整包覆寫／清空
    unset($in['keys'], $in['keysOnServer']);

    // ─── 逐項驗證（只驗有送來的欄位）───
    if (array_key_exists('permissionMode', $in)) {
        $modes = ['plan', 'default', 'acceptEdits', 'full'];
        if (!in_array($in['permissionMode'], $modes, true)) {
            oc_fail('permissionMode 無效，必須是 plan / default / acceptEdits / full 之一', 400,
                    'got: ' . oc_json_encode($in['permissionMode']));
        }
    }
    if (array_key_exists('transport', $in)) {
        if (!in_array($in['transport'], ['direct', 'relay'], true)) {
            oc_fail('transport 無效，必須是 direct 或 relay', 400,
                    'got: ' . oc_json_encode($in['transport']));
        }
    }
    // 介面語系：只收五種，前端 i18n.js 的 LOCALES 就是這份清單
    if (array_key_exists('locale', $in)) {
        $locales = ['zh-TW', 'zh-CN', 'en', 'ja', 'ko'];
        if (!is_string($in['locale']) || !in_array($in['locale'], $locales, true)) {
            oc_fail('locale 無效，必須是 zh-TW / zh-CN / en / ja / ko 之一', 400,
                    'got: ' . oc_json_encode($in['locale']));
        }
    }
    if (array_key_exists('autoCompactAt', $in)) {
        if (!is_numeric($in['autoCompactAt'])) oc_fail('autoCompactAt 必須是數字', 400);
        $v = (float)$in['autoCompactAt'];
        if ($v < 0.3 || $v > 0.95) oc_fail('autoCompactAt 必須介於 0.3 與 0.95 之間', 400, 'got: ' . $v);
        $in['autoCompactAt'] = $v;
    }
    if (array_key_exists('maxTurns', $in)) {
        if (!is_numeric($in['maxTurns'])) oc_fail('maxTurns 必須是數字', 400);
        $v = (int)$in['maxTurns'];
        if ($v < 1 || $v > 200) oc_fail('maxTurns 必須介於 1 與 200 之間', 400, 'got: ' . $v);
        $in['maxTurns'] = $v;
    }
    // 工作區若一併送來，仍需存在才收（正式切換請用 set_workspace）
    if (array_key_exists('workspace', $in)) {
        $p    = oc_norm_slashes((string)$in['workspace']);
        $real = $p === '' ? false : @realpath($p);
        if ($real === false || !is_dir($real)) oc_fail('工作區資料夾不存在：' . $p, 404);
        $in['workspace'] = oc_norm_slashes($real);
    }
    if (array_key_exists('schedules', $in)) {
        if (!is_array($in['schedules'])) oc_fail('schedules 必須是陣列', 400);
        if (count($in['schedules']) > 50) oc_fail('排程最多 50 筆', 400);
    }
    if (array_key_exists('sensitivePaths', $in)) {
        if (!is_array($in['sensitivePaths'])) oc_fail('sensitivePaths 必須是陣列', 400);
    }
    if (array_key_exists('toolGroupsOff', $in)) {
        if (!is_array($in['toolGroupsOff'])) oc_fail('toolGroupsOff 必須是陣列', 400);
        $ok = ['media', 'ui', 'agent', 'usertools'];
        foreach ($in['toolGroupsOff'] as $g) {
            if (!in_array($g, $ok, true)) oc_fail('未知的能力群組：' . oc_json_encode($g), 400);
        }
    }
    if (array_key_exists('effortLevel', $in)) {
        $levels = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];
        if (!in_array($in['effortLevel'], $levels, true)) {
            oc_fail('effortLevel 無效，必須是 off / low / medium / high / xhigh / max 之一', 400,
                    'got: ' . oc_json_encode($in['effortLevel']));
        }
    }
    // 舊鍵：遷移時會被寫成 null 註銷。新舊字彙都放行 ——
    // 這裡擋下來的話，前端的 .catch 會把它吞掉，使用者只看到設定「存了又跳回去」
    if (array_key_exists('thinkingLevel', $in) && $in['thinkingLevel'] !== null) {
        $levels = ['off', 'standard', 'deep', 'max', 'low', 'medium', 'high', 'xhigh'];
        if (!in_array($in['thinkingLevel'], $levels, true)) {
            oc_fail('thinkingLevel 無效', 400, 'got: ' . oc_json_encode($in['thinkingLevel']));
        }
    }
    if (array_key_exists('modelConfig', $in)) {
        // 只做結構檢查；欄位內容由前端 models.js 負責正規化
        $mc = $in['modelConfig'];
        if ($mc !== null && !is_array($mc) && !is_object($mc)) {
            oc_fail('modelConfig 必須是物件或 null', 400);
        }
    }
    // 型別歸位
    if (array_key_exists('thinking', $in))   $in['thinking'] = (bool)$in['thinking'];
    if (array_key_exists('autoVerify', $in)) $in['autoVerify'] = (bool)$in['autoVerify'];
    // Sentinel 總開關與範圍例外表（契約 §13.5 / §13.6）
    if (array_key_exists('sentinel', $in)) $in['sentinel'] = (bool)$in['sentinel'];
    if (array_key_exists('sentinelNetAsk', $in)) $in['sentinelNetAsk'] = (bool)$in['sentinelNetAsk'];
    if (array_key_exists('scopeRules', $in)) {
        if (!is_array($in['scopeRules']) && !is_object($in['scopeRules'])) oc_fail('scopeRules 必須是物件', 400);
        $sr = (array)$in['scopeRules'];
        $clean = [];
        foreach ($sr as $tool => $v) {
            $tool = trim((string)$tool);
            $v = strtolower(trim((string)$v));
            if ($tool === '' || !in_array($v, ['allow', 'ask', 'deny'], true)) continue;
            if (count($clean) >= 100) break;
            $clean[$tool] = $v;
        }
        $in['scopeRules'] = $clean;
    }
    if (array_key_exists('privacyTrain', $in)) $in['privacyTrain'] = (bool)$in['privacyTrain'];
    if (array_key_exists('mcpServers', $in)) {
        if (!is_array($in['mcpServers']) && !is_object($in['mcpServers'])) {
            oc_fail('mcpServers 必須是物件', 400);
        }
        $m = (array)$in['mcpServers'];
        $in['mcpServers'] = count($m) ? $m : new stdClass();
    }
    foreach (['extraApiHosts', 'allowRules', 'denyRules', 'recentWorkspaces'] as $k) {
        if (!array_key_exists($k, $in)) continue;
        if (!is_array($in[$k])) oc_fail($k . ' 必須是陣列', 400);
        $list = [];
        foreach ($in[$k] as $item) {
            if (is_string($item) && trim($item) !== '') $list[] = trim($item);
        }
        $in[$k] = array_values(array_unique($list));
    }

    $cfg = oc_cfg_save($in);          // 淺層合併 + 落盤（keys 因已移除而原封不動保留）
    oc_ok(['config' => oc_redact_cfg($cfg)]);
}

// ═══════════════════════════════════════════════════════════════
// action: browse —— 磁碟瀏覽（不受工作區限制，供選工作區用）
// ═══════════════════════════════════════════════════════════════
function oc_settings_browse() {
    $raw    = trim((string)oc_arg('path', ''));
    $win    = oc_is_win();
    $drives = oc_list_drives();

    // 路徑留空：Windows 列磁碟機，POSIX 直接列根目錄
    if ($raw === '') {
        if ($win) {
            oc_ok(['cwd' => '', 'parent' => null, 'dirs' => [], 'drives' => $drives]);
        }
        $raw = '/';
    }
    if (strpos($raw, "\0") !== false) oc_fail('路徑含非法字元', 400);

    $path = oc_norm_slashes($raw);
    $real = @realpath($path);
    if ($real === false || !is_dir($real)) oc_fail('資料夾不存在：' . $path, 404);
    $cwd = oc_norm_slashes($real);

    $items = @scandir($real);
    if ($items === false) oc_fail('無法讀取資料夾（權限不足或磁碟未就緒）：' . $cwd, 403);

    // 只留「讀得到的子目錄」；讀不到的（如 System Volume Information）直接略過
    $base  = rtrim($cwd, '/');           // "D:/" → "D:"；"/" → ""
    $names = [];
    foreach ($items as $name) {
        if ($name === '.' || $name === '..') continue;
        $full = $base . '/' . $name;
        if (!@is_dir($full)) continue;
        if (!@is_readable($full)) continue;
        $names[] = $name;
    }
    natcasesort($names);

    $dirs = [];
    foreach ($names as $name) {
        $dirs[] = ['name' => $name, 'path' => $base . '/' . $name];
    }

    oc_ok([
        'cwd'    => $cwd,
        'parent' => oc_parent_dir($cwd),
        'dirs'   => $dirs,
        'drives' => $drives,          // Windows 一律附上，讓 UI 能切磁碟
    ]);
}

// ═══════════════════════════════════════════════════════════════
// action: set_workspace —— 切換工作區
// ═══════════════════════════════════════════════════════════════
function oc_settings_set_ws() {
    $raw = trim((string)oc_arg('path', ''));
    if ($raw === '') oc_fail('請提供資料夾路徑', 400);
    if (strpos($raw, "\0") !== false) oc_fail('路徑含非法字元', 400);

    $real = @realpath(oc_norm_slashes($raw));
    if ($real === false || !is_dir($real)) oc_fail('資料夾不存在：' . $raw, 404);
    if (!is_readable($real))               oc_fail('資料夾無法讀取（權限不足）：' . $raw, 403);
    $ws = oc_norm_slashes($real);

    // 最近使用清單：去重、最新在前、最多 12 筆
    $cfg    = oc_cfg();
    $recent = isset($cfg['recentWorkspaces']) && is_array($cfg['recentWorkspaces'])
              ? $cfg['recentWorkspaces'] : [];
    $list = [$ws];
    foreach ($recent as $r) {
        if (!is_string($r)) continue;
        $r = oc_norm_slashes($r);
        if ($r === '') continue;
        $dup = false;
        foreach ($list as $seen) { if (strcasecmp($seen, $r) === 0) { $dup = true; break; } }
        if (!$dup) $list[] = $r;
    }
    $list = array_slice($list, 0, 12);

    oc_cfg_save(['workspace' => $ws, 'recentWorkspaces' => $list]);
    oc_ok(['workspace' => $ws, 'recentWorkspaces' => $list]);
}

// ═══════════════════════════════════════════════════════════════
// 額外工作資料夾（跟著對話走，上限 OC_EXTRA_ROOTS_MAX）
// ═══════════════════════════════════════════════════════════════
// alias 規則：英數字底線連字號 1–32 字元；同一 alias 重掛 = 覆蓋。
// path 必須是存在的可讀目錄，以 realpath 正規化後存放。
function oc_settings_extra_list() {
    $cfg = oc_cfg();
    $list = $cfg['activeExtraRoots'] ?? [];
    return is_array($list) ? array_values($list) : [];
}

function oc_settings_extra_check($rawAlias, $rawPath) {
    $alias = trim((string)$rawAlias);
    if (!preg_match('/^[A-Za-z0-9_-]{1,32}$/', $alias)) {
        oc_fail('別名只允許英數字、底線、連字號（1–32 字元）', 400, (string)$rawAlias);
    }
    $raw = trim((string)$rawPath);
    if ($raw === '') oc_fail('請提供資料夾路徑', 400);
    if (strpos($raw, "\0") !== false) oc_fail('路徑含非法字元', 400);
    $real = @realpath(oc_norm_slashes($raw));
    if ($real === false || !is_dir($real)) oc_fail('資料夾不存在：' . $raw, 404);
    if (!is_readable($real))               oc_fail('資料夾無法讀取（權限不足）：' . $raw, 403);
    return [$alias, oc_norm_slashes($real)];
}

// POST extra_add —— {alias, path}
function oc_settings_extra_add() {
    list($alias, $path) = oc_settings_extra_check(oc_arg('alias', ''), oc_arg('path', ''));
    $list = oc_settings_extra_list();
    // 同一路徑已掛在別的 alias 下 → 直接回現況，不長第二筆
    foreach ($list as $it) {
        if (is_array($it) && strcasecmp((string)($it['path'] ?? ''), $path) === 0) {
            oc_ok(['roots' => $list, 'alias' => (string)($it['alias'] ?? $alias)]);
        }
    }
    $found = false;
    foreach ($list as &$it) {
        if (is_array($it) && strcasecmp((string)($it['alias'] ?? ''), $alias) === 0) {
            $it = ['alias' => $alias, 'path' => $path];
            $found = true;
            break;
        }
    }
    unset($it);
    if (!$found) {
        if (count($list) >= OC_EXTRA_ROOTS_MAX) {
            oc_fail('額外資料夾最多掛 ' . OC_EXTRA_ROOTS_MAX . ' 個（請先移除不用的）', 400);
        }
        $list[] = ['alias' => $alias, 'path' => $path];
    }
    oc_cfg_save(['activeExtraRoots' => $list]);
    oc_ok(['roots' => $list, 'alias' => $alias]);
}

// POST extra_remove —— {alias}
function oc_settings_extra_rm() {
    $alias = trim((string)oc_arg('alias', ''));
    $list = array_values(array_filter(oc_settings_extra_list(), function ($it) use ($alias) {
        return !is_array($it) || strcasecmp((string)($it['alias'] ?? ''), $alias) !== 0;
    }));
    oc_cfg_save(['activeExtraRoots' => $list]);
    oc_ok(['roots' => $list]);
}

// POST extra_sync —— {roots:[{alias,path}]}（切換對話時把該會話的掛載同步為作用中）
// 全部重新驗證：不存在的目錄靜默丟掉，不擋載入；超過上限截斷。
function oc_settings_extra_sync() {
    $in = oc_arg('roots', []);
    if (!is_array($in)) oc_fail('roots 必須是陣列', 400);
    $out = [];
    foreach ($in as $it) {
        if (!is_array($it)) continue;
        $alias = trim((string)($it['alias'] ?? ''));
        $raw = trim((string)($it['path'] ?? ''));
        if (!preg_match('/^[A-Za-z0-9_-]{1,32}$/', $alias) || $raw === '') continue;
        $real = @realpath(oc_norm_slashes($raw));
        if ($real === false || !is_dir($real) || !is_readable($real)) continue;
        $path = oc_norm_slashes($real);
        $dup = false;
        foreach ($out as $o) {
            if (strcasecmp($o['alias'], $alias) === 0 || strcasecmp($o['path'], $path) === 0) { $dup = true; break; }
        }
        if (!$dup) $out[] = ['alias' => $alias, 'path' => $path];
        if (count($out) >= OC_EXTRA_ROOTS_MAX) break;
    }
    oc_cfg_save(['activeExtraRoots' => $out]);
    oc_ok(['roots' => $out]);
}

// ═══════════════════════════════════════════════════════════════
// action: audit / audit_list —— 工具稽核（學 OpenClaw 的 audit ledger 輕量版）
// ═══════════════════════════════════════════════════════════════
// 只記「做了什麼、結果如何」（時間、會話、工具名、成功失敗、耗時），
// 參數與輸出內容一律不記 —— 稽核檔不該成為第二個洩漏源。
// data/logs/audit.log（JSON Lines），最多保留 2000 行。
function oc_settings_audit() {
    $line = (string)oc_arg('line', '');
    if ($line === '') oc_fail('缺少稽核內容', 400);
    $j = json_decode($line, true);
    if (!is_array($j) || !isset($j['tool'])) oc_fail('稽核內容格式錯誤', 400);
    // 白名單欄位：多餘的一律丟掉（前端若誤送參數內容也不會落地）
    $safe = [
        'ts'       => (string)($j['ts'] ?? ''),
        'sess'     => (string)($j['sess'] ?? ''),
        'tool'     => (string)$j['tool'],
        'ok'       => !empty($j['ok']),
        'denied'   => !empty($j['denied']),
        'sentinel' => !empty($j['sentinel']),
        'ms'       => is_numeric($j['ms'] ?? null) ? (int)$j['ms'] : null,
    ];
    @file_put_contents(OC_LOGS . '/audit.log', json_encode($safe, JSON_UNESCAPED_UNICODE) . PHP_EOL, FILE_APPEND | LOCK_EX);
    // 封頂：超過 2000 行就只留尾段（稽核是近況追查，不是永久保存）
    $f = OC_LOGS . '/audit.log';
    $lines = @file($f, FILE_IGNORE_NEW_LINES);
    if (is_array($lines) && count($lines) > 2000) {
        @file_put_contents($f, implode(PHP_EOL, array_slice($lines, -2000)) . PHP_EOL, LOCK_EX);
    }
    oc_ok(['logged' => true]);
}

function oc_settings_audit_list() {
    $limit = oc_int('limit', 50);
    if ($limit < 1) $limit = 1;
    if ($limit > 200) $limit = 200;
    $sess = (string)oc_arg('sess', '');
    $f = OC_LOGS . '/audit.log';
    if (!is_file($f)) oc_ok(['entries' => [], 'total' => 0]);
    $lines = @file($f, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if (!is_array($lines)) oc_ok(['entries' => [], 'total' => 0]);
    $out = [];
    for ($i = count($lines) - 1; $i >= 0 && count($out) < $limit; $i--) {
        $j = json_decode($lines[$i], true);
        if (!is_array($j)) continue;
        if ($sess !== '' && (string)($j['sess'] ?? '') !== $sess) continue;
        $out[] = $j;
    }
    oc_ok(['entries' => $out, 'total' => count($lines)]);
}

// ═══════════════════════════════════════════════════════════════
// action: keys_set —— 選擇性把金鑰存在伺服器（data/config.json）
// ═══════════════════════════════════════════════════════════════
function oc_settings_keys_set() {
    $provider = strtolower(trim((string)oc_arg('provider', '')));
    if (!in_array($provider, oc_key_providers(), true)) {
        oc_fail('不支援的供應商：' . $provider, 400,
                '可用：' . implode(' / ', oc_key_providers()));
    }
    $key = oc_arg('key', '');
    if (!is_string($key)) $key = '';
    $key = trim($key);

    $cfg  = oc_cfg();
    $keys = isset($cfg['keys']) ? (array)$cfg['keys'] : [];
    if ($key === '') unset($keys[$provider]);      // 空字串 = 刪除
    else             $keys[$provider] = $key;

    oc_cfg_save(['keys' => count($keys) ? $keys : new stdClass()]);
    oc_ok(['provider' => $provider, 'set' => $key !== '']);
}

// ═══════════════════════════════════════════════════════════════
// action: keys_status —— 各供應商是否已有伺服器端金鑰
// ═══════════════════════════════════════════════════════════════
function oc_settings_keys_status() {
    $cfg  = oc_cfg();
    $keys = isset($cfg['keys']) ? (array)$cfg['keys'] : [];
    $out  = [];
    foreach (oc_key_providers() as $p) {
        $out[$p] = oc_key_present($keys[$p] ?? null);
    }
    oc_ok($out);
}
