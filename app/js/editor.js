'use strict';
// ═══════════════════════════════════════════════════════════════
// Omni Code — 分頁編輯器（CodeMirror 5）
// ═══════════════════════════════════════════════════════════════
// 全部分頁共用「一個」CodeMirror 實例：切分頁時用 swapDoc 換 Doc，
// 每個檔案的 Doc 掛在 OC.openFiles[i].doc，而 .cm 一律指向共用實例，
// 好讓 agent.js 的 uiSnapshot()（讀 f.cm.getCursor()）對目前分頁仍然正確。
// CodeMirror 不存在時整個降級成 <textarea>，存檔/dirty 行為不變。
// 契約見 ARCHITECTURE.md §10.1 §12.1 §15
// ═══════════════════════════════════════════════════════════════

// ─── 常數 ───────────────────────────────────────────────────────
const _EDIT_IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'ico'];
const _EDIT_MAX_TEXT = 4 * 1024 * 1024;      // 超過就先問過使用者再開
const _EDIT_QO_TTL = 20000;                  // 快速開啟的檔案清單快取秒數
const _EDIT_KEYMAP = [
    ['Ctrl P', '快速開啟檔案'],
    ['Ctrl S', '儲存目前檔案'],
    ['Ctrl F', '在檔案內搜尋'],
    ['Ctrl Shift F', '全專案搜尋'],
    ['Ctrl /', '註解／取消註解'],
    ['Ctrl B', '開關側欄'],
    ['Ctrl Enter', '送出訊息給 AI'],
    ['Shift Tab', '循環權限模式'],
];

/** 快捷鍵說明跟著介面語系走（常數本體留中文保底） */
function _editKeymap() {
    if (typeof t !== 'function') return _EDIT_KEYMAP;
    return [
        ['Ctrl P', t('editor.kQuick')], ['Ctrl S', t('editor.kSave')],
        ['Ctrl F', t('editor.kInFile')], ['Ctrl Shift F', t('editor.kProjSearch')],
        ['Ctrl /', t('editor.kComment')], ['Ctrl B', t('editor.kSidebar')],
        ['Ctrl Enter', t('editor.kSendAI')], ['Shift Tab', t('editor.kPermCycle')],
    ];
}

// ─── 模組狀態 ───────────────────────────────────────────────────
let _edCM = null;            // 共用的 CodeMirror 實例
let _edWrap = null;          // 包住編輯器本體的容器（在 #editor-host 進出）
let _edTA = null;            // 降級模式的 textarea
let _edPlain = false;        // 是否降級（CodeMirror 未載入）
let _edEmptyNode = null;     // 空狀態節點（快取）
let _edGuardOn = false;      // beforeunload 是否已掛上
let _edReloadAsking = {};    // path -> true，避免同一檔重複跳衝突對話框
let _edQoCache = { at: 0, files: [] };
let _edQoIdx = 0;
let _edQoRows = [];

// ═══════════════════════════════════════════════════════════════
// 小工具
// ═══════════════════════════════════════════════════════════════

// 正規化成「工作區相對、POSIX 斜線」的路徑
function _edNorm(p) {
    let s = String(p || '').replace(/\\/g, '/').trim();
    const ws = String(OC.ws || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (ws && s.toLowerCase().startsWith(ws.toLowerCase() + '/')) s = s.slice(ws.length + 1);
    return s.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

function _edFind(path) {
    const p = _edNorm(path);
    return OC.openFiles.find(f => f.path === p) || null;
}

function _edActive() {
    return OC.activeFile ? _edFind(OC.activeFile) : null;
}

// 取得某分頁「目前」的緩衝內容
function _edBufValue(f) {
    if (!f || f.kind !== 'text') return '';
    if (_edPlain) return (OC.activeFile === f.path && _edTA) ? _edTA.value : (f.content || '');
    return f.doc ? f.doc.getValue() : (f.content || '');
}

function _edThemeName() {
    return document.documentElement.dataset.theme === 'light' ? 'oc-light' : 'oc-dark';
}

// 把節點放進 #editor-host（一次只掛一個，避免依賴任何隱藏用的 CSS class）
function _edShowNode(node) {
    const host = $('editor-host');
    if (!host || !node) return;
    if (host.childNodes.length === 1 && host.firstChild === node) return;
    while (host.firstChild) host.removeChild(host.firstChild);
    host.appendChild(node);
}

// ═══════════════════════════════════════════════════════════════
// 編輯器本體
// ═══════════════════════════════════════════════════════════════

function _edEnsureShell() {
    if (_edWrap) return _edWrap;
    _edPlain = (typeof CodeMirror === 'undefined');
    _edWrap = el('div', { class: 'editor-cm' });

    // ── 降級：純 textarea（仍支援 dirty / Ctrl+S）──
    if (_edPlain) {
        _edTA = el('textarea', { class: 'ta editor-plain', spellcheck: 'false', wrap: 'off' });
        _edTA.addEventListener('input', () => {
            const f = _edActive();
            if (f && f.kind === 'text') { f.content = _edTA.value; _edScheduleSync(f); }
        });
        _edTA.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveActiveFile(); }
            if (e.key === 'Tab') {
                e.preventDefault();
                const s = _edTA.selectionStart, t = _edTA.selectionEnd;
                _edTA.setRangeText('    ', s, t, 'end');
                _edTA.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
        _edWrap.appendChild(_edTA);
        return _edWrap;
    }

    const gutters = ['CodeMirror-linenumbers'];
    if (CodeMirror.fold) gutters.push('CodeMirror-foldgutter');

    _edCM = CodeMirror(_edWrap, {
        value: '',
        mode: 'text/plain',
        theme: _edThemeName(),
        lineNumbers: true,
        lineWrapping: false,
        indentUnit: 4,
        tabSize: 4,
        indentWithTabs: false,
        smartIndent: true,
        matchBrackets: true,
        autoCloseBrackets: true,
        styleActiveLine: true,
        foldGutter: !!CodeMirror.fold,
        gutters,
        scrollbarStyle: 'native',
        extraKeys: _edExtraKeys(),
    });
    _edCM.setSize('100%', '100%');

    // 視窗尺寸變動 / 主題切換都要讓 CM 重新量測
    window.addEventListener('resize', debounce(() => _edCM?.refresh(), 120));
    try {
        new MutationObserver(() => _edCM?.setOption('theme', _edThemeName()))
            .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch { /* 舊瀏覽器沒有 MutationObserver 就算了 */ }

    return _edWrap;
}

function _edExtraKeys() {
    const keys = {
        'Ctrl-S': () => { saveActiveFile(); },
        'Cmd-S': () => { saveActiveFile(); },
        'Ctrl-P': () => { quickOpen(); },
        'Cmd-P': () => { quickOpen(); },
        'Alt-F': () => toast(t('editor.noFormatter'), 'info', 4200),
        Tab: (cm) => {
            if (cm.somethingSelected()) cm.indentSelection('add');
            else cm.execCommand('insertSoftTab');
        },
        'Shift-Tab': (cm) => cm.indentSelection('subtract'),
        Esc: (cm) => { cm.execCommand('clearSearch'); cm.getInputField().blur(); },
    };
    const cmds = (typeof CodeMirror !== 'undefined' && CodeMirror.commands) || {};
    if (cmds.find) { keys['Ctrl-F'] = 'find'; keys['Cmd-F'] = 'find'; keys['Ctrl-G'] = 'findNext'; }
    else keys['Ctrl-F'] = () => toast(t('editor.noSearchAddon'), 'warn');
    if (cmds.toggleComment) { keys['Ctrl-/'] = 'toggleComment'; keys['Cmd-/'] = 'toggleComment'; }
    else keys['Ctrl-/'] = () => toast(t('editor.noCommentAddon'), 'warn');
    return keys;
}

// ═══════════════════════════════════════════════════════════════
// 分頁列
// ═══════════════════════════════════════════════════════════════

function renderTabs() {
    const bar = $('tab-bar');
    if (!bar) return;
    bar.innerHTML = '';

    const strip = el('div', { class: 'tab-strip' });
    for (const f of OC.openFiles) {
        const active = f.path === OC.activeFile;
        const tab = el('div', {
            class: 'tab' + (active ? ' active' : '') + (f.dirty ? ' dirty' : ''),
            'data-path': f.path,
            title: f.path + (f.missing ? '（檔案已不存在）' : ''),
            onclick: (e) => { if (!e.target.closest('.tab-x')) _edActivate(f.path); },
            onauxclick: (e) => { if (e.button === 1) { e.preventDefault(); closeFileTab(f.path); } },
            oncontextmenu: (e) => { e.preventDefault(); _edTabMenu(e, f); },
        },
            el('span', { class: 'ms tab-icon', text: f.missing ? 'error' : fileIcon(f.path, 'file') }),
            el('span', { class: 'tab-name', text: baseName(f.path) }),
            f.dirty ? el('span', { class: 'ms tab-dirty', text: 'circle', title: '尚未儲存' }) : null,
            el('button', {
                class: 'tab-x ms', text: 'close', title: '關閉（中鍵亦可）',
                onclick: (e) => { e.stopPropagation(); closeFileTab(f.path); },
            })
        );
        strip.appendChild(tab);
    }
    bar.appendChild(strip);

    const acts = el('div', { class: 'tab-actions' },
        el('button', {
            class: 'btn-icon ms', text: 'search', title: t('editor.openFile'),
            onclick: () => quickOpen(),
        }),
        OC.openFiles.length ? el('button', {
            class: 'btn-icon ms', text: 'save', title: t('editor.saveFile'),
            onclick: () => saveActiveFile(),
        }) : null,
        OC.openFiles.length ? el('button', {
            class: 'btn-icon ms', text: 'close_fullscreen', title: t('editor.closeAll'),
            onclick: () => _edCloseAll(),
        }) : null
    );
    bar.appendChild(acts);

    if (!OC.openFiles.length) _edShowEmpty();
    _edUpdateGuard();
}

function _edTabMenu(e, f) {
    const items = [
        { icon: 'close', label: t('editor.tabClose'), onClick: () => closeFileTab(f.path) },
        { icon: 'close_fullscreen', label: t('editor.tabCloseOthers'), onClick: () => _edCloseOthers(f.path) },
        { icon: 'clear_all', label: t('editor.closeAll'), onClick: () => _edCloseAll() },
        { sep: true },
        { icon: 'content_copy', label: t('editor.copyPath'), onClick: () => copyText(f.path) },
        { icon: 'account_tree', label: t('editor.revealTree'), onClick: () => window.revealInTree?.(f.path) },
        f.kind === 'text' ? { icon: 'save', label: t('common.save'), onClick: () => saveFile(f.path) } : null,
    ].filter(Boolean);
    if (window.ocContextMenu) window.ocContextMenu(e.clientX, e.clientY, items);
}

async function _edCloseAll() {
    for (const f of OC.openFiles.slice()) {
        const ok = await closeFileTab(f.path);
        if (ok === false) break;
    }
}

async function _edCloseOthers(keep) {
    for (const f of OC.openFiles.slice()) {
        if (f.path === keep) continue;
        await closeFileTab(f.path);
    }
}

// ═══════════════════════════════════════════════════════════════
// 開檔 / 切換 / 關檔
// ═══════════════════════════════════════════════════════════════

async function openFile(path, line) {
    const p = _edNorm(path);
    if (!p) { toast(t('editor.noPath'), 'warn'); return null; }

    const already = _edFind(p);
    if (already) {
        _edActivate(p);
        if (line) editorGoToLine(line);
        focusEditor();
        return already;
    }

    let st;
    try {
        st = await FS.stat(p);
    } catch (e) {
        toast(t('editor.openFail', { msg: e.message }), 'error');
        return null;
    }
    if (!st.exists) { toast(t('editor.notExist', { p }), 'error'); return null; }
    if (st.type === 'dir') { window.revealInTree?.(p); return null; }

    const ext = extName(p);

    // ── 圖片：走預覽面板，不進 CodeMirror ──
    if (_EDIT_IMG_EXT.includes(ext)) {
        let dataUrl = '';
        try {
            const r = await FS.readB64(p, 16 * 1024 * 1024);
            dataUrl = `data:${r.mime};base64,${r.data}`;
        } catch (e) { toast(t('editor.imgReadFail', { msg: e.message }), 'error'); return null; }
        const f = _edPushEntry({ path: p, kind: 'image', dataUrl, size: st.size, mtime: st.mtime });
        _edActivate(p);
        return f;
    }

    if (st.size > _EDIT_MAX_TEXT) {
        const go = await confirmModal(t('editor.bigFileT'),
            t('editor.bigFileMsg', { p: esc(p), s: fmtBytes(st.size) }),
            { okText: t('editor.bigFileOk'), danger: true });
        if (!go) return null;
    }

    let r;
    try {
        r = await FS.readAll(p);
    } catch (e) {
        toast(t('editor.readFail', { msg: e.message }), 'error');
        return null;
    }

    // ── 後端判定為二進位：顯示資訊面板 ──
    if (r.binary) {
        const f = _edPushEntry({ path: p, kind: 'binary', size: r.size ?? st.size, mime: r.mime || st.mime, mtime: st.mtime });
        _edActivate(p);
        return f;
    }

    const f = _edPushEntry({ path: p, kind: 'text', content: r.content || '', size: r.size, mtime: r.mtime });
    _edActivate(p);
    if (line) editorGoToLine(line);
    focusEditor();
    return f;
}

// 建立分頁項目（含 CodeMirror Doc）
function _edPushEntry({ path, kind, content = '', dataUrl = '', size = 0, mime = '', mtime = 0 }) {
    _edEnsureShell();
    const mode = cmMode(path);
    const f = {
        path, kind,
        content: kind === 'text' ? content : '',
        original: kind === 'text' ? content : '',
        dirty: false,
        cm: _edPlain ? null : _edCM,       // 共用實例；uiSnapshot() 讀的就是這個
        doc: null,
        mode,
        scroll: { left: 0, top: 0 },
        size, mime, mtime,
        dataUrl,
        missing: false,
    };
    if (kind === 'text' && !_edPlain) {
        f.doc = CodeMirror.Doc(content, mode);
        f.doc.on('change', () => _edScheduleSync(f));
    }
    OC.openFiles.push(f);
    return f;
}

function _edActivate(path) {
    const p = _edNorm(path);
    const f = _edFind(p);
    if (!f) return;

    // 先把目前分頁的捲軸位置存起來
    const cur = _edActive();
    if (cur && cur !== f && cur.kind === 'text' && !_edPlain && _edCM && OC.activeFile === cur.path) {
        const si = _edCM.getScrollInfo();
        cur.scroll = { left: si.left, top: si.top };
    } else if (cur && cur !== f && _edPlain && _edTA) {
        cur.scroll = { left: _edTA.scrollLeft, top: _edTA.scrollTop };
        if (cur.kind === 'text') cur.content = _edTA.value;
    }

    OC.activeFile = p;

    if (f.kind === 'text') {
        _edEnsureShell();
        _edShowNode(_edWrap);
        if (_edPlain) {
            _edTA.value = f.content || '';
            _edTA.scrollTop = f.scroll.top || 0;
            _edTA.scrollLeft = f.scroll.left || 0;
        } else {
            _edCM.swapDoc(f.doc);
            _edCM.setOption('mode', f.mode);
            requestAnimationFrame(() => {
                if (OC.activeFile !== f.path) return;      // 期間又切走了就不要亂捲
                _edCM.refresh();
                _edCM.scrollTo(f.scroll.left || 0, f.scroll.top || 0);
            });
        }
    } else {
        _edShowNode(_edPreviewNode(f));
    }

    renderTabs();
    window.markTreeActive?.(p);
}

async function closeFileTab(path) {
    const p = _edNorm(path);
    const i = OC.openFiles.findIndex(f => f.path === p);
    if (i < 0) return true;
    const f = OC.openFiles[i];

    if (f.dirty && !f.missing) {
        const ok = await confirmModal('尚未儲存',
            `${p} 有尚未儲存的變更，關閉後這些變更就沒了。確定要關閉嗎？`,
            { okText: '關閉並捨棄', cancelText: '取消', danger: true });
        if (!ok) return false;
    }

    // 目前的 Doc 還掛在共用實例上 → 先換一份空的再移除，避免 Doc 仍被綁住
    if (!_edPlain && _edCM && OC.activeFile === p && f.doc) {
        try { _edCM.swapDoc(CodeMirror.Doc('', 'text/plain')); } catch { /* ignore */ }
    }
    clearTimeout(f._syncT);
    OC.openFiles.splice(i, 1);

    if (OC.activeFile === p) {
        const next = OC.openFiles[i] || OC.openFiles[i - 1] || null;
        OC.activeFile = next ? next.path : null;
        if (next) _edActivate(next.path);
        else { _edShowEmpty(); renderTabs(); }
    } else {
        renderTabs();
    }
    _edUpdateGuard();
    return true;
}

// ═══════════════════════════════════════════════════════════════
// 內容同步 / 存檔 / 重新載入
// ═══════════════════════════════════════════════════════════════

function _edScheduleSync(f) {
    clearTimeout(f._syncT);
    f._syncT = setTimeout(() => _edSync(f), 140);
}

function _edSync(f) {
    if (!OC.openFiles.includes(f)) return;
    const v = _edBufValue(f);
    f.content = v;
    const dirty = v !== f.original;
    if (dirty !== f.dirty) {
        f.dirty = dirty;
        renderTabs();
        _edUpdateGuard();
    }
}

async function saveFile(path) {
    const p = _edNorm(path);
    const f = _edFind(p);
    if (!f) { toast(t('editor.notOpen', { p }), 'warn'); return false; }
    if (f.kind !== 'text') { toast(t('editor.notTextSave'), 'warn'); return false; }

    const content = _edBufValue(f);
    try {
        const r = await FS.write(p, content, true);
        f.original = content;
        f.content = content;
        f.dirty = false;
        f.missing = false;
        f.size = r.size;
        f.mtime = r.mtime;
        renderTabs();
        _edUpdateGuard();
        window.invalidateRead?.(p);          // 讓 Agent 知道要重讀
        window.refreshFileTreeSoon?.();
        toast(t('editor.saved', { n: baseName(p), s: fmtBytes(r.size) }), 'success', 2000);
        return true;
    } catch (e) {
        toast(t('editor.saveFail', { msg: e.message }), 'error', 6000);
        return false;
    }
}

function saveActiveFile() {
    if (!OC.activeFile) { toast(t('editor.noActive'), 'warn', 1800); return Promise.resolve(false); }
    return saveFile(OC.activeFile);
}

// 直接寫入編輯器緩衝（不落盤）；檔案沒開就先開起來
async function setEditorContent(path, content) {
    const p = _edNorm(path);
    let f = _edFind(p);
    if (!f) {
        f = await openFile(p);
        if (!f) {
            // 檔案不存在 → 開一個尚未落盤的新緩衝
            _edEnsureShell();
            f = _edPushEntry({ path: p, kind: 'text', content: '' });
            f.original = '\u0000';           // 保證與內容不同 → 一定是 dirty
            f.missing = true;
        }
    }
    if (f.kind !== 'text') { toast(t('editor.notTextSet'), 'warn'); return f; }

    const text = String(content ?? '');
    if (_edPlain) {
        f.content = text;
        if (OC.activeFile === p && _edTA) _edTA.value = text;
    } else {
        f.doc.setValue(text);
    }
    _edSync(f);
    _edActivate(p);
    return f;
}

// tools.js 在 Agent 寫檔後呼叫：乾淨就靜靜重載，髒的就問使用者要留哪一份
async function reloadOpenFile(path) {
    const p = _edNorm(path);
    const f = _edFind(p);
    if (!f) return;

    if (f.kind === 'image') {
        try {
            const r = await FS.readB64(p, 16 * 1024 * 1024);
            f.dataUrl = `data:${r.mime};base64,${r.data}`;
            f.size = r.size;
            if (OC.activeFile === p) _edShowNode(_edPreviewNode(f, true));
        } catch { f.missing = true; renderTabs(); }
        return;
    }
    if (f.kind !== 'text') return;

    let r;
    try {
        r = await FS.readAll(p);
    } catch {
        f.missing = true;                    // 可能被刪掉或改名了
        renderTabs();
        return;
    }
    const disk = r.content || '';
    if (disk === _edBufValue(f)) {            // 內容一樣就只要更新基準
        f.original = disk;
        f.content = disk;
        if (f.dirty) { f.dirty = false; renderTabs(); _edUpdateGuard(); }
        return;
    }

    if (!f.dirty) { _edApplyDisk(f, disk, r); return; }

    if (_edReloadAsking[p]) return;
    _edReloadAsking[p] = true;
    try {
        const takeAi = await confirmModal(t('editor.conflictT'),
            `<div class="cf-msg">${t('editor.conflictMsg', { p: esc(p) })}</div>`,
            { okText: t('editor.loadAi'), cancelText: t('editor.keepMineBtn') });
        if (takeAi) {
            _edApplyDisk(f, disk, r);
            toast(t('editor.aiLoaded'), 'info', 2200);
        } else {
            f.original = disk;               // 保留自己的：改以磁碟版為基準，仍標記 dirty
            f.dirty = true;
            renderTabs();
            toast(t('editor.keepMine'), 'warn', 4200);
        }
    } finally {
        delete _edReloadAsking[p];
    }
}

// 用磁碟內容取代緩衝，盡量維持游標與捲軸
function _edApplyDisk(f, disk, meta) {
    const isActive = OC.activeFile === f.path;
    let cur = null, si = null;
    if (isActive && !_edPlain && _edCM) { cur = _edCM.getCursor(); si = _edCM.getScrollInfo(); }
    if (isActive && _edPlain && _edTA) { si = { left: _edTA.scrollLeft, top: _edTA.scrollTop }; }

    if (_edPlain) {
        f.content = disk;
        if (isActive && _edTA) _edTA.value = disk;
    } else {
        f.doc.setValue(disk);
    }
    f.original = disk;
    f.content = disk;
    f.dirty = false;
    f.missing = false;
    if (meta) { f.size = meta.size; f.mtime = meta.mtime; }

    if (isActive && !_edPlain && _edCM) {
        const last = _edCM.lastLine();
        if (cur) _edCM.setCursor({ line: Math.min(cur.line, last), ch: cur.ch });
        if (si) _edCM.scrollTo(si.left, si.top);
    } else if (isActive && _edPlain && _edTA && si) {
        _edTA.scrollTop = si.top; _edTA.scrollLeft = si.left;
    }
    renderTabs();
    _edUpdateGuard();
}

function getActiveFile() { return _edActive(); }

function focusEditor() {
    const f = _edActive();
    if (!f || f.kind !== 'text') return;
    if (_edPlain) _edTA?.focus();
    else setTimeout(() => _edCM?.focus(), 0);
}

function editorGoToLine(line) {
    const f = _edActive();
    if (!f || f.kind !== 'text') return;
    const n = Math.max(1, parseInt(line, 10) || 1);

    if (_edPlain) {
        if (!_edTA) return;
        const lines = (_edTA.value || '').split('\n');
        let off = 0;
        for (let i = 0; i < Math.min(n - 1, lines.length); i++) off += lines[i].length + 1;
        _edTA.focus();
        _edTA.setSelectionRange(off, off + (lines[n - 1] || '').length);
        return;
    }
    if (!_edCM) return;
    const l = Math.min(_edCM.lastLine(), n - 1);
    _edCM.setCursor({ line: l, ch: 0 });
    const h = _edCM.getScrollInfo().clientHeight;
    const top = _edCM.charCoords({ line: l, ch: 0 }, 'local').top;
    const target = Math.max(0, top - h / 2 + 20);
    _edCM.scrollTo(null, target);
    // 同步寫回 scroll，否則 _edActivate 排在下一幀的捲軸還原會把這裡的跳行蓋掉
    f.scroll = { left: f.scroll?.left || 0, top: target };
    try {
        _edCM.addLineClass(l, 'background', 'cm-goto-flash');
        setTimeout(() => { try { _edCM.removeLineClass(l, 'background', 'cm-goto-flash'); } catch {} }, 1400);
    } catch { /* 行號可能已不存在 */ }
    _edCM.focus();
}

// ═══════════════════════════════════════════════════════════════
// 空狀態 / 圖片・二進位預覽
// ═══════════════════════════════════════════════════════════════

function _edShowEmpty() {
    if (!_edEmptyNode) {
        // 空狀態快取：語系切換時清掉重建（見 paintEditorEmpty）
        const keys = el('div', { class: 'editor-empty-keys' });
        for (const [k, desc] of _editKeymap()) {
            keys.appendChild(el('div', { class: 'editor-key-row' },
                el('span', { class: 'editor-key-combo' }, ...k.split(' ').map(x => el('kbd', { text: x }))),
                el('span', { class: 'editor-key-desc', text: desc })
            ));
        }
        _edEmptyNode = el('div', { class: 'editor-empty' },
            el('span', { class: 'ms editor-empty-icon', text: 'code_blocks' }),
            el('div', { class: 'editor-empty-title', text: 'Omni Code' }),
            el('div', { class: 'editor-empty-sub', text: t('editor.emptySub2') }),
            el('button', {
                class: 'btn btn-primary', onclick: () => quickOpen(),
            }, el('span', { class: 'ms', text: 'search' }), el('span', { text: t('editor.kQuick') })),
            keys
        );
    }
    _edShowNode(_edEmptyNode);
}

/** 語系切換時清掉空狀態快取，下次顯示用新語系重建 */
function paintEditorEmpty() { _edEmptyNode = null; if (!OC.openFiles.length) _edShowEmpty(); }

function _edPreviewNode(f, rebuild) {
    if (f._node && !rebuild) return f._node;
    const dl = el('a', {
        class: 'btn btn-ghost', href: FS.downloadUrl(f.path), download: baseName(f.path),
    }, el('span', { class: 'ms', text: 'download' }), el('span', { text: '下載' }));

    const meta = el('div', { class: 'bin-meta' },
        el('span', { class: 'chip', text: fmtBytes(f.size || 0) }),
        f.mime ? el('span', { class: 'chip', text: f.mime }) : null,
        f.mtime ? el('span', { class: 'chip', text: fmtTime(f.mtime < 1e12 ? f.mtime * 1000 : f.mtime) }) : null
    );

    let body;
    if (f.kind === 'image') {
        const img = el('img', { class: 'bin-img', src: f.dataUrl, alt: baseName(f.path) });
        const dim = el('span', { class: 'chip', text: '—' });
        meta.insertBefore(dim, meta.firstChild);
        imageSize(f.dataUrl).then(d => { dim.textContent = `${d.width} × ${d.height}`; }).catch(() => {});
        body = el('div', { class: 'bin-img-wrap' }, img);
    } else {
        body = el('div', { class: 'bin-icon' }, el('span', { class: 'ms', text: fileIcon(f.path, 'file') }));
    }

    f._node = el('div', { class: 'editor-bin' },
        el('div', { class: 'bin-head' },
            el('span', { class: 'ms', text: f.kind === 'image' ? 'image' : 'draft' }),
            el('span', { class: 'bin-name', text: f.path })
        ),
        body,
        meta,
        el('div', { class: 'bin-actions' },
            dl,
            el('button', {
                class: 'btn btn-ghost',
                onclick: () => window.open(FS.downloadUrl(f.path), '_blank', 'noopener'),
            }, el('span', { class: 'ms', text: 'open_in_new' }), el('span', { text: '新分頁開啟' })),
            f.kind !== 'image' ? el('button', {
                class: 'btn btn-ghost', onclick: () => _edForceText(f.path),
            }, el('span', { class: 'ms', text: 'text_snippet' }), el('span', { text: '強制以文字開啟' })) : null,
            el('button', {
                class: 'btn btn-ghost', onclick: () => copyText(f.path),
            }, el('span', { class: 'ms', text: 'content_copy' }), el('span', { text: '複製路徑' }))
        )
    );
    return f._node;
}

// 二進位檔強制以純文字開啟（偵錯用）
async function _edForceText(path) {
    const p = _edNorm(path);
    const f = _edFind(p);
    if (!f) return;
    let r;
    try { r = await FS.read(p, 0, 3000); }
    catch (e) { toast(t('editor.readFail', { msg: e.message }), 'error'); return; }
    const i = OC.openFiles.indexOf(f);
    OC.openFiles.splice(i, 1);
    const nf = _edPushEntry({ path: p, kind: 'text', content: r.content || '', size: r.size, mtime: r.mtime });
    // 位置保持原本的分頁順序
    OC.openFiles.splice(OC.openFiles.length - 1, 1);
    OC.openFiles.splice(i, 0, nf);
    _edActivate(p);
}

// ═══════════════════════════════════════════════════════════════
// 離開頁面守門
// ═══════════════════════════════════════════════════════════════

function _edGuardHandler(e) {
    const n = OC.openFiles.filter(f => f.dirty).length;
    if (!n) return;
    e.preventDefault();
    e.returnValue = `還有 ${n} 個檔案沒有儲存`;
    return e.returnValue;
}

function _edUpdateGuard() {
    const dirty = OC.openFiles.some(f => f.dirty);
    if (dirty && !_edGuardOn) { window.addEventListener('beforeunload', _edGuardHandler); _edGuardOn = true; }
    else if (!dirty && _edGuardOn) { window.removeEventListener('beforeunload', _edGuardHandler); _edGuardOn = false; }
}

// ═══════════════════════════════════════════════════════════════
// 快速開啟（Ctrl+P 模糊搜尋）
// ═══════════════════════════════════════════════════════════════

function _edQoBuild() {
    let box = $('modal-quickopen');
    if (box) return box;
    box = el('div', { class: 'modal-overlay', id: 'modal-quickopen' },
        el('div', { class: 'modal-box qo-box', onclick: (e) => e.stopPropagation() },
            el('div', { class: 'qo-head' },
                el('span', { class: 'ms', text: 'search' }),
                el('input', {
                    id: 'qo-input', class: 'inp qo-input', type: 'text', autocomplete: 'off', spellcheck: 'false',
                    placeholder: '輸入檔名片段…（↑↓ 選擇、Enter 開啟、Esc 關閉）',
                })
            ),
            el('div', { class: 'qo-list', id: 'qo-list' }),
            el('div', { class: 'qo-foot' },
                el('span', { id: 'qo-count', class: 'hint', text: '' }),
                el('span', { class: 'hint', text: '模糊比對：輸入 ajs 也找得到 agent.js' })
            )
        )
    );
    box.addEventListener('click', () => closeModal('modal-quickopen'));
    document.body.appendChild(box);

    const inp = $('qo-input');
    inp.addEventListener('input', () => _edQoRender(inp.value));
    inp.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); _edQoMove(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); _edQoMove(-1); }
        else if (e.key === 'Enter') { e.preventDefault(); _edQoPick(); }
        else if (e.key === 'Escape') { e.preventDefault(); closeModal('modal-quickopen'); }
    });
    return box;
}

async function quickOpen() {
    const box = _edQoBuild();
    if (box.classList.contains('active')) return;       // 已開著就不重複開
    openModal('modal-quickopen');
    const inp = $('qo-input');
    inp.value = '';
    _edQoRender('');
    setTimeout(() => { inp.focus(); inp.select(); }, 40);

    if (Date.now() - _edQoCache.at > _EDIT_QO_TTL) {
        $('qo-count').textContent = '掃描檔案中…';
        try {
            const r = await FS.glob('**/*', '', 4000);
            _edQoCache = { at: Date.now(), files: (r.files || []).filter(Boolean) };
        } catch (e) {
            _edQoCache = { at: 0, files: [] };
            $('qo-count').textContent = `檔案清單載入失敗：${e.message}`;
            return;
        }
        if ($('modal-quickopen')?.classList.contains('active')) _edQoRender($('qo-input').value);
    }
}

// 子序列模糊比對；回傳 {score, pos[]}，不符合回 null
function _edFuzzy(q, s) {
    const ls = s.toLowerCase();
    let from = 0, score = 0, prev = -2;
    const pos = [];
    for (let i = 0; i < q.length; i++) {
        const idx = ls.indexOf(q[i], from);
        if (idx === -1) return null;
        pos.push(idx);
        if (idx === prev + 1) score += 12;
        else score += Math.max(0, 6 - (idx - from));
        if (idx === 0 || '/-_. '.includes(ls[idx - 1])) score += 8;
        prev = idx;
        from = idx + 1;
    }
    return { score, pos };
}

function _edQoRender(query) {
    const list = $('qo-list');
    const cnt = $('qo-count');
    if (!list) return;
    const q = String(query || '').toLowerCase().replace(/\s+/g, '');
    const opened = OC.openFiles.map(f => f.path);
    const pool = _edQoCache.files.length ? _edQoCache.files : opened;

    let rows;
    if (!q) {
        const recent = opened.slice().reverse();
        const rest = pool.filter(p => !opened.includes(p));
        rows = [...recent, ...rest].slice(0, 40).map(p => ({ path: p, pos: [] }));
    } else {
        const scored = [];
        for (const p of pool) {
            const m = _edFuzzy(q, p);
            if (!m) continue;
            const baseStart = p.length - baseName(p).length;
            let sc = m.score - p.length * 0.04;
            if (m.pos[0] >= baseStart) sc += 40;               // 全部命中在檔名裡
            if (opened.includes(p)) sc += 6;
            scored.push({ path: p, pos: m.pos, score: sc });
        }
        scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
        rows = scored.slice(0, 40);
    }

    _edQoRows = rows;
    _edQoIdx = 0;
    list.innerHTML = '';
    if (!rows.length) {
        list.appendChild(el('div', { class: 'qo-none', text: q ? `找不到符合「${query}」的檔案` : '工作區裡沒有檔案' }));
        if (cnt) cnt.textContent = '';
        return;
    }
    rows.forEach((r, i) => {
        const set = new Set(r.pos);
        const bs = r.path.length - baseName(r.path).length;
        const dirHtml = _edMarkHtml(r.path, set, 0, bs);
        const nameHtml = _edMarkHtml(r.path, set, bs, r.path.length);
        const row = el('div', {
            class: 'qo-item' + (i === 0 ? ' sel' : ''), 'data-i': i,
            onclick: () => { _edQoIdx = i; _edQoPick(); },
            onmousemove: () => { if (_edQoIdx !== i) { _edQoIdx = i; _edQoPaint(); } },
        },
            el('span', { class: 'ms qo-icon', text: fileIcon(r.path, 'file') }),
            el('span', { class: 'qo-name', html: nameHtml }),
            el('span', { class: 'qo-dir', html: dirHtml })
        );
        list.appendChild(row);
    });
    if (cnt) cnt.textContent = `${rows.length} 個結果${_edQoCache.files.length ? `／共 ${_edQoCache.files.length} 個檔案` : ''}`;
}

// 依命中位置把字串包成 <b>，逐字 esc（絕不注入未跳脫內容）
function _edMarkHtml(str, posSet, from, to) {
    let html = '', open = false;
    for (let i = from; i < to; i++) {
        const hit = posSet.has(i);
        if (hit && !open) { html += '<b class="qo-hit">'; open = true; }
        else if (!hit && open) { html += '</b>'; open = false; }
        html += esc(str[i]);
    }
    if (open) html += '</b>';
    return html;
}

function _edQoPaint() {
    $$('#qo-list .qo-item').forEach((n, i) => n.classList.toggle('sel', i === _edQoIdx));
    $$('#qo-list .qo-item')[_edQoIdx]?.scrollIntoView({ block: 'nearest' });
}

function _edQoMove(d) {
    if (!_edQoRows.length) return;
    _edQoIdx = (_edQoIdx + d + _edQoRows.length) % _edQoRows.length;
    _edQoPaint();
}

function _edQoPick() {
    const r = _edQoRows[_edQoIdx];
    if (!r) return;
    closeModal('modal-quickopen');
    openFile(r.path);
}

// ═══════════════════════════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════════════════════════

function initEditor() {
    _edEnsureShell();
    if (!OC.openFiles.length) _edShowEmpty();
    renderTabs();

    // Ctrl+P / Ctrl+S：CodeMirror 內部已處理過的按鍵會帶 defaultPrevented，直接放行避免重複觸發；
    // app.js 若也綁了 Ctrl+P，quickOpen() 本身有「已開啟就跳過」的保護。
    document.addEventListener('keydown', (e) => {
        if (e.defaultPrevented) return;
        if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
        const k = e.key.toLowerCase();
        if (k === 'p' && !e.shiftKey) { e.preventDefault(); quickOpen(); }
        else if (k === 's' && !e.shiftKey && OC.activeFile) { e.preventDefault(); saveActiveFile(); }
    });

    if (_edPlain) {
        console.warn('[Omni Code] CodeMirror 未載入，編輯器降級為純文字模式');
    }
}

Object.assign(window, {
    initEditor, openFile, closeFileTab, saveFile, saveActiveFile,
    setEditorContent, reloadOpenFile, getActiveFile, renderTabs,
    focusEditor, quickOpen, editorGoToLine,
});
