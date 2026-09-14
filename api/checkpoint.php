<?php
require_once __DIR__ . '/../includes/helpers.php';
oc_boot();

// ═══════════════════════════════════════════════════════════════
// Omni Code — 檔案檢查點與回溯
// ═══════════════════════════════════════════════════════════════
// 讓使用者敢放手讓 Agent 跑：任何一輪動過的檔案都能整批還原。
//
// 設計取捨：不做全工作區快照（大專案會慢到不可用），改成「寫入前捕捉」——
// 只有真正被動到的檔案才進檢查點，成本正比於改動量而非專案大小。
//
//   data/checkpoints/<session>/<cp_id>/manifest.json
//   data/checkpoints/<session>/<cp_id>/blobs/<sha1>.bin
//
// manifest.files 的每一項記錄該檔案「被動之前」的狀態：
//   existed → 有 blob，還原時寫回去
//   absent  → 當時不存在，還原時要刪掉（Agent 新建的檔案）
//
// bash 能做任何事，我們無從得知它碰了什麼。所以只記錄「這個檢查點跑過命令」，
// 還原時如實告訴使用者：命令造成的副作用（安裝套件、改資料庫）救不回來。
// 假裝能完整還原比不能還原更危險。
// ═══════════════════════════════════════════════════════════════

$action = oc_arg('action', '');

switch ($action) {
    case 'begin':   oc_cp_begin();   break;
    case 'capture': oc_cp_capture(); break;
    case 'note':    oc_cp_note();    break;
    case 'list':    oc_cp_list();    break;
    case 'get':     oc_cp_get();     break;
    case 'restore': oc_cp_restore(); break;
    case 'delete':  oc_cp_delete();  break;
    case 'prune':   oc_cp_prune();   break;
    default:
        oc_fail('未知的 action：' . $action, 400,
                '可用：begin / capture / note / list / get / restore / delete / prune');
}

// ─── 路徑 ───────────────────────────────────────────────────────

function oc_cp_root(): string {
    return oc_norm_slashes(dirname(__DIR__) . '/data/checkpoints');
}

function oc_cp_dir(string $session, string $cpId): string {
    return oc_cp_root() . '/' . $session . '/' . $cpId;
}

/** 會話 / 檢查點 id 都必須是安全字元，直接當資料夾名用 */
function oc_cp_valid(string $id): bool {
    return (bool)preg_match('/^[A-Za-z0-9_-]{1,80}$/', $id);
}

function oc_cp_need_ids(): array {
    $session = (string)oc_arg('session', '');
    $cpId    = (string)oc_arg('id', '');
    if (!oc_cp_valid($session)) oc_fail('session 無效', 400, 'got: ' . $session);
    if (!oc_cp_valid($cpId))    oc_fail('檢查點 id 無效', 400, 'got: ' . $cpId);
    return [$session, $cpId];
}

function oc_cp_manifest_path(string $session, string $cpId): string {
    return oc_cp_dir($session, $cpId) . '/manifest.json';
}

function oc_cp_load(string $session, string $cpId): array {
    $f = oc_cp_manifest_path($session, $cpId);
    if (!is_file($f)) oc_fail('檢查點不存在：' . $cpId, 404);
    $m = oc_read_json($f, null);
    if (!is_array($m)) oc_fail('檢查點資料損毀：' . $cpId, 500);
    return $m;
}

function oc_cp_save(string $session, string $cpId, array $m): void {
    $dir = oc_cp_dir($session, $cpId);
    if (!is_dir($dir)) @mkdir($dir, 0775, true);
    oc_write_json(oc_cp_manifest_path($session, $cpId), $m);
}

// ─── begin：開一個新檢查點 ──────────────────────────────────────

function oc_cp_begin(): void {
    $in      = oc_input();
    $session = (string)($in['session'] ?? '');
    if (!oc_cp_valid($session)) oc_fail('session 無效', 400, 'got: ' . $session);

    $cpId = 'cp_' . oc_id();
    $m = [
        'id'        => $cpId,
        'session'   => $session,
        'workspace' => oc_ws(),
        'label'     => mb_substr(trim((string)($in['label'] ?? '')), 0, 120),
        'created'   => round(microtime(true) * 1000),
        'files'     => new stdClass(),
        'commands'  => [],
        'restored'  => false,
    ];
    oc_cp_save($session, $cpId, $m);
    oc_cp_prune_session($session);
    oc_ok(['id' => $cpId, 'created' => $m['created']]);
}

// ─── capture：寫入前捕捉單一檔案的原始狀態 ──────────────────────

function oc_cp_capture(): void {
    $in = oc_input();
    $session = (string)($in['session'] ?? '');
    $cpId    = (string)($in['id'] ?? '');
    if (!oc_cp_valid($session)) oc_fail('session 無效', 400);
    if (!oc_cp_valid($cpId))    oc_fail('檢查點 id 無效', 400);

    $paths = $in['paths'] ?? [$in['path'] ?? ''];
    if (!is_array($paths)) $paths = [$paths];

    $m     = oc_cp_load($session, $cpId);
    $files = (array)$m['files'];
    $dir   = oc_cp_dir($session, $cpId);
    $blobs = $dir . '/blobs';

    $added = 0;
    foreach ($paths as $raw) {
        $rel = oc_clean_rel((string)$raw);
        if ($rel === '') continue;
        // 同一個檢查點內只捕捉第一次 —— 我們要的是「這一輪動手前」的狀態，
        // 後續覆蓋會把原始版本蓋掉，等於失去還原點。
        if (isset($files[$rel])) continue;

        $abs = oc_path($rel);   // 越界會在此處直接 fail

        if (is_dir($abs)) {
            // 目錄本身不存內容；還原時只在「原本不存在」的情況下才刪除空目錄
            $files[$rel] = ['state' => 'dir'];
            $added++;
            continue;
        }
        if (!is_file($abs)) {
            $files[$rel] = ['state' => 'absent'];
            $added++;
            continue;
        }

        $data = @file_get_contents($abs);
        if ($data === false) {
            $files[$rel] = ['state' => 'unreadable'];
            $added++;
            continue;
        }
        if (!is_dir($blobs)) @mkdir($blobs, 0775, true);
        $sha  = sha1($data);
        $blob = $blobs . '/' . $sha . '.bin';
        if (!is_file($blob)) @file_put_contents($blob, $data, LOCK_EX);

        $files[$rel] = [
            'state' => 'existed',
            'blob'  => $sha,
            'size'  => strlen($data),
            'mtime' => (int)(@filemtime($abs) * 1000),
        ];
        $added++;
    }

    $m['files'] = $files ?: new stdClass();
    oc_cp_save($session, $cpId, $m);
    oc_ok(['captured' => $added, 'total' => count($files)]);
}

// ─── note：記下這個檢查點跑過的命令（無法還原，但要誠實告知）───

function oc_cp_note(): void {
    $in = oc_input();
    $session = (string)($in['session'] ?? '');
    $cpId    = (string)($in['id'] ?? '');
    if (!oc_cp_valid($session) || !oc_cp_valid($cpId)) oc_fail('session 或 id 無效', 400);

    $m = oc_cp_load($session, $cpId);
    $cmds = (array)($m['commands'] ?? []);
    $cmd  = mb_substr(trim((string)($in['command'] ?? '')), 0, 300);
    if ($cmd !== '' && count($cmds) < 50) $cmds[] = $cmd;
    $m['commands'] = $cmds;
    oc_cp_save($session, $cpId, $m);
    oc_ok(['commands' => count($cmds)]);
}

// ─── list / get ────────────────────────────────────────────────

function oc_cp_list(): void {
    $session = (string)oc_arg('session', '');
    if (!oc_cp_valid($session)) oc_fail('session 無效', 400);

    $dir = oc_cp_root() . '/' . $session;
    $out = [];
    foreach (glob($dir . '/cp_*/manifest.json') ?: [] as $f) {
        $m = oc_read_json($f, null);
        if (!is_array($m)) continue;
        $files = (array)($m['files'] ?? []);
        $out[] = [
            'id'        => $m['id'] ?? basename(dirname($f)),
            'label'     => $m['label'] ?? '',
            'created'   => $m['created'] ?? 0,
            'workspace' => $m['workspace'] ?? '',
            'fileCount' => count($files),
            'files'     => array_slice(array_keys($files), 0, 12),
            'commands'  => count((array)($m['commands'] ?? [])),
            'restored'  => !empty($m['restored']),
        ];
    }
    usort($out, fn($a, $b) => ($b['created'] <=> $a['created']));
    oc_ok(['checkpoints' => $out]);
}

function oc_cp_get(): void {
    [$session, $cpId] = oc_cp_need_ids();
    $m = oc_cp_load($session, $cpId);
    $files = [];
    foreach ((array)($m['files'] ?? []) as $rel => $info) {
        $files[] = ['path' => $rel, 'state' => $info['state'] ?? '?', 'size' => $info['size'] ?? 0];
    }
    oc_ok([
        'id'       => $m['id'],
        'label'    => $m['label'] ?? '',
        'created'  => $m['created'] ?? 0,
        'files'    => $files,
        'commands' => (array)($m['commands'] ?? []),
        'restored' => !empty($m['restored']),
    ]);
}

// ─── restore：把捕捉過的檔案全部還原 ────────────────────────────

function oc_cp_restore(): void {
    $in      = oc_input();
    $session = (string)($in['session'] ?? '');
    $cpId    = (string)($in['id'] ?? '');
    if (!oc_cp_valid($session) || !oc_cp_valid($cpId)) oc_fail('session 或 id 無效', 400);

    $m = oc_cp_load($session, $cpId);

    // 工作區換過了就不能還原 —— 相對路徑會指到完全不同的檔案，
    // 硬還原等於拿舊專案的內容覆蓋新專案。
    $cpWs = oc_norm_slashes((string)($m['workspace'] ?? ''));
    $now  = oc_ws();
    if ($cpWs !== '' && strcasecmp($cpWs, $now) !== 0) {
        oc_fail('這個檢查點屬於另一個工作區，不能在目前工作區還原', 409,
                '檢查點：' . $cpWs . '｜目前：' . $now);
    }

    $dir      = oc_cp_dir($session, $cpId);
    $restored = [];
    $deleted  = [];
    $failed   = [];

    foreach ((array)($m['files'] ?? []) as $rel => $info) {
        $state = $info['state'] ?? '';
        try {
            $abs = oc_path((string)$rel);
        } catch (Throwable $e) {
            $failed[] = ['path' => $rel, 'error' => '路徑無效'];
            continue;
        }

        if ($state === 'existed') {
            $blob = $dir . '/blobs/' . ($info['blob'] ?? '') . '.bin';
            if (!is_file($blob)) { $failed[] = ['path' => $rel, 'error' => '備份內容遺失']; continue; }
            $data = @file_get_contents($blob);
            if ($data === false) { $failed[] = ['path' => $rel, 'error' => '備份讀取失敗']; continue; }
            $parent = dirname($abs);
            if (!is_dir($parent)) @mkdir($parent, 0775, true);
            if (@file_put_contents($abs, $data, LOCK_EX) === false) {
                $failed[] = ['path' => $rel, 'error' => '寫回失敗'];
                continue;
            }
            $restored[] = $rel;
        } elseif ($state === 'absent') {
            // 當時不存在 → Agent 新建的，刪掉才算還原
            if (is_file($abs)) {
                @unlink($abs) ? $deleted[] = $rel : $failed[] = ['path' => $rel, 'error' => '刪除失敗'];
            } elseif (is_dir($abs)) {
                @rmdir($abs) ? $deleted[] = $rel : $failed[] = ['path' => $rel, 'error' => '目錄非空，未刪除'];
            }
        }
        // dir / unreadable：不動它
    }

    $m['restored']   = true;
    $m['restoredAt'] = round(microtime(true) * 1000);
    oc_cp_save($session, $cpId, $m);

    oc_ok([
        'restored' => $restored,
        'deleted'  => $deleted,
        'failed'   => $failed,
        'commands' => (array)($m['commands'] ?? []),   // 前端據此警告命令副作用無法還原
    ]);
}

// ─── delete / prune ────────────────────────────────────────────

function oc_cp_delete(): void {
    $in      = oc_input();
    $session = (string)($in['session'] ?? '');
    $cpId    = (string)($in['id'] ?? '');
    if (!oc_cp_valid($session) || !oc_cp_valid($cpId)) oc_fail('session 或 id 無效', 400);
    oc_cp_rmdir(oc_cp_dir($session, $cpId));
    oc_ok(['deleted' => $cpId]);
}

function oc_cp_prune(): void {
    $in      = oc_input();
    $session = (string)($in['session'] ?? '');
    if (!oc_cp_valid($session)) oc_fail('session 無效', 400);
    $kept = oc_cp_prune_session($session, oc_int($in['keep'] ?? 30, 30));
    oc_ok(['kept' => $kept]);
}

/** 每個會話只保留最近 N 個檢查點，避免 data/ 無限膨脹 */
function oc_cp_prune_session(string $session, int $keep = 30): int {
    $dir  = oc_cp_root() . '/' . $session;
    $dirs = glob($dir . '/cp_*', GLOB_ONLYDIR) ?: [];
    if (count($dirs) <= $keep) return count($dirs);
    usort($dirs, fn($a, $b) => (@filemtime($b) <=> @filemtime($a)));
    foreach (array_slice($dirs, $keep) as $old) oc_cp_rmdir($old);
    return $keep;
}

function oc_cp_rmdir(string $dir): void {
    if (!is_dir($dir)) return;
    // 只允許刪 checkpoints 底下的東西 —— 這個函式會遞迴刪除，
    // 前綴檢查是防止傳入的路徑被動過手腳而刪到別處。
    $root = oc_cp_root();
    if (strncmp(oc_norm_slashes($dir), $root, strlen($root)) !== 0) return;
    foreach (scandir($dir) ?: [] as $e) {
        if ($e === '.' || $e === '..') continue;
        $p = $dir . '/' . $e;
        is_dir($p) ? oc_cp_rmdir($p) : @unlink($p);
    }
    @rmdir($dir);
}
