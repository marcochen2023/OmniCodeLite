<?php
require_once __DIR__ . '/../includes/helpers.php';
// CLI（mcp-server.php）只是要 include 進來拿 oc_adr_dispatch()，
// 不該連帶送出 HTTP 標頭、也不該在檔尾自己跑一次請求（同 fs.php 模式）。
if (PHP_SAPI !== 'cli') oc_boot();

// ═══════════════════════════════════════════════════════════════
// Omni Code — api/adr.php（v1.5.0；架構決策紀錄 ADR）
// ═══════════════════════════════════════════════════════════════
// 取法 cbm 的 manage_adr 工具精神：跨會話保存「為什麼這樣設計」。
// 但 OmniCode 的語境是「自己會即時改自己」——ADR 跟 OMNI.md 互補：
//   OMNI.md 描述「現在怎樣」（指令、風格、注意事項）
//   ADR 描述「為什麼這樣」（已做的取捨，連同替代方案與取捨理由）
// 改了就回不去的決定才值得寫 ADR，否則只是 noise。
//
// 儲存：<ws>/.omni/adr/NNNN-slug.md
//   NNNN    = 4 位數流水號，自動遞增（從現有最大值+1；0 開頭保留）
//   slug    = 小寫英文+連字號
//   索引    = <ws>/.omni/adr/INDEX.md（每次 save 後自動維護）
//   列表用 grep：列出所有 .md 檔的標題與 status
//
// 為什麼不做為「記憶」的一種：記憶是個人層級、可改寫、可刪；
// ADR 是「這個決定是這樣定的」事實紀錄——sl 編號固定就是這個意圖。
// ═══════════════════════════════════════════════════════════════

define('OC_ADR_DIR',    '.omni/adr');
define('OC_ADR_INDEX',  '.omni/adr/INDEX.md');
define('OC_ADR_STATUS', ['proposed', 'accepted', 'deprecated', 'superseded']);

function oc_adr_dir_abs() {
    $ws = oc_ws();
    $d = $ws . '/' . OC_ADR_DIR;
    if (!is_dir($d)) @mkdir($d, 0777, true);
    return $d;
}

function oc_adr_index_abs() {
    return oc_ws() . '/' . OC_ADR_INDEX;
}

function oc_adr_slug($s) {
    $s = strtolower(trim((string)$s));
    $s = preg_replace('/[^a-z0-9\-]+/', '-', $s);
    $s = preg_replace('/-+/', '-', $s);
    return trim($s, '-');
}

// "0042-some-slug" → 42, "42" → 42, "abc" → 0
function oc_adr_num_from_id($id) {
    if (!preg_match('/^(\d{1,5})/', (string)$id, $m)) return 0;
    return (int)$m[1];
}

function oc_adr_next_num() {
    $d = oc_adr_dir_abs();
    $max = 0;
    foreach (@glob($d . '/*.md') ?: [] as $f) {
        $n = oc_adr_num_from_id(basename($f, '.md'));
        if ($n > $max) $max = $n;
    }
    return $max + 1;
}

function oc_adr_file($id) {
    $id = (string)$id;
    if (!preg_match('/^\d{4}-[a-z0-9][a-z0-9\-]*$/', $id)
        && !preg_match('/^\d{1,5}$/', $id)) {
        oc_fail('ADR 編號格式不正確：' . $id
              . '（應為 NNNN-slug，例如 0001-use-token-get-all；或只給數字 NNNN）', 400);
    }
    // 只給數字 → 嘗試找 NNNN-*.md
    if (ctype_digit($id)) {
        $id = str_pad($id, 4, '0', STR_PAD_LEFT);
        $d = oc_adr_dir_abs();
        $candidates = glob($d . '/' . $id . '-*.md') ?: [];
        if (!$candidates) oc_fail('找不到 ADR：' . $id, 404);
        return $candidates[0];
    }
    return oc_adr_dir_abs() . '/' . $id . '.md';
}

function oc_adr_parse($raw) {
    $raw = (string)$raw;
    $meta = [];
    $body = $raw;
    if (preg_match('/^---\s*\n(.*?)\n---\s*\n?(.*)$/s', $raw, $m)) {
        $body = $m[2];
        foreach (preg_split("/\r\n|\n|\r/", $m[1]) as $line) {
            if (!preg_match('/^([a-z_]+)\s*:\s*(.*)$/i', $line, $mm)) continue;
            $k = strtolower(trim($mm[1]));
            $v = trim($mm[2], " \t\"'");
            $meta[$k] = $v;
        }
    }
    return [$meta, $body];
}

function oc_adr_meta_to_frontmatter($meta) {
    $keys = ['id', 'title', 'status', 'date', 'deciders', 'tags', 'supersedes', 'superseded_by'];
    $L = ['---'];
    foreach ($keys as $k) {
        if (!isset($meta[$k]) || $meta[$k] === '') continue;
        $L[] = $k . ': ' . $meta[$k];
    }
    $L[] = '---';
    $L[] = '';
    return implode("\n", $L);
}

function oc_adr_status_emoji($s) {
    return [
        'proposed'   => '🟡',
        'accepted'   => '🟢',
        'deprecated' => '⚫',
        'superseded' => '🔵',
    ][strtolower((string)$s)] ?? '⚪';
}

// 重建索引
function oc_adr_rebuild_index() {
    $d = oc_adr_dir_abs();
    $files = @glob($d . '/*.md') ?: [];
    // 把 INDEX.md 排除（自己）
    $files = array_values(array_filter($files, function ($f) {
        return basename($f) !== 'INDEX.md';
    }));
    usort($files, function ($a, $b) {
        return strcmp(basename($a), basename($b));
    });

    $L = [];
    $L[] = '# 架構決策紀錄索引';
    $L[] = '';
    $L[] = '> 由 Omni Code 自動維護。新增 ADR 用 `manage_adr` 工具（`api/adr.php`），勿手動編輯本檔。';
    $L[] = '';
    if (!$files) {
        $L[] = '_（目前沒有任何 ADR）_';
    } else {
        $L[] = '| 編號 | 標題 | 狀態 | 日期 |';
        $L[] = '|------|------|------|------|';
        foreach ($files as $f) {
            $raw = @file_get_contents($f);
            if ($raw === false) continue;
            [$m, ] = oc_adr_parse($raw);
            $id    = $m['id'] ?? pathinfo($f, PATHINFO_FILENAME);
            $title = $m['title'] ?? '（無標題）';
            $st    = $m['status'] ?? 'proposed';
            $date  = $m['date'] ?? '';
            $L[] = '| ' . $id . ' | ' . $title . ' | ' . oc_adr_status_emoji($st) . ' ' . $st . ' | ' . $date . ' |';
        }
    }
    $L[] = '';
    $L[] = '## 撰寫約定';
    $L[] = '';
    $L[] = '每個 ADR 用 Markdown，frontmatter 帶 `id / title / status / date`，本文至少涵蓋：';
    $L[] = '';
    $L[] = '1. **Context（背景）**：當時面對什麼問題';
    $L[] = '2. **Decision（決定）**：選了什麼方案';
    $L[] = '3. **Alternatives Considered（替代方案）**：評估過哪些、為何不選';
    $L[] = '4. **Consequences（後果）**：採用後的權衡，包括後悔成本';
    $L[] = '';
    @file_put_contents(oc_adr_index_abs(), implode("\n", $L) . "\n", LOCK_EX);
}

function oc_adr_list() {
    $d = oc_adr_dir_abs();
    $files = @glob($d . '/*.md') ?: [];
    $files = array_values(array_filter($files, function ($f) {
        return basename($f) !== 'INDEX.md';
    }));
    usort($files, function ($a, $b) {
        return strcmp(basename($a), basename($b));
    });

    $out = [];
    foreach ($files as $f) {
        $raw = @file_get_contents($f);
        if ($raw === false) continue;
        [$m, $body] = oc_adr_parse($raw);
        $id    = $m['id'] ?? pathinfo($f, PATHINFO_FILENAME);
        $title = $m['title'] ?? '（無標題）';
        $st    = $m['status'] ?? 'proposed';
        // 取第一段非空行當摘要
        $summary = '';
        foreach (preg_split("/\r\n|\n|\r/", $body) as $line) {
            $line = trim($line);
            if ($line === '' || $line[0] === '#') continue;
            $summary = mb_substr($line, 0, 140, 'UTF-8');
            break;
        }
        $out[] = [
            'id'      => $id,
            'title'   => $title,
            'status'  => $st,
            'date'    => $m['date'] ?? '',
            'tags'    => $m['tags'] ?? '',
            'summary' => $summary,
            'path'    => OC_ADR_DIR . '/' . basename($f),
        ];
    }
    oc_ok(['adrs' => $out, 'count' => count($out),
           'next_id' => str_pad(oc_adr_next_num(), 4, '0', STR_PAD_LEFT)]);
}

function oc_adr_get() {
    $id = (string)oc_arg('id', '');
    if (trim($id) === '') oc_fail('缺少 id 參數', 400);
    $file = oc_adr_file($id);
    if (!is_file($file)) oc_fail('找不到 ADR：' . $id, 404);
    $raw = @file_get_contents($file);
    if ($raw === false) oc_fail('無法讀取：' . $id, 500, $file);
    [$m, $body] = oc_adr_parse($raw);
    oc_ok([
        'id'    => $m['id'] ?? basename($file, '.md'),
        'meta'  => $m ? $m : new stdClass(),
        'body'  => $body,
        'raw'   => $raw,
        'path'  => OC_ADR_DIR . '/' . basename($file),
    ]);
}

function oc_adr_save() {
    // 三種模式：
    //   新建：給 {title, body, status?, date?, tags?}
    //   改既有：給 {id, ...任意欄位}
    //   刪除：給 {id, _delete: true}
    $id      = (string)oc_arg('id', '');
    $title   = trim((string)oc_arg('title', ''));
    $body    = (string)oc_arg('body', '');
    $status  = strtolower(trim((string)oc_arg('status', 'accepted')));
    $date    = trim((string)oc_arg('date', date('Y-m-d')));
    $tags    = trim((string)oc_arg('tags', ''));
    $deciders= trim((string)oc_arg('deciders', ''));
    $supersedes     = trim((string)oc_arg('supersedes', ''));
    $supersededBy   = trim((string)oc_arg('superseded_by', ''));
    $delete  = oc_bool('_delete', false);

    if (!in_array($status, OC_ADR_STATUS, true)) {
        oc_fail('status 必須是：' . implode(' / ', OC_ADR_STATUS), 400, $status);
    }

    // 既有 ADR：update 或 delete
    if ($id !== '') {
        $file = oc_adr_file($id);
        if ($delete) {
            if (!is_file($file)) oc_fail('找不到 ADR：' . $id, 404);
            @unlink($file);
            oc_adr_rebuild_index();
            oc_ok(['deleted' => $id]);
        }
        $raw = @file_get_contents($file);
        if ($raw === false) oc_fail('找不到 ADR：' . $id, 404);
        [$m, $oldBody] = oc_adr_parse($raw);
        // 沒指定欄位就保留舊值
        $m['id']    = $m['id']    ?? basename($file, '.md');
        $m['title'] = $title !== '' ? $title : ($m['title'] ?? '（無標題）');
        $m['status']= $status;
        $m['date']  = $date;
        if ($tags !== '')      $m['tags'] = $tags;
        if ($deciders !== '')  $m['deciders'] = $deciders;
        if ($supersedes !== '') $m['supersedes'] = $supersedes;
        if ($supersededBy !== '') $m['superseded_by'] = $supersededBy;
        $newBody = $body !== '' ? $body : $oldBody;
        $out = oc_adr_meta_to_frontmatter($m) . "\n" . $newBody . "\n";
        @file_put_contents($file, $out, LOCK_EX);
        oc_adr_rebuild_index();
        oc_ok(['id' => $m['id'], 'updated' => true, 'path' => OC_ADR_DIR . '/' . basename($file)]);
    }

    // 新建
    if ($title === '') oc_fail('新建 ADR 必須給 title', 400);
    if ($body === '') oc_fail('新建 ADR 必須給 body（至少一段 context / decision）', 400);
    $num = oc_adr_next_num();
    $idNum = str_pad($num, 4, '0', STR_PAD_LEFT);
    $slugInput = trim((string)oc_arg('slug', ''));
    $slug = $slugInput !== '' ? oc_adr_slug($slugInput) : oc_adr_slug($title);
    if ($slug === '') $slug = 'decision';
    $fullId = $idNum . '-' . $slug;
    $file = oc_adr_dir_abs() . '/' . $fullId . '.md';

    $m = [
        'id'     => $fullId,
        'title'  => $title,
        'status' => $status,
        'date'   => $date,
    ];
    if ($tags !== '')     $m['tags'] = $tags;
    if ($deciders !== '') $m['deciders'] = $deciders;
    if ($supersedes !== '') $m['supersedes'] = $supersedes;
    if ($supersededBy !== '') $m['superseded_by'] = $supersededBy;

    $raw = oc_adr_meta_to_frontmatter($m) . "\n" . $body . "\n";
    @file_put_contents($file, $raw, LOCK_EX);
    oc_adr_rebuild_index();
    oc_ok(['id' => $fullId, 'created' => true, 'path' => OC_ADR_DIR . '/' . $fullId . '.md']);
}

function oc_adr_suggest() {
    // 給「下一個建議編號」+ 最近 5 筆做上下文
    $list = [];
    $d = oc_adr_dir_abs();
    $files = @glob($d . '/*.md') ?: [];
    $files = array_values(array_filter($files, function ($f) {
        return basename($f) !== 'INDEX.md';
    }));
    usort($files, function ($a, $b) {
        return strcmp(basename($b), basename($a));  // 新→舊
    });
    foreach (array_slice($files, 0, 5) as $f) {
        $raw = @file_get_contents($f);
        if ($raw === false) continue;
        [$m, ] = oc_adr_parse($raw);
        $list[] = [
            'id'    => $m['id'] ?? basename($f, '.md'),
            'title' => $m['title'] ?? '',
            'status'=> $m['status'] ?? 'proposed',
        ];
    }
    oc_ok([
        'next_id' => str_pad(oc_adr_next_num(), 4, '0', STR_PAD_LEFT),
        'recent'  => $list,
    ]);
}

function oc_adr_dispatch($action) {
    switch ($action) {
        case 'list':    oc_adr_list();    break;
        case 'get':     oc_adr_get();     break;
        case 'save':    oc_adr_save();    break;
        case 'suggest': oc_adr_suggest(); break;
        default:
            oc_fail('未知的 action: ' . $action, 404);
    }
}

if (PHP_SAPI !== 'cli') oc_adr_dispatch(oc_arg('action', ''));
