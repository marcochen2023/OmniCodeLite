<?php
require_once __DIR__ . '/../includes/helpers.php';
// CLI（mcp-server.php）只是要 include 進來拿 oc_cg_dispatch()，
// 不該連帶送出 HTTP 標頭、也不該在檔尾自己跑一次請求（同 fs.php 模式）。
if (PHP_SAPI !== 'cli') oc_boot();

// ═══════════════════════════════════════════════════════════════
// Omni Code — api/codegraph.php（結構化程式碼圖譜：Graft Tier-1 移植）
// ═══════════════════════════════════════════════════════════════
// 取法 trailhq/Graft 的免模型結構層（Tier-1：deterministic tree-sitter，
// no model, no key），用純 PHP 重做一遍 —— 本專案零 composer、
// 沒有 tree-sitter 綁定，所以：
//
//   PHP 檔 → token_get_all() 詞法分析（精確：namespace／類／函式／
//            方法／use 匯入／呼叫邊，行號精確）
//   JS/TS  → 逐行正規表達式（近似：頂層 function／class／箭頭函式常數／
//            import；方法級不做 —— 正則分不清縮排語境，硬做只會給出
//            錯答案。Graft 的 broad-tier 也是近似層，概念一致）
//   其他語言 → 跳過不索引（Graft 亦然：不支援的語言直接略過）
//
// Graft 的三個關鍵機制照搬：
//   1. 增量快取 —— 每檔 content hash，未變動的檔直接重放上次解析結果，
//      全量重建與增量重建輸出一致（Graft 的 cold==incremental 不變量）。
//   2. 查詢前自動同步 —— 每次 query 先比指紋（size+mtime 快路徑，
//      脏檔才讀內容算 hash），只重解析變動檔。結構層 $0，不調模型。
//   3. 符號級定向 —— repo_map（Graft map）／file_api（Graft skeleton）／
//      trace_calls（Graft callers／blast）／find_refs（Graft grep），
//      讓 Agent 少讀全文、少燒 token。
//
// 刻意不做 Tier-2（LLM 寫節點摘要／概念分群）：那需要供應商 key 與
// 另一套快取語義，列入 roadmap，日後再議。
//
// 快取位置：<workspace>/.omni/codegraph.json（單檔：指紋＋符號＋匯入邊）。
// .omni/ 是既有約定（spill 檢查點同在此），屬本地可再生快取（Graft 語：
// like node_modules），不是提交物。
// ═══════════════════════════════════════════════════════════════

define('OC_CG_VERSION',      2);
define('OC_CG_MAX_FILE',     2 * 1024 * 1024);  // 單檔超過 2MB 跳過不索引
define('OC_CG_WALK_SECS',    6.0);              // 同步列舉的時間預算
define('OC_CG_WALK_DEPTH',   32);
define('OC_CG_CACHE',        '.omni/codegraph.json');
define('OC_CG_CONFIG',       '.codebase-memory.json');  // per-project 副檔名覆蓋

// ─── per-project 設定檔（v1.4 補；取法 cbm）──
// 形狀：{"extra_extensions": {".blade.php": "php", ".vue": "js", ".twig": "html"}}
// 缺失／損壞一律靜默忽略——這是 hint 不是契約。
// 為什麼不做全域：cbm 的全域是「~/.config/cbm/config.json」，
// 但 OmniCode 沒有「全域使用者」這個概念，data/config.json 是伺服器狀態不是
// 開發者個人設定；副檔名覆蓋本來就該跟著工作區走。
function oc_cg_config_load() {
    static $cached = null;
    if ($cached !== null) return $cached;
    $cached = [];
    $p = oc_path(OC_CG_CONFIG);
    if (!is_file($p)) return $cached;
    $raw = @file_get_contents($p);
    $j = $raw ? json_decode($raw, true) : null;
    if (!is_array($j)) return $cached;
    $map = is_array($j['extra_extensions'] ?? null) ? $j['extra_extensions'] : [];
    // 規格化：key 一律 ".xxx"，value 一律小寫
    $out = [];
    foreach ($map as $k => $v) {
        if (!is_string($k) || !is_string($v)) continue;
        $k = strtolower(trim($k));
        if ($k === '' || $k[0] !== '.') $k = '.' . ltrim($k, '.');
        $v = strtolower(trim($v));
        if ($v === '') continue;
        $out[$k] = $v;
    }
    $cached = $out;
    return $cached;
}

// 索引的副檔名 → 萃取器
// 內建白名單：php、js 系；per-project 設定可額外把任意副檔名
// 對映成 "php" / "js"（其他語言萃取器為 null 一律跳過）。
function oc_cg_lang($rel) {
    $e = oc_ext($rel);
    $ext = $e === '' ? '' : '.' . $e;
    // 1) per-project 設定先贏
    $over = oc_cg_config_load();
    if ($ext !== '' && isset($over[$ext])) {
        $v = $over[$ext];
        if ($v === 'php') return 'php';
        if (in_array($v, ['js', 'javascript', 'ts', 'typescript'], true)) return 'js';
        return null;
    }
    // 2) 內建白名單
    if ($e === 'php' || $e === 'phtml') return 'php';
    if (in_array($e, ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx'], true)) return 'js';
    return null;
}

// ─── 精簡走訪器 ────────────────────────────────────────────────
// 不複用 fs.php 的 oc_fs_walk：那個函式住在 fs.php 裡，require 它會
// 連帶觸發檔尾的 oc_fs_dispatch(oc_arg('action','')) → action 為空直接
// 404 exit。拆檔案的風險高於重寫一個 40 行的走訪器。
function oc_cg_walk($baseAbs, &$timedOut) {
    global $OC_IGNORE;
    $out = [];
    $timedOut = false;
    $deadline = microtime(true) + OC_CG_WALK_SECS;
    $stack = [[$baseAbs, 0]];
    while ($stack) {
        if (microtime(true) > $deadline) { $timedOut = true; break; }
        [$dir, $depth] = array_pop($stack);
        if ($depth > OC_CG_WALK_DEPTH) continue;
        $items = @scandir($dir);
        if ($items === false) continue;
        foreach ($items as $it) {
            if ($it === '.' || $it === '..') continue;
            $abs = str_replace('\\', '/', $dir . '/' . $it);
            if (is_dir($abs)) {
                if (in_array($it, $OC_IGNORE, true)) continue;
                if ($it[0] === '.') continue;   // .git / .omni / .vscode 一律不進索引
                $stack[] = [$abs, $depth + 1];
            } elseif (is_file($abs)) {
                if (oc_cg_lang($abs) === null) continue;
                $size = (int)@filesize($abs);
                if ($size <= 0 || $size > OC_CG_MAX_FILE) continue;
                $out[] = ['rel' => oc_rel($abs), 'abs' => $abs,
                          'size' => $size, 'mtime' => (int)@filemtime($abs)];
            }
        }
    }
    return $out;
}

// ═══════════════════════════════════════════════════════════════
// PHP 萃取（token_get_all 精確版）
// ═══════════════════════════════════════════════════════════════
// T_FUNCTION 後直接跟 '(' 是匿名函式／閉包 → 跳過（不給符號）。
// 閉包的 use ($x) 形同頂層 use，靠 $skipUse 旗標排除，否則會誤記成匯入。
// 箭頭函式 fn() 無大括號，其內呼叫會記到外層函式名下 —— 近似，誠實註明。
// self::／parent:: 跳過：記了也解不到符號定義，只佔邊。
function oc_cg_extract_php($rel, $src) {
    $tokens = @token_get_all($src);
    if (!is_array($tokens)) return ['symbols' => [], 'imports' => []];
    $syms = [];
    $imports = [];
    $ns = '';
    $depth = 0;
    $classStack = [];    // [fqn, depth]
    $funcStack  = [];    // [symIdx, depth]
    $pendingClass = null;  // ['name'=>, 'line'=>, 'kind'=>]
    $pendingExtends = '';
    $pendingFunc = null;   // symIdx（等 '{' 入棧，等 ';' 丟棄）
    $skipUse = false;      // 剛見過匿名 function，等著吃掉它的 use
    $n = count($tokens);

    // 往前找下一個有意義 token 的下標（跳過空白／註解）
    $nextSig = function ($j) use ($tokens, $n) {
        for ($k = $j + 1; $k < $n; $k++) {
            $t = $tokens[$k];
            if (is_array($t) && in_array($t[0], [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true)) continue;
            return $k;
        }
        return -1;
    };
    // 從下標 j 起讀一個命名空間／類名（含 PHP8 的 T_NAME_* 複合 token，
    // 以及 use function／use const 前綴與分组 use 的前綴）
    $readName = function ($j) use ($tokens, $n) {
        $name = '';
        for ($k = $j + 1; $k < $n; $k++) {
            $t = $tokens[$k];
            if (is_array($t) && in_array($t[0], [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true)) continue;
            if (is_array($t) && ($t[0] === T_FUNCTION || $t[0] === T_CONST)) continue;
            if (is_array($t) && in_array($t[0],
                [T_STRING, T_NAME_QUALIFIED, T_NAME_FULLY_QUALIFIED, T_NAME_RELATIVE,
                 T_NS_SEPARATOR], true)) {
                $name .= $t[1];
                continue;
            }
            break;
        }
        return [rtrim($name, '\\'), $k ?? $n];
    };
    // 往回找上一個有意義 token 的下標（跳過空白／註解）—— 宣告名不記呼叫邊用
    $prevSig = function ($j) use ($tokens) {
        for ($k = $j - 1; $k >= 0; $k--) {
            $t = $tokens[$k];
            if (is_array($t) && in_array($t[0], [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true)) continue;
            return $k;
        }
        return -1;
    };

    $noCall = ['if' => 1, 'else' => 1, 'elseif' => 1, 'while' => 1, 'do' => 1,
        'for' => 1, 'foreach' => 1, 'switch' => 1, 'case' => 1, 'catch' => 1,
        'echo' => 1, 'print' => 1, 'return' => 1, 'require' => 1, 'include' => 1,
        'require_once' => 1, 'include_once' => 1, 'isset' => 1, 'empty' => 1,
        'unset' => 1, 'exit' => 1, 'die' => 1, 'eval' => 1, 'list' => 1,
        'match' => 1, 'fn' => 1, 'function' => 1, 'class' => 1, 'clone' => 1,
        'throw' => 1, 'yield' => 1, 'global' => 1, 'static' => 1,
        'self' => 1, 'parent' => 1, 'true' => 1, 'false' => 1, 'null' => 1,
        'and' => 1, 'or' => 1, 'xor' => 1, 'as' => 1, 'use' => 1,
        'namespace' => 1, 'new' => 1];

    for ($i = 0; $i < $n; $i++) {
        $t = $tokens[$i];
        if (is_string($t)) {
            if ($t === '{') {
                $depth++;
                if ($pendingClass !== null) {
                    $classStack[] = [$pendingClass, $depth];
                    $pendingClass = null;
                }
                if ($pendingFunc !== null) {
                    $funcStack[] = [$pendingFunc, $depth];
                    $pendingFunc = null;
                }
            } elseif ($t === '}') {
                while ($funcStack && $funcStack[count($funcStack) - 1][1] >= $depth) array_pop($funcStack);
                while ($classStack && $classStack[count($classStack) - 1][1] >= $depth) array_pop($classStack);
                $depth--;
            } elseif ($t === ';') {
                $pendingFunc = null;   // 抽象方法／介面方法：無體宣告
            }
            continue;
        }
        [$id, $text, $line] = $t;
        switch ($id) {
            case T_NAMESPACE:
                [$nm] = $readName($i);
                if ($nm !== '') $ns = ltrim($nm, '\\');
                break;
            case T_CLASS:
            case T_INTERFACE:
            case T_TRAIT:
            case T_ENUM: {
                $k = $nextSig($i);
                $nmTok = $k >= 0 ? $tokens[$k] : null;
                if (!is_array($nmTok) || $nmTok[0] !== T_STRING) break;  // new class 匿名類
                $short = $nmTok[1];
                $fqn = ($ns !== '' ? $ns . '\\' : '') . $short;
                $kind = $id === T_CLASS ? 'class' : ($id === T_INTERFACE ? 'interface'
                    : ($id === T_TRAIT ? 'trait' : 'enum'));
                $syms[] = ['name' => $short, 'fqn' => $fqn, 'kind' => $kind,
                           'file' => $rel, 'line' => (int)$nmTok[2], 'calls' => [], 'extends' => ''];
                $pendingClass = ['idx' => count($syms) - 1, 'fqn' => $fqn];
                break;
            }
            case T_EXTENDS:
            case T_IMPLEMENTS:
                if ($pendingClass !== null) {
                    [$nm] = $readName($i);
                    if ($nm !== '') {
                        $prev = $syms[$pendingClass['idx']]['extends'];
                        $syms[$pendingClass['idx']]['extends'] = trim($prev . ' ' . $nm);
                    }
                }
                break;
            case T_FUNCTION: {
                $k = $nextSig($i);
                // 跳過引用符號 &
                if ($k >= 0 && $tokens[$k] === '&') $k = $nextSig($k);
                $nt = $k >= 0 ? $tokens[$k] : null;
                if ($nt === '(' || $nt === null) { $skipUse = true; break; }  // 匿名
                if (!is_array($nt) || $nt[0] !== T_STRING) break;
                $short = $nt[1];
                $inClass = count($classStack) > 0;
                // $classStack 元素 = [pendingClass(['idx','fqn']), depth]（入棧處見 '{' 處理）
                $fqn = $inClass ? $classStack[count($classStack) - 1][0]['fqn'] . '::' . $short
                                : (($ns !== '' ? $ns . '\\' : '') . $short);
                $syms[] = ['name' => $short, 'fqn' => $fqn,
                           'kind' => $inClass ? 'method' : 'function',
                           'file' => $rel, 'line' => (int)$nt[2], 'calls' => []];
                $pendingFunc = count($syms) - 1;
                break;
            }
            case T_USE:
                if ($skipUse) { $skipUse = false; break; }
                if ($depth === 0 && !count($classStack)) {
                    // 分組 use（use Foo\{Bar, function baz\}）：readName 只讀到 "Foo\"，
                    // 逗號後半截會漏。分組本體少見，逐段補讀 "{" 內的每一節。
                    [$nm, $afterIdx] = $readName($i);
                    $nm = ltrim($nm, '\\');
                    if ($nm !== '') {
                        $at = $afterIdx >= 0 && $afterIdx < $n ? $tokens[$afterIdx] : null;
                        if ($at === '{') {
                            $inner = '';
                            for ($g = $afterIdx + 1; $g < $n; $g++) {
                                $gt = $tokens[$g];
                                if ($gt === '}') break;
                                if ($gt === ',') {
                                    $inner = trim($inner);
                                    if ($inner !== '' && strtolower($inner) !== 'function' && strtolower($inner) !== 'const') {
                                        $imports[] = $nm . ltrim($inner, '\\');
                                    }
                                    $inner = '';
                                    continue;
                                }
                                $inner .= is_array($gt) ? $gt[1] : $gt;
                            }
                            $inner = trim($inner);
                            if ($inner !== '' && strtolower($inner) !== 'function' && strtolower($inner) !== 'const') {
                                $imports[] = $nm . ltrim($inner, '\\');
                            }
                        } else {
                            $imports[] = $nm;
                        }
                    }
                }
                break;   // 類內 trait use 與閉包 use 一律略過
            case T_NEW: {
                // 例示化依賴：new Foo → 記 Foo（改 Foo 的建構會影響這裡，屬 blast radius）
                // new class（匿名類）→ 下一個是 T_CLASS，不是名字，直接跳過
                $k = $nextSig($i);
                $nt = $k >= 0 ? $tokens[$k] : null;
                if (is_array($nt) && $nt[0] === T_CLASS) break;
                if (is_array($nt) && $nt[0] === T_STRING && count($funcStack)) {
                    $top = $funcStack[count($funcStack) - 1][0];
                    $syms[$top]['calls'][] = $nt[1];
                }
                break;
            }
            case T_STRING: {
                $k = $nextSig($i);
                $nt = $k >= 0 ? $tokens[$k] : null;
                $isCall = ($nt === '(');
                $isStatic = (is_array($nt) && $nt[0] === T_DOUBLE_COLON);
                if (!$isCall && !$isStatic) break;
                $lname = strtolower($text);
                if (isset($noCall[$lname])) break;
                if (!count($funcStack)) break;   // 頂層程式碼的呼叫不歸屬（trace 主體是函式間）
                // 宣告名不記邊：function foo( 的 foo、class Foo 的 Foo、
                // 方法定義的 foo（前面是 T_FUNCTION）、echo 之類前面是 T_ECHO 的都不記。
                // 只看緊鄰上一個 token 就夠：宣告名與關鍵字之間只有空白／&。
                $pk = $prevSig($i);
                $pt = $pk >= 0 ? $tokens[$pk] : null;
                if (is_array($pt) && in_array($pt[0],
                    [T_FUNCTION, T_CLASS, T_INTERFACE, T_TRAIT, T_ENUM, T_NEW,
                     T_OBJECT_OPERATOR, T_NULLSAFE_OBJECT_OPERATOR], true)) break;
                if ($pt === '&') {
                    $pk2 = $prevSig($pk);
                    $pt2 = $pk2 >= 0 ? $tokens[$pk2] : null;
                    if (is_array($pt2) && $pt2[0] === T_FUNCTION) break;  // function &foo(
                }
                // T_PAAMAYIM_NEKUDOTAYIM（::）只看左半：Foo::bar( 只記 Foo；
                // 若上一個是 ::，這是右半（方法名），在 PHP 側不記邊
                // （跨類方法名重複極多，記了全是誤報；精確解析需型別推導，日後再議）
                if ($pk >= 0) {
                    $raw = $tokens[$pk];
                    $isColon = (is_array($raw) && $raw[0] === T_DOUBLE_COLON) || $raw === ':';
                    if ($isColon) break;
                    // $obj->method(：左半是 ->，方法名跨類重複極多，同樣不記
                    if (is_array($raw) && in_array($raw[0],
                        [T_OBJECT_OPERATOR, T_NULLSAFE_OBJECT_OPERATOR], true)) break;
                    // 函式定義的參數／預設值裡的類名（function f(Foo $x) 的 Foo）不是呼叫
                    if ($raw === '(' || $raw === ',' || $raw === '?') break;
                }
                $top = $funcStack[count($funcStack) - 1][0];
                $syms[$top]['calls'][] = $isStatic ? $text : $text;
                break;
            }
        }
    }
    foreach ($syms as &$s) {
        $s['calls'] = array_values(array_unique($s['calls']));
    }
    unset($s);
    return ['symbols' => $syms, 'imports' => array_values(array_unique($imports))];
}

// ═══════════════════════════════════════════════════════════════
// JS/TS 萃取（逐行正則近似版）
// ═══════════════════════════════════════════════════════════════
// 只認頂層定義；方法級不做（見檔頭說明）。呼叫歸屬採「上方最近符號」
// 近似 —— 跨函式的呼叫會記到前一個函式名下，trace 時以名字解，
// 召回優先於精確，誤收的邊由呼叫端自行用 file:line 驗證。
function oc_cg_extract_js($rel, $src) {
    $syms = [];
    $imports = [];
    $lines = preg_split("/\r\n|\n|\r/", $src);
    $cur = -1;
    $noCall = ['if' => 1, 'for' => 1, 'while' => 1, 'switch' => 1, 'catch' => 1,
        'with' => 1, 'typeof' => 1, 'instanceof' => 1, 'new' => 1, 'delete' => 1,
        'void' => 1, 'in' => 1, 'of' => 1, 'do' => 1, 'else' => 1, 'return' => 1,
        'throw' => 1, 'yield' => 1, 'await' => 1, 'function' => 1, 'class' => 1,
        'extends' => 1, 'super' => 1, 'this' => 1, 'import' => 1, 'export' => 1,
        'from' => 1, 'as' => 1, 'async' => 1, 'static' => 1, 'get' => 1, 'set' => 1,
        'constructor' => 1, 'true' => 1, 'false' => 1, 'null' => 1, 'undefined' => 1];
    foreach ($lines as $idx => $ln) {
        $lineNo = $idx + 1;
        $t = trim($ln);
        if ($t === '' || strncmp($t, '//', 2) === 0) continue;
        if (preg_match('/\bimport\b[^;]*?\bfrom\s*[\'"]([^\'"]+)[\'"]/u', $t, $m)
            || preg_match('/\brequire\s*\(\s*[\'"]([^\'"]+)[\'"]\s*\)/u', $t, $m)
            || preg_match('/^\s*import\s*[\'"]([^\'"]+)[\'"]/u', $t, $m)) {
            $imports[] = $m[1];
            continue;
        }
        if (preg_match('/^(?:export\s+default\s+|export\s+)?class\s+([A-Za-z_$][\w$]*)/u', $t, $m)) {
            $syms[] = ['name' => $m[1], 'fqn' => $m[1], 'kind' => 'class',
                       'file' => $rel, 'line' => $lineNo, 'calls' => []];
            $cur = count($syms) - 1;
            continue;
        }
        if (preg_match('/^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[\(\<]/u', $t, $m)) {
            $syms[] = ['name' => $m[1], 'fqn' => $m[1], 'kind' => 'function',
                       'file' => $rel, 'line' => $lineNo, 'calls' => []];
            $cur = count($syms) - 1;
            continue;
        }
        if (preg_match('/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>|function)/u', $t, $m)) {
            $syms[] = ['name' => $m[1], 'fqn' => $m[1], 'kind' => 'function',
                       'file' => $rel, 'line' => $lineNo, 'calls' => []];
            $cur = count($syms) - 1;
            continue;
        }
        if ($cur >= 0 && preg_match_all('/([A-Za-z_$][\w$]*)\s*\(/u', $t, $mm)) {
            foreach ($mm[1] as $nm) {
                if (isset($noCall[strtolower($nm)])) continue;
                $syms[$cur]['calls'][] = $nm;
            }
        }
    }
    foreach ($syms as &$s) {
        $s['calls'] = array_values(array_unique($s['calls']));
    }
    unset($s);
    return ['symbols' => $syms, 'imports' => array_values(array_unique($imports))];
}

// ═══════════════════════════════════════════════════════════════
// 快取與同步（增量）
// ═══════════════════════════════════════════════════════════════
function oc_cg_cache_path() {
    return oc_path(OC_CG_CACHE);
}

function oc_cg_empty() {
    return ['version' => OC_CG_VERSION, 'built_at' => 0, 'files' => []];
}

function oc_cg_load() {
    $p = oc_cg_cache_path();
    if (!is_file($p)) return oc_cg_empty();
    $raw = @file_get_contents($p);
    $j = $raw ? json_decode($raw, true) : null;
    if (!is_array($j) || ($j['version'] ?? 0) !== OC_CG_VERSION || !is_array($j['files'] ?? null)) {
        return oc_cg_empty();
    }
    return $j;
}

function oc_cg_save($g) {
    $g['built_at'] = (int)round(microtime(true) * 1000);
    $p = oc_cg_cache_path();
    $dir = dirname($p);
    if (!is_dir($dir)) @mkdir($dir, 0777, true);
    @file_put_contents($p, oc_json_encode($g), LOCK_EX);
}

// 查詢前自動同步：只重解析「指紋變了」的檔，其餘重放快取。
// 回傳 [graph, stale] —— 列舉超時時 stale=true，呼叫端必須如實告知。
function oc_cg_sync($forceAll = false) {
    $ws = oc_ws();
    if (!is_dir($ws)) oc_fail('工作區不存在，無法建立索引', 500);
    $g = oc_cg_load();
    $files = oc_cg_walk($ws, $timedOut);
    $seen = [];
    $parsed = 0;
    $reused = 0;
    foreach ($files as $f) {
        $rel = $f['rel'];
        $seen[$rel] = true;
        $old = $g['files'][$rel] ?? null;
        if (!$forceAll && $old && ($old['size'] ?? -1) === $f['size'] && ($old['mtime'] ?? -1) === $f['mtime']) {
            $reused++;
            continue;   // 快路徑：size+mtime 未動，連內容都不讀（Graft 的 ~3ms 級 refresh）
        }
        $src = @file_get_contents($f['abs']);
        if ($src === false) continue;
        $hash = sha1($src);
        if (!$forceAll && $old && ($old['hash'] ?? '') === $hash) {
            $g['files'][$rel]['size'] = $f['size'];
            $g['files'][$rel]['mtime'] = $f['mtime'];
            $reused++;
            continue;
        }
        $lang = oc_cg_lang($rel);
        $r = $lang === 'php' ? oc_cg_extract_php($rel, $src) : oc_cg_extract_js($rel, $src);
        $g['files'][$rel] = ['size' => $f['size'], 'mtime' => $f['mtime'], 'hash' => $hash,
                             'lang' => $lang, 'symbols' => $r['symbols'], 'imports' => $r['imports']];
        $parsed++;
    }
    // 列舉中還有、但磁碟上已消失的檔 → 移出索引（無需獨立 pruning pass）
    $pruned = 0;
    foreach (array_keys($g['files']) as $rel) {
        if (!isset($seen[$rel])) { unset($g['files'][$rel]); $pruned++; }
    }
    // 無變動就不必重寫快取（mtime 動了但 hash 沒變的 stat 回填同理）
    if ($parsed === 0 && $pruned === 0) {
        $g['_sync'] = ['parsed' => 0, 'reused' => $reused, 'stale' => $timedOut];
        return $g;
    }
    oc_cg_save($g);
    $g['_sync'] = ['parsed' => $parsed, 'reused' => $reused, 'stale' => $timedOut];
    return $g;
}

function oc_cg_all_symbols($g) {
    $out = [];
    foreach ($g['files'] as $rel => $f) {
        foreach ($f['symbols'] ?? [] as $s) $out[] = $s;
    }
    return $out;
}

// 名字 → 定義表（短名與 fqn 雙鍵，trace 雙向解析用）。
// 無命名空間的函式 name 與 fqn 相同，同一 key 會命中兩次 → 呼叫端一律去重。
function oc_cg_name_index($g) {
    $idx = [];
    foreach (oc_cg_all_symbols($g) as $s) {
        $idx[strtolower($s['name'])][] = $s;
        if (strtolower($s['fqn']) !== strtolower($s['name'])) {
            $idx[strtolower($s['fqn'])][] = $s;
        }
    }
    return $idx;
}

// 每個符號被多少處引用（in-degree：map hubs 與 search 排序用）
function oc_cg_indegree($g) {
    $deg = [];
    foreach (oc_cg_all_symbols($g) as $s) {
        foreach ($s['calls'] ?? [] as $c) {
            $deg[strtolower($c)] = ($deg[strtolower($c)] ?? 0) + 1;
        }
    }
    return $deg;
}

function oc_cg_stale_note($g) {
    return !empty($g['_sync']['stale'])
        ? "\n⚠ 列舉工作區時達時間上限，索引可能遺漏新檔 —— 結論僅供參考，可縮小 path 範圍重查。"
        : '';
}

// ═══════════════════════════════════════════════════════════════
// 查詢：repo_map（Graft map）
// ═══════════════════════════════════════════════════════════════
// token-budgeted 第一眼：目錄聚類＋各目錄 hubs＋全域 hotspots，
// 全部按 in-degree 排序，不調模型。
function oc_cg_map($g, $pathPrefix = '') {
    $deg = oc_cg_indegree($g);
    $dirs = [];
    $nSym = 0;
    $nEdge = 0;
    $langs = [];
    foreach ($g['files'] as $rel => $f) {
        if ($pathPrefix !== '' && stripos($rel, $pathPrefix) !== 0) continue;
        $dir = strpos($rel, '/') === false ? '.' : substr($rel, 0, strrpos($rel, '/'));
        $d = &$dirs[$dir];
        if (!isset($d)) $d = ['files' => 0, 'symbols' => 0, 'hubs' => []];
        $d['files']++;
        $langs[$f['lang'] ?? '?'] = true;
        foreach ($f['symbols'] ?? [] as $s) {
            $nSym++;
            $nEdge += count($s['calls'] ?? []);
            $d['symbols']++;
            $in = $deg[strtolower($s['name'])] ?? 0;
            $d['hubs'][] = ['s' => $s, 'in' => $in];
        }
        unset($d);
    }
    ksort($dirs, SORT_NATURAL | SORT_FLAG_CASE);
    $lines = [];
    foreach ($dirs as $dir => $d) {
        usort($d['hubs'], function ($a, $b) { return $b['in'] <=> $a['in']; });
        $hubs = [];
        foreach (array_slice($d['hubs'], 0, 3) as $h) {
            if ($h['in'] <= 0) break;
            $hubs[] = $h['s']['name'] . '（' . $h['s']['file'] . ':' . $h['s']['line'] . '，' . $h['in'] . '←）';
        }
        $lines[] = $dir . '/  ' . $d['files'] . ' 檔 · ' . $d['symbols'] . ' 符號'
                 . ($hubs ? '  hubs: ' . implode('、', $hubs) : '');
    }
    $all = oc_cg_all_symbols($g);
    usort($all, function ($a, $b) use ($deg) {
        return ($deg[strtolower($b['name'])] ?? 0) <=> ($deg[strtolower($a['name'])] ?? 0);
    });
    $hots = [];
    foreach (array_slice($all, 0, 8) as $s) {
        $in = $deg[strtolower($s['name'])] ?? 0;
        if ($in <= 0) break;
        $hots[] = $s['name'] . ' · ' . $s['kind'] . ' · ' . $s['file'] . ':' . $s['line'] . ' · ' . $in . '←';
    }
    $nFile = count($g['files']);
    $text = 'repo map — ' . $nFile . ' 檔 · ' . $nSym . ' 符號 · ' . $nEdge . ' 呼叫邊'
          . ' · ' . implode('+', array_keys($langs))
          . "\n\n" . implode("\n", $lines)
          . ($hots ? "\n\nhotspots: " . implode(' ／ ', $hots) : '')
          . oc_cg_stale_note($g);
    if ($pathPrefix !== '') $text .= "\n（範圍限定：" . $pathPrefix . ' 下）';
    return $text;
}

// ═══════════════════════════════════════════════════════════════
// 查詢：file_api（Graft skeleton）
// ═══════════════════════════════════════════════════════════════
// 某檔的全部簽名、無函式體 —— 約 1/10 token 拿到 API 面。
function oc_cg_file_api($g, $rel) {
    $clean = oc_clean_rel($rel);
    if (!isset($g['files'][$clean])) {
        oc_fail('索引中沒有這個檔案：' . $clean . '（可能是不支援的語言、過大、或已被刪除）', 404);
    }
    $f = $g['files'][$clean];
    $deg = oc_cg_indegree($g);
    $abs = oc_path($clean);
    $fileLines = @file($abs, FILE_IGNORE_NEW_LINES);
    $rows = [];
    foreach ($f['symbols'] ?? [] as $s) {
        $sig = '';
        if (is_array($fileLines) && isset($fileLines[$s['line'] - 1])) {
            $sig = trim(mb_substr($fileLines[$s['line'] - 1], 0, 160, 'UTF-8'));
        }
        $in = $deg[strtolower($s['name'])] ?? 0;
        $rows[] = '  ' . $s['kind'] . ' ' . $s['fqn'] . '（L' . $s['line'] . '）'
                . ($in ? ' ←' . $in . ' 處引用' : '')
                . ($sig !== '' ? "\n    " . $sig : '')
                . (($s['extends'] ?? '') !== '' ? "\n    extends/implements: " . $s['extends'] : '');
    }
    if (!$rows) return $clean . '：沒有可索引的符號（' . ($f['lang'] ?? '?') . '）。';
    $text = $clean . ' — ' . count($rows) . ' 個簽名（無函式體）'
          . ($f['imports'] ? "\n匯入: " . implode('、', $f['imports']) : '')
          . "\n" . implode("\n", $rows)
          . oc_cg_stale_note($g);
    return $text;
}

// ═══════════════════════════════════════════════════════════════
// 查詢：trace_calls（Graft callers／blast）
// ═══════════════════════════════════════════════════════════════
// 改簽名前看 blast radius：誰會被影響（in），或它依賴誰（out）。
// 同名多定義 → 起點全部展開並標示（不用猜，不替使用者選）。
function oc_cg_trace($g, $name, $direction = 'in', $depth = 2) {
    $name = trim((string)$name);
    if ($name === '') oc_fail('缺少 symbol 參數', 400);
    if ($direction !== 'in' && $direction !== 'out') oc_fail('direction 必須是 in 或 out', 400);
    $depth = max(1, min(5, (int)$depth));
    $idx = oc_cg_name_index($g);
    $starts = $idx[strtolower($name)] ?? [];
    // 短名命中 nothing 時，試全名後綴（Foo::bar 打 bar 也找得到 —— 短名鍵已覆蓋；此處免）
    if (!$starts) {
        // 最後一搏：大小寫不敏感的子字串（只取前 10，避免爆炸）
        $lq = strtolower($name);
        foreach (oc_cg_all_symbols($g) as $s) {
            if (stripos($s['fqn'], $lq) !== false) {
                $starts[] = $s;
                if (count($starts) >= 10) break;
            }
        }
    }
    if (!$starts) oc_fail('找不到符號：' . $name . '（先用 repo_map 或 find_refs 確認名字）', 404);

    $lines = [];
    $lines[] = 'trace ' . $name . ($direction === 'in' ? ' ← 被誰用' : ' → 依賴誰')
             . '（深 ' . $depth . '，' . count($starts) . ' 處定義）';
    foreach ($starts as $st) {
        $lines[] = '';
        $lines[] = '● ' . $st['fqn'] . ' · ' . $st['kind'] . ' · ' . $st['file'] . ':' . $st['line'];
        $seen = [strtolower($st['fqn']) => true, strtolower($st['name']) => true];
        $frontier = [[$st, 0]];
        $shown = 0;
        $cut = false;
        while ($frontier && $shown < 120) {
            [$cur, $lv] = array_shift($frontier);
            if ($lv >= $depth) continue;
            $next = [];
            if ($direction === 'in') {
                foreach (oc_cg_all_symbols($g) as $s) {
                    foreach ($s['calls'] ?? [] as $c) {
                        if (strtolower($c) === strtolower($cur['name'])
                            || strtolower($c) === strtolower($cur['fqn'])) {
                            $next[] = $s;
                            break;
                        }
                    }
                }
            } else {
                $seenUn = [];
                foreach ($cur['calls'] ?? [] as $c) {
                    if (isset($idx[strtolower($c)])) {
                        foreach ($idx[strtolower($c)] as $s) $next[] = $s;
                    } elseif (!isset($seenUn[strtolower($c)])) {
                        // 未解析：同名只顯示一次（count()／is_array() 這種內建在同一函式會出現很多次）
                        $seenUn[strtolower($c)] = true;
                        $next[] = ['name' => $c, 'fqn' => $c, 'kind' => '?',
                                   'file' => $cur['file'], 'line' => $cur['line'], '_unresolved' => true];
                    }
                }
            }
            // 同層去重＋已訪跳過（防環）
            $uniq = [];
            foreach ($next as $s) {
                $k = strtolower($s['fqn']) . '@' . $s['file'] . ':' . $s['line'];
                if (isset($seen[$k])) continue;
                $seen[$k] = true;
                $uniq[] = $s;
            }
            foreach ($uniq as $s) {
                if ($shown >= 120) { $cut = true; break; }
                $shown++;
                $pad = str_repeat('  ', $lv + 1) . '← ';
                $tag = !empty($s['_unresolved']) ? $s['name'] . '（外部／未解析：PHP 內建或索引外，名字出現於 ' . $s['file'] . ':' . $s['line'] . '）'
                     : $s['fqn'] . ' · ' . $s['kind'] . ' · ' . $s['file'] . ':' . $s['line'];
                $lines[] = $pad . $tag;
                if (empty($s['_unresolved'])) $frontier[] = [$s, $lv + 1];
            }
        }
        if (!$shown) $lines[] = '  （無' . ($direction === 'in' ? '引用者' : '依賴') . ' —— 改它不影響其他符號）';
        if ($cut) $lines[] = '  …（超過 120 節點已截斷，加深 depth 或改用 find_refs 縮小範圍）';
    }
    return implode("\n", $lines) . oc_cg_stale_note($g);
}

// ═══════════════════════════════════════════════════════════════
// 查詢：find_refs（Graft grep）
// ═══════════════════════════════════════════════════════════════
// 后端自帶精簡 grep（不 require fs.php，原因見 oc_cg_walk），
// 命中按「包圍符號」分組、按該符號 in-degree 排序 ——
// 「每個出現處」任務用這個，不用 ask 式的 top-N。
function oc_cg_search($g, $pattern, $pathPrefix = '', $ignoreCase = false, $literal = false, $limit = 60) {
    $pattern = (string)$pattern;
    if ($pattern === '') oc_fail('缺少 pattern 參數', 400);
    $limit = max(1, min(300, (int)$limit));
    $body = $literal ? preg_quote($pattern, '#') : str_replace('#', '\#', $pattern);
    $re = '#' . $body . '#' . ($ignoreCase ? 'i' : '') . 'u';
    if (@preg_match($re, '') === false) {
        $re = '#' . $body . '#' . ($ignoreCase ? 'i' : '');
        if (@preg_match($re, '') === false) oc_fail('正規表達式無效', 400, $pattern);
    }
    $deg = oc_cg_indegree($g);
    $groups = [];   // key → ['s'=>symbol|null, 'file'=>, 'in'=>, 'hits'=>[[line,text]]]
    $nHit = 0;
    $nFile = 0;
    $cut = false;
    foreach ($g['files'] as $rel => $f) {
        if ($nHit >= $limit) { $cut = true; break; }
        if ($pathPrefix !== '' && stripos($rel, $pathPrefix) !== 0) continue;
        $content = @file_get_contents(oc_path($rel));
        if ($content === false || $content === '') continue;
        $nFile++;
        $lines = preg_split("/\r\n|\n|\r/", $content);
        $syms = $f['symbols'] ?? [];
        foreach ($lines as $i => $ln) {
            if ($nHit >= $limit) { $cut = true; break 2; }
            if (@preg_match($re, $ln) !== 1) continue;
            $lineNo = $i + 1;
            // 包圍符號 = 該行之前最近定義的同檔符號（近似，見萃取器註明）
            $owner = null;
            foreach ($syms as $s) {
                if ($s['line'] <= $lineNo) $owner = $s;
                else break;
            }
            $key = $owner ? ('s:' . strtolower($owner['fqn'])) : ('f:' . $rel);
            if (!isset($groups[$key])) {
                $groups[$key] = ['s' => $owner, 'file' => $rel,
                                 'in' => $owner ? ($deg[strtolower($owner['name'])] ?? 0) : -1,
                                 'hits' => []];
            }
            $t = mb_substr(trim($ln), 0, 200, 'UTF-8');
            $groups[$key]['hits'][] = [$lineNo, $t];
            $nHit++;
        }
    }
    if (!$nHit) return '「' . $pattern . '」在索引檔中沒有命中（共掃 ' . $nFile . ' 檔）。';
    uasort($groups, function ($a, $b) { return $b['in'] <=> $a['in']; });
    $out = ['「' . $pattern . '」— ' . $nHit . ' 處命中 · ' . count($groups) . ' 個符號 · ' . $nFile . ' 檔'
          . ($cut ? '（達上限已截斷）' : '')];
    foreach ($groups as $gr) {
        $head = $gr['s']
            ? $gr['s']['fqn'] . ' · ' . $gr['s']['kind'] . ' · ' . $gr['file'] . ':' . $gr['s']['line']
              . ' · ' . $gr['in'] . '←'
            : $gr['file'] . '（頂層程式碼，無包圍符號）';
        $out[] = "\n" . $head;
        foreach (array_slice($gr['hits'], 0, 8) as [$ln, $tx]) {
            $out[] = '  L' . $ln . ': ' . $tx;
        }
        if (count($gr['hits']) > 8) $out[] = '  …（該符號還有 ' . (count($gr['hits']) - 8) . ' 處）';
    }
    return implode("\n", $out) . oc_cg_stale_note($g);
}

// ═══════════════════════════════════════════════════════════════
// 查詢：architecture（v1.4 補；取法 cbm get_architecture）
// ═══════════════════════════════════════════════════════════════
// 一次回傳語言分佈、套件邊界、入口、路由、hotspots、叢集、總覽——
// 「5 分鐘心智地圖」的後端版本，對應 codebase-onboarding skill 的需求。
//
// token-budgeted：完整摘要通常 < 1KB；不算大但故意不上千字。
// 所有資訊來自現有索引，零 LLM 調用。
function oc_cg_architecture($g) {
    $deg = oc_cg_indegree($g);
    $nFile = count($g['files']);
    $nSym = 0; $nEdge = 0;
    $langs = [];      // lang => 檔數
    $dirs = [];       // dir => ['files'=>N, 'syms'=>N]
    $routes = [];     // PHP 內 method 名含 handle/action/route
    $entryHints = []; // 檔名命中 index/serve/main/app/router/web
    $allSyms = [];

    foreach ($g['files'] as $rel => $f) {
        $lang = $f['lang'] ?? '?';
        $langs[$lang] = ($langs[$lang] ?? 0) + 1;
        $dir = strpos($rel, '/') === false ? '.' : substr($rel, 0, strrpos($rel, '/'));
        $d = &$dirs[$dir];
        if (!isset($d)) $d = ['files' => 0, 'syms' => 0, 'edge' => 0];
        $d['files']++;
        foreach ($f['symbols'] ?? [] as $s) {
            $nSym++;
            $nEdge += count($s['calls'] ?? []);
            $d['syms']++;
            $d['edge'] += count($s['calls'] ?? []);
            $allSyms[] = $s;
            $ln = strtolower($s['name']);
            // 入口偵測：檔名 or 符號名命中常見慣例
            if (preg_match('#^(index|main|app|serve|router|web|bootstrap|api)\b#i', $s['name'])) {
                $entryHints[] = ['file' => $rel . ':' . $s['line'], 'kind' => $s['kind'], 'name' => $s['fqn']];
            }
            // 路由偵測（PHP）：方法名 handle / action / route / 帶 HTTP 動詞前綴
            if (($s['kind'] === 'method' || $s['kind'] === 'function')
                && preg_match('#^(handle|on|action|route|dispatch|api|get|post|put|delete|patch)[A-Z_]#', $s['name'])) {
                $routes[] = ['file' => $rel . ':' . $s['line'], 'name' => $s['fqn']];
            }
        }
        unset($d);
    }

    // 全域 hotspots（被引用最多）
    usort($allSyms, function ($a, $b) use ($deg) {
        return ($deg[strtolower($b['name'])] ?? 0) <=> ($deg[strtolower($a['name'])] ?? 0);
    });
    $hots = [];
    foreach ($allSyms as $s) {
        $in = $deg[strtolower($s['name'])] ?? 0;
        if ($in <= 0) break;
        $hots[] = $s['name'] . ' · ' . ($s['kind'] ?? '?') . ' · ' . $s['file'] . ':' . $s['line'] . ' · ' . $in . '←';
        if (count($hots) >= 8) break;
    }

    // 套件邊界：用頂層目錄的「外向匯入 vs 內部呼叫」比例粗略估算
    // （粗略就夠——只標「這個目錄跟外面有沒有交流」）
    $outCalls = [];   // dir => 指向其他 dir 的呼叫邊數
    $inCalls = [];
    $idx = oc_cg_name_index($g);
    foreach ($allSyms as $s) {
        $myDir = strpos($s['file'], '/') === false ? '.' : substr($s['file'], 0, strrpos($s['file'], '/'));
        foreach ($s['calls'] ?? [] as $c) {
            $hits = $idx[strtolower($c)] ?? [];
            $otherDirs = [];
            foreach ($hits as $h) {
                $d = strpos($h['file'], '/') === false ? '.' : substr($h['file'], 0, strrpos($h['file'], '/'));
                if ($d !== $myDir) $otherDirs[$d] = true;
            }
            if ($otherDirs) {
                $outCalls[$myDir] = ($outCalls[$myDir] ?? 0) + 1;
                foreach (array_keys($otherDirs) as $d) $inCalls[$d] = ($inCalls[$d] ?? 0) + 1;
            }
        }
    }
    arsort($outCalls);
    $boundaries = [];
    foreach (array_slice($outCalls, 0, 5, true) as $d => $n) {
        $boundaries[] = $d . '/（' . ($dirs[$d]['files'] ?? '?') . ' 檔 · ' . $n . ' 條跨邊呼叫）';
    }

    // ─── 輸出 ───
    $L = [];
    $L[] = 'architecture — ' . $nFile . ' 檔 · ' . $nSym . ' 符號 · ' . $nEdge . ' 呼叫邊';
    $L[] = '語言：' . implode('+', array_map(function ($n, $c) { return "$n:$c"; }, array_keys($langs), array_values($langs)));

    if ($entryHints) {
        $L[] = '';
        $L[] = '入口（檔名／符號名命中常見慣例的）';
        foreach (array_slice($entryHints, 0, 6) as $e) {
            $L[] = '  ● ' . $e['name'] . ' · ' . $e['kind'] . ' · ' . $e['file'];
        }
    }

    if ($routes) {
        $L[] = '';
        $L[] = '路由（名稱匹配 handle/action/route/HTTP 動詞前綴）';
        foreach (array_slice($routes, 0, 6) as $r) {
            $L[] = '  ● ' . $r['name'] . ' · ' . $r['file'];
        }
    }

    if ($boundaries) {
        $L[] = '';
        $L[] = '套件邊界（外向呼叫最多的目錄）';
        foreach ($boundaries as $b) $L[] = '  ● ' . $b;
    }

    if ($hots) {
        $L[] = '';
        $L[] = 'hotspots（被引用最多）';
        $L[] = '  ' . implode(' ／ ', $hots);
    }

    // 目錄分佈概覽（前 8 大目錄）
    $dirList = $dirs;
    uasort($dirList, function ($a, $b) { return $b['syms'] <=> $a['syms']; });
    $L[] = '';
    $L[] = '目錄分佈（依符號數前 8）';
    $i = 0;
    foreach ($dirList as $d => $info) {
        if ($i++ >= 8) break;
        $L[] = '  ' . $d . '/  ' . $info['files'] . ' 檔 · ' . $info['syms'] . ' 符號 · ' . $info['edge'] . ' 邊';
    }

    $L[] = oc_cg_stale_note($g);
    return implode("\n", $L);
}

// ═══════════════════════════════════════════════════════════════
// 查詢：detect_changes（v1.4 補；取法 cbm detect_changes）
// ═══════════════════════════════════════════════════════════════
// git diff → 動到的符號 → 用 in-degree 排風險。
// 不在 git repo 裡的話退回到「整個工作區的最近 mtime 變動」近似清單，
// 並明講退路。
function oc_cg_detect_changes($g, $limit, $maxRisk) {
    $ws = oc_ws();
    $limit = max(1, min(200, $limit));
    $maxRisk = max(1, min(50, $maxRisk));

    $mode = 'git';  // git | mtime
    $changedFiles = [];

    if (is_dir($ws . '/.git')) {
        // git diff HEAD --name-only（沒有 HEAD 時退到 --cached 或空）
        $cmd = 'git -C ' . escapeshellarg($ws) . ' diff HEAD --name-only --no-renames 2>&1';
        $out = @shell_exec($cmd);
        if ($out !== null && $out !== '') {
            foreach (preg_split("/\r\n|\n|\r/", trim($out)) as $line) {
                $line = trim($line);
                if ($line === '') continue;
                $rel = str_replace('\\', '/', $line);
                if (strpos($rel, "\0") !== false) continue;
                $changedFiles[] = $rel;
            }
        }
        if (!$changedFiles) {
            // 沒改動就看 status
            $cmd2 = 'git -C ' . escapeshellarg($ws) . ' status --short 2>&1';
            $out2 = @shell_exec($cmd2);
            if ($out2) {
                foreach (preg_split("/\r\n|\n|\r/", trim($out2)) as $line) {
                    if (!preg_match('#^\s*[AM?][AM?]\s+(.+)$#', $line, $m)) continue;
                    $rel = str_replace('\\', '/', $m[1]);
                    if (!in_array($rel, $changedFiles, true)) $changedFiles[] = $rel;
                }
            }
        }
    } else {
        $mode = 'mtime';
        // 退路：取索引中 mtime 在最近 7 天內的檔
        $cutoff = time() - 7 * 86400;
        $tmp = [];
        foreach ($g['files'] as $rel => $f) {
            if (($f['mtime'] ?? 0) >= $cutoff) $tmp[] = ['rel' => $rel, 'mtime' => $f['mtime']];
        }
        usort($tmp, function ($a, $b) { return $b['mtime'] <=> $a['mtime']; });
        $changedFiles = array_column(array_slice($tmp, 0, $limit), 'rel');
    }

    if (!$changedFiles) {
        return '工作區沒有未提交的變更（git status 乾淨）。';
    }

    // 對每個動到的檔，列出其中動到的符號 + in-degree + 風險等級
    $deg = oc_cg_indegree($g);
    $idx = oc_cg_name_index($g);
    $groups = [];  // 檔案 → 受影響符號清單
    $allAffected = [];  // 全部受影響符號（去重）

    foreach ($changedFiles as $rel) {
        $f = $g['files'][$rel] ?? null;
        if (!$f) continue;  // 索引中沒有（不支援的語言或被略過）
        $syms = $f['symbols'] ?? [];
        if (!$syms) continue;
        $rows = [];
        foreach ($syms as $s) {
            $in = $deg[strtolower($s['name'])] ?? 0;
            $rows[] = ['s' => $s, 'in' => $in];
            $allAffected[strtolower($s['name'])] = ['s' => $s, 'in' => $in, 'src' => $rel];
        }
        usort($rows, function ($a, $b) { return $b['in'] <=> $a['in']; });
        $groups[$rel] = $rows;
    }

    // 全域受影響符號：對每個 in 邊，找誰呼叫了它（inbound trace，深度 1）
    $blast = [];  // 符號名 → ['in' => 引用者, 'from' => 原始檔]
    foreach ($allAffected as $nm => $info) {
        $s = $info['s'];
        $lname = strtolower($s['name']);
        $callers = [];
        foreach ($g['files'] as $rel => $f) {
            foreach ($f['symbols'] ?? [] as $cand) {
                foreach ($cand['calls'] ?? [] as $c) {
                    if (strtolower($c) === $lname || strtolower($c) === strtolower($s['fqn'])) {
                        $callers[] = $cand['fqn'] . ' · ' . $rel . ':' . $cand['line'];
                        break;
                    }
                }
            }
        }
        if ($callers) {
            $blast[$nm] = ['s' => $s, 'in' => $info['in'], 'callers' => $callers, 'from' => $info['src']];
        } else {
            $blast[$nm] = ['s' => $s, 'in' => $info['in'], 'callers' => [], 'from' => $info['src']];
        }
    }

    // 風險排序：先看「被外部引用數」再看「本身被多少處呼叫」
    uasort($blast, function ($a, $b) { return $b['in'] <=> $a['in']; });
    $top = array_slice($blast, 0, $maxRisk, true);

    // ─── 輸出 ───
    $L = [];
    $L[] = 'detect_changes — ' . count($changedFiles) . ' 個動到的檔'
         . ($mode === 'mtime' ? '（git 不可用，退到最近 7 天 mtime）' : '');
    $L[] = '';

    // 受影響符號總覽
    $L[] = '受影響符號（依被引用數排序，前 ' . $maxRisk . '）';
    foreach ($top as $info) {
        $s = $info['s'];
        $in = $info['in'];
        $nc = count($info['callers']);
        $risk = $in >= 5 ? '🔴' : ($in >= 2 ? '🟡' : '🟢');
        $L[] = '  ' . $risk . ' ' . $s['fqn'] . ' · ' . ($s['kind'] ?? '?') . ' · ' . $info['from'] . ':' . $s['line']
             . '（本身被 ' . $in . ' 處引用，影響 ' . $nc . ' 個呼叫者）';
    }

    // 列出每個被影響符號的「呼叫者」（blast radius）
    $withCallers = array_filter($top, function ($info) { return !empty($info['callers']); });
    if ($withCallers) {
        $L[] = '';
        $L[] = 'blast radius（高風險符號的呼叫者，最多 ' . $limit . ' 個）';
        $shown = 0;
        foreach ($withCallers as $info) {
            if ($shown >= $limit) break;
            $shown++;
            $L[] = '';
            $L[] = '  ● ' . $info['s']['fqn'] . '（' . $info['in'] . ' 處引用，來自 ' . count($info['callers']) . ' 個呼叫者）';
            foreach (array_slice($info['callers'], 0, 8) as $c) $L[] = '    ← ' . $c;
            if (count($info['callers']) > 8) $L[] = '    …（還有 ' . (count($info['callers']) - 8) . ' 個）';
        }
    }

    // 列出動到的檔（沒被索引的）
    $unindexed = array_diff($changedFiles, array_keys($groups));
    if ($unindexed) {
        $L[] = '';
        $L[] = '動到但沒在索引裡（不支援的語言、>2MB、或新檔）';
        foreach (array_slice($unindexed, 0, 30) as $f) $L[] = '  · ' . $f;
        if (count($unindexed) > 30) $L[] = '  …（還有 ' . (count($unindexed) - 30) . ' 個）';
    }

    $L[] = oc_cg_stale_note($g);
    return implode("\n", $L);
}

// ═══════════════════════════════════════════════════════════════
// 路由（包成函式供 MCP 複用，同 fs.php 模式）
// ═══════════════════════════════════════════════════════════════
function oc_cg_dispatch($action) {
switch ($action) {

// ─── build — 全量重建索引 ───
case 'build': {
    $g = oc_cg_sync(true);
    $nSym = count(oc_cg_all_symbols($g));
    oc_ok(['text' => '索引已重建：' . count($g['files']) . ' 檔 · ' . $nSym . ' 符號'
                     . '（解析 ' . $g['_sync']['parsed'] . ' 檔）'
                     . oc_cg_stale_note($g),
           'files' => count($g['files']), 'symbols' => $nSym,
           'parsed' => $g['_sync']['parsed'], 'stale' => $g['_sync']['stale']]);
}

// ─── map / file_api / trace / search — 查詢前自動同步 ───
case 'map': {
    $g = oc_cg_sync(!oc_bool('no_refresh', false));
    $prefix = ltrim(str_replace('\\', '/', (string)oc_arg('path', '')), '/');
    oc_ok(['text' => oc_cg_map($g, $prefix),
           'files' => count($g['files']), 'stale' => $g['_sync']['stale']]);
}

case 'file_api': {
    $g = oc_cg_sync(!oc_bool('no_refresh', false));
    $rel = (string)oc_arg('path', '');
    if (trim($rel) === '') oc_fail('缺少 path 參數', 400);
    oc_ok(['text' => oc_cg_file_api($g, $rel)]);
}

case 'trace': {
    $g = oc_cg_sync(!oc_bool('no_refresh', false));
    oc_ok(['text' => oc_cg_trace($g, (string)oc_arg('symbol', ''),
                                 strtolower((string)oc_arg('direction', 'in')),
                                 oc_int('depth', 2))]);
}

case 'search': {
    $g = oc_cg_sync(!oc_bool('no_refresh', false));
    oc_ok(['text' => oc_cg_search($g, (string)oc_arg('pattern', ''),
                                  ltrim(str_replace('\\', '/', (string)oc_arg('path', '')), '/'),
                                  oc_bool('ignore_case', false),
                                  oc_bool('literal', false),
                                  oc_int('limit', 60))]);
}

case 'architecture': {
    $g = oc_cg_sync(!oc_bool('no_refresh', false));
    oc_ok(['text' => oc_cg_architecture($g),
           'files' => count($g['files']),
           'stale' => $g['_sync']['stale']]);
}

case 'detect_changes': {
    $g = oc_cg_sync(!oc_bool('no_refresh', false));
    $limit = oc_int('limit', 30);
    $maxRisk = oc_int('max_risk', 20);
    oc_ok(['text' => oc_cg_detect_changes($g, $limit, $maxRisk),
           'stale' => $g['_sync']['stale']]);
}

default:
    oc_fail('未知的 action: ' . $action, 404);
}

}   // ← oc_cg_dispatch

if (PHP_SAPI !== 'cli') oc_cg_dispatch(oc_arg('action', ''));
