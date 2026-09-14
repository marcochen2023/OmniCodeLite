<?php
require_once __DIR__ . '/../includes/helpers.php';
oc_boot();

// ═══════════════════════════════════════════════════════════════
// Omni Code — api/video.php（影片／音訊多模態分析）
// ═══════════════════════════════════════════════════════════════
// 為什麼在 PHP 做而不是瀏覽器：影片動輒幾十到幾百 MB，讀進瀏覽器
// 記憶體再 base64 上傳等於把檔案脹大三分之一塞進 JS heap，很容易把
// 分頁弄死。PHP 直接從工作區磁碟串流給 Google，前端只傳一個路徑。
//
// 兩條路徑（依檔案大小自動選）：
//   ≤ 14MB  → inline_data 一次呼叫（20MB 上限算的是 base64 之後的請求本體）
//   >  14MB → Gemini Files API 續傳上傳 → 輪詢到 ACTIVE → file_uri 呼叫
//             → 用完刪除（Files API 檔案 48 小時後自動過期，但不留垃圾）
//
// 金鑰由前端隨請求帶入（與 relay.php 相同的信任模型：oc_guard_local
// 已保證只有本機能呼叫）。這裡只對 generativelanguage.googleapis.com
// 發請求，寫死主機 —— 不是開放代理。
// ═══════════════════════════════════════════════════════════════

// 14MB：Google 的 20MB 上限算的是「整個請求本體」，base64 會把檔案脹大 4/3
// （14MB 原始 → 18.7MB base64，再留餘裕給 JSON 結構與提示詞）。
// 之前設 19MB 時，14.5–19MB 的檔案會 100% 撞牆 —— 落在 inline 分支卻必定被 400 退。
const OC_VIDEO_INLINE_MAX  = 14 * 1024 * 1024;
const OC_VIDEO_FILE_MAX    = 500 * 1024 * 1024;   // 500MB：再大輪詢時間會長到不合理
const OC_VIDEO_POLL_SECS   = 300;                  // 等待 Google 處理影片的上限
const OC_GEMINI_HOST       = 'https://generativelanguage.googleapis.com';

// 影片處理整段可能要好幾分鐘，PHP 預設 30 秒會腰斬
@set_time_limit(0);
@ini_set('memory_limit', '1024M');

function oc_video_mime($path) {
    static $map = [
        'mp4' => 'video/mp4',   'mpeg' => 'video/mpeg', 'mpg' => 'video/mpg',
        'mov' => 'video/mov',   'avi' => 'video/avi',   'flv' => 'video/x-flv',
        'webm' => 'video/webm', 'wmv' => 'video/wmv',   '3gp' => 'video/3gpp',
        // 音訊也一併支援 —— Gemini 同一個介面就吃
        'mp3' => 'audio/mp3',   'wav' => 'audio/wav',   'aac' => 'audio/aac',
        'ogg' => 'audio/ogg',   'flac' => 'audio/flac', 'm4a' => 'audio/aac',
    ];
    $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
    return $map[$ext] ?? null;
}

/** 對 Google 發 HTTP 請求。回 [status, headers(小寫鍵), body]。
 *  $soft = true 時連線層失敗回 [0, [], '']，不終止腳本 ——
 *  oc_fail() 是 echo+exit，exit 不是 Throwable，外層的 try/catch 根本攔不到。
 *  輪詢與清理這種「失敗要能繼續」的呼叫必須用 soft。 */
function oc_video_http($method, $url, $headers, $body, $timeout = 120, $soft = false) {
    $ch = curl_init($url);
    $respHeaders = [];
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST  => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => $timeout,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$respHeaders) {
            $p = strpos($line, ':');
            if ($p !== false) $respHeaders[strtolower(trim(substr($line, 0, $p)))] = trim(substr($line, $p + 1));
            return strlen($line);
        },
    ]);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    $out = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $err = curl_error($ch);
    curl_close($ch);
    if ($out === false) {
        if ($soft) return [0, [], ''];
        oc_fail('連線 Google 失敗：' . $err, 502);
    }
    return [$status, $respHeaders, $out];
}

/** Files API 續傳上傳，回傳 file 資源（含 name / uri / state）。 */
function oc_video_upload($real, $mime, $size, $key) {
    // 第 1 步：start —— 拿到上傳網址
    [$st, $hd] = oc_video_http('POST',
        OC_GEMINI_HOST . '/upload/v1beta/files?key=' . rawurlencode($key),
        [
            'X-Goog-Upload-Protocol: resumable',
            'X-Goog-Upload-Command: start',
            'X-Goog-Upload-Header-Content-Length: ' . $size,
            'X-Goog-Upload-Header-Content-Type: ' . $mime,
            'Content-Type: application/json',
        ],
        json_encode(['file' => ['display_name' => basename($real)]]));
    if ($st !== 200) oc_fail("Files API 起始失敗（HTTP {$st}）", 502);
    $uploadUrl = $hd['x-goog-upload-url'] ?? '';
    if ($uploadUrl === '') oc_fail('Files API 沒有回傳上傳網址', 502);

    // 第 2 步：upload, finalize —— 一次送完整檔案內容。
    // 500MB 以下一個請求就好；真的斷線重來的成本低於分塊的複雜度。
    $bin = @file_get_contents($real);
    if ($bin === false) oc_fail('讀取影片檔失敗', 500);
    [$st2, , $body2] = oc_video_http('POST', $uploadUrl, [
        'X-Goog-Upload-Command: upload, finalize',
        'X-Goog-Upload-Offset: 0',
        'Content-Length: ' . strlen($bin),
    ], $bin, 1800);
    unset($bin);
    if ($st2 !== 200) oc_fail("影片上傳失敗（HTTP {$st2}）：" . substr($body2, 0, 300), 502);
    $file = json_decode($body2, true)['file'] ?? null;
    if (!$file || empty($file['uri'])) oc_fail('上傳回應缺少 file.uri', 502);

    // 第 3 步：輪詢到 ACTIVE —— 影片要等 Google 轉檔完才能用，
    // PROCESSING 期間拿去 generateContent 會直接 400
    $deadline = time() + OC_VIDEO_POLL_SECS;
    while (($file['state'] ?? '') === 'PROCESSING' && time() < $deadline) {
        sleep(4);
        // soft：單次輪詢失敗（連線抖動、逾時）就下一輪再試，
        // 不能讓一次抖動把已經上傳完的大檔前功盡棄
        [$st3, , $body3] = oc_video_http('GET',
            OC_GEMINI_HOST . '/v1beta/' . $file['name'] . '?key=' . rawurlencode($key), [], null, 30, true);
        if ($st3 === 200) $file = json_decode($body3, true) ?: $file;
    }
    if (($file['state'] ?? '') !== 'ACTIVE') {
        oc_video_delete($file['name'] ?? '', $key);
        oc_fail('影片處理逾時或失敗（state: ' . ($file['state'] ?? '?') . '）。'
              . '較長的影片需要更久的處理時間，可以稍後重試。', 504);
    }
    return $file;
}

function oc_video_delete($name, $key) {
    if ($name === '') return;
    // 清不掉也無妨 —— Files API 的檔案 48 小時後自動過期。
    // 一定要用 soft：清理失敗若走 oc_fail 會直接 exit，
    // 把「分析已成功、只是刪暫存檔失敗」變成整個請求 502，
    // 使用者等了好幾分鐘的結果就這樣被丟掉。
    oc_video_http('DELETE', OC_GEMINI_HOST . '/v1beta/' . $name . '?key=' . rawurlencode($key), [], null, 20, true);
}

// ═══════════════════════════════════════════════════════════════

$action = oc_arg('action', '');
if ($action !== 'analyze') oc_fail('未知的 action', 400);

$in = oc_input();
$path        = (string)($in['path'] ?? '');
$instruction = trim((string)($in['instruction'] ?? ''));
$model       = trim((string)($in['model'] ?? '')) ?: 'gemini-3.5-flash';
$key         = trim((string)($in['key'] ?? ''));

if ($path === '')        oc_fail('缺少 path', 400);
if ($instruction === '') oc_fail('缺少 instruction（要模型對影片做什麼）', 400);
if ($key === '')         oc_fail('缺少 Gemini API Key', 400);
// 模型名只該是識別字 —— 它會被拼進 URL，不做白名單也至少要擋住路徑符號
if (!preg_match('/^[A-Za-z0-9.\-]{1,80}$/', $model)) oc_fail('model 名稱不合法', 400);

$real = oc_path($path);
if (!is_file($real)) oc_fail('找不到檔案：' . $path, 404);
$mime = oc_video_mime($real);
if ($mime === null) oc_fail('不支援的影音格式：' . $path . '（支援 mp4/mov/avi/webm/mpeg/wmv/flv/3gp 與 mp3/wav/aac/ogg/flac）', 400);
$size = (int)filesize($real);
if ($size <= 0) oc_fail('檔案是空的', 400);
if ($size > OC_VIDEO_FILE_MAX) oc_fail('檔案超過 500MB 上限（' . round($size / 1048576) . 'MB）。請先剪短或壓縮。', 413);

$t0 = microtime(true);
$uploadedName = '';

// 組媒體 part：小檔 inline、大檔走 Files API
if ($size <= OC_VIDEO_INLINE_MAX) {
    $mediaPart = ['inline_data' => ['mime_type' => $mime, 'data' => base64_encode(file_get_contents($real))]];
    $via = 'inline';
} else {
    $file = oc_video_upload($real, $mime, $size, $key);
    $uploadedName = $file['name'];
    $mediaPart = ['file_data' => ['mime_type' => $mime, 'file_uri' => $file['uri']]];
    $via = 'files_api';
}

$body = [
    'contents' => [[
        'parts' => [
            $mediaPart,
            ['text' => $instruction],
        ],
    ]],
    'generationConfig' => ['maxOutputTokens' => 16384],
];

[$st, , $out] = oc_video_http('POST',
    OC_GEMINI_HOST . '/v1beta/models/' . rawurlencode($model) . ':generateContent?key=' . rawurlencode($key),
    ['Content-Type: application/json'],
    json_encode($body), 600, true);

// 無論成敗都先把 Files API 的暫存檔清掉，再處理錯誤 ——
// 順序反過來的話，生成失敗會讓上傳檔變孤兒（要等 48 小時自動過期）
oc_video_delete($uploadedName, $key);

if ($st === 0) oc_fail('連線 Google 失敗（生成階段逾時或斷線）。長影片可以稍後重試。', 502);

$j = json_decode($out, true);
if ($st !== 200) {
    $msg = $j['error']['message'] ?? ('HTTP ' . $st);
    oc_fail('Gemini 回應錯誤：' . $msg, 502, substr($out, 0, 800));
}

$text = '';
foreach (($j['candidates'][0]['content']['parts'] ?? []) as $p) {
    if (isset($p['text']) && empty($p['thought'])) $text .= $p['text'];
}
if ($text === '') {
    $fr = $j['candidates'][0]['finishReason'] ?? '';
    oc_fail('模型沒有回傳內容' . ($fr ? "（{$fr}）" : ''), 502, substr($out, 0, 500));
}

oc_ok([
    'text'    => $text,
    'via'     => $via,
    'bytes'   => $size,
    'mime'    => $mime,
    'seconds' => round(microtime(true) - $t0, 1),
    'usage'   => [
        'input'  => (int)($j['usageMetadata']['promptTokenCount'] ?? 0),
        'output' => (int)($j['usageMetadata']['candidatesTokenCount'] ?? 0),
    ],
]);
