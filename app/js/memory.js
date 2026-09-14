'use strict';
// ═══════════════════════════════════════════════════════════════
// Omni Code — 記憶與上下文管理
// ═══════════════════════════════════════════════════════════════
// 三層記憶 + 使用者畫像（學 OpenClaw 的 USER.md 分層）：
//   1. OMNI.md      — 專案指示檔（每輪注入 system prompt，等同 CLAUDE.md）
//   2. 記憶檔案     — .omni/memory/*.md（專案）與 data/memory/*.md（跨專案）
//                     system prompt 只放索引（名稱＋摘要），內文由工具按需載入
//   3. 會話上下文   — 微壓縮 + 完整壓縮，讓長專案不爆 context
//   + USER.md       — 穩定的使用者畫像（偏好、溝通風格），併入記憶索引最上層。
//                     工作區有 USER.md 就用它；沒有就自動退回「跨專案 type=user 記憶」。
// 契約見 ARCHITECTURE.md §11.3
// ═══════════════════════════════════════════════════════════════

const MEM = {
    omni: { content: '', path: '', exists: false, userMd: '', loadedAt: 0 },
    index: '',
    list: [],          // [{name,description,type,scope,path,updated}]
    loadedAt: 0,
};

// ─── 載入 ───────────────────────────────────────────────────────

async function loadOmniMd(force = false) {
    if (!force && MEM.omni.loadedAt && Date.now() - MEM.omni.loadedAt < 15000) return MEM.omni;
    try {
        const r = await SESS.omniMd();
        MEM.omni = { content: r.content || '', path: r.path || '', exists: !!r.exists, userMd: '', loadedAt: Date.now() };
        // 使用者畫像：工作區 USER.md 優先；沒有就退回跨專案 type=user 記憶拼湊。
        // USER.md 是使用者自己維護的穩定畫像，跟「AI 學到的偏好」分開存 ——
        // 前者使用者說了算，後者 AI 從互動裡提煉，兩條來源不互相覆蓋。
        try {
            const u = await FS.read('USER.md', 0, 60);
            if (u?.content?.trim()) MEM.omni.userMd = u.content.trim().slice(0, 2000);
        } catch { /* 沒有 USER.md 就用記憶退回 */ }
        if (!MEM.omni.userMd) {
            const prefs = (MEM.list || []).filter(m => m.scope === 'user' && m.type === 'user');
            if (prefs.length) {
                MEM.omni.userMd = prefs.slice(0, 8)
                    .map(m => `- ${m.description || m.name}`).join('\n');
            }
        }
    } catch (e) {
        MEM.omni = { content: '', path: '', exists: false, userMd: '', loadedAt: Date.now() };
    }
    return MEM.omni;
}

async function loadMemories(force = false) {
    if (!force && MEM.loadedAt && Date.now() - MEM.loadedAt < 15000) return MEM.list;
    try {
        const r = await SESS.memoryList('all');
        MEM.list = r.memories || [];
        MEM.index = r.index || '';
        MEM.loadedAt = Date.now();
    } catch { MEM.list = []; MEM.index = ''; MEM.loadedAt = Date.now(); }
    return MEM.list;
}

async function refreshMemory() {
    MEM.loadedAt = 0; MEM.omni.loadedAt = 0;
    await Promise.all([loadOmniMd(true), loadMemories(true)]);
    window.renderMemoryPanel?.();
}

// ─── System prompt 片段 ─────────────────────────────────────────

function omniMdSection() {
    if (!MEM.omni.exists || !MEM.omni.content.trim()) return '';
    return `\n═══ 專案指示（OMNI.md）═══\n以下是本工作區的專案指示檔，優先級高於你的一般習慣，請務必遵守：\n\n${MEM.omni.content.trim()}\n`;
}

function memoryIndexSection() {
    if (!MEM.list.length) return '';
    const byScope = { project: [], user: [] };
    MEM.list.forEach(m => (byScope[m.scope] || byScope.project).push(m));
    // USER 層記憶是「穩定的使用者畫像」，獨立一層放最前面（學 OpenClaw 的 USER.md）——
    // 模型先看到「這個人是誰」，再看專案約定，判斷相關性時比較不會錯。
    // USER.md 相容：若使用者在工作區放了 USER.md，它的內容併入本層（見 loadOmniMd）。
    const userLines = (MEM.omni.userMd || '').trim();
    let s = '\n═══ 記憶索引 ═══\n以下是先前存下的記憶（只列標題，需要內文時呼叫 read_memory 取得）：\n';
    if (userLines) s += '\n【使用者畫像】\n' + userLines + '\n';
    if (byScope.project.length) {
        s += '\n【本專案】\n' + byScope.project.map(m => `- ${m.name}（${m.type || 'project'}）：${m.description || ''}`).join('\n');
    }
    if (byScope.user.length) {
        s += '\n【跨專案 / 使用者】\n' + byScope.user.map(m => `- ${m.name}（${m.type || 'user'}）：${m.description || ''}`).join('\n');
    }
    s += '\n\n當使用者表達偏好、告訴你專案的非顯而易見資訊、或糾正你的做法時，'
       + '主動用 remember 工具存下來（一則記憶=一件事）。不要存程式碼本身或 git 已記錄的資訊。\n'
       + '使用者隨時可以叫你忘記（forget_memory 工具、/forget 指令、記憶面板刪除鈕）—— '
       + '他說忘就忘，不要挽留、不要備份、不要問「真的嗎」。\n';
    return s;
}

// ═══════════════════════════════════════════════════════════════
// 上下文預算
// ═══════════════════════════════════════════════════════════════

function contextLimit(model) {
    return getModelInfo(model || OC.cfg.model).context || 200000;
}

// 回傳 {used, limit, ratio, sys, msgs, tools}
function contextUsage(systemLen = 0) {
    const limit = contextLimit();
    const tools = estTokens(JSON.stringify((OC.tools || []).map(t => ({ n: t.name, d: t.description, p: t.params }))));
    const sys = systemLen || OC._lastSysTokens || 0;

    // 錨定：供應商每次回應都回報「這次請求實際用了幾個 token」——
    // 那是精確值，拿它當基準，只概估錨點之後新增的訊息。
    // chars/4 的概估在程式碼與中英夾雜的內容上會飄，
    // 飄高會讓壓縮提早白跑、飄低會撞上下文牆。
    const a = OC._anchor;
    let msgs;
    if (a && a.model === OC.cfg.model && OC.messages.length >= a.msgCount) {
        msgs = Math.max(0, a.tokens - a.sysTokens - a.toolTokens)
             + estMessagesTokens(OC.messages.slice(a.msgCount));
    } else {
        msgs = estMessagesTokens(OC.messages);
    }
    const used = msgs + tools + sys;
    return { used, limit, ratio: used / limit, msgs, tools, sys };
}

// 詳細分佈（/context 指令用）
function contextBreakdown() {
    const u = contextUsage();
    const rows = [];
    let toolResults = 0, assistantText = 0, userText = 0, images = 0, toolCalls = 0;
    for (const m of OC.messages) {
        for (const b of (m.content || [])) {
            if (b.type === 'tool_result') toolResults += estTokens(typeof b.content === 'string' ? b.content : JSON.stringify(b.content));
            else if (b.type === 'tool_use') toolCalls += estTokens(b.name) + estTokens(b.input);
            else if (b.type === 'image') images += 1400;
            else if (b.type === 'text') { if (m.role === 'user') userText += estTokens(b.text); else assistantText += estTokens(b.text); }
        }
    }
    rows.push({ label: '系統提示（含 OMNI.md / 記憶索引 / 技能）', tokens: u.sys });
    rows.push({ label: '工具定義', tokens: u.tools });
    rows.push({ label: '工具執行結果', tokens: toolResults });
    rows.push({ label: '工具呼叫', tokens: toolCalls });
    rows.push({ label: '你的訊息', tokens: userText });
    rows.push({ label: 'AI 回覆', tokens: assistantText });
    if (images) rows.push({ label: '圖片附件', tokens: images });
    return { ...u, rows: rows.filter(r => r.tokens > 0).sort((a, b) => b.tokens - a.tokens) };
}

// ═══════════════════════════════════════════════════════════════
// 微壓縮：把「距今 N 輪以上」的大型工具結果裁短
// 便宜、無損重要資訊（模型可重新讀取），優先於完整壓縮執行
// ═══════════════════════════════════════════════════════════════
const MICRO_KEEP = 400;          // 保留字元數
const MICRO_MIN = 1200;          // 小於此長度不動
const MICRO_RECENT_MSGS = 12;    // 最近幾則不動

/** 工具附上的舊圖直接剪掉：批次看圖（例如分類 100 張照片）時，
 *  每張圖每一輪都會重新上傳給供應商 —— 已經分析完的圖留著只是燒頻寬燒錢。
 *  這必須「無條件」每輪執行，不能等 token 比例超標才做：
 *  Gemini 是 1M 上下文、圖片概估只算 1400 tokens，比例永遠到不了門檻，
 *  但供應商的單一請求有 20MB 上限 —— 幾十張圖的 base64 累積起來就撞牆了。
 *  使用者自己貼的圖（沒有 _tool 標記）不動。 */
function pruneOldToolImages(msgs, keepRecent = MICRO_RECENT_MSGS) {
    const cut = Math.max(0, msgs.length - keepRecent);
    let pruned = 0;
    for (let i = 0; i < cut; i++) {
        const content = msgs[i].content || [];
        for (let k = 0; k < content.length; k++) {
            const b = content[k];
            if (b.type === 'image' && b._tool) {
                content[k] = { type: 'text', text: '（此處原有一張工具回傳的圖片，已從上下文移除以節省空間；需要再看請重新用 read_images 讀取）' };
                pruned++;
            }
        }
    }
    return pruned;
}

function microCompact() {
    const msgs = OC.messages;
    const cut = Math.max(0, msgs.length - MICRO_RECENT_MSGS);
    let saved = 0;
    for (let i = 0; i < cut; i++) {
        for (const b of (msgs[i].content || [])) {
            if (b.type !== 'tool_result' || b._micro) continue;
            const c = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
            if (!c || c.length < MICRO_MIN) continue;
            const head = c.slice(0, MICRO_KEEP);
            const tail = c.slice(-200);
            b.content = `${head}\n\n…（中間 ${c.length - MICRO_KEEP - 200} 字元已省略以節省上下文；需要完整內容請重新呼叫工具）…\n\n${tail}`;
            b._micro = true;
            saved += estTokens(c) - estTokens(b.content);
        }
    }
    return saved;
}

// ═══════════════════════════════════════════════════════════════
// 完整壓縮：把最舊的一段對話交給模型摘要成結構化紀要
// ═══════════════════════════════════════════════════════════════
const COMPACT_KEEP_RECENT = 8;   // 保留最近幾則原始訊息

const COMPACT_PROMPT = `你是一個對話壓縮器。以下是一段 AI 程式開發代理與使用者的對話紀錄。
請把它壓縮成一份**結構化紀要**，讓接手的 AI 只讀這份紀要就能無縫繼續工作。

嚴格使用以下格式（沒有內容的段落寫「無」，不要加任何額外前言或結語）：

## 使用者的目標
（原始需求與後續調整，用使用者自己的說法）

## 已完成
（做了什麼，具體到檔案與功能）

## 檔案異動
（每行一個：路徑 — 做了什麼改動）

## 關鍵決策與約束
（採用了什麼方案、為什麼、有什麼限制或踩過的坑。這是最重要的一段，不要省略原因）

## 目前狀態
（進行到哪一步，下一步原本要做什麼）

## 未解決的問題
（錯誤、卡住的地方、待驗證的事）

## 使用者偏好
（表達過的偏好、規範、語氣要求）

規則：
- 保留所有檔案路徑、函式名、錯誤訊息原文、指令原文——這些是接手時的關鍵線索。
- 不要保留冗長的檔案內容或工具輸出，只保留結論。
- 以繁體中文書寫。
- 直接輸出紀要本身。

═══ 待壓縮的對話 ═══
`;

// 把訊息陣列轉成可讀文字（給壓縮模型看）
function messagesToText(msgs, perBlockLimit = 1500) {
    const out = [];
    for (const m of msgs) {
        const role = m.role === 'user' ? '使用者' : 'AI';
        for (const b of (m.content || [])) {
            if (b.type === 'text' && b.text?.trim()) {
                out.push(`【${role}】${b.text.slice(0, 4000)}`);
            } else if (b.type === 'tool_use') {
                out.push(`【AI 呼叫工具】${b.name}(${JSON.stringify(b.input || {}).slice(0, 600)})`);
            } else if (b.type === 'tool_result') {
                const c = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
                out.push(`【工具結果${b.is_error ? '｜失敗' : ''}】${(c || '').slice(0, perBlockLimit)}`);
            } else if (b.type === 'image') {
                out.push('【使用者附上一張圖片】');
            }
        }
    }
    return out.join('\n');
}

// 找到安全的切割點：絕不可切在 assistant(tool_use) 與它對應的 tool_result 之間。
// 切在中間會讓保留的那半邊以一個「沒有對應 tool_use 的 tool_result」開頭，
// 四家供應商都會直接回 400，且是在壓縮之後才爆——使用者會看到整個對話突然無法繼續。
// 找不到安全切點時回傳 -1（呼叫端必須改走微壓縮，不能硬切）。
function safeSplitIndex(msgs, target) {
    const isSafeStart = (i) => {
        const m = msgs[i];
        if (!m || m.role !== 'user') return false;
        // 以 tool_result 開頭 = 它的 tool_use 被留在丟棄的那半邊 → 不安全
        return !(m.content || []).some(b => b.type === 'tool_result');
    };
    const from = Math.min(Math.max(0, target), msgs.length - 1);
    // 先往前找（保留較多的近期訊息）
    for (let i = from; i >= 0; i--) if (isSafeStart(i)) return i;
    // 再往後找（保留較少也好過切壞配對）
    for (let i = from + 1; i < msgs.length; i++) if (isSafeStart(i)) return i;
    return -1;
}

async function compactContext({ instruction = '', auto = false } = {}) {
    const msgs = OC.messages;
    if (msgs.length < 6) {
        if (!auto) toast(t('mem.tooShort'), 'info');
        return null;
    }

    const before = estMessagesTokens(msgs);
    const targetKeep = Math.max(2, Math.min(COMPACT_KEEP_RECENT, Math.floor(msgs.length * 0.35)));
    const splitAt = safeSplitIndex(msgs, msgs.length - targetKeep);
    if (splitAt <= 0) {
        // 沒有安全切點（例如整段都是工具往返）→ 退回微壓縮。
        // 寧可少省一些 token，也不能切壞 tool_use / tool_result 的配對。
        const saved = microCompact();
        window.renderTokenMeter?.();
        if (!auto) {
            toast(saved > 0
                ? t('mem.microSaved', { s: fmtTokens(saved) })
                : t('mem.noContent'), saved > 0 ? 'success' : 'info', 4000);
        }
        return { microOnly: true, saved };
    }

    const older = msgs.slice(0, splitAt);
    const recent = msgs.slice(splitAt);
    if (!older.length) { if (!auto) toast(t('mem.noPara'), 'info'); return null; }

    window.chatSystemNote?.(auto
        ? '⚡ 上下文接近上限，正在自動壓縮…'
        : '⚡ 正在壓縮上下文…', 'compacting');

    let summary;
    try {
        const extra = instruction ? `\n\n【使用者的額外壓縮指示，請優先滿足】${instruction}\n` : '';
        summary = await callOnce(
            COMPACT_PROMPT + extra + messagesToText(older),
            { model: pickFeatureModel('compact'), maxTokens: 6000, purpose: 'compact' }
        );
    } catch (e) {
        window.chatSystemNote?.(`壓縮失敗：${e.message}（已改用微壓縮）`, 'error');
        const saved = microCompact();
        window.renderTokenMeter?.();
        return { failed: true, saved };
    }

    const touched = [...new Set(OC.session.files_touched || [])];
    const head = `[先前對話摘要 — 由 Omni Code 自動壓縮]\n\n${summary}\n`
        + (touched.length ? `\n## 本次會話已接觸的檔案\n${touched.map(f => '- ' + f).join('\n')}\n` : '')
        + '\n（以上為先前對話的壓縮紀要。若需要任何檔案的實際內容，請重新讀取，不要憑記憶假設。）';

    OC.messages = [
        { role: 'user', content: [{ type: 'text', text: head }], _compacted: true },
        { role: 'assistant', content: [{ type: 'text', text: '我已掌握先前的進度，繼續處理。' }], _compacted: true },
        ...recent,
    ];
    OC.session.compactions = (OC.session.compactions || 0) + 1;
    OC.readCache = {};   // 壓縮後強制重讀檔案，避免用舊快取誤判
    OC.seenFiles = {};

    OC._anchor = null;        // 訊息重排後錨點失效，退回純概估直到下一次回應
    OC._rcHash = 0;           // 壓縮可能吃掉 runtime-context 快照，下一步重新注入
    const after = estMessagesTokens(OC.messages);
    window.chatRenderAll?.();
    window.chatSystemNote?.(
        `⚡ 上下文已壓縮：${msgs.length} 則 → ${OC.messages.length} 則，`
        + `約 ${fmtTokens(before)} → ${fmtTokens(after)} tokens（節省 ${fmtTokens(before - after)}）`,
        'compact');
    window.renderTokenMeter?.();
    window.saveSession?.();
    return { before, after, saved: before - after, summary };
}

// Agent 迴圈每輪呼叫：必要時自動壓縮
async function maybeCompact() {
    pruneOldToolImages(OC.messages);      // 無條件：見函式說明
    const u = contextUsage();
    if (u.ratio > 0.55) {
        const saved = microCompact();
        if (saved > 2000) window.renderTokenMeter?.();
    }
    const u2 = contextUsage();
    const threshold = OC.cfg.autoCompactAt || 0.75;
    if (u2.ratio >= threshold) {
        await compactContext({ auto: true });
        return true;
    }
    return false;
}

// ═══════════════════════════════════════════════════════════════
// 檔案讀取追蹤
// ═══════════════════════════════════════════════════════════════
// 兩個獨立的概念，不可混用：
//   readCache — 「這個檔案自上次讀取後有沒有變？」→ 決定 read_file 要不要省略重讀
//   seenFiles — 「模型知不知道這個檔案的內容？」→ 決定 edit/write 的前置檢查
// 模型自己寫入後，內容變了（readCache 失效）但它當然知道內容（seenFiles 保留），
// 因此可以連續編輯同一個檔案，不必為了通過檢查而白讀一次。
function markRead(path, stat) {
    OC.readCache[path] = { mtime: stat.mtime, size: stat.size, at: Date.now() };
    OC.seenFiles[path] = true;
}
function isUnchanged(path, stat) {
    const c = OC.readCache[path];
    return !!c && c.mtime === stat.mtime && c.size === stat.size;
}
function invalidateRead(path) { delete OC.readCache[path]; }
function markSeen(path) { OC.seenFiles[path] = true; }
function hasSeen(path) { return !!OC.seenFiles[path]; }

// ═══════════════════════════════════════════════════════════════
// 記憶寫入（remember 工具與 UI 共用）
// ═══════════════════════════════════════════════════════════════
function slugify(s) {
    return String(s || '').toLowerCase().trim()
        .replace(/[\s_]+/g, '-')
        .replace(/[^a-z0-9一-鿿-]/g, '')
        .replace(/-+/g, '-').replace(/^-|-$/g, '')
        .slice(0, 64);
}

async function saveMemory({ name, description, type = 'project', content, scope = 'project' }) {
    const slug = slugify(name);
    if (!slug) throw new Error('記憶名稱無效（需含英數字）');
    const today = new Date().toISOString().slice(0, 10);
    const md = `---
name: ${slug}
description: ${String(description || '').replace(/\n/g, ' ')}
type: ${type}
updated: ${today}
---

${String(content || '').trim()}
`;
    const r = await SESS.memorySave(slug, md, scope);
    MEM.loadedAt = 0;
    await loadMemories(true);
    window.renderMemoryPanel?.();
    return { ...r, name: slug };
}

async function deleteMemory(name, scope = 'project') {
    await SESS.memoryDelete(name, scope);
    MEM.loadedAt = 0;
    await loadMemories(true);
    window.renderMemoryPanel?.();
}

// ═══════════════════════════════════════════════════════════════
// 記憶面板 UI（#panel-memory）
// ═══════════════════════════════════════════════════════════════

const MEM_TYPE_LABEL = {
    user: '使用者', feedback: '回饋', project: '專案', reference: '參考',
};

// 類型 → 圖示＋讀得懂的一句話（面板卡片用；跟 MEM_TYPE_LABEL 共用同一個 key 表）
// 顯示層一律走 memTypeLabel／memTypeMeta（跟著介面語系走），常數本體只留中文保底 ——
// 跟 permissions.js 的 permModeMeta 同一招：state 在 i18n 之前載入，不能直接 t()。
function memTypeLabel(ty) {
    if (typeof t !== 'function') return MEM_TYPE_LABEL[ty] || ty || '';
    return { user: t('mem.typeUser'), feedback: t('mem.typeFeedback'), project: t('mem.typeProj'), reference: t('mem.typeRef') }[ty]
        || MEM_TYPE_LABEL[ty] || ty || '';
}
function memTypeMeta(ty) {
    const base = MEM_TYPE_META[ty] || MEM_TYPE_META.project;
    if (typeof t !== 'function') return base;
    return {
        ...base,
        hint: { user: t('mem.hintUser'), feedback: t('mem.hintFeedback'), project: t('mem.hintProj'), reference: t('mem.hintRef') }[ty] || base.hint,
    };
}

// 類型 → 圖示＋讀得懂的一句話（面板卡片用；跟 MEM_TYPE_LABEL 共用同一個 key 表）
const MEM_TYPE_META = {
    user:      { icon: 'person',        hint: '你的偏好，所有專案生效' },
    feedback:  { icon: 'rate_review',   hint: '你糾正過 AI 的做法' },
    project:   { icon: 'folder_special', hint: '這個專案的約定' },
    reference: { icon: 'bookmarks',     hint: '參考資料，隨查隨用' },
};

let _memFilter = '';

// 搜尋命中時標亮關鍵字（跟會話面板同一招：前後文保留，大小寫不敏感）
function _memHi(text, q) {
    const t = String(text || '');
    if (!q) return esc(t);
    const i = t.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return esc(t);
    return esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + q.length)) + '</mark>' + esc(t.slice(i + q.length));
}

async function renderMemoryPanel() {
    const body = $('memory-body');
    if (!body) return;
    await Promise.all([loadOmniMd(), loadMemories()]);

    const omni = MEM.omni;
    const q = _memFilter.trim().toLowerCase();
    const match = (m) => !q
        || (m.name || '').toLowerCase().includes(q)
        || (m.description || '').toLowerCase().includes(q)
        || (m.preview || '').toLowerCase().includes(q);
    const groups = { project: [], user: [] };
    MEM.list.filter(match).forEach(m => (groups[m.scope] || groups.project).push(m));
    const total = MEM.list.length;

    const card = (m) => {
        const meta = memTypeMeta(m.type);
        const chars = typeof m.chars === 'number' ? m.chars : -1;
        return `
      <div class="card card-hover mem-item" data-name="${esc(m.name)}" data-scope="${esc(m.scope)}" title="${esc(t('mem.viewEdit'))}">
        <div class="mem-top">
          <span class="ms mem-ico" title="${esc(meta.hint)}">${meta.icon}</span>
          <span class="mem-name">${_memHi(m.name, q)}</span>
          <span class="chip mem-type">${esc(memTypeLabel(m.type))}</span>
        </div>
        <div class="mem-desc">${_memHi(m.description || t('mem.descEmpty'), q) || ''}</div>
        ${m.preview ? `<div class="mem-preview">${_memHi(m.preview, q)}</div>` : ''}
        <div class="mem-meta">
          ${chars >= 0 ? `<span title="${esc(t('mem.charsN', { n: chars }))}">📝 ${esc(t('mem.charsU', { n: chars }))}</span><span class="sess-dot">·</span>` : ''}
          <span>🕘 ${esc(m.updated || '')}</span>
          <span class="mem-acts">
            <button class="btn-icon btn-xs ms mem-view" title="${esc(t('mem.viewEdit'))}">visibility</button>
            <button class="btn-icon btn-xs ms mem-del" title="${esc(t('mem.delOne'))}">delete</button>
          </span>
        </div>
      </div>`;
    };

    const section = (title, icon, list, hint) => `
      <div class="mem-section">
        <div class="mem-sec-head">
          <span class="ms">${icon}</span><span>${title}</span>
          <span class="mem-count">${list.length}</span>
        </div>
        ${list.length ? `<div class="mem-list">${list.map(card).join('')}</div>`
            : q ? `<div class="mem-empty">${esc(t('mem.noMatch', { q: _memFilter.trim() }))}</div>`
            : `<div class="panel-empty"><span class="ms">psychology</span><div class="hint">${hint}</div></div>`}
      </div>`;

    body.innerHTML = `
      <div class="panel-search">
        <span class="ms">search</span>
        <input class="inp" id="mem-search" placeholder="${esc(t('mem.searchPh'))}" value="${esc(_memFilter)}">
      </div>
      <div class="mem-status">
        <span class="ms">psychology</span>
        <span>${t('mem.statusN', { n: `<b>${total}</b>` })}${q ? t('mem.statusF', { n: `<b>${groups.project.length + groups.user.length}</b>` }) : ''}</span>
        <span class="hint">${esc(t('mem.statusHint'))}</span>
      </div>
      <div class="card mem-privacy">
        <div class="mem-omni-head">
          <span class="ms">lock</span>
          <span class="mem-omni-title">${esc(t('mem.privT'))}</span>
        </div>
        <div class="mem-omni-desc">${t('mem.privD')}</div>
      </div>
      <div class="card mem-omni ${omni.exists ? 'has' : 'none'}">
        <div class="mem-omni-head">
          <span class="ms">description</span>
          <span class="mem-omni-title">${esc(t('mem.omniT'))}</span>
          ${omni.exists
            ? `<span class="chip chip-accent">${fmtTokens(estTokens(omni.content))} tokens</span>`
            : `<span class="chip">${esc(t('mem.omniNone'))}</span>`}
        </div>
        <div class="mem-omni-desc">${esc(omni.exists ? t('mem.omniHasD') : t('mem.omniNoneD'))}</div>
        <div class="mem-omni-acts">
          ${omni.exists
            ? `<button class="btn btn-xs btn-ghost" id="mem-omni-open">${esc(t('mem.omniOpen'))}</button>`
            : `<button class="btn btn-xs btn-primary" id="mem-omni-init">${esc(t('mem.omniInit'))}</button>`}
        </div>
      </div>

      ${section(t('mem.secProj'), 'folder_special', groups.project, esc(t('mem.emptyProj')))}
      ${section(t('mem.secUser'), 'person', groups.user, esc(t('mem.emptyUser')))}

      <div class="hint skill-foot">${t('mem.foot')}</div>`;

    $('mem-search')?.addEventListener('input', (e) => {
        _memFilter = e.target.value;
        const pos = e.target.selectionStart;
        renderMemoryPanel().then(() => {
            const inp = $('mem-search');
            if (inp) { inp.focus(); try { inp.setSelectionRange(pos, pos); } catch {} }
        });
    });

    $('mem-omni-open')?.addEventListener('click', () => window.openFile?.('OMNI.md'));
    $('mem-omni-init')?.addEventListener('click', () => window.handleSlash?.('/init'));

    $$('.mem-view', body).forEach(b => b.addEventListener('click', (e) => {
        const it = e.target.closest('.mem-item');
        viewMemory(it.dataset.name, it.dataset.scope);
    }));
    $$('.mem-del', body).forEach(b => b.addEventListener('click', async (e) => {
        const it = e.target.closest('.mem-item');
        const ok = await confirmModal(t('mem.delT'),
            t('mem.delB', { n: it.dataset.name }), { danger: true, okText: t('common.del') });
        if (!ok) return;
        try {
            await deleteMemory(it.dataset.name, it.dataset.scope);
            toast(t('mem.deleted'), 'success');
        } catch (err) { toast(t('mem.delFail', { msg: err.message }), 'error'); }
    }));
    $$('.mem-item', body).forEach(it => it.addEventListener('click', (e) => {
        if (e.target.closest('.mem-acts')) return;
        viewMemory(it.dataset.name, it.dataset.scope);
    }));
}

// 檢視／編輯單一記憶
async function viewMemory(name, scope) {
    let content = '';
    try {
        const r = await SESS.memoryGet(name, scope);
        content = r.content || '';
    } catch (e) { toast(t('mem.readFail', { msg: e.message }), 'error'); return; }

    const { meta, body } = parseFrontmatter(content);
    $('modal-generic-title').textContent = t('mem.viewT', { n: name });
    $('modal-generic-body').innerHTML = `
      <div class="ig">
        <label>${esc(t('mem.fDesc'))}</label>
        <input id="mem-edit-desc" class="inp" value="${esc(meta.description || '')}">
      </div>
      <div class="ig">
        <label>${esc(t('mem.fType'))}</label>
        <select id="mem-edit-type" class="sel">
          ${['project', 'user', 'feedback', 'reference'].map(ty =>
            `<option value="${ty}"${meta.type === ty ? ' selected' : ''}>${esc(memTypeLabel(ty))}</option>`).join('')}
        </select>
      </div>
      <div class="ig">
        <label>${esc(t('mem.fBody'))}</label>
        <textarea id="mem-edit-body" class="ta" rows="12">${esc(body.trim())}</textarea>
      </div>
      <div class="hint">${esc(t('mem.scopeLine', { s: scope === 'user' ? t('mem.scopeUser') : t('mem.scopeProj') }))}</div>`;

    const acts = $('modal-generic-actions');
    acts.innerHTML = '';
    acts.appendChild(el('button', { class: 'btn btn-ghost', text: t('common.close'), onclick: () => closeModal('modal-generic') }));
    acts.appendChild(el('button', {
        class: 'btn btn-primary', text: t('common.save'),
        onclick: async () => {
            try {
                await saveMemory({
                    name,
                    description: $('mem-edit-desc').value.trim(),
                    type: $('mem-edit-type').value,
                    content: $('mem-edit-body').value,
                    scope,
                });
                closeModal('modal-generic');
                toast(t('mem.edited'), 'success');
            } catch (e) { toast(t('mem.saveFail', { msg: e.message }), 'error'); }
        },
    }));
    openModal('modal-generic');
}

// 手動新增記憶
async function newMemoryDialog() {
    $('modal-generic-title').textContent = t('mem.newT');
    $('modal-generic-body').innerHTML = `
      <div class="ig">
        <label>${esc(t('mem.newName'))} <span class="dim">${esc(t('mem.newNameHint'))}</span></label>
        <input id="mem-new-name" class="inp" placeholder="${esc(t('mem.newNamePh'))}">
      </div>
      <div class="ig">
        <label>${esc(t('mem.newDesc'))} <span class="dim">${esc(t('mem.newDescHint'))}</span></label>
        <input id="mem-new-desc" class="inp" placeholder="${esc(t('mem.newDescPh'))}">
      </div>
      <div class="ig">
        <label>${esc(t('mem.newScope'))}</label>
        <select id="mem-new-scope" class="sel">
          <option value="project">${esc(t('mem.newScopeProj'))}</option>
          <option value="user">${esc(t('mem.newScopeUser'))}</option>
        </select>
      </div>
      <div class="ig">
        <label>${esc(t('mem.newType'))}</label>
        <select id="mem-new-type" class="sel">
          ${['project', 'user', 'feedback', 'reference'].map(ty =>
            `<option value="${ty}">${esc(memTypeLabel(ty))}</option>`).join('')}
        </select>
      </div>
      <div class="ig">
        <label>${esc(t('mem.newBody'))}</label>
        <textarea id="mem-new-body" class="ta" rows="8"
          placeholder="${esc(t('mem.newBodyPh'))}"></textarea>
      </div>`;
    const acts = $('modal-generic-actions');
    acts.innerHTML = '';
    acts.appendChild(el('button', { class: 'btn btn-ghost', text: t('common.cancel'), onclick: () => closeModal('modal-generic') }));
    acts.appendChild(el('button', {
        class: 'btn btn-primary', text: t('mem.newCreate'),
        onclick: async () => {
            const name = $('mem-new-name').value.trim();
            if (!name) { toast(t('mem.needName'), 'warn'); return; }
            try {
                await saveMemory({
                    name,
                    description: $('mem-new-desc').value.trim(),
                    type: $('mem-new-type').value,
                    content: $('mem-new-body').value,
                    scope: $('mem-new-scope').value,
                });
                closeModal('modal-generic');
                toast(t('mem.created'), 'success');
            } catch (e) { toast(t('mem.createFail', { msg: e.message }), 'error'); }
        },
    }));
    openModal('modal-generic');
}

// ─── 壓縮前記憶沖洗（學 OpenClaw 的 memory flush）─────────────────
// 觸發條件：下一輪真的會自動壓縮（已達 autoCompactAt 門檻）。
// 平常不觸發 —— 沒到門檻時硬沖只是燒一輪 token 叫模型寫廢話。
// 沖洗本身：請模型把對話裡「還沒進記憶」的重要事記下來，然後照常結束。
// 記下來的東西進記憶檔，下一輪壓縮丟細節也不心疼。
async function memoryFlushIfNeeded() {
    if (OC.abort?.signal?.aborted) return;
    if (!OC.messages?.length) return;
    let ratio = 0;
    try { ratio = contextUsage().ratio || 0; } catch { return; }
    if (ratio < (OC.cfg.autoCompactAt || 0.75)) return;

    const probe = `【壓縮前記憶沖洗】下一輪將自動壓縮上下文，壓縮會遺失細節。
請快速檢查這段對話：有沒有「重要但還沒寫進記憶」的內容
（使用者的偏好或糾正、專案的非顯而易見約束、關鍵決策與原因、外部資源連結）？
- 有 → 用 remember／remember_error 記下來，只記真正值得長期保留的（最多 3 則）。
- 沒有 → 直接回覆「無需記錄」四個字，不要呼叫任何工具。
注意：只挑「壓縮後會遺失」的記；程式碼內容、檔案路徑、git 狀態不用記（那些不在記憶的職責範圍）。`;
    try {
        // streamChat 是唯讀併發安全集的一員，但這裡只有一筆呼叫、且在 finally 收尾段 ——
        // 直接用 callOnce（同一個底層），省掉自己組裝 tools 過濾的麻煩。
        const out = await callOnce(
            '以下是最近的對話：\n\n' + messagesToText(OC.messages.slice(-12)) + '\n\n' + probe,
            { system: '你是記憶整理助手，只負責判斷要不要記錄。', model: pickFeatureModel('subagent'), maxTokens: 800, purpose: 'memory-flush' }
        );
        void out;
        // 註：callOnce 不帶工具，模型若判斷「有」要記，會在回覆裡說明；
        // 真正的寫入交給下一輪主迴圈（模型看到沖洗回覆後自己調 remember）。
        // 這是刻意的：沖洗輪不直接寫檔，避免便宜模型誤寫污染記憶。
    } catch { /* 沖洗是盡力而為，失敗就當沒發生 */ }
}

function initMemoryPanel() {
    $('mem-new')?.addEventListener('click', () => newMemoryDialog());
    $('mem-refresh')?.addEventListener('click', async () => {
        await refreshMemory();
        toast(t('mem.reloadDone'), 'success', 1600);
    });
}

Object.assign(window, {
    MEM, loadOmniMd, loadMemories, refreshMemory,
    omniMdSection, memoryIndexSection,
    contextLimit, contextUsage, contextBreakdown,
    microCompact, compactContext, maybeCompact, messagesToText, pruneOldToolImages,
    markRead, isUnchanged, invalidateRead, markSeen, hasSeen,
    saveMemory, deleteMemory, slugify,
    renderMemoryPanel, viewMemory, newMemoryDialog, initMemoryPanel,
    memoryFlushIfNeeded,
});
