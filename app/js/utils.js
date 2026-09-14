'use strict';
// ═══════════════════════════════════════════════════════════════
// Omni Code — 共用工具函式
// ═══════════════════════════════════════════════════════════════

// ─── DOM ───
const $ = (id) => document.getElementById(id);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const $1 = (sel, root) => (root || document).querySelector(sel);

function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'html') n.innerHTML = v;
        else if (k === 'text') n.textContent = v;
        else n.setAttribute(k, v);
    }
    for (const c of children.flat()) {
        if (c === null || c === undefined || c === false) continue;
        n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return n;
}

// ─── 字串跳脫 ───
function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escAttr(v) { return esc(JSON.stringify(v)); }

// ─── 數值 / 格式 ───
function fmtBytes(n) {
    if (n === null || n === undefined) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
}
function fmtNum(n) { return (n || 0).toLocaleString('en-US'); }
function fmtTokens(n) {
    n = n || 0;
    if (n < 1000) return String(n);
    if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
    return (n / 1000000).toFixed(2) + 'M';
}
function fmtDur(ms) {
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
    return `${m}分${s}秒`;
}
function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts), now = Date.now(), diff = now - ts;
    // 相對時間跟著介面語系走；t() 還沒載入時退回中文（utils 在 i18n 之前載入）
    if (typeof t === 'function') {
        if (diff < 60000) return t('time.justNow');
        if (diff < 3600000) return t('time.minAgo', { n: Math.floor(diff / 60000) });
        if (diff < 86400000) return t('time.hourAgo', { n: Math.floor(diff / 3600000) });
        if (diff < 604800000) return t('time.dayAgo', { n: Math.floor(diff / 86400000) });
    } else {
        if (diff < 60000) return '剛剛';
        if (diff < 3600000) return Math.floor(diff / 60000) + ' 分鐘前';
        if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小時前';
        if (diff < 604800000) return Math.floor(diff / 86400000) + ' 天前';
    }
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

// ─── Token 估算（CJK 感知）───
// 英數約 4 char/token，CJK 約 1.1 char/token
function estTokens(s) {
    if (!s) return 0;
    if (typeof s !== 'string') { try { s = JSON.stringify(s); } catch { s = String(s); } }
    let cjk = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef)) cjk++;
    }
    return Math.ceil((s.length - cjk) / 4 + cjk / 1.1) + 4;
}

// 估算整個訊息陣列的 token
function estMessagesTokens(messages) {
    let t = 0;
    for (const m of (messages || [])) {
        t += 6;
        const c = m.content;
        if (typeof c === 'string') { t += estTokens(c); continue; }
        for (const b of (c || [])) {
            if (b.type === 'text' || b.type === 'thinking') t += estTokens(b.text);
            else if (b.type === 'tool_use') t += estTokens(b.name) + estTokens(b.input) + 12;
            else if (b.type === 'tool_result') t += estTokens(typeof b.content === 'string' ? b.content : JSON.stringify(b.content)) + 8;
            else if (b.type === 'image') t += 1400;   // 概估
        }
    }
    return t;
}

// ─── 路徑 ───
function baseName(p) { return String(p || '').split('/').pop(); }
function dirName(p) {
    const parts = String(p || '').split('/');
    parts.pop();
    return parts.join('/');
}
function extName(p) {
    const b = baseName(p);
    if (!b.includes('.')) return '';
    return b.split('.').pop().toLowerCase();
}
function joinPath(...parts) {
    return parts.filter(Boolean).join('/').replace(/\/+/g, '/').replace(/\/$/, '');
}
function shortPath(p, max = 46) {
    p = String(p || '');
    if (p.length <= max) return p;
    const b = baseName(p);
    if (b.length >= max - 4) return '…' + b.slice(-(max - 1));
    const head = p.slice(0, max - b.length - 4);
    return head + '…/' + b;
}

// 依副檔名取 CodeMirror mode
const CM_MODES = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', json: { name: 'javascript', json: true },
    ts: 'text/typescript', tsx: 'text/typescript-jsx',
    php: 'application/x-httpd-php', phtml: 'application/x-httpd-php',
    html: 'htmlmixed', htm: 'htmlmixed', vue: 'htmlmixed', twig: 'htmlmixed', blade: 'htmlmixed',
    xml: 'xml', svg: 'xml', xhtml: 'xml',
    css: 'css', scss: 'text/x-scss', sass: 'text/x-sass', less: 'text/x-less',
    md: 'markdown', markdown: 'markdown',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
    java: 'text/x-java', c: 'text/x-csrc', h: 'text/x-csrc', cpp: 'text/x-c++src',
    hpp: 'text/x-c++src', cc: 'text/x-c++src', cs: 'text/x-csharp',
    sh: 'shell', bash: 'shell', zsh: 'shell', bat: 'shell', cmd: 'shell', ps1: 'powershell',
    sql: 'text/x-sql', yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'properties',
    lua: 'lua', pl: 'perl', dart: 'dart', swift: 'swift', kt: 'text/x-kotlin',
};
function cmMode(path) {
    const e = extName(path);
    if (CM_MODES[e]) return CM_MODES[e];
    const b = baseName(path).toLowerCase();
    if (b === 'dockerfile') return 'dockerfile';
    if (b === 'makefile') return 'text/x-sh';
    if (b.startsWith('.env')) return 'properties';
    return 'text/plain';
}

// 依副檔名取 highlight.js 語言
const HL_LANGS = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', php: 'php', html: 'xml', htm: 'xml',
    xml: 'xml', svg: 'xml', vue: 'xml', css: 'css', scss: 'scss', less: 'less',
    json: 'json', md: 'markdown', py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
    java: 'java', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp', sh: 'bash', bash: 'bash',
    bat: 'dos', cmd: 'dos', ps1: 'powershell', sql: 'sql', yml: 'yaml', yaml: 'yaml',
    ini: 'ini', toml: 'ini', lua: 'lua', swift: 'swift', kt: 'kotlin', dart: 'dart',
};
function hlLang(path) { return HL_LANGS[extName(path)] || 'plaintext'; }

// 依副檔名取檔案圖示（Material Symbols）
function fileIcon(path, type) {
    if (type === 'dir') return 'folder';
    const e = extName(path), b = baseName(path).toLowerCase();
    if (['png','jpg','jpeg','gif','webp','svg','bmp','ico','avif'].includes(e)) return 'image';
    if (['mp4','webm','mov','avi','mkv'].includes(e)) return 'movie';
    if (['mp3','wav','ogg','flac','m4a'].includes(e)) return 'music_note';
    if (['zip','rar','7z','tar','gz'].includes(e)) return 'folder_zip';
    if (e === 'pdf') return 'picture_as_pdf';
    if (['md','markdown','txt'].includes(e)) return 'article';
    if (['json','yml','yaml','toml','ini','env','conf','cfg'].includes(e)) return 'settings_applications';
    if (b.startsWith('.git')) return 'commit';
    if (['js','mjs','cjs','jsx','ts','tsx','php','py','rb','go','rs','java','c','cpp','cs','sh','sql','lua'].includes(e)) return 'code';
    if (['html','htm','xml','vue','svelte'].includes(e)) return 'html';
    if (['css','scss','sass','less'].includes(e)) return 'css';
    return 'description';
}

// ─── 非同步小工具 ───
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function debounce(fn, ms) {
    let t = null;
    return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); };
}
function throttle(fn, ms) {
    let last = 0, pend = null;
    return function (...a) {
        const now = Date.now();
        if (now - last >= ms) { last = now; fn.apply(this, a); }
        else { clearTimeout(pend); pend = setTimeout(() => { last = Date.now(); fn.apply(this, a); }, ms - (now - last)); }
    };
}
function nextFrame() { return new Promise(r => requestAnimationFrame(() => r())); }
function uid(prefix = '') { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ─── Toast ───
function toast(msg, type = 'info', ms = 3600) {
    const box = $('toast-container');
    if (!box) { console.log(`[${type}]`, msg); return; }
    const icons = { info: 'info', success: 'check_circle', error: 'error', warn: 'warning' };
    const n = el('div', { class: 'toast toast-' + type },
        el('span', { class: 'ms', text: icons[type] || 'info' }),
        el('span', { class: 'toast-msg', text: String(msg) })
    );
    box.appendChild(n);
    requestAnimationFrame(() => n.classList.add('in'));
    setTimeout(() => { n.classList.remove('in'); setTimeout(() => n.remove(), 280); }, ms);
    return n;
}

// ─── 持久錯誤條 ───
function errorTicker(title, detail) {
    const box = $('toast-container');
    if (!box) return;
    const existing = $$('.err-ticker', box);
    if (existing.length >= 3) existing[0].remove();
    const n = el('div', { class: 'toast toast-error err-ticker' },
        el('span', { class: 'ms', text: 'error' }),
        el('div', { style: { flex: '1', minWidth: '0' } },
            el('div', { class: 'toast-msg', text: title }),
            detail ? el('div', { class: 'toast-sub', text: String(detail).slice(0, 160) }) : null
        ),
        el('button', { class: 'toast-x ms', text: 'close', onclick: () => n.remove() })
    );
    if (detail) n.addEventListener('click', (e) => {
        if (e.target.classList.contains('toast-x')) return;
        alertModal(title, `<pre class="pre-scroll">${esc(detail)}</pre>`);
    });
    box.appendChild(n);
    requestAnimationFrame(() => n.classList.add('in'));
    setTimeout(() => { n.classList.remove('in'); setTimeout(() => n.remove(), 280); }, 20000);
}

// ─── Modal ───
// 以 Promise 為介面的對話框（confirmModal / promptModal）一定要有人呼叫 resolve，
// 否則 `await confirmModal(...)` 會永遠卡住——權限授權流程就是這樣掛掉的。
// 因此關閉途徑（按鈕、Esc、點背景）全部統一走 closeModal()，
// 由它負責觸發註冊好的「取消」回呼。
const _modalDismiss = Object.create(null);

function openModal(id, onDismiss) {
    const m = $(id);
    if (!m) return;
    if (typeof onDismiss === 'function') _modalDismiss[id] = onDismiss;
    m.classList.add('active');
    if (!m.dataset.backdropWired) {
        m.dataset.backdropWired = '1';
        m.addEventListener('mousedown', (e) => {
            // 只有點在背景（不是對話框本體）才關閉
            if (e.target === m && m.dataset.noBackdropClose !== '1') closeModal(id);
        });
    }
    const focusable = m.querySelector('input,textarea,select,button');
    setTimeout(() => focusable?.focus(), 60);
}

function closeModal(id) {
    const m = $(id);
    if (!m) return;
    m.classList.remove('active');
    const fn = _modalDismiss[id];
    if (fn) { delete _modalDismiss[id]; try { fn(); } catch (e) { console.error(e); } }
}

function topModal() {
    const list = $$('.modal-overlay.active');
    return list.length ? list[list.length - 1] : null;
}

function alertModal(title, html) {
    $('modal-generic-title').textContent = title;
    $('modal-generic-body').innerHTML = html;
    $('modal-generic-actions').innerHTML = '';
    const b = el('button', { class: 'btn btn-primary', text: (typeof t === 'function' ? t('common.gotIt') : '知道了'), onclick: () => closeModal('modal-generic') });
    $('modal-generic-actions').appendChild(b);
    openModal('modal-generic');
}

// 回傳 Promise<boolean>
function confirmModal(title, message, opts = {}) {
    return new Promise(resolve => {
        $('modal-confirm-title').textContent = title;
        $('modal-confirm-body').innerHTML = typeof message === 'string' && message.includes('<')
            ? message : `<div class="cf-msg">${esc(message)}</div>`;
        const acts = $('modal-confirm-actions');
        acts.innerHTML = '';
        let settled = false;
        const done = (v) => {
            if (settled) return;
            settled = true;
            delete _modalDismiss['modal-confirm'];
            $('modal-confirm')?.classList.remove('active');
            resolve(v);
        };
        acts.appendChild(el('button', { class: 'btn btn-ghost', text: opts.cancelText || (typeof t === 'function' ? t('common.cancel') : '取消'), onclick: () => done(false) }));
        acts.appendChild(el('button', {
            class: 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary'),
            text: opts.okText || (typeof t === 'function' ? t('common.confirm') : '確定'), onclick: () => done(true),
        }));
        // Esc / 點背景 → 視為「取消」，Promise 一定會有結果
        openModal('modal-confirm', () => done(false));
        window._ocConfirmResolve = done;
    });
}

// 文字輸入對話框，回傳 Promise<string|null>
function promptModal(title, label, defVal = '', opts = {}) {
    return new Promise(resolve => {
        $('modal-generic-title').textContent = title;
        $('modal-generic-body').innerHTML =
            `<div class="ig"><label>${esc(label)}</label>
             <input id="_prompt-input" class="inp" type="${opts.type === 'password' ? 'password' : 'text'}" value="${esc(defVal)}" placeholder="${esc(opts.placeholder || '')}"></div>
             ${opts.hint ? `<div class="hint">${esc(opts.hint)}</div>` : ''}`;
        const acts = $('modal-generic-actions');
        acts.innerHTML = '';
        let settled = false;
        const done = (v) => {
            if (settled) return;
            settled = true;
            delete _modalDismiss['modal-generic'];
            $('modal-generic')?.classList.remove('active');
            resolve(v);
        };
        acts.appendChild(el('button', { class: 'btn btn-ghost', text: (typeof t === 'function' ? t('common.cancel') : '取消'), onclick: () => done(null) }));
        acts.appendChild(el('button', {
            class: 'btn btn-primary', text: opts.okText || (typeof t === 'function' ? t('common.confirm') : '確定'),
            onclick: () => done($('_prompt-input').value),
        }));
        openModal('modal-generic', () => done(null));
        setTimeout(() => {
            const i = $('_prompt-input');
            i?.focus(); i?.select();
            i?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); done(i.value); } });
        }, 60);
    });
}

// ─── 剪貼簿 ───
async function copyText(t) {
    try { await navigator.clipboard.writeText(t); toast(t('common.copied'), 'success', 1600); return true; }
    catch {
        const ta = el('textarea', { style: { position: 'fixed', opacity: '0' } });
        ta.value = t; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); toast(t('common.copied'), 'success', 1600); } catch {}
        ta.remove(); return true;
    }
}

// ─── 下載 ───
function downloadText(filename, content, mime = 'text/plain') {
    const blob = new Blob([content], { type: mime + ';charset=utf-8' });
    const a = el('a', { href: URL.createObjectURL(blob), download: filename });
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ─── Markdown 渲染（marked + DOMPurify + highlight.js）───
// 注意：marked v5 起已移除 `highlight` 選項，設了也不會生效。
// 因此語法上色改在 decorateCodeBlocks() 內對已渲染的 DOM 執行，
// 不依賴 marked 的版本。
let _mdReady = false;
function initMarkdown() {
    if (_mdReady || typeof marked === 'undefined') return;
    marked.setOptions({ breaks: true, gfm: true });
    _mdReady = true;
}
function renderMarkdown(text) {
    initMarkdown();
    let html;
    if (typeof marked !== 'undefined') {
        try { html = marked.parse(String(text ?? '')); }
        catch { html = `<p>${esc(text)}</p>`; }
    } else {
        html = `<p>${esc(text).replace(/\n/g, '<br>')}</p>`;
    }
    if (typeof DOMPurify !== 'undefined') {
        html = DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
    }
    return html;
}

// 在已渲染的 markdown 容器內，為每個 <pre> 套用語法上色與複製按鈕
function decorateCodeBlocks(root) {
    $$('pre', root).forEach(pre => {
        if (pre.dataset.deco) return;
        pre.dataset.deco = '1';
        const code = pre.querySelector('code');

        // 語法上色（marked 已不再提供 highlight hook，改在此處對 DOM 執行）
        if (code && typeof hljs !== 'undefined' && !code.dataset.hl) {
            code.dataset.hl = '1';
            // 內容過長時上色成本高又沒必要，直接跳過
            if (code.textContent.length <= 40000) {
                const cls = [...code.classList].find(c => c.startsWith('language-'));
                const lang = cls ? cls.slice(9) : '';
                try {
                    if (lang && hljs.getLanguage(lang)) {
                        code.innerHTML = hljs.highlight(code.textContent, { language: lang }).value;
                    } else {
                        code.innerHTML = hljs.highlightAuto(code.textContent).value;
                    }
                    code.classList.add('hljs');
                } catch { /* 上色失敗就維持純文字 */ }
            }
        }

        const btn = el('button', {
            class: 'code-copy ms', text: 'content_copy', title: '複製',
            onclick: (e) => { e.stopPropagation(); copyText(code ? code.textContent : pre.textContent); },
        });
        pre.appendChild(btn);
    });
}

// ─── 簡易行級 diff（LCS）───
// 回傳 [{type:'ctx'|'add'|'del', text, aLine, bLine}]
function diffLines(a, b) {
    const A = String(a ?? '').split(/\r\n|\n|\r/);
    const B = String(b ?? '').split(/\r\n|\n|\r/);
    const n = A.length, m = B.length;
    // 太大就退化成「整段刪除 + 整段新增」，避免 O(n*m) 爆炸
    if (n * m > 4000000) {
        return [...A.map((t, i) => ({ type: 'del', text: t, aLine: i + 1 })),
                ...B.map((t, i) => ({ type: 'add', text: t, bLine: i + 1 }))];
    }
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
        for (let j = m - 1; j >= 0; j--)
            dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (A[i] === B[j]) { out.push({ type: 'ctx', text: A[i], aLine: i + 1, bLine: j + 1 }); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: A[i], aLine: i + 1 }); i++; }
        else { out.push({ type: 'add', text: B[j], bLine: j + 1 }); j++; }
    }
    while (i < n) { out.push({ type: 'del', text: A[i], aLine: i + 1 }); i++; }
    while (j < m) { out.push({ type: 'add', text: B[j], bLine: j + 1 }); j++; }
    return out;
}

// diff 統計
function diffStat(rows) {
    let add = 0, del = 0;
    for (const r of rows) { if (r.type === 'add') add++; else if (r.type === 'del') del++; }
    return { add, del };
}

// 只保留變更附近 N 行的精簡 diff
function compactDiff(rows, ctx = 3) {
    const keep = new Set();
    rows.forEach((r, i) => {
        if (r.type === 'ctx') return;
        for (let k = Math.max(0, i - ctx); k <= Math.min(rows.length - 1, i + ctx); k++) keep.add(k);
    });
    const out = [];
    let lastKept = -1;
    rows.forEach((r, i) => {
        if (!keep.has(i)) return;
        if (lastKept >= 0 && i - lastKept > 1) out.push({ type: 'gap', text: `⋯ 略過 ${i - lastKept - 1} 行 ⋯` });
        out.push(r);
        lastKept = i;
    });
    return out;
}

// ─── 影像：壓縮 / 裁切 / 縮放（Canvas）───
function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('圖片載入失敗'));
        img.crossOrigin = 'anonymous';
        img.src = src;
    });
}

// file → dataURL（等比縮到 max 邊長）
function compressImageFile(file, max = 1536, quality = 0.86) {
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = async () => {
            try {
                const img = await loadImage(fr.result);
                const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
                if (scale >= 1 && file.size < 900000) return resolve(fr.result);
                const c = el('canvas');
                c.width = Math.round(img.naturalWidth * scale);
                c.height = Math.round(img.naturalHeight * scale);
                c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                try { resolve(c.toDataURL('image/jpeg', quality)); } catch { resolve(fr.result); }
            } catch (e) { reject(e); }
        };
        fr.onerror = () => reject(new Error('檔案讀取失敗'));
        fr.readAsDataURL(file);
    });
}

// dataURL 裁切（x,y,w,h 為原圖像素座標）
async function cropDataUrl(dataUrl, x, y, w, h, format = 'image/png', quality = 0.92) {
    const img = await loadImage(dataUrl);
    const c = el('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, x, y, w, h, 0, 0, c.width, c.height);
    return c.toDataURL(format, quality);
}

// dataURL 縮放；mode: 'stretch' | 'contain'(留白) | 'cover'(裁切填滿)
async function resizeDataUrl(dataUrl, width, height, mode = 'stretch', format = 'image/png', quality = 0.92, bg = 'transparent') {
    const img = await loadImage(dataUrl);
    const c = el('canvas');
    c.width = Math.max(1, Math.round(width));
    c.height = Math.max(1, Math.round(height || (width * img.naturalHeight / img.naturalWidth)));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    if (bg && bg !== 'transparent') { ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height); }
    const iw = img.naturalWidth, ih = img.naturalHeight;
    if (mode === 'contain') {
        const s = Math.min(c.width / iw, c.height / ih);
        const dw = iw * s, dh = ih * s;
        ctx.drawImage(img, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh);
    } else if (mode === 'cover') {
        const s = Math.max(c.width / iw, c.height / ih);
        const sw = c.width / s, sh = c.height / s;
        ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, c.width, c.height);
    } else {
        ctx.drawImage(img, 0, 0, c.width, c.height);
    }
    return c.toDataURL(format, quality);
}

// 取得 dataURL 尺寸
async function imageSize(dataUrl) {
    const img = await loadImage(dataUrl);
    return { width: img.naturalWidth, height: img.naturalHeight };
}

// dataURL → {mime, data(base64)}
function splitDataUrl(dataUrl) {
    const m = String(dataUrl || '').match(/^data:([^;,]+);base64,(.*)$/s);
    if (!m) return { mime: 'application/octet-stream', data: String(dataUrl || '').replace(/^data:[^,]*,/, '') };
    return { mime: m[1], data: m[2] };
}

// ─── JSON 修復解析（模型輸出常見問題）───
function repairJsonControlChars(s) {
    let out = '', inStr = false, escd = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (escd) { out += ch; escd = false; continue; }
        if (ch === '\\') { out += ch; if (inStr) escd = true; continue; }
        if (ch === '"') { inStr = !inStr; out += ch; continue; }
        if (inStr) {
            if (ch === '\n') { out += '\\n'; continue; }
            if (ch === '\r') { out += '\\r'; continue; }
            if (ch === '\t') { out += '\\t'; continue; }
            const cc = ch.charCodeAt(0);
            if (cc < 0x20) { out += '\\u' + cc.toString(16).padStart(4, '0'); continue; }
        }
        out += ch;
    }
    return out;
}
function parseJsonLoose(t) {
    if (typeof t === 'object' && t !== null) return t;
    const c = String(t ?? '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    if (!c) return {};
    try { return JSON.parse(c); } catch {}
    const m = c.match(/[[{][\s\S]*[\]}]/);
    const body = m ? m[0] : c;
    try { return JSON.parse(body); } catch {}
    try { return JSON.parse(repairJsonControlChars(body)); } catch {}
    throw new Error('JSON 解析失敗');
}

// ─── 簡易 YAML frontmatter 解析（技能 / 記憶檔用）───
function parseFrontmatter(text) {
    const s = String(text ?? '');
    const m = s.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) return { meta: {}, body: s };
    const meta = {};
    let curKey = null;
    for (const raw of m[1].split(/\r?\n/)) {
        if (!raw.trim() || /^\s*#/.test(raw)) continue;
        const listItem = raw.match(/^\s*-\s+(.*)$/);
        if (listItem && curKey) {
            if (!Array.isArray(meta[curKey])) meta[curKey] = meta[curKey] ? [meta[curKey]] : [];
            meta[curKey].push(stripQuotes(listItem[1].trim()));
            continue;
        }
        const kv = raw.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (kv) {
            curKey = kv[1];
            const v = kv[2].trim();
            meta[curKey] = v === '' ? '' : stripQuotes(v);
        }
    }
    return { meta, body: m[2] };
}
function stripQuotes(v) {
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
    return v;
}

// ─── glob → RegExp（前端過濾用）───
function globToRegex(pattern) {
    let re = '';
    const p = String(pattern || '');
    for (let i = 0; i < p.length; i++) {
        const c = p[i];
        if (c === '*') {
            if (p[i + 1] === '*') { re += '.*'; i++; if (p[i + 1] === '/') i++; }
            else re += '[^/]*';
        } else if (c === '?') re += '[^/]';
        else if ('\\^$.|+()[]{}'.includes(c)) re += '\\' + c;
        else if (c === '/') re += '/';
        else re += c;
    }
    return new RegExp('^' + re + '$', 'i');
}

// ─── 主題 ───
function setTheme(t) {
    document.documentElement.dataset.theme = t;
    localStorage.setItem('oc_theme', t);
    if (window.OC) OC.cfg.theme = t;
    // CodeMirror 主題同步
    if (window.OC?.openFiles) {
        OC.openFiles.forEach(f => f.cm?.setOption('theme', t === 'dark' ? 'oc-dark' : 'oc-light'));
    }
    const btn = $('theme-btn');
    if (btn) btn.textContent = t === 'dark' ? 'light_mode' : 'dark_mode';
}
function toggleTheme() {
    setTheme((document.documentElement.dataset.theme === 'dark') ? 'light' : 'dark');
}

// ─── 匯出到 window ───
Object.assign(window, {
    $, $$, $1, el, esc, escAttr,
    fmtBytes, fmtNum, fmtTokens, fmtDur, fmtTime,
    estTokens, estMessagesTokens,
    baseName, dirName, extName, joinPath, shortPath, cmMode, hlLang, fileIcon,
    sleep, debounce, throttle, nextFrame, uid,
    toast, errorTicker, openModal, closeModal, topModal, alertModal, confirmModal, promptModal,
    copyText, downloadText,
    renderMarkdown, decorateCodeBlocks, initMarkdown,
    diffLines, diffStat, compactDiff,
    loadImage, compressImageFile, cropDataUrl, resizeDataUrl, imageSize, splitDataUrl,
    parseJsonLoose, parseFrontmatter, globToRegex,
    setTheme, toggleTheme,
});
