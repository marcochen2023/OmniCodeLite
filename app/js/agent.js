'use strict';
// ═══════════════════════════════════════════════════════════════
// Omni Code — Agent 主迴圈
// ═══════════════════════════════════════════════════════════════
// 對標 Claude Code 的代理迴圈：
//   使用者訊息 → 串流回覆 → 工具呼叫 → 權限閘 → 執行 → 回填 → 再迴圈
// 具備：中止、自動壓縮、平行唯讀工具、錯誤自癒、子代理、Todo。
// 契約見 ARCHITECTURE.md §11
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// System Prompt 組裝（每輪重算，因為環境會變）
// ═══════════════════════════════════════════════════════════════

const IDENTITY = `你是 Omni Code —— 一個在瀏覽器裡執行、對本機工作區擁有完整權限的 AI 程式開發代理。
你不只是聊天：你能讀寫檔案、執行命令、搜尋程式碼、上網查資料、生成與編修圖片素材，
還能直接操作這個 IDE 介面本身（開檔案、切面板、跑預覽、顯示 diff）。

【行為準則】
1. 回覆語言見本輪【回覆語言】一節（跟著使用者的介面語系走）。程式碼、指令、識別字保持原文。
2. 先動手，再解釋。不要問「要我幫你做嗎」——使用者叫你做，就直接做完再回報。
3. 絕不臆造。不確定檔案內容就去讀，不確定 API 就去查，不確定結果就去執行驗證。
4. 回報要誠實：測試沒過就說沒過並附上輸出；跳過了某步驟就講明；做完且驗證過才說「完成」。
5. 簡潔。使用者看得到你的工具呼叫過程，不需要你複述做了哪些步驟；講結論與影響。
6. 修改程式碼要融入既有風格：命名、縮排、註解密度、慣用寫法都跟著周圍的程式碼走。
7. 註解只寫「程式碼本身表達不了的約束」。不要寫「這行在做什麼」或「這是我改的」。

【工作方法】
- 動手改任何檔案前，一定先 read_file 讀過它。這是硬性規定，違反會直接被工具擋下。
- 找檔案用 glob，找內容用 grep。不要用 bash 的 dir / findstr / ls。
- 可以平行的唯讀操作（讀多個檔、多個搜尋）請在同一輪一次送出，不要一個一個來。
- 任務有 3 個以上步驟時，先用 todo_write 列出計畫，每完成一項立刻更新狀態。
- 大範圍調查（要翻很多檔案才得到一個答案）可以派 spawn_agent 去做，保留你的上下文。
- 改完程式碼後一定要呼叫 verify 驗證。它會自動偵測專案的檢查方式（語法／lint／測試）。
  沒通過就修到通過為止；真的修不好，如實說卡在哪裡，不要宣稱完成。
  verify 說「找不到可執行的檢查」時，改用 bash 跑一個你認為能證明改動可用的命令。
- 使用者表達偏好或糾正你時，用 remember 存下來（連同原因）。

【還原點】
- 你每一輪動的檔案都會在改動前自動備份，使用者可以用 /rewind 整批還原。
- 這是給使用者的安全網，不是給你亂改的許可證：照樣先讀再改、照樣謹慎。
- bash 命令的副作用（裝套件、改資料庫、送 API）救不回來。這類操作前要說清楚你要做什麼。`;


const BATCH_PLAYBOOK = `
═══ 批次與多模態工作 ═══
遇到下列類型的任務，照這些既定流程做，不要自創低效率的做法：

【研讀多份文件後回答】
用 read_files 一次讀多個檔（每批最多 8 個）；被截斷的檔用 read_file offset 續讀。
「全部讀完」才開始作答 —— 先用 todo_write 列出要讀的檔案清單，逐批勾掉，
最後的回答要引用具體檔案與行號，讓使用者能查證。

【批次生成圖片（使用者給一組提示詞）】
用 generate_images 一次排入整批（每行一個提示詞 → items 一筆一張），不要逐張呼叫。
開始前告知預估時間（每張約 15–30 秒）。中文提示詞先翻成具體的英文。
完成後回報成功／失敗清單；失敗的單獨重試，不要整批重跑。

【批次分析／分類圖片（例如 100 張分成男女老少四個資料夾）】
1. glob 或 list_dir 取得完整檔案清單，todo_write 記錄總數與進度
2. 先 make_dir 建好所有目標資料夾
3. read_images 每批 6–8 張 → 逐張判斷 → 立刻用 move_path 搬移（判斷完就搬，不要攢到最後）
4. 重複直到清單見底。已處理的圖不要重讀；舊圖會自動從上下文清除，這是正常的
5. 最後列出每個資料夾的張數統計，加總必須等於原始總數 —— 對不上就找出漏掉的檔案

【分析影片／音訊】
用 analyze_video。要產出「影片生成提示詞」時，instruction 必須要求：
依內容在轉場／場景／動作變化處自然切分（時長不規則，不是固定每 10 秒一刀）、
每段標明起訖時間、描述構圖／主體／動作／運鏡／光線／風格。
結果通常很長，帶 save_to 存成檔案。300MB 以上的長片先提醒使用者要等幾分鐘。`;

async function buildSystemPrompt({ subagent = false, readonly = false } = {}) {
    await Promise.all([loadOmniMd(), loadMemories(), loadSkills()]);

    const mode = window.currentMode?.() || 'project';

    // ── AI 對話模式：沒有工作區、沒有檔案工具，整份提示換成通用助理 ──
    // 子代理不受影響（它們只會在專案／自我提升模式被派出去）。
    if (mode === 'chat' && !subagent) {
        const p = [window.CHAT_IDENTITY];
        try { if (typeof t === 'function') p.push(`═══ 回覆語言 ═══\n${t('sys.langRule')}`); } catch {}
        p.push(`
═══ 環境 ═══
- 平台：${OC.env.os || 'Windows'}
- 這個模式沒有工作區，也沒有任何檔案系統工具。
- 即時狀態（今天日期、目前模型、任務清單）見對話中的 <runtime-context> 訊息。`);
        p.push(`\n═══ 權限 ═══\n${permissionPromptSection()}`);
        const mem = memoryIndexSection();
        if (mem) p.push(mem);
        if (OC.skills.length) {
            // vibe 是 SKILL frontmatter 裡的一行人格定位（如「30 秒內嗅出 race condition」），
            // 拿來當 description 的子句有兩個好處：(1) 比 description 更短更聚焦，
            // 適合模型一眼判斷；(2) 沒寫 vibe 的舊技能照舊只用 description，相容。
            p.push(`\n═══ 可用技能 ═══\n覺得有 1% 可能適用某個技能，就必須先呼叫 skill(name) 載入完整說明再照著做——這是紀律，不是建議。\n先載入再回應／提問／讀檔／動手；載入後發現不適用才可不用。「這很簡單」「先看一眼再說」這類念頭一律視為開脫，無效。\n`
                + OC.skills.map(s => {
                    const vibe = s.vibe ? ` · ${s.vibe}` : '';
                    return `- ${s.name}：${s.description}${vibe}`;
                }).join('\n'));
        }
        return p.join('\n');
    }

    const parts = [IDENTITY];
    // 回覆語言跟著介面語系走（英文介面下 Agent 用英文回覆；見 i18n.js sys.langRule）
    try { if (typeof t === 'function') parts.push(`═══ 回覆語言 ═══\n${t('sys.langRule')}`); } catch {}

    // ─── 環境（只留完全靜態的部分）───
    // 日期、git 狀態、開啟中的檔案這些「每一步都在變」的資訊
    // 已抽到 buildRuntimeContext()，以使用者訊息的形式注入。
    // 系統提示每一個字元的變動都會打斷供應商的前綴快取 ——
    // 長會話下等於每一步都用原價重算整份系統提示與工具定義。
    parts.push(`
═══ 環境 ═══
- 工作區（你的權限範圍，所有路徑都相對於此）：${OC.ws}
- 平台：${OC.env.os || 'Windows'}／PHP ${OC.env.php || '?'}／XAMPP Apache
- 你只能存取工作區內的檔案；工作區外的路徑會被後端拒絕。
- 即時狀態（今天日期、目前模型、git、開啟中的檔案、任務清單）見對話中的
  <runtime-context> 訊息，永遠以「最新的一則」為準。`);
    // 額外工作資料夾（跟著目前對話走）：有掛才出現，沒掛不佔系統提示
    try {
        const xr = (window.extraRoots?.() || []).filter(r => r && r.alias && r.path);
        if (xr.length) {
            parts.push(`\n═══ 額外工作資料夾（跟著目前對話走，一樣完整讀寫）═══\n`
                + xr.map(r => `- extra:${r.alias}/… → ${r.path}`).join('\n')
                + `\n用法跟工作區相同，只是路徑前面加 extra:<別名>/ 前綴，例如 extra:${xr[0].alias}/README.md。`
                + `未掛載的工作區外路徑仍會被後端拒絕，不要自己拼絕對路徑。`);
        }
    } catch {}

    // ─── 權限 ───
    parts.push(`\n═══ 權限 ═══\n${permissionPromptSection()}`);
    parts.push(BATCH_PLAYBOOK);
    const _gn = window.disabledGroupNote?.();
    if (_gn) parts.push(_gn);

    // ─── OMNI.md ───
    const omni = omniMdSection();
    if (omni) parts.push(omni);
    else if (!subagent) {
        parts.push(`\n（本工作區還沒有 OMNI.md 專案指示檔。若使用者要求「初始化」或你察覺這個專案值得長期記錄慣例，可以主動建議執行 /init。）`);
    }

    // ─── 自我提升：版本、規劃、歷程 ───
    if (mode === 'self' && !subagent) {
        parts.push(await window.selfPromptSection?.() || '');
    }

    // ─── 記憶索引 ───
    if (!subagent) {
        const mem = memoryIndexSection();
        if (mem) parts.push(mem);
    }

    // ─── 自訂子代理 ───
    // 只放「名稱 — 描述」，正文等 spawn_agent 真的派工時才載入，
    // 跟技能一樣的漸進式揭露，放很多也不吃上下文。
    if (!subagent && OC.agents?.length) {
        parts.push(`\n═══ 可用子代理 ═══\n需要專職處理時，用 spawn_agent 並指定 agent 名稱：\n`
            + OC.agents.map(a => `- ${a.name}：${a.description || '（沒有描述）'}`
                + (a.readonly ? '（唯讀）' : '')).join('\n'));
    }

    // ─── 技能 ───
    if (!subagent && OC.skills.length) {
        parts.push(`\n═══ 可用技能 ═══\n覺得有 1% 可能適用某個技能，就必須先呼叫 skill(name) 載入完整說明再照著做——這是紀律，不是建議。\n先載入再回應／提問／讀檔／動手；載入後發現不適用才可不用。「這很簡單」「先看一眼再說」這類念頭一律視為開脫，無效。\n`
            + OC.skills.map(s => {
                const vibe = s.vibe ? ` · ${s.vibe}` : '';
                return `- ${s.name}：${s.description}${vibe}`;
            }).join('\n'));
    }

    if (readonly) {
        parts.push(`\n═══ 限制 ═══\n你目前只有唯讀權限：可以讀檔、搜尋、查資料，但不能修改檔案或執行命令。請完成調查後回報結論。`);
    }

    return parts.join('\n');
}


// ═══════════════════════════════════════════════════════════════
// 即時執行環境快照（runtime context）
// ═══════════════════════════════════════════════════════════════
// 為什麼不放系統提示：那裡一個字元變了，供應商的前綴快取就整段作廢。
// 改成雜湊比對 —— 沒變就完全不注入，變了才以 user 訊息補一則新快照，
// 並把舊快照替換成一行說明（免得模型拿過期狀態推論、也省上下文）。

function buildRuntimeContext() {
    const now = new Date();
    const openList = OC.openFiles.length
        ? OC.openFiles.map(f => f.path + (f.dirty ? '（未存檔）' : '')).join('、')
        : '（無）';
    let git = '';
    if (OC._gitInfo) {
        git = `\nGit：分支 ${OC._gitInfo.branch || '?'}${OC._gitInfo.dirty ? `，有 ${OC._gitInfo.dirty} 個未提交的變更` : '，工作區乾淨'}`;
    }
    let todos = '';
    if (OC.todos.length) {
        const icon = { completed: '✅', in_progress: '⏳', pending: '⬜' };
        todos = `\n任務清單：\n` + OC.todos.map(t => `${icon[t.status]} ${t.content}`).join('\n')
              + `\n（完成一項就用 todo_write 更新整份清單）`;
    }
    return `<runtime-context>\n`
        + `今天：${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}\n`
        + `目前模型：${getModelInfo(OC.cfg.model).displayName}\n`
        + `編輯器開啟中：${openList}\n`
        + `目前面板：左「${OC.panel}」／下「${OC.dock}」`
        + git + todos + `\n</runtime-context>`;
}

function djb2(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return h;
}

/** 快照沒變就什麼都不做；變了才注入新的、並把舊的縮成一行。 */
function maybeInjectRuntimeContext() {
    const rc = buildRuntimeContext();
    const h = djb2(rc);
    if (OC._rcHash === h) return;
    // 舊快照縮成一行 —— 兩份「即時狀態」並存的話，模型會挑到過期的那份
    for (const m of OC.messages) {
        if (m._runtime && !m._stale) {
            m._stale = true;
            m.content = [{ type: 'text', text: '（過期的 runtime-context 快照，已由較新的一則取代）' }];
        }
    }
    OC.messages.push({ role: 'user', _runtime: true, content: [{ type: 'text', text: rc }] });
    OC._rcHash = h;
}

// ═══════════════════════════════════════════════════════════════
// 技能載入
// ═══════════════════════════════════════════════════════════════
let _skillsLoadedAt = 0;
async function loadSkills(force = false) {
    if (!force && _skillsLoadedAt && Date.now() - _skillsLoadedAt < 30000) return OC.skills;
    try {
        const r = await SESS.skills();
        OC.skills = r.skills || [];
    } catch { OC.skills = []; }
    try {
        const a = await SESS.agents();
        OC.agents = a.agents || [];
    } catch { OC.agents = []; }
    _skillsLoadedAt = Date.now();
    window.renderSkillsPanel?.();
    return OC.skills;
}

// ═══════════════════════════════════════════════════════════════
// Git 狀態（背景更新，供 system prompt 使用）
// ═══════════════════════════════════════════════════════════════
async function refreshGitInfo() {
    try {
        const st = await FS.stat('.git');
        if (!st.exists) { OC._gitInfo = null; return; }
        const r = await EXEC.run('git branch --show-current && git status --porcelain', '', 8000);
        const lines = (r.stdout || '').split(/\r?\n/).filter(Boolean);
        OC._gitInfo = { branch: lines[0] || '', dirty: Math.max(0, lines.length - 1) };
    } catch { OC._gitInfo = null; }
}

// ═══════════════════════════════════════════════════════════════
// 主迴圈
// ═══════════════════════════════════════════════════════════════

async function runAgent(userText, attachments = []) {
    if (OC.running) { toast(t('common.runningBusy'), 'warn'); return; }

    // 斜線指令本地短路
    if (userText.trim().startsWith('/')) {
        const handled = await window.handleSlash?.(userText.trim());
        if (handled) return;
    }

    OC.running = true;
    OC.abort = new AbortController();
    OC.turn = 0;
    OC.lastError = null;
    OC._errLoggedThisTurn = false;

    // 新的一輪 = 新的還原點。實際的檢查點延遲到第一次寫入才建立，
    // 純問答的回合不會留下空檢查點。
    OC.checkpointId = null;
    OC._cpWarned = false;
    OC._turnLabel = userText.trim().slice(0, 60) || '（附件）';
    // 自我提升兜底記錄用：這一輪開始前動過幾個檔案、模型有沒有自己記
    OC._selfLogged = false;
    const _selfFilesBefore = new Set(OC.session.files_touched || []).size;

    window.setRunningUI?.(true);

    // 使用者訊息入列
    const content = [];
    for (const a of attachments) content.push({ type: 'image', mime: a.mime, data: a.data });
    if (userText.trim()) content.push({ type: 'text', text: userText });

    // @ 提及的檔案內容直接附上，省掉模型「先讀一輪」的來回
    let mentioned = [];
    if (userText.includes('@')) {
        try {
            const ex = await window.expandMentions?.(userText);
            if (ex?.blocks?.length) { content.push(...ex.blocks); mentioned = ex.mentioned || []; }
        } catch (e) { window.OCLog?.('展開 @ 提及失敗：' + e.message); }
    }

    // UserPromptSubmit hook：專案可以在每次提問時注入額外上下文
    // （例如目前 git log、正在跑的服務狀態）
    try {
        const extra = await window.hookUserPrompt?.(userText, OC.abort.signal);
        if (extra) content.push({ type: 'text', text: extra });
    } catch { /* hook 壞掉不該擋住對話 */ }

    if (content.length) {
        OC.messages.push({ role: 'user', content });
        window.chatAppendUser?.(userText, attachments, mentioned);
    }

    refreshGitInfo();   // 不 await，讓它背景更新

    let failStreak = 0;
    let hitLimit = true;
    OC._overflowRetries = 0;
    OC._fallbackSwaps = 0;
    window.runDedupeClear?.();        // 單輪去重的作用域就是這一次執行                 // 只要是 break 出來的就清掉
    let autoVerifyDone = 0;              // 自動驗證已經回饋過幾次（避免無限修不好）
    const maxTurns = OC.cfg.maxTurns || 40;

    try {
        while (OC.turn < maxTurns) {
            if (OC.abort.signal.aborted) { hitLimit = false; break; }
            OC.turn++;

            // 1) 上下文預算
            await maybeCompact();

            // 2) 組裝
            const system = await buildSystemPrompt();
            maybeInjectRuntimeContext();
            OC._lastSysTokens = estTokens(system);
            OC.tools = activeTools();

            // 3) 串流
            const bubble = window.chatBeginAssistant?.();
            let res;
            try {
                res = await streamChat({
                    model: OC.cfg.model,
                    system,
                    messages: OC.messages,
                    tools: OC.tools,
                    signal: OC.abort.signal,
                    onText: (d) => window.chatStreamText?.(bubble, d),
                    onThinking: (d) => window.chatStreamThinking?.(bubble, d),
                    onToolStart: ({ id, name }) => window.chatToolPending?.(bubble, id, name),
                    onToolInput: (id, d) => window.chatToolInputDelta?.(bubble, id, d),
                });
            } catch (e) {
                window.chatEndAssistant?.(bubble);
                if (e.name === 'AbortError' || OC.abort.signal.aborted) {
                    window.chatSystemNote?.('已中止', 'stop');
                    hitLimit = false; break;
                }
                OC.lastError = e;
                if (e.code === 'NO_KEY') {
                    window.chatSystemNote?.(e.message, 'error');
                    window.openKeysModal?.();
                    hitLimit = false; break;
                }
                // 上下文超限：先壓縮再重試這一步，而不是讓整輪死掉。
                // estTokens 是概估，長會話難免飄移到供應商那邊才被打回來 ——
                // 這在以前是死路（使用者只能手動 /compact 再重講一次）。
                // 護欄：只有「壓縮真的讓用量變小」才重試，最多兩次，
                // 否則壓不動的會話會在這裡無限打轉。
                if (e.code === 'CONTEXT_WINDOW_EXCEEDED' && (OC._overflowRetries || 0) < 2) {
                    OC._overflowRetries = (OC._overflowRetries || 0) + 1;
                    const before = contextUsage().used;
                    window.chatSystemNote?.('⚠ 上下文超過模型上限，正在壓縮後重試…', 'warn');
                    microCompact();
                    if (contextUsage().used > before * 0.9) {
                        await compactContext({ auto: true });
                    }
                    if (contextUsage().used < before) {
                        OC.turn--;          // 這一步重來，不吃輪數額度
                        continue;
                    }
                }
                // 換備援模型再試一次，而不是整輪死掉。
                // 每輪最多換兩次，避免一路把備援鏈燒完。
                const alt = window.nextHealthyModel?.(OC.cfg.model);
                if (alt && (OC._fallbackSwaps || 0) < 2) {
                    OC._fallbackSwaps = (OC._fallbackSwaps || 0) + 1;
                    const from = getModelInfo(OC.cfg.model).displayName;
                    const to = getModelInfo(alt).displayName;
                    OC.cfg.model = alt;
                    OC._anchor = null;           // 錨點屬於舊模型，換模型就失效
                    window.renderModelButton?.();
                    window.renderEffortButton?.();
                    window.chatSystemNote?.(
                        `${from} 暫時無法使用（${e.message}），已切換到 ${to} 繼續。`
                        + `原模型冷卻 30 分鐘；用 /model 明確選它可立即解除。`, 'warn');
                    OC.turn--;                   // 這一步重來，不吃輪數
                    continue;
                }
                window.chatSystemNote?.(`呼叫模型失敗：${e.message}`, 'error');
                errorTicker('模型呼叫失敗', e.detail || e.message);
                hitLimit = false; break;
            }

            // 4) 統計
            OC.usage.in += res.usage?.input || 0;
            OC.usage.out += res.usage?.output || 0;
            // 錨定 token 計量：供應商回報的 input 用量是「這次請求的精確總量」，
            // 存下來讓 contextUsage() 以它為基準，只概估之後新增的部分
            const anchorTok = (res.usage?.input || 0) + (res.usage?.cache_read || 0) + (res.usage?.cache_write || 0);
            if (anchorTok > 0) {
                OC._anchor = {
                    tokens: anchorTok,
                    msgCount: OC.messages.length,
                    model: OC.cfg.model,
                    sysTokens: OC._lastSysTokens || 0,
                    toolTokens: estTokens(JSON.stringify((OC.tools || []).map(t => ({ n: t.name, d: t.description, p: t.params })))),
                };
            }
            window.renderTokenMeter?.();

            const toolUses = res.content.filter(b => b.type === 'tool_use');

            // api.js 在回覆被長度截斷時會拔掉殘缺的 tool_use（參數不可信），
            // 這裡只需要停下來讓使用者決定要不要繼續
            if (res.truncatedToolCalls) {
                if (res.content.length) OC.messages.push({ role: 'assistant', content: res.content });
                window.chatEndAssistant?.(bubble, res);
                window.chatSystemNote?.('⚠ 回覆因長度上限被截斷，其中的工具呼叫參數不完整、已略過執行。可以叫我「繼續」。', 'warn');
                hitLimit = false; break;
            }

            // ★ thinking 區塊必須保留在歷史裡。
            // 開啟擴展思考時，Anthropic 規定帶工具呼叫的 assistant 回合，
            // 下一輪必須把 thinking 連同簽章原樣送回，否則整個請求被拒。
            // 這裡丟掉的話，簽章就永遠回不去了。
            // 其他供應商的轉譯層（msgsForOpenAI / msgsForGemini）本來就會略過
            // thinking，所以保留不會造成副作用。
            const assistantContent = res.content;
            if (assistantContent.length) OC.messages.push({ role: 'assistant', content: assistantContent });
            window.chatEndAssistant?.(bubble, res);

            // 5) 沒有工具呼叫 → 回合結束（但先做自動驗證）
            if (!toolUses.length) {
                hitLimit = false;                     // 正常結束，不是撞到輪數上限
                if (res.stopReason === 'max_tokens' || res.stopReason === 'length') {
                    window.chatSystemNote?.('⚠ 回覆長度達上限而被截斷。可以叫我「繼續」。', 'warn');
                    break;
                }
                // Agent 說做完了 —— 動過程式碼就實際驗證一次再放它走。
                // 「看起來沒問題」是最貴的謊，而模型自己不一定會主動去驗。
                const fb = await autoVerifyFeedback(autoVerifyDone);
                if (fb) {
                    autoVerifyDone++;
                    OC.messages.push({ role: 'user', content: [{ type: 'text', text: fb }] });
                    continue;                          // 把失敗結果丟回去讓它修
                }
                // 使用者在執行期間補充了訊息 → 接著處理，不要就這樣結束
                if (flushQueuedInto(OC.messages)) continue;
                break;
            }

            // 6) 執行工具（工具稽核：學 OpenClaw 的 audit ledger ——
            // 只記「做了什麼、結果如何」，不記參數與輸出內容。
            // 參數可能含金鑰、輸出可能含個資，稽核檔不該成為第二個洩漏源。）
            const results = await runToolBatch(toolUses, bubble);
            try {
                for (const r of results) {
                    auditTool(tu_of(r, toolUses), r);
                }
            } catch { /* 稽核是盡力而為，失敗不擋主流程 */ }
            // 關鍵操作留痕：這一輪有「被擋／被問過／失敗」的工具才秀稽核卡。
            // 全部一次通過的安靜做事就好 —— 卡片是給「有故事」的那一輪看的。
            try {
                const notable = results.filter(r => r.is_error || r.denied || r.sentinel);
                if (notable.length && window.auditCard) {
                    window.auditCard({
                        entries: results.map(r => ({
                            tool: r.name, ok: !r.is_error,
                            denied: !!r.denied, ms: r.ms ?? null, sentinel: !!r.sentinel,
                        })),
                    });
                }
            } catch { /* 卡片畫不出來不該影響迴圈 */ }

            // 7) 回填 tool_result
            const resultBlocks = [];
            const extraImages = [];
            for (const r of results) {
                resultBlocks.push({
                    type: 'tool_result',
                    tool_use_id: r.id,
                    _name: r.name,          // Gemini functionResponse 需要工具名
                    content: r.content || '(無輸出)',
                    is_error: !!r.is_error,
                });
                if (r.attachImage) extraImages.push(r.attachImage);
                if (Array.isArray(r.attachImages)) extraImages.push(...r.attachImages);
            }
            const userTurn = { role: 'user', content: resultBlocks };
            OC.messages.push(userTurn);
            // 工具回傳的圖片以獨立 user 訊息附上（多數供應商不允許 tool_result 內嵌圖片）
            if (extraImages.length) {
                OC.messages.push({
                    role: 'user',
                    _carrier: true,     // 工具附圖的載體，不是真正的使用者輸入
                    content: [
                        ...extraImages.map(i => ({ type: 'image', mime: i.mime, data: i.data, _tool: true })),
                        { type: 'text', text: '（以上是工具回傳的圖片）' },
                    ],
                });
            }

            // 8) 錯誤自癒
            const allFailed = results.length > 0 && results.every(r => r.is_error);
            const anyAborted = results.some(r => r.aborted);
            if (anyAborted || OC.abort.signal.aborted) { hitLimit = false; break; }

            if (allFailed) {
                failStreak++;
                if (failStreak >= 3) {
                    window.chatSystemNote?.('連續三輪工具全部失敗，已停止以免空轉。請看看上面的錯誤訊息。', 'error');
                    hitLimit = false; break;
                }
                // 查一下以前有沒有踩過同樣的坑。有的話直接把對策端到眼前 ——
                // 讓模型自己想到要去搜，比直接給它答案慢得多，也常常想不到。
                let priorHint = '';
                try {
                    const firstErr = results.find(r => r.is_error);
                    const q = String(firstErr?.content || '').slice(0, 200);
                    const r = await SESS.errmemSearch(q, firstErr?._name || '', 3);
                    const hits = (r.errors || []).filter(x => x.cause);
                    if (hits.length) {
                        priorHint = '\n\n[以前踩過的同類問題]\n' + hits.map(h =>
                            `· ${h.tool}：${h.symptom}\n  原因：${h.cause}\n  對策：${h.action}`
                            + (h.outcome === 'abandoned' || h.outcome === 'failed' ? '（註：這條路當時沒走通）' : '')
                        ).join('\n');
                    }
                } catch { /* 查不到就算了，不能因此讓自癒流程中斷 */ }

                userTurn.content.push({
                    type: 'text',
                    text: `[系統提示] 這一輪所有工具都失敗了（第 ${failStreak} 次）。`
                        + `請先讀懂上面的錯誤訊息、診斷真正的原因，然後改用不同的做法——不要原封不動重試同樣的呼叫。`
                        + `如果是路徑問題，先用 glob 或 list_dir 確認實際路徑。`
                        + priorHint
                        + (priorHint ? '\n（修好之後請用 remember_error 把結論記下來。）' : ''),
                });
            } else {
                // 從全敗中恢復：這一輪之前至少失敗過一次，現在成功了 ——
                // 這正是有故事可記的時刻（Hermes 的 background review 在做的事，
                // 這裡用輕量版：只在「真有坑」時提醒，不每輪打擾）。
                // 若模型已經自己記了（remember_error 剛調用過）就不必多嘴。
                if (failStreak > 0 && !OC._errLoggedThisTurn) {
                    userTurn.content.push({
                        type: 'text',
                        text: `[系統提示] 你剛才從連續失敗中恢復了（之前失敗 ${failStreak} 輪）。`
                            + `如果這次查明了「真正原因 → 有效對策」，請用 remember_error 把它記下來，`
                            + `之後的會話遇到同類錯誤會自動看到；如果只是換個做法碰巧繞過、原因仍不明，就不用記。`,
                    });
                }
                failStreak = 0;
            }

            // 9) 若使用者拒絕了某個工具，讓模型知道要調整方向
            const denied = results.filter(r => r.denied);
            if (denied.length) {
                userTurn.content.push({
                    type: 'text',
                    text: `[系統提示] 使用者拒絕了 ${denied.map(d => d.name).join('、')} 的執行。`
                        + `請不要重試同樣的操作；改問使用者想怎麼做，或換一個不需要該權限的方式。`,
                });
            }

            // 10) 回合邊界：把使用者執行期間打的訊息插進來。
            // 在這裡注入而不是中途打斷，是因為工具結果必須緊跟在 tool_use 之後——
            // 插在中間會讓四家供應商全部回 400。
            flushQueuedInto(OC.messages);
        }

        // 只有「真的把輪數用完還沒收尾」才提示；正常在最後一輪結束不算超限
        if (hitLimit && OC.turn >= maxTurns) {
            window.chatSystemNote?.(`已達單次最多 ${maxTurns} 輪的上限而停止。要我繼續的話再說一聲。`, 'warn');
        }
    } finally {
        OC.running = false;
        window.setRunningUI?.(false);
        window.renderTokenMeter?.();
        await window.saveSession?.();
        // 壓縮前記憶沖洗（學 OpenClaw 的 memory flush）：壓縮會丟細節，
        // 在自動壓縮真的動手之前，先讓模型把「還沒記下來的重要事」寫進記憶。
        // 只在「下一輪真的會壓縮」時觸發，平常不打擾也不燒 token。
        try { await window.memoryFlushIfNeeded?.(); } catch {}
        maybeAutoTitle();
        // 自我提升模式：模型沒自己記歷程就兜底補一筆（見 modes.js）
        try { await window.selfAfterRun?.({ filesBefore: _selfFilesBefore }); } catch {}
        refreshGitInfo();
        window.refreshFileTree?.();
        window.invalidateMentionIndex?.();     // 檔案可能增減了，@ 索引要重建
        // Stop hook：Agent 收工時跑一次（例如自動 lint / 通知）
        try { await window.hookStop?.(); } catch { /* 收尾階段的失敗不再向上拋 */ }
    }
}

// ─── 工具稽核（學 OpenClaw 的 audit ledger 輕量版）────────────────
// 記什麼：時間、會話、工具名、成功／失敗、耗時。不記參數與輸出 ——
// 參數可能含 API key，輸出可能含個資與檔案全文，稽核檔不該變成第二個洩漏源。
// 存在 data/logs/audit.log（JSON Lines，後端 oc_log 同一條通道），
// 使用者可用 /audit 翻最近紀錄。
function tu_of(r, toolUses) {
    return toolUses.find(t => t.id === r.id) || { name: r.name };
}
function auditTool(tu, r) {
    try {
        const line = JSON.stringify({
            ts: new Date().toISOString(),
            sess: OC.session?.id || '',
            tool: tu.name || r.name || '?',
            ok: !r.is_error,
            denied: !!r.denied,
            sentinel: !!r.sentinel || !!r.sentinelBroken,
            ms: r.ms ?? null,
        });
        // 經後端寫檔：前端自己寫不了 data/，且統一走 LOCK_EX 避免併發互蓋
        fetch(API_BASE + 'settings.php?action=audit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ line }),
        }).catch(() => {});
    } catch { /* 忽略 */ }
}

// ─── 執行中排隊的訊息 ───
// 使用者在 Agent 跑的時候打字 → 進佇列 → 下一個回合邊界注入。
// 為什麼不立刻打斷：tool_result 必須緊接在對應的 tool_use 之後，
// 中間插一則 user 訊息會讓四家供應商全部回 400。
function queueMessage(text, attachments = []) {
    const t = String(text || '').trim();
    if (!t && !attachments.length) return;

    if (!OC.running) {                     // 已經跑完了 → 直接當新一輪送出
        runAgent(t, attachments);
        return;
    }
    const item = { text: t, attachments, at: Date.now(), _expanded: null };
    OC.queued.push(item);
    window.chatAppendQueued?.(t, attachments, OC.queued.length - 1);
    window.renderQueueBadge?.();

    // @ 提及在排隊時就先展開：排到的時候檔案可能已經被 Agent 改過，
    // 但使用者要的是他「當下看到」的那份內容。
    if (t.includes('@')) {
        window.expandMentions?.(t)
            .then(ex => { if (ex?.blocks?.length) item._expanded = ex.blocks; })
            .catch(() => {});
    }
}

// 把佇列裡的訊息倒進對話（在回合邊界呼叫）
function flushQueuedInto(messages) {
    if (!OC.queued.length) return false;
    const batch = OC.queued.splice(0);
    for (const q of batch) {
        const content = [];
        for (const a of (q.attachments || [])) content.push({ type: 'image', mime: a.mime, data: a.data });
        if (q.text) {
            content.push({
                type: 'text',
                // 標明是執行途中補充的，模型才知道這是新指示而非舊訊息重播
                text: `[使用者在你執行途中補充]\n${q.text}`,
            });
        }
        // 排隊訊息裡的 @ 提及一樣要展開（q._expanded 由 queueMessage 預先算好）
        if (q._expanded?.length) content.push(...q._expanded);
        if (content.length) messages.push({ role: 'user', content });
    }
    window.chatMarkQueuedSent?.();
    window.renderQueueBadge?.();
    return true;
}

function clearQueued() {
    if (!OC.queued.length) return;
    OC.queued.length = 0;
    window.chatClearQueued?.();
    window.renderQueueBadge?.();
}

// ─── 自動驗證：Agent 宣稱完成時，實際跑一次檢查 ───
// 通過或無事可驗 → 回傳 null（放行）
// 失敗 → 回傳要餵回模型的訊息，讓它自己修
//
// 最多回饋 MAX_AUTO_VERIFY 次。修不好就停下來如實告訴使用者，
// 而不是讓它在同一個錯誤上反覆空轉燒 token。
const MAX_AUTO_VERIFY = 2;

async function autoVerifyFeedback(doneCount) {
    if (!OC.cfg.autoVerify) return null;
    if (doneCount >= MAX_AUTO_VERIFY) return null;
    if (OC.abort?.signal?.aborted) return null;

    // 這一回合有沒有動過程式碼？沒有就不必驗
    const touched = (OC.session.files_touched || []).filter(p =>
        /\.(js|mjs|cjs|ts|tsx|jsx|php|py|json|css|html)$/i.test(p));
    if (!touched.length) return null;

    const note = window.chatSystemNote?.('🔍 自動驗證改動…', 'verify');
    let out;
    try {
        out = await runVerification('auto', touched, { signal: OC.abort?.signal });
    } catch (e) {
        window.chatSystemNoteUpdate?.(note, `驗證無法執行：${e.message}`);
        return null;                     // 驗證本身壞掉不該擋住使用者
    }

    const passed = out.startsWith('驗證通過');
    const nothing = out.startsWith('找不到任何');

    if (passed) {
        window.chatSystemNoteUpdate?.(note, '✅ 自動驗證通過');
        return null;
    }
    if (nothing) {
        window.chatSystemNoteUpdate?.(note, 'ℹ️ 這個專案還沒有可用的驗證方式');
        return null;
    }

    window.chatSystemNoteUpdate?.(note, `❌ 自動驗證發現問題（第 ${doneCount + 1} 次，最多 ${MAX_AUTO_VERIFY} 次）`);
    return `[系統自動驗證] 你剛才說做完了，但驗證沒過：\n\n${out}\n\n`
         + `請修好這些問題。修完後再呼叫 verify 確認，不要在還沒通過時就說完成。`
         + (doneCount + 1 >= MAX_AUTO_VERIFY
             ? `\n（這是最後一次自動回饋。若這次還修不好，請如實告訴使用者卡在哪裡，不要假裝成功。）`
             : '');
}

// ─── 一輪的工具批次執行（唯讀併發、有副作用序列化）───
// Hermes 式併發：同一輪的工具呼叫全部同時開跑、結果按原順序回填。
// 邊界：
//   - 互動式工具（ask_user、present_plan）一次只跑一個 —— 兩張選項卡
//     同時出現會互相覆蓋，對話框是整頁唯一的。
//   - 寫入／命令／網路類保持序列 —— 併發寫檔會互相覆蓋，檢查點也會混亂。
//   - 唯讀但「問權限」的（敏感檔、mcp__、web_* 在預設模式）先全部同步判定，
//     需要授權的在序列段經 requestPermissionSerial 排隊彈框。
async function runToolBatch(toolUses, bubble) {
    const ctxBase = { signal: OC.abort.signal };
    const results = new Array(toolUses.length);

    // 互動式工具先挑出來：它們強制序列，且不跟任何工具併發
    const interactive = [];
    const rest = [];
    toolUses.forEach((tu, i) => {
        ((tu.name === 'ask_user' || tu.name === 'present_plan' || tu.name === 'present_task') ? interactive : rest).push({ tu, i });
    });

    // 唯讀工具併發跑；有副作用的依序跑
    const parallel = [];
    const serial = [];
    rest.forEach(({ tu, i }) => {
        (PARALLEL_SAFE.has(tu.name) ? parallel : serial).push({ tu, i });
    });

    if (parallel.length) {
        await Promise.all(parallel.map(async ({ tu, i }) => {
            results[i] = await runOne(tu, bubble, ctxBase);
        }));
    }
    for (const { tu, i } of serial) {
        if (OC.abort.signal.aborted) {
            results[i] = { id: tu.id, name: tu.name, content: '（已中止，未執行）', is_error: true, aborted: true };
            continue;
        }
        results[i] = await runOne(tu, bubble, ctxBase);
    }
    // 互動式最後、一個一個跑
    for (const { tu, i } of interactive) {
        if (OC.abort.signal.aborted) {
            results[i] = { id: tu.id, name: tu.name, content: '（已中止，未執行）', is_error: true, aborted: true };
            continue;
        }
        results[i] = await runOne(tu, bubble, ctxBase);
    }
    return results;
}

async function runOne(tu, bubble, ctxBase) {
    const card = window.chatToolStart?.(bubble, tu);
    // 主迴圈標記：remember_error 的 run 用它判斷「這輪已經記過」
    const ctx = { ...ctxBase, toolUseId: tu.id, agent: 'main' };

    // 權限閘
    const perm = checkPermission(tu.name, tu.input);
    if (perm.decision === 'deny') {
        window.chatToolEnd?.(card, { is_error: true, content: perm.reason });
        return { id: tu.id, name: tu.name, content: `操作被拒絕：${perm.reason}`, is_error: true, denied: true };
    }
    if (perm.decision === 'ask') {
        window.chatToolWaiting?.(card);
        // 併發輪裡多個工具可能同時要授權 —— 對話框整頁唯一，排隊等。
        // （序列段本來就一次一個，走同一函式只是多一層鏈，無害。）
        const ans = await window.requestPermissionSerial
            ? window.requestPermissionSerial(tu.name, tu.input)
            : requestPermission(tu.name, tu.input);
        if (!ans.ok) {
            const msg = `使用者拒絕了這個操作。${ans.feedback ? `他說：「${ans.feedback}」` : ''}`;
            window.chatToolEnd?.(card, { is_error: true, content: '使用者拒絕' });
            return { id: tu.id, name: tu.name, content: msg, is_error: true, denied: true };
        }
        window.chatToolResume?.(card);
    }

    // Sentinel 獨立監控（契約 §13.5）：單向收緊，allowRules 蓋不掉。
    // 問過的理由要讓使用者看得出是「第二隻眼」在問，不是重複彈同一個框。
    if (window.sentinelCheck) {
        let sv;
        try { sv = window.sentinelCheck(tu.name, tu.input); }
        catch (e) { sv = { verdict: 'allow', broken: String(e.message || e) }; }
        if (sv && sv.broken) {
            window.chatSystemNote?.(`⚠ Sentinel 監控異常（${sv.broken}），本次放行但已記錄。`, 'warn');
            try { auditTool({ name: tu.name }, { is_error: true, ms: 0, sentinelBroken: true }); } catch {}
        } else if (sv && sv.verdict === 'deny') {
            window.chatToolEnd?.(card, { is_error: true, content: sv.reason });
            return { id: tu.id, name: tu.name, content: `操作被 Sentinel 拒絕：${sv.reason}`, is_error: true, denied: true, sentinel: true };
        } else if (sv && sv.verdict === 'ask') {
            window.chatToolWaiting?.(card);
            const ans = await (window.requestPermissionSerial
                ? window.requestPermissionSerial(tu.name, tu.input, sv.reason)
                : requestPermission(tu.name, tu.input));
            if (!ans.ok) {
                const msg = `使用者拒絕了這個操作（Sentinel：${sv.reason}）。${ans.feedback ? `他說：「${ans.feedback}」` : ''}`;
                window.chatToolEnd?.(card, { is_error: true, content: '使用者拒絕' });
                return { id: tu.id, name: tu.name, content: msg, is_error: true, denied: true, sentinel: true };
            }
            if (sv.netGate) OC._sentinelNetOk = true;   // 對外連線本會話問過一次就好
            window.chatToolResume?.(card);
        }
    }

    const r = await execTool(tu.name, tu.input, ctx);
    window.chatToolEnd?.(card, r);
    return { id: tu.id, name: tu.name, ...r };
}

// ═══════════════════════════════════════════════════════════════
// 子代理
// ═══════════════════════════════════════════════════════════════
async function runSubAgent(task, { readonly = true, maxTurns = 12, agentDef = null, signal } = {}) {
    const label = agentDef ? `🤖 ${agentDef.name}` : '🤖 子代理';
    const noteId = window.chatSystemNote?.(`${label} 啟動：${task.slice(0, 80)}${task.length > 80 ? '…' : ''}`, 'subagent');

    let system = await buildSystemPrompt({ subagent: true, readonly });
    // 專職代理的正文接在基礎提示之後：它描述「這個代理該怎麼做事」，
    // 而不是取代環境／權限那些非有不可的段落。
    if (agentDef?.prompt) {
        system += `\n\n═══ 你的專職角色：${agentDef.name} ═══\n${agentDef.prompt}`;
    }

    let tools = activeTools({ readonly });
    // 定義檔限定了工具就照它縮小範圍——這是專職代理的重點：
    // 給它剛好夠用的工具，它就不會亂跑。
    if (agentDef?.tools?.length) {
        const allow = new Set(agentDef.tools);
        const narrowed = tools.filter(t => allow.has(t.name));
        if (narrowed.length) tools = narrowed;
    }

    const messages = [{ role: 'user', content: [{ type: 'text', text: task }] }];
    const model = agentDef?.model || pickFeatureModel('subagent');
    // Orca worker contract 心法：子代理回來要帶結構（做了什麼／發現／未竟），
    // 而不是一段散文 —— 主代理要比對多路結論時，結構化回報才拼得起來。
    // 用追加而非取代：專職代理的正文（agentDef.prompt）優先，通用回報格式只補底線。
    system += `\n\n═══ 回報格式 ═══\n結論請收束成三段（每段 1–3 行）：\n`
        + `【做了什麼】實際執行的動作\n【發現】關鍵結果（含檔案路徑與行號）\n【未竟／不確定】沒做完或沒把握的事`;

    let final = '';
    let turns = 0;
    try {
        while (turns < maxTurns) {
            if (signal?.aborted) break;
            turns++;
            const res = await streamChat({ model, system, messages, tools, signal, maxTokens: 8192, purpose: 'subagent' });
            const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
            if (text) final = text;
            const uses = res.content.filter(b => b.type === 'tool_use');
            // 同主迴圈：保留 thinking（含簽章），否則 Anthropic 擴展思考 + 工具會被拒
            messages.push({ role: 'assistant', content: res.content });
            if (!uses.length) break;

            const blocks = [];
            const subImages = [];
            for (const tu of uses) {
                window.chatSystemNoteUpdate?.(noteId, `🤖 子代理（第 ${turns} 輪）：${tu.name}`);
                const perm = checkPermission(tu.name, tu.input);
                if (perm.decision === 'deny') {
                    blocks.push({ type: 'tool_result', tool_use_id: tu.id, _name: tu.name, content: `被拒絕：${perm.reason}`, is_error: true });
                    continue;
                }
                // 'ask' 必須真的問使用者。子代理不是繞過權限閘的後門——
                // 否則主代理只要把工作丟給 spawn_agent，就能在「標準」模式下
                // 不經同意執行寫入與命令。
                // 併發的子代理輪（spawn_agents 同時多路）可能同時彈框 ——
                // 對話框整頁唯一，走序列排隊。
                if (perm.decision === 'ask') {
                    const ask = window.requestPermissionSerial
                        ? window.requestPermissionSerial(tu.name, tu.input)
                        : requestPermission(tu.name, tu.input);
                    const ans = await ask;
                    if (!ans.ok) {
                        blocks.push({
                            type: 'tool_result', tool_use_id: tu.id, _name: tu.name,
                            content: `使用者拒絕了這個操作。${ans.feedback ? `他說：「${ans.feedback}」` : ''}`,
                            is_error: true,
                        });
                        continue;
                    }
                }
                // Sentinel 獨立監控：子代理不是後門，收緊規則照樣生效。
                // deny 直接擋；ask 走同一個序列授權框問使用者。
                if (window.sentinelCheck) {
                    let sv = null;
                    try { sv = window.sentinelCheck(tu.name, tu.input); } catch { sv = null; }
                    if (sv && sv.verdict === 'deny') {
                        blocks.push({ type: 'tool_result', tool_use_id: tu.id, _name: tu.name, content: `被 Sentinel 拒絕：${sv.reason}`, is_error: true });
                        continue;
                    }
                    if (sv && sv.verdict === 'ask') {
                        const ask = window.requestPermissionSerial
                            ? window.requestPermissionSerial(tu.name, tu.input, sv.reason)
                            : requestPermission(tu.name, tu.input, sv.reason);
                        const ans = await ask;
                        if (!ans.ok) {
                            blocks.push({
                                type: 'tool_result', tool_use_id: tu.id, _name: tu.name,
                                content: `使用者拒絕了這個操作（Sentinel：${sv.reason}）。${ans.feedback ? `他說：「${ans.feedback}」` : ''}`,
                                is_error: true,
                            });
                            continue;
                        }
                        if (sv.netGate) OC._sentinelNetOk = true;
                    }
                }
                const r = await execTool(tu.name, tu.input, { signal });
                blocks.push({ type: 'tool_result', tool_use_id: tu.id, _name: tu.name, content: r.content, is_error: r.is_error });
                if (r.attachImage) subImages.push(r.attachImage);
                if (Array.isArray(r.attachImages)) subImages.push(...r.attachImages);
            }
            messages.push({ role: 'user', content: blocks });
            // 子代理沒有 maybeCompact，批次看圖時舊圖會無限累積 —— 每輪剪一次
            window.pruneOldToolImages?.(messages, 12);
            // 工具回傳的圖片要真的送到子代理眼前，否則它被告知「內容如下圖」卻什麼都沒收到
            if (subImages.length) {
                messages.push({
                    role: 'user',
                    _carrier: true,
                    content: [
                        ...subImages.map(i => ({ type: 'image', mime: i.mime, data: i.data, _tool: true })),
                        { type: 'text', text: '（以上是工具回傳的圖片）' },
                    ],
                });
            }
            OC.usage.in += res.usage?.input || 0;
            OC.usage.out += res.usage?.output || 0;
        }
    } catch (e) {
        window.chatSystemNoteUpdate?.(noteId, `🤖 子代理失敗：${e.message}`);
        return `子代理執行失敗：${e.message}`;
    }
    window.chatSystemNoteUpdate?.(noteId, `🤖 子代理完成（${turns} 輪）`);
    window.renderTokenMeter?.();
    return final || '（子代理沒有回傳結論）';
}

// ═══════════════════════════════════════════════════════════════
// 中止
// ═══════════════════════════════════════════════════════════════
function stopAgent() {
    if (!OC.running) return;
    OC.abort?.abort();
    // 若正卡在權限對話框，視為拒絕（closeModal 會觸發 finish({ok:false})）
    if ($('modal-permission')?.classList.contains('active')) {
        closeModal('modal-permission');
    }
    window.chatSystemNote?.('⏹ 已中止', 'stop');

    // 中止後佇列裡還有東西 → 把它放回輸入框而不是默默丟掉。
    // 使用者打過的字不該憑空消失。
    if (OC.queued.length) {
        const texts = OC.queued.map(q => q.text).filter(Boolean);
        clearQueued();
        const inp = $('chat-input');
        if (inp && texts.length) {
            inp.value = [inp.value.trim(), ...texts].filter(Boolean).join('\n');
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            window.chatSystemNote?.(`已把 ${texts.length} 則待送出的訊息放回輸入框`, 'info');
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// 會話標題自動命名
// ═══════════════════════════════════════════════════════════════
async function maybeAutoTitle() {
    if (OC.session.title || OC.messages.length < 2) return;
    const firstUser = OC.messages.find(m => m.role === 'user' && (m.content || []).some(b => b.type === 'text'));
    const text = firstUser?.content.find(b => b.type === 'text')?.text || '';
    if (!text) return;
    // 先給一個立即可用的標題，避免等待
    OC.session.title = text.replace(/\s+/g, ' ').slice(0, 28);
    window.renderSessionTitle?.();
    try {
        const rule = (typeof t === 'function' ? t('sys.titleRule') : '') || '用 12 個字以內的繁體中文，為這個程式開發任務下一個標題。只輸出標題本身，不要引號、不要標點結尾。';
        const title = await callOnce(
            `${rule}\n\n任務：${text.slice(0, 500)}`,
            { model: pickFeatureModel('title'), maxTokens: 60, purpose: 'title' });
        const clean = title.split('\n')[0].replace(/^["'「『]|["'」』。]$/g, '').trim();
        if (clean && clean.length <= 30) {
            OC.session.title = clean;
            window.renderSessionTitle?.();
            window.saveSession?.();
        }
    } catch {}
}

// ═══════════════════════════════════════════════════════════════
// UI 快照（給 ui_control snapshot 用）
// ═══════════════════════════════════════════════════════════════
function uiSnapshot() {
    const L = [];
    L.push(`【Omni Code 介面狀態】`);
    L.push(`工作區：${OC.ws}`);
    L.push(`模型：${getModelInfo(OC.cfg.model).displayName}｜權限模式：${(window.permModeMeta ? permModeMeta(OC.cfg.permissionMode) : null)?.label || window.PERM_MODES[OC.cfg.permissionMode]?.label || OC.cfg.permissionMode}｜主題：${document.documentElement.dataset.theme}`);
    L.push(`左側面板：${OC.panel}｜下方面板：${OC.dock}${OC.dockOpen ? '' : '（已收合）'}`);

    if (OC.openFiles.length) {
        L.push(`\n編輯器分頁（${OC.openFiles.length}）：`);
        for (const f of OC.openFiles) {
            const active = f.path === OC.activeFile ? ' ←目前' : '';
            const lines = (f.content || '').split('\n').length;
            L.push(`  ${f.path}（${lines} 行${f.dirty ? '，未存檔' : ''}）${active}`);
        }
        const af = OC.openFiles.find(f => f.path === OC.activeFile);
        if (af?.cm) {
            const c = af.cm.getCursor();
            L.push(`  游標位置：第 ${c.line + 1} 行第 ${c.ch + 1} 欄`);
            const sel = af.cm.getSelection();
            if (sel) L.push(`  選取範圍（${sel.length} 字元）：${sel.slice(0, 200)}${sel.length > 200 ? '…' : ''}`);
        }
    } else {
        L.push('\n編輯器：沒有開啟任何檔案');
    }

    const term = window.terminalTail?.(1500);
    if (term) L.push(`\n終端機（最後輸出）：\n${term}`);

    const shells = Object.entries(OC.shells).filter(([, s]) => s.running);
    if (shells.length) L.push(`\n執行中的背景程序：${shells.map(([id, s]) => `${id}（${s.command}）`).join('、')}`);

    if (OC.todos.length) {
        const icon = { completed: '✅', in_progress: '⏳', pending: '⬜' };
        L.push(`\n任務清單：\n` + OC.todos.map(t => `  ${icon[t.status]} ${t.content}`).join('\n'));
    }

    const preview = $('dock-preview-frame')?.src;
    if (preview && preview !== 'about:blank') L.push(`\n預覽中：${preview}`);

    const u = contextUsage();
    L.push(`\n上下文：約 ${fmtTokens(u.used)} / ${fmtTokens(u.limit)} tokens（${Math.round(u.ratio * 100)}%）`);

    // 可互動元素（給 click/fill 用）
    const btns = $$('#oc-top button, #oc-rail button, .dock-tab, #chat-form button')
        .filter(b => b.offsetParent !== null)
        .map(b => `${b.id ? '#' + b.id : ''}「${(b.title || b.textContent || '').trim().slice(0, 20)}」`)
        .filter(Boolean).slice(0, 30);
    if (btns.length) L.push(`\n可點擊的介面元素：${btns.join('、')}`);

    return L.join('\n');
}

Object.assign(window, {
    runAgent, stopAgent, runSubAgent, buildSystemPrompt,
    loadSkills, refreshGitInfo, uiSnapshot, maybeAutoTitle, IDENTITY,
    queueMessage, flushQueuedInto, clearQueued,
});
