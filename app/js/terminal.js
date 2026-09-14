'use strict';
// ═══════════════════════════════════════════════════════════════
// Omni Code — 終端機面板（#dock-terminal）
// ═══════════════════════════════════════════════════════════════
// 真正可互動的終端機：
//   · 前景命令   → EXEC.run（cd / clear 在前端本地處理）
//   · 背景 shell → EXEC.start 之後由 terminalAttach 輪詢 EXEC.output
//   · ANSI SGR 顏色保留、其餘跳脫序列剝除
//   · 命令歷史（↑ ↓，存 localStorage）
// 對外契約：initTerminal / terminalEcho / terminalAttach /
//           terminalTail / terminalClear / terminalRun
// 契約見 ARCHITECTURE.md §4 §15
// ═══════════════════════════════════════════════════════════════

const TERM_MAX_LINES = 2000;        // 輸出緩衝上限（超過從最舊開始丟）
const TERM_HIST_KEY  = 'oc_term_history';
const TERM_HIST_MAX  = 100;
const TERM_POLL_MS   = 1200;        // 背景 shell 輪詢間隔
const TERM_TIMEOUT   = 120000;
const TERM_STALL_MS  = 5 * 60 * 1000;   // 還在跑、但超過這麼久沒新輸出 → 提醒可能停滯

let _tInited = false;
let _tOut = null, _tInput = null, _tPrompt = null, _tShells = null, _tCwdBtn = null;
let _tBuf = [];                     // 純文字行緩衝（terminalTail 用）
let _tHist = [];
let _tHistIdx = -1;                 // -1 = 不在瀏覽歷史中
let _tDraft = '';
let _tStick = true;                 // 使用者是否黏在底部
let _tBusy = false;
const _tPollers = Object.create(null);   // shell_id -> setInterval id

// ═══════════════════════════════════════════════════════════════
// ANSI 處理
// ═══════════════════════════════════════════════════════════════
// 只認得最常見的 SGR（30-37 / 90-97 前景色、1 粗體、0 重置），
// 其餘 CSI / OSC 一律剝除。這樣 npm / git / composer 的輸出才不會變成亂碼。

const ANSI_FG = {
    30: '#5b6276', 31: '#ff6b6b', 32: '#4ecfa0', 33: '#efb567',
    34: '#5ac8fa', 35: '#b083ea', 36: '#4dd0e1', 37: '#c9cee0',
    90: '#6b7288', 91: '#ff8f8f', 92: '#7fe3c0', 93: '#f5cd8b',
    94: '#8fd9ff', 95: '#c9a4f2', 96: '#7fe0ea', 97: '#ffffff',
};

const RE_OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;   // OSC（設定視窗標題等）
const RE_CSI = /\x1b\[[0-9;?]*[A-Za-z]/g;          // 所有 CSI
const RE_CTL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g; // 控制字元（保留 \t \n）

// 純文字化（給緩衝與 terminalTail 用）
function ansiStrip(s) {
    return String(s ?? '').replace(RE_OSC, '').replace(RE_CSI, '').replace(RE_CTL, '');
}

// 依 SGR 參數更新樣式狀態
function ansiApplySgr(params, st) {
    const codes = String(params || '0').split(';');
    for (const raw of codes) {
        const c = parseInt(raw || '0', 10);
        if (Number.isNaN(c)) continue;
        if (c === 0) { st.color = ''; st.bold = false; }
        else if (c === 1) st.bold = true;
        else if (c === 22) st.bold = false;
        else if (c === 39) st.color = '';
        else if (ANSI_FG[c]) st.color = ANSI_FG[c];
    }
}

// 一行文字 → DocumentFragment（帶顏色的 span）
function ansiFragment(text) {
    const frag = document.createDocumentFragment();
    const s = String(text ?? '').replace(RE_OSC, '').replace(/\x1b[=>]/g, '');
    const st = { color: '', bold: false };
    const re = /\x1b\[([0-9;?]*)([A-Za-z])/g;
    let last = 0, m;

    const push = (chunk) => {
        const t = chunk.replace(RE_CTL, '');
        if (!t) return;
        if (st.color || st.bold) {
            const span = el('span', { class: 't-ansi' });
            if (st.color) span.style.color = st.color;
            if (st.bold) span.style.fontWeight = '700';
            span.textContent = t;
            frag.appendChild(span);
        } else {
            frag.appendChild(document.createTextNode(t));
        }
    };

    while ((m = re.exec(s)) !== null) {
        push(s.slice(last, m.index));
        last = re.lastIndex;
        if (m[2] === 'm') ansiApplySgr(m[1], st);   // 其餘 CSI（清行、移動游標…）直接丟棄
    }
    push(s.slice(last));
    return frag;
}

// 背景 shell 標籤配色（依 id 雜湊，同一個 shell 顏色固定）
const SHELL_COLORS = ['#8b7cf6', '#4ecfa0', '#efb567', '#5ac8fa', '#ff97c4', '#4dd0e1'];
function termShellColor(id) {
    let h = 0;
    const s = String(id || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return SHELL_COLORS[h % SHELL_COLORS.length];
}

// ═══════════════════════════════════════════════════════════════
// 建立面板
// ═══════════════════════════════════════════════════════════════

function initTerminal() {
    if (_tInited) return true;
    const host = $('dock-terminal');
    if (!host) return false;

    if (typeof OC.termCwd !== 'string') OC.termCwd = '';
    _tHist = loadTermHistory();

    host.innerHTML = '';

    // ─── 工具列 ───
    _tCwdBtn = el('button', {
        class: 'btn btn-xs btn-ghost t-cwd',
        title: t('term.cwdT'),
        onclick: termChooseCwd,
    }, el('span', { class: 'ms', text: 'folder_open' }), el('span', { class: 't-cwd-text', text: termCwdLabel() }));

    const bar = el('div', { class: 't-bar' },
        el('span', { class: 'ms t-bar-icon', text: 'terminal' }),
        el('span', { class: 't-bar-title', text: t('term.title') }),
        _tCwdBtn,
        el('span', { class: 't-bar-gap' }),
        el('button', {
            class: 'btn btn-xs btn-ghost', title: t('term.clearT'), onclick: () => terminalClear(),
        }, el('span', { class: 'ms', text: 'delete_sweep' }), el('span', { text: t('term.clear') })),
        el('button', {
            class: 'btn btn-xs btn-ghost', title: t('term.copyAllT'),
            onclick: () => copyText(_tBuf.join('\n')),
        }, el('span', { class: 'ms', text: 'content_copy' }), el('span', { text: t('term.copyAll') })),
    );

    // ─── 背景 shell 列 ───
    _tShells = el('div', { class: 't-shells' });

    // ─── 輸出區 ───
    _tOut = el('div', { class: 't-out', tabindex: '0' });
    _tOut.addEventListener('scroll', () => {
        _tStick = (_tOut.scrollHeight - _tOut.scrollTop - _tOut.clientHeight) < 48;
    });
    _tOut.addEventListener('mouseup', () => {
        // 有選取文字時不要搶焦點，否則沒辦法複製
        if (!String(window.getSelection?.() || '')) _tInput?.focus();
    });

    // ─── 輸入列 ───
    _tPrompt = el('span', { class: 't-prompt', text: termPromptLabel() });
    _tInput = el('input', {
        class: 't-input', type: 'text', spellcheck: 'false',
        autocomplete: 'off', autocapitalize: 'off',
        placeholder: t('term.inputPh'),
        onkeydown: termOnKey,
    });
    const inputLine = el('div', { class: 't-input-line', onclick: () => _tInput.focus() },
        _tPrompt, _tInput);

    host.appendChild(bar);
    host.appendChild(_tShells);
    host.appendChild(_tOut);
    host.appendChild(inputLine);

    _tInited = true;
    termRenderShells();
    termLine(t('term.welcome', { ws: OC.ws || t('term.noWs') }), 'sys');
    termLine(t('term.welcomeHint'), 'sys');
    // 重整／重開後：後端可能還有沒跑完的背景 shell，前端輪詢器卻沒了。
    // 這裡主動 list 一次，把還在 running 的接回來 —— 否則它們在後端默默跑、
    // 前端卻以為沒事，那正是「靜默吞錯」。
    try {
        EXEC.list().then(r => {
            const shells = (r && r.shells) || [];
            const resumed = [];
            for (const s of shells) {
                if (!s || !s.running || !s.id) continue;
                if (OC.shells[s.id]) continue;
                OC.shells[s.id] = { command: s.command || '', offset: 0, running: true };
                resumed.push(s.id);
            }
            if (resumed.length) {
                termLine(`⚠ 偵測到 ${resumed.length} 個在分頁關閉前還在跑的背景程序（${resumed.join('、')}），已重新接上輪詢。輸出可能有缺口 —— 完整內容看 data/shells/ 日誌。`, 'warn');
                termScrollEnd();
                for (const id of resumed) terminalAttach(id, OC.shells[id].command);
                termRenderShells();
            }
        }).catch(() => {});
    } catch {}
    return true;
}

// 面板可能還沒建立（tools.js 會早於 app.js 呼叫 terminalEcho）
function ensureTerm() {
    if (_tInited) return true;
    return initTerminal();
}

function termCwdLabel() { return OC.termCwd ? shortPath(OC.termCwd, 34) : '（工作區根目錄）'; }
function termPromptLabel() { return (OC.termCwd ? OC.termCwd + ' ' : '') + '$'; }

function termSyncCwd() {
    if (_tCwdBtn) { const t = $1('.t-cwd-text', _tCwdBtn); if (t) t.textContent = termCwdLabel(); }
    if (_tPrompt) _tPrompt.textContent = termPromptLabel();
}

// ═══════════════════════════════════════════════════════════════
// 輸出
// ═══════════════════════════════════════════════════════════════

// 附加一行（已處理 ANSI 與緩衝上限）
function termLine(text, kind, shellId) {
    const cls = ['cmd', 'out', 'err', 'sys'].includes(kind) ? kind : 'out';
    const plain = ansiStrip(text);

    _tBuf.push((shellId ? `[${shellId}] ` : '') + plain);
    if (_tBuf.length > TERM_MAX_LINES) _tBuf.splice(0, _tBuf.length - TERM_MAX_LINES);

    if (!_tOut) return;
    const line = el('div', { class: 't-line ' + cls });
    if (shellId) {
        const tag = el('span', { class: 't-tag', text: `[${shellId}]` });
        tag.style.color = termShellColor(shellId);
        line.appendChild(tag);
    }
    line.appendChild(ansiFragment(text));
    _tOut.appendChild(line);

    while (_tOut.childElementCount > TERM_MAX_LINES) _tOut.removeChild(_tOut.firstChild);
}

function termScrollEnd(force) {
    if (!_tOut) return;
    if (!_tStick && !force) return;
    _tOut.scrollTop = _tOut.scrollHeight;
}

// 對外：把一段文字寫進終端機
// kind: 'cmd' | 'out' | 'err' | 'sys'
function terminalEcho(text, kind = 'out', shellId = '') {
    if (text === null || text === undefined) return;
    const s = String(text);
    if (!s.length) return;
    ensureTerm();

    const lines = s.replace(/\r\n/g, '\n').split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    for (let line of lines) {
        // 單獨的 CR 代表「回車覆寫」（進度條）——只保留最後一段
        if (line.indexOf('\r') !== -1) line = line.split('\r').pop();
        termLine(line, kind, shellId);
    }
    termScrollEnd();
}

// 對外：清空
function terminalClear() {
    ensureTerm();
    // 依契約：清除時一併停止所有輪詢器（背景程序本身不受影響）
    const attached = Object.keys(_tPollers);
    attached.forEach(termStopPoller);
    _tBuf = [];
    if (_tOut) _tOut.innerHTML = '';
    _tStick = true;
    if (attached.length) {
        termLine(`已停止 ${attached.length} 個背景輸出串接；點上方的 shell 標籤可重新附加。`, 'sys');
    }
    termRenderShells();
    termScrollEnd(true);
}

// 對外：取最後 N 個字元的純文字（給 agent.js 的 uiSnapshot）
function terminalTail(maxChars = 2000) {
    const all = _tBuf.join('\n');
    const n = Math.max(0, parseInt(maxChars, 10) || 0);
    if (!n || all.length <= n) return all;
    return '…' + all.slice(-n);
}

// ═══════════════════════════════════════════════════════════════
// 命令執行
// ═══════════════════════════════════════════════════════════════

// 把 cd 的參數解析成工作區相對路徑
function termResolveCwd(base, arg) {
    let a = String(arg || '').trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/');
    if (a === '' || a === '~' || a === '/') return '';
    const parts = a.startsWith('/') ? [] : String(base || '').split('/').filter(Boolean);
    for (const seg of a.split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') parts.pop();
        else parts.push(seg);
    }
    return parts.join('/');
}

async function termCd(arg) {
    const target = termResolveCwd(OC.termCwd || '', arg);
    if (!target) {
        OC.termCwd = '';
        termSyncCwd();
        termLine(t('term.cdRoot'), 'sys');
        termScrollEnd();
        return;
    }
    try {
        const st = await FS.stat(target);
        if (!st.exists) { termLine(t('term.cdNoPath', { p: target }), 'err'); termScrollEnd(); return; }
        if (st.type !== 'dir') { termLine(t('term.cdNotDir', { p: target }), 'err'); termScrollEnd(); return; }
    } catch (e) {
        // 目標在工作區之外 → 這不是錯誤，是「你想換一個專案」。
        // 直接提供切換工作區的按鈕，而不是丟一句看不懂的越界訊息。
        if (/超出工作區|403/.test(e.message)) {
            await termOfferWorkspaceSwitch(arg);
            return;
        }
        termLine(`cd: ${e.message}`, 'err');
        termScrollEnd();
        return;
    }
    OC.termCwd = target;
    termSyncCwd();
    termLine(t('term.cdTo', { p: target }), 'sys');
    termScrollEnd();
}

// cd 到工作區外時的引導：Omni Code 的權限邊界是「工作區」，
// 要在別的資料夾工作就得換工作區，這是設計，不是限制的 bug。
// 但使用者不該只看到一句紅字，所以這裡直接把切換動作端到他面前。
async function termOfferWorkspaceSwitch(rawPath) {
    const abs = String(rawPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
    termLine(t('term.notInWs', { p: abs }), 'err');
    termLine(t('term.curWs', { ws: OC.ws }), 'sys');

    // 先確認那個資料夾真的存在（用不受工作區限制的 browse）
    let exists = false;
    try {
        const r = await SETTINGS.browse(abs);
        exists = !!r.cwd;
    } catch { exists = false; }

    if (!exists) {
        termLine(t('term.noSuchPath'), 'sys');
        termScrollEnd();
        return;
    }

    const line = el('div', { class: 't-line t-line-sys t-offer' },
        el('span', { text: t('term.switchAsk') }),
        el('button', {
            class: 'btn btn-xs btn-primary', text: t('term.switchTo', { n: baseName(abs) }),
            onclick: async () => {
                line.remove();
                termLine(t('term.switchingTo', { p: abs }), 'sys');
                await window.applyWorkspace?.(abs);
                OC.termCwd = '';
                termSyncCwd();
                termLine(t('term.switched', { ws: OC.ws }), 'sys');
                termScrollEnd();
            },
        }),
        el('button', {
            class: 'btn btn-xs btn-ghost', text: t('term.browseOther'),
            onclick: () => { line.remove(); window.openWorkspacePicker?.(); },
        })
    );
    _tOut?.appendChild(line);
    termScrollEnd();
}

// 點工具列的路徑按鈕 → 手動輸入工作目錄
async function termChooseCwd() {
    const v = await promptModal(t('term.pickCwdT'), t('term.pickCwdLab'),
        OC.termCwd || '', { hint: t('term.pickCwdHint', { ws: OC.ws || '' }), placeholder: 'app/js' });
    if (v === null) return;
    await termCd(v.trim() || '/');
    _tInput?.focus();
}

// 對外：執行一行命令
async function terminalRun(command) {
    const cmd = String(command || '').trim();
    if (!cmd) return;
    ensureTerm();
    pushTermHistory(cmd);

    // ─── 本地特例 ───
    if (/^(clear|cls)$/i.test(cmd)) { terminalClear(); return; }
    const cd = cmd.match(/^cd(?:\s+(.*))?$/i);
    if (cd) {
        termLine(termPromptLabel() + ' ' + cmd, 'cmd');
        await termCd(cd[1] || '');
        return;
    }

    if (_tBusy) { termLine(t('term.alreadyBusy'), 'sys'); termScrollEnd(); return; }

    termLine(termPromptLabel() + ' ' + cmd, 'cmd');
    termScrollEnd();
    setTermBusy(true);
    const t0 = Date.now();
    try {
        const r = await EXEC.run(cmd, OC.termCwd || '', TERM_TIMEOUT);
        if (r.stdout) terminalEcho(r.stdout, 'out');
        if (r.stderr) terminalEcho(r.stderr, 'err');
        if (!r.stdout && !r.stderr) termLine(t('term.noOut'), 'sys');
        termLine(
            t('term.exitLine', {
                c: r.exit_code,
                to: r.timed_out ? t('term.timedOut') : '',
                d: fmtDur(r.duration_ms || (Date.now() - t0)),
                tr: r.truncated ? t('term.truncated') : '',
            }),
            'sys');
        window.refreshFileTreeSoon?.();
    } catch (e) {
        termLine(`✗ ${e.message}`, 'err');
        if (e.detail) termLine(String(e.detail).slice(0, 400), 'err');
    } finally {
        setTermBusy(false);
        termScrollEnd();
    }
}

function setTermBusy(v) {
    _tBusy = !!v;
    if (!_tInput) return;
    const hadFocus = document.activeElement === _tInput || document.activeElement === document.body;
    _tInput.disabled = _tBusy;
    _tInput.placeholder = _tBusy ? t('term.runningPh') : t('term.inputPh');
    // 只有原本焦點就在終端機時才收回焦點，避免搶走聊天輸入框
    if (!_tBusy && hadFocus && _tInput.offsetParent !== null) _tInput.focus();
}

// ═══════════════════════════════════════════════════════════════
// 命令歷史
// ═══════════════════════════════════════════════════════════════

function loadTermHistory() {
    try {
        const a = JSON.parse(localStorage.getItem(TERM_HIST_KEY) || '[]');
        return Array.isArray(a) ? a.filter(x => typeof x === 'string').slice(-TERM_HIST_MAX) : [];
    } catch { return []; }
}
function saveTermHistory() {
    try { localStorage.setItem(TERM_HIST_KEY, JSON.stringify(_tHist.slice(-TERM_HIST_MAX))); } catch {}
}
function pushTermHistory(cmd) {
    if (_tHist[_tHist.length - 1] !== cmd) _tHist.push(cmd);
    if (_tHist.length > TERM_HIST_MAX) _tHist.splice(0, _tHist.length - TERM_HIST_MAX);
    _tHistIdx = -1;
    _tDraft = '';
    saveTermHistory();
}

function termOnKey(e) {
    if (e.isComposing || e.keyCode === 229) return;   // 輸入法組字中
    if (e.key === 'Enter') {
        e.preventDefault();
        const v = _tInput.value;
        _tInput.value = '';
        _tHistIdx = -1;
        terminalRun(v);
        return;
    }
    if (e.key === 'ArrowUp') {
        if (!_tHist.length) return;
        e.preventDefault();
        if (_tHistIdx === -1) { _tDraft = _tInput.value; _tHistIdx = _tHist.length - 1; }
        else if (_tHistIdx > 0) _tHistIdx--;
        _tInput.value = _tHist[_tHistIdx] || '';
        setTimeout(() => _tInput.setSelectionRange(_tInput.value.length, _tInput.value.length), 0);
        return;
    }
    if (e.key === 'ArrowDown') {
        if (_tHistIdx === -1) return;
        e.preventDefault();
        if (_tHistIdx < _tHist.length - 1) { _tHistIdx++; _tInput.value = _tHist[_tHistIdx] || ''; }
        else { _tHistIdx = -1; _tInput.value = _tDraft; }
        setTimeout(() => _tInput.setSelectionRange(_tInput.value.length, _tInput.value.length), 0);
        return;
    }
    if (e.key === 'l' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); terminalClear(); return; }
    if (e.key === 'c' && e.ctrlKey && !_tInput.value) {
        // 沒有選取內容時，Ctrl+C 當作「取消目前輸入」
        e.preventDefault();
        termLine(termPromptLabel() + ' ^C', 'sys');
        termScrollEnd();
    }
}

// ═══════════════════════════════════════════════════════════════
// 背景 shell 串接
// ═══════════════════════════════════════════════════════════════

// 對外：把某個背景 shell 的輸出串接到終端機
function terminalAttach(shellId, command) {
    const id = String(shellId || '').trim();
    if (!id) return;
    ensureTerm();

    const sh = OC.shells[id] || (OC.shells[id] = { command: command || '', offset: 0, running: true });
    if (command) sh.command = command;
    if (sh.running === undefined) sh.running = true;

    if (_tPollers[id]) { termRenderShells(); return; }

    termLine(`▶ 背景啟動 ${sh.command || '(未知命令)'}`, 'sys', id);
    termScrollEnd();

    let inflight = false;
    sh.lastOutAt = sh.lastOutAt || Date.now();
    sh.stallWarned = false;
    const timer = setInterval(async () => {
        if (inflight) return;
        inflight = true;
        try {
            const since = sh.offset || 0;
            const r = await EXEC.output(id, since);
            if (typeof r.offset === 'number') sh.offset = r.offset;
            sh.running = !!r.running;
            if (r.chunk) {
                terminalEcho(r.chunk, 'out', id);
                sh.lastOutAt = Date.now();
                sh.stallWarned = false;
            }
            if (!r.running) {
                termLine(`■ 程序結束，結束碼 ${r.exit_code ?? '?'}`, 'sys', id);
                termScrollEnd();
                termStopPoller(id);
                termRenderShells();
            } else if (!sh.stallWarned && Date.now() - sh.lastOutAt > TERM_STALL_MS) {
                // 還在跑、但 5 分鐘沒新輸出 —— 可能是卡住了（Muse 內測「停刷」那類故障）。
                // 只提醒一次，不自動殺：殺掉一個其實還在跑的任務更糟。
                sh.stallWarned = true;
                termLine('⚠ 這個程序已經 5 分鐘沒有新輸出了，可能停滯。若確定卡住可用「終止」結束它。', 'warn', id);
                termScrollEnd();
                window.chatSystemNote?.(`⚠ 背景程序 ${id}（${sh.command || ''}）5 分鐘沒有新輸出，可能停滯。`, 'warn');
            }
        } catch (e) {
            termLine(`✗ 讀取輸出失敗：${e.message}`, 'err', id);
            termScrollEnd();
            sh.running = false;
            termStopPoller(id);
            termRenderShells();
        } finally {
            inflight = false;
        }
    }, TERM_POLL_MS);

    _tPollers[id] = timer;
    sh.poll = timer;
    termRenderShells();
}

function termStopPoller(id) {
    const t = _tPollers[id];
    if (t) clearInterval(t);
    delete _tPollers[id];
    if (OC.shells[id]) OC.shells[id].poll = null;
}

async function termKillShell(id) {
    try {
        await EXEC.kill(id);
        if (OC.shells[id]) OC.shells[id].running = false;
        termStopPoller(id);
        termLine(t('term.killed'), 'sys', id);
        termScrollEnd();
        toast(t('term.killedT', { id }), 'success', 2000);
    } catch (e) {
        termLine(t('term.killFail', { msg: e.message }), 'err', id);
        termScrollEnd();
        toast(t('term.killFail', { msg: e.message }), 'error');
    }
    termRenderShells();
}

// 執行中的背景 shell 一覽
function termRenderShells() {
    if (!_tShells) return;
    _tShells.innerHTML = '';
    const running = Object.entries(OC.shells || {}).filter(([, s]) => s && s.running);
    if (!running.length) { _tShells.classList.remove('has-shells'); return; }
    _tShells.classList.add('has-shells');

    _tShells.appendChild(el('span', { class: 't-shells-label', text: t('term.bgProcs') }));
    for (const [id, sh] of running) {
        const attached = !!_tPollers[id];
        const tag = el('span', { class: 't-shell-id', text: id });
        tag.style.color = termShellColor(id);
        const chip = el('div', {
            class: 't-shell' + (attached ? ' attached' : ''),
            title: (attached ? t('term.attachOn') : t('term.attachOff')) + `：${sh.command || ''}`,
            onclick: (e) => { if (e.target.closest('button')) return; if (!attached) terminalAttach(id, sh.command); },
        },
            el('span', { class: 'ms', text: attached ? 'sensors' : 'link' }),
            tag,
            el('span', { class: 't-shell-cmd', text: shortPath(String(sh.command || ''), 40) }),
            el('button', {
                class: 'btn btn-xs btn-danger', title: t('term.killBg'),
                onclick: (e) => { e.stopPropagation(); termKillShell(id); },
            }, el('span', { text: t('term.killOne') })),
        );
        _tShells.appendChild(chip);
    }
}

// ═══════════════════════════════════════════════════════════════
// 匯出
// ═══════════════════════════════════════════════════════════════
Object.assign(window, {
    initTerminal, terminalEcho, terminalAttach, terminalTail, terminalClear, terminalRun,
});
