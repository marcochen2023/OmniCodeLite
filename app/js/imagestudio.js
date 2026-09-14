'use strict';
// ═══════════════════════════════════════════════════════════════
// Omni Code — 圖片工作室（生成 + 裁切 / 縮放 / 轉檔）
// ═══════════════════════════════════════════════════════════════
// 契約見 ARCHITECTURE.md §17。
//   左：提示詞 / 風格 / 比例 / 尺寸 / 參考圖 / 生成
//   右：Canvas 工作區（棋盤底 + 裁切框 + 縮放 + 格式轉換 + 復原堆疊）
//   下：本次會話產生的所有圖片（OC.imageStudio.images）
//
// 對外 API（tools.js / agent 會呼叫）：
//   openImageStudio(prompt)      開啟並帶入提示詞
//   openImageStudioWith(dataUrl) 開啟並直接把圖載進工作區
//   imageStudioAdd(url,p,path)   把一張圖加進畫廊（Agent 生成時自動呼叫）
//   imageStudioNote(text)        顯示一行狀態訊息
//   closeImageStudio()
//   initImageStudio()            由 app.js 啟動時呼叫
//
// 【座標系統】這是本檔最需要精準的部分：
//   IMGST.crop 一律是「相對於 <img> 顯示框左上角的 CSS 像素」。
//   螢幕 → 原圖：乘上 naturalWidth / getBoundingClientRect().width。
//   圖片顯示尺寸會隨視窗改變，因此用 ResizeObserver 等比重算 IMGST.crop。
// ═══════════════════════════════════════════════════════════════

// ─── 模組內部狀態（跨會話保留的資料放 OC.imageStudio）───
const IMGST = {
    mounted: false,
    open: false,
    natural: { w: 0, h: 0 },      // 目前圖片的原始像素尺寸
    undo: [],                     // dataURL 堆疊（最多 20）
    redo: [],
    dirty: false,                 // 有未存檔的編輯
    crop: null,                   // {x,y,w,h} 顯示框 CSS 像素
    cropOn: false,
    drag: null,                   // 拖曳中 {mode,sx,sy,rect}
    disp: { w: 0, h: 0 },         // 上次量到的圖片顯示尺寸（供 resize 重算）
    style: 'none',
    aspect: '',
    size: '',
    model: '',          // 本次生成用的繪圖模型 id（空 = 主要繪圖模型）
    cutout: false,      // 去背開關（解析度列右側 toggle，預設 off）
    fmt: 'png',
    quality: 0.92,
    lockRatio: true,
    fit: 'stretch',
    busy: false,
    abort: null,
    ro: null,
    keysBound: false,
    pickerMode: '',
};

const IS_UNDO_MAX = 20;
const IS_REF_MAX = 5;
const IS_MIN_CROP = 10;           // 裁切框最小邊長（顯示像素）

// 裁切鎖定比例選項（值為 寬/高，null = 自由，'orig' = 原圖比例）
const IS_LOCKS = [
    { id: 'free', get label() { return t('is.lockFree'); }, r: null },
    { id: '1:1', label: '1:1', r: 1 },
    { id: '4:3', label: '4:3', r: 4 / 3 },
    { id: '16:9', label: '16:9', r: 16 / 9 },
    { id: '3:4', label: '3:4', r: 3 / 4 },
    { id: '9:16', label: '9:16', r: 9 / 16 },
    { id: 'orig', get label() { return t('is.lockOrig'); }, r: 'orig' },
];

// ═══════════════════════════════════════════════════════════════
// 樣式（自帶降級樣式；styles.css 若另有定義以本檔為準，
// 全部選擇器都以 .is- 前綴命名，不干擾其他模組的元件 class）
// ═══════════════════════════════════════════════════════════════
const IS_CSS = `
.is-overlay{position:fixed;inset:0;z-index:80;display:none;background:rgba(6,7,12,.78);backdrop-filter:blur(6px)}
.is-overlay.active{display:flex}
.is-front{z-index:9999}
.is-shell{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:var(--canvas);color:var(--ink);font-family:var(--sans)}
.is-top{display:flex;align-items:center;gap:8px;padding:9px 14px;border-bottom:1px solid var(--line);background:var(--panel-4);flex-shrink:0}
.is-top h2{margin:0;font-family:var(--display);font-size:15px;font-weight:700;display:flex;align-items:center;gap:8px}
.is-top h2 .ms{font-size:20px;color:var(--accent)}
.is-grow{flex:1}
.is-model{max-width:230px;padding:5px 8px;border-radius:var(--r-sm);border:1px solid var(--line-2);background:var(--panel-3);color:var(--ink);font-family:var(--sans);font-size:12px;overflow:hidden;text-overflow:ellipsis}
.is-model:focus{outline:none;border-color:var(--accent)}
.is-main{flex:1;display:flex;min-height:0;min-width:0}
.is-left{width:344px;flex-shrink:0;border-right:1px solid var(--line);background:var(--panel-4);overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:13px}
.is-right{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0}
.is-sec{display:flex;flex-direction:column;gap:7px}
.is-lbl{font-size:11.5px;font-weight:700;color:var(--ink-dim);letter-spacing:.03em;display:flex;align-items:center;gap:6px}
.is-lbl .is-grow{flex:1}
.is-chips{display:flex;flex-wrap:wrap;gap:6px}
.is-chip{padding:4px 10px;border-radius:999px;border:1px solid var(--line-2);background:var(--panel);color:var(--ink-dim);font-size:11.5px;cursor:pointer;user-select:none;transition:.14s;line-height:1.6}
.is-chip:hover{border-color:var(--accent);color:var(--ink)}
.is-chip.on{background:var(--accent-soft);border-color:var(--accent);color:var(--ink)}
.is-ta{width:100%;min-height:96px;max-height:320px;resize:none;overflow-y:auto;padding:9px 10px;border-radius:var(--r-sm);border:1px solid var(--line-2);background:var(--panel-3);color:var(--ink);font-family:var(--sans);font-size:13px;line-height:1.6}
.is-ta:focus{outline:none;border-color:var(--accent)}
.is-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.is-refs{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.is-ref{position:relative;width:50px;height:50px;border-radius:var(--r-sm);overflow:hidden;border:1px solid var(--line-2);flex-shrink:0}
.is-ref img{width:100%;height:100%;object-fit:cover;display:block}
.is-ref-x{position:absolute;top:1px;right:1px;width:16px;height:16px;border:none;border-radius:50%;background:rgba(0,0,0,.62);color:#fff;font-size:11px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}
.is-ref-add{width:50px;height:50px;border-radius:var(--r-sm);border:1px dashed var(--line-2);background:var(--panel);display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--ink-faint);flex-shrink:0}
.is-ref-add:hover{border-color:var(--accent);color:var(--accent)}
.is-note{font-size:11.5px;color:var(--ink-faint);line-height:1.55;min-height:16px;word-break:break-word}
.is-note.on{color:var(--accent-2)}
.is-tools{display:flex;flex-wrap:wrap;align-items:center;gap:7px;padding:7px 12px;border-bottom:1px solid var(--line);background:var(--panel);flex-shrink:0}
.is-read{font-family:var(--mono);font-size:11px;color:var(--ink-dim);white-space:nowrap}
.is-stage{flex:1 1 auto;position:relative;display:grid;place-items:center;overflow:auto;padding:16px;min-height:320px;
  background-color:var(--panel-3);
  background-image:linear-gradient(45deg,var(--line) 25%,transparent 25%,transparent 75%,var(--line) 75%),
                   linear-gradient(45deg,var(--line) 25%,transparent 25%,transparent 75%,var(--line) 75%);
  background-size:22px 22px;background-position:0 0,11px 11px}
.is-frame{position:relative;line-height:0;max-width:100%;max-height:100%}
.is-frame img{display:block;max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;border-radius:2px;box-shadow:0 8px 34px rgba(0,0,0,.45)}
.is-empty{margin:auto}
.is-empty{color:var(--ink-faint);font-size:13px;text-align:center;line-height:1.9}
.is-empty .ms{font-size:42px;display:block;opacity:.5;margin-bottom:6px}
.is-crop-box{position:absolute;border:1px solid rgba(255,255,255,.92);box-shadow:0 0 0 9999px rgba(4,5,10,.6);cursor:move;box-sizing:border-box}
.is-crop-grid{position:absolute;inset:0;pointer-events:none}
.is-crop-grid i{position:absolute;background:rgba(255,255,255,.35)}
.is-crop-grid i:nth-child(1){left:33.333%;top:0;bottom:0;width:1px}
.is-crop-grid i:nth-child(2){left:66.666%;top:0;bottom:0;width:1px}
.is-crop-grid i:nth-child(3){top:33.333%;left:0;right:0;height:1px}
.is-crop-grid i:nth-child(4){top:66.666%;left:0;right:0;height:1px}
.is-h{position:absolute;width:12px;height:12px;border-radius:3px;background:var(--accent);border:2px solid #fff;z-index:2;box-sizing:border-box}
.is-h[data-h="nw"]{left:-6px;top:-6px;cursor:nwse-resize}
.is-h[data-h="n"]{left:calc(50% - 6px);top:-6px;cursor:ns-resize}
.is-h[data-h="ne"]{right:-6px;top:-6px;cursor:nesw-resize}
.is-h[data-h="e"]{right:-6px;top:calc(50% - 6px);cursor:ew-resize}
.is-h[data-h="se"]{right:-6px;bottom:-6px;cursor:nwse-resize}
.is-h[data-h="s"]{left:calc(50% - 6px);bottom:-6px;cursor:ns-resize}
.is-h[data-h="sw"]{left:-6px;bottom:-6px;cursor:nesw-resize}
.is-h[data-h="w"]{left:-6px;top:calc(50% - 6px);cursor:ew-resize}
.is-bottom{flex-shrink:0;border-top:1px solid var(--line);background:var(--panel-4);padding:9px 12px;display:flex;flex-direction:column;gap:8px}
.is-bottom.is-collapsed{padding:0;border-top:none}
.is-bottom.is-collapsed .is-brow{display:none}
.is-brow{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.is-num{width:78px;padding:5px 7px;border-radius:var(--r-sm);border:1px solid var(--line-2);background:var(--panel-3);color:var(--ink);font-family:var(--mono);font-size:12px}
.is-num:focus{outline:none;border-color:var(--accent)}
.is-mini{font-size:11px;color:var(--ink-faint);white-space:nowrap}
.is-range{width:118px;accent-color:var(--accent)}
.is-hide{display:none !important}
.is-gallery{flex-shrink:0;border-top:1px solid var(--line);background:var(--panel-4);padding:8px 12px;display:flex;gap:8px;overflow-x:auto;overflow-y:hidden;align-items:center;min-height:88px;max-height:120px}
.is-gallery.is-collapsed{display:none}
.is-gempty{color:var(--ink-faint);font-size:12px;padding:0 4px}
.is-gitem{position:relative;width:96px;height:72px;flex-shrink:0;border-radius:var(--r-sm);overflow:hidden;border:1px solid var(--line-2);background:var(--panel-3);cursor:pointer}
.is-gitem.on{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}
.is-gitem img{width:100%;height:100%;object-fit:cover;display:block}
.is-gover{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:3px;background:rgba(8,9,14,.78);opacity:0;transition:.15s}
.is-gitem:hover .is-gover{opacity:1}
.is-gbtn{width:24px;height:24px;border:none;border-radius:6px;background:var(--panel-2);color:var(--ink);cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}
.is-gbtn:hover{background:var(--accent);color:#fff}
.is-gbtn .ms{font-size:14px}
.is-gcap{position:absolute;left:0;right:0;bottom:0;padding:1px 4px;font-family:var(--mono);font-size:9px;color:#fff;background:rgba(0,0,0,.55);pointer-events:none}
.is-picker{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(560px,86vw);max-height:70vh;display:flex;flex-direction:column;background:var(--panel-3);border:1px solid var(--line-2);border-radius:var(--r);box-shadow:0 24px 70px rgba(0,0,0,.6);z-index:12;overflow:hidden}
.is-picker-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line)}
.is-picker-list{overflow-y:auto;padding:6px}
.is-pk{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:var(--r-sm);cursor:pointer;font-size:12.5px;color:var(--ink-dim)}
.is-pk:hover{background:var(--panel-2);color:var(--ink)}
.is-pk .ms{font-size:16px;color:var(--ink-faint)}
.is-pk span.p{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media (max-width:1080px){.is-left{width:290px}}
@media (max-width:860px){.is-main{flex-direction:column;overflow-y:auto}.is-left{width:auto;border-right:none;border-bottom:1px solid var(--line);overflow:visible}.is-right{min-height:70vh}.is-stage{min-height:300px}}
`;

// ═══════════════════════════════════════════════════════════════
// 綠幕去背（移植自 docs/OneClickStickerV5.8.0.jsx 的 chromaKey）
// 邊緣連通 flood-fill＋smoothstep＋3×3 柔化＋choke 收邊＋切口 despill。
// 貼圖專用的描邊／文字／匯出不搬，只留「生成→去背」這段。
// ═══════════════════════════════════════════════════════════════
const IS_CUTOUT_FX = { threshold: 0.42, softness: 0.30, despill: 0.85, choke: 0.18 };

// dataURL → 已去背的 PNG dataURL。失敗時拋錯，由呼叫端決定保留原圖。
async function _isChromaKey(dataUrl, fx = IS_CUTOUT_FX) {
    const img = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => rej(new Error('圖片解碼失敗'));
        im.src = dataUrl;
    });
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    if (!w || !h) throw new Error('圖片尺寸為 0');
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const image = ctx.getImageData(0, 0, w, h);
    const d = image.data, n = w * h;
    const clamp01 = (v) => Math.max(0, Math.min(1, v));

    const hi = 0.04 + fx.threshold * 0.50;
    const lo = Math.max(0.008, hi - (0.02 + fx.softness * 0.32));
    // 硬綠幕門檻：接近純 #00FF00 才算，用來救被包住的綠口袋（手臂與身體間的三角殘留）
    const hardT = Math.max(0.55, hi + 0.05);
    const green = new Float32Array(n);
    const hard = new Uint8Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
        const r = d[p], g = d[p + 1], b = d[p + 2];
        const gr = (g - Math.max(r, b)) / 255;
        green[i] = gr;
        if (gr > hardT && g > 120 && r < 170 && b < 170) hard[i] = 1;
    }

    // 只有「從畫面邊緣連得到的綠」才算背景，衣服／眼睛裡的綠不會被挖穿
    const reachable = new Uint8Array(n);
    const stack = new Int32Array(n);
    let top = 0;
    const push = (i) => { if (!reachable[i] && green[i] > lo) { reachable[i] = 1; stack[top++] = i; } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    for (let i = 0; i < n; i++) if (hard[i]) push(i);
    while (top > 0) {
        const i = stack[--top];
        const x = i % w, y = (i - x) / w;
        if (x > 0) push(i - 1);
        if (x < w - 1) push(i + 1);
        if (y > 0) push(i - w);
        if (y < h - 1) push(i + w);
    }

    const alpha = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        if (!reachable[i]) { alpha[i] = 1; continue; }
        const t = clamp01((green[i] - lo) / Math.max(0.001, hi - lo));
        alpha[i] = 1 - t * t * (3 - 2 * t);      // smoothstep，邊緣不鋸齒
    }

    // 柔化 alpha（3×3 box blur），去掉硬邊
    if (fx.softness > 0.02) {
        const blur = new Float32Array(n);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                let sum = 0, cnt = 0;
                for (let dy = -1; dy <= 1; dy++) {
                    const yy = y + dy;
                    if (yy < 0 || yy >= h) continue;
                    for (let dx = -1; dx <= 1; dx++) {
                        const xx = x + dx;
                        if (xx < 0 || xx >= w) continue;
                        sum += alpha[yy * w + xx]; cnt++;
                    }
                }
                blur[y * w + x] = sum / cnt;
            }
        }
        alpha.set(blur);
    }

    // 收邊：matte 往內縮，殘留的綠色細邊直接切掉
    if (fx.choke > 0) {
        const ch = Math.min(0.6, fx.choke);
        for (let i = 0; i < n; i++) alpha[i] = clamp01((alpha[i] - ch) / (1 - ch));
    }

    // despill 只作用在切口附近 2px 帶狀區，綠衣服內部不會被洗灰
    const band = new Uint8Array(n);
    if (fx.despill > 0) {
        for (let i = 0; i < n; i++) if (alpha[i] < 0.6) band[i] = 1;
        for (let pass = 0; pass < 2; pass++) {
            const prev = band.slice();
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const i = y * w + x;
                    if (prev[i]) continue;
                    if ((x > 0 && prev[i - 1]) || (x < w - 1 && prev[i + 1])
                        || (y > 0 && prev[i - w]) || (y < h - 1 && prev[i + w])) band[i] = 1;
                }
            }
        }
    }

    for (let i = 0, p = 0; i < n; i++, p += 4) {
        const a = alpha[i];
        if (band[i] && a > 0) {
            const f = a < 0.98 ? Math.max(fx.despill, 0.95) : fx.despill;
            const avg = (d[p] + d[p + 2]) / 2;
            if (d[p + 1] > avg) d[p + 1] = Math.round(d[p + 1] + (avg - d[p + 1]) * f);
        }
        d[p + 3] = Math.round(d[p + 3] * a);
    }
    ctx.putImageData(image, 0, 0);
    return c.toDataURL('image/png');
}

// ═══════════════════════════════════════════════════════════════
// 小工具
// ═══════════════════════════════════════════════════════════════

// dataURL 的實際位元組數（base64 → bytes）
function _isBytes(dataUrl) {
    const i = String(dataUrl || '').indexOf(',');
    if (i < 0) return 0;
    const b64 = dataUrl.slice(i + 1);
    const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor(b64.length * 3 / 4) - pad);
}

// 二進位 dataURL 下載（downloadText 只處理文字，這裡要走 Uint8Array）
function _isDownload(filename, dataUrl) {
    const { mime, data } = splitDataUrl(dataUrl);
    let bin;
    try { bin = atob(data); } catch { toast(t('is.dataBroken'), 'error'); return; }
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const a = el('a', { href: URL.createObjectURL(new Blob([buf], { type: mime })), download: filename });
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// 提示詞 → 檔名 slug
function _isSlug(s) {
    const t = String(s || '').toLowerCase()
        .replace(/[^a-z0-9一-鿿]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .replace(/-+$/, '');
    return t || 'image';
}

function _isStamp() {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 開 promptModal / confirmModal 時把該 modal 拉到工作室之上
async function _isWithModal(fn) {
    const ids = ['modal-generic', 'modal-confirm'];
    ids.forEach(id => $(id)?.classList.add('is-front'));
    try { return await fn(); }
    finally { setTimeout(() => ids.forEach(id => $(id)?.classList.remove('is-front')), 60); }
}

function _isAutoGrow(ta) {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(320, Math.max(96, ta.scrollHeight + 2)) + 'px';
}

// ═══════════════════════════════════════════════════════════════
// 建立 DOM（只做一次；index.html 若已有 #image-studio 就沿用它）
// ═══════════════════════════════════════════════════════════════
function _isMount() {
    if (IMGST.mounted) return;

    if (!$('is-css')) {
        // 放在 head 最後，確保 .is-* 規則在 styles.css 缺漏時仍可用
        document.head.appendChild(el('style', { id: 'is-css', text: IS_CSS }));
    }

    let root = $('image-studio');
    if (!root) {
        root = el('div', { id: 'image-studio', class: 'modal-overlay is-overlay' });
        // 插在第一個 modal 之前，讓 modal 疊在工作室之上
        const firstModal = $1('body > .modal-overlay');
        if (firstModal) firstModal.parentNode.insertBefore(root, firstModal);
        else document.body.appendChild(root);
    } else {
        root.classList.add('is-overlay');
    }

    const aspects = API_CONFIG.image.aspects || ['1:1'];
    const sizes = API_CONFIG.image.sizes || ['2K'];
    IMGST.aspect = API_CONFIG.image.defaultAspect || aspects[0];
    IMGST.size = API_CONFIG.image.defaultSize || sizes[0];

    root.innerHTML = `
<div class="is-shell">
  <div class="is-top">
    <h2><span class="ms">auto_awesome</span>${esc(t('is.title'))}</h2>
    <select class="is-model" id="is-model" title="${esc(t('is.modelT'))}"></select>
    <span class="is-grow"></span>
    <button class="btn btn-ghost btn-sm" id="is-undo" title="${esc(t('is.undoT'))}"><span class="ms">undo</span>${esc(t('is.undo'))}</button>
    <button class="btn btn-ghost btn-sm" id="is-redo" title="${esc(t('is.redoT'))}"><span class="ms">redo</span>${esc(t('is.redo'))}</button>
    <button class="btn btn-ghost btn-sm" id="is-download" title="${esc(t('is.dlT'))}"><span class="ms">download</span>${esc(t('is.dl'))}</button>
    <button class="btn btn-primary btn-sm" id="is-save" title="${esc(t('is.saveT'))}"><span class="ms">save</span>${esc(t('is.save'))}</button>
    <button class="btn-icon modal-x" id="is-close" title="${esc(t('is.closeT'))}"><span class="ms">close</span></button>
  </div>

  <div class="is-main">
    <div class="is-left">
      <div class="is-sec">
        <div class="is-lbl"><span class="ms">edit_note</span>${esc(t('is.prompt'))}<span class="is-grow"></span>
          <button class="btn btn-ghost btn-xs" id="is-optimize" title="${esc(t('is.optimizeT'))}"><span class="ms">auto_fix_high</span>${esc(t('is.optimize'))}</button>
        </div>
        <textarea class="is-ta" id="is-prompt" placeholder="${esc(t('is.promptPh'))}"></textarea>
        <div class="is-row">
          <button class="btn btn-ghost btn-xs" id="is-copy"><span class="ms">content_copy</span>${esc(t('is.copyFull'))}</button>
          <span class="is-mini" id="is-ptok"></span>
        </div>
      </div>

      <div class="is-sec">
        <div class="is-lbl"><span class="ms">palette</span>${esc(t('is.style'))}</div>
        <div class="is-chips" id="is-styles"></div>
      </div>

      <div class="is-sec">
        <div class="is-lbl"><span class="ms">aspect_ratio</span>${esc(t('is.aspect'))}</div>
        <div class="is-chips" id="is-aspects"></div>
      </div>

      <div class="is-sec">
        <div class="is-lbl"><span class="ms">hd</span>${esc(t('is.res'))}<span class="is-grow"></span>
          <button class="is-chip" id="is-cutout" title="${esc(t('is.cutoutT'))}">${esc(t('is.cutout'))}</button>
        </div>
        <div class="is-chips" id="is-sizes"></div>
      </div>

      <div class="is-sec">
        <div class="is-lbl"><span class="ms">imagesmode</span>${esc(t('is.refs'))}<span class="is-grow"></span>
          <button class="btn btn-ghost btn-xs" id="is-pick-ref"><span class="ms">folder_open</span>${esc(t('is.pickRef'))}</button>
        </div>
        <div class="is-refs" id="is-refs">
          <label class="is-ref-add" id="is-ref-add" title="${esc(t('is.addRefT'))}">
            <input type="file" accept="image/*" multiple hidden id="is-ref-input">
            <span class="ms">add_photo_alternate</span>
          </label>
        </div>
        <div class="hint">${esc(t('is.refHint'))}</div>
      </div>

      <button class="btn btn-primary" id="is-gen"><span class="ms">brush</span>${esc(t('is.gen'))}</button>
      <div class="is-note" id="is-note"></div>
    </div>

    <div class="is-right">
      <div class="is-tools">
        <button class="btn btn-ghost btn-sm" id="is-crop-toggle"><span class="ms">crop</span>${esc(t('is.crop'))}</button>
        <select class="sel sel-sm is-hide" id="is-crop-lock" title="${esc(t('is.cropLockT'))}"></select>
        <button class="btn btn-primary btn-sm is-hide" id="is-crop-apply"><span class="ms">check</span>${esc(t('is.applyCrop'))}</button>
        <button class="btn btn-ghost btn-sm is-hide" id="is-crop-reset"><span class="ms">select_all</span>${esc(t('is.selectAll'))}</button>
        <span class="is-grow"></span>
        <button class="btn btn-ghost btn-sm" id="is-bottom-toggle" title="${esc(t('is.tuneT'))}"><span class="ms">tune</span>${esc(t('is.tune'))}</button>
        <button class="btn btn-ghost btn-sm" id="is-gallery-toggle" title="${esc(t('is.histT'))}"><span class="ms">photo_library</span>${esc(t('is.hist'))}</button>
        <span class="is-read" id="is-read">${esc(t('is.noImg'))}</span>
      </div>

      <div class="is-stage" id="is-stage">
        <div class="is-empty" id="is-placeholder"><span class="ms">image</span>${t('is.emptyHtml')}</div>
        <div class="is-frame is-hide" id="is-frame">
          <img id="is-img" alt="">
          <div class="is-crop-box is-hide" id="is-crop-box">
            <div class="is-crop-grid"><i></i><i></i><i></i><i></i></div>
            <span class="is-h" data-h="nw"></span><span class="is-h" data-h="n"></span>
            <span class="is-h" data-h="ne"></span><span class="is-h" data-h="e"></span>
            <span class="is-h" data-h="se"></span><span class="is-h" data-h="s"></span>
            <span class="is-h" data-h="sw"></span><span class="is-h" data-h="w"></span>
          </div>
        </div>
      </div>

      <div class="is-bottom is-collapsed" id="is-bottom">
        <div class="is-brow">
          <span class="is-lbl"><span class="ms">photo_size_select_large</span>${esc(t('is.resize'))}</span>
          <input type="number" class="is-num" id="is-rw" min="1" max="16384" placeholder="${esc(t('is.wPh'))}">
          <span class="is-mini">×</span>
          <input type="number" class="is-num" id="is-rh" min="1" max="16384" placeholder="${esc(t('is.hPh'))}">
          <button class="btn btn-ghost btn-xs" id="is-lock" title="${esc(t('is.lockRatioT'))}"><span class="ms">link</span>${esc(t('is.lockRatio'))}</button>
          <select class="sel sel-sm" id="is-fit" title="${esc(t('is.fitT'))}">
            <option value="stretch">${esc(t('is.fitStretch'))}</option>
            <option value="contain">${esc(t('is.fitContain'))}</option>
            <option value="cover">${esc(t('is.fitCover'))}</option>
          </select>
          <button class="btn btn-ghost btn-sm" id="is-resize"><span class="ms">aspect_ratio</span>${esc(t('is.applyResize'))}</button>
        </div>
        <div class="is-brow">
          <span class="is-mini">${esc(t('is.quickSize'))}</span>
          <button class="btn btn-ghost btn-xs" data-preset="512">512</button>
          <button class="btn btn-ghost btn-xs" data-preset="1024">1024</button>
          <button class="btn btn-ghost btn-xs" data-preset="1920">1920</button>
          <span class="is-mini">${esc(t('is.icon'))}</span>
          <button class="btn btn-ghost btn-xs" data-icon="256">256</button>
          <button class="btn btn-ghost btn-xs" data-icon="128">128</button>
          <button class="btn btn-ghost btn-xs" data-icon="64">64</button>
          <button class="btn btn-ghost btn-xs" data-icon="32">32</button>
          <span class="is-grow"></span>
          <select class="sel sel-sm" id="is-fmt">
            <option value="png">PNG</option>
            <option value="jpeg">JPEG</option>
            <option value="webp">WebP</option>
          </select>
          <span class="is-mini is-hide" id="is-qwrap">${esc(t('is.quality'))} <input type="range" class="is-range" id="is-q" min="40" max="100" value="92"><b id="is-qv">92</b></span>
          <span class="is-mini" id="is-est"></span>
        </div>
      </div>
    </div>
  </div>

  <div class="is-gallery" id="is-gallery"></div>
</div>`;

    // ─── 風格 / 比例 / 尺寸 chips ───
    const styleBox = $('is-styles');
    const styleLabel = (s) => (typeof t === 'function' && s.id !== 'none' ? t('imgstyle.' + s.id) : '') || s.label;
    if (styleBox && !styleBox.dataset.i18nBound) styleBox.dataset.i18nBound = '1';
    (API_CONFIG.image.stylePresets || []).forEach((s, i) => {
        styleBox.appendChild(el('span', {
            class: 'is-chip' + (i === 0 ? ' on' : ''),
            text: styleLabel(s), title: s.prompt || t('is.noStyle'),
            onclick: () => { IMGST.style = s.id; _isMarkChip(styleBox, styleLabel(s)); },
        }));
    });
    const aspBox = $('is-aspects');
    aspects.forEach(a => aspBox.appendChild(el('span', {
        class: 'is-chip' + (a === IMGST.aspect ? ' on' : ''), text: a,
        onclick: () => { IMGST.aspect = a; _isMarkChip(aspBox, a); },
    })));
    const szBox = $('is-sizes');
    sizes.forEach(s => szBox.appendChild(el('span', {
        class: 'is-chip' + (s === IMGST.size ? ' on' : ''), text: s,
        onclick: () => { IMGST.size = s; _isMarkChip(szBox, s); },
    })));
    _isRenderModelSelect();
    _isRenderSizeChips();

    // ─── 裁切比例下拉 ───
    const lockSel = $('is-crop-lock');
    IS_LOCKS.forEach(l => lockSel.appendChild(el('option', { value: l.id, text: l.label })));
    lockSel.addEventListener('change', () => {
        if (!IMGST.crop) return;
        _isConstrain('se');
        _isRenderCrop();
    });

// ─── 事件 ───
    const prompt = $('is-prompt');
    prompt.addEventListener('input', () => { _isAutoGrow(prompt); _isRenderPromptInfo(); });
    $('is-optimize').addEventListener('click', _isOptimizePrompt);
    $('is-copy').addEventListener('click', () => {
        const p = _isFinalPrompt();
        if (!p) { toast(t('is.needPrompt'), 'warn'); return; }
        copyText(p);
    });
    $('is-gen').addEventListener('click', _isGenerate);
    const cutBtn = $('is-cutout');
    const paintCut = () => {
        if (!cutBtn) return;
        cutBtn.classList.toggle('on', IMGST.cutout);
        cutBtn.textContent = IMGST.cutout ? t('is.cutoutOn') : t('is.cutout');
    };
    paintCut();
    cutBtn?.addEventListener('click', () => {
        IMGST.cutout = !IMGST.cutout;
        paintCut();
        _isRenderPromptInfo();
    });

    $('is-ref-input').addEventListener('change', async (e) => {
        await _isAddRefFiles(Array.from(e.target.files || []));
        e.target.value = '';
    });
    $('is-pick-ref').addEventListener('click', () => _isOpenPicker('ref'));

    $('is-close').addEventListener('click', _isRequestClose);
    root.addEventListener('mousedown', (e) => { if (e.target === root) _isRequestClose(); });

    $('is-undo').addEventListener('click', _isUndo);
    $('is-redo').addEventListener('click', _isRedo);
    $('is-save').addEventListener('click', _isSaveToWorkspace);
    $('is-download').addEventListener('click', _isDownloadCurrent);

    $('is-crop-toggle').addEventListener('click', () => _isSetCropMode(!IMGST.cropOn));
    $('is-crop-apply').addEventListener('click', _isApplyCrop);
    $('is-crop-reset').addEventListener('click', () => { _isResetCrop(); _isRenderCrop(); });
    $('is-bottom-toggle')?.addEventListener('click', () => $('is-bottom')?.classList.toggle('is-collapsed'));
    $('is-gallery-toggle')?.addEventListener('click', () => $('is-gallery')?.classList.toggle('is-collapsed'));

    // 裁切框拖曳（框身移動 + 8 個把手）
    const box = $('is-crop-box');
    box.addEventListener('pointerdown', (e) => {
        const h = e.target.closest('.is-h');
        _isDragStart(e, h ? h.dataset.h : 'move');
    });
    // 在空白處拖曳 = 重新框選
    $('is-frame').addEventListener('pointerdown', (e) => {
        if (!IMGST.cropOn || e.target.closest('.is-crop-box')) return;
        const r = $('is-img').getBoundingClientRect();
        IMGST.crop = { x: e.clientX - r.left, y: e.clientY - r.top, w: IS_MIN_CROP, h: IS_MIN_CROP };
        _isRenderCrop();
        _isDragStart(e, 'se');
    });

    // 縮放控制
    const wIn = $('is-rw'), hIn = $('is-rh');
    wIn.addEventListener('input', () => {
        if (!IMGST.lockRatio || !IMGST.natural.w) return;
        const w = parseInt(wIn.value, 10);
        if (w > 0) hIn.value = Math.max(1, Math.round(w * IMGST.natural.h / IMGST.natural.w));
    });
    hIn.addEventListener('input', () => {
        if (!IMGST.lockRatio || !IMGST.natural.h) return;
        const h = parseInt(hIn.value, 10);
        if (h > 0) wIn.value = Math.max(1, Math.round(h * IMGST.natural.w / IMGST.natural.h));
    });
    const lockBtn = $('is-lock');
    const paintLock = () => {
        lockBtn.classList.toggle('btn-primary', IMGST.lockRatio);
        lockBtn.classList.toggle('btn-ghost', !IMGST.lockRatio);
    };
    lockBtn.addEventListener('click', () => { IMGST.lockRatio = !IMGST.lockRatio; paintLock(); });
    paintLock();
    $('is-fit').addEventListener('change', (e) => { IMGST.fit = e.target.value; });
    $('is-resize').addEventListener('click', _isApplyResize);
    $$('[data-preset]', root).forEach(b => b.addEventListener('click', () => _isPreset(parseInt(b.dataset.preset, 10), false)));
    $$('[data-icon]', root).forEach(b => b.addEventListener('click', () => _isPreset(parseInt(b.dataset.icon, 10), true)));

    $('is-fmt').addEventListener('change', (e) => {
        IMGST.fmt = e.target.value;
        $('is-qwrap').classList.toggle('is-hide', IMGST.fmt === 'png');
        _isEstimateSoon();
    });
    $('is-q').addEventListener('input', (e) => {
        IMGST.quality = parseInt(e.target.value, 10) / 100;
        $('is-qv').textContent = e.target.value;
        _isEstimateSoon();
    });

    // 圖片顯示尺寸改變時等比重算裁切框
    const img = $('is-img');
    if (typeof ResizeObserver !== 'undefined') {
        IMGST.ro = new ResizeObserver(() => _isRescaleCrop());
        IMGST.ro.observe(img);
    } else {
        window.addEventListener('resize', () => _isRescaleCrop());
    }

    IMGST.mounted = true;
    _isRenderRefs();
    _isRenderGallery();
    _isRenderUndoButtons();
}

// ─── 繪圖模型下拉（頂部列；清單跟模型管理面板同一份）───
// _isMount 只跑一次，面板新增模型後重開工作室要重建選項，所以渲染獨立成函式。
// 注意：必須是頂層函式 —— openImageStudio 每次開啟都會呼叫，包在 _isMount
// 裡面會變成區域函式，外部呼叫直接 ReferenceError。
function _isRenderModelSelect() {
    const sel = $('is-model');
    if (!sel) return;
    sel.innerHTML = '';
    const list = (API_CONFIG.imageModels || []).filter(m => !m.hidden);
    const primary = (typeof primaryImageModel === 'function' ? primaryImageModel() : '') || list[0]?.id || '';
    if (!list.find(m => m.id === IMGST.model)) IMGST.model = primary;
    if (!list.length) {
        sel.appendChild(el('option', { value: '', text: t('is.noImgModel') }));
        sel.disabled = true;
        return;
    }
    sel.disabled = false;
    list.forEach(m => sel.appendChild(el('option', {
        value: m.id, text: m.displayName || m.id,
    })));
    sel.value = IMGST.model;
    sel.onchange = () => { IMGST.model = sel.value; _isRenderSizeChips(); };
}

// 解析度 chips 按當前模型切換：muse 系（直連 meta 或 OpenRouter 的 meta/muse-image）
// 顯示官方三檔，Gemini 與 OR 版 gpt-image 維持 1K/2K 制（gpt-image 的 size 轉 quality 送出）。注意 OpenRouter 版 /v1/images 不吃 size 參數，
// chips 純粹是選擇記錄（存檔命名／切回直連版時沿用），不影響本次請求。
function _isRenderSizeChips() {
    const box = $('is-sizes');
    if (!box) return;
    box.innerHTML = '';
    const isMuse = /muse-image/i.test(IMGST.model || '')
        || (typeof getProviderForModel === 'function' ? getProviderForModel(IMGST.model) : '') === 'meta';
    const list = isMuse
        ? (API_CONFIG.image.metaSizes || ['1024x1024'])
        : (API_CONFIG.image.sizes || ['2K']);
    const fallback = isMuse ? (API_CONFIG.image.defaultMetaSize || list[0]) : (API_CONFIG.image.defaultSize || list[0]);
    if (!list.includes(IMGST.size)) IMGST.size = fallback;
    list.forEach(s => box.appendChild(el('span', {
        class: 'is-chip' + (s === IMGST.size ? ' on' : ''), text: s,
        onclick: () => { IMGST.size = s; _isMarkChip(box, s); },
    })));
}

function _isMarkChip(box, label) {
    $$('.is-chip', box).forEach(c => c.classList.toggle('on', c.textContent === label));
}

// ═══════════════════════════════════════════════════════════════
// 提示詞
// ═══════════════════════════════════════════════════════════════

// 組出實際會送給繪圖模型的完整提示詞（生成與「複製完整提示詞」共用，兩者必然一致）
// 去背開啟時自動加綠幕指示（照抄 OneClickSticker 的 buildInstruction：純 #00FF00 平面背景＋主體禁用綠色）
const IS_CUTOUT_SUFFIX = '\nThe background MUST be one solid pure chroma green (#00FF00), completely flat, no gradient, no pattern, no shadow on the background. '
    + 'Do not use any green colour on the subject, clothing, hair or accessories — green must appear only in the background. '
    + 'Composition: single subject, centred, with clear empty margin on all four sides.';

function _isFinalPrompt() {
    const user = ($('is-prompt')?.value || '').trim();
    const preset = (API_CONFIG.image.stylePresets || []).find(s => s.id === IMGST.style);
    const style = preset?.prompt || '';
    let full = (style + user).trim();
    if (IMGST.cutout && full) full += IS_CUTOUT_SUFFIX;
    return full;
}

function _isRenderPromptInfo() {
    const n = $('is-ptok');
    if (!n) return;
    const p = _isFinalPrompt();
    n.textContent = p ? t('is.chars', { n: p.length }) : '';
}

async function _isOptimizePrompt() {
    const ta = $('is-prompt');
    const raw = (ta?.value || '').trim();
    if (!raw) { toast(t('is.needDraw'), 'warn'); return; }
    const btn = $('is-optimize');
    const html = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>${esc(t('is.optimizing'))}`;
    try {
        const out = await callOnce(
            `你是專業的 AI 繪圖提示詞工程師。把下面的需求改寫成一段高品質的英文 image prompt。\n`
            + `要求：\n`
            + `1. 只輸出提示詞本身，不要任何說明、引號、標題或條列。\n`
            + `2. 具體描述主體、材質、動作、構圖視角、鏡頭、光線、配色、背景與整體氛圍。\n`
            + `3. 60～120 個英文單字，用逗號分隔的短語，不要寫成句子。\n`
            + `4. 除非需求明確要求，否則加上 "no text, no watermark, no letters"。\n\n`
            + `需求：${raw}`,
            { model: pickFeatureModel('imagePrompt'), maxTokens: 600 });
        const clean = String(out || '').replace(/^```[a-z]*\s*|```\s*$/gi, '').trim();
        if (!clean) throw new Error(t('is.noModelOut'));
        ta.value = clean;
        _isAutoGrow(ta);
        _isRenderPromptInfo();
        toast(t('is.optimized'), 'success');
    } catch (e) {
        if (e.code === 'NO_KEY') { window.openKeysModal?.(); toast(e.message, 'warn'); }
        else toast(t('is.optFail', { msg: e.message }), 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = html;
    }
}

// ═══════════════════════════════════════════════════════════════
// 參考圖
// ═══════════════════════════════════════════════════════════════
async function _isAddRefFiles(files) {
    const refs = OC.imageStudio.refs;
    for (const f of files) {
        if (refs.length >= IS_REF_MAX) { toast(t('is.refMax', { n: IS_REF_MAX }), 'warn'); break; }
        if (!f || !/^image\//.test(f.type || '')) continue;
        try {
            const dataUrl = await compressImageFile(f, 1536, 0.86);
            const { mime, data } = splitDataUrl(dataUrl);
            refs.push({ dataUrl, mime, data, name: f.name || t('is.refDefault') });
        } catch (e) { toast(t('is.refReadFail', { n: f.name }), 'error'); }
    }
    _isRenderRefs();
}

async function _isAddRefPath(path) {
    const refs = OC.imageStudio.refs;
    if (refs.length >= IS_REF_MAX) { toast(t('is.refMax', { n: IS_REF_MAX }), 'warn'); return; }
    try {
        const r = await FS.readB64(path, 8 * 1024 * 1024);
        const dataUrl = `data:${r.mime};base64,${r.data}`;
        refs.push({ dataUrl, mime: r.mime, data: r.data, name: baseName(path) });
        _isRenderRefs();
        toast(t('is.refAdded', { n: baseName(path) }), 'success', 1800);
    } catch (e) { toast(t('is.readFail', { msg: e.message }), 'error'); }
}

function _isRenderRefs() {
    const box = $('is-refs'), add = $('is-ref-add');
    if (!box || !add) return;
    $$('.is-ref', box).forEach(n => n.remove());
    OC.imageStudio.refs.forEach((r, i) => {
        const node = el('div', { class: 'is-ref', title: r.name || '' },
            el('img', { src: r.dataUrl, alt: '' }),
            el('button', {
                class: 'is-ref-x', text: '×', title: t('is.refRemove'),
                onclick: () => { OC.imageStudio.refs.splice(i, 1); _isRenderRefs(); },
            })
        );
        box.insertBefore(node, add);
    });
    add.classList.toggle('is-hide', OC.imageStudio.refs.length >= IS_REF_MAX);
}

// ═══════════════════════════════════════════════════════════════
// 生成
// ═══════════════════════════════════════════════════════════════
async function _isGenerate() {
    if (IMGST.busy) { IMGST.abort?.abort(); return; }
    const prompt = _isFinalPrompt();
    if (!prompt) { toast(t('is.needPrompt'), 'warn'); $('is-prompt')?.focus(); return; }

    const btn = $('is-gen');
    IMGST.busy = true;
    IMGST.abort = new AbortController();
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-danger');
    btn.innerHTML = `<span class="spinner"></span>${esc(t('is.genStop'))}`;
    imageStudioNote(t('is.generating', { p: prompt.slice(0, 70) + (prompt.length > 70 ? '…' : '') }));

    const t0 = Date.now();
    try {
        const refs = OC.imageStudio.refs.map(r => ({ mime: r.mime, data: r.data, label: r.name }));
        // 512 綠邊太多挖不乾淨，去背時自動提到 1K 並告知（僅 Gemini 標籤；Meta 三檔不動）
        let size = IMGST.size;
        if (IMGST.cutout && size === '512') {
            size = '1K';
            toast(t('is.cutMin'), 'info', 2600);
        }
        const img = await generateImage({
            prompt, refs, aspect: IMGST.aspect, size, model: IMGST.model || undefined, signal: IMGST.abort.signal,
        });
        imageStudioAdd(img.dataUrl, prompt, '');
        // 去背：失敗就保留原圖，不擋流程（跟 OneClickSticker 同一策略）
        let finalUrl = img.dataUrl, cutMsg = '';
        if (IMGST.cutout) {
            try {
                imageStudioNote(t('is.cutoutDoing'));
                finalUrl = await _isChromaKey(img.dataUrl);
                cutMsg = t('is.cutDone');
            } catch (e) {
                toast(t('is.cutFailKeep', { msg: e.message }), 'warn', 4200);
            }
            imageStudioAdd(finalUrl, prompt + t('is.cutSuffix'), '');
        }
        await _isLoadImage(finalUrl, { fresh: true });
        imageStudioNote(t('is.doneIn', { cut: cutMsg, d: fmtDur(Date.now() - t0), extra: img.text ? '｜' + img.text.slice(0, 80) : '' }));
        toast(t('is.generated', { cut: cutMsg }), 'success');
    } catch (e) {
        if (e.name === 'AbortError') { imageStudioNote(t('is.aborted')); }
        else if (e.code === 'NO_KEY') {
            imageStudioNote(e.message);
            window.openKeysModal?.();
            toast(e.message, 'warn', 5000);
        } else {
            imageStudioNote(t('is.genFail', { msg: e.message }));
            errorTicker(t('is.genFail', { msg: '' }).replace(/：.*$/, '').replace(/:.*$/, '') || 'Image', e.detail || e.message);
        }
    } finally {
        IMGST.busy = false;
        IMGST.abort = null;
        btn.classList.remove('btn-danger');
        btn.classList.add('btn-primary');
        btn.innerHTML = `<span class="ms">brush</span>${esc(t('is.gen'))}`;
    }
}

// ═══════════════════════════════════════════════════════════════
// 工作區圖片載入 / 復原堆疊
// ═══════════════════════════════════════════════════════════════

// fresh:true = 全新的圖（清空復原堆疊、視為未編輯）
async function _isLoadImage(dataUrl, { fresh = false, push = false } = {}) {
    _isMount();
    if (push && OC.imageStudio.current) _isPushUndo(OC.imageStudio.current);
    if (fresh) { IMGST.undo = []; IMGST.redo = []; IMGST.dirty = false; }

    OC.imageStudio.current = dataUrl;
    const img = $('is-img');
    img.src = dataUrl;
    $('is-frame').classList.remove('is-hide');
    $('is-placeholder').classList.add('is-hide');

    let dim = { width: 0, height: 0 };
    try { dim = await imageSize(dataUrl); } catch {}
    IMGST.natural = { w: dim.width, h: dim.height };
    $('is-rw').value = dim.width || '';
    $('is-rh').value = dim.height || '';

    // 換圖後原本的裁切框已無意義
    IMGST.crop = null;
    IMGST.disp = { w: 0, h: 0 };
    if (IMGST.cropOn) { _isResetCrop(); }
    _isRenderCrop();
    _isRenderUndoButtons();
    _isRenderGallery();
    _isEstimateSoon();
    _isRenderRead();
    // 成果回到舞台頂部：換圖後捲軸若停在舊位置，使用者會以為拿到一張空白圖
    $('is-stage').scrollTop = 0;
    $('is-stage').scrollLeft = 0;
}

function _isPushUndo(dataUrl) {
    if (!dataUrl) return;
    IMGST.undo.push(dataUrl);
    if (IMGST.undo.length > IS_UNDO_MAX) IMGST.undo.shift();
    IMGST.redo = [];
    _isRenderUndoButtons();
}

async function _isUndo() {
    if (!IMGST.undo.length) return;
    if (OC.imageStudio.current) IMGST.redo.push(OC.imageStudio.current);
    const prev = IMGST.undo.pop();
    await _isLoadImage(prev);
    IMGST.dirty = IMGST.undo.length > 0;
    _isRenderUndoButtons();
}

async function _isRedo() {
    if (!IMGST.redo.length) return;
    if (OC.imageStudio.current) {
        IMGST.undo.push(OC.imageStudio.current);
        if (IMGST.undo.length > IS_UNDO_MAX) IMGST.undo.shift();
    }
    const next = IMGST.redo.pop();
    await _isLoadImage(next);
    IMGST.dirty = true;
    _isRenderUndoButtons();
}

function _isRenderUndoButtons() {
    const u = $('is-undo'), r = $('is-redo');
    if (u) u.disabled = !IMGST.undo.length;
    if (r) r.disabled = !IMGST.redo.length;
}

// ═══════════════════════════════════════════════════════════════
// 裁切
// ═══════════════════════════════════════════════════════════════

function _isSetCropMode(on) {
    if (on && !OC.imageStudio.current) { toast(t('is.needImg'), 'warn'); return; }
    IMGST.cropOn = on;
    $('is-crop-toggle').classList.toggle('btn-primary', on);
    $('is-crop-toggle').classList.toggle('btn-ghost', !on);
    ['is-crop-lock', 'is-crop-apply', 'is-crop-reset'].forEach(id => $(id)?.classList.toggle('is-hide', !on));
    if (on && !IMGST.crop) _isResetCrop();
    _isRenderCrop();
}

// 預設框選整張圖（並套用目前的鎖定比例）
function _isResetCrop() {
    const r = $('is-img')?.getBoundingClientRect();
    if (!r || !r.width) return;
    IMGST.crop = { x: 0, y: 0, w: r.width, h: r.height };
    IMGST.disp = { w: r.width, h: r.height };
    _isConstrain('se');
}

// 目前鎖定比例（寬/高，null = 自由）
function _isRatio() {
    const id = $('is-crop-lock')?.value || 'free';
    const found = IS_LOCKS.find(l => l.id === id);
    if (!found || found.r === null) return null;
    if (found.r === 'orig') return IMGST.natural.h ? IMGST.natural.w / IMGST.natural.h : null;
    return found.r;
}

// 依鎖定比例修正裁切框，並夾回圖片範圍內
// mode 用來決定「哪一邊固定」：包含 n → 底邊固定；包含 w → 右邊固定
function _isConstrain(mode = 'se') {
    if (!IMGST.crop) return;
    const r = $('is-img')?.getBoundingClientRect();
    if (!r || !r.width) return;
    const B = { w: r.width, h: r.height };
    const c = IMGST.crop;
    const R = _isRatio();

    const right = c.x + c.w, bottom = c.y + c.h;
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;

    if (R) {
        const horiz = /[ew]/.test(mode), vert = /[ns]/.test(mode);
        if (horiz && !vert) { c.h = c.w / R; c.y = cy - c.h / 2; }
        else if (vert && !horiz) { c.w = c.h * R; c.x = cx - c.w / 2; }
        else { c.h = c.w / R; if (mode.includes('n')) c.y = bottom - c.h; }
        if (mode.includes('w')) c.x = right - c.w;

        // 超出可視範圍就等比縮小（維持比例是硬條件）
        const s = Math.min(1, B.w / c.w, B.h / c.h);
        if (s < 1) { c.w *= s; c.h = c.w / R; }
        if (c.w < IS_MIN_CROP) { c.w = IS_MIN_CROP; c.h = c.w / R; }
        if (c.h < IS_MIN_CROP) { c.h = IS_MIN_CROP; c.w = c.h * R; }
    } else {
        c.w = Math.max(IS_MIN_CROP, Math.min(c.w, B.w));
        c.h = Math.max(IS_MIN_CROP, Math.min(c.h, B.h));
    }

    c.x = Math.max(0, Math.min(c.x, B.w - c.w));
    c.y = Math.max(0, Math.min(c.y, B.h - c.h));
}

function _isDragStart(e, mode) {
    if (!IMGST.cropOn || !IMGST.crop) return;
    e.preventDefault();
    e.stopPropagation();
    IMGST.drag = { mode, sx: e.clientX, sy: e.clientY, rect: { ...IMGST.crop } };
    window.addEventListener('pointermove', _isDragMove);
    window.addEventListener('pointerup', _isDragEnd);
    window.addEventListener('pointercancel', _isDragEnd);
}

function _isDragMove(e) {
    const d = IMGST.drag;
    if (!d) return;
    const r = $('is-img').getBoundingClientRect();
    const B = { w: r.width, h: r.height };
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    const s = d.rect;

    if (d.mode === 'move') {
        IMGST.crop = {
            x: Math.max(0, Math.min(s.x + dx, B.w - s.w)),
            y: Math.max(0, Math.min(s.y + dy, B.h - s.h)),
            w: s.w, h: s.h,
        };
        _isRenderCrop();
        return;
    }

    const c = { ...s };
    const right = s.x + s.w, bottom = s.y + s.h;
    if (d.mode.includes('w')) { c.x = Math.max(0, Math.min(s.x + dx, right - IS_MIN_CROP)); c.w = right - c.x; }
    if (d.mode.includes('e')) { c.w = Math.max(IS_MIN_CROP, Math.min(s.w + dx, B.w - c.x)); }
    if (d.mode.includes('n')) { c.y = Math.max(0, Math.min(s.y + dy, bottom - IS_MIN_CROP)); c.h = bottom - c.y; }
    if (d.mode.includes('s')) { c.h = Math.max(IS_MIN_CROP, Math.min(s.h + dy, B.h - c.y)); }

    IMGST.crop = c;
    _isConstrain(d.mode);
    _isRenderCrop();
}

function _isDragEnd() {
    IMGST.drag = null;
    window.removeEventListener('pointermove', _isDragMove);
    window.removeEventListener('pointerup', _isDragEnd);
    window.removeEventListener('pointercancel', _isDragEnd);
}

// 圖片顯示尺寸改變（視窗縮放、左欄捲動）→ 等比搬移裁切框
function _isRescaleCrop() {
    const img = $('is-img');
    if (!img) return;
    const r = img.getBoundingClientRect();
    if (!r.width || !r.height) return;
    if (IMGST.crop && IMGST.disp.w && IMGST.disp.h) {
        const sx = r.width / IMGST.disp.w, sy = r.height / IMGST.disp.h;
        IMGST.crop.x *= sx; IMGST.crop.w *= sx;
        IMGST.crop.y *= sy; IMGST.crop.h *= sy;
    }
    IMGST.disp = { w: r.width, h: r.height };
    _isRenderCrop();
}

function _isRenderCrop() {
    const box = $('is-crop-box');
    if (!box) return;
    const show = IMGST.cropOn && !!IMGST.crop && !!OC.imageStudio.current;
    box.classList.toggle('is-hide', !show);
    if (show) {
        box.style.left = IMGST.crop.x + 'px';
        box.style.top = IMGST.crop.y + 'px';
        box.style.width = IMGST.crop.w + 'px';
        box.style.height = IMGST.crop.h + 'px';
    }
    _isRenderRead();
}

// 螢幕座標 → 原圖像素（讀數與實際裁切共用同一個換算，確保所見即所得）
function _isCropOriginal() {
    if (!IMGST.crop || !IMGST.natural.w) return null;
    const r = $('is-img').getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const sx = IMGST.natural.w / r.width, sy = IMGST.natural.h / r.height;
    let x = Math.round(IMGST.crop.x * sx);
    let y = Math.round(IMGST.crop.y * sy);
    let w = Math.round(IMGST.crop.w * sx);
    let h = Math.round(IMGST.crop.h * sy);
    x = Math.max(0, Math.min(x, IMGST.natural.w - 1));
    y = Math.max(0, Math.min(y, IMGST.natural.h - 1));
    w = Math.max(1, Math.min(w, IMGST.natural.w - x));
    h = Math.max(1, Math.min(h, IMGST.natural.h - y));
    return { x, y, w, h };
}

function _isRenderRead() {
    const n = $('is-read');
    if (!n) return;
    if (!OC.imageStudio.current) { n.textContent = t('is.noImg'); return; }
    const base = t('is.readOrig', { w: IMGST.natural.w, h: IMGST.natural.h });
    if (IMGST.cropOn && IMGST.crop) {
        const c = _isCropOriginal();
        if (c) { n.textContent = `x ${c.x}, y ${c.y}, w ${c.w}, h ${c.h}　｜　${base}`; return; }
    }
    n.textContent = base;
}

async function _isApplyCrop() {
    const c = _isCropOriginal();
    if (!c) { toast(t('is.noCrop'), 'warn'); return; }
    if (c.w === IMGST.natural.w && c.h === IMGST.natural.h) { toast(t('is.cropSame'), 'info'); return; }
    try {
        // 同縮放：中間結果保持 PNG，避免反覆有損壓縮
        const out = await cropDataUrl(OC.imageStudio.current, c.x, c.y, c.w, c.h, 'image/png', 1);
        await _isLoadImage(out, { push: true });
        IMGST.dirty = true;
        _isSetCropMode(false);
        toast(t('is.cropped', { w: c.w, h: c.h }), 'success');
    } catch (e) { toast(t('is.cropFail', { msg: e.message }), 'error'); }
}

// ═══════════════════════════════════════════════════════════════
// 縮放 / 格式
// ═══════════════════════════════════════════════════════════════
function _isPreset(n, isIcon) {
    if (!IMGST.natural.w) { toast(t('is.needImg2'), 'warn'); return; }
    if (isIcon) {
        // 圖示一律正方形；非正方原圖用 cover 裁滿比拉伸自然
        $('is-rw').value = n;
        $('is-rh').value = n;
        if (IMGST.natural.w !== IMGST.natural.h && IMGST.fit === 'stretch') {
            IMGST.fit = 'cover';
            $('is-fit').value = 'cover';
        }
        return;
    }
    // 以長邊為準等比縮放
    const long = Math.max(IMGST.natural.w, IMGST.natural.h);
    const s = n / long;
    $('is-rw').value = Math.max(1, Math.round(IMGST.natural.w * s));
    $('is-rh').value = Math.max(1, Math.round(IMGST.natural.h * s));
}

async function _isApplyResize() {
    if (!OC.imageStudio.current) { toast(t('is.needImg2'), 'warn'); return; }
    const w = parseInt($('is-rw').value, 10);
    const h = parseInt($('is-rh').value, 10);
    if (!w || w < 1) { toast(t('is.badW'), 'warn'); return; }
    if (w === IMGST.natural.w && h === IMGST.natural.h) { toast(t('is.sizeSame'), 'info'); return; }
    try {
        // 編輯過程一律保持 PNG 無損，格式與品質只在存檔／下載時才套用
        const out = await resizeDataUrl(OC.imageStudio.current, w, h || 0, IMGST.fit, 'image/png', 1);
        await _isLoadImage(out, { push: true });
        IMGST.dirty = true;
        toast(t('is.resized', { w: IMGST.natural.w, h: IMGST.natural.h }), 'success');
    } catch (e) { toast(t('is.resizeFail', { msg: e.message }), 'error'); }
}

// 依目前格式 / 品質重新編碼（存檔與下載都走這裡，估算大小也是）
async function _isEncode() {
    const src = OC.imageStudio.current;
    if (!src) return '';
    const mime = 'image/' + IMGST.fmt;
    if (IMGST.fmt === 'png' && splitDataUrl(src).mime === 'image/png') return src;
    return resizeDataUrl(src, IMGST.natural.w, IMGST.natural.h, 'stretch', mime, IMGST.quality);
}

const _isEstimateSoon = debounce(async () => {
    const n = $('is-est');
    if (!n) return;
    if (!OC.imageStudio.current) { n.textContent = ''; return; }
    try {
        const out = await _isEncode();
        n.textContent = t('is.about', { s: fmtBytes(_isBytes(out)) });
    } catch { n.textContent = ''; }
}, 320);

// ═══════════════════════════════════════════════════════════════
// 存檔 / 下載
// ═══════════════════════════════════════════════════════════════
function _isDefaultPath() {
    const ext = IMGST.fmt === 'jpeg' ? 'jpg' : IMGST.fmt;
    const src = ($('is-prompt')?.value || '').trim()
        || OC.imageStudio.images.find(i => i.dataUrl === OC.imageStudio.current)?.prompt
        || '';
    return `assets/images/${_isSlug(src)}-${_isStamp()}.${ext}`;
}

async function _isSaveToWorkspace(dataUrl) {
    const src = (typeof dataUrl === 'string' && dataUrl) ? dataUrl : OC.imageStudio.current;
    if (!src) { toast(t('is.noSaveImg'), 'warn'); return; }
    const path = await _isWithModal(() => promptModal(
        t('is.saveT2'), t('is.savePathLab'), _isDefaultPath(),
        { okText: t('common.save'), hint: t('is.saveHint') }));
    if (path === null) return;
    const clean = String(path).trim().replace(/^[/\\]+/, '');
    if (!clean) { toast(t('is.pathEmpty'), 'warn'); return; }
    try {
        const out = (src === OC.imageStudio.current) ? await _isEncode() : src;
        await FS.writeB64(clean, out, true);
        IMGST.dirty = false;
        const item = OC.imageStudio.images.find(i => i.dataUrl === src);
        if (item) item.path = clean;
        _isRenderGallery();
        toast(t('is.saved', { p: clean, s: fmtBytes(_isBytes(out)) }), 'success');
        window.refreshFileTreeSoon?.();
        window.touchFile?.(clean);
    } catch (e) {
        toast(t('is.saveFail', { msg: e.message }), 'error');
        errorTicker(t('is.saveFail', { msg: '' }).replace(/：.*$/, '').replace(/:.*$/, '') || 'Image', e.detail || e.message);
    }
}

async function _isDownloadCurrent() {
    if (!OC.imageStudio.current) { toast(t('is.noDlImg'), 'warn'); return; }
    try {
        const out = await _isEncode();
        const ext = IMGST.fmt === 'jpeg' ? 'jpg' : IMGST.fmt;
        _isDownload(`${_isSlug(($('is-prompt')?.value || ''))}-${_isStamp()}.${ext}`, out);
    } catch (e) { toast(t('is.dlFail', { msg: e.message }), 'error'); }
}

// ═══════════════════════════════════════════════════════════════
// 畫廊（本次會話產生的所有圖片）
// ═══════════════════════════════════════════════════════════════
function _isRenderGallery() {
    const box = $('is-gallery');
    if (!box) return;
    box.innerHTML = '';
    const list = OC.imageStudio.images;
    if (!list.length) {
        box.appendChild(el('div', { class: 'is-gempty', text: t('is.gEmpty') }));
        return;
    }
    list.forEach((it) => {
        const item = el('div', {
            class: 'is-gitem' + (it.dataUrl === OC.imageStudio.current ? ' on' : ''),
            title: (it.prompt || '').slice(0, 160) + (it.path ? '\n' + t('is.savedAt', { p: it.path }) : ''),
            onclick: () => _isLoadImage(it.dataUrl, { fresh: true }),
        },
            el('img', { src: it.dataUrl, alt: '' }),
            el('div', { class: 'is-gcap', text: it.w ? `${it.w}×${it.h}` : (it.path ? baseName(it.path) : '') }),
            el('div', { class: 'is-gover' },
                el('button', {
                    class: 'is-gbtn', title: t('is.loadWs'),
                    onclick: (e) => { e.stopPropagation(); _isLoadImage(it.dataUrl, { fresh: true }); },
                }, el('span', { class: 'ms', text: 'open_in_full' })),
                el('button', {
                    class: 'is-gbtn', title: t('is.saveToWs'),
                    onclick: (e) => { e.stopPropagation(); _isSaveToWorkspace(it.dataUrl); },
                }, el('span', { class: 'ms', text: 'save' })),
                el('button', {
                    class: 'is-gbtn', title: t('is.rmGallery'),
                    onclick: (e) => {
                        e.stopPropagation();
                        const i = OC.imageStudio.images.indexOf(it);
                        if (i >= 0) OC.imageStudio.images.splice(i, 1);
                        _isRenderGallery();
                    },
                }, el('span', { class: 'ms', text: 'delete' }))
            )
        );
        box.appendChild(item);
    });
}

// ═══════════════════════════════════════════════════════════════
// 工作區圖片選擇器
// ═══════════════════════════════════════════════════════════════
async function _isOpenPicker(mode) {
    _isMount();
    $('is-picker')?.remove();
    IMGST.pickerMode = mode;

    const list = el('div', { class: 'is-picker-list' }, el('div', { class: 'is-gempty', text: t('is.searching') }));
    const filter = el('input', { class: 'inp', id: 'is-picker-q', placeholder: t('is.filterPh') });
    const panel = el('div', { class: 'is-picker', id: 'is-picker' },
        el('div', { class: 'is-picker-head' },
            el('span', { class: 'ms', text: 'folder_open' }),
            filter,
            el('button', {
                class: 'btn-icon', title: t('is.close'),
                onclick: () => panel.remove(),
            }, el('span', { class: 'ms', text: 'close' }))
        ),
        list
    );
    $1('.is-shell', $('image-studio'))?.appendChild(panel);
    setTimeout(() => filter.focus(), 60);

    let files = [];
    try {
        const r = await FS.glob('**/*.{png,jpg,jpeg,webp}', '', 400);
        files = r.files || [];
        if (!files.length) {
            // 後端若不支援大括號展開，改逐一副檔名查詢
            const parts = await Promise.all(
                ['png', 'jpg', 'jpeg', 'webp'].map(e => FS.glob(`**/*.${e}`, '', 150).catch(() => ({ files: [] })))
            );
            files = parts.flatMap(p => p.files || []);
        }
    } catch (e) {
        list.innerHTML = '';
        list.appendChild(el('div', { class: 'is-gempty', text: t('is.searchFail', { msg: e.message }) }));
        return;
    }
    const draw = (q) => {
        const needle = String(q || '').toLowerCase();
        const shown = needle ? files.filter(f => f.toLowerCase().includes(needle)) : files;
        list.innerHTML = '';
        if (!shown.length) {
            list.appendChild(el('div', { class: 'is-gempty', text: t('is.noWsImg') }));
            return;
        }
        shown.slice(0, 300).forEach(f => {
            list.appendChild(el('div', {
                class: 'is-pk', title: f,
                onclick: async () => {
                    panel.remove();
                    if (IMGST.pickerMode === 'ref') await _isAddRefPath(f);
                    else await _isOpenWorkspaceImage(f);
                },
            },
                el('span', { class: 'ms', text: fileIcon(f, 'file') }),
                el('span', { class: 'p', text: shortPath(f, 62) })
            ));
        });
    };
    draw('');
    filter.addEventListener('input', debounce(() => draw(filter.value), 160));
}

async function _isOpenWorkspaceImage(path) {
    try {
        const r = await FS.readB64(path, 20 * 1024 * 1024);
        const dataUrl = `data:${r.mime};base64,${r.data}`;
        imageStudioAdd(dataUrl, t('is.wsImg', { p: path }), path);
        await _isLoadImage(dataUrl, { fresh: true });
    } catch (e) { toast(t('is.readFail', { msg: e.message }), 'error'); }
}

// ═══════════════════════════════════════════════════════════════
// 開關與快捷鍵
// ═══════════════════════════════════════════════════════════════
async function _isRequestClose() {
    if (IMGST.busy) {
        const stop = await _isWithModal(() => confirmModal('圖片還在生成中', '關閉工作室會一併中止生成，確定嗎？', { okText: '中止並關閉', danger: true }));
        if (!stop) return;
        IMGST.abort?.abort();
    } else if (IMGST.dirty) {
        const ok = await _isWithModal(() => confirmModal('尚未存檔', '你對圖片做的編輯還沒存入工作區，關閉後會遺失（畫廊仍保留原圖）。確定關閉嗎？', { okText: '關閉', danger: true }));
        if (!ok) return;
    }
    closeImageStudio();
}

function _isKeydown(e) {
    if (!IMGST.open) return;
    const root = $('image-studio');
    // 若上面還疊著別的 modal（存檔／確認對話框），交給它處理
    // 不用 topModal() 判斷，因為 #image-studio 在 DOM 中的位置由 index.html 決定
    if ($$('.modal-overlay.active').some(m => m !== root)) return;

    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        _isRequestClose();
        return;
    }
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '');
    if ((e.ctrlKey || e.metaKey) && !inField) {
        const k = e.key.toLowerCase();
        if (k === 'z' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); _isUndo(); }
        else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); e.stopPropagation(); _isRedo(); }
        else if (k === 's') { e.preventDefault(); e.stopPropagation(); _isSaveToWorkspace(); }
    }
}

// ═══════════════════════════════════════════════════════════════
// 對外 API
// ═══════════════════════════════════════════════════════════════

function initImageStudio() {
    _isMount();
    if (!IMGST.keysBound) {
        // 捕獲階段攔截，才能在 app.js 的全域快捷鍵之前處理 Esc / Ctrl+Z
        document.addEventListener('keydown', _isKeydown, true);
        IMGST.keysBound = true;
    }
}

function openImageStudio(prompt) {
    _isMount();
    _isRenderModelSelect();
    _isRenderSizeChips();
    openModal('image-studio');
    IMGST.open = true;
    if (prompt) {
        const ta = $('is-prompt');
        if (ta) { ta.value = String(prompt); _isAutoGrow(ta); _isRenderPromptInfo(); }
    }
    _isRenderRefs();
    _isRenderGallery();
    _isRenderUndoButtons();
    // 顯示後才量得到圖片尺寸
    requestAnimationFrame(() => { _isRescaleCrop(); _isRenderRead(); });
    setTimeout(() => $('is-prompt')?.focus(), 80);
}

async function openImageStudioWith(dataUrl) {
    if (!dataUrl) { openImageStudio(); return; }
    openImageStudio();
    if (!OC.imageStudio.images.some(i => i.dataUrl === dataUrl)) imageStudioAdd(dataUrl, '', '');
    await _isLoadImage(dataUrl, { fresh: true });
}

function closeImageStudio() {
    closeModal('image-studio');
    $('is-picker')?.remove();
    IMGST.open = false;
}

// tools.js 的 generate_image / edit_image 會呼叫這裡，讓 Agent 產生的圖自動進畫廊
function imageStudioAdd(dataUrl, prompt = '', savedPath = '') {
    if (!dataUrl) return null;
    _isMount();
    const item = {
        id: uid('img-'),
        dataUrl,
        prompt: String(prompt || ''),
        path: String(savedPath || ''),
        ts: Date.now(),
        w: 0, h: 0,
    };
    OC.imageStudio.images.unshift(item);
    if (OC.imageStudio.images.length > 60) OC.imageStudio.images.length = 60;
    imageSize(dataUrl).then(d => { item.w = d.width; item.h = d.height; _isRenderGallery(); }).catch(() => {});
    _isRenderGallery();
    // 工作室開著時直接換到新圖，關著就只進畫廊
    if (IMGST.open && !IMGST.dirty) _isLoadImage(dataUrl, { fresh: true });
    return item;
}

function imageStudioNote(text) {
    _isMount();
    const n = $('is-note');
    if (!n) return;
    n.textContent = String(text || '');
    n.classList.add('on');
    setTimeout(() => n.classList.remove('on'), 2400);
}

Object.assign(window, {
    openImageStudio, openImageStudioWith, imageStudioAdd, studioChromaKey: _isChromaKey,
    imageStudioNote, closeImageStudio, initImageStudio,
});
