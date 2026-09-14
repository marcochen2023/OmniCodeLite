<?php
require_once __DIR__ . '/../includes/helpers.php';
// CLI（mcp-server.php）只是要 include 進來拿 oc_fs_dispatch()，
// 不該連帶送出 HTTP 標頭、也不該在檔尾自己跑一次請求。
if (PHP_SAPI !== 'cli') oc_boot();

// ═══════════════════════════════════════════════════════════════
// Omni Code — api/fs.php（檔案系統：Agent 的手）
// ═══════════════════════════════════════════════════════════════
// 契約見 docs/ARCHITECTURE.md §3。
// 所有 path / from / to 皆為「工作區相對路徑」（POSIX 斜線），
// 一律經 oc_path() 檢查，越界時由 oc_path() 直接 403。
// 除了 download / raw 兩個串流動作外，全部回應都走 oc_ok() / oc_fail()。
// ═══════════════════════════════════════════════════════════════

define('OC_FS_MAX_LINES',      5000);              // read 單次最多回傳行數
define('OC_FS_MAX_B64_BYTES',  12 * 1024 * 1024);  // read_b64 預設上限
define('OC_FS_STAT_LINE_MAX',  2 * 1024 * 1024);   // stat 計算行數的檔案大小上限
define('OC_FS_WALK_DEPTH',     32);                // 走訪最大深度（防符號連結繞圈）
define('OC_FS_WALK_MAX',       200000);            // 走訪最大檔案數（安全閥）
define('OC_FS_WALK_SECS',      8.0);               // 走訪（列舉檔案）時間預算，秒
define('OC_FS_GREP_SECS',      12.0);              // grep 掃描內容時間預算，秒
define('OC_FS_GREP_BYTES',     96 * 1024 * 1024);  // grep 累計讀取位元組預算

// ═══════════════════════════════════════════════════════════════
// 內部小工具
// ═══════════════════════════════════════════════════════════════

// 斜線統一（scandir / realpath / dirname 的輸出在 Windows 會混用反斜線）
function oc_fs_slash($p) {
    return str_replace('\\', '/', (string)$p);
}

// 取得「必定存在的檔案」絕對路徑
function oc_fs_file($rel, $what = '檔案') {
    $abs = oc_path($rel);
    if (!file_exists($abs)) oc_fail($what . '不存在：' . oc_clean_rel($rel), 404);
    if (!is_file($abs))     oc_fail('這是目錄，不是' . $what . '：' . oc_clean_rel($rel), 400);
    return $abs;
}

// 依目標換行風格轉換字串（先統一成 LF，再轉成目標）
function oc_fs_to_eol($s, $eol) {
    $s = str_replace(["\r\n", "\r"], "\n", (string)$s);
    return $eol === "\n" ? $s : str_replace("\n", $eol, $s);
}

// 內容 → 行陣列（不把結尾換行算成一行）
function oc_fs_lines($content, &$hadTrailingEol = false) {
    $hadTrailingEol = false;
    if ($content === '') return [];
    $lines = oc_split_lines($content);
    if (count($lines) > 1 && $lines[count($lines) - 1] === '') {
        array_pop($lines);
        $hadTrailingEol = true;
    }
    return $lines;
}

// 截斷顯示用文字（多位元組安全）
function oc_fs_clip($s, $max = 400) {
    $s = (string)$s;
    return mb_strlen($s, 'UTF-8') > $max ? mb_substr($s, 0, $max, 'UTF-8') : $s;
}

// 遞迴刪除，回傳刪除的節點數
function oc_fs_rm($abs) {
    if (is_dir($abs) && !is_link($abs)) {
        $n = 0;
        foreach (@scandir($abs) ?: [] as $it) {
            if ($it === '.' || $it === '..') continue;
            $n += oc_fs_rm($abs . '/' . $it);
        }
        if (!@rmdir($abs)) oc_fail('無法刪除目錄：' . oc_rel($abs), 500);
        return $n + 1;
    }
    if (file_exists($abs) || is_link($abs)) {
        if (!@unlink($abs)) oc_fail('無法刪除檔案：' . oc_rel($abs), 500);
        return 1;
    }
    return 0;
}

// 遞迴複製，回傳複製的節點數
function oc_fs_cp($src, $dst) {
    if (is_dir($src)) {
        if (!is_dir($dst) && !@mkdir($dst, 0777, true)) {
            oc_fail('無法建立目錄：' . oc_rel($dst), 500);
        }
        $n = 1;
        foreach (@scandir($src) ?: [] as $it) {
            if ($it === '.' || $it === '..') continue;
            $n += oc_fs_cp($src . '/' . $it, $dst . '/' . $it);
        }
        return $n;
    }
    $dir = dirname($dst);
    if (!is_dir($dir) && !@mkdir($dir, 0777, true)) {
        oc_fail('無法建立目錄：' . oc_rel($dir), 500);
    }
    if (!@copy($src, $dst)) oc_fail('無法複製檔案：' . oc_rel($src), 500);
    return 1;
}

// 確保父目錄存在
function oc_fs_mkparent($abs) {
    $dir = dirname($abs);
    if (is_dir($dir)) return;
    if (!@mkdir($dir, 0777, true) && !is_dir($dir)) {
        oc_fail('無法建立上層目錄：' . oc_rel($dir), 500);
    }
}

// ─── glob 模式 → 正規表達式 ────────────────────────────────────
// PHP 內建 glob() 不支援 `**`，故自行轉換：
//   '**/' → '(?:.*/)?'   '**' → '.*'   '*' → '[^/]*'   '?' → '[^/]'
// 其餘字元一律 preg_quote 逃逸。Windows 檔名不分大小寫，故加 'i'。
function oc_fs_glob_regex($pattern) {
    $pat = ltrim(str_replace('\\', '/', (string)$pattern), '/');
    // 去掉開頭的 "./"：比對用的是工作區相對路徑，本身不帶 "./" 前綴，
    // 留著會讓 './app/*.js' 這種寫法永遠比不中（oc_fs_glob_base 已做同樣正規化）
    while (strncmp($pat, './', 2) === 0) $pat = ltrim(substr($pat, 2), '/');
    if ($pat === '') return null;
    $re = '';
    $n  = strlen($pat);
    for ($i = 0; $i < $n; $i++) {
        $c = $pat[$i];
        if ($c === '*') {
            if ($i + 1 < $n && $pat[$i + 1] === '*') {
                if ($i + 2 < $n && $pat[$i + 2] === '/') { $re .= '(?:.*/)?'; $i += 2; }
                else                                     { $re .= '.*';       $i += 1; }
            } else {
                $re .= '[^/]*';
            }
        } elseif ($c === '?') {
            $re .= '[^/]';
        } else {
            $re .= preg_quote($c, '#');
        }
    }
    return '#^' . $re . '$#' . (oc_is_win() ? 'i' : '');
}

// 路徑比對：以「工作區相對路徑」為準；若限定了子目錄，另外允許以「子目錄相對路徑」比對，
// 讓 glob('*.php', 'app/js') 這種直覺用法也能命中。
function oc_fs_glob_match($re, $relWs, $basePrefix) {
    if (preg_match($re, $relWs) === 1) return true;
    if ($basePrefix !== '' && strncasecmp($relWs, $basePrefix, strlen($basePrefix)) === 0) {
        return preg_match($re, substr($relWs, strlen($basePrefix))) === 1;
    }
    return false;
}

// ─── 共用走訪器（glob 與 grep 共用，確保兩者行為完全一致）────────
// 回傳 [['rel'=>工作區相對, 'abs'=>絕對, 'mtime'=>int, 'size'=>int], …]
function oc_fs_walk($baseAbs, $re = null, $basePrefix = '', $noIgnore = false) {
    $out = [];
    $deadline = microtime(true) + OC_FS_WALK_SECS;   // 大型工作區不可無限走訪
    if (is_file($baseAbs)) {
        $rel = oc_rel($baseAbs);
        if ($re === null || oc_fs_glob_match($re, $rel, $basePrefix)) {
            $out[] = ['rel' => $rel, 'abs' => $baseAbs,
                      'mtime' => (int)@filemtime($baseAbs), 'size' => (int)@filesize($baseAbs)];
        }
        return $out;
    }
    $stack = [[$baseAbs, 0]];
    $seen  = [];
    while ($stack) {
        if (microtime(true) > $deadline) { $GLOBALS['OC_FS_WALK_TIMEOUT'] = true; break; }
        [$dir, $depth] = array_pop($stack);
        if ($depth > OC_FS_WALK_DEPTH) continue;
        // 以 realpath 去重，避免符號連結 / junction 造成無限迴圈
        $realKey = strtolower(oc_fs_slash(@realpath($dir) ?: $dir));
        if (isset($seen[$realKey])) continue;
        $seen[$realKey] = true;

        $items = @scandir($dir);
        if ($items === false) continue;
        foreach ($items as $it) {
            if ($it === '.' || $it === '..') continue;
            $abs = oc_fs_slash($dir . '/' . $it);
            if (is_dir($abs)) {
                if (!$noIgnore && oc_ignored($it)) continue;
                $stack[] = [$abs, $depth + 1];
            } elseif (is_file($abs)) {
                $rel = oc_rel($abs);
                if ($re !== null && !oc_fs_glob_match($re, $rel, $basePrefix)) continue;
                $out[] = ['rel' => $rel, 'abs' => $abs,
                          'mtime' => (int)@filemtime($abs), 'size' => (int)@filesize($abs)];
                if (count($out) >= OC_FS_WALK_MAX) return $out;
            }
        }
    }
    return $out;
}

// ─── 從 glob 樣式抽出「不含萬用字元的目錄前綴」────────────────────
// 'app/js/**/*.test.js' → 'app/js'      'src/*.php' → 'src'
// '**/*.php'            → ''（無前綴）  'README.md' → ''（最後一段是檔名，不算目錄）
// 這是效能關鍵：沒有它，每次 glob 都得走訪整個工作區。
// 在 D:/xampp/htdocs 這種大型根目錄下，差別是 58 秒 vs 0.06 秒。
function oc_fs_glob_base($pattern) {
    $pat = ltrim(str_replace('\\', '/', (string)$pattern), '/');
    if ($pat === '') return '';
    $segs = explode('/', $pat);
    array_pop($segs);                       // 最後一段是檔名樣式，不是目錄
    $base = [];
    foreach ($segs as $s) {
        if ($s === '' || $s === '.') continue;
        // 一遇到萬用字元就停：後面的層級必須靠走訪
        if (strpbrk($s, '*?[]{}') !== false) break;
        if ($s === '..') break;             // 交給 oc_path 去擋
        $base[] = $s;
    }
    return implode('/', $base);
}

// 依 glob 參數（或整棵樹）建立候選檔案清單 —— glob / grep 的共同入口
function oc_fs_collect($pathParam, $globPattern, $noIgnore) {
    $baseRel = oc_clean_rel($pathParam);
    $baseAbs = oc_path($pathParam);
    if (!file_exists($baseAbs)) oc_fail('路徑不存在：' . $baseRel, 404);
    $prefix  = $baseRel === '' ? '' : $baseRel . '/';
    $re      = ($globPattern === '' || $globPattern === null) ? null : oc_fs_glob_regex($globPattern);

    // 樣式本身帶有固定目錄前綴時，直接從那個目錄開始走訪。
    // 比對仍以完整的工作區相對路徑進行，因此結果完全相同，只是不再白走整棵樹。
    //
    // 這裡必須「保守」：只有在能明確指認出一個存在的起點目錄時才走捷徑，
    // 其餘一律退回完整走訪。樣式與 path 的組合方式不只一種
    // （oc_fs_glob_match 同時接受「工作區相對」與「path 相對」兩種形式），
    // 猜錯起點就會靜默回傳空結果——那比慢更糟。
    if ($re !== null) {
        $gBase = oc_fs_glob_base($globPattern);
        if ($gBase !== '') {
            // 候選一：樣式相對於 path（glob('js/*.js', 'app') → app/js）
            $cands = [$baseRel === '' ? $gBase : $baseRel . '/' . $gBase];
            // 候選二：樣式本身就是工作區相對路徑（glob('app/js/*.js', 'app') → app/js）
            if ($baseRel !== '' && $gBase !== $baseRel) $cands[] = $gBase;

            foreach ($cands as $candRel) {
                $candAbs = oc_path($candRel);
                if (!is_dir($candAbs)) continue;
                // 限定了 path 時，起點必須真的落在 path 底下，否則會越界搜尋
                if ($baseRel !== '') {
                    $c = oc_norm_slashes($candAbs);
                    $b = oc_norm_slashes($baseAbs);
                    if (strcasecmp($c, $b) !== 0 && stripos($c, $b . '/') !== 0) continue;
                }
                return oc_fs_walk($candAbs, $re, $prefix, $noIgnore);
            }
        }
    }
    return oc_fs_walk($baseAbs, $re, $prefix, $noIgnore);
}

// ─── edit 失敗時的「最接近的行」提示（幫助模型自我修正）──────────
function oc_fs_near_lines($content, $old) {
    $needle = '';
    foreach (oc_split_lines($old) as $l) {
        if (trim($l) !== '') { $needle = trim($l); break; }
    }
    if ($needle === '') return null;
    $needle = substr($needle, 0, 200);

    $scored = [];
    $lines  = oc_split_lines($content);
    $cap    = min(count($lines), 20000);
    for ($i = 0; $i < $cap; $i++) {
        $t = trim($lines[$i]);
        if ($t === '') continue;
        $pct = 0.0;
        @similar_text($needle, substr($t, 0, 200), $pct);
        $scored[] = ['n' => $i + 1, 'pct' => $pct, 'text' => $t];
    }
    if (!$scored) return null;
    usort($scored, function ($a, $b) { return $b['pct'] <=> $a['pct']; });

    $out = [];
    foreach (array_slice($scored, 0, 3) as $s) {
        $out[] = '第 ' . $s['n'] . ' 行（相似度 ' . round($s['pct']) . '%）：' . oc_fs_clip($s['text'], 160);
    }
    return "檔案中最接近的 3 行（請重新 read 後逐字複製）：\n" . implode("\n", $out);
}

// ─── 單次取代（供 edit / multi_edit 共用）────────────────────────
// 成功回傳 ['content'=>新內容, 'replaced'=>次數]；失敗回傳 ['error'=>訊息,'code'=>HTTP,'detail'=>…]
function oc_fs_apply_edit($content, $oldRaw, $newRaw, $replaceAll) {
    if (!is_string($oldRaw) || $oldRaw === '') {
        return ['error' => 'old_string 不得為空', 'code' => 400, 'detail' => null];
    }
    if (!is_string($newRaw)) $newRaw = (string)$newRaw;
    if ($oldRaw === $newRaw) {
        return ['error' => 'old_string 與 new_string 完全相同，不需要編輯', 'code' => 400, 'detail' => null];
    }

    // 保持原檔換行風格：先以「轉成原檔 EOL」的版本比對，找不到再退回原字串（處理混合換行的檔案）
    $eol  = oc_detect_eol($content);
    $old  = oc_fs_to_eol($oldRaw, $eol);
    $new  = oc_fs_to_eol($newRaw, $eol);
    $cnt  = substr_count($content, $old);
    if ($cnt === 0 && $old !== $oldRaw) {
        $old = $oldRaw;
        $new = $newRaw;
        $cnt = substr_count($content, $old);
    }

    if ($cnt === 0) {
        return [
            'error'  => '找不到要取代的內容（old_string 必須與檔案內容逐字相符，含縮排與換行）',
            'code'   => 404,
            'detail' => oc_fs_near_lines($content, $oldRaw),
        ];
    }
    if ($cnt > 1 && !$replaceAll) {
        return [
            'error'  => 'old_string 在檔案中出現 ' . $cnt . ' 次，需要唯一；請加長 old_string 使其唯一，或設定 replace_all=true',
            'code'   => 409,
            'detail' => 'occurrences=' . $cnt,
        ];
    }

    if ($replaceAll) {
        $content = str_replace($old, $new, $content);
    } else {
        // 僅取代第一處：以位移手動接合，避免 str_replace 影響其他位置
        $pos     = strpos($content, $old);
        $content = substr($content, 0, $pos) . $new . substr($content, $pos + strlen($old));
        $cnt     = 1;
    }
    return ['content' => $content, 'replaced' => $cnt];
}

// ─── 檔名清洗（upload 用）──────────────────────────────────────
function oc_fs_safe_name($name) {
    $name = basename(str_replace('\\', '/', (string)$name));
    $name = preg_replace('/[\x00-\x1F\x7F]/u', '', $name);
    $name = preg_replace('/[<>:"|?*]/u', '_', $name);
    $name = trim($name);
    if ($name === '' || $name === '.' || $name === '..') return '';
    return $name;
}

// ─── 串流輸出前清空緩衝 ────────────────────────────────────────
function oc_fs_stream_clean() {
    while (ob_get_level() > 0) { @ob_end_clean(); }
}

// ═══════════════════════════════════════════════════════════════
// 路由
// ═══════════════════════════════════════════════════════════════
// 包成函式而不是留在檔案最外層 —— MCP 模式要能重複呼叫它。
// 刻意「整包搬進來」而不是拆成 18 個小函式：case 內容有 800 行，
// 逐一拆解的風險遠高於收益，而這個包法達成同樣的目的。
function oc_fs_dispatch($action) {

switch ($action) {

// ───────────────────────────────────────────────────────────────
// list — 列出單層目錄
// ───────────────────────────────────────────────────────────────
case 'list': {
    $rel  = oc_arg('path', '');
    $abs  = oc_path($rel);
    if (!file_exists($abs)) oc_fail('目錄不存在：' . oc_clean_rel($rel), 404);
    if (!is_dir($abs))      oc_fail('這不是目錄：' . oc_clean_rel($rel), 400);

    $showHidden = oc_bool('show_hidden', false);
    $noIgnore   = oc_bool('no_ignore', false);

    $items = @scandir($abs);
    if ($items === false) oc_fail('無法讀取目錄：' . oc_clean_rel($rel), 500);

    $dirs = [];
    $files = [];
    foreach ($items as $name) {
        if ($name === '.' || $name === '..') continue;
        if (!$showHidden && $name[0] === '.') continue;              // 隱藏檔（dotfile）
        $child = oc_fs_slash($abs . '/' . $name);
        $isDir = is_dir($child);
        if ($isDir && !$noIgnore && oc_ignored($name)) continue;     // 排除清單目錄

        $entry = [
            'name'  => $name,
            'path'  => oc_rel($child),
            'type'  => $isDir ? 'dir' : 'file',
            'size'  => $isDir ? 0 : (int)@filesize($child),
            'mtime' => (int)@filemtime($child) * 1000,               // 毫秒
            'ext'   => $isDir ? '' : oc_ext($child),
        ];
        if ($isDir) {
            $dirs[] = $entry;
        } else {
            $entry['binary'] = !oc_is_text($child);
            $files[] = $entry;
        }
    }

    // 目錄優先，各自以自然順序（不分大小寫）排序
    $bynat = function ($a, $b) { return strnatcasecmp($a['name'], $b['name']); };
    usort($dirs, $bynat);
    usort($files, $bynat);

    oc_ok([
        'path'    => oc_rel($abs),
        'entries' => array_merge($dirs, $files),
    ]);
}

// ───────────────────────────────────────────────────────────────
// tree — 遞迴目錄樹（含深度與節點數上限）
// ───────────────────────────────────────────────────────────────
case 'tree': {
    $rel = oc_arg('path', '');
    $abs = oc_path($rel);
    if (!file_exists($abs)) oc_fail('路徑不存在：' . oc_clean_rel($rel), 404);

    $depth = oc_int('depth', 2);
    if ($depth < 0) $depth = 0;
    if ($depth > OC_FS_WALK_DEPTH) $depth = OC_FS_WALK_DEPTH;
    $limit = oc_int('limit', 2000);
    if ($limit <= 0) $limit = 2000;
    $noIgnore   = oc_bool('no_ignore', false);
    $showHidden = oc_bool('show_hidden', true);

    $count     = 0;
    $truncated = false;

    // 遞迴建節點；$count 為已產生的子節點總數
    $build = function ($nodeAbs, $left) use (&$build, &$count, &$truncated, $limit, $noIgnore, $showHidden) {
        $nodeRel = oc_rel($nodeAbs);
        $isDir   = is_dir($nodeAbs);
        $node = [
            'name' => ($nodeRel === '' ? basename(oc_ws()) : basename($nodeAbs)),
            'path' => $nodeRel,
            'type' => $isDir ? 'dir' : 'file',
        ];
        if (!$isDir) {
            $node['size']  = (int)@filesize($nodeAbs);
            $node['mtime'] = (int)@filemtime($nodeAbs) * 1000;
            $node['ext']   = oc_ext($nodeAbs);
            return $node;
        }
        $node['children'] = [];
        if ($left <= 0) return $node;

        $items = @scandir($nodeAbs);
        if ($items === false) return $node;

        $dirs = [];
        $files = [];
        foreach ($items as $name) {
            if ($name === '.' || $name === '..') continue;
            if (!$showHidden && $name[0] === '.') continue;
            $child = oc_fs_slash($nodeAbs . '/' . $name);
            if (is_dir($child)) {
                if (!$noIgnore && oc_ignored($name)) continue;
                $dirs[] = $child;
            } else {
                $files[] = $child;
            }
        }
        $bynat = function ($a, $b) { return strnatcasecmp(basename($a), basename($b)); };
        usort($dirs, $bynat);
        usort($files, $bynat);

        foreach (array_merge($dirs, $files) as $child) {
            if ($count >= $limit) { $truncated = true; break; }
            $count++;
            $node['children'][] = $build($child, $left - 1);
        }
        return $node;
    };

    $tree = $build($abs, $depth);
    oc_ok(['tree' => $tree, 'truncated' => $truncated, 'nodes' => $count]);
}

// ───────────────────────────────────────────────────────────────
// read — 讀取文字檔（可指定起始行與行數）
// ───────────────────────────────────────────────────────────────
case 'read': {
    $rel  = oc_arg('path', '');
    $abs  = oc_fs_file($rel);
    $size = (int)@filesize($abs);
    $mime = oc_mime($abs);

    // 二進位檔不 fail，改回 200 + binary:true（ARCHITECTURE.md §3 的回應形狀）。
    // 前端編輯器會據此切到二進位/圖片預覽面板；用 4xx 的話它只會顯示一則錯誤，
    // 而且錯誤文字裡的「工具名」對模型來說是不存在的東西，只會誤導它。
    if (!oc_is_text($abs)) {
        oc_ok([
            'path'        => oc_rel($abs),
            'content'     => '',
            'lines'       => 0,
            'total_lines' => 0,
            'offset'      => 0,
            'truncated'   => false,
            'size'        => $size,
            'mtime'       => (int)@filemtime($abs) * 1000,
            'binary'      => true,
            'mime'        => $mime,
            'eol'         => "\n",
            'hint'        => '這是二進位檔，無法以文字讀取。圖片請用 read_image 工具（會直接以視覺形式呈現），'
                           . '其他二進位檔請改用 action=read_b64。',
        ]);
    }

    $truncated = false;
    if ($size > OC_MAX_READ_BYTES) {
        // 超過上限只讀前段
        $fh = @fopen($abs, 'rb');
        if (!$fh) oc_fail('無法開啟檔案：' . oc_rel($abs), 500);
        $content = (string)fread($fh, OC_MAX_READ_BYTES);
        fclose($fh);
        $truncated = true;
    } else {
        $content = @file_get_contents($abs);
        if ($content === false) oc_fail('無法讀取檔案：' . oc_rel($abs), 500);
    }

    $eol   = oc_detect_eol($content);
    $lines = oc_fs_lines($content, $hadTrailingEol);
    $total = count($lines);

    $offset = oc_int('offset', 0);           // 1-based 起始行（0 與 1 都代表第一行）
    if ($offset < 1) $offset = 1;
    $limit  = oc_int('limit', 0);            // 0 = 全部（仍受 OC_FS_MAX_LINES 上限）
    if ($limit <= 0 || $limit > OC_FS_MAX_LINES) $limit = OC_FS_MAX_LINES;

    if ($total === 0) {
        $out = '';
        $returned = 0;
    } elseif ($offset > $total) {
        $out = '';
        $returned = 0;
    } else {
        $start = $offset - 1;
        $slice = array_slice($lines, $start, $limit);
        $returned = count($slice);
        $reachEnd = ($start + $returned) >= $total;
        if ($start + $returned < $total) $truncated = true;   // 還有未回傳的行
        if ($start === 0 && $reachEnd && !$truncated) {
            $out = $content;                                   // 全檔命中：原封不動回傳（保留結尾換行）
        } else {
            $out = implode($eol, $slice);
            if ($reachEnd && $hadTrailingEol) $out .= $eol;
        }
    }

    oc_ok([
        'content'     => $out,
        'lines'       => $returned,
        'total_lines' => $total,
        'offset'      => $offset,
        'truncated'   => $truncated,
        'size'        => $size,
        'mtime'       => (int)@filemtime($abs) * 1000,
        'binary'      => false,
        'mime'        => $mime,
        'eol'         => $eol,
        'path'        => oc_rel($abs),
    ]);
}

// ───────────────────────────────────────────────────────────────
// read_b64 — 讀取二進位（圖片）為 base64
// ───────────────────────────────────────────────────────────────
case 'read_b64': {
    $rel  = oc_arg('path', '');
    $abs  = oc_fs_file($rel);
    $size = (int)@filesize($abs);

    $max = oc_int('max', 0);
    if ($max <= 0) $max = OC_FS_MAX_B64_BYTES;
    if ($size > $max) {
        oc_fail(
            '檔案過大，無法轉為 base64（' . round($size / 1048576, 2) . ' MB）',
            413,
            'size=' . $size . '; max=' . $max
        );
    }

    $raw = @file_get_contents($abs);
    if ($raw === false) oc_fail('無法讀取檔案：' . oc_rel($abs), 500);

    oc_ok([
        'data'  => base64_encode($raw),
        'mime'  => oc_mime($abs),
        'size'  => $size,
        'path'  => oc_rel($abs),
        'mtime' => (int)@filemtime($abs) * 1000,
    ]);
}

// ───────────────────────────────────────────────────────────────
// write — 建立 / 覆寫文字檔
// ───────────────────────────────────────────────────────────────
case 'write': {
    $rel = oc_arg('path', '');
    if (oc_clean_rel($rel) === '') oc_fail('缺少 path 參數', 400);
    $abs = oc_path($rel);
    if (is_dir($abs)) oc_fail('目標是目錄，無法寫入檔案：' . oc_clean_rel($rel), 400);

    $content = oc_arg('content', '');
    if (is_array($content) || is_object($content)) oc_fail('content 必須是字串', 400);
    $content = (string)$content;

    $created = !file_exists($abs);
    if (oc_bool('create_dirs', true)) {
        oc_fs_mkparent($abs);
    } elseif (!is_dir(dirname($abs))) {
        oc_fail('上層目錄不存在（可設定 create_dirs=true 自動建立）：' . oc_rel(dirname($abs)), 404);
    }

    $r = @file_put_contents($abs, $content, LOCK_EX);
    if ($r === false) oc_fail('寫入失敗：' . oc_clean_rel($rel), 500);
    clearstatcache(true, $abs);

    oc_ok([
        'path'    => oc_rel($abs),
        'size'    => (int)@filesize($abs),
        'mtime'   => (int)@filemtime($abs) * 1000,
        'created' => $created,
    ]);
}

// ───────────────────────────────────────────────────────────────
// write_b64 — 以 base64 / dataURL 寫入二進位檔
// ───────────────────────────────────────────────────────────────
case 'write_b64': {
    $rel = oc_arg('path', '');
    if (oc_clean_rel($rel) === '') oc_fail('缺少 path 參數', 400);
    $abs = oc_path($rel);
    if (is_dir($abs)) oc_fail('目標是目錄，無法寫入檔案：' . oc_clean_rel($rel), 400);

    $data = oc_arg('data', '');
    if (!is_string($data) || $data === '') oc_fail('缺少 data 參數（base64 或 dataURL）', 400);

    // 同時接受 "data:image/png;base64,xxxx" 與純 base64 字串
    if (stripos($data, 'data:') === 0) {
        $comma = strpos($data, ',');
        if ($comma === false) oc_fail('dataURL 格式錯誤（找不到逗號分隔）', 400);
        $data = substr($data, $comma + 1);
    }
    $data = preg_replace('/\s+/', '', $data);          // 去掉換行 / 空白
    $bin  = base64_decode($data, true);
    if ($bin === false) oc_fail('base64 解碼失敗（資料不是合法的 base64）', 400);

    $created = !file_exists($abs);
    if (oc_bool('create_dirs', true)) {
        oc_fs_mkparent($abs);
    } elseif (!is_dir(dirname($abs))) {
        oc_fail('上層目錄不存在（可設定 create_dirs=true 自動建立）：' . oc_rel(dirname($abs)), 404);
    }

    $r = @file_put_contents($abs, $bin, LOCK_EX);
    if ($r === false) oc_fail('寫入失敗：' . oc_clean_rel($rel), 500);
    clearstatcache(true, $abs);

    oc_ok([
        'path'    => oc_rel($abs),
        'size'    => (int)@filesize($abs),
        'mtime'   => (int)@filemtime($abs) * 1000,
        'created' => $created,
    ]);
}

// ───────────────────────────────────────────────────────────────
// edit — 逐字取代（唯一或 replace_all）
// ───────────────────────────────────────────────────────────────
case 'edit': {
    $rel = oc_arg('path', '');
    $abs = oc_fs_file($rel);

    $content = @file_get_contents($abs);
    if ($content === false) oc_fail('無法讀取檔案：' . oc_rel($abs), 500);

    $res = oc_fs_apply_edit(
        $content,
        oc_arg('old_string', ''),
        oc_arg('new_string', ''),
        oc_bool('replace_all', false)
    );
    if (isset($res['error'])) oc_fail($res['error'], $res['code'], $res['detail']);

    $r = @file_put_contents($abs, $res['content'], LOCK_EX);
    if ($r === false) oc_fail('寫入失敗：' . oc_rel($abs), 500);
    clearstatcache(true, $abs);

    oc_ok([
        'path'     => oc_rel($abs),
        'replaced' => $res['replaced'],
        'size'     => (int)@filesize($abs),
        'mtime'    => (int)@filemtime($abs) * 1000,
    ]);
}

// ───────────────────────────────────────────────────────────────
// multi_edit — 多筆取代，全有全無（任一失敗都不落盤）
// ───────────────────────────────────────────────────────────────
case 'multi_edit': {
    $rel = oc_arg('path', '');
    $abs = oc_fs_file($rel);

    $edits = oc_arg('edits', []);
    if (!is_array($edits) || !$edits) oc_fail('edits 必須是非空陣列', 400);

    $content = @file_get_contents($abs);
    if ($content === false) oc_fail('無法讀取檔案：' . oc_rel($abs), 500);

    $working  = $content;
    $applied  = 0;
    $replaced = 0;
    $i        = 0;
    foreach ($edits as $e) {
        $i++;
        if (!is_array($e)) oc_fail('multi_edit 第 ' . $i . ' 筆編輯格式錯誤（必須是物件）', 400);
        $res = oc_fs_apply_edit(
            $working,
            $e['old_string'] ?? '',
            $e['new_string'] ?? '',
            !empty($e['replace_all'])
        );
        if (isset($res['error'])) {
            // 全有全無：直接失敗，磁碟上的檔案保持原狀
            oc_fail(
                'multi_edit 第 ' . $i . ' 筆編輯失敗：' . $res['error'] . '（已中止，檔案未被修改）',
                $res['code'],
                $res['detail']
            );
        }
        $working  = $res['content'];
        $replaced += $res['replaced'];
        $applied++;
    }

    $r = @file_put_contents($abs, $working, LOCK_EX);
    if ($r === false) oc_fail('寫入失敗：' . oc_rel($abs), 500);
    clearstatcache(true, $abs);

    oc_ok([
        'path'     => oc_rel($abs),
        'applied'  => $applied,
        'replaced' => $replaced,
        'size'     => (int)@filesize($abs),
        'mtime'    => (int)@filemtime($abs) * 1000,
    ]);
}

// ───────────────────────────────────────────────────────────────
// mkdir — 建立目錄（含上層）
// ───────────────────────────────────────────────────────────────
case 'mkdir': {
    $rel   = oc_arg('path', '');
    $clean = oc_clean_rel($rel);
    if ($clean === '') oc_fail('缺少 path 參數', 400);
    $abs = oc_path($rel);

    if (is_dir($abs)) oc_ok(['path' => oc_rel($abs), 'created' => false]);
    if (file_exists($abs)) oc_fail('同名檔案已存在：' . $clean, 409);

    if (!@mkdir($abs, 0777, true) && !is_dir($abs)) {
        oc_fail('無法建立目錄：' . $clean, 500);
    }
    oc_ok(['path' => oc_rel($abs), 'created' => true]);
}

// ───────────────────────────────────────────────────────────────
// delete — 刪除檔案 / 目錄
// ───────────────────────────────────────────────────────────────
case 'delete': {
    $rel   = oc_arg('path', '');
    $clean = oc_clean_rel($rel);
    if ($clean === '') oc_fail('拒絕刪除工作區根目錄', 403);
    $abs = oc_path($rel);
    if (!file_exists($abs) && !is_link($abs)) oc_fail('路徑不存在：' . $clean, 404);

    $recursive = oc_bool('recursive', false);
    if (is_dir($abs) && !is_link($abs)) {
        $items = @scandir($abs) ?: [];
        $empty = count(array_diff($items, ['.', '..'])) === 0;
        if (!$empty && !$recursive) {
            oc_fail('目錄非空，需設定 recursive=true 才能刪除：' . $clean, 409);
        }
    }

    $deleted = oc_fs_rm($abs);
    clearstatcache();
    oc_ok(['path' => $clean, 'deleted' => $deleted]);
}

// ───────────────────────────────────────────────────────────────
// move — 移動 / 更名
// ───────────────────────────────────────────────────────────────
case 'move': {
    $fromRel = oc_arg('from', '');
    $toRel   = oc_arg('to', '');
    if (oc_clean_rel($fromRel) === '') oc_fail('拒絕移動工作區根目錄', 403);
    if (oc_clean_rel($toRel) === '')   oc_fail('缺少 to 參數', 400);

    $from = oc_path($fromRel);
    $to   = oc_path($toRel);
    if (!file_exists($from)) oc_fail('來源不存在：' . oc_clean_rel($fromRel), 404);
    if (strcasecmp($from, $to) === 0) oc_ok(['from' => oc_rel($from), 'to' => oc_rel($to), 'moved' => false]);

    // 目標位於來源目錄內 → 會把目錄搬進自己裡面。
    // rename() 失敗後的「複製 + 刪除」後援會邊複製邊產生新內容，
    // 最後 oc_fs_rm($from) 連同剛複製好的東西一起刪光 —— 這是純粹的資料遺失。
    // （copy 早就有這道守衛，move 卻漏了。）
    if (is_dir($from) && stripos(oc_fs_slash($to) . '/', oc_fs_slash($from) . '/') === 0) {
        oc_fail('目標位於來源目錄之內，無法移動：' . oc_clean_rel($fromRel) . ' → ' . oc_clean_rel($toRel), 400);
    }

    $overwrite = oc_bool('overwrite', false);
    if (file_exists($to)) {
        if (!$overwrite) oc_fail('目標已存在：' . oc_clean_rel($toRel), 409);
        // 目標包含來源時不可先刪目標（會把來源一起刪掉）
        if (is_dir($to) && stripos(oc_fs_slash($from) . '/', oc_fs_slash($to) . '/') === 0) {
            oc_fail('來源位於目標目錄之內，無法覆蓋移動', 400);
        }
        oc_fs_rm($to);
    }
    oc_fs_mkparent($to);

    if (!@rename($from, $to)) {
        // 跨磁碟區 rename 在 Windows 會失敗 → 退回「複製 + 刪除」
        oc_fs_cp($from, $to);
        oc_fs_rm($from);
    }
    clearstatcache();
    oc_ok(['from' => oc_clean_rel($fromRel), 'to' => oc_rel($to), 'moved' => true]);
}

// ───────────────────────────────────────────────────────────────
// copy — 複製（支援目錄遞迴）
// ───────────────────────────────────────────────────────────────
case 'copy': {
    $fromRel = oc_arg('from', '');
    $toRel   = oc_arg('to', '');
    if (oc_clean_rel($toRel) === '') oc_fail('缺少 to 參數', 400);

    $from = oc_path($fromRel);
    $to   = oc_path($toRel);
    if (!file_exists($from)) oc_fail('來源不存在：' . oc_clean_rel($fromRel), 404);
    if (strcasecmp($from, $to) === 0) oc_fail('來源與目標相同', 400);
    // 防止把目錄複製進自己的子目錄造成無限遞迴
    if (is_dir($from) && stripos($to . '/', $from . '/') === 0) {
        oc_fail('目標位於來源目錄之內，無法複製', 400);
    }

    $overwrite = oc_bool('overwrite', false);
    if (file_exists($to)) {
        if (!$overwrite) oc_fail('目標已存在：' . oc_clean_rel($toRel), 409);
        oc_fs_rm($to);
    }
    oc_fs_mkparent($to);

    $copied = oc_fs_cp($from, $to);
    clearstatcache();
    oc_ok(['from' => oc_rel($from), 'to' => oc_rel($to), 'copied' => $copied]);
}

// ───────────────────────────────────────────────────────────────
// glob — 遞迴檔名比對（支援 ** ；依 mtime 新→舊）
// ───────────────────────────────────────────────────────────────
case 'glob': {
    $pattern = (string)oc_arg('pattern', '');
    if (trim($pattern) === '') oc_fail('缺少 pattern 參數（例如 **/*.php）', 400);

    $limit = oc_int('limit', 500);
    if ($limit <= 0)   $limit = 500;
    if ($limit > 5000) $limit = 5000;

    $hits = oc_fs_collect(oc_arg('path', ''), $pattern, oc_bool('no_ignore', false));

    // 新→舊
    usort($hits, function ($a, $b) { return $b['mtime'] <=> $a['mtime']; });

    $truncated = count($hits) > $limit;
    $hits      = array_slice($hits, 0, $limit);

    $files = [];
    foreach ($hits as $h) $files[] = $h['rel'];

    $gMeta = ['files' => $files, 'count' => count($files), 'truncated' => $truncated];
    if (!empty($GLOBALS['OC_FS_WALK_TIMEOUT'])) {
        $gMeta['truncated'] = true;
        $gMeta['timed_out'] = true;
        $gMeta['hint'] = '搜尋範圍太大，列舉檔案時已達時間上限。請在樣式前加上目錄（例如 "app/js/**/*.js"）或用 path 參數限定範圍。';
    }
    oc_ok($gMeta);
}

// ───────────────────────────────────────────────────────────────
// grep — 純 PHP 遞迴內容搜尋（content / files / count 三種模式）
// ───────────────────────────────────────────────────────────────
case 'grep': {
    $pattern = oc_arg('pattern', '');
    if (!is_string($pattern) || $pattern === '') oc_fail('缺少 pattern 參數', 400);

    $mode = strtolower((string)oc_arg('mode', 'content'));
    if (!in_array($mode, ['content', 'files', 'count'], true)) {
        oc_fail('mode 必須是 content / files / count 其中之一', 400);
    }
    $ignoreCase = oc_bool('ignore_case', false);
    $multiline  = oc_bool('multiline', false);
    $literal    = oc_bool('literal', false);
    $context    = oc_int('context', 0);
    if ($context < 0)  $context = 0;
    if ($context > 20) $context = 20;
    $limit = oc_int('limit', 200);
    if ($limit <= 0)    $limit = 200;
    if ($limit > 10000) $limit = 10000;

    // ─ 組正規表達式並先行驗證 ─
    $body  = $literal ? preg_quote($pattern, '#') : str_replace('#', '\#', $pattern);
    $mods  = ($ignoreCase ? 'i' : '') . ($multiline ? 's' : '');
    $reRaw = '#' . $body . '#' . $mods;
    $reU   = $reRaw . 'u';
    $re    = $reU;
    if (@preg_match($reU, '') === false) {
        // 'u' 修飾子可能因樣式本身非 UTF-8 而失敗，退回無 'u' 版本
        if (@preg_match($reRaw, '') === false) {
            $err = error_get_last();
            oc_fail('正規表達式無效', 400, $err['message'] ?? ('pattern=' . $pattern));
        }
        $re = $reRaw;
    }
    $reNoU = $reRaw;   // 遇到非 UTF-8 檔案時改用這個

    $hits = oc_fs_collect(oc_arg('path', ''), (string)oc_arg('glob', ''), oc_bool('no_ignore', false));

    $matches   = [];   // content 模式
    $fileList  = [];   // files 模式
    $counts    = [];   // count 模式
    $scanned   = 0;
    $truncated = false;
    $timedOut  = !empty($GLOBALS['OC_FS_WALK_TIMEOUT']);   // 列舉階段就已超時
    $bytesRead = 0;
    $grepEnd   = microtime(true) + OC_FS_GREP_SECS;

    foreach ($hits as $h) {
        if ($truncated) break;
        // 時間 / 流量預算：大型工作區的無篩選搜尋不可讓請求無限期卡住，
        // 改為回傳部分結果並標記 timed_out，由呼叫端縮小範圍後重試。
        if (microtime(true) > $grepEnd)      { $timedOut = true; break; }
        if ($bytesRead > OC_FS_GREP_BYTES)   { $timedOut = true; break; }
        if ($h['size'] > OC_MAX_GREP_BYTES) continue;      // 過大檔案跳過
        if (!oc_is_text($h['abs'])) continue;              // 二進位跳過

        $content = @file_get_contents($h['abs']);
        if ($content === false || $content === '') continue;
        $scanned++;
        $bytesRead += strlen($content);

        // 非 UTF-8 內容改用無 'u' 版本，避免 preg_* 直接回 false
        $useRe = (!mb_check_encoding($content, 'UTF-8')) ? $reNoU : $re;

        if ($multiline) {
            // 整檔比對，回報比對起點所在行號
            $n = @preg_match_all($useRe, $content, $mm, PREG_OFFSET_CAPTURE);
            if (!$n) continue;
            if ($mode === 'files') {
                $fileList[] = $h['rel'];
                if (count($fileList) >= $limit) { $truncated = true; }
                continue;
            }
            if ($mode === 'count') {
                $counts[] = ['file' => $h['rel'], 'count' => $n];
                if (count($counts) >= $limit) { $truncated = true; }
                continue;
            }
            $lines = oc_fs_lines($content);
            foreach ($mm[0] as $m) {
                if (count($matches) >= $limit) { $truncated = true; break; }
                $lineNo = substr_count(substr($content, 0, $m[1]), "\n") + 1;
                $before = [];
                $after  = [];
                for ($k = max(1, $lineNo - $context); $k < $lineNo; $k++)  $before[] = oc_fs_clip($lines[$k - 1] ?? '');
                for ($k = $lineNo + 1; $k <= min(count($lines), $lineNo + $context); $k++) $after[] = oc_fs_clip($lines[$k - 1] ?? '');
                $matches[] = [
                    'file'   => $h['rel'],
                    'line'   => $lineNo,
                    'text'   => oc_fs_clip($m[0]),
                    'before' => $before,
                    'after'  => $after,
                ];
            }
            continue;
        }

        // ─ 逐行比對 ─
        $lines = oc_fs_lines($content);
        $total = count($lines);
        $cnt   = 0;
        $local = [];
        for ($i = 0; $i < $total; $i++) {
            if (@preg_match($useRe, $lines[$i]) !== 1) continue;
            $cnt++;
            if ($mode === 'files') break;                  // 命中一次就夠
            if ($mode === 'content') {
                $before = [];
                $after  = [];
                for ($k = max(0, $i - $context); $k < $i; $k++) $before[] = oc_fs_clip($lines[$k]);
                for ($k = $i + 1; $k <= min($total - 1, $i + $context); $k++) $after[] = oc_fs_clip($lines[$k]);
                $local[] = [
                    'file'   => $h['rel'],
                    'line'   => $i + 1,
                    'text'   => oc_fs_clip($lines[$i]),
                    'before' => $before,
                    'after'  => $after,
                ];
                if (count($matches) + count($local) >= $limit) { $truncated = true; break; }
            }
        }
        if ($cnt === 0) continue;

        if ($mode === 'files') {
            $fileList[] = $h['rel'];
            if (count($fileList) >= $limit) $truncated = true;
        } elseif ($mode === 'count') {
            $counts[] = ['file' => $h['rel'], 'count' => $cnt];
            if (count($counts) >= $limit) $truncated = true;
        } else {
            $matches = array_merge($matches, $local);
        }
    }

    // 超出時間 / 流量預算時回傳部分結果並說明原因，讓呼叫端能縮小範圍重試，
    // 而不是讓請求無限期卡住（大型工作區的無篩選搜尋一定會踩到）。
    $meta = ['scanned' => $scanned, 'truncated' => $truncated || $timedOut];
    if ($timedOut) {
        $meta['timed_out'] = true;
        $meta['hint'] = '搜尋範圍太大，已在掃描 ' . $scanned . ' 個檔案後停止並回傳部分結果。'
                      . '請用 glob 參數限定副檔名（例如 "**/*.php"）或用 path 參數限定子目錄後重試。';
    }

    if ($mode === 'files') {
        sort($fileList, SORT_NATURAL | SORT_FLAG_CASE);
        oc_ok(array_merge(['files' => $fileList, 'count' => count($fileList)], $meta));
    }
    if ($mode === 'count') {
        usort($counts, function ($a, $b) { return $b['count'] <=> $a['count']; });
        $total = 0;
        foreach ($counts as $c) $total += $c['count'];
        oc_ok(array_merge(['counts' => $counts, 'total' => $total], $meta));
    }
    oc_ok(array_merge(['matches' => $matches, 'count' => count($matches)], $meta));
}

// ───────────────────────────────────────────────────────────────
// stat — 檔案 / 目錄資訊
// ───────────────────────────────────────────────────────────────
case 'stat': {
    $rel = oc_arg('path', '');
    $abs = oc_path($rel);
    clearstatcache(true, $abs);

    if (!file_exists($abs)) {
        oc_ok([
            'exists' => false, 'path' => oc_clean_rel($rel), 'type' => null,
            'size' => 0, 'mtime' => 0, 'ctime' => 0, 'readonly' => false, 'mime' => null,
        ]);
    }

    $isDir = is_dir($abs);
    $size  = $isDir ? 0 : (int)@filesize($abs);
    $out = [
        'exists'   => true,
        'path'     => oc_rel($abs),
        'name'     => basename($abs),
        // 碰到憑證／金鑰類檔案時回一句說明，讓前端把操作升級成需授權
        'sensitive' => oc_path_sensitivity($rel),
        'type'     => $isDir ? 'dir' : 'file',
        'size'     => $size,
        'mtime'    => (int)@filemtime($abs) * 1000,
        'ctime'    => (int)@filectime($abs) * 1000,
        'readonly' => !@is_writable($abs),
        'mime'     => $isDir ? null : oc_mime($abs),
    ];
    if (!$isDir) {
        $out['ext']    = oc_ext($abs);
        $out['binary'] = !oc_is_text($abs);
        // 行數只在「文字檔且小於 2MB」時計算，避免大檔拖慢
        if (!$out['binary'] && $size > 0 && $size <= OC_FS_STAT_LINE_MAX) {
            $c = @file_get_contents($abs);
            if ($c !== false) $out['lines'] = count(oc_fs_lines($c));
        }
    }
    oc_ok($out);
}

// ───────────────────────────────────────────────────────────────
// upload — multipart 上傳（file[] + path 目標目錄）
// ───────────────────────────────────────────────────────────────
case 'upload': {
    if (empty($_FILES['file'])) oc_fail('沒有收到上傳檔案（欄位名稱須為 file[]）', 400);

    // multipart 請求的 php://input 是空的，目標目錄改從 $_POST 取
    $destRel = $_POST['path'] ?? oc_arg('path', '');
    $destAbs = oc_path($destRel);
    if (file_exists($destAbs) && !is_dir($destAbs)) {
        oc_fail('目標不是目錄：' . oc_clean_rel($destRel), 400);
    }
    if (!is_dir($destAbs) && !@mkdir($destAbs, 0777, true) && !is_dir($destAbs)) {
        oc_fail('無法建立目標目錄：' . oc_clean_rel($destRel), 500);
    }
    $destRelClean = oc_clean_rel($destRel);

    // 統一成陣列形式（file 與 file[] 都支援）
    $f     = $_FILES['file'];
    $names = is_array($f['name']) ? $f['name'] : [$f['name']];
    $tmps  = is_array($f['tmp_name']) ? $f['tmp_name'] : [$f['tmp_name']];
    $errs  = is_array($f['error']) ? $f['error'] : [$f['error']];
    $sizes = is_array($f['size']) ? $f['size'] : [$f['size']];

    $saved = [];
    foreach ($names as $i => $rawName) {
        if (($errs[$i] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
            oc_fail('上傳失敗（PHP 錯誤碼 ' . ($errs[$i] ?? '?') . '）：' . $rawName, 400);
        }
        if (($sizes[$i] ?? 0) > OC_MAX_UPLOAD_BYTES) {
            oc_fail('檔案過大：' . $rawName, 413, 'max=' . OC_MAX_UPLOAD_BYTES);
        }
        $name = oc_fs_safe_name($rawName);
        if ($name === '') oc_fail('檔名不合法：' . $rawName, 400);

        // 再走一次 oc_path()，確保清洗後的路徑仍在工作區內
        $targetRel = ($destRelClean === '' ? '' : $destRelClean . '/') . $name;
        $targetAbs = oc_path($targetRel);

        $tmp = $tmps[$i] ?? '';
        $ok  = @is_uploaded_file($tmp) ? @move_uploaded_file($tmp, $targetAbs) : @rename($tmp, $targetAbs);
        if (!$ok) oc_fail('無法儲存上傳檔案：' . $name, 500);

        clearstatcache(true, $targetAbs);
        $saved[] = ['path' => oc_rel($targetAbs), 'name' => $name, 'size' => (int)@filesize($targetAbs)];
    }

    oc_ok(['files' => $saved, 'count' => count($saved), 'dir' => $destRelClean]);
}

// ───────────────────────────────────────────────────────────────
// download — 原始檔案串流（附件下載，不回 JSON）
// ───────────────────────────────────────────────────────────────
case 'download': {
    $abs  = oc_fs_file(oc_arg('path', ''));
    $name = basename($abs);
    $size = (int)@filesize($abs);

    oc_fs_stream_clean();
    header('Content-Type: application/octet-stream');
    header('Content-Disposition: attachment; filename="' . rawurlencode($name) . '"; filename*=UTF-8\'\'' . rawurlencode($name));
    header('Content-Length: ' . $size);
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    @readfile($abs);
    exit;
}

// ───────────────────────────────────────────────────────────────
// raw — 原始檔案串流（inline，供前端 <img> 預覽，不回 JSON）
// ───────────────────────────────────────────────────────────────
case 'raw': {
    $abs  = oc_fs_file(oc_arg('path', ''));
    $name = basename($abs);
    $size = (int)@filesize($abs);

    oc_fs_stream_clean();
    header('Content-Type: ' . oc_mime($abs));
    header('Content-Disposition: inline; filename="' . rawurlencode($name) . '"');
    header('Content-Length: ' . $size);
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    @readfile($abs);
    exit;
}

// ───────────────────────────────────────────────────────────────
default:
    oc_fail('未知的 action: ' . $action, 404);
}

}   // ← oc_fs_dispatch

if (PHP_SAPI !== 'cli') oc_fs_dispatch(oc_arg('action', ''));
