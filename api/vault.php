<?php
require_once __DIR__ . '/../includes/helpers.php';
oc_boot();

// ═══════════════════════════════════════════════════════════════
// Omni Code — 憑證保險庫（借鏡 Muse「可用不可讀」）
// ═══════════════════════════════════════════════════════════════
// Agent 只拿代號不拿明文：工具定義與 MCP 設定裡寫 {{VAULT:名稱}}，
// 執行當下才由後端從 data/vault.json 取值代入。值「永不」離開伺服器：
//   · list 只回 key 名單，不回值
//   · set 只回 key 名單，不回傳寫入的值
//   · 對話上下文、稽核檔、工具定義裡永遠只有 {{VAULT:名稱}} 這個代號
//
// 跟 data/secrets.json 的分工：secrets.json 是自撰 API 工具的舊金鑰庫
// （{{SECRET:}} 照舊可用）；vault.json 是通用庫，usertools 與 MCP 共用。
// 契約見 docs/ARCHITECTURE.md §13.6
// ═══════════════════════════════════════════════════════════════

define('OC_VAULT_FILE', OC_DATA . '/vault.json');

function oc_vault_all() {
    $v = oc_read_json(OC_VAULT_FILE, []);
    return is_array($v) ? $v : [];
}

/** 代號合法性：跟 {{SECRET:}} 同一組字元，兩邊通用 */
function oc_vault_valid_key($k) {
    return preg_match('/^[A-Za-z0-9_.-]{1,64}$/', (string)$k) === 1;
}

function oc_vault_list() {
    oc_ok(['keys' => array_keys(oc_vault_all())]);
}

function oc_vault_set() {
    $k = (string)oc_arg('key', '');
    $v = (string)oc_arg('value', '');
    if (!oc_vault_valid_key($k)) oc_fail('key 不合法（英數字、底線、句點、連字號，1–64 字）', 400);
    $s = oc_vault_all();
    if ($v === '') unset($s[$k]); else $s[$k] = $v;
    if (!oc_write_json(OC_VAULT_FILE, $s)) oc_fail('無法寫入保險庫', 500);
    // 絕不回傳值本身
    oc_ok(['keys' => array_keys($s)]);
}

function oc_vault_has() {
    $k = (string)oc_arg('key', '');
    $s = oc_vault_all();
    oc_ok(['exists' => array_key_exists($k, $s)]);
}

$action = oc_arg('action', '');
switch ($action) {
    case 'list':   oc_vault_list(); break;
    case 'set':    oc_vault_set();  break;
    case 'has':    oc_vault_has();  break;
    default: oc_fail('未知的 action: ' . $action, 404);
}
