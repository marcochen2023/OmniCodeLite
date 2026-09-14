<?php
require_once __DIR__ . '/includes/helpers.php';
oc_boot(false);   // 不設 JSON 標頭（本檔多半是 302 轉址），但仍守門本機 + 建好 data/

// ═══════════════════════════════════════════════════════════════
// Omni Code — 入口
// ═══════════════════════════════════════════════════════════════
// 一般存取：轉址到 app/（唯一的 HTML 外殼）。
// 帶 ?health：回傳健檢 JSON，供 /doctor 與部署腳本確認 PHP 正常。
// ═══════════════════════════════════════════════════════════════

if (strpos((string)($_SERVER['QUERY_STRING'] ?? ''), 'health') !== false) {
    header('Content-Type: application/json; charset=utf-8');
    echo oc_json_encode(['ok' => true, 'php' => PHP_VERSION, 'app' => 'Omni Code']);
    exit;
}

header('Location: app/');
exit;
