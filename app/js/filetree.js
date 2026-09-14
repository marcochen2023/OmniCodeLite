'use strict';
// ═══════════════════════════════════════════════════════════════
// Omni Code — 檔案樹（#panel-files）與全專案搜尋（#panel-search）
// ═══════════════════════════════════════════════════════════════
// 樹是「用到才載入」：只有展開過的目錄才會去打 FS.list，結果快取在
// OC.tree[path]；收合時保留快取。展開狀態依工作區存 localStorage。
// 右鍵選單是自己畫的絕對定位 .ctx-menu（同時給 editor.js 的分頁用）。
// 契約見 ARCHITECTURE.md §3 §15
// ═══════════════════════════════════════════════════════════════

// ─── 模組狀態 ───────────────────────────────────────────────────
let _ftOpen = new Set();          // 展開中的目錄路徑
let _ftOpenKey = '';              // 目前 localStorage 的 key（依工作區）
let _ftLoading = new Set();       // 正在載入子項目的目錄
let _ftBusy = false;              // refreshFileTree 進行中
let _ftAgain = false;             // 進行中又被要求刷新 → 結束後補跑一次
let _ftCtx = null;                // 目前的右鍵選單節點
let _ftUploadInput = null;

// 搜尋面板狀態
let _ftQ = '';
let _ftGlobPat = '';
let _ftCase = false;              // Aa
let _ftRegex = false;             // .*
let _ftHits = [];                 // [{file,line,text}]
let _ftTruncated = false;
let _ftTimedOut = false;
let _ftScanned = 0;
let _ftHint = '';
let _ftCollapsed = new Set();     // 收合的檔案群組
let _ftSearchErr = '';
let _ftSearchToken = 0;
let _ftSearching = false;

// ═══════════════════════════════════════════════════════════════
// 展開狀態持久化
// ═══════════════════════════════════════════════════════════════

function _ftHashWs() {
    const s = String(OC.ws || OC.cfg.workspace || '');
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
}

// 工作區換掉時重新載入展開集合並清空快取
function _ftSyncOpenSet() {
    const key = 'oc_tree_open_' + _ftHashWs();
    if (key === _ftOpenKey) return;
    _ftOpenKey = key;
    _ftOpen = new Set();
    OC.tree = {};
    try {
        const raw = localStorage.getItem(key);
        if (raw) _ftOpen = new Set(JSON.parse(raw) || []);
    } catch { /* 壞掉就當作全部收合 */ }
}

function _ftSaveOpenSet() {
    if (!_ftOpenKey) return;
    try { localStorage.setItem(_ftOpenKey, JSON.stringify(Array.from(_ftOpen).slice(0, 400))); } catch {}
}

// ═══════════════════════════════════════════════════════════════
// 路徑小工具
// ═══════════════════════════════════════════════════════════════

function _ftNorm(p) {
    return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
}
function _ftSel(p) { return String(p).replace(/["\\]/g, '\\$&'); }   // 供 [data-path="…"] 用
function _ftRow(path) { return $1(`#file-tree .tree-row[data-path="${_ftSel(path)}"]`); }

// ═══════════════════════════════════════════════════════════════
// 面板骨架（不覆蓋 index.html 既有內容，缺什麼補什麼）
// ═══════════════════════════════════════════════════════════════

function _ftEnsureFilesShell() {
    const panel = $('panel-files');
    if (!panel) return null;

    let head = $1('.panel-head', panel);
    if (!head) {
        head = el('div', { class: 'panel-head' });
        panel.insertBefore(head, panel.firstChild);
    }
    if (!$1('.panel-title', head) && !head.textContent.trim()) {
        head.appendChild(el('span', { class: 'panel-title', text: t('ft.files') }));
    }
    // index.html 已經有 #ft-refresh / #ft-new-file / #ft-new-dir / #ft-collapse，
    // 直接接上它們即可；再注入一組會變成兩排一模一樣的按鈕，而且原本那組沒有作用。
    const wire = (id, fn) => {
        const b = $(id);
        if (b && !b.dataset.ftWired) { b.dataset.ftWired = '1'; b.addEventListener('click', fn); }
    };
    wire('ft-refresh',  () => refreshFileTree());
    wire('ft-new-file', () => _ftNewFile(''));
    wire('ft-new-dir',  () => _ftNewDir(''));
    wire('ft-collapse', () => _ftCollapseAll());
    if (!$1('.ft-tools', head) && !$('ft-refresh')) {
        head.appendChild(el('div', { class: 'ft-tools' },
            el('button', { class: 'btn-icon ms', text: 'refresh', title: t('ft.refresh'), onclick: () => refreshFileTree() }),
            el('button', { class: 'btn-icon ms', text: 'note_add', title: t('ft.newFile'), onclick: () => _ftNewFile('') }),
            el('button', { class: 'btn-icon ms', text: 'unfold_less', title: t('ft.collapseAll'), onclick: () => _ftCollapseAll() }),
            el('button', { class: 'btn-icon ms', text: 'upload', title: t('ft.uploadRoot'), onclick: () => _ftPickUpload('') })
        ));
    }

    let tree = $('file-tree');
    if (!tree) {
        tree = el('div', { id: 'file-tree', class: 'file-tree' });
        panel.appendChild(tree);
    }
    return tree;
}

function _ftEnsureSearchShell() {
    const panel = $('panel-search');
    if (!panel) return null;
    if ($('search-q')) return $('search-results');

    let head = $1('.panel-head', panel);
    if (!head) {
        head = el('div', { class: 'panel-head' });
        panel.insertBefore(head, panel.firstChild);
    }
    if (!head.textContent.trim()) head.appendChild(el('span', { class: 'panel-title', text: t('panel.search') }));

    const onInput = debounce(() => _ftReadOpts(true), 350);

    const box = el('div', { class: 'search-box' },
        el('div', { class: 'search-row' },
            el('span', { class: 'ms', text: 'search' }),
            el('input', {
                id: 'search-q', class: 'inp', type: 'text', autocomplete: 'off', spellcheck: 'false',
                placeholder: t('ft.searchPh'),
                oninput: onInput,
                onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); _ftReadOpts(true); } },
            })
        ),
        el('div', { class: 'search-opts' },
            el('button', {
                id: 'search-opt-case', class: 'btn btn-xs btn-ghost', text: 'Aa', title: t('ft.caseT'),
                onclick: () => { _ftCase = !_ftCase; _ftPaintOpts(); _ftReadOpts(true); },
            }),
            el('button', {
                id: 'search-opt-regex', class: 'btn btn-xs btn-ghost', text: '.*', title: t('ft.regexT'),
                onclick: () => { _ftRegex = !_ftRegex; _ftPaintOpts(); _ftReadOpts(true); },
            }),
            el('input', {
                id: 'search-glob', class: 'inp', type: 'text', autocomplete: 'off', spellcheck: 'false',
                placeholder: t('ft.globPh'),
                oninput: onInput,
                onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); _ftReadOpts(true); } },
            })
        ),
        el('div', { id: 'search-summary', class: 'search-summary' })
    );

    const results = el('div', { id: 'search-results', class: 'search-results' });
    // 必須放進 .panel-body（#search-body）——它才是有 overflow-y:auto 的捲動容器。
    // 直接掛在 panel 上會讓結果超出面板高度後被裁掉且捲不到。
    const host = $('search-body') || panel;
    host.appendChild(box);
    host.appendChild(results);
    _ftPaintOpts();
    _ftRenderResults();
    return results;
}

// ═══════════════════════════════════════════════════════════════
// 樹：載入與渲染
// ═══════════════════════════════════════════════════════════════

async function _ftLoadDir(path, force = false) {
    const p = _ftNorm(path);
    if (!force && OC.tree[p]) return OC.tree[p];
    const r = await FS.list(p, false);
    OC.tree[p] = r.entries || [];
    return OC.tree[p];
}

function renderTree() {
    const host = $('file-tree');
    if (!host) return;
    const rows = [];
    _ftBuildRows('', 0, rows);

    host.innerHTML = '';
    if (!OC.tree['']) {
        host.appendChild(el('div', { class: 'tree-hint' },
            el('span', { class: 'spinner' }), el('span', { text: t('ft.loading') })));
        return;
    }
    if (!rows.length) {
        host.appendChild(el('div', { class: 'tree-hint', text: t('ft.emptyWs') }));
        return;
    }
    const frag = document.createDocumentFragment();
    rows.forEach(n => frag.appendChild(n));
    host.appendChild(frag);
}

function _ftBuildRows(path, depth, out) {
    const entries = OC.tree[path];
    if (!entries) return;
    for (const e of entries) {
        out.push(_ftMakeRow(e, depth));
        if (e.type === 'dir' && _ftOpen.has(e.path)) _ftBuildRows(e.path, depth + 1, out);
    }
}

function _ftMakeRow(e, depth) {
    const isDir = e.type === 'dir';
    const open = isDir && _ftOpen.has(e.path);
    const loading = _ftLoading.has(e.path);
    const active = !isDir && OC.activeFile === e.path;

    const caret = isDir
        ? el('span', { class: 'ms tree-caret', text: loading ? 'progress_activity' : (open ? 'expand_more' : 'chevron_right') })
        : el('span', { class: 'tree-caret tree-caret-sp' });

    return el('div', {
        class: 'tree-row' + (isDir ? ' is-dir' : ' is-file') + (active ? ' active' : '') + (open ? ' open' : ''),
        'data-path': e.path,
        'data-type': e.type,
        title: e.path + (isDir ? '' : `　${fmtBytes(e.size)}`),
        style: { paddingLeft: (depth * 12 + 6) + 'px' },
        onclick: () => (isDir ? _ftToggleDir(e.path) : window.openFile?.(e.path)),
        oncontextmenu: (ev) => { ev.preventDefault(); _ftRowMenu(ev, e); },
    },
        caret,
        el('span', { class: 'ms tree-icon', text: fileIcon(e.path, e.type) }),
        el('span', { class: 'tree-name', text: e.name }),
        !isDir && e.binary ? el('span', { class: 'tree-tag', text: 'bin' }) : null
    );
}

async function _ftToggleDir(path) {
    const p = _ftNorm(path);
    if (_ftOpen.has(p)) {
        _ftOpen.delete(p);                 // 收合保留快取，下次展開不用再打後端
        _ftSaveOpenSet();
        renderTree();
        return;
    }
    _ftOpen.add(p);
    _ftSaveOpenSet();
    if (!OC.tree[p]) {
        _ftLoading.add(p);
        renderTree();
        try { await _ftLoadDir(p); }
        catch (e) {
            _ftOpen.delete(p);
            toast(t('ft.readFail', { p, msg: e.message }), 'error');
        }
        finally { _ftLoading.delete(p); }
    }
    renderTree();
}

function _ftCollapseAll() {
    _ftOpen.clear();
    _ftSaveOpenSet();
    renderTree();
}

// 標記目前編輯中的檔案（editor.js 切分頁時呼叫）
function markTreeActive(path) {
    const p = _ftNorm(path);
    $$('#file-tree .tree-row.active').forEach(n => n.classList.remove('active'));
    _ftRow(p)?.classList.add('active');
}

async function refreshFileTree() {
    _ftSyncOpenSet();
    if (_ftBusy) { _ftAgain = true; return; }      // 進行中就排一次補跑，避免漏掉最新狀態
    _ftBusy = true;
    _ftAgain = false;
    try {
        const dirs = ['', ...Array.from(_ftOpen)];
        await Promise.all(dirs.map(async d => {
            try { await _ftLoadDir(d, true); }
            catch { if (d) { _ftOpen.delete(d); delete OC.tree[d]; } }
        }));
        _ftSaveOpenSet();
        renderTree();
    } catch (e) {
        const host = $('file-tree');
        if (host) {
            host.innerHTML = '';
            host.appendChild(el('div', { class: 'tree-hint', text: `檔案樹載入失敗：${e.message}` }));
        }
    } finally {
        _ftBusy = false;
        if (_ftAgain) { _ftAgain = false; setTimeout(() => refreshFileTree(), 60); }
    }
}

const refreshFileTreeSoon = debounce(() => refreshFileTree(), 400);

// 展開所有上層目錄並捲到該列
async function revealInTree(path) {
    const p = _ftNorm(path);
    if (!p) return;
    _ftSyncOpenSet();
    const parts = p.split('/');
    const isDir = OC.tree[p] !== undefined || (OC.tree[dirName(p)] || []).some(e => e.path === p && e.type === 'dir');
    if (!isDir) parts.pop();
    let cur = '';
    for (const seg of parts) {
        cur = cur ? cur + '/' + seg : seg;
        _ftOpen.add(cur);
        try { await _ftLoadDir(cur); } catch { break; }
    }
    _ftSaveOpenSet();
    if (!OC.tree['']) { try { await _ftLoadDir(''); } catch {} }
    renderTree();
    const row = _ftRow(p);
    if (row) {
        row.scrollIntoView({ block: 'nearest' });
        row.classList.add('flash');
        setTimeout(() => row.classList.remove('flash'), 1200);
    }
    window.switchPanel?.('files');
}

// ═══════════════════════════════════════════════════════════════
// 右鍵選單（editor.js 的分頁也共用這支）
// ═══════════════════════════════════════════════════════════════

let _ftCtxCleanup = null;
function _ftCloseCtx() {
    _ftCtx?.remove();
    _ftCtx = null;
    if (_ftCtxCleanup) { _ftCtxCleanup(); _ftCtxCleanup = null; }
}

function ocContextMenu(x, y, items) {
    _ftCloseCtx();
    // 位置是動態計算的，只有定位相關屬性走 inline style
    const menu = el('div', {
        class: 'ctx-menu',
        style: { position: 'fixed', left: x + 'px', top: y + 'px', zIndex: '9000' },
    });
    for (const it of (items || [])) {
        if (!it) continue;
        if (it.sep) { menu.appendChild(el('div', { class: 'ctx-sep' })); continue; }
        menu.appendChild(el('button', {
            class: 'ctx-item' + (it.danger ? ' ctx-danger' : ''),
            onclick: (e) => { e.stopPropagation(); _ftCloseCtx(); it.onClick?.(); },
        },
            el('span', { class: 'ms', text: it.icon || 'chevron_right' }),
            el('span', { class: 'ctx-label', text: it.label })
        ));
    }
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth - 8) menu.style.left = Math.max(8, window.innerWidth - r.width - 8) + 'px';
    if (r.bottom > window.innerHeight - 8) menu.style.top = Math.max(8, window.innerHeight - r.height - 8) + 'px';
    _ftCtx = menu;
    // 不能用 {once:true} + 同一個具名函式：三個事件註冊的是同一個參考，
    // 任一個先觸發就把其餘兩個一起消耗掉，之後選單就再也關不掉。
    // 改成每次開選單建立獨立的 closure，並在關閉時明確移除。
    const close = () => _ftCloseCtx();
    _ftCtxCleanup = () => {
        document.removeEventListener('click', close, true);
        document.removeEventListener('contextmenu', close, true);
        window.removeEventListener('resize', close);
        window.removeEventListener('blur', close);
    };
    setTimeout(() => {
        document.addEventListener('click', close, true);
        document.addEventListener('contextmenu', close, true);
        window.addEventListener('resize', close);
        window.addEventListener('blur', close);
    }, 0);
    return menu;
}

function _ftRowMenu(ev, e) {
    const isDir = e.type === 'dir';
    const parent = isDir ? e.path : dirName(e.path);
    ocContextMenu(ev.clientX, ev.clientY, [
        { icon: 'note_add', label: '新增檔案', onClick: () => _ftNewFile(parent) },
        { icon: 'create_new_folder', label: '新增資料夾', onClick: () => _ftNewDir(parent) },
        { sep: true },
        !isDir ? { icon: 'edit_document', label: '在編輯器開啟', onClick: () => window.openFile?.(e.path) } : null,
        { icon: 'drive_file_rename_outline', label: '重新命名', onClick: () => _ftRename(e) },
        { icon: 'content_copy', label: '複製路徑', onClick: () => copyText(e.path) },
        { icon: 'delete', label: '刪除', danger: true, onClick: () => _ftDelete(e) },
        { sep: true },
        { icon: 'auto_awesome', label: '用 AI 說明這個檔案', onClick: () => _ftAskAi(e.path) },
    ].filter(Boolean));
}

// ═══════════════════════════════════════════════════════════════
// 檔案操作
// ═══════════════════════════════════════════════════════════════

async function _ftNewFile(dir) {
    const base = _ftNorm(dir);
    const name = await promptModal(t('ft.newFileT'), t('ft.newFileLab'), '', {
        placeholder: 'example.js',
        hint: base ? `會建立在 ${base}/ 底下` : '會建立在工作區根目錄',
    });
    if (!name) return;
    const path = base ? `${base}/${_ftNorm(name)}` : _ftNorm(name);
    try {
        const st = await FS.stat(path);
        if (st.exists) { toast(t('ft.exists', { p: path }), 'warn'); await revealInTree(path); return; }
    } catch { /* stat 失敗就當作不存在 */ }
    try {
        await FS.write(path, '', true);
        toast(t('ft.created', { p: path }), 'success', 2000);
        await refreshFileTree();
        await revealInTree(path);
        window.openFile?.(path);
    } catch (e) { toast(t('ft.createFail', { msg: e.message }), 'error', 6000); }
}

async function _ftNewDir(dir) {
    const base = _ftNorm(dir);
    const name = await promptModal(t('ft.newDirT'), t('ft.newDirLab'), '', {
        placeholder: 'components',
        hint: base ? `會建立在 ${base}/ 底下` : '會建立在工作區根目錄',
    });
    if (!name) return;
    const path = base ? `${base}/${_ftNorm(name)}` : _ftNorm(name);
    try {
        await FS.mkdir(path);
        toast(t('ft.createdDir', { p: path }), 'success', 2000);
        delete OC.tree[base];
        await refreshFileTree();
        await revealInTree(path);
    } catch (e) { toast(t('ft.createFail', { msg: e.message }), 'error', 6000); }
}

async function _ftRename(entry) {
    const oldPath = entry.path;
    const dir = dirName(oldPath);
    const name = await promptModal(t('ft.renameT'), t('ft.renameLab'), baseName(oldPath), {
        hint: `位於 ${dir || '工作區根目錄'}`,
    });
    if (!name || name === baseName(oldPath)) return;
    const newPath = dir ? `${dir}/${_ftNorm(name)}` : _ftNorm(name);
    try {
        await FS.move(oldPath, newPath, false);
        const wasOpen = (OC.openFiles || []).some(f => f.path === oldPath);
        if (wasOpen) await window.closeFileTab?.(oldPath);
        delete OC.tree[oldPath];
        delete OC.tree[dir];
        if (_ftOpen.has(oldPath)) { _ftOpen.delete(oldPath); _ftOpen.add(newPath); _ftSaveOpenSet(); }
        toast(t('ft.renamed', { n: baseName(newPath) }), 'success', 2200);
        await refreshFileTree();
        if (wasOpen && entry.type !== 'dir') window.openFile?.(newPath);
    } catch (e) { toast(t('ft.renameFail', { msg: e.message }), 'error', 6000); }
}

async function _ftDelete(entry) {
    const isDir = entry.type === 'dir';
    const ok = await confirmModal(t('ft.delT'),
        `<div class="cf-msg">${isDir ? t('ft.delDirB', { p: esc(entry.path) }) : t('ft.delFileB', { p: esc(entry.path) })}</div>`,
        { okText: t('common.del'), danger: true });
    if (!ok) return;
    try {
        const r = await FS.remove(entry.path, isDir);
        await window.closeFileTab?.(entry.path);
        delete OC.tree[entry.path];
        delete OC.tree[dirName(entry.path)];
        _ftOpen.delete(entry.path);
        _ftSaveOpenSet();
        toast(t('ft.deletedN', { p: entry.path, n: r.deleted }), 'success', 2400);
        await refreshFileTree();
    } catch (e) { toast(t('ft.delFail', { msg: e.message }), 'error', 6000); }
}

function _ftAskAi(path) {
    // 送進對話框的預設提問：跟著介面語系走
    const text = (typeof t === 'function' ? t('ft.askAi', { p: path }) : null) || `解釋 ${path} 這個檔案在做什麼`;
    const inp = $('chat-input');
    if (!inp) { window.runAgent?.(text); return; }
    inp.value = text;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    const form = $('chat-form');
    if (form) {
        if (form.requestSubmit) form.requestSubmit();
        else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    } else {
        inp.value = '';
        window.runAgent?.(text);
    }
}

// ─── 上傳 ───────────────────────────────────────────────────────

function _ftPickUpload(destDir) {
    if (!_ftUploadInput) {
        _ftUploadInput = el('input', { type: 'file', multiple: 'multiple', class: 'ft-file-input', hidden: 'hidden' });
        _ftUploadInput.addEventListener('change', async () => {
            const dir = _ftUploadInput.dataset.dest || '';
            const files = Array.from(_ftUploadInput.files || []);
            _ftUploadInput.value = '';
            await _ftUpload(files, dir);
        });
        document.body.appendChild(_ftUploadInput);
    }
    _ftUploadInput.dataset.dest = _ftNorm(destDir || '');
    _ftUploadInput.click();
}

async function _ftUpload(files, destDir) {
    if (!files || !files.length) return;
    const dir = _ftNorm(destDir || '');
    const note = toast(t('ft.uploading', { n: files.length, d: dir || t('ft.rootDir') }), 'info', 60000);
    try {
        const r = await FS.upload(files, dir);
        note?.remove();
        toast(t('ft.uploaded', { n: r.files.length }), 'success', 2600);
        delete OC.tree[dir];
        await refreshFileTree();
    } catch (e) {
        note?.remove();
        toast(t('ft.uploadFail', { msg: e.message }), 'error', 6000);
    }
}

function _ftBindDnd(host) {
    if (!host || host.dataset.dnd) return;
    host.dataset.dnd = '1';
    host.addEventListener('dragover', (e) => {
        if (!e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        host.classList.add('dragover');
    });
    host.addEventListener('dragleave', (e) => {
        if (e.target === host || !host.contains(e.relatedTarget)) host.classList.remove('dragover');
    });
    host.addEventListener('drop', async (e) => {
        if (!e.dataTransfer?.files?.length) return;
        e.preventDefault();
        host.classList.remove('dragover');
        const row = e.target.closest?.('.tree-row');
        let dest = '';
        if (row) dest = row.dataset.type === 'dir' ? row.dataset.path : dirName(row.dataset.path);
        await _ftUpload(Array.from(e.dataTransfer.files), dest);
    });
}

// ═══════════════════════════════════════════════════════════════
// 搜尋面板
// ═══════════════════════════════════════════════════════════════

function _ftPaintOpts() {
    const c = $('search-opt-case');
    if (c) c.className = 'btn btn-xs ' + (_ftCase ? 'btn-primary' : 'btn-ghost');
    const r = $('search-opt-regex');
    if (r) r.className = 'btn btn-xs ' + (_ftRegex ? 'btn-primary' : 'btn-ghost');
}

function _ftReadOpts(run) {
    _ftQ = $('search-q')?.value ?? _ftQ;
    _ftGlobPat = $('search-glob')?.value ?? _ftGlobPat;
    if (run) _ftExecSearch();
}

async function _ftExecSearch() {
    const q = String(_ftQ || '');
    const token = ++_ftSearchToken;
    _ftSearchErr = '';
    if (!q.trim()) {
        _ftHits = [];
        _ftTruncated = false;
        _ftSearching = false;
        _ftRenderResults();
        return [];
    }
    _ftSearching = true;
    _ftRenderResults();
    try {
        const r = await FS.grep({
            pattern: q,
            path: '',
            glob: _ftGlobPat || '',
            mode: 'content',
            ignore_case: !_ftCase,
            literal: !_ftRegex,
            context: 0,
            limit: 200,
            multiline: false,
        });
        if (token !== _ftSearchToken) return [];
        _ftHits = r.matches || [];
        _ftTruncated = !!r.truncated;
        // 後端因範圍過大而提前中止時要如實告知，不能顯示成「找不到」
        _ftTimedOut = !!r.timed_out;
        _ftScanned = r.scanned || 0;
        _ftHint = r.hint || '';
    } catch (e) {
        if (token !== _ftSearchToken) return [];
        _ftHits = [];
        _ftTruncated = false;
        _ftTimedOut = false;
        _ftHint = '';
        _ftSearchErr = e.message || '搜尋失敗';
    } finally {
        if (token === _ftSearchToken) {
            _ftSearching = false;
            _ftRenderResults();
        }
    }
    return _ftHits;
}

// 依目前選項組出前端用的高亮 RegExp（失敗就不高亮）
function _ftHlRegex() {
    const q = String(_ftQ || '');
    if (!q) return null;
    const src = _ftRegex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try { return new RegExp(src, 'g' + (_ftCase ? '' : 'i')); }
    catch { return null; }
}

function _ftMarkLine(text, re) {
    let s = String(text ?? '');
    let head = '';
    if (s.length > 400) {                       // 太長的行以第一個命中為中心裁切
        let at = 0;
        if (re) { re.lastIndex = 0; const m = re.exec(s); at = m ? m.index : 0; }
        const from = Math.max(0, at - 80);
        if (from > 0) head = '…';
        s = s.slice(from, from + 400);
    }
    if (!re) return head + esc(s);
    re.lastIndex = 0;
    let out = head, last = 0, m, guard = 0;
    while ((m = re.exec(s)) !== null && guard++ < 300) {
        if (m[0] === '') { re.lastIndex++; continue; }
        out += esc(s.slice(last, m.index)) + '<mark>' + esc(m[0]) + '</mark>';
        last = m.index + m[0].length;
    }
    out += esc(s.slice(last));
    return out;
}

function _ftRenderResults() {
    const host = $('search-results');
    const sum = $('search-summary');
    if (!host) return;
    host.innerHTML = '';

    if (_ftSearching) {
        if (sum) sum.textContent = t('ft.searching');
        host.appendChild(el('div', { class: 'search-empty' },
            el('span', { class: 'spinner' }), el('span', { text: t('ft.searching') })));
        return;
    }
    if (_ftSearchErr) {
        if (sum) sum.textContent = '';
        host.appendChild(el('div', { class: 'search-empty' },
            el('span', { class: 'ms', text: 'error' }),
            el('span', { text: _ftSearchErr })));
        return;
    }
    if (!String(_ftQ || '').trim()) {
        if (sum) sum.textContent = '';
        host.appendChild(el('div', { class: 'search-empty' },
            el('span', { class: 'ms', text: 'travel_explore' }),
            el('span', { text: t('ft.searchHint') })));
        return;
    }
    if (!_ftHits.length) {
        if (sum) sum.textContent = '';
        if (_ftTimedOut) {
            // 掃到一半就沒時間了——講清楚，否則使用者會誤以為專案裡真的沒有這段字
            host.appendChild(el('div', { class: 'search-empty' },
                el('span', { class: 'ms', text: 'timer_off' }),
                el('span', { text: t('ft.tooBig', { s: _ftScanned, q: _ftQ }) }),
                el('span', { class: 'search-empty-hint',
                    text: t('ft.tooMany') }),
                el('button', {
                    class: 'btn btn-sm btn-ghost', text: t('ft.switchWs'),
                    onclick: () => window.openWorkspacePicker?.(),
                })));
            return;
        }
        host.appendChild(el('div', { class: 'search-empty' },
            el('span', { class: 'ms', text: 'search_off' }),
            el('span', { text: t('ft.noHit', { q: _ftQ }) })));
        return;
    }

    // 依檔案分組（保留後端回傳的順序）
    const groups = [];
    const idx = new Map();
    for (const h of _ftHits) {
        let g = idx.get(h.file);
        if (!g) { g = { file: h.file, hits: [] }; idx.set(h.file, g); groups.push(g); }
        g.hits.push(h);
    }
    if (sum) {
        sum.textContent = t('ft.summary', { h: _ftHits.length, g: groups.length })
            + (_ftTimedOut ? t('ft.partial', { s: _ftScanned })
                           : (_ftTruncated ? t('ft.capped') : ''));
        sum.classList.toggle('search-partial', _ftTimedOut);
    }

    const re = _ftHlRegex();
    const frag = document.createDocumentFragment();
    for (const g of groups) {
        const collapsed = _ftCollapsed.has(g.file);
        const head = el('div', {
            class: 'sr-file-head',
            title: g.file,
            onclick: () => {
                if (collapsed) _ftCollapsed.delete(g.file); else _ftCollapsed.add(g.file);
                _ftRenderResults();
            },
        },
            el('span', { class: 'ms sr-caret', text: collapsed ? 'chevron_right' : 'expand_more' }),
            el('span', { class: 'ms sr-icon', text: fileIcon(g.file, 'file') }),
            el('span', { class: 'sr-name', text: baseName(g.file) }),
            el('span', { class: 'sr-dir', text: dirName(g.file) }),
            el('span', { class: 'sr-count', text: String(g.hits.length) })
        );
        const box = el('div', { class: 'sr-file' + (collapsed ? ' collapsed' : ''), 'data-file': g.file }, head);
        if (!collapsed) {
            const hits = el('div', { class: 'sr-hits' });
            for (const h of g.hits) {
                hits.appendChild(el('div', {
                    class: 'sr-hit',
                    title: `${g.file}:${h.line}`,
                    onclick: () => window.openFile?.(g.file, h.line),
                },
                    el('span', { class: 'sr-line', text: String(h.line) }),
                    el('span', { class: 'sr-text', html: _ftMarkLine(h.text, re) })
                ));
            }
            box.appendChild(hits);
        }
        frag.appendChild(box);
    }
    host.appendChild(frag);
}

function renderSearchPanel() {
    _ftEnsureSearchShell();
    _ftPaintOpts();
    _ftRenderResults();
    if ($('panel-search')?.classList.contains('active')) {
        setTimeout(() => { const i = $('search-q'); i?.focus(); i?.select(); }, 40);
    }
}

// 外部入口：設定查詢條件並立刻執行（例如 Ctrl+Shift+F 或斜線指令）
async function runProjectSearch(query, opts = {}) {
    _ftEnsureSearchShell();
    if (query !== undefined && query !== null) {
        _ftQ = String(query);
        const i = $('search-q');
        if (i) i.value = _ftQ;
    }
    if (opts.caseSensitive !== undefined) _ftCase = !!opts.caseSensitive;
    if (opts.regex !== undefined) _ftRegex = !!opts.regex;
    if (opts.glob !== undefined) {
        _ftGlobPat = String(opts.glob || '');
        const g = $('search-glob');
        if (g) g.value = _ftGlobPat;
    }
    _ftPaintOpts();
    window.switchPanel?.('search');
    return _ftExecSearch();
}

// ═══════════════════════════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════════════════════════

function initFileTree() {
    const tree = _ftEnsureFilesShell();
    _ftEnsureSearchShell();
    _ftSyncOpenSet();
    if (tree) {
        _ftBindDnd(tree);
        // 空白處右鍵 → 根目錄選單
        tree.addEventListener('contextmenu', (ev) => {
            if (ev.target.closest('.tree-row')) return;
            ev.preventDefault();
            ocContextMenu(ev.clientX, ev.clientY, [
                { icon: 'note_add', label: '新增檔案', onClick: () => _ftNewFile('') },
                { icon: 'create_new_folder', label: '新增資料夾', onClick: () => _ftNewDir('') },
                { sep: true },
                { icon: 'upload', label: '上傳檔案', onClick: () => _ftPickUpload('') },
                { icon: 'refresh', label: '重新整理', onClick: () => refreshFileTree() },
                { icon: 'unfold_less', label: '收合全部', onClick: () => _ftCollapseAll() },
            ]);
        });
    }
    refreshFileTree();
}

Object.assign(window, {
    initFileTree, refreshFileTree, refreshFileTreeSoon, revealInTree,
    renderSearchPanel, runProjectSearch,
    markTreeActive, ocContextMenu, renderTree,
});
