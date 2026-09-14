<?php
require_once __DIR__ . '/../includes/helpers.php';
oc_boot();

// ═══════════════════════════════════════════════════════════════
// Omni Code — api/exec.php（命令執行；ARCHITECTURE.md §4）
// ═══════════════════════════════════════════════════════════════
// action:
//   run    POST {command, cwd, timeout}  → {stdout,stderr,exit_code,duration_ms,truncated,timed_out,cwd,command}
//   start  POST {command, cwd}           → {shell_id}
//   output GET  shell_id, since          → {chunk, offset, running, exit_code}
//   kill   POST {shell_id}               → {ok}
//   list   GET  —                        → {shells:[…]}
//
// 前景：proc_open，stdout/stderr 導向暫存檔後以 usleep(15ms) 輪詢追讀，
//       逾時 taskkill /T + proc_terminate。（Windows 的程序 pipe 不支援
//       非阻塞讀取，用 pipe 的話 fread 會擋到 EOF，逾時形同虛設。）
// 背景：把命令寫成 data/shells/<id>.bat（POSIX 為 .sh），以 start /b 卸離啟動，
//       全部輸出導向 <id>.log，結束時附加 __OC_DONE__:<code> 完成標記。
//       用批次檔可完全避開巢狀引號地獄（cmd 的引號規則極易踩雷）。
// ═══════════════════════════════════════════════════════════════

define('OC_DONE_MARK',    '__OC_DONE__');       // 背景命令完成標記
define('OC_SHELL_LOG_TTL', 3 * 86400);          // 日誌 / 暫存腳本保留 3 天
define('OC_SHELL_META_TTL', 86400);             // meta 保留 24 小時（日誌已消失才清）

// ─── 路徑 / 平台小工具 ──────────────────────────────────────────
function oc_shell_log($id)    { return OC_SHELLS . '/' . $id . '.log'; }
function oc_shell_meta($id)   { return OC_SHELLS . '/' . $id . '.json'; }
function oc_shell_script($id) { return OC_SHELLS . '/' . $id . (oc_is_win() ? '.bat' : '.sh'); }

// 交給 cmd.exe 的路徑一律用反斜線（scandir/realpath 的輸出已被統一成 /）
function oc_win_path($p) {
    return str_replace('/', '\\', oc_norm_slashes($p));
}

// 把命令包成平台對應的完整命令列
//   Windows：/d 不跑 AutoRun、/s 只剝除頭尾引號其餘原樣、/c 執行完結束
//            先切 UTF-8 主控台碼頁，中文輸出才不會亂碼（失敗則靜默略過）
//
// ⚠ 多行命令不能走命令列：cmd /c "..." 只會執行到第一個換行為止，
//   後面的行被靜默丟棄，而且還回報 exit_code 0 —— 模型會以為整段都成功了。
//   模型很常送多行命令，所以一旦偵測到換行就改寫成暫存 .bat 執行。
//   回傳 [命令列, 需要事後刪除的暫存檔或 null]。
function oc_exec_cmdline($command) {
    if (!oc_is_win()) {
        return ['/bin/sh -c ' . escapeshellarg($command), null];
    }

    // 走批次檔的兩個理由（實測驗證）：
    //  1. 多行：cmd /c "…" 只執行到第一個換行，其餘靜默丟棄且仍回報 exit 0。
    //  2. 非 ASCII：命令列走系統 OEM 碼頁（本機為 437），中文會整段變成「??????」；
    //     寫進 .bat 並在檔首 chcp 65001，中文就能正確傳遞與輸出。
    //     本產品的路徑與檔名常含中文，這條比多行更常踩到。
    $needsScript = strpbrk($command, "\r\n") !== false
                || preg_match('/[^\x00-\x7F]/', $command) === 1;

    if (!$needsScript) {
        return ['cmd /d /s /c "chcp 65001 >nul 2>&1 & ' . $command . '"', null];
    }

    $tmp  = OC_SHELLS . '/run-' . oc_id() . '.bat';
    $body = preg_replace("/\r\n|\r|\n/", "\r\n", $command);
    // 批次檔內的 % 會被當成變數展開，寫成 %% 才是字面值
    $bat  = "@echo off\r\nchcp 65001 >nul 2>&1\r\n"
          . str_replace('%', '%%', $body) . "\r\n";
    if (!is_dir(OC_SHELLS)) @mkdir(OC_SHELLS, 0777, true);
    if (@file_put_contents($tmp, $bat, LOCK_EX) === false) {
        oc_fail('無法建立暫存批次檔以執行命令', 500);
    }
    return ['cmd /d /s /c "' . oc_win_path($tmp) . '"', $tmp];
}

// 舊介面保留給單行呼叫點
function oc_exec_wrap($command) {
    [$line] = oc_exec_cmdline($command);
    return $line;
}

// ─── 輸出編碼正規化 ─────────────────────────────────────────────
// Windows 主控台常吐 CP950（繁中）等非 UTF-8 位元組，統一轉成 UTF-8，
// 免得 json_encode 只能塞一堆替代字元給模型看。
function oc_exec_utf8($s) {
    if ($s === '' || $s === null) return '';
    if (!function_exists('mb_check_encoding')) return $s;
    if (mb_check_encoding($s, 'UTF-8')) return $s;          // 純 ASCII 也會走這條

    // 先把非法位元組換成 U+FFFD，量一下「壞掉的比例」。
    // 只有零星壞位元組（例如截斷剛好切到半個字）就當它是 UTF-8，
    // 否則一顆壞位元組會讓整段被誤判成 CP950，整片中文變亂碼。
    $prev = @mb_substitute_character();
    @mb_substitute_character(0xFFFD);
    $sub = (string)@mb_convert_encoding($s, 'UTF-8', 'UTF-8');
    @mb_substitute_character($prev);
    $bad = substr_count($sub, "\xEF\xBF\xBD");
    if ($bad / max(1, mb_strlen($sub, 'UTF-8')) < 0.02) return $sub;

    static $cands = null;
    if ($cands === null) {
        $cands = [];
        $have  = array_map('strtoupper', (array)@mb_list_encodings());
        foreach (['CP950', 'BIG-5', 'CP936', 'CP932', 'CP1252'] as $e) {
            if (in_array($e, $have, true)) $cands[] = $e;
        }
    }
    foreach ($cands as $e) {
        if (@mb_check_encoding($s, $e)) {
            $c = @mb_convert_encoding($s, 'UTF-8', $e);
            if (is_string($c) && $c !== '') return $c;
        }
    }
    return $sub;                                            // 最後手段：帶著替代字元回去
}

// 串流讀取時，尾端可能切在多位元組字元中間；回傳應延後到下一次再送的位元組數。
function oc_utf8_defer_tail($s) {
    $len = strlen($s);
    for ($i = 1; $i <= 3 && $i <= $len; $i++) {
        $c = ord($s[$len - $i]);
        if ($c < 0x80)  return 0;                                   // ASCII 結尾 → 完整
        if ($c >= 0xC0) {                                           // 前導位元組
            $need = $c >= 0xF0 ? 4 : ($c >= 0xE0 ? 3 : 2);
            return $i < $need ? $i : 0;
        }
        // 0x80–0xBF：續接位元組，繼續往前找前導位元組
    }
    return 0;
}

// 反向：切掉開頭孤兒續接位元組（截斷後的尾段開頭可能是半個字的後半）
function oc_utf8_trim_lead($s) {
    $i = 0;
    $n = strlen($s);
    while ($i < 3 && $i < $n) {
        $c = ord($s[$i]);
        if ($c < 0x80 || $c >= 0xC0) break;                 // 遇到 ASCII 或前導位元組就停
        $i++;
    }
    return $i > 0 ? (string)substr($s, $i) : $s;
}

// 追讀「正在被寫入的檔案」：從 $off 讀到目前檔尾，回傳讀到的位元組數。
// 每次都 fseek 一次，才能清掉先前碰到 EOF 留下的旗標（否則之後永遠讀不到新資料）。
function oc_tail_read($fh, $file, &$off, &$acc) {
    if (!is_resource($fh)) return 0;
    clearstatcache(true, $file);
    $size = (int)@filesize($file);
    $n    = 0;
    while ($size > $off) {
        if (@fseek($fh, $off) !== 0) break;
        $buf = @fread($fh, (int)min(65536, $size - $off));
        if ($buf === false || $buf === '') break;
        $off += strlen($buf);
        $n   += strlen($buf);
        oc_acc_push($acc, $buf);
    }
    return $n;
}

// ─── 有上限的輸出累積器（頭尾各留一半，中段丟棄） ───────────────
// 錯誤訊息通常在尾端，開頭又常是關鍵指令回聲，所以兩頭都要留。
function oc_acc_new($cap) {
    return ['half' => max(1024, intdiv($cap, 2)), 'head' => '', 'tail' => '', 'omitted' => 0];
}

function oc_acc_push(&$a, $s) {
    if ($s === '' || $s === null) return;
    if (strlen($a['head']) < $a['half']) {                 // 先填頭段
        $need = $a['half'] - strlen($a['head']);
        $a['head'] .= substr($s, 0, $need);
        $s = (string)substr($s, $need);
        if ($s === '') return;
    }
    $a['tail'] .= $s;                                      // 其餘進尾段，只保留最後 half 位元組
    $over = strlen($a['tail']) - $a['half'];
    if ($over > 0) {
        $a['tail']     = substr($a['tail'], $over);
        $a['omitted'] += $over;
    }
}

// → [內容, 是否截斷]
function oc_acc_result($a) {
    if ($a['omitted'] <= 0) {
        // 未截斷：頭尾本是連續位元組，必須先接起來再轉碼，否則會切壞多位元組字元
        return [oc_exec_utf8($a['head'] . $a['tail']), false];
    }
    // 截斷處先把切壞的半個字元丟掉，兩段才能各自正確判斷編碼
    $head  = $a['head'];
    $defer = oc_utf8_defer_tail($head);
    if ($defer > 0) $head = (string)substr($head, 0, strlen($head) - $defer);
    $tail  = oc_utf8_trim_lead($a['tail']);
    $mark  = "\n…（已省略 " . $a['omitted'] . " 字元）…\n";
    return [oc_exec_utf8($head) . $mark . oc_exec_utf8($tail), true];
}

// ─── 程序終結 ───────────────────────────────────────────────────
// Windows 用 taskkill /T 連同子程序一起殺（只 proc_terminate 會留下孤兒）。
function oc_kill_tree($pid) {
    $pid = (int)$pid;
    if ($pid <= 0 || !function_exists('exec')) return false;
    $out = [];
    $rc  = 1;
    if (oc_is_win()) {
        @exec('taskkill /F /T /PID ' . $pid . ' 2>&1', $out, $rc);
        return $rc === 0;
    }
    @exec('kill -TERM -' . $pid . ' 2>/dev/null', $out, $rc);       // 先試整個程序群組
    if ($rc !== 0) @exec('kill -TERM ' . $pid . ' 2>/dev/null', $out, $rc);
    usleep(200000);
    @exec('kill -KILL ' . $pid . ' 2>/dev/null');
    return $rc === 0;
}

// Windows 背景命令用 start /b 啟動，拿不到 PID；kill 時才以「指令列包含 shell id」反查。
// 這條路只在 kill 時走一次，慢一點無所謂。
function oc_win_find_pid($id) {
    if (!function_exists('shell_exec')) return 0;
    $n = preg_replace('/[^A-Za-z0-9_.\-]/', '', (string)$id);
    if ($n === '') return 0;
    $ps = 'powershell -NoProfile -NonInteractive -Command '
        . '"Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like \'*' . $n . '*\' } '
        . '| Select-Object -First 1 -ExpandProperty ProcessId" 2>nul';
    $out = @shell_exec($ps);
    if (is_string($out) && preg_match('/(\d+)/', $out, $m)) return (int)$m[1];
    return 0;
}

// ─── 背景 shell 的 meta / 日誌 ──────────────────────────────────
function oc_shell_require($id) {
    $id = (string)$id;
    if (!oc_valid_id($id) || strpos($id, 'sh-') !== 0) oc_fail('無效的 shell_id', 400, $id);
    $file = oc_shell_meta($id);
    if (!is_file($file)) oc_fail('找不到背景命令：' . $id, 404);
    $m = oc_read_json($file, null);
    if (!is_array($m)) oc_fail('背景命令資料損毀：' . $id, 500, $file);
    $m['id'] = $id;
    return $m;
}

// 掃描日誌尾端是否已有完成標記 → 結束碼 / null
function oc_shell_tail_done($log) {
    if (!is_file($log)) return null;
    $size = (int)@filesize($log);
    if ($size <= 0) return null;
    $fh = @fopen($log, 'rb');
    if (!$fh) return null;
    if ($size > 512) @fseek($fh, $size - 512);
    $tail = (string)@stream_get_contents($fh);
    @fclose($fh);
    if (preg_match_all('/' . preg_quote(OC_DONE_MARK, '/') . ':(-?\d+)/', $tail, $mm)) {
        return (int)end($mm[1]);
    }
    return null;
}

// 把 meta 標記為已結束，並清掉暫存腳本
function oc_shell_finish(&$m, $code) {
    $m['running']   = false;
    $m['exit_code'] = $code === null ? null : (int)$code;
    $m['ended']     = time();
    oc_write_json(oc_shell_meta($m['id']), $m);
    @unlink(oc_shell_script($m['id']));
}

// 清掉 3 天前的日誌 / 暫存腳本，以及 24 小時前且日誌已消失的 meta。
// 每次 list 都跑一次，避免 data/shells 無限長大。
function oc_shell_prune() {
    $now     = time();
    $running = [];                                          // 執行中的 id → 不清
    foreach ((array)@glob(OC_SHELLS . '/*.json') as $f) {
        $m  = oc_read_json($f, []);
        $id = (string)($m['id'] ?? '');
        if ($id === '' || !oc_valid_id($id)) {              // 壞掉的 meta：放到過期才清，不急著動手
            $mt = @filemtime($f);
            if ($mt !== false && ($now - $mt) > OC_SHELL_META_TTL) @unlink($f);
            continue;
        }
        if (!empty($m['running'])) { $running[$id] = true; continue; }
        $started = (int)($m['started'] ?? 0);
        if ($started > 0 && ($now - $started) < OC_SHELL_META_TTL) continue;
        if (is_file(oc_shell_log($id))) continue;           // 日誌還在就留著 meta
        @unlink($f);
    }
    foreach (['log', 'bat', 'sh', 'out', 'err'] as $ext) {   // out/err 是 run 的暫存檔，正常會自刪
        foreach ((array)@glob(OC_SHELLS . '/*.' . $ext) as $f) {
            $id = basename($f, '.' . $ext);
            if (isset($running[$id])) continue;
            $mt = @filemtime($f);
            if ($mt !== false && ($now - $mt) > OC_SHELL_LOG_TTL) @unlink($f);
        }
    }
}

// ─── 共用參數解析 ───────────────────────────────────────────────
function oc_exec_command_arg() {
    $command = trim((string)oc_arg('command', ''));
    if ($command === '')            oc_fail('缺少 command 參數', 400);
    if (strlen($command) > 8000)    oc_fail('命令過長（上限 8000 字元）', 400);
    return $command;
}

// cwd 一律走 oc_path()，越界時 oc_path() 自己會 403
function oc_exec_cwd_arg() {
    $rel = (string)oc_arg('cwd', '');
    $abs = oc_path($rel);
    if (!is_dir($abs)) oc_fail('工作目錄不存在：' . ($rel === '' ? '.' : $rel), 404);
    return $abs;
}

// ═══════════════════════════════════════════════════════════════
// run — 前景執行
// ═══════════════════════════════════════════════════════════════
function oc_exec_run() {
    if (!function_exists('proc_open')) oc_fail('伺服器已停用 proc_open，無法執行命令', 500);

    $command = oc_exec_command_arg();
    $cwdAbs  = oc_exec_cwd_arg();

    $timeout = oc_int('timeout', OC_DEFAULT_EXEC_TIMEOUT);
    if ($timeout <= 0)                  $timeout = OC_DEFAULT_EXEC_TIMEOUT;
    if ($timeout > OC_MAX_EXEC_TIMEOUT) $timeout = OC_MAX_EXEC_TIMEOUT;

    // stdout / stderr 走暫存檔而不是 pipe：Windows 的程序 pipe 不吃
    // stream_set_blocking(false)，fread() 會一路擋到 EOF，逾時根本來不及觸發。
    // 改用檔案就能真正非阻塞輪詢，也不會因為 pipe 緩衝區塞滿而互卡。
    if (!is_dir(OC_SHELLS)) @mkdir(OC_SHELLS, 0777, true);
    $rid     = oc_id('run-');
    $outFile = OC_SHELLS . '/' . $rid . '.out';
    $errFile = OC_SHELLS . '/' . $rid . '.err';

    $desc  = [0 => ['pipe', 'r'], 1 => ['file', $outFile, 'w'], 2 => ['file', $errFile, 'w']];
    $pipes = [];
    // Windows 必須 bypass_shell：否則 PHP 會再包一層 cmd /c "…"，
    // 造成四個引號讓 cmd 放棄剝除，指令直接掛掉。
    $opts = oc_is_win() ? ['bypass_shell' => true] : [];

    $t0   = microtime(true);
    [$cmdLine, $tmpScript] = oc_exec_cmdline($command);
    $proc = @proc_open($cmdLine, $desc, $pipes, $cwdAbs, null, $opts);
    if (!is_resource($proc)) {
        @unlink($outFile); @unlink($errFile);
        if ($tmpScript) @unlink($tmpScript);
        oc_fail('無法啟動命令程序', 500, $command);
    }
    if (isset($pipes[0]) && is_resource($pipes[0])) @fclose($pipes[0]);   // stdin 立刻給 EOF

    $outAcc = oc_acc_new(OC_MAX_EXEC_OUTPUT);
    $errAcc = oc_acc_new(OC_MAX_EXEC_OUTPUT);
    $offOut = 0;
    $offErr = 0;
    $fo = @fopen($outFile, 'rb');
    $fe = @fopen($errFile, 'rb');

    $deadline = $t0 + $timeout / 1000;
    $timedOut = false;
    $exitCode = null;
    $pid      = 0;

    while (true) {
        $st = @proc_get_status($proc);
        if (!is_array($st)) break;
        if ($pid === 0) $pid = (int)($st['pid'] ?? 0);
        $n = oc_tail_read($fo, $outFile, $offOut, $outAcc)
           + oc_tail_read($fe, $errFile, $offErr, $errAcc);

        if (empty($st['running'])) {
            // exitcode 只有「第一次讀到 running=false」時才有效，先收起來
            $exitCode = (int)$st['exitcode'];
            break;
        }

        if (microtime(true) >= $deadline) {
            $timedOut = true;
            oc_kill_tree($pid);                             // 連子程序一起殺
            @proc_terminate($proc);
            for ($w = 0; $w < 40; $w++) {                   // 最多等 600ms 收屍
                $s2 = @proc_get_status($proc);
                if (is_array($s2) && empty($s2['running'])) { $exitCode = (int)$s2['exitcode']; break; }
                usleep(15000);
            }
            break;
        }

        if ($n === 0) usleep(15000);                        // 沒資料才睡，有資料就繼續搬
    }

    // 收尾：程序結束後緩衝區已 flush，再掃兩輪把殘留讀乾淨
    for ($d = 0; $d < 2; $d++) {
        oc_tail_read($fo, $outFile, $offOut, $outAcc);
        oc_tail_read($fe, $errFile, $offErr, $errAcc);
        usleep(20000);
    }

    if (is_resource($fo)) @fclose($fo);
    if (is_resource($fe)) @fclose($fe);
    foreach ($pipes as $p) { if (is_resource($p)) @fclose($p); }
    $closed = @proc_close($proc);
    @unlink($outFile);
    @unlink($errFile);
    if ($tmpScript) @unlink($tmpScript);                    // 多行命令用的暫存批次檔
    if ($exitCode === null) $exitCode = is_int($closed) ? $closed : -1;
    if ($timedOut) $exitCode = 124;                         // 逾時慣例碼（強殺後的原始碼沒有意義）

    list($stdout, $outTrunc) = oc_acc_result($outAcc);
    list($stderr, $errTrunc) = oc_acc_result($errAcc);

    if ($timedOut) {
        $stderr .= ($stderr === '' ? '' : "\n")
                 . '（命令執行逾時 ' . $timeout . " ms，已強制終止）\n";
    }

    oc_ok([
        'stdout'      => $stdout,
        'stderr'      => $stderr,
        'exit_code'   => $exitCode,
        'duration_ms' => (int)round((microtime(true) - $t0) * 1000),
        'truncated'   => ($outTrunc || $errTrunc),
        'timed_out'   => $timedOut,
        'cwd'         => oc_rel($cwdAbs),
        'command'     => $command,
    ]);
}

// ═══════════════════════════════════════════════════════════════
// start — 背景執行（卸離；輸出寫入 data/shells/<id>.log）
// ═══════════════════════════════════════════════════════════════
function oc_exec_start() {
    $command = oc_exec_command_arg();
    $cwdAbs  = oc_exec_cwd_arg();

    if (!is_dir(OC_SHELLS)) @mkdir(OC_SHELLS, 0777, true);
    if (!is_dir(OC_SHELLS)) oc_fail('無法建立 data/shells 目錄', 500, OC_SHELLS);

    $id     = oc_id('sh-');
    $log    = oc_shell_log($id);
    $script = oc_shell_script($id);
    if (@file_put_contents($log, '') === false) oc_fail('無法建立背景命令日誌', 500, $log);

    $pid = 0;

    if (oc_is_win()) {
        // 批次檔結構：
        //   call :OC_RUN >>log 2>&1   → 整段子程序輸出集中導向日誌
        //   >>log echo __OC_DONE__:%ERRORLEVEL%
        //     （重導向寫在前面是必要的：寫在後面時 "…:0>>log" 的 0 會被
        //       cmd 當成 stdin 的檔案代號，標記就寫不進去了）
        $body = preg_replace("/\r\n|\r|\n/", "\r\n", $command);
        $lg   = oc_win_path($log);
        $bat  = "@echo off\r\n"
              . "chcp 65001 >nul 2>&1\r\n"
              . 'cd /d "' . oc_win_path($cwdAbs) . '"' . "\r\n"
              . 'call :OC_RUN >>"' . $lg . '" 2>&1' . "\r\n"
              . '>>"' . $lg . '" echo ' . OC_DONE_MARK . ':%ERRORLEVEL%' . "\r\n"
              . "exit /b\r\n\r\n"
              . ":OC_RUN\r\n"
              . $body . "\r\n";
        if (@file_put_contents($script, $bat) === false) {
            oc_fail('無法寫入背景命令批次檔', 500, $script);
        }
        if (!function_exists('popen')) oc_fail('伺服器已停用 popen，無法背景執行', 500);
        // start "" /b 才不會另開主控台視窗；
        // >nul 2>&1 <nul 讓子程序不要繼承 popen 的管線控制碼，否則 pclose 會卡住等它結束。
        $launch = 'start "" /b "' . oc_win_path($script) . '" >nul 2>&1 <nul';
        $h = @popen($launch, 'r');
        if ($h === false) oc_fail('無法啟動背景命令', 500, $launch);
        @pclose($h);
        // Windows 這裡拿不到卸離後的 PID，kill 時再以指令列反查（見 oc_win_find_pid）
    } else {
        $sh = "#!/bin/sh\n"
            . 'cd ' . escapeshellarg($cwdAbs) . " || exit 1\n"
            . "{\n" . $command . "\n} >>" . escapeshellarg($log) . " 2>&1\n"
            . 'echo "' . OC_DONE_MARK . ':$?" >>' . escapeshellarg($log) . "\n";
        if (@file_put_contents($script, $sh) === false) {
            oc_fail('無法寫入背景命令腳本', 500, $script);
        }
        @chmod($script, 0755);
        if (!function_exists('shell_exec')) oc_fail('伺服器已停用 shell_exec，無法背景執行', 500);
        $out = @shell_exec('nohup /bin/sh ' . escapeshellarg($script) . ' >/dev/null 2>&1 & echo $!');
        $pid = (int)trim((string)$out);
    }

    oc_write_json(oc_shell_meta($id), [
        'id'        => $id,
        'command'   => $command,
        'cwd'       => oc_rel($cwdAbs),
        'started'   => time(),
        'pid'       => $pid,
        'running'   => true,
        'exit_code' => null,
    ]);

    oc_ok(['shell_id' => $id]);
}

// ═══════════════════════════════════════════════════════════════
// output — 從 byte offset 續讀背景輸出
// ═══════════════════════════════════════════════════════════════
function oc_exec_output() {
    $id   = (string)oc_arg('shell_id', '');
    $meta = oc_shell_require($id);

    $since = oc_int('since', 0);
    if ($since < 0) $since = 0;

    $log = oc_shell_log($id);
    clearstatcache(true, $log);
    $size = is_file($log) ? (int)filesize($log) : 0;
    if ($since > $size) $since = 0;                         // 日誌被清掉或重建 → 從頭讀

    $chunk = '';
    if ($size > $since) {
        $fh = @fopen($log, 'rb');
        if ($fh) {
            @fseek($fh, $since);
            $chunk = (string)@stream_get_contents($fh, $size - $since);
            @fclose($fh);
        }
    }
    $offset = $since + strlen($chunk);

    // 完成標記：取出結束碼後，從回傳內容中剔除（模型不該看到內部標記）
    $done = null;
    if ($chunk !== '' && strpos($chunk, OC_DONE_MARK) !== false) {
        $q = preg_quote(OC_DONE_MARK, '/');
        if (preg_match_all('/' . $q . ':(-?\d+)/', $chunk, $mm)) $done = (int)end($mm[1]);
        $chunk = (string)preg_replace(
            '/(?:\r\n|\n|\r)?' . $q . ':-?\d+[ \t]*(?:\r\n|\n|\r)?/', '', $chunk
        );
    }

    $running = !empty($meta['running']);
    if ($done !== null && $running) {
        oc_shell_finish($meta, $done);
        $running = false;
    }

    // 還在跑：尾端若切在多位元組字元中間就少送幾個位元組，下一輪自然補上
    if ($running) {
        $defer = oc_utf8_defer_tail($chunk);
        if ($defer > 0) {
            $chunk   = (string)substr($chunk, 0, strlen($chunk) - $defer);
            $offset -= $defer;
        }
    }

    $exit = (array_key_exists('exit_code', $meta) && $meta['exit_code'] !== null)
            ? (int)$meta['exit_code'] : null;

    oc_ok([
        'chunk'     => oc_exec_utf8($chunk),
        'offset'    => $offset,
        'running'   => $running,
        'exit_code' => $running ? null : $exit,
    ]);
}

// ═══════════════════════════════════════════════════════════════
// kill — 終止背景命令
// ═══════════════════════════════════════════════════════════════
function oc_exec_kill() {
    $id   = (string)oc_arg('shell_id', '');
    $meta = oc_shell_require($id);

    $pid    = (int)($meta['pid'] ?? 0);
    $killed = false;

    if (!empty($meta['running'])) {
        if (oc_is_win() && $pid <= 0) $pid = oc_win_find_pid($id);
        $killed = oc_kill_tree($pid);
        // 補寫完成標記，讓還在輪詢 output 的前端能收斂（被殺的程序不會自己寫）
        $eol = oc_is_win() ? "\r\n" : "\n";
        @file_put_contents(
            oc_shell_log($id),
            $eol . '[已由使用者中止]' . $eol . OC_DONE_MARK . ':-1' . $eol,
            FILE_APPEND | LOCK_EX
        );
    }

    $meta['pid'] = $pid;
    oc_shell_finish($meta, (isset($meta['exit_code']) && $meta['exit_code'] !== null)
                          ? $meta['exit_code'] : -1);

    oc_ok(['killed' => $killed, 'pid' => $pid]);
}

// ═══════════════════════════════════════════════════════════════
// list — 列出背景命令（新→舊）
// ═══════════════════════════════════════════════════════════════
function oc_exec_list() {
    oc_shell_prune();

    $shells = [];
    foreach ((array)@glob(OC_SHELLS . '/*.json') as $f) {
        $m  = oc_read_json($f, null);
        if (!is_array($m)) continue;
        $id = (string)($m['id'] ?? '');
        if ($id === '' || !oc_valid_id($id)) continue;
        $m['id'] = $id;

        // 沒人輪詢 output 時 meta 會停在 running=true，這裡順手用日誌尾端校正
        if (!empty($m['running'])) {
            $code = oc_shell_tail_done(oc_shell_log($id));
            if ($code !== null) oc_shell_finish($m, $code);
        }

        $shells[] = [
            'id'        => $id,
            'command'   => (string)($m['command'] ?? ''),
            'cwd'       => (string)($m['cwd'] ?? ''),
            'running'   => !empty($m['running']),
            'started'   => (int)($m['started'] ?? 0),
            'exit_code' => (isset($m['exit_code']) && $m['exit_code'] !== null) ? (int)$m['exit_code'] : null,
        ];
    }

    usort($shells, function ($a, $b) { return $b['started'] <=> $a['started']; });

    oc_ok(['shells' => $shells]);
}

// ═══════════════════════════════════════════════════════════════
// 分派
// ═══════════════════════════════════════════════════════════════
$action = oc_arg('action', '');
switch ($action) {
    case 'run':    oc_exec_run();    break;
    case 'start':  oc_exec_start();  break;
    case 'output': oc_exec_output(); break;
    case 'kill':   oc_exec_kill();   break;
    case 'list':   oc_exec_list();   break;
    default:       oc_fail('未知的 action: ' . $action, 404);
}
