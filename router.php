<?php
// ═══════════════════════════════════════════════════════════════
// Omni Code — php -S 開發伺服器路由
// ═══════════════════════════════════════════════════════════════
// 用法：
//   cd D:/xampp/htdocs/app/OmniCode
//   D:/xampp/php/php.exe -S localhost:8080 router.php
//
// 目標：讓 `php -S` 的行為與 XAMPP/Apache 下完全一致 ——
//   · api/  只放行 *.php（對應 api/.htaccess）
//   · data/ 一律 403（對應 data/.htaccess）
//   · 既有靜態檔以正確 MIME 送出
//   · /、/app、/app/ → app/index.html
//   · 其餘 404
// 回傳 false = 交還內建伺服器自行處理；回傳 true = 本檔已處理完畢。
// ═══════════════════════════════════════════════════════════════

$root = str_replace('\\', '/', __DIR__);
$uri  = (string)parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
$uri  = urldecode($uri);
$uri  = str_replace('\\', '/', $uri);
if ($uri === '') $uri = '/';

// 副檔名 → MIME（沒列到的交給內建伺服器）
$OC_MIME = [
    'html'  => 'text/html; charset=utf-8',
    'htm'   => 'text/html; charset=utf-8',
    'css'   => 'text/css; charset=utf-8',
    'js'    => 'text/javascript; charset=utf-8',
    'mjs'   => 'text/javascript; charset=utf-8',
    'json'  => 'application/json; charset=utf-8',
    'map'   => 'application/json; charset=utf-8',
    'md'    => 'text/markdown; charset=utf-8',
    'txt'   => 'text/plain; charset=utf-8',
    'svg'   => 'image/svg+xml',
    'png'   => 'image/png',
    'jpg'   => 'image/jpeg',
    'jpeg'  => 'image/jpeg',
    'gif'   => 'image/gif',
    'webp'  => 'image/webp',
    'ico'   => 'image/x-icon',
    'woff2' => 'font/woff2',
    'woff'  => 'font/woff',
];

// ─── 送出純文字狀態頁的小工具 ──────────────────────────────────
function oc_router_stop($code, $text) {
    http_response_code($code);
    header('Content-Type: text/plain; charset=utf-8');
    echo $text;
}

// ─── 0) 路徑逃逸防護 ───────────────────────────────────────────
if (strpos($uri, "\0") !== false || strpos($uri, '..') !== false) {
    oc_router_stop(403, '403 Forbidden');
    return true;
}

// ─── 1) data/ 一律拒絕（設定檔、金鑰、會話存檔都在裡面）────────
if (preg_match('#^/data(/|$)#i', $uri)) {
    oc_router_stop(403, '403 Forbidden');
    return true;
}

// ─── 2) api/ 只放行 *.php，並直接執行對應端點 ──────────────────
if (preg_match('#^/api(/|$)#i', $uri)) {
    if (!preg_match('#^/api/([A-Za-z0-9_\-]+\.php)$#', $uri, $m)) {
        oc_router_stop(403, '403 Forbidden');
        return true;
    }
    $file = $root . '/api/' . $m[1];
    if (!is_file($file)) {
        oc_router_stop(404, '404 Not Found: ' . $uri);
        return true;
    }
    require $file;
    return true;
}

// ─── 3) 既有實體檔案 ───────────────────────────────────────────
if ($uri !== '/' && is_file($root . $uri)) {
    $file = $root . $uri;
    $ext  = strtolower(pathinfo($file, PATHINFO_EXTENSION));
    if ($ext === 'php') {          // 例如 /index.php?health
        require $file;
        return true;
    }
    if (isset($OC_MIME[$ext])) {
        header('Content-Type: ' . $OC_MIME[$ext]);
        header('Content-Length: ' . (string)filesize($file));
        readfile($file);
        return true;
    }
    return false;                  // 未知型別 → 交還內建伺服器
}

// ─── 4) 應用外殼 ───────────────────────────────────────────────
if ($uri === '/' || $uri === '/app' || $uri === '/app/') {
    $shell = $root . '/app/index.html';
    if (!is_file($shell)) {
        oc_router_stop(404, '404 Not Found: app/index.html 不存在');
        return true;
    }
    header('Content-Type: text/html; charset=utf-8');
    readfile($shell);
    return true;
}

// ─── 5) 其餘 404 ───────────────────────────────────────────────
oc_router_stop(404, '404 Not Found: ' . $uri);
return true;
