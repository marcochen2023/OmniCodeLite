'use strict';
// ═══════════════════════════════════════════════════════════════
// Omni Code — Diff 檢視（#dock-diff）
// ═══════════════════════════════════════════════════════════════
// 三種比較來源，依序判斷：
//   1. 檔案在編輯器開著且未存檔 → 磁碟內容 vs 編輯器緩衝
//   2. 本會話有基準快照（OC.diffBase[path]）→ 基準 vs 目前磁碟內容
//   3. 都沒有 → 改用 git diff（解析 unified diff），並把目前內容記為基準
// renderDiffRows 是共用渲染器，chat.js 的工具卡也是走這裡（window.renderDiffRows）。
// 契約見 ARCHITECTURE.md §12（ui:{type:'diff'}）與 §15
// ═══════════════════════════════════════════════════════════════

const DIFF_MAX_ROWS = 600;      // 一次最多畫幾列，其餘按「顯示全部」再畫
const DIFF_CTX      = 3;        // 精簡模式保留的前後文行數

let _dvInited = false;
let _dvBody = null, _dvChanges = null, _dvSub = null, _dvToggle = null;
let _dvCur = null;              // {path, before, after, rows?, note, compact}

// OC.diffBase 由本模組維護（state.js 沒有預先宣告）
function dvBaseMap() {
    return OC.diffBase || (OC.diffBase = {});
}

// ═══════════════════════════════════════════════════════════════
// 面板骨架
// ═══════════════════════════════════════════════════════════════

function initDiffView() {
    if (_dvInited) return true;
    const host = $('dock-diff');
    if (!host) return false;

    host.innerHTML = '';

    _dvSub = el('span', { class: 'dv-sub', text: '' });
    _dvToggle = el('button', {
        class: 'btn btn-xs btn-ghost', title: t('dv.toggle'),
        onclick: () => {
            if (!_dvCur) return;
            _dvCur.compact = !_dvCur.compact;
            dvRender();
        },
    }, el('span', { class: 'ms', text: 'unfold_more' }), el('span', { text: t('dv.fullCompact') }));

    const bar = el('div', { class: 'dv-bar' },
        el('span', { class: 'ms dv-bar-icon', text: 'difference' }),
        el('span', { class: 'dv-title', text: t('dv.title') }),
        _dvSub,
        el('span', { class: 'dv-bar-gap' }),
        _dvToggle,
        el('button', {
            class: 'btn btn-xs btn-ghost', title: t('dv.copyDiff'),
            onclick: () => copyText(dvDiffText()),
        }, el('span', { class: 'ms', text: 'content_copy' }), el('span', { text: t('dv.copyShort') })),
        el('button', {
            class: 'btn btn-xs btn-ghost', title: t('dv.refresh'),
            onclick: () => listSessionChanges(),
        }, el('span', { class: 'ms', text: 'refresh' }), el('span', { text: t('dv.refreshShort') })),
    );

    _dvChanges = el('div', { class: 'dv-changes' });
    _dvBody = el('div', { class: 'dv-body' });

    host.appendChild(bar);
    host.appendChild(_dvChanges);
    host.appendChild(_dvBody);

    _dvInited = true;
    dvRender();
    listSessionChanges();
    return true;
}

function ensureDiff() { return _dvInited ? true : initDiffView(); }

// ═══════════════════════════════════════════════════════════════
// 共用渲染器：rows → DOM
// rows 來自 utils.js 的 diffLines() / compactDiff()
//   [{type:'ctx'|'add'|'del'|'gap', text, aLine, bLine}]
// ═══════════════════════════════════════════════════════════════

function dvRowNode(r) {
    const type = ['ctx', 'add', 'del', 'gap'].includes(r?.type) ? r.type : 'ctx';
    const line = el('div', { class: 'diff-line ' + type });
    if (type === 'gap') {
        line.appendChild(el('span', { class: 'diff-gap-text', text: r.text || '⋯' }));
        return line;
    }
    line.appendChild(el('span', { class: 'diff-ln', text: r.aLine ? String(r.aLine) : '' }));
    line.appendChild(el('span', { class: 'diff-ln', text: r.bLine ? String(r.bLine) : '' }));
    line.appendChild(el('span', { class: 'diff-mark', text: type === 'add' ? '+' : type === 'del' ? '−' : ' ' }));
    line.appendChild(el('span', { class: 'diff-txt', text: r.text ?? '' }));
    return line;
}

function renderDiffRows(rows, opts = {}) {
    const compact = opts.compact === true;
    const maxRows = Math.max(20, parseInt(opts.maxRows ?? DIFF_MAX_ROWS, 10) || DIFF_MAX_ROWS);
    const ctx = parseInt(opts.ctx ?? DIFF_CTX, 10);

    let list = Array.isArray(rows) ? rows : [];
    if (compact && list.length) list = compactDiff(list, ctx);

    const view = el('div', { class: 'diff-view' });
    if (!list.length) {
        view.appendChild(el('div', { class: 'hint', text: t('dv.noDiff') }));
        return view;
    }

    const body = el('div', { class: 'diff-rows' });
    view.appendChild(body);

    const paint = (from, to) => {
        const frag = document.createDocumentFragment();
        for (let i = from; i < to; i++) frag.appendChild(dvRowNode(list[i]));
        body.appendChild(frag);
    };

    const first = Math.min(list.length, maxRows);
    paint(0, first);

    if (list.length > first) {
        let more = null;
        more = el('button', {
            class: 'btn btn-sm btn-ghost diff-more',
            text: `顯示全部（還有 ${list.length - first} 行）`,
            onclick: () => { paint(first, list.length); more.remove(); },
        });
        view.appendChild(more);
    }
    return view;
}

// diff 統計小標籤
function dvStatNode(st) {
    return el('span', { class: 'diff-stat' },
        el('span', { class: 'diff-stat-add', text: `+${st.add}` }),
        el('span', { class: 'diff-stat-del', text: `−${st.del}` }),
    );
}

// ═══════════════════════════════════════════════════════════════
// 主檢視
// ═══════════════════════════════════════════════════════════════

function dvCurrentRows() {
    if (!_dvCur) return [];
    if (_dvCur.rows) return _dvCur.rows;
    return diffLines(_dvCur.before, _dvCur.after);
}

// 把目前 diff 轉成可複製的純文字
function dvDiffText() {
    const rows = dvCurrentRows();
    if (!rows.length) return '';
    const head = `--- ${_dvCur?.path || ''}\n+++ ${_dvCur?.path || ''}\n`;
    return head + rows.map(r => {
        if (r.type === 'gap') return '@@';
        return (r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' ') + (r.text ?? '');
    }).join('\n');
}

function dvRender() {
    if (!_dvBody) return;
    _dvBody.innerHTML = '';

    if (!_dvCur) {
        if (_dvSub) _dvSub.textContent = '';
        _dvBody.appendChild(el('div', { class: 'hint dv-empty' },
            el('span', { class: 'ms', text: 'difference' }),
            el('span', { text: t('dv.pickFile') })));
        return;
    }

    const rows = dvCurrentRows();
    const st = diffStat(rows);
    if (_dvSub) _dvSub.textContent = `${shortPath(_dvCur.path, 52)}　+${st.add} −${st.del}`;

    // ─── 標頭 ───
    const head = el('div', { class: 'dv-head' },
        el('span', { class: 'ms', text: fileIcon(_dvCur.path, 'file') }),
        el('span', { class: 'dv-path', text: _dvCur.path, title: _dvCur.path }),
        dvStatNode(st),
        el('span', { class: 'dv-bar-gap' }),
        el('button', {
            class: 'btn btn-xs btn-ghost', title: t('dv.openFile'),
            onclick: () => window.openFile?.(_dvCur.path),
        }, el('span', { class: 'ms', text: 'edit' }), el('span', { text: t('dv.openShort') })),
    );
    _dvBody.appendChild(head);

    if (_dvCur.note) _dvBody.appendChild(el('div', { class: 'dv-note hint', text: _dvCur.note }));

    _dvBody.appendChild(renderDiffRows(rows, {
        compact: _dvCur.compact !== false,
        maxRows: DIFF_MAX_ROWS,
        ctx: DIFF_CTX,
    }));
}

// 對外：直接給定前後內容
function showDiff(path, before, after, opts = {}) {
    ensureDiff();
    _dvCur = {
        path: String(path || ''),
        before: String(before ?? ''),
        after: String(after ?? ''),
        rows: null,
        note: opts.note || '',
        compact: opts.compact !== false,
    };
    window.switchDock?.('diff');
    dvRender();
    return true;
}

// 內部：直接給定已解析好的 rows（git diff 用）
function dvShowRows(path, rows, note) {
    ensureDiff();
    _dvCur = { path: String(path || ''), before: '', after: '', rows: rows || [], note: note || '', compact: false };
    window.switchDock?.('diff');
    dvRender();
}

function dvBusy(msg) {
    if (!_dvBody) return;
    _dvBody.innerHTML = '';
    _dvBody.appendChild(el('div', { class: 'dv-busy hint' },
        el('span', { class: 'spinner' }), el('span', { text: msg })));
}

// ═══════════════════════════════════════════════════════════════
// 檔案 diff（三種來源）
// ═══════════════════════════════════════════════════════════════

async function showFileDiff(path) {
    const p = String(path || '').trim();
    if (!p) { toast(t('dv.noFile'), 'warn'); return; }
    if (!ensureDiff()) return;
    window.switchDock?.('diff');
    dvBusy(`讀取 ${shortPath(p, 40)}…`);

    // 目前磁碟內容
    let st = null, disk = '';
    try { st = await FS.stat(p); } catch { st = null; }
    if (st?.exists && st.type === 'dir') {
        _dvCur = null;
        dvRender();
        toast(t('dv.dirNoDiff'), 'warn');
        return;
    }
    if (st?.exists) {
        try { disk = (await FS.readAll(p)).content || ''; }
        catch (e) { disk = ''; }
    }

    // ─── 1) 編輯器開著且未存檔 ───
    const open = (OC.openFiles || []).find(f => f.path === p);
    if (open && open.dirty) {
        let buf = '';
        try { buf = open.cm?.getValue?.() ?? open.content ?? ''; } catch { buf = open.content || ''; }
        showDiff(p, disk, buf, { note: '磁碟內容 → 編輯器緩衝（尚未存檔）' });
        listSessionChanges();
        return;
    }

    // ─── 2) 本會話基準快照 ───
    const base = dvBaseMap();
    if (Object.prototype.hasOwnProperty.call(base, p)) {
        showDiff(p, base[p], st?.exists ? disk : '', {
            note: st?.exists ? '本會話基準 → 目前磁碟內容' : '本會話基準 → 檔案已被刪除',
        });
        listSessionChanges();
        return;
    }

    // ─── 3) 沒有基準 → 改用 git diff ───
    dvBusy('本會話沒有基準版本，改用 git diff 比較…');
    const rows = await dvGitDiffRows(p);
    if (st?.exists) base[p] = disk;     // 之後的變更就以「現在」為基準（延遲建立）

    if (rows && rows.length) {
        dvShowRows(p, rows, 'git diff（本會話沒有基準版本；已把目前內容設為之後的比較基準）');
        listSessionChanges();
        return;
    }
    dvNoBaseline(p, rows === null, !!st?.exists);
    listSessionChanges();
}

function dvNoBaseline(path, gitFailed, recorded) {
    ensureDiff();
    _dvCur = null;
    if (!_dvBody) return;
    _dvBody.innerHTML = '';
    if (_dvSub) _dvSub.textContent = shortPath(path, 52);

    _dvBody.appendChild(el('div', { class: 'dv-head' },
        el('span', { class: 'ms', text: fileIcon(path, 'file') }),
        el('span', { class: 'dv-path', text: path, title: path }),
    ));
    _dvBody.appendChild(el('div', { class: 'card dv-nobase' },
        el('div', { class: 'dv-nobase-title' },
            el('span', { class: 'ms', text: 'history_toggle_off' }),
            el('span', { text: t('dv.noBaseline') })),
        el('div', { class: 'hint', text: gitFailed
            ? `本會話還沒有 ${path} 的基準快照，而且 git diff 無法執行（可能不是 git 專案）。`
            : `本會話還沒有 ${path} 的基準快照，git diff 也顯示這個檔案沒有未提交的變更。` }),
        el('div', { class: 'hint', text: recorded
            ? '已把目前的內容記為基準，之後這個檔案的任何變更都會在這裡顯示。'
            : '這個路徑目前不存在（可能已被刪除或還沒建立）。' }),
        el('div', { class: 'dv-nobase-acts' },
            el('button', {
                class: 'btn btn-sm btn-ghost',
                onclick: async () => {
                    dvBusy('執行 git diff…');
                    const rows = await dvGitDiffRows(path);
                    if (rows && rows.length) dvShowRows(path, rows, 'git diff');
                    else { dvNoBaseline(path, rows === null, recorded); toast(t('dv.gitNoOut'), 'info'); }
                },
            }, el('span', { class: 'ms', text: 'terminal' }), el('span', { text: t('dv.rerun') })),
            el('button', {
                class: 'btn btn-sm btn-ghost',
                onclick: () => window.openFile?.(path),
            }, el('span', { class: 'ms', text: 'edit' }), el('span', { text: t('dv.openEd') })),
        ),
    ));
}

// ═══════════════════════════════════════════════════════════════
// git 整合
// ═══════════════════════════════════════════════════════════════

function dvQuote(p) { return '"' + String(p || '').replace(/["`$]/g, '') + '"'; }

// 回傳 rows；[] = 沒有變更；null = git 無法執行
async function dvGitDiffRows(path) {
    const q = dvQuote(path);
    try {
        let r = await EXEC.run(`git diff -- ${q}`, '', 20000);
        let txt = String(r.stdout || '').trim();
        if (!txt) {
            r = await EXEC.run(`git diff --cached -- ${q}`, '', 20000);
            txt = String(r.stdout || '').trim();
        }
        if (!txt) {
            // git 本身有問題（不是 repo、找不到命令）時 exit_code 非 0
            if (r.exit_code !== 0) return null;
            return [];
        }
        return dvParseUnified(txt);
    } catch { return null; }
}

// unified diff → rows（與 diffLines 相同形狀）
function dvParseUnified(text) {
    const rows = [];
    let a = 0, b = 0;
    for (const raw of String(text || '').split(/\r?\n/)) {
        if (raw.startsWith('diff --git') || raw.startsWith('index ') ||
            raw.startsWith('new file') || raw.startsWith('deleted file') ||
            raw.startsWith('old mode') || raw.startsWith('new mode') ||
            raw.startsWith('similarity ') || raw.startsWith('rename ') ||
            raw.startsWith('--- ') || raw.startsWith('+++ ')) continue;
        if (raw.startsWith('\\')) continue;                 // \ No newline at end of file
        if (raw.startsWith('@@')) {
            const m = raw.match(/^@@\s*-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@(.*)$/);
            if (m) { a = parseInt(m[1], 10); b = parseInt(m[2], 10); }
            rows.push({ type: 'gap', text: m && m[3].trim() ? `⋯ ${m[3].trim()}` : '⋯' });
            continue;
        }
        if (raw.startsWith('+')) { rows.push({ type: 'add', text: raw.slice(1), bLine: b++ }); continue; }
        if (raw.startsWith('-')) { rows.push({ type: 'del', text: raw.slice(1), aLine: a++ }); continue; }
        if (raw.startsWith(' ')) { rows.push({ type: 'ctx', text: raw.slice(1), aLine: a++, bLine: b++ }); continue; }
        if (raw === '') continue;
        rows.push({ type: 'ctx', text: raw, aLine: a++, bLine: b++ });
    }
    // 第一列若是 gap 就拿掉，畫面比較乾淨
    if (rows.length && rows[0].type === 'gap' && rows[0].text === '⋯') rows.shift();
    return rows;
}

// git diff --numstat → {path: {add, del}}
async function dvGitNumstat() {
    const parse = (txt) => {
        const out = {};
        for (const line of String(txt || '').split(/\r?\n/)) {
            const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
            if (!m) continue;
            out[m[3].replace(/\\/g, '/')] = {
                add: m[1] === '-' ? null : parseInt(m[1], 10),
                del: m[2] === '-' ? null : parseInt(m[2], 10),
            };
        }
        return out;
    };
    try {
        let r = await EXEC.run('git diff --numstat HEAD', '', 20000);
        if (r.exit_code !== 0) r = await EXEC.run('git diff --numstat', '', 20000);
        if (r.exit_code !== 0) return null;
        return parse(r.stdout);
    } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════
// 本會話變更清單
// ═══════════════════════════════════════════════════════════════

let _dvListing = false;

async function listSessionChanges() {
    if (!ensureDiff()) return;
    if (_dvListing) return;
    _dvListing = true;

    const files = (OC.session?.files_touched || []).slice();
    _dvChanges.innerHTML = '';

    const head = el('div', { class: 'dv-changes-head' },
        el('span', { class: 'ms', text: 'edit_document' }),
        el('span', { class: 'dv-changes-title', text: `本會話變更（${files.length}）` }),
    );
    _dvChanges.appendChild(head);

    if (!files.length) {
        _dvChanges.appendChild(el('div', { class: 'hint', text: t('dv.emptySess') }));
        _dvListing = false;
        return;
    }

    const rowsBox = el('div', { class: 'dv-changes-list' });
    _dvChanges.appendChild(rowsBox);

    // 先畫出來（統計還沒算好時顯示「計算中」），避免等待
    const statCells = {};
    for (const f of files) {
        const cell = el('span', { class: 'diff-stat dv-stat-loading', text: t('dv.loading') });
        statCells[f] = cell;
        rowsBox.appendChild(el('div', { class: 'dv-change' },
            el('span', { class: 'ms', text: fileIcon(f, 'file') }),
            el('span', { class: 'dv-change-path', text: shortPath(f, 54), title: f }),
            cell,
            el('button', {
                class: 'btn btn-xs btn-ghost', title: t('dv.viewOne'),
                onclick: () => showFileDiff(f),
            }, el('span', { class: 'ms', text: 'difference' }), el('span', { text: t('dv.viewShort') })),
        ));
    }

    const numstat = await dvGitNumstat();
    const base = dvBaseMap();
    for (const f of files) {
        const cell = statCells[f];
        if (!cell || !cell.isConnected) continue;
        cell.classList.remove('dv-stat-loading');
        cell.innerHTML = '';

        let st = numstat ? numstat[f] : null;
        // git 沒有涵蓋（未追蹤 / repo 根不同）時，退回本會話基準快照計算
        if (!st && Object.prototype.hasOwnProperty.call(base, f)) {
            try {
                const cur = (await FS.readAll(f)).content || '';
                const d = diffStat(diffLines(base[f], cur));
                st = { add: d.add, del: d.del };
            } catch { st = null; }
        }
        if (st && st.add !== null && st.del !== null) {
            cell.appendChild(el('span', { class: 'diff-stat-add', text: `+${st.add}` }));
            cell.appendChild(el('span', { class: 'diff-stat-del', text: `−${st.del}` }));
        } else if (st) {
            cell.appendChild(el('span', { class: 'dv-stat-unknown', text: t('dv.binary') }));
        } else {
            cell.appendChild(el('span', { class: 'dv-stat-unknown', text: t('dv.unknown') }));
        }
    }
    _dvListing = false;
}

// ═══════════════════════════════════════════════════════════════
// Modal 版（審閱後才套用）
// opts 可以是 onAccept 函式，或 {onAccept, onReject, title, note}
// 有 onAccept 時才會出現「套用／捨棄」，否則只有「關閉」
// ═══════════════════════════════════════════════════════════════

function showDiffModal(path, before, after, opts = {}) {
    const o = typeof opts === 'function' ? { onAccept: opts } : (opts || {});
    return new Promise(resolve => {
        const title = $('modal-generic-title');
        const body = $('modal-generic-body');
        const acts = $('modal-generic-actions');
        if (!title || !body || !acts) {           // modal DOM 不在時退回 dock 顯示
            showDiff(path, before, after, { note: o.note });
            resolve(false);
            return;
        }

        const rows = diffLines(before, after);
        const st = diffStat(rows);
        const box = $1('.modal-box', $('modal-generic'));
        box?.classList.add('modal-diff');

        title.textContent = o.title || t('dv.modalT', { n: baseName(path) });
        body.innerHTML = '';
        body.appendChild(el('div', { class: 'dv-head' },
            el('span', { class: 'ms', text: fileIcon(path, 'file') }),
            el('span', { class: 'dv-path', text: path, title: path }),
            dvStatNode(st),
        ));
        if (o.note) body.appendChild(el('div', { class: 'dv-note hint', text: o.note }));
        body.appendChild(renderDiffRows(rows, { compact: rows.length > 400, maxRows: DIFF_MAX_ROWS }));

        const done = (v) => {
            box?.classList.remove('modal-diff');
            closeModal('modal-generic');
            resolve(v);
        };

        acts.innerHTML = '';
        acts.appendChild(el('button', {
            class: 'btn btn-ghost', text: t('dv.copyDiff'),
            onclick: () => copyText(rows.map(r =>
                (r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' ') + (r.text ?? '')).join('\n')),
        }));
        if (typeof o.onAccept === 'function') {
            acts.appendChild(el('button', {
                class: 'btn btn-danger', text: t('dv.discard'),
                onclick: async () => { try { await o.onReject?.(); } catch (e) { toast(e.message, 'error'); } done(false); },
            }));
            acts.appendChild(el('button', {
                class: 'btn btn-primary', text: t('dv.apply'),
                onclick: async () => {
                    try { await o.onAccept(); done(true); }
                    catch (e) { toast(t('dv.applyFail', { msg: e.message }), 'error'); done(false); }
                },
            }));
        } else {
            acts.appendChild(el('button', { class: 'btn btn-primary', text: t('common.close'), onclick: () => done(false) }));
        }
        openModal('modal-generic');
    });
}

// ═══════════════════════════════════════════════════════════════
// 匯出
// ═══════════════════════════════════════════════════════════════
Object.assign(window, {
    initDiffView, showFileDiff, showDiff, renderDiffRows, showDiffModal, listSessionChanges,
});
