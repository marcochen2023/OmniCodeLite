<?php
// ═══════════════════════════════════════════════════════════════
// Omni Code — 敏感資源政策（建議 #3）
// ═══════════════════════════════════════════════════════════════
// oc_path() 已經把檔案系統關進工作區，但工作區「裡面」的 .env、
// .git-credentials、id_rsa 是完全敞開的 —— 自動編輯模式下讀取這些檔
// 連問都不會問。這份清單把它們升級成「需要明確授權」。
//
// 資料來源是 Agenvoy 的 denied_map，那是有人認真想過「哪些檔會漏密」
// 的成果，值得原樣照抄。
//
// ★ 兩半的性質完全不同，不要混為一談：
//   檔案這半（oc_policy_is_sensitive）是「真的強制」—— 它擋在
//     oc_path() 這個所有 fs 操作的唯一入口上。
//   命令那半（oc_policy_cmd_risk）只是「防手滑」—— PHP 的字串掃描
//     擋不住 eval、base64、或用變數組出來的命令名，而 Windows 上
//     也沒有 bwrap / sandbox-exec 可以退守。
//   把它當安全邊界會給人錯誤的安全感。
// ═══════════════════════════════════════════════════════════════

// ─── 敏感目錄（任一路徑片段命中即算）───────────────────────────
$OC_DENIED_DIRS = [
    '.ssh', '.aws', '.gcloud', '.gnupg', '.gpg', '.docker', '.kube',
];

// ─── 敏感檔名（支援尾端 * 萬用）─────────────────────────────────
$OC_DENIED_FILES = [
    'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*',
    'authorized_keys', 'known_hosts',
    'ssh_host_*_key*',
    '.bash_history', '.zsh_history', '.psql_history', '.mysql_history',
    '.netrc', '_netrc',
    '.git-credentials', '.npmrc', '.pypirc',
    'credentials', 'credentials.json', 'service-account*.json',
];

// ─── 敏感檔名前綴 ───────────────────────────────────────────────
$OC_DENIED_PREFIXES = ['.env.'];
// ─── 敏感副檔名 ─────────────────────────────────────────────────
$OC_DENIED_EXTS = ['.pem', '.key', '.p12', '.pfx', '.cer', '.crt', '.keystore', '.jks'];

// ─── 唯讀命令：這些不會改變任何狀態，可以免詢問 ─────────────────
// 用途是「少問一點」，不是「擋住什麼」—— 命中就快速放行，
// 沒命中也只是照舊走原本的權限判定。
$OC_READONLY_CMDS = [
    'ls', 'dir', 'pwd', 'cd', 'echo', 'cat', 'type', 'head', 'tail', 'wc',
    'find', 'grep', 'rg', 'fd', 'which', 'where', 'file', 'stat',
    'date', 'whoami', 'hostname', 'uname', 'env', 'printenv',
    'git status', 'git log', 'git diff', 'git show', 'git branch',
    'git remote', 'git config --get', 'git rev-parse',
    'npm ls', 'npm view', 'npm outdated', 'pip list', 'pip show',
    'php -v', 'php -l', 'node -v', 'node --check', 'python --version',
    'go version', 'cargo --version', 'tree',
];

// ─── 高風險命令：一律需要授權，即使在 acceptEdits ───────────────
$OC_RISKY_CMDS = [
    'rm -rf', 'rmdir /s', 'del /f', 'format', 'mkfs',
    'dd if=', 'shutdown', 'reboot',
    'chmod 777', 'chown -R',
    'curl -o', 'wget -O', 'iwr -outfile',
    'git push --force', 'git push -f', 'git reset --hard', 'git clean -fd',
    'npm publish', 'pip install', 'npm install -g',
];

// ═══════════════════════════════════════════════════════════════

function oc_policy_glob_match($pattern, $name) {
    if (strpos($pattern, '*') === false) return strcasecmp($pattern, $name) === 0;
    $re = '/^' . str_replace('\*', '.*', preg_quote($pattern, '/')) . '$/i';
    return (bool)preg_match($re, $name);
}

/**
 * 這條路徑碰到敏感資源了嗎？（工作區相對，或 extra:<alias>/…）
 * 回傳 '' 表示不敏感；否則回傳「為什麼」的說明字串。
 *
 * 專案根目錄自己的 .env 是豁免的 —— 那是使用者天天在編輯的檔案，
 * 每次都跳授權會把這個功能變成純粹的阻力，然後被關掉。
 * 巢狀目錄裡的 .env（常常是別人的專案、或不小心複製進來的）仍然要問。
 *
 * extra: 根一律不豁免：那是別人的目錄借來參考的，根下的 .env 照樣要問。
 */
function oc_policy_is_sensitive($rel) {
    global $OC_DENIED_DIRS, $OC_DENIED_FILES, $OC_DENIED_PREFIXES, $OC_DENIED_EXTS;

    $rel  = trim(str_replace('\\', '/', (string)$rel), '/');
    if ($rel === '') return '';
    $isExtra = strncasecmp($rel, 'extra:', 6) === 0;
    if ($isExtra) {
        // 去掉 extra:<alias>/，只看根內的相對路徑；根本身（無後綴）視為根目錄
        $slash = strpos($rel, '/');
        $rel = $slash === false ? '' : substr($rel, $slash + 1);
        if ($rel === '') return '';
    }
    $segs = explode('/', $rel);
    $name = end($segs);
    $lower = strtolower($name);

    // 使用者可以「增列」，但不能移除內建的（跟 Agenvoy 一樣採相加合併）
    $extra = oc_cfg()['sensitivePaths'] ?? [];
    if (is_array($extra)) {
        foreach ($extra as $pat) {
            if (oc_policy_glob_match((string)$pat, $name)) return "符合你自訂的敏感清單：{$pat}";
        }
    }

    foreach (array_slice($segs, 0, -1) as $seg) {
        if (in_array(strtolower($seg), $OC_DENIED_DIRS, true)) return "位於敏感目錄 {$seg}/ 之下";
    }

    // 工作區根目錄的 .env 豁免（見上方說明）；extra: 根不豁免
    if ($lower === '.env') return (count($segs) === 1 && !$isExtra) ? '' : '巢狀目錄中的 .env';

    foreach ($OC_DENIED_FILES as $pat) {
        if (oc_policy_glob_match($pat, $name)) return "敏感檔名（{$pat}）";
    }
    foreach ($OC_DENIED_PREFIXES as $pre) {
        if (stripos($name, $pre) === 0) return "敏感檔名前綴（{$pre}*）";
    }
    foreach ($OC_DENIED_EXTS as $ext) {
        if (substr($lower, -strlen($ext)) === $ext) return "敏感副檔名（{$ext}）";
    }
    return '';
}

/**
 * 命令風險分級：'readonly' | 'risky' | ''
 * 見檔頭說明：這是防手滑，不是安全邊界。
 */
function oc_policy_cmd_risk($cmd) {
    global $OC_READONLY_CMDS, $OC_RISKY_CMDS;
    $c = strtolower(trim(preg_replace('/\s+/', ' ', (string)$cmd)));
    if ($c === '') return '';

    foreach ($OC_RISKY_CMDS as $r) {
        if (strpos($c, strtolower($r)) !== false) return 'risky';
    }
    // 有串接就不算唯讀 —— `ls && rm -rf x` 的前半段長得很無辜
    if (preg_match('/[;&|>`]|\$\(/', $c)) return '';
    foreach ($OC_READONLY_CMDS as $ro) {
        $ro = strtolower($ro);
        if ($c === $ro || strpos($c, $ro . ' ') === 0) return 'readonly';
    }
    return '';
}
