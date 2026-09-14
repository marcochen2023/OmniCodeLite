<?php
// ═══════════════════════════════════════════════════════════════
// Omni Code — 伺服器端常數
// ═══════════════════════════════════════════════════════════════
// 本專案不使用資料庫，也不需要任何平台金鑰。
// 執行期可變設定（工作區、權限模式、MCP…）存於 data/config.json。
// ═══════════════════════════════════════════════════════════════

define('OC_ROOT',      str_replace('\\', '/', dirname(__DIR__)));
define('OC_DATA',      OC_ROOT . '/data');
define('OC_SESSIONS',  OC_DATA . '/sessions');
define('OC_SHELLS',    OC_DATA . '/shells');
define('OC_MEMORY',    OC_DATA . '/memory');
define('OC_MODELS',    OC_DATA . '/models.json');   // 模型管理面板的設定（獨立於 config.json）
define('OC_LOGS',      OC_DATA . '/logs');
define('OC_SKILLS',    OC_ROOT . '/skills');
define('OC_CONFIG_FILE', OC_DATA . '/config.json');

// 預設工作區（可於前端「工作區選擇器」變更）
// 刻意指向 Omni Code 自己的目錄，而不是整個 htdocs：
// htdocs 底下常有數十萬個檔案，一開啟就把它當工作區會讓搜尋與檔案樹又慢又難用。
// 使用者第一次進來看到的是一個乾淨、能立刻運作的小型專案，
// 再用頂列的工作區選擇器切到自己要開發的資料夾。
define('OC_DEFAULT_WORKSPACE', str_replace('\\', '/', dirname(__DIR__)));

// 限制值
define('OC_MAX_READ_BYTES',     8 * 1024 * 1024);   // 單檔讀取上限
define('OC_MAX_GREP_BYTES',     5 * 1024 * 1024);   // grep 單檔跳過門檻
define('OC_MAX_EXEC_OUTPUT',    200 * 1024);        // 命令輸出上限
define('OC_MAX_EXEC_TIMEOUT',   600000);            // 命令逾時上限（ms）
define('OC_DEFAULT_EXEC_TIMEOUT', 120000);
define('OC_MAX_UPLOAD_BYTES',   64 * 1024 * 1024);
define('OC_MCP_TIMEOUT',        30);                // MCP 呼叫逾時（秒）
define('OC_FETCH_TIMEOUT',      30);

// 僅允許本機連線（唯一的安全邊界；工作區內 Agent 有 100% 權限）
define('OC_LOCAL_ONLY', true);

// AI 供應商網域白名單（relay 代理僅允許這些主機，避免變成開放代理）
$OC_API_HOSTS = [
    'generativelanguage.googleapis.com',
    'api.openai.com',
    'api.anthropic.com',
    'openrouter.ai',
];

// glob / grep / tree 預設忽略
$OC_IGNORE = [
    '.git', 'node_modules', 'vendor', 'dist', 'build', '.next', '.nuxt',
    '__pycache__', '.venv', 'venv', '.idea', '.vscode-test', 'coverage',
    '.cache', '.parcel-cache', 'bower_components', '.svn', '.hg',
];

// 視為文字檔的副檔名（其餘以 NUL byte 偵測二次判斷）
$OC_TEXT_EXT = [
    'txt','md','markdown','json','jsonc','json5','xml','yml','yaml','toml','ini','cfg','conf','env',
    'php','phtml','js','mjs','cjs','jsx','ts','tsx','vue','svelte','css','scss','sass','less',
    'html','htm','twig','blade','ejs','hbs','pug','astro',
    'py','rb','go','rs','java','kt','kts','swift','c','h','cpp','hpp','cc','cs','m','mm',
    'sh','bash','zsh','fish','ps1','psm1','bat','cmd','sql','graphql','gql','proto',
    'lua','pl','r','dart','ex','exs','erl','hs','clj','scala','groovy','gradle',
    'gitignore','gitattributes','editorconfig','htaccess','dockerfile','makefile','lock','log','csv','tsv','srt','vtt','patch','diff',
    // svg 是 XML 文字：要能被 read_file 讀、被 grep 搜尋、在編輯器裡改。
    // oc_is_text() 先查本白名單再看圖片清單，所以放這裡會贏過 $OC_IMAGE_EXT。
    'svg',
];

// 圖片副檔名（read_file 自動轉多模態附件）
$OC_IMAGE_EXT = ['png','jpg','jpeg','gif','webp','bmp','svg','ico','avif'];
