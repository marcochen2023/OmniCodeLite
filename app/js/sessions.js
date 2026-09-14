'use strict';
// ═══════════════════════════════════════════════════════════════
// Omni Code — 會話持久化與會話面板
// ═══════════════════════════════════════════════════════════════
// 契約見 docs/ARCHITECTURE.md §6、§11.4。
//   存檔位置：data/sessions/<id>.json（由 api/sessions.php 管理）
//   存檔時機：
//     1. 每次 Agent 回合結束 → agent.js 的 finally 呼叫 saveSession()
//     2. 對話有異動 → scheduleSaveSession()（去抖 1200ms）
//     3. 分頁被切到背景 → keepalive 補送一次，避免關掉瀏覽器就掉資料
//   OC.session 是唯一真相；OC.messages / OC.todos / OC.usage 都是它的 getter。
// ═══════════════════════════════════════════════════════════════

const SESS_AUTOSAVE_MS = 1200;          // 去抖存檔間隔
const SESS_RESUME_WINDOW = 8 * 3600000; // 開機續接的時效：8 小時
const SESS_LIST_TTL = 5000;             // 會話清單快取有效期
const SESS_KEEPALIVE_MAX = 58 * 1024;   // fetch keepalive 的 body 上限約 64KB，留安全邊界

// ─── 面板狀態（不進 OC，純 UI）───
let _sessList = [];        // [{id,title,ws,created,updated,msg_count,tokens,model}]
let _sessListAt = 0;
let _sessListing = false;
let _sessFilter = '';
let _sessSavePromise = Promise.resolve(null);
let _sessSaveErrShown = false;
let _sessImportInput = null;  // 匯入用的隱藏 file input（建一次重複用）

// ═══════════════════════════════════════════════════════════════
// 會話物件
// ═══════════════════════════════════════════════════════════════

function newSessionId() { return 's-' + Date.now(); }

// 全新的空會話
function emptySession() {
    const now = Date.now();
    return {
        id: newSessionId(),
        title: '',
        ws: OC.ws || OC.cfg.workspace || '',
        mode: window.currentMode?.() || 'project',     // project | chat | self（見 modes.js）
        model: OC.cfg.model || '',
        created: now,
        updated: now,
        pinned: false,
        pinnedAt: 0,
        extraRoots: [],   // 額外工作資料夾 [{alias, path}]，跟著對話走（上線 5 個）
        messages: [],
        todos: [],
        usage: { in: 0, out: 0, cost: 0 },
        compactions: 0,
        files_touched: [],
    };
}

// 後端讀回來的會話補齊缺欄位（舊存檔／手動編輯過的檔案都可能缺）
function normalizeSession(s) {
    const base = emptySession();
    const out = Object.assign(base, s || {});
    out.id = String(out.id || base.id);
    out.messages = Array.isArray(out.messages) ? out.messages : [];
    out.todos = Array.isArray(out.todos) ? out.todos : [];
    out.files_touched = Array.isArray(out.files_touched) ? out.files_touched : [];
    out.usage = Object.assign({ in: 0, out: 0, cost: 0 }, out.usage || {});
    out.compactions = parseInt(out.compactions || 0, 10) || 0;
    // 舊存檔沒有置頂欄位，讀回來補預設（false，不動 updated）
    out.pinned = !!out.pinned;
    out.pinnedAt = parseInt(out.pinnedAt || 0, 10) || 0;
    // 舊存檔沒有額外資料夾：補空陣列；髒資料只收 {alias, path} 字串對
    if (!Array.isArray(out.extraRoots)) out.extraRoots = [];
    else {
        const seen = new Set();
        out.extraRoots = out.extraRoots.filter(it => {
            if (!it || typeof it.alias !== 'string' || typeof it.path !== 'string') return false;
            const k = it.alias.toLowerCase() + '|' + it.path.toLowerCase();
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        }).slice(0, 5);
    }

    // 尾端修復：會話若在工具執行中途被關掉（斷電、關瀏覽器），
    // 最後一則 assistant 的 tool_use 沒有對應的 tool_result ——
    // 這種歷史送到四家供應商都會被 400 拒絕，會話等於永久壞死。
    // 補上合成的錯誤結果，讓恢復的會話至少能繼續對話。
    const msgs = out.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role !== 'assistant') { if (m.role === 'user') break; continue; }
        const calls = (m.content || []).filter(b => b.type === 'tool_use');
        if (!calls.length) break;
        const answered = new Set();
        for (let k = i + 1; k < msgs.length; k++) {
            for (const b of (msgs[k].content || [])) {
                if (b.type === 'tool_result') answered.add(b.tool_use_id);
            }
        }
        const missing = calls.filter(c => !answered.has(c.id));
        if (missing.length) {
            msgs.splice(i + 1, 0, {
                role: 'user',
                content: missing.map(c => ({
                    type: 'tool_result', tool_use_id: c.id, _name: c.name,
                    is_error: true, content: '（工具執行因會話中斷而未完成，這是恢復會話時補上的記號）',
                })),
            });
        }
        break;
    }
    return out;
}

function ensureSessionId() {
    if (!OC.session.id) OC.session.id = newSessionId();
    return OC.session.id;
}

// Windows 路徑大小寫不敏感，realpath 回來的大小寫也可能跟存檔時不同；
// 轉小寫再比，免得只是大小寫差異就白切一次工作區。
function _sameWs(a, b) {
    return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

// ═══════════════════════════════════════════════════════════════
// 存檔
// ═══════════════════════════════════════════════════════════════

// 實際送出（序列化執行，避免兩次存檔互相覆蓋）
async function _doSave() {
    const s = OC.session;
    // 空會話不落盤，免得每次開啟頁面都長出一個空檔
    if (!s || !(s.messages || []).length) return null;

    ensureSessionId();
    // 已有 ws 的會話不重蓋：切換流程都是先換工作區才存檔
    //（applyWorkspace 換完 ws 才開新會話，連帶存下舊會話），
    // 拿當下的 OC.ws 回寫會把舊會話的工作區洗成新的，
    // 之後再點它就不會跳回原本的目錄了。跟下一行的 mode 同 pattern。
    s.ws = s.ws || OC.ws || '';
    s.mode = s.mode || window.currentMode?.() || 'project';
    s.model = OC.cfg.model || s.model || '';
    if (!s.created) s.created = Date.now();
    s.updated = Date.now();

    try {
        const r = await SESS.save(s.id, s);
        if (r.created) s.created = r.created;
        if (r.updated) s.updated = r.updated;
        _sessSaveErrShown = false;
        _sessListAt = 0;   // 清單快取作廢
        return r;
    } catch (e) {
        // 存檔失敗只提示一次，不要在長迴圈裡洗版
        if (!_sessSaveErrShown) {
            _sessSaveErrShown = true;
            errorTicker(t('sess.saveFail'), e.message + (e.detail ? '\n' + e.detail : ''));
        }
        return null;
    }
}

// 立即存檔（可 await）
function saveSession() {
    _sessSavePromise = _sessSavePromise.then(_doSave, _doSave);
    return _sessSavePromise;
}

// 去抖存檔（對話變動時呼叫，1200ms 內的多次呼叫只送一次）
const scheduleSaveSession = debounce(() => { saveSession(); }, SESS_AUTOSAVE_MS);

// 分頁隱藏時的補送：fsapi 的封裝不支援 keepalive，這裡直接寫一次 fetch
function flushSessionKeepalive() {
    const s = OC.session;
    if (!s || !s.id || !(s.messages || []).length) return;
    s.updated = Date.now();
    s.ws = s.ws || OC.ws || '';
    s.model = OC.cfg.model || s.model || '';

    let body;
    try { body = JSON.stringify({ id: s.id, session: s }); } catch { return; }

    // keepalive 的 body 有 64KB 上限；超過就退回一般 fetch
    // （visibilitychange→hidden 不等於關頁，多數情況仍送得完）
    let bytes = body.length;
    try { bytes = new Blob([body]).size; } catch {}
    const opt = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
    };
    if (bytes < SESS_KEEPALIVE_MAX) opt.keepalive = true;

    try { fetch(API_BASE + 'sessions.php?action=save', opt).catch(() => {}); } catch {}
}

// ═══════════════════════════════════════════════════════════════
// 新會話 / 載入 / 刪除
// ═══════════════════════════════════════════════════════════════

// 就地重置（不詢問），供 newSession 與「刪除目前會話」共用
function resetSessionState() {
    OC.session = emptySession();
    OC.readCache = {};
    OC._anchor = null;
    OC._rcHash = 0;
    OC.sessionAllow = [];
    OC._sentinelNetOk = false;   // 對外連線授權是 per-會話的，換會話重問
    OC.turn = 0;
    OC.lastError = null;
    // 開新會話 = 掛載清空（跟著對話走，不能殘留上一個對話的授權）
    OC.cfg.activeExtraRoots = [];
    try { SETTINGS.extraSync([]).catch(() => {}); } catch {}
    window.renderExtraRoots?.();
    window.chatClear?.();
    window.renderTodos?.();
    window.renderTokenMeter?.();
    window.renderSessionTitle?.();
    paintSessions();
}

// silent:true 由「切換工作區」等流程使用 —— 那時已經確認過一次，
// 不該再彈第二個對話框（而且切換過程中彈窗會跟關閉分頁的對話框互相蓋掉）。
async function newSession({ silent = false } = {}) {
    if (OC.running) { toast(t('sess.busy'), 'warn'); return false; }

    if ((OC.session.messages || []).length) {
        if (!silent) {
            const ok = await confirmModal(t('sess.newQT'),
                `<div class="cf-msg">${t('sess.newQB', { n: OC.session.messages.length })}</div>`,
                { okText: t('sess.newOk') });
            if (!ok) return false;
        }
        await saveSession();
    }

    resetSessionState();
    refreshSessionList(true);
    if (!silent) toast(t('sess.newDone'), 'success', 2000);
    return true;
}

async function loadSession(id, { silent = false } = {}) {
    if (!id) return false;
    if (id === OC.session.id) { if (!silent) toast(t('sess.isCur'), 'info', 1800); return false; }
    if (OC.running) { toast(t('sess.busy'), 'warn'); return false; }

    let s;
    try {
        const r = await SESS.get(id);
        s = normalizeSession(r.session);
    } catch (e) {
        toast(t('sess.loadFail', { msg: e.message }), 'error');
        return false;
    }

    // 會話屬於別的模式 → 先切過去（self 會順便把工作區切到安裝目錄）
    const sMode = window.modeOfSession?.(s) || 'project';
    if (window.currentMode && sMode !== currentMode()) {
        const ok = await window.setMode(sMode, { silent: true });
        if (!ok) return false;
    }

    // 跨工作區的會話：訊息裡的路徑都綁在原本的工作區，
    // 載入後一併把「選擇工作區」切過去（chat 模式沒有工作區，不用問）
    const curWs = OC.ws || OC.cfg.workspace || '';
    if (sMode !== 'chat' && s.ws && !_sameWs(s.ws, curWs)) {
        if (!silent) {
            const ok = await confirmModal(t('sess.swT'),
                `<div class="cf-msg">${t('sess.swB', { ws: esc(s.ws), cur: esc(curWs) })}</div>`,
                { okText: t('sess.swOk') });
            if (!ok) return false;
        }
        await window.applyWorkspace?.(s.ws);
        // 工作區不存在或使用者中途取消：applyWorkspace 內部已經 toast，
        // OC.ws 沒變就不要載入，否則路徑全對不上。
        if (!_sameWs(OC.ws || OC.cfg.workspace || '', s.ws)) return false;
    }

    // 先保住目前進度（註：上面走過 applyWorkspace 的話，
    // 它內部已經存檔舊會話並開了空會話，這裡的 messages 是空的就不會重存）
    if ((OC.session.messages || []).length) await saveSession();

    OC.session = s;
    OC.readCache = {};      // 換會話等於換上下文，讀檔快取一律作廢
    OC._anchor = null;      // token 錨點屬於舊會話
    OC._rcHash = 0;         // runtime-context 快照重新注入
    OC.sessionAllow = [];
    OC._sentinelNetOk = false;   // 對外連線授權是 per-會話的，換會話重問
    OC.turn = 0;
    OC.lastError = null;

    // 額外資料夾跟著對話走：把該會話的掛載同步為作用中（不存在的目錄後端會丟掉），
    // 失敗不擋載入（頂多該會話的 extra: 路徑暫時 403）。
    try {
        const r = await SETTINGS.extraSync(s.extraRoots || []);
        OC.cfg.activeExtraRoots = r.roots || [];
    } catch (e) { console.warn('[sessions] 額外資料夾同步失敗：', e.message); }
    window.renderExtraRoots?.();

    window.chatRenderAll?.();
    window.renderTodos?.();
    window.renderTokenMeter?.();
    window.renderSessionTitle?.();
    paintSessions();
    if (!silent) toast(t('sess.loadedT', { t: s.title || t('sess.untitled') }), 'success', 2200);
    return true;
}

async function togglePinSession(id, pinned) {
    if (!id) return false;
    const meta = _sessList.find(x => x.id === id);
    // 還沒落盤的目前會話沒有檔可釘：直接改記憶體再走一般存檔
    if (!meta && id === OC.session.id && (OC.session.messages || []).length) {
        OC.session.pinned = !!pinned;
        OC.session.pinnedAt = pinned ? Date.now() : 0;
        await saveSession();
        await refreshSessionList(true);
        toast(pinned ? t('sess.pinned') : t('sess.unpinned'), 'success', 1800);
        return true;
    }
    try {
        const r = await SESS.pin(id, pinned);
        const next = !!(r && 'pinned' in r ? r.pinned : pinned);
        if (meta) { meta.pinned = next ? 1 : 0; meta.pinnedAt = next ? Date.now() : 0; }
        // 目前會話的記憶體也要同步，否則下次自動存檔會把 pinned 蓋回去
        if (id === OC.session.id) {
            OC.session.pinned = next;
            OC.session.pinnedAt = next ? (meta?.pinnedAt || Date.now()) : 0;
        }
        _sessListAt = 0;   // 索引已由後端更新，下次拉清單會同步
        paintSessions();
        toast(next ? t('sess.pinned') : t('sess.unpinned'), 'success', 1800);
        return true;
    } catch (e) {
        toast(t('sess.pinFail', { msg: e.message }), 'error');
        return false;
    }
}

async function deleteSession(id) {
    const meta = _sessList.find(x => x.id === id);
    const ok = await confirmModal(t('sess.delT'),
        `<div class="cf-msg">${t('sess.delB', { t: esc(meta?.title || id) })}</div>`,
        { danger: true, okText: t('common.del') });
    if (!ok) return false;

    try { await SESS.remove(id); }
    catch (e) { toast(t('sess.delFail', { msg: e.message }), 'error'); return false; }

    _sessList = _sessList.filter(x => x.id !== id);
    if (id === OC.session.id) resetSessionState();
    else paintSessions();
    toast(t('sess.deleted'), 'success', 1800);
    return true;
}

// 重新命名：promptModal 輸入新標題 → 後端 rename → 同步清單＋目前會話
async function renameSession(id) {
    if (!id) return false;
    const meta = _sessList.find(x => x.id === id);
    const cur = meta?.title || (id === OC.session.id ? OC.session.title : '') || '';
    const title = await promptModal(t('sess.renameT'), t('sess.renameLab'), cur, { okText: t('common.save') });
    if (title === null) return false;   // 使用者取消
    if (!title.trim()) { toast(t('sess.renameEmpty'), 'warn'); return false; }
    if (title.trim() === cur) return true;   // 沒改就不用存
    // 還沒落盤的目前會話沒有檔可改：直接改記憶體再走一般存檔
    if (!meta && id === OC.session.id && (OC.session.messages || []).length) {
        OC.session.title = title.trim();
        await saveSession();
        window.renderSessionTitle?.();
        await refreshSessionList(true);
        toast(t('sess.renamed'), 'success', 1800);
        return true;
    }
    try {
        const r = await SESS.rename(id, title.trim());
        const next = r?.title ?? title.trim();
        if (meta) meta.title = next;
        // 目前會話的記憶體也要同步，否則下次自動存檔會把標題蓋回去
        if (id === OC.session.id) {
            OC.session.title = next;
            window.renderSessionTitle?.();
        }
        _sessListAt = 0;   // 索引已由後端更新，下次拉清單會同步
        paintSessions();
        toast(t('sess.renamed'), 'success', 1800);
        return true;
    } catch (e) {
        toast(t('sess.renameFail', { msg: e.message }), 'error');
        return false;
    }
}

// 匯出：format 省略為 md；id 省略為目前會話
async function exportSession(format = 'md', id) {
    const fmt = format === 'json' ? 'json' : 'md';
    const sid = id || OC.session.id;
    if (!sid || (!id && !(OC.session.messages || []).length)) {
        toast(t('sess.noExport'), 'warn');
        return false;
    }
    try {
        if (sid === OC.session.id) await saveSession();
        const r = await SESS.export(sid, fmt);
        downloadText(r.filename, r.content, fmt === 'json' ? 'application/json' : 'text/markdown');
        toast(t('sess.exported', { f: r.filename }), 'success');
        return true;
    } catch (e) {
        toast(t('sess.exportFail', { msg: e.message }), 'error');
        return false;
    }
}

// 匯入：讀取先前匯出的 JSON 檔 → 以新 ID 存成新會話 → 載入
// 一律發新 ID，避免蓋掉已存在的會話；原 ID 留在 parent 方便追溯。
async function importSession(file) {
    if (!file) return false;
    if (OC.running) { toast(t('sess.busy'), 'warn'); return false; }
    let raw;
    try { raw = await file.text(); }
    catch (e) { toast(t('sess.importFail', { msg: e.message }), 'error'); return false; }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { toast(t('sess.importBad'), 'error'); return false; }
    // 匯出檔內容就是完整會話物件；相容 {session:{…}} 包裝
    const data = (parsed && typeof parsed.session === 'object' && parsed.session !== null) ? parsed.session : parsed;
    if (!data || typeof data !== 'object' || !Array.isArray(data.messages)) {
        toast(t('sess.importBad'), 'error');
        return false;
    }
    if (!data.messages.length) { toast(t('sess.importEmpty'), 'error'); return false; }
    const s = normalizeSession(data);
    const prevId = String(s.id || '');
    s.id = newSessionId();
    if (prevId && prevId !== s.id) s.parent = prevId;
    s.pinned = false;
    s.pinnedAt = 0;
    s.updated = Date.now();
    if (!s.created) s.created = s.updated;
    try {
        await SESS.save(s.id, s);
    } catch (e) {
        toast(t('sess.importFail', { msg: e.message }), 'error');
        return false;
    }
    _sessListAt = 0;   // 清單快取作廢，新會話才會出現在清單
    const ok = await loadSession(s.id);
    if (ok) toast(t('sess.imported', { t: s.title || t('sess.untitled') }), 'success', 2200);
    return ok;
}

// ═══════════════════════════════════════════════════════════════
// 開機續接：只在「同一工作區」且「8 小時內」才自動接回上次的會話
// ═══════════════════════════════════════════════════════════════
async function resumeLastSession() {
    try {
        const r = await SESS.list(40);
        _sessList = r.sessions || [];
        _sessListAt = Date.now();
        const curWs = OC.ws || OC.cfg.workspace || '';
        const mode = window.currentMode?.() || 'project';
        // 只接同一模式的會話；chat 模式不看工作區。
        // 大小寫不敏感比對：Windows 下「目錄」跟「磁碟」大小寫常常不一致。
        const cand = _sessList
            .filter(s => s.msg_count > 0)
            .filter(s => (window.modeOfSession?.(s) || 'project') === mode)
            .filter(s => mode === 'chat' || !s.ws || _sameWs(s.ws, curWs))
            .sort((a, b) => b.updated - a.updated)[0];
        paintSessions();
        if (!cand) return false;
        if (Date.now() - cand.updated > SESS_RESUME_WINDOW) return false;   // 太久沒動就重新開始
        // 檔案層級防呆：loadSession 正常一定切工作區；萬一它回了 true
        // 但 OC.ws 還停在舊路徑，寧可放棄續接、也不要頂著錯誤的工作區開工。
        const ok = await loadSession(cand.id, { silent: true });
        if (ok && mode !== 'chat' && cand.ws && !_sameWs(OC.ws || OC.cfg.workspace || '', cand.ws)) return false;
        if (ok) window.chatSystemNote?.(t('sess.resumed', { t: cand.title || t('sess.untitled'), when: fmtTime(cand.updated) }), 'resume');
        return ok;
    } catch {
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════
// 會話面板（#panel-sessions）
// ═══════════════════════════════════════════════════════════════

// ─── 會話分組標籤（跟著介面語系走；舊存檔沒有語系概念，這裡只管顯示）───
function sessGroupLabel(g) {
    if (typeof t !== 'function') return g;
    return { '今天': t('sess.gToday'), '昨天': t('sess.gYesterday'), '本週': t('sess.gWeek'), '更早': t('sess.gOlder') }[g] || g;
}

const SESS_GROUPS = ['今天', '昨天', '本週', '更早'];
let _sessModeFilter = 'current';     // current | project | chat | self | all

function sessGroupOf(ts) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const t0 = today.getTime();
    if (ts >= t0) return '今天';
    if (ts >= t0 - 86400000) return '昨天';
    if (ts >= t0 - 6 * 86400000) return '本週';
    return '更早';
}

// 面板骨架只建一次，之後只重畫清單；語系切換時外殼重建（見 renderSessionsPanel）
function sessionsHost() {
    const host = $('panel-sessions');
    if (!host) return null;
    if (host.dataset.ready === '1') return host;
    host.dataset.ready = '1';
    host.innerHTML = '';

    host.appendChild(el('div', { class: 'panel-head' },
        el('span', { class: 'panel-title' },
            el('span', { class: 'ms', text: 'forum' }),
            el('span', { text: t('panel.sessions') })),
        el('div', { class: 'panel-head-acts' },
            el('button', {
                class: 'btn btn-xs btn-ghost', title: t('sess.import'),
                onclick: () => _sessImportInput?.click(),
            }, el('span', { class: 'ms', text: 'upload' }), el('span', { text: t('sess.import') })),
            el('button', {
                class: 'btn btn-xs btn-ghost', title: t('sess.newT'),
                onclick: () => newSession(),
            }, el('span', { class: 'ms', text: 'add' }), el('span', { text: t('sess.new') })),
            el('button', {
                class: 'btn-icon', title: t('sess.refresh'),
                onclick: () => refreshSessionList(true),
            }, el('span', { class: 'ms', text: 'refresh' }))
        )
    ));

    // 模式分頁：目前模式 / 專案 / 對話 / 自我提升 / 全部
    host.appendChild(el('div', { class: 'sess-mode-tabs' },
        ...[['current', t('sess.modeCur')], ['project', t('sess.modeProj')], ['chat', t('sess.modeChat')], ['self', t('sess.modeSelf')], ['all', t('sess.modeAll')]].map(([k, lab]) =>
            el('button', { class: 'sess-mode-tab' + (k === _sessModeFilter ? ' active' : ''), 'data-mode': k,
                onclick: () => { _sessModeFilter = k; paintSessions(); } }, el('span', { text: lab })))
    ));

    host.appendChild(el('div', { class: 'panel-search' },
        el('span', { class: 'ms', text: 'search' }),
        el('input', {
            class: 'inp', id: 'sess-search', placeholder: t('sess.searchPh'),
            oninput: (e) => { _sessFilter = e.target.value.trim().toLowerCase(); paintSessions(); },
        })
    ));

    // 搜尋列留在外面固定不動，只有清單捲動；清單必須在 .panel-body 內
    // （.oc-panel 是 flex 直向容器，只有 .panel-body 有 overflow-y:auto）。
    const body = el('div', { class: 'panel-body', id: 'sessions-body' },
        el('div', { class: 'sess-list', id: 'sess-list' })
    );
    host.appendChild(body);
    // 匯入用的隱藏 file input（建一次重複用；選到檔就走 importSession）
    _sessImportInput = el('input', {
        type: 'file', accept: '.json,application/json', hidden: 'hidden',
        onchange: (e) => {
            const f = e.target.files && e.target.files[0];
            e.target.value = '';   // 清掉，下次選同一個檔才會再觸發
            if (f) importSession(f);
        },
    });
    host.appendChild(_sessImportInput);
    return host;
}

function sessionRow(s) {
    const cur = s.id === OC.session.id;
    const curWs = OC.ws || OC.cfg.workspace || '';
    const sMode = window.modeOfSession?.(s) || 'project';
    const other = sMode !== 'chat' && !!s.ws && !_sameWs(s.ws, curWs);
    const model = s.model ? getModelInfo(s.model) : null;
    const M = window.MODES?.[sMode];
    const pinned = !!s.pinned;

    const main = el('div', {
        class: 'sess-main',
        title: s.ws || '',
        onclick: () => { if (!cur) loadSession(s.id); },
    },
        el('div', { class: 'sess-title', text: s.title || t('sess.untitled') }),
        el('div', { class: 'sess-meta' },
            el('span', { text: fmtTime(s.updated) }),
            el('span', { class: 'sess-dot', text: '·' }),
            el('span', { text: t('sess.msgsN', { n: s.msg_count }) }),
            s.tokens ? el('span', { class: 'sess-dot', text: '·' }) : null,
            s.tokens ? el('span', { text: fmtTokens(s.tokens) + ' tokens' }) : null
        ),
        el('div', { class: 'sess-chips' },
            M && sMode !== 'project' ? el('span', { class: 'chip sess-mode sess-mode-' + sMode, text: (typeof modeLabelOf === 'function' ? modeLabelOf(sMode) : null) || M.label }) : null,
            model ? el('span', { class: 'chip sess-model', text: model.displayName }) : null,
            other ? el('span', { class: 'chip sess-otherws', title: s.ws, text: t('sess.otherWs') }) : null
        )
    );

    return el('div', { class: 'card sess-item' + (cur ? ' active' : '') + (pinned ? ' pinned' : ''), 'data-id': s.id },
        main,
        el('div', { class: 'sess-acts' },
            el('button', {
                class: 'btn-icon btn-xs' + (pinned ? ' active' : ''), title: pinned ? t('sess.unpin') : t('sess.pin'),
                onclick: (e) => { e.stopPropagation(); togglePinSession(s.id, !pinned); },
            }, el('span', { class: 'ms' + (pinned ? ' fill' : ''), text: 'push_pin' })),
            el('button', {
                class: 'btn-icon btn-xs', title: t('sess.exportMd'),
                onclick: (e) => { e.stopPropagation(); exportSession('md', s.id); },
            }, el('span', { class: 'ms', text: 'download' })),
            el('button', {
                class: 'btn-icon btn-xs', title: t('sess.exportJson'),
                onclick: (e) => { e.stopPropagation(); exportSession('json', s.id); },
            }, el('span', { class: 'ms', text: 'data_object' })),
            el('button', {
                class: 'btn-icon btn-xs', title: t('sess.rename'),
                onclick: (e) => { e.stopPropagation(); renameSession(s.id); },
            }, el('span', { class: 'ms', text: 'drive_file_rename_outline' })),
            el('button', {
                class: 'btn-icon btn-xs', title: t('sess.delOne'),
                onclick: (e) => { e.stopPropagation(); deleteSession(s.id); },
            }, el('span', { class: 'ms', text: 'delete' }))
        )
    );
}

// 重畫清單（純同步，資料來自 _sessList 快取）
function paintSessions() {
    const host = sessionsHost();
    if (!host) return;
    const box = $('sess-list');
    if (!box) return;
    box.innerHTML = '';

    // 目前會話若還沒存過檔，也要出現在清單最上方
    const rows = _sessList.slice();
    if (OC.session.id && !rows.some(x => x.id === OC.session.id) && (OC.session.messages || []).length) {
        rows.unshift({
            id: OC.session.id,
            title: OC.session.title || t('sess.untitled'),
            ws: OC.session.ws || OC.ws,
            mode: OC.session.mode,
            created: OC.session.created,
            updated: OC.session.updated || Date.now(),
            msg_count: OC.session.messages.length,
            tokens: (OC.session.usage?.in || 0) + (OC.session.usage?.out || 0),
            model: OC.session.model || OC.cfg.model,
            pinned: OC.session.pinned ? 1 : 0,
            pinnedAt: OC.session.pinnedAt || 0,
        });
    }

    // 模式篩選：預設只看目前模式（每個模式有自己的一份紀錄），可切「全部」
    const want = _sessModeFilter === 'current' ? (window.currentMode?.() || 'project') : _sessModeFilter;
    const byMode = want === 'all' ? rows : rows.filter(s => (window.modeOfSession?.(s) || 'project') === want);
    const hit = _sessFilter
        ? byMode.filter(s => (s.title || '').toLowerCase().includes(_sessFilter) || (s.id || '').includes(_sessFilter))
        : byMode;
    for (const b of $$('.sess-mode-tab')) b.classList.toggle('active', b.dataset.mode === _sessModeFilter);

    if (!hit.length) {
        box.appendChild(el('div', { class: 'panel-empty' },
            el('span', { class: 'ms', text: _sessFilter ? 'search_off' : 'forum' }),
            el('div', { class: 'hint', text: _sessFilter ? t('sess.noMatch') : t('sess.emptyHint') })
        ));
        return;
    }

    const groups = {};
    const isPin = (s) => !!s.pinned;
    // 置頂分區永遠在最上方；搜尋時只列符合的（置頂符合也只出現在置頂區，不重複）
    const pins = hit.filter(isPin).sort((a, b) => (b.pinnedAt || b.updated) - (a.pinnedAt || a.updated));
    if (pins.length) {
        box.appendChild(el('div', { class: 'sess-group sess-group-pin' },
            el('span', { class: 'ms', text: 'push_pin' }), el('span', { text: t('sess.pinnedN', { n: pins.length }) })));
        for (const s of pins) box.appendChild(sessionRow(s));
    }
    const rest = hit.filter(s => !isPin(s));
    for (const s of rest) (groups[sessGroupOf(s.updated)] ||= []).push(s);

    for (const g of SESS_GROUPS) {
        const list = groups[g];
        if (!list || !list.length) continue;
        box.appendChild(el('div', { class: 'sess-group', text: t('sess.groupN', { g: sessGroupLabel(g), n: list.length }) }));
        list.sort((a, b) => b.updated - a.updated);
        for (const s of list) box.appendChild(sessionRow(s));
    }
}

// 拉清單（有快取，force 時強拉）
async function refreshSessionList(force = false) {
    if (_sessListing) return _sessList;
    if (!force && _sessListAt && Date.now() - _sessListAt < SESS_LIST_TTL) { paintSessions(); return _sessList; }
    _sessListing = true;
    try {
        const r = await SESS.list(80);
        _sessList = r.sessions || [];
        _sessListAt = Date.now();
    } catch (e) {
        console.warn('[sessions] 清單載入失敗：', e.message);
    } finally {
        _sessListing = false;
    }
    paintSessions();
    return _sessList;
}

// 面板對外入口（app.js 切換面板時呼叫）；語系切換時外殼重建再重畫
function renderSessionsPanel(force = false) {
    if (force) {
        const host = $('panel-sessions');
        if (host) { delete host.dataset.ready; host.innerHTML = ''; }
    }
    paintSessions();
    refreshSessionList(false);
}

// ═══════════════════════════════════════════════════════════════
// 啟動
// ═══════════════════════════════════════════════════════════════
function initSessions() {
    if (!OC.session.id) OC.session.id = newSessionId();
    OC.session.ws = OC.session.ws || OC.ws || OC.cfg.workspace || '';
    OC.session.model = OC.session.model || OC.cfg.model || '';

    // 分頁被切走／被關掉時補送一次
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushSessionKeepalive();
    });
    window.addEventListener('pagehide', flushSessionKeepalive);

    sessionsHost();
    refreshSessionList(true);
}

// ═══════════════════════════════════════════════════════════════
Object.assign(window, {
    initSessions, saveSession, scheduleSaveSession, flushSessionKeepalive,
    newSession, loadSession, deleteSession, renameSession, togglePinSession, exportSession, importSession,
    renderSessionsPanel, refreshSessionList, resumeLastSession,
    emptySession, normalizeSession,
});
