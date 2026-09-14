'use strict';
// ═══════════════════════════════════════════════════════════════
// Omni Code — 排程執行（建議 #8）
// ═══════════════════════════════════════════════════════════════
// ★ 誠實的限制，寫在最前面：
//   這個排程「只在 Omni Code 分頁開著的時候活著」。
//
//   為什麼不能做成真正的背景服務：agent loop 在 agent.js 裡，
//   是瀏覽器的 JavaScript。Windows 工作排程器去打一個 PHP 端點，
//   PHP 那邊「根本沒有 LLM 迴圈可以跑」—— 不是難做，是結構上不存在。
//   與其假裝有背景自主執行，不如把限制講明白。
//
// 兩條不可設定的安全規則：
//   1. 無人值守的執行一律強制 plan 模式（除非該排程自帶 allowRules）
//   2. 全自動模式下拒絕觸發 —— 沒人看著的全自動是這個功能最糟的失敗模式
// ═══════════════════════════════════════════════════════════════

const SCHED_TICK_MS = 30000;      // 30 秒檢查一次，cron 最小粒度是分鐘，夠用
const SCHED_MAX_FAIL = 3;         // 連續失敗幾次就自動停用（失敗大聲說，不要靜默空轉）
let _schedTimer = null;
let _schedList = [];

// ─── 五欄位 cron 比對 ───────────────────────────────────────────
// 刻意只支援標準五欄位（分 時 日 月 週），不支援秒、不支援 @daily 這類簡寫。
// 排程要能被一眼看懂，語法糖只會製造「我以為它是這個意思」的 bug。
function cronFieldMatch(field, value) {
    for (const part of String(field).split(',')) {
        if (part === '*') return true;
        const [range, stepRaw] = part.split('/');
        const step = stepRaw ? parseInt(stepRaw, 10) : 1;
        if (!Number.isFinite(step) || step < 1) continue;
        if (range === '*') { if (value % step === 0) return true; continue; }
        const [aRaw, bRaw] = range.split('-');
        const a = parseInt(aRaw, 10);
        const b = bRaw === undefined ? a : parseInt(bRaw, 10);
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        for (let v = a; v <= b; v += step) if (v === value) return true;
    }
    return false;
}

function cronMatches(expr, d) {
    const f = String(expr || '').trim().split(/\s+/);
    if (f.length !== 5) return false;
    return cronFieldMatch(f[0], d.getMinutes())
        && cronFieldMatch(f[1], d.getHours())
        && cronFieldMatch(f[2], d.getDate())
        && cronFieldMatch(f[3], d.getMonth() + 1)
        && cronFieldMatch(f[4], d.getDay());
}

function cronDescribe(expr) {
    const f = String(expr || '').trim().split(/\s+/);
    if (f.length !== 5) return '（無效的 cron 運算式）';
    const [mi, h, dom, mon, dow] = f;
    if (dom === '*' && mon === '*' && dow === '*') {
        if (h === '*') return mi.startsWith('*/') ? `每 ${mi.slice(2)} 分鐘` : `每小時的第 ${mi} 分`;
        return `每天 ${h.padStart(2, '0')}:${mi.padStart(2, '0')}`;
    }
    const W = ['日', '一', '二', '三', '四', '五', '六'];
    if (dom === '*' && mon === '*') {
        const days = dow.split(',').map(x => W[+x] ?? x).join('、');
        return `每週${days} ${h.padStart(2, '0')}:${mi.padStart(2, '0')}`;
    }
    return expr;
}

// ─── 儲存 ───────────────────────────────────────────────────────

async function loadSchedules() {
    try {
        const r = await SETTINGS.get();
        _schedList = Array.isArray(r.config?.schedules) ? r.config.schedules : [];
    } catch { _schedList = []; }
    return _schedList;
}

async function saveSchedules() {
    try { await SETTINGS.set({ schedules: _schedList }); }
    catch (e) { toast(t('common.schedSaveFail', { msg: e.message }), 'error', 6000); }
}

// ─── 觸發 ───────────────────────────────────────────────────────

async function fireSchedule(s) {
    // 正在跑就別插隊 —— 丟進佇列，agent.js 會在回合邊界送進去。
    // 那個機制本來就是為了「執行到一半來了新訊息」設計的。
    if (OC.running) {
        window.queueMessage?.(`[排程 ${s.name}] ${s.prompt}`);
        window.chatSystemNote?.(`排程「${s.name}」已排入佇列（目前有工作在執行）。`, 'info');
        return;
    }

    // 安全規則 2：全自動模式下拒絕觸發
    if (OC.cfg.permissionMode === 'full' && !(s.allowRules || []).length) {
        window.chatSystemNote?.(
            `排程「${s.name}」沒有觸發：目前是全自動模式，而這個排程沒有自帶 allowRules。`
            + `沒人看著的全自動執行風險太高。請改用其他模式，或給這個排程明確的允許規則。`, 'warn', 9000);
        return;
    }

    // 安全規則 1：無人值守強制 plan 模式（除非自帶 allowRules）
    const prevMode = OC.cfg.permissionMode;
    const prevAllow = OC.sessionAllow || [];
    if ((s.allowRules || []).length) {
        OC.sessionAllow = [...prevAllow, ...s.allowRules];
    } else {
        await window.setPermissionMode?.('plan', { silent: true, skipConfirm: true });
    }

    window.chatSystemNote?.(`⏰ 排程「${s.name}」觸發（${cronDescribe(s.cron)}）`, 'info');
    try {
        await window.runAgent?.(s.prompt);
        s.failStreak = 0;
        notifyDone(s, true);
    } catch (e) {
        s.failStreak = (s.failStreak || 0) + 1;
        window.chatSystemNote?.(`排程「${s.name}」執行失敗（連續 ${s.failStreak} 次）：${e.message}`, 'error');
        // 連續失敗就自動停用 —— 靜默空轉比重試更糟（Muse 內測「監控無故關掉」那類故障）。
        // 停用是大聲的：使用者回來一眼就看到，不會以為它還在跑。
        if (s.failStreak >= SCHED_MAX_FAIL) {
            s.enabled = false;
            window.chatSystemNote?.(
                `排程「${s.name}」連續失敗 ${SCHED_MAX_FAIL} 次，已自動停用。修好問題後用 /schedule toggle ${s.id} 重開。`,
                'error', 12000);
        }
        try { await saveSchedules(); } catch {}
        notifyDone(s, false);
    } finally {
        // 還原權限狀態 —— 排程不該偷偷改變使用者的設定
        OC.sessionAllow = prevAllow;
        if (!(s.allowRules || []).length && prevMode !== 'plan') {
            await window.setPermissionMode?.(prevMode, { silent: true, skipConfirm: true });
        }
    }
}

function notifyDone(s, ok) {
    try {
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
        new Notification(ok ? `排程完成：${s.name}` : `排程失敗：${s.name}`,
            { body: s.prompt.slice(0, 120), silent: true });
    } catch {}
}

// ─── tick ───────────────────────────────────────────────────────

function schedTick() {
    if (!_schedList.length) return;
    const now = new Date();
    const stamp = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    let dirty = false;

    for (const s of _schedList) {
        if (!s.enabled) continue;
        if (!cronMatches(s.cron, now)) continue;
        // 同一分鐘只觸發一次；分頁關掉幾小時再開也不會補跑一整批
        if (s.lastStamp === stamp) continue;
        s.lastStamp = stamp;
        s.lastRun = Date.now();
        dirty = true;
        fireSchedule(s);
        break;                     // 一次只跑一個，避免同分鐘多筆互相插隊
    }
    if (dirty) saveSchedules();
}

async function initSchedules() {
    await loadSchedules();
    if (_schedTimer) clearInterval(_schedTimer);
    _schedTimer = setInterval(schedTick, SCHED_TICK_MS);
    // 分頁重開後：排程只在開著時活著，關掉期間錯過的不補跑 ——
    // 但要大聲說「這段時間我不在」，而不是讓使用者以為它們有跑。
    try {
        const seenRaw = parseInt(localStorage.getItem('oc_sched_seen') || '0', 10) || 0;
        try { localStorage.setItem('oc_sched_seen', String(Date.now())); } catch {}
        // 第一次進來沒有上次時間戳 —— 那是全新啟動，不是「重開」，不要誤報
        if (!seenRaw) return;
        const gap = Date.now() - seenRaw;
        const n = (_schedList || []).filter(s => s.enabled).length;
        if (n && gap > 10 * 60 * 1000) {
            window.chatSystemNote?.(
                `⚠ Omni Code 分頁剛重開（離開約 ${Math.round(gap / 60000)} 分鐘）。`
                + `這段期間 ${n} 個啟用中的排程都沒有執行 —— 排程只在分頁開著時活著，`
                + `錯過的不會補跑。`,
                'warn', 12000);
        }
    } catch {}
}

// ─── 指令介面 ───────────────────────────────────────────────────

function listSchedules() { return _schedList; }

function addSchedule(cron, name, prompt) {
    const f = String(cron || '').trim().split(/\s+/);
    if (f.length !== 5) return { ok: false, error: 'cron 必須是五欄位：分 時 日 月 週（例如 0 9 * * 1-5）' };
    if (!cronMatches(cron, new Date()) && !/^[\d*,\-\/\s]+$/.test(cron)) {
        return { ok: false, error: 'cron 只接受數字、* , - / 與空白' };
    }
    if (!prompt) return { ok: false, error: '要有一段給 Agent 的指示' };
    _schedList.push({
        id: 's' + Date.now().toString(36),
        name: name || prompt.slice(0, 20),
        cron, prompt, enabled: true, allowRules: [], lastRun: 0, lastStamp: '',
    });
    saveSchedules();
    return { ok: true };
}

function removeSchedule(id) {
    const n = _schedList.length;
    _schedList = _schedList.filter(s => s.id !== id);
    if (_schedList.length !== n) { saveSchedules(); return true; }
    return false;
}

function toggleSchedule(id) {
    const s = _schedList.find(x => x.id === id);
    if (!s) return false;
    s.enabled = !s.enabled;
    saveSchedules();
    return s.enabled;
}

Object.assign(window, {
    initSchedules, listSchedules, addSchedule, removeSchedule, toggleSchedule,
    cronMatches, cronDescribe, fireSchedule,
});
