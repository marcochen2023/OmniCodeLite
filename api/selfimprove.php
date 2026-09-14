<?php
require_once __DIR__ . '/../includes/helpers.php';
oc_boot();

// ═══════════════════════════════════════════════════════════════
// Omni Code — 自我提升（self-improvement）歷程與版本規劃
// ═══════════════════════════════════════════════════════════════
// 「自我提升」模式讓 Agent 以 Omni Code 自己的原始碼為工作區，
// 透過對話改進自身功能。這支端點負責兩件事：
//
//   1. 歷程（history）：每一次自我提升做了什麼、動了哪些檔、屬於哪個版本。
//      Agent 用 selfimprove_log 工具寫入；前端在回合結束時也會兜底補記
//      （模型忘了記也不會漏）。
//   2. 版本規劃（roadmap）：語意化版本 + 各版本要做的項目清單。
//      版本號由這裡管：bump patch / minor / major。
//
// 全部存在 data/selfimprove/state.json，單一檔案、單一真相。
//
// ★ 為什麼不用 git 做版本：Omni Code 的安裝目錄不是 git repo（也不該假設
//   使用者裝了 git）。這裡的「版本」是產品層級的語意版本，不是 commit。
//   還原點（checkpoint）仍由既有的 /rewind 機制負責，兩者互補。
// ═══════════════════════════════════════════════════════════════

define('OC_SELF_DIR',   OC_DATA . '/selfimprove');
define('OC_SELF_STATE', OC_SELF_DIR . '/state.json');
const OC_SELF_MAX_HISTORY = 500;

function oc_self_default() {
    return [
        'version'  => '1.0.0',
        'history'  => [],
        'roadmap'  => [],
        'updated'  => 0,
    ];
}

function oc_self_load() {
    $s = oc_read_json(OC_SELF_STATE, null);
    if (!is_array($s)) $s = oc_self_default();
    if (!isset($s['version']) || !preg_match('/^\d+\.\d+\.\d+$/', (string)$s['version'])) $s['version'] = '1.0.0';
    if (!isset($s['history']) || !is_array($s['history'])) $s['history'] = [];
    if (!isset($s['roadmap']) || !is_array($s['roadmap'])) $s['roadmap'] = [];
    return $s;
}

function oc_self_save($s) {
    if (!is_dir(OC_SELF_DIR)) @mkdir(OC_SELF_DIR, 0777, true);
    $s['updated'] = (int)round(microtime(true) * 1000);
    if (!oc_write_json(OC_SELF_STATE, $s)) oc_fail('無法寫入 data/selfimprove/state.json', 500);
    return $s;
}

function oc_self_bump($ver, $kind) {
    [$a, $b, $c] = array_map('intval', explode('.', $ver));
    switch ($kind) {
        case 'major': return ($a + 1) . '.0.0';
        case 'minor': return $a . '.' . ($b + 1) . '.0';
        case 'patch': return $a . '.' . $b . '.' . ($c + 1);
        default:      return $ver;
    }
}

function oc_self_id($prefix) {
    return $prefix . '-' . base_convert((string)round(microtime(true) * 1000), 10, 36) . substr(bin2hex(random_bytes(2)), 0, 3);
}

// ─── get ────────────────────────────────────────────────────────
function oc_self_get() {
    $s = oc_self_load();
    $limit = oc_int('limit', 100);
    if ($limit < 1) $limit = 1;
    // history 新→舊
    $h = $s['history'];
    usort($h, function ($x, $y) { return ($y['at'] ?? 0) <=> ($x['at'] ?? 0); });
    $s['history'] = array_slice($h, 0, $limit);
    $s['history_total'] = count($h);
    $s['root'] = OC_ROOT;
    oc_ok(['state' => $s]);
}

// ─── log：新增一筆歷程 ──────────────────────────────────────────
// {title, summary, files[], session, bump: none|patch|minor|major, roadmapItem?}
function oc_self_log() {
    $title = trim((string)oc_arg('title', ''));
    if ($title === '') oc_fail('缺少 title', 400);
    $summary = trim((string)oc_arg('summary', ''));
    $files = oc_arg('files', []);
    if (!is_array($files)) $files = [];
    $files = array_values(array_unique(array_filter(array_map(function ($f) {
        return is_string($f) ? trim(str_replace('\\', '/', $f)) : '';
    }, $files))));
    $bump = strtolower((string)oc_arg('bump', 'none'));
    if (!in_array($bump, ['none', 'patch', 'minor', 'major'], true)) oc_fail('bump 必須是 none / patch / minor / major', 400);

    $s = oc_self_load();
    $prevVer = $s['version'];
    if ($bump !== 'none') $s['version'] = oc_self_bump($s['version'], $bump);

    $entry = [
        'id'       => oc_self_id('h'),
        'at'       => (int)round(microtime(true) * 1000),
        'version'  => $s['version'],
        'fromVersion' => $prevVer,
        'bump'     => $bump,
        'title'    => mb_substr($title, 0, 120),
        'summary'  => mb_substr($summary, 0, 4000),
        'files'    => array_slice($files, 0, 200),
        'session'  => (string)oc_arg('session', ''),
        'model'    => (string)oc_arg('model', ''),
        'auto'     => oc_bool('auto', false),          // 前端兜底補記（模型沒自己記）
        'status'   => 'done',
    ];
    // 同一個會話的「兜底補記」若已有模型自己記的項目，就合併檔案清單而不是重複一筆
    if ($entry['auto'] && $entry['session'] !== '') {
        foreach ($s['history'] as &$h) {
            if (($h['session'] ?? '') === $entry['session'] && empty($h['auto'])) {
                $h['files'] = array_values(array_unique(array_merge($h['files'] ?? [], $entry['files'])));
                unset($h);
                oc_self_save($s);
                oc_ok(['merged' => true, 'version' => $s['version']]);
            }
        }
        unset($h);
    }

    // 歷程可對應到 roadmap 項目 → 自動打勾
    $ri = (string)oc_arg('roadmapItem', '');
    if ($ri !== '') {
        foreach ($s['roadmap'] as &$r) {
            foreach ($r['items'] as &$it) {
                if (($it['id'] ?? '') === $ri) { $it['done'] = true; $it['doneAt'] = $entry['at']; $it['history'] = $entry['id']; }
            }
            unset($it);
        }
        unset($r);
    }

    $s['history'][] = $entry;
    if (count($s['history']) > OC_SELF_MAX_HISTORY) {
        $s['history'] = array_slice($s['history'], -OC_SELF_MAX_HISTORY);
    }
    oc_self_save($s);
    oc_ok(['entry' => $entry, 'version' => $s['version']]);
}

// ─── roadmap：版本規劃 ──────────────────────────────────────────
// op: add_version {version, title} | add_item {version, text} | toggle {id}
//     | remove_item {id} | remove_version {version} | set_status {version, status}
function oc_self_roadmap() {
    $op = (string)oc_arg('op', '');
    $s = oc_self_load();
    $now = (int)round(microtime(true) * 1000);

    $findVer = function (&$s, $v) {
        foreach ($s['roadmap'] as $i => $r) if (($r['version'] ?? '') === $v) return $i;
        return -1;
    };

    switch ($op) {
        case 'add_version': {
            $v = trim((string)oc_arg('version', ''));
            if (!preg_match('/^\d+\.\d+\.\d+$/', $v)) oc_fail('version 必須是 x.y.z', 400);
            if ($findVer($s, $v) >= 0) oc_fail('這個版本已經在規劃裡：' . $v, 400);
            $s['roadmap'][] = [
                'version' => $v,
                'title'   => mb_substr(trim((string)oc_arg('title', '')), 0, 120),
                'status'  => 'planned',       // planned | active | released
                'items'   => [],
                'created' => $now,
            ];
            // 依版本號排序
            usort($s['roadmap'], function ($a, $b) { return version_compare($a['version'], $b['version']); });
            break;
        }
        case 'add_item': {
            $v = trim((string)oc_arg('version', ''));
            $text = trim((string)oc_arg('text', ''));
            if ($text === '') oc_fail('缺少 text', 400);
            $i = $findVer($s, $v);
            if ($i < 0) {
                // 版本不存在就順手建立 —— Agent 規劃時不必先跑 add_version
                if (!preg_match('/^\d+\.\d+\.\d+$/', $v)) oc_fail('version 必須是 x.y.z', 400);
                $s['roadmap'][] = ['version' => $v, 'title' => '', 'status' => 'planned', 'items' => [], 'created' => $now];
                usort($s['roadmap'], function ($a, $b) { return version_compare($a['version'], $b['version']); });
                $i = $findVer($s, $v);
            }
            $s['roadmap'][$i]['items'][] = [
                'id' => oc_self_id('i'), 'text' => mb_substr($text, 0, 300), 'done' => false, 'created' => $now,
                'priority' => in_array(oc_arg('priority', 'normal'), ['high', 'normal', 'low'], true) ? oc_arg('priority') : 'normal',
            ];
            break;
        }
        case 'toggle':
        case 'remove_item': {
            $id = (string)oc_arg('id', '');
            $hit = false;
            foreach ($s['roadmap'] as &$r) {
                foreach ($r['items'] as $k => &$it) {
                    if (($it['id'] ?? '') !== $id) continue;
                    $hit = true;
                    if ($op === 'toggle') { $it['done'] = !$it['done']; $it['doneAt'] = $it['done'] ? $now : 0; }
                    else { unset($r['items'][$k]); $r['items'] = array_values($r['items']); }
                    break 2;
                }
                unset($it);
            }
            unset($r);
            if (!$hit) oc_fail('找不到項目：' . $id, 404);
            break;
        }
        case 'remove_version': {
            $v = trim((string)oc_arg('version', ''));
            $i = $findVer($s, $v);
            if ($i < 0) oc_fail('找不到版本：' . $v, 404);
            array_splice($s['roadmap'], $i, 1);
            break;
        }
        case 'set_status': {
            $v = trim((string)oc_arg('version', ''));
            $st = (string)oc_arg('status', '');
            if (!in_array($st, ['planned', 'active', 'released'], true)) oc_fail('status 必須是 planned / active / released', 400);
            $i = $findVer($s, $v);
            if ($i < 0) oc_fail('找不到版本：' . $v, 404);
            $s['roadmap'][$i]['status'] = $st;
            if ($st === 'released') {
                $s['roadmap'][$i]['releasedAt'] = $now;
                // 發布 = 目前版本號前進到它（只前進不後退）
                if (version_compare($v, $s['version']) > 0) $s['version'] = $v;
            }
            break;
        }
        default: oc_fail('未知的 op', 400);
    }
    oc_self_save($s);
    oc_ok(['roadmap' => $s['roadmap'], 'version' => $s['version']]);
}

// ─── set_version：手動指定版本（只允許前進）────────────────────
function oc_self_set_version() {
    $v = trim((string)oc_arg('version', ''));
    if (!preg_match('/^\d+\.\d+\.\d+$/', $v)) oc_fail('version 必須是 x.y.z', 400);
    $s = oc_self_load();
    if (version_compare($v, $s['version']) < 0) oc_fail('版本號只能前進：目前是 ' . $s['version'], 400);
    $s['version'] = $v;
    oc_self_save($s);
    oc_ok(['version' => $v]);
}

switch (oc_arg('action', '')) {
    case 'get':         oc_self_get();         break;
    case 'log':         oc_self_log();         break;
    case 'roadmap':     oc_self_roadmap();     break;
    case 'set_version': oc_self_set_version(); break;
    default: oc_fail('未知的 action', 404);
}
