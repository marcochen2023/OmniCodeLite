# Omni Code — 架構與 API 契約

> 網頁版 AI Agent / IDE，對標 Claude Code。本地端 XAMPP + PHP 8.2 執行，
> 前端零建置（plain `<script>` + CDN），Agent 對指定工作區擁有 100% 檔案權限
> 與前端全局控制權（Computer Use 級路由）。
>
> **本文件是唯一契約**：所有平行開發的檔案都必須嚴格遵守此處定義的
> 端點、JSON 形狀、全域函式名稱與 DOM id。

---

## 0. 名詞與整體資料流

```
使用者輸入一句話
   ↓
app/js/agent.js  runAgentTurn()          ← Agent 主迴圈（對標 Claude Code）
   ↓ 組裝 system prompt（OMNI.md + 記憶 + 環境 + 技能清單 + 工具目錄）
app/js/api.js    streamChat()            ← 四家供應商串流 + 原生 function calling
   ↓ 模型回傳 tool_use blocks
app/js/permissions.js  checkPermission() ← 權限閘（4 種模式 + 規則引擎）
   ↓
app/js/tools.js  execTool()              ← 工具執行器（30+ 內建 + MCP 動態）
   ├─ 檔案類 → api/fs.php
   ├─ 命令類 → api/exec.php
   ├─ 網路類 → api/relay.php
   ├─ 前端控制類 → 直接操作 DOM / 呼叫 window.* （Computer Use）
   └─ MCP     → api/mcp.php
   ↓ tool_result 回填 messages
   ↺ 迴圈直到模型不再呼叫工具
```

**執行環境**：`http://localhost/app/OmniCode/app/`
**PHP**：8.2.12（ZTS，Windows）— 可用擴充：curl / json / mbstring / openssl。**無 zip、無 pdo_mysql 需求**（本專案不使用資料庫）。

---

## 1. 目錄結構

```
D:\xampp\htdocs\app\OmniCode\
├── index.php                 # 轉址到 app/
├── router.php                # php -S 開發伺服器路由（與 Apache 行為一致）
├── README.md
├── docs/ARCHITECTURE.md      # 本檔
├── OMNI.md                   # 本專案自身的 Agent 指示檔（範例）
├── mcp-server.php            # MCP server（php-cli，stdio）—— 見 §8.9
├── includes/
│   ├── config.php            # 常數（資料目錄、預設工作區、限制值）
│   ├── policy.php            # 敏感檔／命令政策清單（見 §8.8）
│   └── helpers.php           # JSON 封套 / 路徑安全 / CORS / 本機守門
├── api/
│   ├── .htaccess             # 僅擋非 .php 直接存取 + 關閉 SSE 緩衝
│   ├── settings.php          # 工作區設定、磁碟瀏覽、金鑰、MCP 設定
│   ├── fs.php                # 檔案系統完整 CRUD + glob + grep + tree
│   ├── exec.php              # 命令執行（前景 / 背景 shell）
│   ├── relay.php             # AI 供應商串流中繼 + WebFetch + WebSearch
│   ├── sessions.php          # 會話持久化 + 記憶檔案 + 跨會話錯誤記憶
│   ├── usertools.php         # 自撰宣告式 API 工具的註冊與執行（見 §8.8）
│   ├── codegraph.php         # 結構化程式碼圖譜（Graft Tier-1 移植，見 §8.11）
│   ├── selfimprove.php       # 自我提升歷程與版本規劃（見 §8.10）
│   └── mcp.php               # MCP 伺服器代理（http / stdio）
├── data/                     # 伺服器狀態（.htaccess Deny）
│   ├── .htaccess
│   ├── config.json           # 執行期設定（工作區、模式、MCP、金鑰選存）
│   ├── sessions/<sid>.json   # 會話存檔
│   ├── shells/<id>.log       # 背景命令輸出
│   └── memory/*.md           # 使用者層級（跨專案）記憶
├── skills/<name>/SKILL.md    # 內建技能包
└── app/
    ├── .htaccess             # ★ 前端資源一律 no-store（見下方說明）
    ├── index.html            # IDE 外殼（唯一 HTML）
    ├── css/styles.css        # Aurora-Dark 設計系統
    └── js/                   # 載入順序 = 依賴圖，見 §9
```

**工作區（workspace）**：Agent 擁有 100% 權限的目錄，
**預設為 Omni Code 自己的目錄**（`dirname(includes/)`），而不是整個 `htdocs` —— 
htdocs 底下常有數十萬個檔案，一開啟就當工作區會讓搜尋與檔案樹又慢又難用。
可在前端「工作區選擇器」改成任意存在的資料夾，存於 `data/config.json`。
所有 `api/fs.php` 路徑一律是**工作區相對路徑**（POSIX 斜線，如 `app/js/agent.js`），
越界（`..` 逃逸、絕對路徑、符號連結指向外部）一律 403。

---

## 2. 後端通則

### 2.1 回應封套

**全部**端點統一：

```json
{ "ok": true,  ...payload }
{ "ok": false, "error": "中文錯誤訊息", "detail": "可選技術細節" }
```

失敗時同時設定 HTTP 狀態碼（400 參數錯誤 / 403 越權 / 404 不存在 / 409 衝突 / 500 內部）。
`json_encode(..., JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES|JSON_INVALID_UTF8_SUBSTITUTE)`。

### 2.2 呼叫方式（direct-hit，不依賴 rewrite）

前端一律以相對路徑呼叫：`../api/fs.php?action=read&path=...`。
沿用 OmniPD 的 `fs.php` 模式：每個 PHP 檔自帶標頭與 OPTIONS 204 處理，
在子目錄部署（`/app/OmniCode/`）下可直接運作，無需任何 `.htaccess` rewrite。

### 2.3 安全守門（`includes/helpers.php`）

```php
oc_guard_local();   // 僅允許 127.0.0.1 / ::1 / localhost 存取；否則 403 exit
oc_cors();          // Access-Control-Allow-Origin: * + OPTIONS 204 exit
oc_input();         // json_decode(php://input) ?: []，並合併 $_GET
oc_ok($arr=[]);     // echo {"ok":true,...} exit
oc_fail($msg,$code=400,$detail=null);
oc_cfg();           // 讀 data/config.json（含預設值合併）
oc_cfg_save($cfg);
oc_ws();            // 目前工作區絕對路徑（已 realpath 正規化，斜線統一為 /）
oc_path($rel);      // 工作區相對路徑 → 絕對路徑；越界時 oc_fail(403)。
                    // 規則：拒絕含 NUL、拒絕 Windows 磁碟前綴、逐段拒絕 '..'，
                    // 組合後對「已存在的最深祖先」realpath 前綴比對工作區。
oc_rel($abs);       // 絕對路徑 → 工作區相對路徑
oc_is_text($abs);   // 以副檔名白名單 + NUL byte 偵測判斷是否文字檔
oc_mime($abs);
oc_log($chan,$msg); // data/logs/<chan>.log
```

**這是唯一的安全邊界**：Agent 在工作區內有 100% 權限（新增 / 刪除 / 修改 / 移動），
工作區外一律拒絕；服務僅接受本機連線。

### 2.4 前端資源不快取（`app/.htaccess`）

Omni Code 是一個「AI 會即時改自己前端程式碼」的工具。只要瀏覽器快取了舊的
`.js` / `.css`，使用者就會看到**改了卻沒生效**的假象——原始碼是新的、執行的是舊的，
而且極難察覺（開發過程中確實踩過這個坑）。因此 `app/` 目錄一律
`Cache-Control: no-store` 並移除 `ETag` / `Last-Modified`，重新整理即見最新結果。

---

## 3. `api/fs.php` — 檔案系統（Agent 的手）

所有 `path` / `from` / `to` 皆為工作區相對路徑，`""` 或 `"."` 代表工作區根。

**額外工作資料夾**（`extra:<alias>/…`）：對話欄 `folder_open` 按鈕掛載的
工作區外目錄，跟著目前對話走（上限 5 個，後端 `settings.php extra_add/remove/sync`）。
守門仍在 `oc_path()` 單一入口：`extra:` 前綴解析到掛載的根並做同樣的
realpath 越界檢查；未掛載的 alias 或掛載外的絕對路徑一律 403。
`oc_rel()` 反向把落在額外根下的絕對路徑寫回 `extra:<alias>/…`。

| action | 方法 | 參數 | 回應 |
|---|---|---|---|
| `list` | GET | `path`, `show_hidden`(0/1) | `{entries:[{name,path,type:"dir"\|"file",size,mtime,ext,binary}]}` 目錄優先、名稱排序 |
| `tree` | GET | `path`, `depth`(預設 2), `limit`(預設 2000) | `{tree:{name,path,type,children:[…]}, truncated}` |
| `read` | GET | `path`, `offset`(1-based 起始行), `limit`(行數，預設 2000) | `{content, lines, total_lines, offset, truncated, size, mtime, binary, mime}`；`content` 為**純內容**（不含行號，行號由前端/工具層加） |
| `read_b64` | GET | `path`, `max`(bytes) | `{data, mime, size}` — 圖片/二進位 |
| `write` | POST | `{path, content, create_dirs:true}` | `{size, mtime, created:bool}` |
| `write_b64` | POST | `{path, data(base64 或 dataURL), create_dirs}` | `{size, mtime}` |
| `edit` | POST | `{path, old_string, new_string, replace_all:false}` | `{replaced:int, size, mtime}`；`old_string` 不存在→404「找不到要取代的內容」；`replace_all=false` 且出現多次→409「出現 N 次，需唯一或用 replace_all」 |
| `multi_edit` | POST | `{path, edits:[{old_string,new_string,replace_all}]}` | `{applied:int, size, mtime}` — 全有全無（任一失敗則不寫入） |
| `mkdir` | POST | `{path}` | `{created:bool}` |
| `delete` | POST | `{path, recursive:false}` | `{deleted:int}` — 目錄非空且 `recursive=false`→409 |
| `move` | POST | `{from, to, overwrite:false}` | `{ok}` |
| `copy` | POST | `{from, to, overwrite:false}` | `{copied:int}` — 支援目錄遞迴 |
| `glob` | GET | `pattern`(如 `**/*.php`), `path`, `limit`(預設 500) | `{files:[rel…], truncated, timed_out?, hint?}` 依 mtime 新→舊 |
| `grep` | POST | `{pattern, path, glob, mode:"content"\|"files"\|"count", ignore_case, context, limit, multiline, literal}` | content: `{matches:[{file,line,text,before[],after[]}], scanned, truncated, timed_out?, hint?}`；files: `{files:[…]}`；count: `{counts:[{file,count}]}` |
| `stat` | GET | `path` | `{exists,type,size,mtime,ctime,readonly,mime,lines?}` |
| `download` | GET | `path` | 原始檔案串流（`Content-Disposition: attachment`） |
| `upload` | POST | multipart `file[]`, `path`(目標目錄) | `{files:[{path,size}]}` |

**排除清單**（glob/grep/tree 預設略過）：`.git`, `node_modules`, `vendor`, `dist`, `build`, `.next`, `__pycache__`, `.venv`, `data/shells`。可用參數 `no_ignore=1` 關閉。

**grep 實作**：純 PHP 逐檔逐行掃描（不依賴 ripgrep）；`pattern` 預設為 PCRE，
`literal=1` 時以 `preg_quote` 包裝（非 literal 時亦會逃脫分隔符 `#`，避免樣式跳出分隔符）。
`multiline=1` 時整檔比對並回報首行行號。單檔 >5MB 或二進位自動跳過。

### 3.1 效能護欄（大型工作區的關鍵）

工作區可能有數十萬個檔案（例如整個 `htdocs`）。以下三道護欄缺一不可：

1. **glob 前綴最佳化**（`oc_fs_glob_base`）：從樣式抽出不含萬用字元的目錄前綴，
   直接從該目錄開始走訪。`app/js/**/*.ts` 只走 `app/js`，不走整棵樹。
   實測差異：**58 秒 → 0.06 秒**。前綴目錄不存在時直接回空陣列，不走訪。
2. **走訪時間預算**（`OC_FS_WALK_SECS` = 8 秒）：列舉檔案本身也有上限。
3. **grep 掃描預算**（`OC_FS_GREP_SECS` = 12 秒、`OC_FS_GREP_BYTES` = 96MB）：
   超出時回傳**部分結果**並附上 `timed_out:true` 與中文 `hint`，
   而不是讓請求無限期卡住。前端與工具層都必須把 `hint` 原文轉達給使用者／模型，
   否則會誤報成「找不到」——那會讓使用者以為專案裡真的沒有那段程式碼。

---

## 4. `api/exec.php` — 命令執行

| action | 方法 | 參數 | 回應 |
|---|---|---|---|
| `run` | POST | `{command, cwd(工作區相對), timeout(ms,預設 120000,上限 600000)}` | `{stdout, stderr, exit_code, duration_ms, truncated, timed_out}` |
| `start` | POST | `{command, cwd}` | `{shell_id}` — 背景執行，輸出寫入 `data/shells/<id>.log` |
| `output` | GET | `shell_id`, `since`(byte offset) | `{chunk, offset, running, exit_code}` |
| `kill` | POST | `{shell_id}` | `{ok}` |
| `list` | GET | — | `{shells:[{id,command,cwd,running,started,exit_code}]}` |

**實作**：`proc_open` + `cmd.exe /d /s /c`（Windows）或 `/bin/sh -c`；
非阻塞讀取 stdout/stderr pipes + `usleep(20000)` 輪詢 + 逾時 `proc_terminate`。
輸出上限 200KB（超過從中間截斷並標記 `truncated`）。
背景模式以 `start /B cmd /c "… > log 2>&1"` 啟動並記錄 PID 至 `data/shells/<id>.json`。
`cwd` 必須通過 `oc_path()` 檢查。

---

## 5. `api/relay.php` — AI 中繼 / 網路

前端預設 **direct 直連**（速度最快、金鑰不離開瀏覽器）；
遇 CORS/網路錯誤自動改走 relay（`transport` 設定可強制）。

| action | 方法 | 參數 | 回應 |
|---|---|---|---|
| `chat` | POST | `{provider, url, headers:{}, body:{}, stream:true}` | **SSE 直通**：原樣轉發上游 `text/event-stream` 位元組流，`Content-Type: text/event-stream`、關閉緩衝 |
| `json` | POST | 同上，`stream:false` | 上游 JSON 原樣回傳（含 HTTP 狀態碼） |
| `fetch` | POST | `{url, max_chars:100000, format:"text"\|"html"\|"markdown"}` | `{url, status, title, content, truncated, via}` — HTML 去除 script/style/nav 後轉純文字；直連失敗自動降級 Jina Reader（`via:"jina-reader"`），驗證頁會被拒收 |
| `search` | POST | `{query, limit:5}` | `{results:[{title,url,snippet}], engine}` — 依序嘗試：DuckDuckGo HTML → DDG Lite → Bing RSS；皆失敗回 `ok:false` |

**安全**：`url` 必須是 `http(s)://`；`chat`/`json` 的 `url` 必須落在供應商白名單網域
（`generativelanguage.googleapis.com`, `api.openai.com`, `api.anthropic.com`, `openrouter.ai`）
或 `data/config.json` 的 `extraApiHosts`。避免變成開放代理。
`fetch`/`search` 不限網域但擋掉私有網段（127./10./192.168./169.254./::1）以外的判斷交給使用者。

**串流實作**：`curl_setopt(CURLOPT_WRITEFUNCTION)` 內 `echo $chunk; @ob_flush(); flush();`，
搭配 `@ini_set('output_buffering','0')`、`@ini_set('zlib.output_compression','0')`、
`header('X-Accel-Buffering: no')`、`while(ob_get_level()) ob_end_flush();`。

---

## 6. `api/sessions.php` — 會話與記憶

| action | 方法 | 參數 | 回應 |
|---|---|---|---|
| `list` | GET | `limit` | `{sessions:[{id,title,ws,created,updated,msg_count,tokens,model}]}` 依 updated 新→舊 |
| `get` | GET | `id` | `{session:{…}}` |
| `save` | POST | `{id, session}` | `{updated}` — session 形狀見 §11.4 |
| `delete` | POST | `{id}` | `{ok}` |
| `export` | POST | `{id, format:"md"\|"json"}` | `{content, filename}` |
| `memory_list` | GET | `scope:"project"\|"user"\|"all"` | `{memories:[{name,description,type,scope,path,updated}], index}` |
| `memory_get` | GET | `scope`, `name` | `{content, path}` |
| `memory_save` | POST | `{scope, name, content}` | `{path}` |
| `memory_delete` | POST | `{scope, name}` | `{ok}` |
| `omni_md` | GET | — | `{content, path, exists}` — 讀工作區根的 `OMNI.md` |

**記憶儲存位置**
- `scope=project` → `<workspace>/.omni/memory/<name>.md`，索引 `<workspace>/.omni/MEMORY.md`
- `scope=user` → `data/memory/<name>.md`，索引 `data/memory/MEMORY.md`
- `OMNI.md` → `<workspace>/OMNI.md`（等同 Claude Code 的 `CLAUDE.md`）

記憶檔案格式（frontmatter + 內文）：
```markdown
---
name: kebab-case-slug
description: 一行摘要（recall 時判斷相關性用）
type: user | feedback | project | reference
updated: 2026-07-31
---
內文。可用 [[other-slug]] 連結其他記憶。
```

---

## 7. `api/mcp.php` — MCP 代理

伺服器設定存於 `data/config.json` 的 `mcpServers`：
```json
{
  "filesystem": { "type":"stdio", "command":"npx", "args":["-y","@modelcontextprotocol/server-filesystem","D:/xampp/htdocs"], "env":{}, "enabled":true },
  "docs":       { "type":"http",  "url":"http://localhost:3001/mcp", "headers":{}, "enabled":true }
}
```

| action | 方法 | 參數 | 回應 |
|---|---|---|---|
| `servers` | GET | — | `{servers:{name:{type,enabled,status,tool_count,error}}}` |
| `tools` | GET | `server`(可省略=全部) | `{tools:[{server,name,description,input_schema}]}`（快取於 `data/mcp-cache.json`，可 `refresh=1`） |
| `call` | POST | `{server, name, arguments}` | `{result:{content:[{type:"text",text}],isError}}` |
| `save` | POST | `{servers}` | `{ok}` |
| `test` | POST | `{name}` | `{ok, tool_count, error}` |

**stdio 實作**：每次呼叫 `proc_open` 啟動程序，依序送出 JSON-RPC：
`initialize`(protocolVersion `2025-06-18`, clientInfo `{name:"omni-code",version:"1.0"}`)
→ `notifications/initialized` → `tools/list` 或 `tools/call` → 關閉。
逾時 30s。工具名對外統一前綴為 `mcp__<server>__<tool>`。
**http 實作**：POST JSON-RPC 到 `url`，接受 `application/json` 或 SSE 回應。

---

## 8. `api/settings.php` — 設定與工作區

| action | 方法 | 參數 | 回應 |
|---|---|---|---|
| `get` | GET | — | `{config:{workspace, permissionMode, transport, model, imageModel, autoCompactAt, maxTurns, thinking, mcpServers, extraApiHosts, allowRules[], denyRules[], keysOnServer:{provider:bool}}, env:{php,os,workspace_exists,workspace_writable}}` |
| `set` | POST | `{config}` | `{config}` — 淺層合併 |
| `browse` | GET | `path`(絕對，省略=列出磁碟機) | `{cwd, parent, dirs:[{name,path}], drives:[…]}` — **不受工作區限制**，供選擇工作區用 |
| `set_workspace` | POST | `{path}` | `{workspace}` — 必須存在且可寫 |
| `extra_add` | POST | `{alias, path}` | `{roots, alias}` — 掛載額外資料夾（上限 5；同路徑已掛則回現況） |
| `extra_remove` | POST | `{alias}` | `{roots}` — 卸載 |
| `extra_sync` | POST | `{roots:[{alias,path}]}` | `{roots}` — 切換對話時同步作用中授權（不存在的靜默丟掉） |
| `keys_set` | POST | `{provider, key}` | `{ok}` — 選擇性把金鑰存到伺服器（`data/config.json`，僅本機可讀）；空字串=刪除 |
| `keys_status` | GET | — | `{gemini:bool, openai:bool, anthropic:bool, openrouter:bool}` |

---

## 8.5 `api/video.php` — 影片／音訊多模態分析

為什麼在 PHP 做而不是瀏覽器：影片動輒幾十到幾百 MB，讀進瀏覽器記憶體再
base64 上傳等於把檔案脹大三分之一塞進 JS heap。PHP 直接從工作區磁碟串流
給 Google，前端只傳一個路徑。

| 路徑 | 條件 | 做法 |
|---|---|---|
| inline | ≤ 19MB | `inline_data` 一次呼叫（總請求上限 20MB，留 1MB 給提示詞）|
| Files API | > 19MB（上限 500MB）| 續傳上傳 → 輪詢到 ACTIVE → `file_uri` 呼叫 → 用完刪除 |

實測：0.18MB 音訊 inline 12.7 秒；21.4MB 音訊經 Files API 全程 19.4 秒，
時長判斷精確到秒（700 秒的檔案，模型回答 11 分 39 秒）。

金鑰由前端隨請求帶入（與 relay.php 同一信任模型：oc_guard_local 已保證
只有本機能呼叫）。只對 generativelanguage.googleapis.com 發請求，主機寫死
—— 不是開放代理。影片要等 Google 轉檔完（PROCESSING → ACTIVE）才能用，
拿 PROCESSING 中的檔案去 generateContent 會直接 400，所以一定要輪詢。

---

## 8.6 批次與多模態工具（tools.js 新增）

四個工具，對應四種「一次很多個」的工作型態：

| 工具 | 做什麼 | 關鍵設計 |
|---|---|---|
| `read_files` | 一次讀最多 8 個文字檔 | 總量 160k 字元預算，超出的檔案明講「未讀取」而不是靜默截斷 |
| `read_images` | 一次讀最多 8 張圖（多模態）| 自動縮到 1024px JPEG —— 分類用途不需要原解析度，全尺寸的話一批 8 張就是幾十 MB 跟著每輪重送 |
| `generate_images` | 依序生成最多 20 張圖 | 單張失敗不中斷整批；save_to 省略時自動編號；已生成的檔案在中止時保留（花了錢的成果）|
| `analyze_video` | 影音分析（走 video.php）| 結果建議 save_to 存檔；產「影片生成提示詞」時要求依內容不規則切分並標起訖時間 |

**工具回傳多張圖的管線**：工具回 `attachImages` 陣列 → execTool 原樣帶出 →
agent.js 收進 extraImages → 以「獨立 user 訊息」附上（多數供應商不允許
tool_result 內嵌圖片）。四種供應商格式都驗證過圖片塊與 tool_result 並存能存活。

**舊圖自動剪枝**（memory.js microCompact）：工具附上的圖標記 `_tool: true`，
超出最近 12 則訊息的舊圖會被換成一行文字stub。分類 100 張照片時，
已經分析完的圖每一輪還跟著重送純屬燒錢 —— 使用者自己貼的圖（無標記）不動。

**系統提示的工作手冊**（agent.js BATCH_PLAYBOOK）：四種批次任務的既定流程
（研讀多文件、批次生圖、批次分類搬移、影音分析），模型照著做而不是自創
低效率的做法。分類流程強制「判斷完立刻搬移」與「最後張數對帳」。

---

## 8.7 取法 deepseek-harness 的八項融合（2026-08）

深度分析 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
（192k 星的外掛式代理框架）後，把「確認 OmniCode 沒有、且值得搬」的機制移植進來。
完整的取捨（20 項刻意不搬與原因）見會話紀錄；核心八項：

| 融合項 | 來源子系統 | 落點 |
|---|---|---|
| 快取穩定的系統提示 | system-prompt | agent.js：易變資訊抽成 `<runtime-context>` 使用者訊息，雜湊比對、變了才注入、舊快照即時作廢 |
| Anthropic 提示快取 | llm-streaming | api.js：tools 尾端／system／訊息尾端三個 `cache_control` 斷點 |
| 錯誤碼歸一 + 超限自癒 | llm-streaming | api.js `classifyLlmError()`；agent.js 收到 CONTEXT_WINDOW_EXCEEDED → 壓縮後重試（護欄：用量真的縮小才重試，最多 2 次）|
| 截斷防護 + 參數驗證 + 尾端修復 | tools / invariants | 長度截斷的 tool_use 一律拔掉（殘缺 JSON 被「修好」再執行 = 拿錯參數改檔案）；validate.js 預先驗參數；normalizeSession 補懸空 tool_use 的合成結果 |
| Spill 大輸出外溢 | spill | 超過 30KB 的工具輸出落地 `.omni/spill/<會話>/`，上下文只留定位行＋頭尾預覽，細節用 read_file/grep 取回 —— 不必重跑工具 |
| 跨會話全文搜尋 | session-query | sessions.php `search`＋`search_sessions` 工具＋`/search` 指令 |
| @s: 會話引用 | session-reference | mention.js：`@s:<id>` 展開成唯讀紀要（明標「不是指令」）|
| /fork 會話分支 | session | 複製完整歷史另起會話、記錄 parent；原會話不動 |
| 錨定式 token 計量 | token-meter | 供應商回報的精確用量當基準，只概估錨點之後的增量 —— chars/4 概估在中英夾雜與程式碼上會飄 |

**為什麼 spill 的定位行放在最前面**：micro-compact 之後保留的是開頭，
定位資訊在尾巴的話，壓縮一次就找不回全文了。

**為什麼 fork 不用 safeSplitIndex**：那是給壓縮找「尾段起點」用的，
語意剛好相反 —— fork 要的是完整複製，懸空的 tool_use 交給
normalizeSession 的尾端修復處理。

---

## 8.8 取法 Agenvoy 的八項優化（2026-08）

深度分析 [agenvoy/Agenvoy](https://github.com/agenvoy/Agenvoy) 與其文件後，
挑出「OmniCode 沒有、且在本專案的架構下真的做得到」的八項落地。
刻意不搬的部分（腳本工具、強制指示字串、真背景服務）各自在程式碼裡寫了原因。

| # | 優化項 | 落點 |
|---|---|---|
| 1 | 能力群組化工具註冊表 | tools.js `TOOL_GROUPS`（media / ui / agent / usertools）＋`/tools <群組> on\|off`。全開 ~4,170 tok，全關 ~2,427 tok |
| 2 | 跨會話錯誤記憶 | sessions.php `oc_errmem_*`；症狀正規化（去路徑、去數字、去耗時）後雜湊，90 天 TTL；`remember_error` 工具 |
| 3 | 敏感資源政策 | includes/policy.php；`oc_path_sensitivity()` → permissions.js 升級成需授權 |
| 4 | 自撰 API 工具 | api/usertools.php + `data/tools/api/*.json`；`edit_tool`／`test_tool`；skills/tool-author |
| 5 | 模型冷卻與後備鏈 | api.js `MODEL_COOLDOWN`（30 分鐘）；開延伸思考時只在同一種請求格式內換 |
| 6 | 網路快取與同回合去重 | tools.js `NET_CACHE`（30 分鐘／50 筆）＋`DEDUPE_TOOLS`；快取檢查排在 PreToolUse hook 之前 |
| 7 | MCP server 模式 | mcp-server.php —— 見 §8.9 |
| 8 | 排程執行 | schedule.js；★ 只在分頁開著時活著（PHP 那側沒有 LLM 迴圈可跑）|

**#3 的兩半性質完全不同**：檔案那半（`oc_policy_is_sensitive`）是真的強制，
它擋在 `oc_path()` 這個唯一入口上；命令那半（`oc_policy_cmd_risk`）只是防手滑
—— PHP 的字串掃描擋不住 eval／base64／變數組出來的命令名。

**policy.php 必須在 helpers.php 的檔案最外層 require**。在函式裡 require 的話，
`$OC_DENIED_*` 會變成該函式的區域變數，`oc_policy_is_sensitive()` 裡的 `global`
全部拿到 null —— 而且是安靜地失效，因為 `oc_boot()` 關掉了 warning，
每個金鑰檔都會回報「不敏感」。

**#4 只做宣告式那一半**。沒有 bwrap／sandbox-exec 的環境不該讓 agent
寫可執行程式碼。工具是一份描述 HTTP 請求的 JSON，由 PHP 用 curl 執行；
`{參數}` 代入（URL 內自動 urlencode），`{{SECRET:名稱}}` 從 `data/secrets.json`
取值 —— 金鑰不進工具定義、不進對話上下文。`test_tool` 刻意「不寫入註冊表就能測」。
`usertools` 群組出廠關閉：它能用儲存的金鑰對外發任意 POST／DELETE，比只讀的
`web_fetch` 高一階。

---

## 8.9 `mcp-server.php` — 對外的 MCP server

把 OmniCode 的檔案系統與自撰 API 工具，用 MCP 協定接給別的客戶端。

```bash
php mcp-server.php        # stdio transport，逐行 JSON-RPC 2.0
```

Claude Desktop 設定：

```json
{"mcpServers": {"omnicode": {
  "command": "D:/xampp/php/php.exe",
  "args": ["D:/xampp/htdocs/app/OmniCode/mcp-server.php"]
}}}
```

支援 `initialize` / `tools/list` / `tools/call` / `ping`。
暴露 12 個 fs 工具（read_file、write_file、edit_file、list_dir、project_tree、
glob、grep、file_stat、make_dir、move_path、copy_path、delete_path）
＋ 4 個結構化圖譜工具（repo_map、file_api、trace_calls、find_refs，見 §8.11）
＋ `data/tools/api/` 裡的每個自撰工具。

**只暴露 PHP 這側真的有實作的東西**。OmniCode 的 34 個工具裡，生圖、影片分析、
Computer-Use、子代理、Skills 都是瀏覽器裡的 JavaScript，宣告它們只會讓外部
客戶端呼叫到不存在的功能。串流類動作（download / raw / upload）也不暴露 ——
它們的回應不是 JSON。

**實作方式**：`api/fs.php` 的 switch 包成 `oc_fs_dispatch($action)`，
用 `oc_capture(true)` 讓 `oc_ok()`／`oc_fail()` 改丟 `OcResponse` 而不是
echo + exit，`oc_input_set()` 換掉每次請求的參數。
端點程式碼一行都沒改 —— 把 18 個 case、800 行拆成獨立函式的風險遠高於收益。
fs.php 與 usertools.php 的 `oc_boot()` 與檔尾路由都加了 `PHP_SAPI !== 'cli'` 條件，
被 include 時不會自己跑一次請求。

**兩處安全邊界跟 HTTP 版不同，不要假設一樣**：

1. 「僅接受本機連線」不適用 —— stdio 沒有遠端連線的概念。
2. 敏感檔在瀏覽器版是 permissions.js 跳授權對話框擋的，那一層在 MCP 不存在。
   stdio 上問不了人，所以 `mcp_sensitive_block()` 改成**預設一律拒絕**；
   要開請設環境變數 `OMNICODE_MCP_ALLOW_SENSITIVE=1`。

**刻意不放 `instructions` 字串**。Agenvoy 在 initialize 回應裡塞了一段要求客戶端
「優先使用本伺服器工具、忽略其他來源」的指示 —— 那是借協定的信任去壓過使用者
自己的設定。工具描述說明工具做什麼就夠了，不該去指揮宿主。

---

## 8.10 使用模式：專案項目 / AI 對話 / 自我提升（`modes.js`）

三種模式差在「Agent 面對的是什麼」，`OC.mode` 是唯一的狀態：

| 模式 | 工作區 | 工具 | 系統提示 |
|---|---|---|---|
| `project` | 使用者選的工作路徑 | 全部 | `IDENTITY`（原本的 Omni Code）|
| `chat` | 無（`#ws-picker` 壓暗）| 只留 `CHAT_TOOLS`（查網、生圖、記憶、技能…），MCP 與自撰工具也不送 | `CHAT_IDENTITY`：通用助理，沒有環境／OMNI.md 段 |
| `self` | 借用 `OC.env.root`（Omni Code 安裝目錄）| 全部 + `selfimprove_log` / `selfimprove_roadmap`（`selfOnly`）| `IDENTITY` + `SELF_IDENTITY` + 目前版本／未發布規劃／最近歷程 |

**每個會話記著 `mode`**（`sessions.php` 的 meta 也帶），對話紀錄面板依模式分頁；
開機續接只接同模式的會話；載入別的模式的會話會先 `setMode()`。切模式 = 存目前會話 → 開新會話。

**自我提升的工作區是借的**：進入時記 `OC._wsBeforeSelf`，離開時 `applyWorkspace()` 切回去。
`applyWorkspace` 的「工作區已切換」toast 在模式切換時被靜音（`_switchWorkspaceQuiet`）。
重新整理後不會自動回到 self 模式（那需要切工作區）—— 使用者從對話紀錄點回該會話即可。

**入口 modal**（`showEntryModal`）：每次進入問「AI 對話／專案項目／繪圖」。「繪圖」= 專案模式 + 開圖片工作室。
`localStorage.oc_entry_skip` 可關掉，設定面板有開關。沒有任何 API Key 時改顯示金鑰設定，不重疊。

### 自我提升的歷程與版本（`api/selfimprove.php`）

```
data/selfimprove/state.json
  version   語意化版本（產品層級，不是 git commit —— 安裝目錄不是 repo，也不假設有 git）
  history[] {id, at, version, fromVersion, bump, title, summary, files[], session, model, auto}
  roadmap[] {version, title, status: planned|active|released, items[{id, text, done, priority}]}
```

- 模型用 `selfimprove_log` 記錄（bump = patch/minor/major/none；`roadmapItem` 會自動打勾）。
- **兜底**：`runAgent` 結束時若 self 模式下 `files_touched` 有增加而 `OC._selfLogged` 仍為 false，
  `selfAfterRun()` 補一筆 `auto:true`（沒有摘要）。同會話若模型後來自己記了，後端會把兜底那筆
  的檔案合併進去而不是留兩筆。
- 版本只前進不後退；`set_status released` 會把目前版本推到該版本。
- 還原點（`/rewind`）照舊負責「改壞了怎麼救」，歷程負責「改了什麼、為什麼」，兩者互補。

---

## 8.11 結構化程式碼圖譜（`api/codegraph.php`，取法 Graft Tier-1）

深度分析 [trailhq/Graft](https://github.com/trailhq/Graft)（5.6k 星的 codebase
context layer：一次建圖、每次查詢前自動同步、符號級定向）後，
把「確認 OmniCode 沒有、且值得搬」的免模型結構層移植進來。
Tier-2（LLM 寫節點摘要／概念分群）需要供應商 key 與另一套快取語義，
刻意不做，日後再議。

| action | 參數 | 回應 |
|---|---|---|
| `build` | — | `{text, files, symbols, parsed, stale}` — 全量重建索引 |
| `map` | `path`, `no_refresh` | `{text, files, stale}` — repo 第一眼：目錄聚類＋hubs＋hotspots（按被引用數） |
| `file_api` | `path` | `{text}` — 某檔全部簽名、無函式體（約 1/10 token 拿 API 面） |
| `trace` | `symbol`, `direction:"in"\|"out"`, `depth`(1–5) | `{text}` — 改簽名前看 blast radius |
| `search` | `pattern`, `path`, `literal`, `ignore_case`, `limit` | `{text}` — 每個出現處，按包圍符號分組、按被引用數排序 |

後三者呼叫前都會自動同步索引（`no_refresh=1` 可跳過），前端不必手動 build。

**萃取器**：PHP 用 `token_get_all()` 精確解析（namespace／類／函式／方法／
`use` 匯入／呼叫邊，行號精確）；JS/TS 用逐行正則近似（只認頂層定義，
方法級不做 —— 正則分不清縮排語境，硬做只會給出錯答案）。其他語言跳過
不索引（Graft 亦然：不支援的語言直接略過）。

**增量快取**：`<workspace>/.omni/codegraph.json`（單檔：每檔 size+mtime 快路徑、
content hash 慢路徑；未變動的檔重放上次解析，全量與增量輸出一致）。
無變動時連快取檔都不重寫。`.omni/` 屬本地可再生快取（Graft 語：like
node_modules），不是提交物。不支援的語言、>2MB、點開頭目錄（`.git`／`.omni`）
一律不進索引。

**近似之處（如實告知，不假裝精確）**：
`$obj->method()` 與 `Foo::method()` 的方法名不記呼叫邊（跨類重名太多，
記了全是誤報；精確解析需型別推導）；`new class` 匿名類跳過；
箭頭函式 `fn()` 內的呼叫記到外層函式名下；JS 的呼叫歸屬是「上方最近符號」。
trace 的 `out` 方向遇到解不到的名字會標「外部／未解析」而不是硬湊。

**前端工具**（`tools.js`，皆唯讀、可併發）：`repo_map`／`file_api`／
`trace_calls`／`find_refs`（封裝在 `fsapi.js` 的 `CG.*`）。
MCP 對外同名暴露 4 個（`mcp-server.php` 以 `_cg_action` 分派到
`oc_cg_dispatch()`，回應形狀 `{text}` 由 `mcp_render()` 直接攤出；
敏感檔閘門沿用既有 `path` 鍵檢查）。

---

## 9. 前端模組與載入順序

`app/index.html` 底部依序載入（順序即依賴圖，全部 `'use strict'` 的傳統 script，共用 `window` 全域）：

```
 1 config.js       API_CONFIG / 模型清單 / getProviderForModel / getProviderKey
 2 state.js        OC 全域狀態物件
 3 utils.js        $ / esc / toast / modal / confirm / debounce / token 估算 / fmtTime（相對時間跟語系）
 4 i18n.js         五語系字典 OC_I18N + t() + setLocale() + applyChromeI18n()（見 §9.1）
 5 fsapi.js        FS.* / EXEC.* / RELAY.* / SESS.* / MCPAPI.* / SETTINGS.*（後端封裝）
 6 api.js          streamChat() 四家供應商串流 + 工具轉譯 + 圖片生成
 7 permissions.js  權限模式 + 規則引擎 + 授權對話框（permModeMeta 跟語系）
 8 sentinel.js     Sentinel 獨立監控閘門
 9 memory.js       OMNI.md / 記憶 CRUD / 上下文壓縮（memTypeLabel/memTypeMeta 跟語系）
10 mcp.js          MCP 工具載入與呼叫（mcpPresetMeta 跟語系）
11 skills.js       技能掃描 / 載入 / 注入（skillScopeMeta 跟語系）
12 validate.js     輸入驗證
13 schedule.js     排程任務
14 tools.js        工具 schema 定義 + execTool 執行器（含 UI 控制層）
15 agent.js        Agent 主迴圈 + 子代理 + Todo
16 chat.js         聊天渲染（markdown / code / 工具卡 / diff / 串流）
17 filetree.js     檔案樹
18 editor.js       CodeMirror 分頁編輯器
19 terminal.js     終端機面板
20 diffview.js     Diff 檢視
21 imagestudio.js  圖片生成 + 裁切/縮放
22 sessions.js     會話管理（sessGroupLabel 跟語系）
23 modes.js        使用模式（entryChoices 跟語系）
24 slash.js        斜線指令
25 mention.js      @ 提及
26 hooks.js        Hooks 事件
27 models.js       模型管理面板
28 usage.js        Token 流量面板
29 app.js          啟動、佈局、快捷鍵、面板切換、設定面板
```

### 9.1 多國語言（i18n.js）

五種介面語系：`en`（預設）／`zh-TW`／`zh-CN`／`ja`／`ko`。
持久化：`OC.cfg.locale` → `data/config.json`（`settings.php` 的 `set`
只收這五種，其餘 400）；本地鏡像 `localStorage oc_locale`（開機第一幀先套用，避免閃爍）。
`index.html` 靜態可見字串是英文本體（殘留中文只有註解）；開機保底、缺鍵回退、`oc_date_locale()` 日期格式全部預設英文。

- `t(key, vars)`：`{name}` 插值；找不到鍵 → 回退 `en` → 再找不到回傳鍵本身（絕不炸面板）。
- `setLocale(loc)`：雙寫存檔＋`applyChromeI18n()`＋重畫目前面板；已渲染的對話訊息保留（不中斷對話）。
- 靜態 chrome（rail、dock、對話框標頭…）由 `applyChromeI18n()` 按 ID 重寫；
  各面板動態內容在各自 render 時直接呼叫 `t()`。
- 常數中文保底：`MODES`／`MEM_TYPE_LABEL`／`SKILL_SCOPES`／`MCP_PRESETS`／
  `PERM_MODES` 本體保持中文（系統提示與舊資料依賴），呈現層走
  `permModeMeta`／`memTypeLabel`／`skillScopeMeta`／`mcpPresetMeta`／`entryChoices`
  跟語系——`state.js` 在 `i18n.js` 之前載入，不能直接 `t()`。
- 不翻譯：系統提示（給 AI 看的）、工具 schema 描述、後端錯誤訊息原文。

**CDN 依賴**（皆有本地降級判斷）：
`marked` · `DOMPurify` · `highlight.js`(+common langs) · `CodeMirror 5.65.16`
（modes: javascript, php, htmlmixed, xml, css, markdown, python, clike, shell, yaml, sql；
addons: search/searchcursor/dialog, matchbrackets, closebrackets, comment, foldcode/foldgutter, merge）
· `diff_match_patch`（CodeMirror merge 需要）· Google Fonts（Sora / Noto Sans TC / JetBrains Mono / Material Symbols Rounded）。

---

## 10. 前端全域契約

### 10.1 `OC` 全域狀態（state.js）

```js
window.OC = {
  cfg: {},                 // settings.php get 回來的 config
  ws: '',                  // 工作區絕對路徑（顯示用）
  session: {…},            // 目前會話（§11.4）
  messages: [],            // 供應商中立訊息陣列（§11.1）
  tools: [],               // 目前可用工具 schema（內建 + MCP + skill）
  todos: [],               // [{content,status:'pending'|'in_progress'|'completed',activeForm}]
  openFiles: [],           // [{path,content,dirty,cm,mode}]
  activeFile: null,
  running: false,          // Agent 是否執行中
  abort: null,             // AbortController
  turn: 0,
  usage: {in:0,out:0,cache:0,cost:0},
  readCache: {},           // path -> {mtime,size} 已讀檔快取（去重）
  shells: {},              // shell_id -> {command,offset,running}
  mcpTools: [],
  skills: [],
  perm: 'default',         // default | acceptEdits | plan | full
  model: '',
  pending: null,           // 待授權的工具呼叫
};
```

### 10.2 訊息格式（供應商中立，api.js 內部轉譯）

```js
{ role:'user',      content:[{type:'text',text}|{type:'image',mime,data}] }
{ role:'assistant', content:[{type:'text',text}|{type:'thinking',text}|
                             {type:'tool_use',id,name,input}] }
{ role:'user',      content:[{type:'tool_result',tool_use_id,content,is_error}] }
```

### 10.3 `streamChat` 契約（api.js）

```js
await streamChat({
  model, system, messages, tools, maxTokens, temperature, signal,
  onText(delta),          // 文字增量
  onThinking(delta),      // 思考增量（支援的模型）
  onToolStart({id,name}), // 偵測到工具呼叫
  onToolInput(id, partialJsonDelta),
  onDone({content, stopReason, usage}),
  onError(err)
}) → {content:[…blocks], stopReason, usage:{input,output}}
```

- **Anthropic**：`/v1/messages` + `stream:true`，headers 含
  `anthropic-version: 2023-06-01`、`anthropic-dangerous-direct-browser-access: true`；
  工具 `{name,description,input_schema}`；解析 `content_block_start/delta/stop`、`message_delta`。
  新版模型不傳 `temperature`/`top_p`。
- **OpenAI / OpenRouter**：`/chat/completions` + `stream:true` + `stream_options:{include_usage:true}`；
  工具 `{type:'function',function:{name,description,parameters}}`；
  以 `tool_calls[].index` 累積 `function.arguments` 字串。OpenAI 用 `max_completion_tokens`。
  OpenRouter 額外送 `HTTP-Referer` / `X-Title: Omni Code`。
- **Gemini**：`:streamGenerateContent?alt=sse&key=`；
  `systemInstruction:{parts:[{text}]}`、`tools:[{functionDeclarations:[…]}]`、
  `toolConfig:{functionCallingConfig:{mode:'AUTO'}}`、四類 `safetySettings: BLOCK_NONE`；
  解析 `candidates[0].content.parts[]` 的 `text` 與 `functionCall{name,args}`。
  **JSON Schema 需清洗**：移除 `additionalProperties`/`$schema`/`default`/`examples`，
  `type` 轉大寫非必要（v1beta 接受小寫），空 `properties` 的物件要補 `properties:{}`。

  **★ thoughtSignature（Gemini 3 起的硬性要求）**：回應的 part 上會帶一組不透明的
  `thoughtSignature`，下一輪把對話送回去時**必須原封不動附回同一個 part**，否則 400：
  `Function call is missing a thought_signature in functionCall parts`。
  實作：`parseGeminiStream` 把它存進 block 的 `_sig`（會一起存進會話檔），
  `msgsForGemini` 再放回 `functionCall` / `text` part 上。
  **沒有簽章的工具呼叫一律降級成純文字敘述**（連同它的 `tool_result`），
  因為這兩種情況一定會發生且不是使用者的錯：
  (a) 這個機制實作前存下的舊會話；(b) 對話中途從 Claude／GPT 切換到 Gemini——
  那些回合根本不可能有 Gemini 的簽章。降級後語意保留、對話能繼續，
  新回合仍走原生 function calling。
- 通用：`signal` 支援中止；HTTP 429/5xx 指數退避重試 2 次；
  direct 模式 `TypeError`（CORS/網路）→ 自動改走 `RELAY.chat` 重試一次。

### 10.4 圖片生成（api.js）

```js
await generateImage({model, prompt, refs:[{mime,data}], aspect:'1:1', size:'2K', signal})
  → {dataUrl, mime}
```
Gemini `:generateContent`，`generationConfig:{responseModalities:['IMAGE','TEXT'],
imageConfig:{aspectRatio, imageSize}}`；影像取自
`candidates[0].content.parts.find(p=>p.inlineData?.mimeType?.startsWith('image/'))`。

---

## 11. Agent 引擎

### 11.1 主迴圈（agent.js `runAgentTurn`）

```
1. 使用者訊息入列（含附件圖片）
2. while (turn++ < cfg.maxTurns && !aborted):
     a. maybeCompact()               ← 超過 autoCompactAt(預設 0.75) 觸發壓縮
     b. sys = buildSystemPrompt()    ← 每輪重算（環境會變）
     c. res = await streamChat(...)  ← 即時渲染
     d. toolUses = res.content.filter(type==='tool_use')
        若無 → break（回合結束）
     e. 對每個 toolUse：
          perm = checkPermission(name, input)
          若 'ask' → 顯示授權卡，等待使用者（可「允許一次 / 一律允許 / 拒絕」）
          若 'deny' → tool_result(is_error, 說明)
          否則 execTool() → tool_result
        （唯讀工具 read/glob/grep/list 併發執行；寫入/命令序列化執行）
     f. 訊息推入 assistant + tool_result，繼續迴圈
3. 迴圈結束 → 存檔會話、更新 token 儀表、若有未完成 todo 提示
```

- **中止**：`OC.abort.abort()`；進行中的工具收到 signal 後回 `已由使用者中止`。
- **錯誤自癒**：若一輪內所有工具皆失敗，注入系統提示
  「上一輪全部失敗，請診斷原因並改用不同做法，勿重複相同呼叫」，最多 2 次。
- **子代理**：`spawn_agent` 工具建立獨立 `messages`/工具子集，
  跑同一迴圈（`maxTurns` 減半），只把最終文字回傳給主代理。
  回報強制三段式（做了什麼／發現／未竟）以便比對。
- **平行子代理**：`spawn_agents` 一次併發 2–5 路唯讀調查（對標 Orca parallel-agents 競賽），
  各家結論並列回報，主代理負責比對（一致處可信、分歧處深挖）。寫入一律不允許。

### 11.2 System Prompt 組裝（每輪重算）

依序串接：
1. 身分與行為守則（繁體中文回應、簡潔、先動手再解釋、絕不臆造檔案內容）
2. **環境**：工作區路徑、OS、PHP 版本、今日日期、目前開啟檔案、目前面板、
   Git 狀態（若 `.git` 存在，跑 `git status --short` 與 `git branch --show-current`）
3. **OMNI.md** 全文（工作區根，若存在）
4. **記憶**：`MEMORY.md` 索引（名稱＋一行摘要），完整內文由 `read_memory` 工具取
5. **技能清單**：`name — description`（漸進式揭露，本體由 `skill` 工具載入）
6. **工具使用守則**（對標 Claude Code）：
   - 編輯前**必須先 read**；`edit_file` 的 `old_string` 必須逐字相符且唯一
   - 搜尋優先用 `grep`/`glob` 而非 `bash` 的 `dir`/`findstr`
   - 可平行的唯讀呼叫請在同一輪一次送出
   - 大型任務先 `todo_write` 列計畫，完成一項即更新
   - 前端操作用 `ui_control`（開檔、切換面板、預覽、通知）
7. **權限模式說明**（目前模式與其含意）
8. 目前 Todo 狀態

### 11.3 上下文與記憶管理（memory.js）

- **Token 估算**：`est(s) = ceil(asciiCount/4 + cjkCount/1.1 + 8)`，逐訊息快取。
- **模型上限**：`API_CONFIG.models[].contextWindow`（未標示者預設 200000）。
- **微壓縮（microcompact）**：使用率 >55% 時，把「距今 6 輪以上」的 `tool_result`
  內容裁成前 400 字 + `…（已省略 N 字，可重新讀取）`；保留所有 `edit/write` 的結果摘要。
- **完整壓縮（compact）**：使用率 >`autoCompactAt`（預設 0.75）時，
  把最舊 60% 訊息送給模型摘要成結構化紀要：
  `## 已完成 / ## 目前狀態 / ## 檔案異動 / ## 重要決策 / ## 待辦 / ## 使用者偏好`，
  以一則 `user` 訊息「[先前對話摘要]」取代，並保留最近 8 則訊息與所有 todo。
  壓縮後在聊天區顯示分隔線「⚡ 上下文已壓縮（保留 N 則，節省 ~M tokens）」。

  **切割點安全性（不可妥協）**：`safeSplitIndex()` 只會回傳「role 為 user 且
  不含 `tool_result` 的訊息索引」。切在 `tool_use` 與其 `tool_result` 之間，
  會讓保留的那半邊以孤兒 `tool_result` 開頭，**四家供應商都會直接回 400**，
  而且是在壓縮之後才爆——使用者會看到整個對話突然無法繼續。
  找不到安全切點時（例如整段都是工具往返）`safeSplitIndex` 回傳 `-1`，
  `compactContext` 必須**退回微壓縮**，絕不可硬切。
- **檔案讀取去重**：兩個獨立結構，**不可混用**：
  - `OC.readCache[path] = {mtime,size}` — 回答「檔案自上次讀取後有沒有變？」
    未變更時 `read_file` 回「內容請見先前讀取結果」以省 token（`force:true` 可略過）。
  - `OC.seenFiles[path] = true` — 回答「模型知不知道這個檔案的內容？」
    這是 `edit_file` / `write_file` 的前置檢查依據。
  模型自己寫入後，**內容變了（readCache 失效）但它當然知道內容（seenFiles 保留）**，
  因此可以連續編輯同一個檔案，不必為了通過檢查而白讀一次浪費一輪。
- **手動**：`/compact [指示]`、`/clear`、`/context`（顯示佔用分佈）。

### 11.4 會話存檔形狀

```json
{ "id":"s-1738300000000", "title":"自動摘要標題", "ws":"D:/xampp/htdocs/app/OmniCode",
  "model":"claude-sonnet-5", "created":0, "updated":0,
  "extraRoots":[{"alias":"ref","path":"D:/docs/spec"}],
  "messages":[…], "todos":[…], "usage":{"in":0,"out":0,"cost":0},
  "compactions":0, "files_touched":["app/js/agent.js"] }
```

`extraRoots` 是「跟著對話走」的額外工作資料夾（上限 5 個，`list` 只回 `extraRootsCount`）。
`loadSession` 時經 `settings.php extra_sync` 同步為後端作用中授權；開新會話清空。

---

## 12. 工具目錄（`tools.js`）

`name` 一律 snake_case。`OC_TOOLS` 為陣列，每項：
```js
{ name, description, params:{JSON Schema}, danger:'none'|'write'|'exec'|'net',
  readonly:bool, run: async (input, ctx) => string|{text,ui} }
```
`run` 回傳字串即 tool_result 內容；回傳 `{text, ui:{type:'diff'|'image'|'table', …}}`
時 chat.js 會額外渲染富卡片。

| # | 工具 | danger | 說明 |
|---|---|---|---|
| 1 | `read_file` | none | `{path, offset, limit, force}` → 帶行號內容（`cat -n` 風格）；圖片自動轉多模態附件 |
| 2 | `write_file` | write | `{path, content}` → 建立/覆寫；回傳 diff 供 UI 顯示 |
| 3 | `edit_file` | write | `{path, old_string, new_string, replace_all}` |
| 4 | `multi_edit` | write | `{path, edits[]}` 全有全無 |
| 5 | `list_dir` | none | `{path, depth}` |
| 6 | `glob` | none | `{pattern, path}` |
| 7 | `grep` | none | `{pattern, path, glob, mode, ignore_case, context, literal, multiline}` |
| 8 | `bash` | exec | `{command, cwd, timeout, background}` |
| 9 | `bash_output` | none | `{shell_id, since}` |
| 10 | `kill_shell` | exec | `{shell_id}` |
| 11 | `make_dir` | write | `{path}` |
| 12 | `delete_path` | write | `{path, recursive}` |
| 13 | `move_path` | write | `{from, to}` |
| 14 | `copy_path` | write | `{from, to}` |
| 15 | `todo_write` | none | `{todos:[{content,status,activeForm}]}` |
| 16 | `web_fetch` | net | `{url, prompt}` → 抓網頁轉文字（可選由模型摘要） |
| 17 | `web_search` | net | `{query, limit}` |
| 18 | `generate_image` | net | `{prompt, aspect, size, save_to, refs}` → 生成並可直接存進工作區 |
| 19 | `edit_image` | write | `{path, op:'crop'\|'resize'\|'fit'\|'convert', x,y,w,h, width,height, format, quality, out}` — Canvas 執行 |
| 20 | `ui_control` | none | **Computer Use 層**，見 §12.1 |
| 21 | `spawn_agent` | 依子工具 | `{task, agent?, readonly?, max_turns?}` → 單路子代理，回報三段式 |
| 21b | `spawn_agents` | none（強制唯讀） | `{items:[{task, agent?, max_turns?}]}` → 2–5 路併發調查並列回報 |
| 22 | `remember` | write | `{name, description, type, content, scope}` |
| 23 | `read_memory` | none | `{name, scope}`；`name` 省略=列出索引 |
| 24 | `skill` | none | `{name}` → 載入 SKILL.md 全文 |
| 25 | `ask_user` | none | `{question, options:[{label,description}], multi}` → 阻塞式選項卡 |
| 26 | `git` | exec | `{args}` → 便捷包裝（等同 `bash: git …`，但回傳結構化 status/diff） |
| 27 | `open_preview` | none | `{url}` → 右下預覽 iframe |
| 28 | `project_tree` | none | `{depth}` → 專案結構總覽（給模型建立心智模型） |
| 29 | `repo_map` | none | 結構化圖譜：repo 第一眼（目錄聚類＋hubs＋hotspots）—— 見 §8.11 |
| 30 | `file_api` | none | 結構化圖譜：某檔全部簽名、無函式體 —— 見 §8.11 |
| 31 | `trace_calls` | none | 結構化圖譜：改簽名前看 blast radius —— 見 §8.11 |
| 32 | `find_refs` | none | 結構化圖譜：每個出現處，按包圍符號分組 —— 見 §8.11 |
| 33 | `mcp__<server>__<tool>` | net | 動態載入 |

### 12.1 `ui_control` — 前端全局控制（Computer Use 級）

`{action, ...}`：

| action | 參數 | 效果 |
|---|---|---|
| `open_file` | `path, line` | 在編輯器開檔並捲到行 |
| `close_file` | `path` | |
| `save_file` | `path` | 存檔（編輯器緩衝 → 磁碟） |
| `set_editor_content` | `path, content` | 直接寫入編輯器緩衝（不落盤） |
| `switch_panel` | `panel: files\|search\|memory\|mcp\|skills\|sessions\|settings` | 左側面板 |
| `switch_dock` | `dock: terminal\|diff\|problems\|preview\|image` | 下方 dock |
| `show_diff` | `path, before, after` | 開 diff 檢視 |
| `set_theme` | `theme: dark\|light` | |
| `set_model` | `model` | 切換模型 |
| `set_permission_mode` | `mode` | 切換權限模式（`full` 需使用者確認一次） |
| `run_preview` | `url` | 預覽 iframe |
| `notify` | `message, level` | Toast |
| `snapshot` | — | 回傳目前 UI 狀態文字快照（開啟檔案、面板、dock、選取範圍、終端機尾端、錯誤） |
| `click` | `selector \| text` | 點擊元素（先 selector 後文字比對），300ms 沉澱 |
| `fill` | `selector, value` | 填值並派發 `input`/`change` |
| `scroll` | `selector, to` | |
| `open_url` | `url` | 新分頁 |
| `image_studio` | `prompt?` | 開啟圖片工作室（可帶提示詞） |

`snapshot` 是「看得見」的關鍵：讓模型能觀察→動作→再觀察，形成閉環。

---

## 13. 權限系統（permissions.js）

四種模式（右上角切換，`Shift+Tab` 循環）：

| 模式 | 唯讀工具 | 寫入工具 | 命令/網路 | 說明 |
|---|---|---|---|---|
| `plan` 規劃 | ✅ | ❌ 拒絕 | ❌ 拒絕 | 只調查不動手，產出計畫 |
| `default` 標準 | ✅ | 詢問 | 詢問 | 預設 |
| `acceptEdits` 自動編輯 | ✅ | ✅ | 詢問 | 檔案編輯免問 |
| `full` 全自動 | ✅ | ✅ | ✅ | 100% 權限，完全自動化（首次切換需確認） |

**規則引擎**：`allowRules` / `denyRules` 為字串陣列，格式 `tool(pattern)`：
`bash(npm run *)`、`bash(git *)`、`write_file(app/**)`、`delete_path(*)`。
比對順序 deny → allow → 模式預設。授權對話框提供
「允許一次」「本會話一律允許（寫入 allowRules 記憶體）」「永久允許（存 config）」「拒絕並說明」。

### 13.5 Sentinel 獨立監控（sentinel.js，借鏡 Muse 的 Sentinel）

位置在 `checkPermission` 之後、實際執行之前。性質是**單向收緊**：
只能把 allow 翻成 ask/deny，絕不能把 deny 翻成 allow。
`allowRules` / `sessionAllow` 對它無效 —— 這是第二隻眼，不是第三個授權框。

判定（`sentinelCheck(name, input)` → `{verdict, reason}`）：

1. **敏感資源**：比 `checkPermission` 更嚴，`bash` 也不豁免。讀 → ask，寫／刪 → deny。
2. **關鍵操作**：遞迴刪除、高危系統命令、命令列對外寫入、自撰工具寫動詞 → 強制 ask，
   `full` 模式也不豁免（全自動是「不用每步問」，不是「刪庫不用問」）。
3. **對外網路**：`default` 模式下 `web_*` / `mcp__*` 每會話問一次（`OC._sentinelNetOk` 記住）。
4. **範圍閘**：`sentinelScopeOf` 把工具分成 `read` / `act`（`bash` 一律 `act`，
   MCP 按工具名猜、猜不出的一律 `act`）。`act` 在 `default` 模式問；
   `scopeRules`（`{tool名: allow|ask|deny}`）只針對 `act` 生效。

呼叫端（主迴圈 `runOne`＋子代理）：deny 直接擋、ask 走同一個序列授權框
（`requestPermissionSerial(name, input, extraReason)` 會顯示 Sentinel 橫幅）。
模組壞掉時當 allow 但大聲說＋寫稽核 —— 監控壞掉不能擋住所有工作。
總開關 `OC.cfg.sentinel`（預設開），`sentinelNetAsk` 控制第 3 條。

> 本機 PHP 沒有常駐行程，監控必須是同步閘門而非背景 daemon ——
> 不要把它改成輪詢或常駐，否則在 XAMPP 下根本跑不起來。

### 13.6 憑證保險庫（api/vault.php，借鏡 Muse「可用不可讀」）

`data/vault.json`（`{代號: 值}`）。Agent 只拿代號不拿明文：

- `list` / `set` 只回 key 名單，絕不回值；`set` 留空值 = 刪除。
- 引用寫法 `{{VAULT:代號}}`：自撰工具（`oc_ut_fill`，vault 優先於舊 `{{SECRET:}}`）、
  MCP 的 http `headers` 與 stdio `env`（`oc_mcp_vault_fill`）在**真正送出的那一刻**
  才代入。設定檔、前端、稽核裡永遠只有代號原文。
- Agent 工具：`vault_set`（寫）/ `vault_list`（讀）；使用者指令 `/vault`、
  設定面板「憑證保險庫」區塊（值一律走 `promptModal` 密碼框）。

跟 `data/secrets.json` 的分工：那是自撰工具的舊金鑰庫（照舊可用）；
vault 是通用庫，usertools 與 MCP 共用。

---

## 14. 技能系統（skills.js）

掃描 `<workspace>/.omni/skills/*/SKILL.md` 與 `OmniCode/skills/*/SKILL.md`。
Frontmatter：
```yaml
---
name: php-review
description: 審查 PHP 程式碼的安全性與效能問題。當使用者要求 review PHP 檔案時使用。
allowed-tools: read_file, grep, glob   # 選填
---
```
System prompt 只放 `name — description`；模型呼叫 `skill(name)` 後才注入正文（漸進式揭露）。
技能段另有一句強制調用紀律（1% 可能適用就必須先載入；「很簡單」「先看一眼」視為開脫）。
內建技能：`init-project`（產生 OMNI.md）、`code-review`、`refactor`、`ui-design`、`debug`、
`reality-check`、`tool-author`、`codebase-onboarding`、`whimsy-injector`、`video-production`（端到端影片製作）、
`web-intel`（網頁與社群情報蒐集）、`design`（動手前設計＋實作計畫，移植 superpowers 的 brainstorming／writing-plans 心法）。

---

## 15. UI 佈局與 DOM 契約

```
┌─ #oc-top ────────────────────────────────────────────────────────────┐
│ logo Omni Code │ #ws-picker │ #model-select │ #mode-btn │ #token-meter│
├─#oc-rail─┬─ #oc-side ──┬─ #oc-center ──────────────┬─ #oc-chat ──────┤
│ 圖示列   │ 檔案樹/搜尋 │ #tab-bar                  │ #chat-scroll    │
│ files    │ 記憶/MCP    │ #editor-host (CodeMirror) │  訊息/工具卡     │
│ search   │ 技能/會話   │ ─── #dock ───             │ #chat-todo      │
│ memory   │ 設定        │ #dock-tabs                │ #chat-form      │
│ mcp      │             │ #dock-terminal            │  #chat-input    │
│ skills   │             │ #dock-diff                │  #chat-send     │
│ sessions │             │ #dock-problems            │  #chat-stop     │
│ settings │             │ #dock-preview             │  #chat-attach   │
└──────────┴─────────────┴───────────────────────────┴─────────────────┘
```

**必備 id**：`oc-app, oc-top, oc-rail, oc-side, oc-center, oc-chat, ws-picker,
model-select, mode-btn, token-meter, file-tree, tab-bar, editor-host, dock,
dock-tabs, dock-terminal, dock-diff, dock-problems, dock-preview,
chat-scroll, chat-todo, chat-form, chat-input, chat-send, chat-stop, chat-attach,
panel-files, panel-search, panel-memory, panel-mcp, panel-skills, panel-sessions,
panel-settings, modal-generic, modal-confirm, modal-permission, modal-keys,
modal-workspace, image-studio, toast-container, splash`

**面板切換**：`window.switchPanel(name)` / `window.switchDock(name)` —
以 `.active` class 切換（`.oc-panel`、`.dock-view`）。

### 15.1 CSS 設計系統（Aurora-Dark，`app/css/styles.css`）

沿用 OmniPD 語彙但預設暗色、資訊密度提高：

```css
:root{                      /* 暗色為預設 */
  --canvas:#0e1016; --ink:#e8eaf2; --ink-dim:#a2a8bd; --ink-faint:#6b7288;
  --panel:rgba(255,255,255,0.035); --panel-2:rgba(255,255,255,0.06);
  --panel-3:#171a23; --panel-4:#11141b;
  --line:rgba(255,255,255,0.09); --line-2:rgba(255,255,255,0.16);
  --brand:linear-gradient(135deg,#8a7cf0,#b083ea 55%,#ff97c4);
  --accent:#8b7cf6; --accent-2:#ff97c4; --accent-soft:rgba(139,124,246,0.14);
  --success:#4ecfa0; --warning:#efb567; --danger:#ff6b6b; --info:#5ac8fa;
  --r:14px; --r-sm:9px; --r-lg:20px;
  --mono:'JetBrains Mono','Cascadia Code',Consolas,monospace;
  --sans:'Noto Sans TC',system-ui,sans-serif; --display:'Sora',sans-serif;
}
html[data-theme="light"]{ …淺色覆寫… }
```

元件 class：`.btn/.btn-primary/.btn-ghost/.btn-danger/.btn-icon/.btn-xs`、
`.inp/.sel/.ta`、`.card`、`.chip`、`.modal-overlay/.modal-box`、`.toast`、
`.msg.user/.msg.ai/.msg.sys`、`.tool-card[data-state=running|ok|error]`、
`.diff-line.add/.del/.ctx`、`.todo-item.done/.doing/.todo`、`.spinner`。

主題切換：`document.documentElement.dataset.theme`，存 `localStorage['oc_theme']`，
啟動前以 IIFE 套用避免閃爍。

### 15.2 快捷鍵

`Ctrl+S` 存檔 · `Ctrl+P` 檔案快速開啟 · `Ctrl+Shift+F` 全域搜尋 ·
`Ctrl+\`` 終端機 · `Ctrl+B` 側欄 · `Ctrl+K` 指令面板 · `Esc` 關閉最上層 modal / 中止 Agent ·
`Shift+Tab` 循環權限模式 · `Ctrl+Enter` 送出訊息 · `Ctrl+L` 清除聊天。

---

## 16. 斜線指令（slash.js）

本地短路（不呼叫 LLM）：`/help /clear /compact /context /model /mode /cost /todo
/diff /undo /export /resume /sessions /memory /forget /vault /init /mcp /skills /keys /workspace
/theme /terminal /image /doctor`
其中 `/init` 會掃描專案並請模型產生 `OMNI.md`（呼叫 LLM）。

`/forget <名稱>` 刪一則記憶（兩個 scope 都試，先問確認）；
`/vault [set 代號|del 代號]` 管憑證保險庫（值走密碼框，聊天區永遠看不到值）；
`/audit` 表格多一欄 🛡（Sentinel 經手的標記）。

---

## 17. 圖片工作室（imagestudio.js）

- 提示詞輸入 + 風格預設 chips + 比例（1:1 / 3:4 / 4:3 / 9:16 / 16:9 / 2:3）+ 解析度（1K/2K/4K）
- 參考圖上傳（最多 5 張，`_compress(file,1536,0.85)`）
- 生成 → 縮圖畫廊（`data/`-free：直接存進工作區）
- **編輯器**：Canvas 裁切（可拖拉裁切框、鎖定比例、九宮格輔助線）、
  縮放至指定尺寸、格式轉換（png/jpg/webp）、品質滑桿
- 「存入工作區」→ `FS.writeB64(path, dataUrl)`；預設 `assets/images/<slug>-<ts>.png`
- Agent 可用 `generate_image` + `edit_image` 全自動完成同一流程（不需開 UI）

---

## 18. 錯誤處理與健檢

- 所有 `FS.*` / `EXEC.*` 呼叫失敗 → 拋 `Error(封套.error)`，工具層轉成
  `is_error:true` 的 tool_result（模型看得到錯誤原文才能自我修正）。
- `/doctor`：檢查 PHP 端點可達性、工作區可寫、金鑰設定、CDN 載入、MCP 連線，
  以清單呈現 ✅/❌ 與修復建議。
- 前端全域 `window.onerror` / `unhandledrejection` → 錯誤 ticker（最多 3 張，15s）。

---

## 19. 高階智能體能力

讓 Omni Code 從「工具執行器」變成「智能體」的四項能力。核心原則是
**誠實優於樂觀**：不確定就說不確定，驗不了就說驗不了，絕不假裝成功。

### 19.1 擴展思考（`api.js` / `config.js`）

四個等級（`off` / `standard` / `deep` / `max`），各供應商參數不同：

| 供應商 | 參數 |
|---|---|
| Anthropic | `thinking: {type:'enabled', budget_tokens}`；預算箝在 `max_tokens-1024`，並把 `max_tokens` 抬到 `budget+4096` |
| Gemini | `generationConfig.thinkingConfig: {thinkingBudget, includeThoughts:true}` |
| OpenAI | `reasoning_effort: low/medium/high` |
| OpenRouter | `reasoning: {effort}` |

**不維護「哪些模型支援思考」的白名單**——那份清單必然過期，而過期的白名單
會讓新模型永遠用不到思考能力。改用樂觀策略：先送，被 400 拒絕
（`isThinkingRejection`）就自動去掉參數重試一次，並把該模型記進
localStorage `oc_thinking_unsupported`，之後不再送。降級重試不消耗 429/5xx
的重試額度。

### 19.2 檢查點與回溯（`api/checkpoint.php` + `/rewind`）

以「使用者回合」為單位。**不做全工作區快照**（大專案會慢到不可用），改成
**寫入前捕捉**：只有真正被動到的檔案才進檢查點，成本正比於改動量。

```
data/checkpoints/<session>/<cp_id>/manifest.json
data/checkpoints/<session>/<cp_id>/blobs/<sha1>.bin
```

`manifest.files[rel].state` 記錄該檔案「被動之前」的狀態：
`existed`（有 blob，還原時寫回）/ `absent`（當時不存在，還原時刪除）/
`dir` / `unreadable`。

- 檢查點**延遲建立**：純問答的回合不會留下空檢查點（`ensureCheckpoint`）
- 同一檢查點內每個路徑只捕捉第一次——要的是「這一輪動手前」的狀態
- `MUTATING_TOOLS`（tools.js）宣告每個變更型工具要捕捉哪些路徑；
  `move_path` 兩端都捕捉（來源會消失、目標會被覆蓋）
- **bash 只記錄命令不捕捉檔案**：我們無從得知它碰了什麼。還原時如實回報
  「這些命令的副作用救不回來」。假裝能完整還原比不能還原更危險
- 工作區換過就拒絕還原（409）——相對路徑會指到完全不同的檔案
- 每個會話最多保留 30 個檢查點
- 還原後必須重載編輯器分頁，否則使用者一按存檔就把還原成果覆蓋回去

### 19.3 計畫模式（`present_plan` + `presentPlanCard`）

取代原本「一律拒絕寫入」的死板做法，改成**研究 → 提案 → 批准 → 執行**：

1. 唯讀工具徹底調查（`activeTools` 在 plan 模式只送 `danger==='none'` 的工具）
2. `present_plan` 提交結構化計畫（`summary` / `steps[{title,detail,files}]` /
   `risks` / `verification`），檔案路徑可點開檢視
3. 使用者按「批准並執行」→ 自動切到 `acceptEdits` → 工具回傳訊息告訴模型
   繼續執行；按「要求修改」→ 意見回饋給模型重新提案

`present_plan` 帶 `planOnly: true`，**只在 plan 模式存在**，且不給子代理
（批准是主線程與使用者之間的事）。在其他模式呼叫會被婉拒而非執行。

> CSS 陷阱：`.msg.sys` 用 `flex-direction:row`（兩個 class 權重較高），
> 卡片必須用 `.msg.plan-card` 同等權重才蓋得過去，否則內容會橫向排開撐爆面板。

### 19.3b 零門檻任務卡（`present_task` + `presentTaskCard`）

跟 plan 卡的差別：task 卡只是「動手前讓使用者一眼看懂」的確認，
不切權限模式、不走批准流程。`title` / `plan`（白話 2–5 行）/ `next`（第一步預期）/
`confirm_label`（按鈕文字）。互動式工具，與 `ask_user` / `present_plan` 同走
`runToolBatch` 的序列段。CSS 同 plan 卡的權重招（`.msg.task-card`）。

### 19.3c 本輪稽核卡（`auditCard`）

有「被擋／被問過／失敗」的工具那一輪才秀（全部一次通過的安靜做事）。
只記 `{tool, ok, denied, sentinel, ms}` —— 不記參數內容。
稽核檔另加 `sentinel` 欄（白名單，`/audit` 表格顯示 🛡）。

### 19.4 自我驗證（`verify` + `autoVerifyFeedback`）

偵測順序：**OMNI.md 指定的驗證命令 → package.json scripts → 語言內建語法檢查**。
OMNI.md 寫了 `驗證命令：<cmd>` 就只跑它（使用者的規則勝過任何猜測）。

自動驗證迴圈：Agent 宣稱完成時，若本回合動過程式碼就實際跑一次檢查，
沒過就把錯誤餵回去讓它修，最多 `MAX_AUTO_VERIFY = 2` 次。修不好就停下來
如實告訴使用者卡在哪裡，而不是在同一個錯誤上空轉燒 token。

**假陽性防護**（這比檢查本身更重要）：

- PHP 走 `OC.env.php_bin` 的絕對路徑。XAMPP 不把 `php.exe` 放進 PATH，
  直接下 `php -l` 會因「找不到命令」把正確的檔案報成失敗
- `isMissingInterpreter()` 區分「環境缺工具」與「程式碼有錯」，前者計入
  skipped 而非 failed，並明說「這不代表它們沒問題」
- `extractError()` 挑出真正的錯誤行。`node --check` 會先印檔名再印數行空白，
  最後才是 `SyntaxError`——直接取前 N 行只會拿到空行
- 找不到任何檢查方式時回報「沒有可跑的檢查」並教使用者怎麼設定，
  **絕不回傳「通過」**

---

## 20. 對標 Claude Code / Codex 的能力

### 20.1 執行中排隊訊息（`queueMessage` / `flushQueuedInto`）

輸入框在 Agent 執行時**不禁用**。送出的訊息進 `OC.queued`，
在**回合邊界**（工具結果回填之後）才注入對話。

> 為什麼不立刻打斷：`tool_result` 必須緊接在對應的 `tool_use` 之後，
> 中間插一則 user 訊息會讓四家供應商全部回 400。

- 注入時加上 `[使用者在你執行途中補充]` 前綴，模型才知道是新指示而非舊訊息重播
- 訊息裡的 `@` 提及在**排隊當下**就展開（使用者要的是他當時看到的內容）
- Agent 收尾時若佇列還有東西 → 繼續跑而不是結束
- 中止時把未送出的訊息**放回輸入框**，不默默丟掉

### 20.2 @ 提及檔案（`mention.js`）

打 `@` 觸發模糊自動完成，送出時把檔案內容直接附進訊息，省掉模型「先讀一輪」。

- 索引：`FS.glob('**/*', 4000)` + 從路徑推導目錄，快取 30 秒
- 評分：檔名完全相符 > 檔名開頭 > 路徑開頭 > 檔名內含 > 路徑內含 > 子序列，同分取短路徑
- 只認「行首或空白後」的 `@` —— `foo@bar.com` 不會誤觸發
- 預算：單檔 40k、總計 120k、最多 20 個。超過就截斷並標明「請自行 read_file」
- 附上的檔案會 `markSeen()`，模型不會再讀一次
- 目錄提及 → 附上目錄列表；找不到 → 明說找不到（不靜默略過）

### 20.3 Hooks（`hooks.js` + `.omni/hooks.json`）

| 事件 | 語意 |
|---|---|
| `PreToolUse` | 非零結束碼 = **阻擋**該次工具執行，stderr 回饋給模型 |
| `PostToolUse` | 工具成功後執行，輸出附在工具結果後面 |
| `UserPromptSubmit` | stdout 當額外上下文注入該輪 |
| `Stop` | Agent 收尾時執行，輸出只顯示給使用者 |
| `SessionStart` | 載入／新建會話時執行一次 |

- `matcher` 是比對工具名稱的正則；佔位符 `$TOOL $FILE $ARGS $WORKSPACE $PROMPT`
- PreToolUse 排在**權限閘之後**：hook 是專案規則，不能取代使用者授權
- hook 本身跑不起來時據實回報並放行，不讓 hook 故障變成 Agent 故障
- 設定檔 JSON 壞掉會明講（靜默忽略會讓人以為 hook 沒生效）

> **★ Windows cmd 的 `exit /b` 陷阱**：`A && (B && exit /b 1) || exit /b 0`
> 不會如預期結束——括號內的 `exit /b` 只設定 errorlevel 就繼續往下，
> 接著 `||` 被觸發而回傳 0。**要靠結束碼表達成敗一律用多行寫法，
> 最後一行單獨 `exit /b N`。** 這個坑會靜默失效：命令有跑、訊息也印了，就是不生效。

### 20.4 自訂子代理（`.omni/agents/*.md`）

frontmatter 定義能力，正文是該代理的系統提示：

```markdown
---
description: 什麼時候該派它（會進主代理的系統提示）
tools: read_file, grep, glob        # 省略 = 不限制
readonly: true                       # 預設 true，安全優先
max_turns: 15
model: claude-sonnet-5               # 省略 = 用預設子代理模型
---
（正文：這個代理該怎麼做事）
```

- 主代理的系統提示只放「名稱 — 描述」，正文等 `spawn_agent(agent:"名稱")` 才載入
- **定義檔的設定優先於呼叫端**：模型不能用參數繞過定義檔宣告的 readonly / maxTurns
- `tools` 會實際縮小該子代理的工具集——給它剛好夠用的工具，它就不會亂跑
- 指定不存在的代理 → 回傳可用清單，不是錯誤堆疊

### 20.5 自訂斜線指令（`.omni/commands/*.md`）

frontmatter 定義 `description` / `args` / `model`，正文是提示模板。
佔位符 `$ARGUMENTS`（全部參數）與 `$1..$9`（依空白切開）。

> **替換順序必須由大到小（$9→$1）**，否則 `$1` 會先吃掉 `$10` 的前綴。

自動併入 `/` 補全與 `/help`，同名時內建指令優先。

### 20.6 AGENTS.md / CLAUDE.md 相容

`oc_omni_md()` 依序讀 `OMNI.md` → `AGENTS.md` → `CLAUDE.md` → `.omni/OMNI.md`，
**全部都讀並合併**（各段標明來源），不是取第一個——有些專案同時放了兩份。
既有專案不必改檔名就能直接用。回應的 `sources` 欄位列出實際採用了哪些檔案。

---

## 21. 模型管理與流量統計

### 21.1 模型註冊表（`models.js`）

使用者完全掌控模型清單：文字模型與繪圖模型都能任意新增／編輯／刪除，
**包含出廠內建的那些**（id 也可以改）。`data/models.json` 是唯一的真相來源，
存的是**完整清單**而不是差異：

```
data/models.json (v2)
  version            2
  primaryImageModel  Agent 生圖固定使用的繪圖模型 id（"" = 沒有繪圖模型）
  models[]           {id, displayName, provider, context, multimodal, tools, thinking?,
                      effortMax?, tier?, costIn, costOut, hidden}
  imageModels[]      {id, displayName, provider, costImage, hidden}
  providers{}        內建供應商的覆寫（端點、格式、標頭…）
  customProviders[]  完全自訂的供應商
        ↓ rebuildModels()
API_CONFIG.allModels       完整清單（含隱藏）→ getModelInfo / 價格查詢走這份
API_CONFIG.models          上者濾掉 hidden   → 模型選單走這份
OC.cfg.imageModel          primaryImageModel 的鏡像，只是給 api.js generateImage() 讀
```

`API_CONFIG.builtinModels` 只是**第一次的種子**：`models` 為 null 時用它填入。
之後內建模型跟自訂模型沒有任何差別；`_builtin` 旗標只代表「出廠清單有同 id」，
用來決定要不要顯示「還原」按鈕（把那一筆換回出廠值）。

**為什麼從差異疊加改成完整清單**：舊格式把內建模型當成不可刪、不可改 id 的基底，
清單裡永遠躺著用不到的出廠模型。代價是內建清單日後更新不會自動出現在既有使用者
的清單裡 —— 由「還原」（單筆）與「還原成內建清單」（整份重新種入）補回。
舊格式（`overrides / custom / customImage / imageOverrides`）第一次載入時由
`normalizeModelConfig()` 自動轉成 v2 並回存；後端 `models_save` 只接受 v2。

**主要繪圖模型的遞補規則**（`normalizeModelConfig`）：被刪或被隱藏時自動換成
第一個可見的繪圖模型；一個都沒有就清空，`generateImage()` 會用明確的錯誤提示
使用者去新增。設為主要的模型會自動取消隱藏。

**存檔與重讀的競態**：`saveModelConfig()` 只重畫面板、不觸發 `renderModelsPanel()`
—— 後者會從磁碟重讀 `models.json`，那個 GET 常比存檔的 POST 先回來，把剛改好的
記憶體蓋掉。`loadModelConfig()` 在有存檔在飛時（`_mdlSaving > 0`）也會略過套用。

`rebuildModels()` 必須在 `renderModelButton()` **之前**呼叫（boot 已處理）。
目前選用的文字模型若被隱藏或刪除，會自動換成第一個可用模型，避免卡在不存在的模型上。

**價格欄位**：`costIn` / `costOut`（USD 每 1M tokens）、`costImage`（USD 每張）。
未填一律是 `null`（未知）而非 `0` —— 這個區別貫穿整個成本計算，見下節。

### 21.2 用量記錄（`api/usage.php` + `usage.js`）

```
data/usage/YYYY-MM.jsonl    一行一筆，append-only
```

按月分檔 + JSONL 的理由：append 是 O(1)（呼叫很頻繁）、查詢只讀涵蓋的月份、
單行毀損不會波及整份資料。

| action | 說明 |
|---|---|
| `record` | 追加一筆；成本在此時就算好寫入 |
| `query` | 彙總：total / byModel / byProvider / byPurpose / byDay（含補零） |
| `list` | 逐筆明細（新→舊，可分頁、可依模型與用途篩選） |
| `recalc` | 用新價格重算歷史成本（明確動作，不會自動發生） |
| `clear` | 清除（可指定 before 時間點） |

**★ 成本在記錄當下算好並存進去，不在查詢時算。**
價格會被使用者修改，歷史紀錄必須保留當時實際適用的價格；
查詢時才算的話，改一次價格就會讓過去所有帳目跟著變動——那不叫紀錄。
事後才填價格的情況有 `recalc` 這個明確入口。

**★ 沒有價格 = `null`，不是 `0`。**
`oc_usage_cost()` 在沒有任何費率時回傳 `null`，彙總時計入 `unpriced` 計數，
面板顯示「未計價」並提示去哪裡設定。把未知當成免費是會讓人做出錯誤決策的謊。

**期間參數**：`24h|7d|15d|30d|90d|180d|365d|all`。
`24h` 是往前 24 小時；其餘是「往前 N 個完整日曆天的 00:00 起」，跟直覺一致。

> **`oc_usage_files()` 不逐月走訪，直接 glob 再依檔名篩選。**
> 逐月走訪需要迭代上限，而上限一旦小於實際月數就會**靜默漏掉最近的資料**
> ——`period=all` 從 1970 起算時整個查詢會回空。檔案數本來就等於有資料的
> 月份數，直接列檔又快又不可能漏。`all` 的起點取自最早一筆紀錄而非 0，
> 否則 `byDay` 補零會從 1970 開始而被安全上限截斷。

### 21.3 記錄的接入點

`streamChat()` 成功回傳後統一記錄，所以每個 LLM 呼叫都會被記到，
不必在各呼叫點重複處理。用途由 `opts.purpose` 標示：

| purpose | 來源 |
|---|---|
| `agent` | 主迴圈（預設） |
| `subagent` | `runSubAgent` |
| `compact` | 上下文壓縮 |
| `title` | 會話自動命名 |
| `image` | `generateImage`（以 `images:1` 計價，不是 token） |

`recordUsage()` 全程 try/catch —— 記錄失敗絕不影響主流程。

---

## 22. 供應商可編輯化與 Responses 格式

### 22.1 以「格式」而非供應商名稱分派

`buildRequest` / `parseStream` 都改成看 `provider.format`，不再看供應商 id。
這是自訂供應商能運作的關鍵：只要對方的 API 長得像下列其中一種，
不用改任何程式碼就能接上。

| format | 請求 / 回應 |
|---|---|
| `openai` | `POST /chat/completions`，`messages` 陣列 |
| `anthropic` | `POST /v1/messages`，需 `x-api-key` + `anthropic-version` |
| `gemini` | `contents/parts`，金鑰放 `?key=`，端點可用 `{model}` |
| `responses` | `input` / `input_text`（Meta AI、OpenAI Responses） |

每個供應商還可設 `supportsStream`。關閉時走非串流路徑
（`parseStream(..., stream=false)` → `parse*Json`），四種格式都有對應的
非串流解析器，呼叫端完全無感。

### 22.2 使用者設定

```
OC.cfg.modelConfig.providers       內建供應商的覆寫（端點、格式、標頭…）—— 存在 data/models.json
OC.cfg.modelConfig.customProviders 完全自訂的供應商 —— 同上
```

與模型一樣採疊加：內建的可覆寫與還原但不能刪除，自訂的可刪。
端點在設定裡是字串，`rebuildProviders()` 轉回 `API_CONFIG` 期待的函式；
沒被覆寫的內建供應商保留原本的函式（Gemini 的 URL 組法比較特殊，
硬轉字串會壞掉）。

### 22.3 Meta AI / Responses 格式

```
POST https://api.meta.ai/v1/responses
Authorization: Bearer <key>
{ "model": "muse-spark-1.2-contributor",
  "input": [{"role":"user","content":[{"type":"input_text","text":"…"}]}],
  "stream": false }
```

**已驗證 vs 未驗證，要分清楚：**

- **請求主體**取自官方 curl 範例，逐欄位比對過，可信。
  刻意**不送** `max_output_tokens` —— 範例沒有這個欄位，多送一個對方
  不認得的參數可能讓整個請求 400。需要的話用供應商設定的 `extraBody` 自行加。
- **工具呼叫與串流事件**的欄位名稱範例沒有涵蓋，實作沿用 OpenAI Responses
  的慣例（`function_call` / `call_id` / `response.output_text.delta`…），
  **未經實測**。因此 Meta 預設 `supportsStream: false`，只走已驗證的非串流路徑。
- 串流若格式不符，`parseResponsesStream` 會明確報「沒有可辨識的事件，
  請關閉串流」，而不是靜默回傳空白。

Responses 格式最容易搞混的一點：`function_call` 與 `function_call_output`
是 `input` 的**頂層項目**，不是包在 message 裡的 content block。

### 22.4 ★ Anthropic 擴展思考 + 工具呼叫

開啟擴展思考後，帶工具呼叫的 assistant 回合，**下一輪必須把 thinking 區塊
連同簽章原樣送回，且排在該回合最前面**，否則 Anthropic 拒絕整個請求
（`Expected thinking or redacted_thinking...`）。與 Gemini 的
`thoughtSignature` 是同一類要求。

實作橫跨三處，缺一不可：

1. `parseAnthropicStream` 收 `signature_delta` 存進 block 的 `_sig`
   （也處理 `redacted_thinking`）
2. `agent.js` **不再**把 thinking 從 `OC.messages` 濾掉 —— 濾掉的話簽章就回不去了
3. `msgsForAnthropic` 以 `{type:'thinking', thinking, signature}` 送回
   （欄位名是 `thinking` 不是 `text`）

沒有簽章的思考內容（其他供應商產生的、或壓縮後遺失的）一律略過，
送回去反而會被判定竄改。`msgsForOpenAI` / `msgsForGemini` 本來就忽略
thinking，所以保留在歷史裡不會有副作用；`estMessagesTokens` 已計入它們。

> 這個 bug 影響**預設路徑**：`thinkingLevel` 預設 `standard`，
> 而 Anthropic + 工具正是本產品最主要的組合。
