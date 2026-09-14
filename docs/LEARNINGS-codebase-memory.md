# codebase-memory-mcp 取捨備忘錄

> 深度分析 [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp)
> （42.4k★，單檔二進位 + MCP server，162 語言 AST 知識圖譜）後，與 OmniCode v1.0.0
> 結構化程式碼圖譜（`api/codegraph.php`）的逐項比較。
>
> 這份文件**不是模仿指南**——是「學什麼、不學什麼、為什麼」的取捨紀錄。
> 真正動手的版本規劃見 `selfimprove_roadmap`，本檔是它的理由。
>
> 撰寫時間：2026-09-06

---

## 0. 一句話差異

| | cbm (codebase-memory-mcp) | OmniCode codegraph (v1.0.0) |
|---|---|---|
| 形態 | C 寫的單檔二進位 + 162 個 vendored tree-sitter 文法 | PHP 8.2 用 `token_get_all`（PHP）+ 正則（JS/TS） |
| 規模 | Linux kernel 28M LOC、3 分鐘建圖 | OmniCode 自身 ~80 個檔、< 1 秒 |
| 部署 | 獨立 daemon + 客戶端註冊 | 跑在 OmniCode 自家的 PHP 裡，零外部依賴 |
| 圖譜存儲 | SQLite + zstd 快照（`.codebase-memory/graph.db.zst`）可入 git | 單 JSON 檔（`.omni/codegraph.json`），本地再生快取 |
| 語義層 | Tier-2 LLM 摘要 + 11 信號 BM25+ 向量 | 無（刻意不做） |

**共同祖先**：兩者都聲稱取自或精神相通於「結構化程式碼圖譜 = Agent 的知識層」，
把我們讀程式碼從「grep+讀全文」變成「符號級定向查詢」。這條路雙方都認。

---

## 1. 已重疊（不用做）

下列 8 項 cbm 主打功能，OmniCode 在 v1.0.0 已經有了。對照目的是「避免重做」：

| cbm 功能 | OmniCode 落點 | 對應檔案 |
|---|---|---|
| 樹狀檔案清單（目錄聚類 + hubs） | `repo_map`（`codegraph.php:504`） | `api/codegraph.php` |
| 檔案全部簽名 | `file_api`（`codegraph.php:562`） | `api/codegraph.php` |
| 呼叫圖雙向 trace | `trace_calls`（`codegraph.php:596`） | `api/codegraph.php` |
| 結構感知搜尋 | `find_refs`（`codegraph.php:683`） | `api/codegraph.php` |
| 增量快取（mtime + content hash） | `oc_cg_sync()` 的指紋短路 | `api/codegraph.php:438` |
| 查詢前自動同步 | `oc_cg_dispatch` 的 `!no_refresh` 預設 | `api/codegraph.php:763` |
| MCP 對外暴露 4 個工具 | `mcp-server.php` 的 `_cg_action` 分派 | `mcp-server.php` |
| 「外部／未解析」誠實標記 | trace 輸出中 `（外部／未解析：PHP 內建或索引外…）` | `api/codegraph.php:665` |

**重疊率約 70%**。v1.0.0 移植 Graft Tier-1 時，cbm 公開的 15 個 MCP 工具裡，
前 4 個就是它，Graft 已經選對了。剩下的差異才是這份備忘錄的重點。

---

## 2. 學：8 個 cbm 明確比我們強的地方

排序依照「對 OmniCode 實際工作流的高頻幫助」由高到低。★ 是落地優先。

### ★ 1. architecture 一覽（`get_architecture`）
**cbm 怎麼做**：一次回傳「語言分佈 / 套件邊界 / 入口 / 路由 / hotspots / 邊界 / 叢集」。
**OmniCode 缺**：我們有 `repo_map` 但沒有「這是個什麼樣的專案」的高階摘要。
Agent 接手陌生 repo 時，目前要自己東拼西湊。
**為什麼排第一**：對應 `codebase-onboarding` skill——skill 5 分鐘給心智地圖的
承諾需要後端真的能回應「語言、入口、邊界」這種總覽問題。

### ★ 2. git diff 影響分析（`detect_changes`）
**cbm 怎麼做**：`git diff` → 把改動對應到被影響的符號 → 風險分級。
**OmniCode 缺**：`code-review` skill 完全靠 grep + 讀檔，沒有「這次改了會影響誰」。
**為什麼排第二**：使用者改完要發 PR 前，最常問的就是這個問題。
目前得自己跑 `git diff` + 手動比對。**殺手鐧應用：自我提升模式（self mode）**——
我自己改完 OmniCode 自己，沒有 `detect_changes` 就只能靠 trace 逐個看。

### 3. ADR（Architecture Decision Records）管理
**cbm 怎麼做**：`manage_adr` 工具，跨會話保存架構決策。
**OmniCode 缺**：記憶系統（`api/sessions.php`）只存事實型記憶，
沒有「為什麼這樣設計」這類**長效架構理由**的槽位。
**為什麼排第三**：影響小但持久。`OMNI.md` 描述「現在怎樣」，
ADR 描述「為什麼這樣」——後者改了就回不去了，必須保存。

### 4. 跨服務 HTTP 路由 ↔ 呼叫點匹配
**cbm 怎麼做**：`HTTP_CALLS` 邊 + 信心評分，
串聯 gRPC/GraphQL/tRPC 偵測（讀 protobuf 拿 route）。
**OmniCode 缺**：`trace_calls` 只有同進程的 `CALLS` 邊，
不知道「這個 API endpoint 被前端哪支 fetch 呼叫」。
**為什麼排第四**：OmniCode 自己沒有前後端分離的架構，
但使用者的工作區可能有（他們會用 OmniCode 改 Laravel/Vue 專案）。
**判定**：不先做，等有使用者撞到再說。

### 5. `EMITS / LISTENS_ON` 通道偵測
**cbm 怎麼做**：8 種語言偵測 Socket.IO、EventEmitter、pub-sub 模式。
**OmniCode 缺**：`agent.js` 內部有 event bus，
但 codegraph 完全看不見「`OC.events.on('file:change', …)` 是誰發、誰收」。
**為什麼排第五**：自用價值高（自我提升時要知道工具→UI 的事件鏈），
但實作要對 8 種語言逐一寫偵測——**ROI 偏低**。

### 6. `.codebase-memory.json` per-project 設定檔
**cbm 怎麼做**：工作區根的 JSON，覆蓋全域設定（例如把 `.blade.php` 對應到 `php`）。
**OmniCode 缺**：`codegraph` 只認內建的副檔名白名單。
**為什麼排第六**：把 `.vue` 對到 JS、把 `.twig` 對到 HTML，
本來 `codebase-onboarding` 跑到陌生框架就立刻撞到。
**小兒科**（10 行）+ 立刻見效，**跟 #1 architecture 一覽同捆做**。

### 7. CI hooks（PreToolUse 攔截）
**cbm 怎麼做**：45 個客戶端 surface 的 hook，索引前先 cancel 衝突進程。
**OmniCode 缺**：沒有 hooks 子系統。
**為什麼排第七**：hook 機制在 OmniCode 是**MCP 客戶端**的角色，
不是**MCP 伺服器**——要顛倒過來想。**判定**：跟現有權限引擎（`permissions.js`）
重疊，**不做**（見 §3.5）。

### 8. 團隊共享圖譜 artifact（`.codebase-memory/graph.db.zst`）
**cbm 怎麼做**：zstd 壓縮 + git `merge=ours` + LFS 教戰手冊。
**OmniCode 缺**：`.omni/codegraph.json` 是**本地再生快取**，不打算提交。
**為什麼排第八**：OmniCode 的工作區**就是 OmniCode 自己的程式碼**，
單人開發、無團隊共享需求。**判定**：**不做**（見 §3.7）。

---

## 3. 不學：6 個我們刻意不搬的理由

這 6 項值得單獨記下——日後有人想搬時，會先撞到這面牆。

### 3.1 不做 vendored tree-sitter（162 語言）
**cbm 把 162 個 tree-sitter 文法編進二進位**。OmniCode 不能這樣做：
- PHP 8.2 + Apache 部署，**沒有 FFI 沒有 ext-tree-sitter**，
  連 PECL 都不裝。
- 162 種語言我們自己也用不到——OmniCode 自己的工作區是 PHP+JS，
  使用者帶來的工作區大多是這兩種，少數是 Python/TS。
- 零依賴的代價是語言覆蓋率，**這是我們的取捨，不是缺陷**。

### 3.2 不做 Hybrid LSP 語意型別解析
**cbm 寫了 10 種語言的 C 版輕量 LSP 解析器**（trait、泛型、UFCS…），
把 `$obj->method()` 解到正確的方法。
**OmniCode 不做的原因**：
- 上個版本做過評估：純 PHP 走 `token_get_all` 已能精確處理
  namespace/類/函式/use 匯入/呼叫邊（見 `codegraph.php:88-150`）。
- 為了型別解析要多寫 ~3 倍程式碼、維護負擔遠超當前使用者量。
- trace 的 `out` 方向遇到解不到的名字**標「外部／未解析」**就夠誠實了，
  精確解析的收益目前不值得成本。

### 3.3 不做背景 daemon + watcher + auto-index
**cbm 啟動 per-account daemon**（detached process），
背後是 git 輪詢線程 + 自動索引 + watcher。
**OmniCode 不做的原因**：
- 部署在 XAMPP/Apache，每個請求是短命 PHP 進程——沒有「長駐背景執行緒」這回事。
- 每次查詢前自動同步（`oc_cg_sync`）已經夠快了，
  OmniCode 工作區量級（< 1 萬檔）下增量同步 < 100ms。
- 真要做 watcher 得寫 Windows Service / 排程——**ROI 極低**。

### 3.4 不做語意搜尋（vector embeddings + 11 信號評分）
**cbm 把 nomic-embed-code 編進二進位、768d int8 向量**。
**OmniCode 不做的原因**：
- 需要供應商 key / 本地 GGUF 模型——前者破壞「零外部依賴」承諾，後者要 ~500MB 權重。
- 11 信號組合是「BM25 搜不夠精準」的 workaround，
  我們有 `OMNI.md` 自由文本 + `MEMORY.md` 索引，文字檢索已經夠。
- **判定**：**永遠不做**——除非有使用者明確說「我找不到某個函式」，
  而 grep 也找不到，那才考慮加。

### 3.5 不做 CI / PreToolUse hooks
**cbm 對 45 個 agent 客戶端寫 hook**，做安裝時的進程協調。
**OmniCode 不做的原因**：
- 角色顛倒：OmniCode **是** agent 客戶端，**不是** MCP 伺服器（雖然也提供 `mcp-server.php`）。
- 我們的 hook 機制是**權限引擎**（`permissions.js`）——使用者授權模型，不是 agent 協調。
- 想要「安裝時自動加 MCP 設定」其實是 `install` 子命令的工作，
  但 OmniCode 是應用程式不是 CLI 工具，**這條路從一開始就不通**。

### 3.6 不做 3D graph UI
**cbm 在 `localhost:9749` 開 WebGL 視覺化**。
**OmniCode 不做的原因**：
- 圖譜的本質是**給 Agent 用的查詢介面**，不是給人看的視覺化。
- 3D 力導向圖在 100+ 節點就開始卡，OmniCode 工作區輕易破千。
- 如果有天要做「給人看」的視覺化，**2D 樹狀 + 呼叫鏈展開**比 3D 力導向實用得多。
- 前端 bundle 已經夠大（marked + DOMPurify + highlight.js + CodeMirror + diff），
  不要再加 3D 引擎。

### 3.7 不做團隊共享 zstd artifact
**cbm 推 `.codebase-memory/graph.db.zst` 入 git**。
**OmniCode 不做的原因**：
- OmniCode 自己的工作區**是 OmniCode 的原始碼**，
  索引跟原始碼耦合——原始碼動了索引就過期，入 git 是污染歷史。
- `.omni/codegraph.json` 跟 `node_modules` 同性質，**.gitignore 永遠排除**。
- cbm 自己文件也警告「一個團隊 350 次 commit 把 20MB 吹成 6GB」——
  這正是我們想避開的災難。

### 3.8 不學 cbm 的發布基礎設施
**cbm 有 SLSA Level 3、sigstore cosign、VirusTotal 三候選人審、CodeQL SAST**。
**為什麼列在這**：不是不能做，是 OmniCode 是個 PHP 應用，**不是發行給別人裝的軟體**——
沒有發版流程就不需要這些。`selfimprove_log` 就是我們的「發版紀錄」。

### 3.9 跨服務 HTTP 邊（v1.5.0 評估結論：不做）
cbm 的 `HTTP_CALLS` 邊把三件事綁在一起：
1. **後端 route 收集器**（讀 `web.php` / `routes/api.php` / `@Route` 註解）
2. **前端呼叫點收集器**（`fetch()` / `axios.get()` / GraphQL 查詢）
3. **URL + HTTP method 配對**，給信心分數

**OmniCode 評估**：每半邊都要對該語言的 DSL 寫正則／詞法器。
PHP 半邊 4 個常見框架（Laravel / Symfony / Slim / CodeIgniter）的 DSL 各不同；
JS/TS 半邊 `fetch` / `axios` / `trpc` / `GraphQL` 又是 4 套。
完整版預估 3–5 天、2–3 千行，且我們目前**沒有真實的跨服務工作區**（OmniCode 自己的工作區是單進程 PHP+JS）。

**v1.5.0 決策（2026-09-06 拍板）**：**不做**。
- 觸發條件：當有真實使用者帶 Laravel/Vue 或類似前後端分離工作區進 OmniCode、且
  `codebase-onboarding` 撞牆「trace 看得見後端、看不見前端」時，重新打開這條。
- 文件化：此段評估留作下次動工時的「成本清單」——不會無腦重做。

**為什麼不是 v1.5.0 的輕量版**：先前在 #1 `get_architecture` 已能用「方法名命中
  handle/action/route/HTTP 動詞前綴」粗略標出路由（見 `codegraph.php:1031`），
  這對單進程 PHP 已經夠用；JS 端連這種粗略線索都沒有（我們的 JS 沒有 route
  概念），做半邊反而會誤導。

---

## 4. 對 OmniCode 工作流的具體改進（規劃層）

| 場景 | 改進 | 對應待辦 |
|---|---|---|
| 接手陌生 repo | 「這是個什麼樣的專案」5 秒回 | #1 architecture + #6 設定檔 |
| 改完想發 PR | 「這次改了會炸到誰」秒回 | #2 detect_changes |
| 跨會話架構決策 | 「當年為什麼這樣設計」找得到 | #3 ADR |
| 用 OmniCode 改 Laravel/Vue | trace 看得見 HTTP ↔ 前端 | #4 跨服務（暫緩） |
| 自己改自己 | event bus 全鏈條可追 | #5 EMITS（暫緩） |

**v1.4.0 預計做**：#1 + #2 + #6（同捆，單一 feature：「接手陌生 repo 的第一天」）。
**v1.5.0 預計做**：#3（ADR，獨立 feature）+ 評估是否做 #4。
**不做**：#5、#7、#8 + §3 全部。

---

## 5. 取捨的可逆性

下列 3 個**改變心意時成本仍低**，可隨時再做：
- §3.4 語意搜尋——加一個 vendor 端點即可
- §3.5 hooks——已經有 `permissions.js`，擴充成本低
- §3.6 3D UI——純前端，不影響後端契約

下列 2 個**改變心意時成本高**，要慎重：
- §3.1 vendored tree-sitter——零依賴承諾一破就回不去
- §3.3 背景 daemon——部署模型（XAMPP/Apache）若要改，整個後端要重構

---

## 6. 參考

- cbm README：<https://github.com/DeusData/codebase-memory-mcp>
- 論文：[arXiv:2603.27277](https://arxiv.org/abs/2603.27277)
- 我們 v1.0.0 codegraph 移植紀錄：`docs/ARCHITECTURE.md` §8.11
- 版本規劃：`selfimprove_roadmap` 工具（v1.4.0 / v1.5.0）
