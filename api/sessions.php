<?php
require_once __DIR__ . '/../includes/helpers.php';
oc_boot();

// ═══════════════════════════════════════════════════════════════
// Omni Code — 會話持久化 / 記憶檔案 / 技能包
// ═══════════════════════════════════════════════════════════════
// 契約見 docs/ARCHITECTURE.md §6、§14。
//   會話  → data/sessions/<id>.json
//   記憶  → project: <ws>/.omni/memory/*.md（索引 <ws>/.omni/MEMORY.md）
//           user   : data/memory/*.md      （索引 data/memory/MEMORY.md）
//   OMNI.md → <ws>/OMNI.md
//   技能  → skills/*/SKILL.md（內建）與 <ws>/.omni/skills/*/SKILL.md（專案）
// 所有工作區內的路徑一律經 oc_path() 檢查，記憶名稱另行 slug 化。
// ═══════════════════════════════════════════════════════════════

$action = oc_arg('action', '');

switch ($action) {
    // ─── 會話 ───────────────────────────────────────────────────
    case 'list':          oc_sess_list();      break;
    case 'get':           oc_sess_get();       break;
    case 'save':          oc_sess_save();      break;
    case 'delete':        oc_sess_delete();    break;
    case 'rename':        oc_sess_rename();    break;
    case 'pin':           oc_sess_pin();       break;
    case 'export':        oc_sess_export();    break;
    case 'search':        oc_sess_search();    break;
    // ─── 記憶 ───────────────────────────────────────────────────
    case 'memory_list':   oc_mem_list();       break;
    case 'memory_get':    oc_mem_get();        break;
    case 'memory_save':   oc_mem_save();       break;
    case 'memory_delete': oc_mem_delete();     break;
    case 'errmem_search': oc_errmem_search();  break;
    case 'errmem_write':  oc_errmem_write();   break;
    case 'omni_md':       oc_omni_md();        break;
    // ─── 技能 ───────────────────────────────────────────────────
    case 'skills':        oc_skill_list();     break;
    case 'agents':        oc_agent_list();     break;
    case 'agent_get':     oc_agent_get();      break;
    case 'commands':      oc_command_list();   break;
    case 'skill_get':     oc_skill_get();      break;

    default:
        oc_fail('未知的 action: ' . $action, 404);
}

// ═══════════════════════════════════════════════════════════════
// 會話
// ═══════════════════════════════════════════════════════════════

// 會話存檔路徑（id 一律驗證，避免路徑穿越）
function oc_sess_file($id) {
    if (!oc_valid_id($id)) {
        oc_fail('會話 ID 格式不正確（僅允許英數字、底線、句點、連字號）', 400, is_string($id) ? $id : gettype($id));
    }
    return OC_SESSIONS . '/' . $id . '.json';
}

// 目前毫秒時間戳
function oc_sess_now() {
    return (int)round(microtime(true) * 1000);
}

// 毫秒時間戳 → 可讀字串
function oc_sess_time($ms) {
    $ms = is_numeric($ms) ? (float)$ms : 0;
    if ($ms <= 0) return '—';
    return date('Y-m-d H:i', (int)round($ms / 1000));
}

// 從完整會話萃取輕量 meta（list 專用，絕不回傳 messages）
// extraRootsCount 只給面板顯示「有掛幾個」，完整清單走 get 拿。
function oc_sess_extra_count($s) {
    $roots = $s['extraRoots'] ?? [];
    return is_array($roots) ? count($roots) : 0;
}

function oc_sess_meta($s, $id) {
    $msgs  = (isset($s['messages']) && is_array($s['messages'])) ? $s['messages'] : [];
    $usage = (isset($s['usage']) && is_array($s['usage'])) ? $s['usage'] : [];
    $tok   = (int)($usage['in'] ?? 0) + (int)($usage['out'] ?? 0);
    if ($tok === 0 && isset($s['tokens']) && is_numeric($s['tokens'])) $tok = (int)$s['tokens'];
    return [
        'id'        => (string)($s['id'] ?? $id),
        'title'     => (string)($s['title'] ?? '未命名會話'),
        'ws'        => (string)($s['ws'] ?? ''),
        'mode'      => in_array($s['mode'] ?? '', ['project', 'chat', 'self'], true) ? $s['mode'] : 'project',
        'created'   => (int)($s['created'] ?? 0),
        'updated'   => (int)($s['updated'] ?? 0),
        'msg_count' => count($msgs),
        'tokens'    => $tok,
        'model'     => (string)($s['model'] ?? ''),
        'parent'    => (string)($s['parent'] ?? ''),
        'pinned'    => !empty($s['pinned']) ? 1 : 0,
        'pinnedAt'  => (int)($s['pinnedAt'] ?? 0),
        'extraRootsCount' => oc_sess_extra_count($s),
    ];
}

// GET list — 依 updated 新→舊

// ─── 會話 meta 索引（list / search 加速）─────────────────────────
// 學 Hermes 的 FTS 思路，但 PHP 只有 json、沒有 pdo/sqlite 能用 ——
// 退一步做「meta 索引快取」：data/sessions/.index.json 存每檔的
// {mtime, size, meta{title,ws,mode,updated,msg_count,tokens,model}}。
// list 命中索引就不用逐檔 json_decode；search 用索引先做 cheap filter
// （ws 不合、字數太少直接跳過），只讀候選檔。
// 索引是純衍生快取：mtime/size 對不上就視為失效重讀；檔被刪了就清掉。
// 並發寫用 LOCK_EX + 讀後驗證，壞了就地重建 —— 索引永遠可以整份丟掉重長。
function oc_sess_index_file() {
    return OC_SESSIONS . '/.index.json';
}

function oc_sess_index_load() {
    $idx = oc_read_json(oc_sess_index_file(), null);
    if (!is_array($idx) || !isset($idx['entries']) || !is_array($idx['entries'])) return ['entries' => []];
    return $idx;
}

// 掃描目錄，用索引加速：沒變的檔直接用快取的 meta，變了才重讀。
// 回傳 [metas(未排序), freshEntries(可寫回的完整索引), total]
function oc_sess_scan_metas() {
    $files = @glob(OC_SESSIONS . '/*.json');
    if (!is_array($files)) $files = [];
    $idx = oc_sess_index_load();
    $cache = $idx['entries'];
    $metas = [];
    $fresh = [];
    foreach ($files as $f) {
        $id = basename($f, '.json');
        if (!oc_valid_id($id)) continue;
        $mt = (int)@filemtime($f);
        $sz = (int)@filesize($f);
        $hit = $cache[$id] ?? null;
        if (is_array($hit) && ($hit['mtime'] ?? -1) === $mt && ($hit['size'] ?? -1) === $sz && isset($hit['meta'])) {
            $meta = $hit['meta'];
            // 舊索引快取沒有置頂欄位：命中時順手補上，免得新欄位上線後還要等檔案異動才出現
            if (!array_key_exists('pinned', $meta)) $meta['pinned'] = 0;
            if (!array_key_exists('pinnedAt', $meta)) $meta['pinnedAt'] = 0;
            $metas[] = $meta;
            $hit['meta'] = $meta;
            $fresh[$id] = $hit;
            continue;
        }
        $s = oc_read_json($f, null);
        if (!is_array($s)) continue;                         // 忽略毀損檔
        $meta = oc_sess_meta($s, $id);
        if ($meta['updated'] === 0) $meta['updated'] = $mt * 1000;
        $metas[] = $meta;
        $fresh[$id] = ['mtime' => $mt, 'size' => $sz, 'meta' => $meta];
    }
    return [$metas, $fresh, count($files)];
}

function oc_sess_index_store($fresh) {
    @file_put_contents(oc_sess_index_file(), oc_json_encode(['entries' => $fresh]), LOCK_EX);
}

// 單檔異動後更新索引（save / delete 成功後呼叫；失敗就當沒發生）
function oc_sess_index_touch($id, $file) {
    $idx = oc_sess_index_load();
    if (is_file($file)) {
        $s = oc_read_json($file, null);
        if (is_array($s)) {
            $meta = oc_sess_meta($s, $id);
            $mt = (int)@filemtime($file);
            if ($meta['updated'] === 0) $meta['updated'] = $mt * 1000;
            $idx['entries'][$id] = ['mtime' => $mt, 'size' => (int)@filesize($file), 'meta' => $meta];
        }
    } else {
        unset($idx['entries'][$id]);
    }
    oc_sess_index_store($idx['entries']);
}

// ─── 跨會話全文搜尋 ─────────────────────────────────────────────
// 「我上次那個 bug 是在哪個會話修的？」—— 本機規模（幾百個 100KB JSON）
// 線性掃描就夠了，不需要索引。搜文字塊、工具參數與工具結果；圖片跳過。
function oc_sess_search() {
    $q = trim((string)oc_arg('q', ''));
    if ($q === '' || mb_strlen($q) < 2) oc_fail('搜尋字串至少 2 個字元', 400);
    $ws    = (string)oc_arg('ws', '');
    $limit = oc_int('limit', 30);
    if ($limit < 1)   $limit = 1;
    if ($limit > 100) $limit = 100;

    // 先拿 meta（走索引快取）：ws 不合的連檔都不必讀
    list($metas) = oc_sess_scan_metas();
    usort($metas, function ($a, $b) { return $b['updated'] <=> $a['updated']; });

    $out = [];
    $budgetEnd = microtime(true) + 8.0;      // 時間預算，幾千個會話也不會掛住
    foreach ($metas as $meta) {
        if (count($out) >= $limit || microtime(true) > $budgetEnd) break;
        if ($ws !== '' && (string)($meta['ws'] ?? '') !== $ws) continue;
        if (($meta['msg_count'] ?? 0) <= 0) continue;
        $id = (string)($meta['id'] ?? '');
        if (!oc_valid_id($id)) continue;
        $f = OC_SESSIONS . '/' . $id . '.json';
        if (!is_file($f)) continue;
        $s = oc_read_json($f, null);
        if (!is_array($s)) continue;

        $hits = [];
        foreach (($s['messages'] ?? []) as $mi => $m) {
            if (count($hits) >= 3) break;                 // 每個會話最多回報 3 個命中
            foreach ((is_array($m['content'] ?? null) ? $m['content'] : []) as $b) {
                $txt = '';
                $bt = (string)($b['type'] ?? '');
                if ($bt === 'text' || $bt === 'thinking') $txt = (string)($b['text'] ?? '');
                elseif ($bt === 'tool_use') $txt = json_encode($b['input'] ?? [], JSON_UNESCAPED_UNICODE);
                elseif ($bt === 'tool_result') $txt = is_string($b['content'] ?? null) ? $b['content'] : json_encode($b['content'] ?? '', JSON_UNESCAPED_UNICODE);
                if ($txt === '') continue;
                $pos = mb_stripos($txt, $q);
                if ($pos === false) continue;
                $from = max(0, $pos - 60);
                $hits[] = [
                    'msg'     => $mi,
                    'role'    => (string)($m['role'] ?? ''),
                    'snippet' => ($from > 0 ? '…' : '') . mb_substr($txt, $from, 160) . '…',
                ];
                break;                                    // 一則訊息回報一個命中就夠
            }
        }
        if ($hits) {
            $meta = oc_sess_meta($s, $id);
            $meta['hits'] = $hits;
            $out[] = $meta;
        }
    }
    oc_ok(['results' => $out, 'query' => $q]);
}

function oc_sess_list() {
    $limit = oc_int('limit', 60);
    if ($limit < 1)    $limit = 1;
    if ($limit > 1000) $limit = 1000;

    list($metas, $fresh, $total) = oc_sess_scan_metas();
    // 掃描時順手把失效條目清掉（被刪的檔不會出現在 glob 結果裡）
    oc_sess_index_store($fresh);

    usort($metas, function ($a, $b) { return $b['updated'] <=> $a['updated']; });
    if (count($metas) > $limit) $metas = array_slice($metas, 0, $limit);

    oc_ok(['sessions' => $metas, 'total' => $total]);
}

// GET get — 完整會話
function oc_sess_get() {
    $id   = oc_arg('id', '');
    $file = oc_sess_file($id);
    if (!is_file($file)) oc_fail('找不到會話：' . $id, 404);
    $s = oc_read_json($file, null);
    if (!is_array($s)) oc_fail('會話檔案毀損，無法解析：' . $id, 500, $file);
    oc_ok(['session' => $s]);
}

// POST save — {id, session}
function oc_sess_save() {
    $sess = oc_arg('session', null);
    if (!is_array($sess)) oc_fail('缺少 session 內容（需為物件）', 400);

    $id = oc_arg('id', '');
    if ($id === '' || $id === null) $id = $sess['id'] ?? '';
    $file = oc_sess_file($id);

    // created 保留既有值；沒有就以現在時間補上
    $now  = oc_sess_now();
    $prev = is_file($file) ? oc_read_json($file, []) : [];
    $created = 0;
    if (isset($sess['created']) && is_numeric($sess['created']) && (int)$sess['created'] > 0) {
        $created = (int)$sess['created'];
    } elseif (isset($prev['created']) && is_numeric($prev['created']) && (int)$prev['created'] > 0) {
        $created = (int)$prev['created'];
    } else {
        $created = $now;
    }

    $sess['id']      = (string)$id;
    $sess['created'] = $created;
    $sess['updated'] = $now;
    if (!isset($sess['ws']) || $sess['ws'] === '') $sess['ws'] = oc_ws();
    if (!isset($sess['title']) || $sess['title'] === '') $sess['title'] = '未命名會話';
    if (!in_array($sess['mode'] ?? '', ['project', 'chat', 'self'], true)) $sess['mode'] = 'project';
    if (!isset($sess['messages']) || !is_array($sess['messages'])) $sess['messages'] = [];
    // 額外工作資料夾：只收 [{alias, path}]，清洗後存放（上限截斷）。
    // 不存在的目錄不擋存檔（下次掛載驗證／sync 時會丟掉），舊存檔沒有此鍵則維持空陣列。
    if (isset($sess['extraRoots']) && is_array($sess['extraRoots'])) {
        $clean = [];
        foreach ($sess['extraRoots'] as $it) {
            if (!is_array($it)) continue;
            $alias = trim((string)($it['alias'] ?? ''));
            $path  = oc_norm_slashes(trim((string)($it['path'] ?? '')));
            if (!preg_match('/^[A-Za-z0-9_-]{1,32}$/', $alias) || $path === '') continue;
            $dup = false;
            foreach ($clean as $c) {
                if (strcasecmp($c['alias'], $alias) === 0 || strcasecmp($c['path'], $path) === 0) { $dup = true; break; }
            }
            if (!$dup) $clean[] = ['alias' => $alias, 'path' => $path];
            if (count($clean) >= OC_EXTRA_ROOTS_MAX) break;
        }
        $sess['extraRoots'] = $clean;
    } else {
        $sess['extraRoots'] = [];
    }

    if (!oc_write_json($file, $sess)) {
        oc_fail('無法寫入會話存檔', 500, $file);
    }
    oc_sess_index_touch($sess['id'], $file);

    oc_ok([
        'id'      => $sess['id'],
        'updated' => $sess['updated'],
        'created' => $sess['created'],
        'path'    => 'data/sessions/' . $sess['id'] . '.json',
    ]);
}

// POST delete — {id}
function oc_sess_delete() {
    $id   = oc_arg('id', '');
    $file = oc_sess_file($id);
    if (!is_file($file)) oc_ok(['deleted' => false]);    // 重複刪除不視為錯誤
    if (!@unlink($file)) oc_fail('無法刪除會話檔案（可能被其他程序佔用）', 500, $file);
    oc_sess_index_touch($id, $file);                     // 檔已不在，touch 只做清除
    oc_ok(['deleted' => true]);
}

// POST rename — {id, title}：重新命名（只改標題，不動 updated 排序）
function oc_sess_rename() {
    $in = oc_input();
    $id = (string)($in['id'] ?? oc_arg('id', ''));
    $title = trim((string)($in['title'] ?? oc_arg('title', '')));
    if ($title === '') oc_fail('標題不能是空的', 400);
    if (function_exists('mb_strlen') ? mb_strlen($title, 'UTF-8') > 100 : strlen($title) > 300) {
        oc_fail('標題太長（最多 100 字）', 400);
    }
    $file = oc_sess_file($id);
    if (!is_file($file)) oc_fail('找不到會話：' . $id, 404);
    $s = oc_read_json($file, null);
    if (!is_array($s)) oc_fail('會話檔案毀損，無法解析：' . $id, 500, $file);
    $s['title'] = $title;
    if (!oc_write_json($file, $s)) {
        oc_fail('無法寫入會話存檔', 500, $file);
    }
    oc_sess_index_touch($id, $file);
    oc_ok(['id' => $id, 'title' => $title]);
}

// POST pin — {id, pinned:bool}：置頂／取消置頂（只改兩欄，不動 updated 排序）
function oc_sess_pin() {
    $in = oc_input();
    $id = (string)($in['id'] ?? oc_arg('id', ''));
    $file = oc_sess_file($id);
    if (!is_file($file)) oc_fail('找不到會話：' . $id, 404);
    $s = oc_read_json($file, null);
    if (!is_array($s)) oc_fail('會話檔案毀損，無法解析：' . $id, 500, $file);
    $pinned = array_key_exists('pinned', $in) ? oc_bool('pinned', false) : empty($s['pinned']);
    $s['pinned'] = $pinned ? true : false;
    $s['pinnedAt'] = $pinned ? oc_sess_now() : 0;
    if (!oc_write_json($file, $s)) {
        oc_fail('無法寫入會話存檔', 500, $file);
    }
    oc_sess_index_touch($id, $file);
    oc_ok(['id' => $id, 'pinned' => $pinned ? true : false]);
}

// POST export — {id, format:'md'|'json'}
function oc_sess_export() {
    $id     = oc_arg('id', '');
    $format = strtolower(trim((string)oc_arg('format', 'md')));
    if (!in_array($format, ['md', 'json'], true)) {
        oc_fail('不支援的匯出格式：' . $format . '（僅支援 md / json）', 400);
    }
    $file = oc_sess_file($id);
    if (!is_file($file)) oc_fail('找不到會話：' . $id, 404);
    $s = oc_read_json($file, null);
    if (!is_array($s)) oc_fail('會話檔案毀損，無法解析：' . $id, 500, $file);

    $slug = oc_sess_slug((string)($s['title'] ?? ''), $id);

    if ($format === 'json') {
        $flags = JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES;
        if (defined('JSON_INVALID_UTF8_SUBSTITUTE')) $flags |= JSON_INVALID_UTF8_SUBSTITUTE;
        $content = json_encode($s, $flags);
        if ($content === false) oc_fail('會話序列化失敗', 500, json_last_error_msg());
        oc_ok(['content' => $content, 'filename' => $slug . '.json', 'format' => 'json']);
    }

    oc_ok(['content' => oc_sess_markdown($s), 'filename' => $slug . '.md', 'format' => 'md']);
}

// 標題 → 檔名 slug（保留中英數字，其餘轉連字號）
function oc_sess_slug($title, $fallback) {
    $slug = preg_replace('/[^\p{L}\p{N}]+/u', '-', $title);
    $slug = trim((string)$slug, '-');
    if (function_exists('mb_substr')) $slug = mb_substr($slug, 0, 48, 'UTF-8');
    if ($slug === '') $slug = $fallback !== '' ? $fallback : 'session';
    return $slug . '-' . date('Ymd');
}

// 把訊息 content 正規化成 block 陣列
function oc_sess_blocks($content) {
    if (is_string($content)) return [['type' => 'text', 'text' => $content]];
    if (!is_array($content)) return [];
    $out = [];
    foreach ($content as $b) {
        if (is_string($b))      { $out[] = ['type' => 'text', 'text' => $b]; continue; }
        if (!is_array($b))      continue;
        if (!isset($b['type'])) $b['type'] = isset($b['text']) ? 'text' : 'unknown';
        $out[] = $b;
    }
    return $out;
}

// tool_result 的 content 可能是字串或 block 陣列 → 取純文字
function oc_sess_result_text($c) {
    if (is_string($c)) return $c;
    if (!is_array($c)) return oc_json_encode($c);
    $parts = [];
    foreach ($c as $b) {
        if (is_string($b)) { $parts[] = $b; continue; }
        if (is_array($b) && isset($b['text']) && is_string($b['text'])) { $parts[] = $b['text']; continue; }
        $parts[] = oc_json_encode($b);
    }
    return implode("\n", $parts);
}

// 依上限截斷（以字元計，保留 UTF-8 完整性）
function oc_sess_trunc($text, $max) {
    $text = (string)$text;
    $len  = function_exists('mb_strlen') ? mb_strlen($text, 'UTF-8') : strlen($text);
    if ($len <= $max) return $text;
    $cut = function_exists('mb_substr') ? mb_substr($text, 0, $max, 'UTF-8') : substr($text, 0, $max);
    return $cut . "\n…（已截斷，原文共 " . $len . " 字）";
}

// 產生可讀的繁體中文 Markdown 逐字稿
function oc_sess_markdown($s) {
    $L = [];
    $L[] = '# ' . (string)($s['title'] ?? '未命名會話');
    $L[] = '';
    $L[] = '- **工作區**：`' . (string)($s['ws'] ?? '—') . '`';
    $L[] = '- **模型**：' . (string)($s['model'] ?? '—');
    $L[] = '- **建立時間**：' . oc_sess_time($s['created'] ?? 0);
    $L[] = '- **更新時間**：' . oc_sess_time($s['updated'] ?? 0);

    $msgs = (isset($s['messages']) && is_array($s['messages'])) ? $s['messages'] : [];
    $L[]  = '- **訊息則數**：' . count($msgs);

    if (isset($s['usage']) && is_array($s['usage'])) {
        $u = $s['usage'];
        $L[] = '- **Token 用量**：輸入 ' . (int)($u['in'] ?? 0) . ' / 輸出 ' . (int)($u['out'] ?? 0)
             . (isset($u['cost']) ? '（約 US$' . number_format((float)$u['cost'], 4) . '）' : '');
    }
    if (!empty($s['files_touched']) && is_array($s['files_touched'])) {
        $L[] = '- **異動檔案**：' . implode('、', array_map('strval', $s['files_touched']));
    }
    $L[] = '';
    $L[] = '---';
    $L[] = '';

    foreach ($msgs as $m) {
        if (!is_array($m)) continue;
        $role   = (string)($m['role'] ?? 'user');
        $blocks = oc_sess_blocks($m['content'] ?? null);
        if (!$blocks) continue;

        // 判斷這則訊息是否有「使用者可見」的內容；純 tool_result 的 user 訊息不另開標題
        $visible = false;
        foreach ($blocks as $b) {
            if (in_array($b['type'], ['text', 'image', 'thinking'], true)) { $visible = true; break; }
        }

        if ($visible || $role === 'assistant') {
            if ($role === 'assistant')   $L[] = '## 🤖 Omni Code';
            elseif ($role === 'system')  $L[] = '## ⚙️ 系統';
            else                         $L[] = '## 👤 使用者';
            $L[] = '';
        }

        foreach ($blocks as $b) {
            $type = (string)$b['type'];

            if ($type === 'text') {
                $t = trim((string)($b['text'] ?? ''));
                if ($t !== '') { $L[] = $t; $L[] = ''; }

            } elseif ($type === 'thinking') {
                $t = trim((string)($b['text'] ?? ''));
                if ($t === '') continue;
                $L[] = '<details><summary>💭 思考過程</summary>';
                $L[] = '';
                $L[] = oc_sess_trunc($t, 2000);
                $L[] = '';
                $L[] = '</details>';
                $L[] = '';

            } elseif ($type === 'image') {
                $L[] = '> 🖼️ （圖片附件：' . (string)($b['mime'] ?? 'image') . '）';
                $L[] = '';

            } elseif ($type === 'tool_use') {
                $name  = (string)($b['name'] ?? 'unknown');
                $input = $b['input'] ?? new stdClass();
                $flags = JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES;
                if (defined('JSON_INVALID_UTF8_SUBSTITUTE')) $flags |= JSON_INVALID_UTF8_SUBSTITUTE;
                $json  = json_encode($input, $flags);
                if ($json === false) $json = '{}';
                $L[] = '**🔧 工具呼叫：`' . $name . '`**';
                $L[] = '';
                $L[] = '```json';
                $L[] = oc_sess_trunc($json, 2000);
                $L[] = '```';
                $L[] = '';

            } elseif ($type === 'tool_result') {
                $txt = oc_sess_trunc(oc_sess_result_text($b['content'] ?? ''), 2000);
                $err = !empty($b['is_error']);
                $L[] = '<details><summary>' . ($err ? '⚠️ 工具結果（錯誤）' : '工具結果') . '</summary>';
                $L[] = '';
                $L[] = '```';
                $L[] = $txt;
                $L[] = '```';
                $L[] = '';
                $L[] = '</details>';
                $L[] = '';
            }
        }
    }

    // 附錄：Todo 狀態
    if (!empty($s['todos']) && is_array($s['todos'])) {
        $L[] = '---';
        $L[] = '';
        $L[] = '## ✅ 待辦清單';
        $L[] = '';
        foreach ($s['todos'] as $t) {
            if (!is_array($t)) continue;
            $st  = (string)($t['status'] ?? 'pending');
            $box = $st === 'completed' ? '[x]' : ($st === 'in_progress' ? '[~]' : '[ ]');
            $L[] = '- ' . $box . ' ' . (string)($t['content'] ?? '');
        }
        $L[] = '';
    }

    $L[] = '---';
    $L[] = '';
    $L[] = '_由 Omni Code 匯出於 ' . date('Y-m-d H:i') . '_';

    return implode("\n", $L) . "\n";
}

// ═══════════════════════════════════════════════════════════════
// 記憶
// ═══════════════════════════════════════════════════════════════

// 檢查 scope；$allowAll=false 時不接受 'all'
function oc_mem_scope($allowAll = true) {
    $scope = strtolower(trim((string)oc_arg('scope', 'project')));
    if ($scope === '') $scope = 'project';
    $valid = $allowAll ? ['project', 'user', 'all'] : ['project', 'user'];
    if (!in_array($scope, $valid, true)) {
        oc_fail('不支援的記憶範疇：' . $scope . '（僅支援 ' . implode(' / ', $valid) . '）', 400);
    }
    return $scope;
}

// 記憶目錄絕對路徑
function oc_mem_dir($scope) {
    return $scope === 'user' ? OC_MEMORY : (oc_ws() . '/.omni/memory');
}

// 索引檔絕對路徑
function oc_mem_index_file($scope) {
    return $scope === 'user' ? (OC_MEMORY . '/MEMORY.md') : (oc_ws() . '/.omni/MEMORY.md');
}

// 顯示用的相對路徑
function oc_mem_disp($scope, $name) {
    return $scope === 'user' ? ('data/memory/' . $name . '.md') : ('.omni/memory/' . $name . '.md');
}

// 記憶檔絕對路徑：project 範疇一律經 oc_path() 做越界檢查
function oc_mem_file($scope, $name) {
    if ($scope === 'user') return OC_MEMORY . '/' . $name . '.md';
    return oc_path('.omni/memory/' . $name . '.md');
}

// name → ^[a-z0-9-]{1,64}$（小寫、空白轉 '-'、其餘字元剔除）
function oc_mem_slug($raw) {
    $s = strtolower(trim((string)$raw));
    $s = preg_replace('/\.md$/', '', $s);
    $s = preg_replace('/[\s_]+/', '-', $s);
    $s = preg_replace('/[^a-z0-9\-]/', '', $s);
    $s = preg_replace('/-+/', '-', $s);
    $s = trim((string)$s, '-');
    if (strlen($s) > 64) $s = rtrim(substr($s, 0, 64), '-');
    return $s;
}

// 極簡 YAML frontmatter 解析：--- \n key: value… \n --- \n 內文
// 回傳 [meta(assoc), body(string)]
function oc_parse_frontmatter($raw) {
    $raw  = (string)$raw;
    $raw  = preg_replace('/^\xEF\xBB\xBF/', '', $raw);   // 去 BOM
    $meta = [];
    if (!preg_match('/^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)/s', $raw, $m)) {
        return [$meta, ltrim($raw, "\r\n")];
    }
    $body = substr($raw, strlen($m[0]));
    foreach (oc_split_lines($m[1]) as $line) {
        $line = rtrim($line);
        $t    = ltrim($line);
        if ($t === '' || $t[0] === '#') continue;
        $p = strpos($t, ':');
        if ($p === false) continue;
        $k = strtolower(trim(substr($t, 0, $p)));
        $v = trim(substr($t, $p + 1));
        // 去掉成對引號
        $len = strlen($v);
        if ($len >= 2 && (($v[0] === '"' && $v[$len - 1] === '"') || ($v[0] === "'" && $v[$len - 1] === "'"))) {
            $v = substr($v, 1, -1);
        }
        if ($k !== '') $meta[$k] = $v;
    }
    return [$meta, ltrim($body, "\r\n")];
}

// 掃描單一範疇的所有記憶檔
function oc_mem_scan($scope) {
    $dir = oc_mem_dir($scope);
    if (!is_dir($dir)) return [];
    $files = @glob($dir . '/*.md');
    if (!is_array($files)) $files = [];

    $out = [];
    foreach ($files as $f) {
        $base = basename($f);
        if (strcasecmp($base, 'MEMORY.md') === 0) continue;     // 索引檔本身不列入
        $name = oc_mem_slug(pathinfo($base, PATHINFO_FILENAME));
        if ($name === '') continue;

        $raw = @file_get_contents($f);
        if ($raw === false) $raw = '';
        list($meta, $body) = oc_parse_frontmatter($raw);

        $desc = trim((string)($meta['description'] ?? ''));
        if ($desc === '') {
            // 沒有 description 就取內文第一行非空文字當摘要
            foreach (oc_split_lines($body) as $line) {
                $line = trim($line);
                if ($line === '' || $line[0] === '#') continue;
                $desc = function_exists('mb_substr') ? mb_substr($line, 0, 100, 'UTF-8') : substr($line, 0, 100);
                break;
            }
        }
        $updated = trim((string)($meta['updated'] ?? ''));
        if ($updated === '') $updated = date('Y-m-d', (int)@filemtime($f));

        // 內文規模與預覽：面板不用再逐筆 memory_get 就能讓使用者判斷「這則值不值得點開」
        $bodyText = trim(preg_replace('/\s+/', ' ', strip_tags($body)));
        $chars = function_exists('mb_strlen') ? mb_strlen($bodyText, 'UTF-8') : strlen($bodyText);
        $preview = $chars > 90
            ? (function_exists('mb_substr') ? mb_substr($bodyText, 0, 90, 'UTF-8') : substr($bodyText, 0, 90)) . '…'
            : $bodyText;

        // 一律以檔名為準（索引連結與 memory_get 的查找都靠它），
        // frontmatter 的 name 只在標題不一致時附帶回報。
        $out[] = [
            'name'        => $name,
            'description' => $desc,
            'type'        => trim((string)($meta['type'] ?? '')) !== '' ? (string)$meta['type'] : ($scope === 'user' ? 'user' : 'project'),
            'scope'       => $scope,
            'path'        => oc_mem_disp($scope, $name),
            'updated'     => $updated,
            'chars'       => $chars,
            'preview'     => $preview,
        ];
    }

    usort($out, function ($a, $b) { return strcmp($a['name'], $b['name']); });
    return $out;
}

// 重建索引 MEMORY.md（每次 save / delete 後自動維護）
function oc_mem_rebuild_index($scope) {
    if ($scope === 'all') { oc_mem_rebuild_index('project'); oc_mem_rebuild_index('user'); return; }

    $items = oc_mem_scan($scope);
    $file  = oc_mem_index_file($scope);
    // project 的索引位於 .omni/MEMORY.md，記憶檔在 .omni/memory/，連結需加前綴
    $prefix = $scope === 'user' ? '' : 'memory/';

    $L = [];
    $L[] = '# 記憶索引';
    $L[] = '';
    $L[] = '> 由 Omni Code 自動維護（' . ($scope === 'user' ? '使用者層級 · 跨專案' : '專案層級') . '）。';
    $L[] = '> 完整內文請以 `read_memory` 工具讀取，勿手動編輯本檔。';
    $L[] = '';
    if (!$items) {
        $L[] = '_（目前沒有任何記憶）_';
    } else {
        foreach ($items as $it) {
            $desc = $it['description'] !== '' ? $it['description'] : '（無描述）';
            $L[] = '- [' . $it['name'] . '](' . $prefix . $it['name'] . '.md) — ' . $desc;
        }
    }
    $L[] = '';

    $dir = dirname($file);
    if (!is_dir($dir)) @mkdir($dir, 0777, true);
    @file_put_contents($file, implode("\n", $L) . "\n", LOCK_EX);
}

// GET memory_list
function oc_mem_list() {
    $scope  = oc_mem_scope(true);
    $scopes = $scope === 'all' ? ['project', 'user'] : [$scope];

    $memories = [];
    foreach ($scopes as $sc) {
        foreach (oc_mem_scan($sc) as $it) $memories[] = $it;
    }

    // 索引內容（scope=all 時兩份串接）
    $chunks = [];
    foreach ($scopes as $sc) {
        $f = oc_mem_index_file($sc);
        if (!is_file($f)) continue;
        $c = @file_get_contents($f);
        if ($c === false || trim($c) === '') continue;
        $chunks[] = count($scopes) > 1
            ? ('<!-- ' . ($sc === 'user' ? '使用者層級' : '專案層級') . " -->\n" . $c)
            : $c;
    }

    oc_ok([
        'memories' => $memories,
        'index'    => implode("\n\n", $chunks),
        'scope'    => $scope,
    ]);
}

// GET memory_get — {scope, name}
function oc_mem_get() {
    $scope = oc_mem_scope(true);
    $name  = oc_mem_slug(oc_arg('name', ''));
    if ($name === '') oc_fail('記憶名稱不可為空（僅允許小寫英數字與連字號）', 400);

    $scopes = $scope === 'all' ? ['project', 'user'] : [$scope];
    foreach ($scopes as $sc) {
        $file = oc_mem_file($sc, $name);
        if (!is_file($file)) continue;
        $raw = @file_get_contents($file);
        if ($raw === false) oc_fail('無法讀取記憶檔案：' . $name, 500, $file);
        list($meta, $body) = oc_parse_frontmatter($raw);
        oc_ok([
            'content' => $raw,
            'body'    => $body,
            'meta'    => $meta ? $meta : new stdClass(),
            'name'    => $name,
            'scope'   => $sc,
            'path'    => oc_mem_disp($sc, $name),
        ]);
    }
    oc_fail('找不到記憶：' . $name, 404);
}

// POST memory_save — {scope, name, content}

// ═══════════════════════════════════════════════════════════════
// 工具錯誤記憶（建議 #2）
// ═══════════════════════════════════════════════════════════════
// failStreak 只在單次執行內計數，換個會話同一個坑會再踩一次，
// 而且踩法一模一樣。這裡把「症狀 → 原因 → 對策」存成可搜尋的紀錄。
//
// 雜湊前一定要正規化症狀：絕對路徑、數字串、execTool 附加的耗時
// 都會讓同一個錯誤每次雜湊到不同的檔，那樣就永遠命中不了自己。
// 90 天 TTL 在讀取時判定 —— 不需要清理常駐行程。

function oc_errmem_dir() {
    $d = OC_MEMORY . '/errors';
    if (!is_dir($d)) @mkdir($d, 0777, true);
    return $d;
}

function oc_errmem_norm($s) {
    $s = (string)$s;
    $s = preg_replace("#[A-Za-z]:[\\/][^\\s]*#", "<path>", $s);   // Windows 絕對路徑
    $s = preg_replace('#/(?:[\w.-]+/){2,}[\w.-]*#', '<path>', $s);  // POSIX 深路徑
    $s = preg_replace('/\d{3,}/', '<n>', $s);                    // 長數字（行號、位元組、耗時）
    $s = preg_replace('/耗時 [\d.]+ ?ms/u', '', $s);
    $s = preg_replace('/\s+/u', ' ', $s);
    return trim(mb_strtolower($s, 'UTF-8'));
}

function oc_errmem_hash($tool, $symptom) {
    return substr(sha1($tool . '|' . oc_errmem_norm($symptom)), 0, 8);
}

function oc_errmem_search() {
    $q    = trim((string)oc_arg('query', ''));
    $tool = trim((string)oc_arg('tool', ''));
    $limit = max(1, min((int)oc_arg('limit', 4), 20));

    $out = [];
    $now = time();
    foreach (@glob(oc_errmem_dir() . '/*.json') ?: [] as $f) {
        $r = oc_read_json($f, null);
        if (!is_array($r)) continue;
        if (($now - (int)($r['ts'] ?? 0)) > 90 * 86400) continue;      // 過期不回，也不刪（讀取時判定就夠）
        if ($tool !== '' && ($r['tool'] ?? '') !== $tool) continue;

        $hay = mb_strtolower(($r['tool'] ?? '') . ' ' . implode(' ', $r['keywords'] ?? [])
             . ' ' . ($r['symptom'] ?? '') . ' ' . ($r['cause'] ?? ''), 'UTF-8');
        $hits = 0;
        if ($q !== '') {
            foreach (preg_split('/\s+/u', mb_strtolower($q, 'UTF-8')) as $w) {
                if ($w !== '' && mb_strpos($hay, $w) !== false) $hits++;
            }
            if ($hits === 0) continue;
        }
        $r['_hits'] = $hits;
        $out[] = $r;
    }
    usort($out, function ($a, $b) { return ($b['_hits'] <=> $a['_hits']) ?: (($b['ts'] ?? 0) <=> ($a['ts'] ?? 0)); });
    oc_ok(['errors' => array_slice($out, 0, $limit), 'total' => count($out)]);
}

function oc_errmem_write() {
    $in = oc_input();
    $tool    = trim((string)($in['tool'] ?? ''));
    $symptom = trim((string)($in['symptom'] ?? ''));
    if ($tool === '' || $symptom === '') oc_fail('errmem_write 需要 tool 與 symptom', 400);

    $hash = oc_errmem_hash($tool, $symptom);
    $rec = [
        'hash'     => $hash,
        'tool'     => $tool,
        'symptom'  => mb_substr($symptom, 0, 600),
        'cause'    => mb_substr(trim((string)($in['cause'] ?? '')), 0, 600),
        'action'   => mb_substr(trim((string)($in['action'] ?? '')), 0, 600),
        'outcome'  => in_array($in['outcome'] ?? '', ['resolved', 'failed', 'abandoned'], true)
                      ? $in['outcome'] : 'resolved',
        'keywords' => array_slice(array_filter(array_map('trim', (array)($in['keywords'] ?? []))), 0, 12),
        'ts'       => time(),
    ];
    if (!oc_write_json(oc_errmem_dir() . '/' . $hash . '.json', $rec)) {
        oc_fail('無法寫入錯誤記憶', 500);
    }
    oc_ok(['saved' => $hash]);
}

function oc_mem_save() {
    $scope = oc_mem_scope(false);
    $name  = oc_mem_slug(oc_arg('name', ''));
    if ($name === '') oc_fail('記憶名稱不合法（清洗後為空，請使用英數字與連字號）', 400, (string)oc_arg('name', ''));

    $content = oc_arg('content', '');
    if (!is_string($content)) $content = oc_json_encode($content);

    $file = oc_mem_file($scope, $name);
    $dir  = dirname($file);
    if (!is_dir($dir) && !@mkdir($dir, 0777, true)) {
        oc_fail('無法建立記憶目錄', 500, $dir);
    }
    if (@file_put_contents($file, $content, LOCK_EX) === false) {
        oc_fail('無法寫入記憶檔案：' . $name, 500, $file);
    }

    oc_mem_rebuild_index($scope);   // 自動維護索引

    oc_ok([
        'name'  => $name,
        'scope' => $scope,
        'path'  => oc_mem_disp($scope, $name),
        'size'  => strlen($content),
    ]);
}

// POST memory_delete — {scope, name}
function oc_mem_delete() {
    $scope = oc_mem_scope(false);
    $name  = oc_mem_slug(oc_arg('name', ''));
    if ($name === '') oc_fail('記憶名稱不可為空', 400);

    $file    = oc_mem_file($scope, $name);
    $deleted = false;
    if (is_file($file)) {
        if (!@unlink($file)) oc_fail('無法刪除記憶檔案：' . $name, 500, $file);
        $deleted = true;
    }
    oc_mem_rebuild_index($scope);

    oc_ok(['deleted' => $deleted, 'name' => $name, 'scope' => $scope]);
}

// GET omni_md — 讀工作區根的 OMNI.md（不存在也不算錯誤）
function oc_omni_md() {
    // 依序找專案指示檔。既有專案多半已經有 AGENTS.md（Codex 標準）
    // 或 CLAUDE.md，要求使用者改檔名才能用是沒必要的摩擦。
    // 全部都讀並合併，並標明各段來自哪個檔案 —— 有些專案同時放了兩份，
    // 只取第一個會漏掉內容。
    $candidates = ['OMNI.md', 'AGENTS.md', 'CLAUDE.md', '.omni/OMNI.md'];
    $found = [];
    foreach ($candidates as $rel) {
        $f = oc_path($rel);
        if (!is_file($f)) continue;
        $raw = @file_get_contents($f);
        if ($raw === false || trim($raw) === '') continue;
        $found[] = ['path' => $rel, 'content' => $raw, 'mtime' => (int)@filemtime($f), 'size' => strlen($raw)];
    }

    if (!$found) {
        oc_ok(['content' => '', 'path' => 'OMNI.md', 'exists' => false, 'sources' => []]);
    }

    if (count($found) === 1) {
        oc_ok([
            'content' => $found[0]['content'],
            'path'    => $found[0]['path'],
            'exists'  => true,
            'size'    => $found[0]['size'],
            'mtime'   => $found[0]['mtime'],
            'sources' => [$found[0]['path']],
        ]);
    }

    $parts = [];
    foreach ($found as $f) $parts[] = "───── 來自 {$f['path']} ─────\n{$f['content']}";
    $merged = implode("\n\n", $parts);
    oc_ok([
        'content' => $merged,
        'path'    => $found[0]['path'],
        'exists'  => true,
        'size'    => strlen($merged),
        'mtime'   => max(array_column($found, 'mtime')),
        'sources' => array_column($found, 'path'),
    ]);
}

// ═══════════════════════════════════════════════════════════════
// 技能（漸進式揭露：清單只給 name — description）
// ═══════════════════════════════════════════════════════════════

// allowed-tools: a, b  或  [a, b] → 陣列
function oc_skill_tools($raw) {
    $raw = trim((string)$raw);
    if ($raw === '') return [];
    $raw = trim($raw, "[]");
    $out = [];
    foreach (explode(',', $raw) as $t) {
        $t = trim($t, " \t\"'");
        if ($t !== '') $out[] = $t;
    }
    return $out;
}

// 掃描內建 + 專案技能；同名時專案覆蓋內建
function oc_skill_scan() {
    $sources = [
        ['scope' => 'builtin', 'dir' => OC_SKILLS,                    'disp' => 'skills'],
        ['scope' => 'project', 'dir' => oc_ws() . '/.omni/skills',    'disp' => '.omni/skills'],
    ];

    $map = [];   // lower(name) => entry（後掃描的專案技能覆蓋內建）
    foreach ($sources as $src) {
        if (!is_dir($src['dir'])) continue;
        $dirs = @glob($src['dir'] . '/*', GLOB_ONLYDIR);
        if (!is_array($dirs)) continue;
        foreach ($dirs as $d) {
            $d    = str_replace('\\', '/', $d);
            $slug = basename($d);
            if (oc_ignored($slug)) continue;
            $file = $d . '/SKILL.md';
            if (!is_file($file)) continue;

            $raw = @file_get_contents($file);
            if ($raw === false) $raw = '';
            list($meta, $body) = oc_parse_frontmatter($raw);

            $name = trim((string)($meta['name'] ?? ''));
            if ($name === '') $name = $slug;

            $map[strtolower($name)] = [
                'name'         => $name,
                'description'  => trim((string)($meta['description'] ?? '')),
                'vibe'         => trim((string)($meta['vibe'] ?? '')),
                'emoji'        => trim((string)($meta['emoji'] ?? '')),
                'color'        => trim((string)($meta['color'] ?? '')),
                'allowedTools' => oc_skill_tools($meta['allowed-tools'] ?? ($meta['allowed_tools'] ?? '')),
                'scope'        => $src['scope'],
                'path'         => $src['disp'] . '/' . $slug . '/SKILL.md',
                'abs'          => $file,
                'body'         => $body,
            ];
        }
    }

    $list = array_values($map);
    usort($list, function ($a, $b) { return strcmp($a['name'], $b['name']); });
    return $list;
}

// GET skills
function oc_skill_list() {
    $skills = [];
    foreach (oc_skill_scan() as $s) {
        $skills[] = [
            'name'         => $s['name'],
            'description'  => $s['description'],
            'vibe'         => $s['vibe'],
            'emoji'        => $s['emoji'],
            'color'        => $s['color'],
            'allowedTools' => $s['allowedTools'],
            'scope'        => $s['scope'],
            'path'         => $s['path'],
        ];
    }
    oc_ok(['skills' => $skills]);
}

// GET skill_get — {name}
function oc_skill_get() {
    $want = strtolower(trim((string)oc_arg('name', '')));
    if ($want === '') oc_fail('缺少 name 參數', 400);

    foreach (oc_skill_scan() as $s) {
        if (strtolower($s['name']) !== $want) continue;
        oc_ok([
            'name'         => $s['name'],
            'description'  => $s['description'],
            'vibe'         => $s['vibe'],
            'emoji'        => $s['emoji'],
            'color'        => $s['color'],
            'allowedTools' => $s['allowedTools'],
            'scope'        => $s['scope'],
            'path'         => $s['path'],
            'content'      => $s['body'],
        ]);
    }
    oc_fail('找不到技能：' . (string)oc_arg('name', ''), 404);
}

// ═══════════════════════════════════════════════════════════════
// 自訂子代理（.omni/agents/*.md）與自訂斜線指令（.omni/commands/*.md）
// ═══════════════════════════════════════════════════════════════
// 對標 Claude Code 的 .claude/agents 與 .claude/commands。
// 兩者都是「frontmatter 定義中繼資料 + 正文是提示」，
// 差別只在用途：agent 給 spawn_agent 用，command 給使用者打 / 用。

/** 掃描 .md 定義檔（agents / commands 共用） */
function oc_defs_scan($subdir) {
    $dir = oc_ws() . '/.omni/' . $subdir;
    if (!is_dir($dir)) return [];
    $files = @glob($dir . '/*.md');
    if (!is_array($files)) return [];

    $out = [];
    foreach ($files as $f) {
        $slug = pathinfo(basename($f), PATHINFO_FILENAME);
        // 名稱要能安全地當識別字用（會出現在工具參數與 / 指令裡）
        if (!preg_match('/^[A-Za-z0-9_-]{1,64}$/', $slug)) continue;

        $raw = @file_get_contents($f);
        if ($raw === false) $raw = '';
        list($meta, $body) = oc_parse_frontmatter($raw);

        $desc = trim((string)($meta['description'] ?? ''));
        if ($desc === '') {
            foreach (oc_split_lines($body) as $line) {
                $line = trim($line);
                if ($line === '' || $line[0] === '#') continue;
                $desc = function_exists('mb_substr') ? mb_substr($line, 0, 120, 'UTF-8') : substr($line, 0, 120);
                break;
            }
        }

        $out[] = [
            'name'        => $slug,
            'description' => $desc,
            'meta'        => $meta,
            'body'        => $body,
            'path'        => '.omni/' . $subdir . '/' . basename($f),
            'mtime'       => (int)@filemtime($f),
        ];
    }
    usort($out, function ($a, $b) { return strcmp($a['name'], $b['name']); });
    return $out;
}

// GET agents — 自訂子代理清單
function oc_agent_list() {
    $out = [];
    foreach (oc_defs_scan('agents') as $a) {
        $m = $a['meta'];
        $out[] = [
            'name'        => $a['name'],
            'description' => $a['description'],
            'tools'       => oc_skill_tools($m['tools'] ?? ''),          // 空 = 不限制
            'model'       => trim((string)($m['model'] ?? '')),
            'readonly'    => oc_defs_bool($m['readonly'] ?? null, true), // 預設唯讀，安全優先
            'maxTurns'    => (int)($m['max_turns'] ?? $m['maxTurns'] ?? 0),
            'path'        => $a['path'],
        ];
    }
    oc_ok(['agents' => $out]);
}

// GET agent_get — {name}：連正文（系統提示）一起回
function oc_agent_get() {
    $name = (string)oc_arg('name', '');
    foreach (oc_defs_scan('agents') as $a) {
        if (strcasecmp($a['name'], $name) !== 0) continue;
        $m = $a['meta'];
        oc_ok([
            'name'        => $a['name'],
            'description' => $a['description'],
            'prompt'      => $a['body'],
            'tools'       => oc_skill_tools($m['tools'] ?? ''),
            'model'       => trim((string)($m['model'] ?? '')),
            'readonly'    => oc_defs_bool($m['readonly'] ?? null, true),
            'maxTurns'    => (int)($m['max_turns'] ?? $m['maxTurns'] ?? 0),
            'path'        => $a['path'],
        ]);
    }
    oc_fail('找不到名為 ' . $name . ' 的自訂子代理', 404,
            '請確認 .omni/agents/' . $name . '.md 存在');
}

// GET commands — 自訂斜線指令清單（含正文，前端要拿來組提示）
function oc_command_list() {
    $out = [];
    foreach (oc_defs_scan('commands') as $c) {
        $m = $c['meta'];
        $out[] = [
            'name'        => $c['name'],
            'description' => $c['description'],
            'args'        => trim((string)($m['args'] ?? $m['argument-hint'] ?? '')),
            'model'       => trim((string)($m['model'] ?? '')),
            'prompt'      => $c['body'],
            'path'        => $c['path'],
        ];
    }
    oc_ok(['commands' => $out]);
}

/** frontmatter 的布林值（yes/true/1/on 視為真） */
function oc_defs_bool($v, $default = false) {
    if ($v === null || $v === '') return $default;
    if (is_bool($v)) return $v;
    return in_array(strtolower(trim((string)$v)), ['1', 'true', 'yes', 'on'], true);
}
