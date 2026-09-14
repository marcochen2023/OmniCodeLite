# Omni Code

網頁版 AI Agent / IDE，對標 Claude Code。在本機 XAMPP（PHP 8.2 + Apache）上執行，
使用者打一句話，AI 就能自動判斷路由、讀寫檔案、執行命令、操作整個前端介面。

## 技術棧

- **後端**：PHP 8.2，零框架、零 composer。可用擴充只有 `curl` / `json` / `mbstring` / `openssl`
  （**沒有 zip、沒有 pdo**，不要寫依賴它們的程式碼）
- **前端**：零建置。傳統 `<script>` 依序載入，共用 `window.OC` 全域狀態，無模組系統
- **CDN**：marked、DOMPurify、highlight.js、CodeMirror 5.65.16、Google Fonts
- **資料**：純 JSON 檔案（`data/`），無資料庫

## 目錄結構

- `docs/ARCHITECTURE.md` — **唯一契約**。改任何端點或跨模組介面前必讀
- `includes/helpers.php` — 所有 PHP 共用函式（`oc_boot` / `oc_ok` / `oc_fail` / `oc_path` …）
- `api/*.php` — direct-hit 端點，每支自帶標頭，不依賴 rewrite
- `app/js/` — 前端模組，**載入順序即依賴圖**（見 `app/index.html` 底部）
- `skills/*/SKILL.md` — 內建技能包（YAML frontmatter + Markdown 正文）
- `data/` — 執行期狀態（設定、會話、記憶、shell 日誌）。已用 `.htaccess` 擋掉 HTTP 存取

## 常用指令

本專案**不指定** `驗證命令：`，改用 `verify` 工具的內建語法檢查——
它會逐檔跑 `node --check` / `php -l` 並指出是哪一個檔案壞掉，
比一行 for 迴圈的輸出好讀得多。

> 若之後要覆寫，格式是 `驗證命令：<命令>`，且**命令會經由 Windows cmd 執行**。
> 不要寫 bash 語法（`for f in …; do … done` 在 cmd 下會直接報
> `f was unexpected at this time.`）。

```bash
# 語法檢查（沒有測試框架，這是主要的驗證手段）
"D:/xampp/php/php.exe" -l api/fs.php

# 全部 PHP 檔一次檢查
for f in api/*.php includes/*.php *.php; do "D:/xampp/php/php.exe" -l "$f"; done

# 端點煙霧測試
curl -s "http://localhost/app/OmniCode/api/settings.php?action=get"
```

開發網址：`http://localhost/app/OmniCode/app/`

## 程式風格

**PHP**
- 4 空格縮排，單引號優先
- 函式一律 `oc_` 前綴（避免與其他 XAMPP 專案衝突）
- 每支端點：`require_once helpers.php` → `oc_boot()` → `switch ($action)`
- 回應一律走 `oc_ok()` / `oc_fail()`，never echo 原始 JSON（`relay.php` 的 SSE 直通是唯一例外）
- 所有使用者提供的路徑必須經過 `oc_path()`，不可手動字串拼接

**JavaScript**
- 檔案開頭 `'use strict';`，結尾一次 `Object.assign(window, {...})` 匯出
- 4 空格縮排，單引號，語句結尾加分號
- 區塊註解用 `// ═══ 標題 ═══` 分隔
- 用 `utils.js` 既有的 helper（`$` / `el` / `esc` / `toast` / `confirmModal` …），不要重複實作
- 組 DOM 用 `el()`；用 innerHTML 時每個插值都要 `esc()`

**共通**
- 使用者可見字串與程式碼註解一律**繁體中文（台灣用語）**
- 錯誤訊息要能讓 AI 自我修正：說明「錯在哪」+「該怎麼做」

## 注意事項

- **Windows 非阻塞管道無效**：`stream_set_blocking($pipe, false)` 對 Windows 的
  程序管道沒有作用，`fread` 會一路擋到 EOF，導致任何 deadline 判斷形同虛設。
  `exec.php` 與 `mcp.php` 都改用「stdout/stderr 導向暫存檔 + 每次 fseek 追讀」——
  **不要改回管道**，否則逾時會失效並卡死請求
- **cmd 只執行第一行**：`cmd /c "多行內容"` 只跑到第一個換行就結束，其餘靜默丟棄
  且仍回報 exit 0。`exec.php` 遇到換行或非 ASCII 一律改寫成暫存 `.bat` 執行
  （非 ASCII 也必須走 .bat：命令列用系統 OEM 碼頁，中文會變成 `??????`）
- **cmd 的 exit /b 陷阱**：`A && (B && exit /b 1) || exit /b 0` 不會如預期結束 ——
  括號內的 `exit /b` 只設定 errorlevel 就繼續往下，接著 `||` 被觸發而回傳 0。
  要靠結束碼表達成敗（hooks 的 PreToolUse、OMNI.md 的驗證命令）一律用多行寫法，
  最後一行單獨 `exit /b N`。這個坑會靜默失效：命令看起來有跑、訊息也印了，就是不生效
- **背景程序 PID**：Windows 的 `start /b` 拿不到 PID，`exec.php` 在 kill 時才用
  `wmic` 反查。這是刻意的
- **大型工作區**：`glob`/`grep` 有前綴最佳化與時間預算（見 ARCHITECTURE.md §3.1）。
  改動 `oc_fs_collect` 時務必保守：猜錯走訪起點會**靜默回傳空結果**，那比慢更糟
- **壓縮切點**：`safeSplitIndex` 找不到安全切點時回傳 `-1`，呼叫端必須退回微壓縮。
  切在 `tool_use` / `tool_result` 之間會讓四家供應商全部回 400 且無法自行復原
- **完整讀檔**：任何要寫回磁碟的緩衝區一律用 `FS.readAll()`，不可用 `FS.read()`——
  後端單次上限 5000 行，用 `FS.read` 存檔會把超出的部分永久刪掉
- **SSE 串流**：`relay.php` 的 `chat` action 必須 `oc_boot(false)` 且自行送標頭；
  其他 action 要記得補 `Content-Type: application/json`
- **Gemini schema**：Gemini 只吃 OpenAPI 3.0 子集，工具 schema 必須經
  `api.js` 的 `normalizeSchema(schema, 'gemini')` 清洗
- **Gemini thoughtSignature**：Gemini 3 回應 part 上的 `thoughtSignature` 必須在下一輪
  原樣送回（存在 block 的 `_sig`），否則 400。沒有簽章的工具呼叫要連同其 `tool_result`
  一起降級成文字——舊會話與跨供應商切換一定會遇到。改 `msgsForGemini` 時別動這段
- **Anthropic 直連**：瀏覽器呼叫必須帶 `anthropic-dangerous-direct-browser-access: true`
- **新版 Claude 模型**：不接受 `temperature` / `top_p`，傳了會被拒絕
- 新增前端模組時，記得同時加進 `app/index.html` 的 script 清單**與正確的順序位置**
