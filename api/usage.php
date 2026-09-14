<?php
require_once __DIR__ . '/../includes/helpers.php';
oc_boot();

// ═══════════════════════════════════════════════════════════════
// Omni Code — Token 流量與成本記錄
// ═══════════════════════════════════════════════════════════════
// 逐筆記錄每次 LLM／繪圖呼叫，供「流量面板」查詢與統計。
//
//   data/usage/YYYY-MM.jsonl   一行一筆，append-only
//
// 為什麼用 JSONL 按月分檔：
//   - append 是 O(1)，不必讀進整份再寫回（呼叫很頻繁）
//   - 查某段期間只需要讀那幾個月的檔，不會因為累積一年就變慢
//   - 一行壞掉不會毀掉整份資料（讀取時跳過該行即可）
//
// ★ 成本在「記錄當下」就算好並寫進去，不在查詢時算。
//   價格會被使用者改，歷史紀錄必須保留當時實際適用的價格，
//   否則改一次價格會讓過去所有帳目跟著變動 —— 那不叫紀錄，叫幻覺。
//   需要用新價格回頭重算時，有 recalc 這個明確的動作。
// ═══════════════════════════════════════════════════════════════

define('OC_USAGE_DIR', OC_DATA . '/usage');

$action = oc_arg('action', '');

switch ($action) {
    case 'record':  oc_usage_record();  break;
    case 'query':   oc_usage_query();   break;
    case 'list':    oc_usage_list();    break;
    case 'recalc':  oc_usage_recalc();  break;
    case 'clear':   oc_usage_clear();   break;
    case 'months':  oc_usage_months();  break;
    default:
        oc_fail('未知的 action：' . $action, 400,
                '可用：record / query / list / recalc / clear / months');
}

// ─── 檔案 ───────────────────────────────────────────────────────

function oc_usage_file($ms) {
    if (!is_dir(OC_USAGE_DIR)) @mkdir(OC_USAGE_DIR, 0777, true);
    return OC_USAGE_DIR . '/' . date('Y-m', (int)round($ms / 1000)) . '.jsonl';
}

/**
 * 涵蓋 [from,to] 的所有月份檔（由舊到新）。
 *
 * 不逐月往前走訪 —— 直接列出實際存在的檔案再依檔名篩選。
 * 逐月走訪需要一個迭代上限，而上限只要小於「from 到 to 的實際月數」
 * 就會靜默漏掉最近的資料（period=all 從 1970 起算就是這樣整個掃不到）。
 * 檔案數量本來就等於有資料的月份數，直接 glob 又快又不可能漏。
 */
function oc_usage_files($fromMs, $toMs) {
    $files = @glob(OC_USAGE_DIR . '/*.jsonl');
    if (!is_array($files)) return [];

    $fromKey = date('Y-m', (int)round(max(0, $fromMs) / 1000));
    $toKey   = date('Y-m', (int)round($toMs / 1000));

    $out = [];
    foreach ($files as $f) {
        $key = basename($f, '.jsonl');
        if (!preg_match('/^\d{4}-\d{2}$/', $key)) continue;
        // 字串比較對 YYYY-MM 正好等同時間順序
        if ($key < $fromKey || $key > $toKey) continue;
        $out[] = $f;
    }
    sort($out);
    return $out;
}

/** 最早一筆紀錄的時間（毫秒）；沒有資料回傳 0 */
function oc_usage_earliest() {
    $files = @glob(OC_USAGE_DIR . '/*.jsonl');
    if (!is_array($files) || !$files) return 0;
    sort($files);
    $fh = @fopen($files[0], 'r');
    if (!$fh) return 0;
    $min = 0;
    while (($line = fgets($fh)) !== false) {
        $r = json_decode(trim($line), true);
        if (!is_array($r) || !isset($r['ts'])) continue;
        $ts = (float)$r['ts'];
        if (!$min || $ts < $min) $min = $ts;
    }
    fclose($fh);
    return $min;
}

/** 逐行讀取並套用篩選；壞掉的行直接跳過，不讓一行毀掉整份查詢 */
function oc_usage_scan($fromMs, $toMs, $filter = null) {
    $rows = [];
    foreach (oc_usage_files($fromMs, $toMs) as $f) {
        $fh = @fopen($f, 'r');
        if (!$fh) continue;
        while (($line = fgets($fh)) !== false) {
            $line = trim($line);
            if ($line === '') continue;
            $r = json_decode($line, true);
            if (!is_array($r) || !isset($r['ts'])) continue;
            $ts = (float)$r['ts'];
            if ($ts < $fromMs || $ts > $toMs) continue;
            if ($filter && !$filter($r)) continue;
            $rows[] = $r;
        }
        fclose($fh);
    }
    return $rows;
}

// ─── record ─────────────────────────────────────────────────────

function oc_usage_record() {
    $in = oc_input();

    $ts = isset($in['ts']) && is_numeric($in['ts'])
        ? (float)$in['ts']
        : round(microtime(true) * 1000);

    $tin   = max(0, (int)($in['in'] ?? 0));
    $tout  = max(0, (int)($in['out'] ?? 0));
    $cr    = max(0, (int)($in['cache_read'] ?? 0));
    $cw    = max(0, (int)($in['cache_write'] ?? 0));
    $rateI = isset($in['rate_in'])  && is_numeric($in['rate_in'])  ? (float)$in['rate_in']  : null;
    $rateO = isset($in['rate_out']) && is_numeric($in['rate_out']) ? (float)$in['rate_out'] : null;
    $images = max(0, (int)($in['images'] ?? 0));
    $rateImg = isset($in['rate_image']) && is_numeric($in['rate_image']) ? (float)$in['rate_image'] : null;

    $rec = [
        'ts'       => $ts,
        'model'    => mb_substr(trim((string)($in['model'] ?? '')), 0, 100),
        'provider' => mb_substr(trim((string)($in['provider'] ?? '')), 0, 40),
        'in'       => $tin,
        'out'      => $tout,
        'cache_read'  => $cr,
        'cache_write' => $cw,
        'images'   => $images,
        'ms'       => max(0, (int)($in['ms'] ?? 0)),
        'purpose'  => mb_substr(trim((string)($in['purpose'] ?? 'agent')), 0, 30),
        'session'  => mb_substr(trim((string)($in['session'] ?? '')), 0, 80),
        'ws'       => oc_ws(),
        'ok'       => !isset($in['ok']) || !!$in['ok'],
    ];
    if (!empty($in['error'])) $rec['error'] = mb_substr((string)$in['error'], 0, 200);

    // 價格已知才寫成本；未知就留 null，面板顯示「未設定價格」而不是 0 元
    $rec['rate_in']  = $rateI;
    $rec['rate_out'] = $rateO;
    $rec['rate_image'] = $rateImg;
    $rec['cost'] = oc_usage_cost($rec);

    $line = oc_json_encode($rec);
    $f = oc_usage_file($ts);
    if (@file_put_contents($f, $line . "\n", FILE_APPEND | LOCK_EX) === false) {
        oc_fail('無法寫入用量紀錄', 500, $f);
    }
    oc_ok(['recorded' => true, 'cost' => $rec['cost'], 'file' => basename($f)]);
}

/** 依紀錄自身的費率算成本；沒有費率回傳 null（代表「未知」，不是 0） */
function oc_usage_cost(array $r) {
    $has = false;
    $c = 0.0;
    if (isset($r['rate_in']) && $r['rate_in'] !== null) {
        // 費率單位是「USD / 1M tokens」
        $c += ((int)$r['in'] + (int)($r['cache_read'] ?? 0) + (int)($r['cache_write'] ?? 0))
              / 1000000 * (float)$r['rate_in'];
        $has = true;
    }
    if (isset($r['rate_out']) && $r['rate_out'] !== null) {
        $c += (int)$r['out'] / 1000000 * (float)$r['rate_out'];
        $has = true;
    }
    if (isset($r['rate_image']) && $r['rate_image'] !== null && !empty($r['images'])) {
        $c += (int)$r['images'] * (float)$r['rate_image'];
        $has = true;
    }
    return $has ? round($c, 6) : null;
}

// ─── query：彙總統計 ────────────────────────────────────────────

function oc_usage_query() {
    [$from, $to] = oc_usage_range();
    $rows = oc_usage_scan($from, $to);

    $total = ['calls' => 0, 'in' => 0, 'out' => 0, 'cache_read' => 0, 'cache_write' => 0,
              'images' => 0, 'ms' => 0, 'cost' => 0.0, 'unpriced' => 0, 'errors' => 0];
    $byModel = [];
    $byProvider = [];
    $byPurpose = [];
    $byDay = [];

    foreach ($rows as $r) {
        $total['calls']++;
        $total['in']  += (int)$r['in'];
        $total['out'] += (int)$r['out'];
        $total['cache_read']  += (int)($r['cache_read'] ?? 0);
        $total['cache_write'] += (int)($r['cache_write'] ?? 0);
        $total['images'] += (int)($r['images'] ?? 0);
        $total['ms'] += (int)($r['ms'] ?? 0);
        if (empty($r['ok'])) $total['errors']++;

        $cost = $r['cost'] ?? null;
        if ($cost === null) $total['unpriced']++;
        else $total['cost'] += (float)$cost;

        $m = $r['model'] !== '' ? $r['model'] : '(未知)';
        if (!isset($byModel[$m])) {
            $byModel[$m] = ['model' => $m, 'provider' => $r['provider'] ?? '',
                            'calls' => 0, 'in' => 0, 'out' => 0, 'images' => 0,
                            'cost' => 0.0, 'unpriced' => 0];
        }
        $byModel[$m]['calls']++;
        $byModel[$m]['in']  += (int)$r['in'];
        $byModel[$m]['out'] += (int)$r['out'];
        $byModel[$m]['images'] += (int)($r['images'] ?? 0);
        if ($cost === null) $byModel[$m]['unpriced']++;
        else $byModel[$m]['cost'] += (float)$cost;

        $p = $r['provider'] !== '' ? $r['provider'] : '(未知)';
        if (!isset($byProvider[$p])) $byProvider[$p] = ['provider' => $p, 'calls' => 0, 'in' => 0, 'out' => 0, 'cost' => 0.0];
        $byProvider[$p]['calls']++;
        $byProvider[$p]['in']  += (int)$r['in'];
        $byProvider[$p]['out'] += (int)$r['out'];
        if ($cost !== null) $byProvider[$p]['cost'] += (float)$cost;

        $pu = $r['purpose'] !== '' ? $r['purpose'] : 'agent';
        if (!isset($byPurpose[$pu])) $byPurpose[$pu] = ['purpose' => $pu, 'calls' => 0, 'in' => 0, 'out' => 0, 'cost' => 0.0];
        $byPurpose[$pu]['calls']++;
        $byPurpose[$pu]['in']  += (int)$r['in'];
        $byPurpose[$pu]['out'] += (int)$r['out'];
        if ($cost !== null) $byPurpose[$pu]['cost'] += (float)$cost;

        $d = date('Y-m-d', (int)round($r['ts'] / 1000));
        if (!isset($byDay[$d])) $byDay[$d] = ['day' => $d, 'calls' => 0, 'in' => 0, 'out' => 0, 'cost' => 0.0];
        $byDay[$d]['calls']++;
        $byDay[$d]['in']  += (int)$r['in'];
        $byDay[$d]['out'] += (int)$r['out'];
        if ($cost !== null) $byDay[$d]['cost'] += (float)$cost;
    }

    $total['cost'] = round($total['cost'], 6);
    foreach ($byModel as &$v)    { $v['cost'] = round($v['cost'], 6); } unset($v);
    foreach ($byProvider as &$v) { $v['cost'] = round($v['cost'], 6); } unset($v);
    foreach ($byPurpose as &$v)  { $v['cost'] = round($v['cost'], 6); } unset($v);
    foreach ($byDay as &$v)      { $v['cost'] = round($v['cost'], 6); } unset($v);

    $models = array_values($byModel);
    usort($models, function ($a, $b) { return ($b['in'] + $b['out']) <=> ($a['in'] + $a['out']); });

    // 每日補零：中間沒有呼叫的日子也要有點，趨勢圖才不會把兩週前後接在一起
    $days = [];
    $cursor = strtotime(date('Y-m-d', (int)round($from / 1000)));
    $endDay = strtotime(date('Y-m-d', (int)round($to / 1000)));
    $guard = 0;
    while ($cursor <= $endDay && $guard++ < 400) {
        $k = date('Y-m-d', $cursor);
        $days[] = $byDay[$k] ?? ['day' => $k, 'calls' => 0, 'in' => 0, 'out' => 0, 'cost' => 0.0];
        $cursor = strtotime('+1 day', $cursor);
    }

    oc_ok([
        'from' => $from, 'to' => $to,
        'total' => $total,
        'byModel' => $models,
        'byProvider' => array_values($byProvider),
        'byPurpose' => array_values($byPurpose),
        'byDay' => $days,
    ]);
}

// ─── list：逐筆明細（新→舊，可分頁）─────────────────────────────

function oc_usage_list() {
    [$from, $to] = oc_usage_range();
    $limit  = max(1, min(500, oc_int('limit', 100)));
    $offset = max(0, oc_int('offset', 0));
    $model  = trim((string)oc_arg('model', ''));
    $purpose= trim((string)oc_arg('purpose', ''));

    $rows = oc_usage_scan($from, $to, function ($r) use ($model, $purpose) {
        if ($model !== '' && ($r['model'] ?? '') !== $model) return false;
        if ($purpose !== '' && ($r['purpose'] ?? '') !== $purpose) return false;
        return true;
    });

    usort($rows, function ($a, $b) { return $b['ts'] <=> $a['ts']; });
    $totalRows = count($rows);
    $page = array_slice($rows, $offset, $limit);

    oc_ok(['records' => $page, 'total' => $totalRows, 'offset' => $offset, 'limit' => $limit]);
}

// ─── recalc：用新價格重算歷史成本 ───────────────────────────────
// 使用者事後才填價格時用。這是明確的動作，不會自動發生。

function oc_usage_recalc() {
    $in = oc_input();
    $rates = $in['rates'] ?? [];
    if (!is_array($rates)) oc_fail('rates 必須是物件：{ 模型ID: {in, out, image} }', 400);
    $onlyMissing = !empty($in['only_missing']);

    $files = @glob(OC_USAGE_DIR . '/*.jsonl') ?: [];
    $changed = 0; $scanned = 0;

    foreach ($files as $f) {
        $lines = @file($f, FILE_IGNORE_NEW_LINES);
        if (!is_array($lines)) continue;
        $out = [];
        $dirty = false;
        foreach ($lines as $line) {
            $line = trim($line);
            if ($line === '') continue;
            $r = json_decode($line, true);
            if (!is_array($r) || !isset($r['ts'])) { $out[] = $line; continue; }
            $scanned++;

            $m = $r['model'] ?? '';
            if (!isset($rates[$m])) { $out[] = oc_json_encode($r); continue; }
            if ($onlyMissing && ($r['cost'] ?? null) !== null) { $out[] = oc_json_encode($r); continue; }

            $rt = $rates[$m];
            $r['rate_in']    = isset($rt['in'])    && is_numeric($rt['in'])    ? (float)$rt['in']    : null;
            $r['rate_out']   = isset($rt['out'])   && is_numeric($rt['out'])   ? (float)$rt['out']   : null;
            $r['rate_image'] = isset($rt['image']) && is_numeric($rt['image']) ? (float)$rt['image'] : null;
            $new = oc_usage_cost($r);
            if ($new !== ($r['cost'] ?? null)) { $changed++; $dirty = true; }
            $r['cost'] = $new;
            $out[] = oc_json_encode($r);
        }
        if ($dirty) @file_put_contents($f, implode("\n", $out) . "\n", LOCK_EX);
    }

    oc_ok(['scanned' => $scanned, 'changed' => $changed]);
}

// ─── clear ──────────────────────────────────────────────────────

function oc_usage_clear() {
    $in = oc_input();
    $before = isset($in['before']) && is_numeric($in['before']) ? (float)$in['before'] : 0;

    if ($before <= 0) {
        // 全部清空
        $n = 0;
        foreach (@glob(OC_USAGE_DIR . '/*.jsonl') ?: [] as $f) { if (@unlink($f)) $n++; }
        oc_ok(['cleared' => 'all', 'files' => $n]);
    }

    $kept = 0; $removed = 0;
    foreach (@glob(OC_USAGE_DIR . '/*.jsonl') ?: [] as $f) {
        $lines = @file($f, FILE_IGNORE_NEW_LINES);
        if (!is_array($lines)) continue;
        $out = [];
        foreach ($lines as $line) {
            $line = trim($line);
            if ($line === '') continue;
            $r = json_decode($line, true);
            if (!is_array($r) || !isset($r['ts'])) continue;
            if ((float)$r['ts'] >= $before) { $out[] = $line; $kept++; }
            else $removed++;
        }
        if (!$out) @unlink($f);
        else @file_put_contents($f, implode("\n", $out) . "\n", LOCK_EX);
    }
    oc_ok(['kept' => $kept, 'removed' => $removed]);
}

// ─── months：有資料的月份（給「全部」範圍用）───────────────────

function oc_usage_months() {
    $out = [];
    foreach (@glob(OC_USAGE_DIR . '/*.jsonl') ?: [] as $f) {
        $out[] = ['month' => basename($f, '.jsonl'), 'size' => (int)@filesize($f)];
    }
    usort($out, function ($a, $b) { return strcmp($a['month'], $b['month']); });
    oc_ok(['months' => $out]);
}

// ─── 期間參數 ───────────────────────────────────────────────────
// period=24h|7d|15d|30d|90d|180d|365d|all，或直接給 from/to（毫秒）

function oc_usage_range() {
    $now = round(microtime(true) * 1000);

    $from = oc_arg('from', null);
    $to   = oc_arg('to', null);
    if (is_numeric($from) && is_numeric($to)) {
        return [(float)$from, (float)$to];
    }

    $period = strtolower(trim((string)oc_arg('period', '7d')));
    $map = [
        '24h' => 1, '7d' => 7, '15d' => 15, '30d' => 30,
        '90d' => 90, '180d' => 180, '365d' => 365,
    ];
    // 「全部」以最早一筆紀錄為起點，而不是 0。
    // 用 0 的話，byDay 會嘗試從 1970 逐日補零，被安全上限截斷後
    // 反而看不到最近的資料。
    if ($period === 'all') {
        $earliest = oc_usage_earliest();
        return [$earliest ?: ($now - 86400000), $now];
    }
    $days = $map[$period] ?? 7;
    // 24h 是「往前 24 小時」；其餘是「往前 N 天的當日 00:00 起」，
    // 這樣「7 天」看到的是完整 7 個日曆天，跟直覺一致
    if ($period === '24h') return [$now - 86400000, $now];
    $start = strtotime(date('Y-m-d', (int)round($now / 1000)) . ' 00:00:00') - ($days - 1) * 86400;
    return [$start * 1000, $now];
}
