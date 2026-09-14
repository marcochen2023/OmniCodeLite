'use strict';
// ═══════════════════════════════════════════════════════════════
// Omni Code — 模型管理（註冊表 + 面板）
// ═══════════════════════════════════════════════════════════════
// 讓使用者完全掌控模型清單：文字模型與繪圖模型都能任意新增／編輯／刪除
// （包含出廠內建的那些），並指定 Agent 生圖時固定使用的「主要繪圖模型」。
// 每 1M token 的 IN/OUT 價格也在這裡填，流量面板才算得出錢。
//
// 儲存：data/models.json 是唯一的真相來源，存「完整清單」而不是差異。
//
//   {
//     "version": 2,
//     "primaryImageModel": "gemini-3.1-flash-image",
//     "models":      [ {id, displayName, provider, context, multimodal, tools,
//                       thinking?, effortMax?, tier?, costIn, costOut, hidden} ],
//     "imageModels": [ {id, displayName, provider, costImage, hidden} ],
//     "providers":       { '<內建供應商 id>': {label?, endpoint?, …覆寫欄位} },
//     "customProviders": [ {id, label, endpoint, format, …} ]
//   }
//
// 為什麼從「差異疊加」改成「完整清單」：
//   舊格式把內建模型當成不可刪、不可改 id 的基底，使用者只能藏起來。
//   結果是清單裡永遠躺著一堆用不到的出廠模型，想把 id 改成新版號也不行。
//   完整清單讓內建只是「第一次的種子」——之後它跟自訂模型沒有任何差別。
//   代價是內建清單日後更新不會自動出現在既有使用者的清單裡；
//   這由「還原」（單一模型）與「還原成內建清單」（整份）補回來。
//
// 舊格式（overrides / custom / customImage / imageOverrides）第一次載入時
// 自動轉換並回存，之後就不再出現。
//
// 價格單位一律「美金 / 1M tokens」；繪圖模型是「美金 / 張」。
// 沒填價格 = null（未知），不是 0 —— 流量面板會明白標示「未設價格」，
// 絕不把未知當成免費。
// ═══════════════════════════════════════════════════════════════

const MODEL_CFG_VERSION = 2;

function defaultModelConfig() {
    return {
        version: MODEL_CFG_VERSION,
        primaryImageModel: '',
        models: null,          // null = 尚未種入，rebuild 時用內建清單填
        imageModels: null,
        providers: {},
        customProviders: [],
    };
}

// 內建清單的深拷貝（種子）。內建模型從此只是「第一份資料」，
// 不再有任何特殊地位。
function seedModels()      { return API_CONFIG.builtinModels.map(m => ({ ...m, hidden: !!m.hidden })); }
function seedImageModels() { return API_CONFIG.builtinImageModels.map(m => ({ ...m, hidden: !!m.hidden })); }

/** 舊格式（v1：差異疊加）→ 新格式（v2：完整清單） */
function migrateModelConfigV1(old) {
    const models = [];
    for (const b of API_CONFIG.builtinModels) {
        const ov = (old.overrides && old.overrides[b.id]) || {};
        models.push({ ...b, ...ov });
    }
    for (const m of (Array.isArray(old.custom) ? old.custom : [])) {
        if (!m || !m.id) continue;
        const i = models.findIndex(x => x.id === m.id);
        if (i >= 0) models[i] = { ...models[i], ...m };
        else models.push({ ...m });
    }
    const imageModels = [];
    for (const b of API_CONFIG.builtinImageModels) {
        const ov = (old.imageOverrides && old.imageOverrides[b.id]) || {};
        imageModels.push({ ...b, ...ov });
    }
    for (const m of (Array.isArray(old.customImage) ? old.customImage : [])) {
        if (!m || !m.id) continue;
        const i = imageModels.findIndex(x => x.id === m.id);
        if (i >= 0) imageModels[i] = { ...imageModels[i], ...m };
        else imageModels.push({ ...m });
    }
    return {
        version: MODEL_CFG_VERSION,
        primaryImageModel: OC.cfg.imageModel || '',
        models, imageModels,
        providers: (old.providers && !Array.isArray(old.providers)) ? old.providers : {},
        customProviders: Array.isArray(old.customProviders) ? old.customProviders : [],
    };
}

/** 正規化成 v2；回傳 true 表示做了轉換（呼叫端應回存）。 */
function normalizeModelConfig() {
    let c = OC.cfg.modelConfig;
    let changed = false;
    if (!c || typeof c !== 'object' || Array.isArray(c)) { c = defaultModelConfig(); changed = true; }

    const looksV1 = !Array.isArray(c.models) && (c.overrides !== undefined || c.custom !== undefined);
    if (looksV1) { c = migrateModelConfigV1(c); changed = true; }

    if (c.version !== MODEL_CFG_VERSION) { c.version = MODEL_CFG_VERSION; changed = true; }
    // PHP 把空物件存成 [] —— 讀回來要把陣列型的「物件欄位」修回物件
    if (!c.providers || typeof c.providers !== 'object' || Array.isArray(c.providers)) { c.providers = {}; changed = true; }
    if (!Array.isArray(c.customProviders)) { c.customProviders = []; changed = true; }
    if (!Array.isArray(c.models))      { c.models = seedModels();           changed = true; }
    if (!Array.isArray(c.imageModels)) { c.imageModels = seedImageModels(); changed = true; }
    // 清掉壞資料：沒有 id 的項目留著只會讓面板炸掉
    const beforeM = c.models.length, beforeI = c.imageModels.length;
    c.models      = c.models.filter(m => m && typeof m.id === 'string' && m.id.trim());
    c.imageModels = c.imageModels.filter(m => m && typeof m.id === 'string' && m.id.trim());
    if (c.models.length !== beforeM || c.imageModels.length !== beforeI) changed = true;

    if (typeof c.primaryImageModel !== 'string') { c.primaryImageModel = ''; changed = true; }
    const visibleImg = c.imageModels.filter(m => !m.hidden);
    if (!visibleImg.find(m => m.id === c.primaryImageModel)) {
        // 主要模型被刪或被藏 → 換第一個可見的；一個都沒有就清空
        const next = visibleImg[0]?.id || '';
        if (next !== c.primaryImageModel) { c.primaryImageModel = next; changed = true; }
    }
    OC.cfg.modelConfig = c;
    return changed;
}

function modelCfg() {
    normalizeModelConfig();
    return OC.cfg.modelConfig;
}

// ─── 供應商：內建 + 使用者覆寫 + 自訂 ───────────────────────────
// 端點在設定裡是字串，這裡轉回 API_CONFIG 期待的函式形式。
// 字串可用 {model} 佔位符（Gemini 那種要把模型放進 URL 的才需要）。
function endpointFn(url) {
    const u = String(url || '');
    return (model) => u.replace(/\{model\}/g, encodeURIComponent(model || ''));
}

function rebuildProviders() {
    if (!API_CONFIG.builtinProviders) {
        API_CONFIG.builtinProviders = JSON.parse(JSON.stringify(
            Object.fromEntries(Object.entries(API_CONFIG.providers).map(([k, v]) => [k, {
                ...v,
                endpoint: undefined, streamEndpoint: undefined, imagenEndpoint: undefined,
                _endpointStr: typeof v.endpoint === 'function' ? v.endpoint('{model}') : '',
            }]))
        ));
        // 函式無法 JSON 序列化，另外留一份原始函式
        API_CONFIG._builtinFns = Object.fromEntries(Object.entries(API_CONFIG.providers)
            .map(([k, v]) => [k, { endpoint: v.endpoint, streamEndpoint: v.streamEndpoint, imagenEndpoint: v.imagenEndpoint }]));
    }
    const c = modelCfg();
    const out = {};

    for (const [id, base] of Object.entries(API_CONFIG.builtinProviders)) {
        const fns = API_CONFIG._builtinFns[id] || {};
        const ov = c.providers[id] || {};
        const merged = { ...base, ...ov, _builtin: true };
        // 使用者改過端點就用字串版，沒改就用原本的函式（保留 Gemini 的特殊組法）
        merged.endpoint = ov.endpoint ? endpointFn(ov.endpoint) : fns.endpoint;
        merged.streamEndpoint = ov.streamEndpoint ? endpointFn(ov.streamEndpoint) : fns.streamEndpoint;
        merged.imagenEndpoint = fns.imagenEndpoint;
        out[id] = merged;
    }
    for (const pv of c.customProviders) {
        if (!pv || !pv.id) continue;
        out[pv.id] = {
            ...pv,
            label: pv.label || pv.id,
            keyName: pv.keyName || ('oc_' + pv.id + '_key'),
            format: pv.format || 'openai',
            endpoint: endpointFn(pv.endpoint),
            _builtin: false, _custom: true,
        };
    }
    API_CONFIG.providers = out;
    return out;
}

// 數值欄位：空字串 / 非數字 → null（未知），不要變成 0
function numOrNull(v) {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

// ─── 重建 API_CONFIG.models / imageModels / allModels ───────────
// 所有既有呼叫點（模型選單、getModelInfo、availableModels…）都直接
// 讀 API_CONFIG.models，所以這裡改一次，全域就生效，不必動其他檔案。
function rebuildModels() {
    rebuildProviders();
    const c = modelCfg();
    const builtinIds    = new Set(API_CONFIG.builtinModels.map(m => m.id));
    const builtinImgIds = new Set(API_CONFIG.builtinImageModels.map(m => m.id));

    // _builtin 現在只代表「出廠清單裡有同 id 的項目」——用來決定要不要
    // 給「還原」按鈕。它不再限制任何操作。
    API_CONFIG.allModels = c.models.map(m => ({ ...m, _builtin: builtinIds.has(m.id), _custom: !builtinIds.has(m.id) }));
    API_CONFIG.models    = API_CONFIG.allModels.filter(m => !m.hidden);

    API_CONFIG.allImageModels = c.imageModels.map(m => ({ ...m, _builtin: builtinImgIds.has(m.id), _custom: !builtinImgIds.has(m.id) }));
    API_CONFIG.imageModels    = API_CONFIG.allImageModels.filter(m => !m.hidden);

    // 目前選的文字模型被隱藏或刪掉了 → 換一個可用的，否則整個 App 會卡在不存在的模型上
    if (!API_CONFIG.models.find(m => m.id === OC.cfg.model)) {
        const fallback = (typeof availableModels === 'function' ? availableModels() : API_CONFIG.models)[0]
                      || API_CONFIG.models[0];
        if (fallback) OC.cfg.model = fallback.id;
    }
    // 主要繪圖模型：models.json 是真相，OC.cfg.imageModel 只是給 api.js 用的鏡像
    OC.cfg.imageModel = c.primaryImageModel || '';
    return API_CONFIG.models;
}

/** 每次編輯都立刻回存 data/models.json（完整清單、價格、隱藏、主要繪圖模型、供應商）。
 *  目前選用的文字模型仍屬「偏好」，留在 config.json；
 *  imageModel 同步寫一份到 config.json 純粹是為了 api.js 既有的讀法。 */
let _mdlSaving = 0;     // >0 = 有存檔請求在飛；期間磁碟上的舊內容不能蓋掉記憶體

async function saveModelConfig() {
    rebuildModels();
    window.renderModelButton?.();
    window.renderEffortButton?.();
    window.renderThinkButton?.();
    // ★ 這裡只重畫，不呼叫 renderModelsPanel()。
    //   renderModelsPanel 會順手從磁碟重讀 models.json —— 那個 GET 常常比
    //   下面的 POST 先回來，於是「舊的磁碟內容」把剛改好的記憶體蓋掉，
    //   使用者按了「設為主要」卻看到什麼都沒變，要再開一次面板才對。
    window.paintCurrentModel?.();
    window.paintModels?.();
    _mdlSaving++;
    try {
        await Promise.all([
            SETTINGS.modelsSave(modelCfg()),
            SETTINGS.set({ model: OC.cfg.model, imageModel: OC.cfg.imageModel }),
        ]);
    } catch (e) { toast(t('models.saveFail', { msg: e.message }), 'error', 6000); }
    finally { _mdlSaving--; }
}

/** 從 data/models.json 重新載入。開啟模型管理面板時會呼叫，
 *  所以在外部直接編輯過 models.json，回到面板就會看到最新內容。 */
async function loadModelConfig({ silent = true } = {}) {
    try {
        const r = await SETTINGS.modelsGet();
        // 存檔還沒落地就別用磁碟上的舊內容覆蓋記憶體（見 saveModelConfig 的說明）
        if (_mdlSaving > 0) return OC.cfg.modelConfig;
        if (r.models && typeof r.models === 'object') {
            OC.cfg.modelConfig = r.models;
            const converted = normalizeModelConfig();
            rebuildModels();
            window.renderModelButton?.();
            window.renderEffortButton?.();
            // 剛做了格式轉換或種入 → 立刻寫回，讓檔案跟記憶體一致
            if (converted) {
                SETTINGS.modelsSave(modelCfg()).catch(e => console.warn('[models] 轉換後回存失敗', e.message));
                if (!silent) toast(t('models.migrated'), 'info', 4000);
            }
        }
        if (r.migrated && !silent) toast(t('models.moved'), 'info', 4000);
        return OC.cfg.modelConfig;
    } catch (e) {
        // 讀不到就沿用記憶體裡的設定 —— 這裡失敗不該讓面板打不開
        console.warn('[models] 讀取 models.json 失敗', e.message);
        return null;
    }
}

// ─── 價格查詢（流量記錄與面板共用）───────────────────────────
// 回傳 {in, out, image}，未設定為 null
function modelRates(mid) {
    const m = API_CONFIG.allModels?.find(x => x.id === mid)
           || API_CONFIG.allImageModels?.find(x => x.id === mid)
           || getModelInfo(mid);
    return {
        in:    numOrNull(m?.costIn),
        out:   numOrNull(m?.costOut),
        image: numOrNull(m?.costImage),
    };
}

// 全部模型的價格表（給「重算歷史成本」用）
function allModelRates() {
    const out = {};
    for (const m of [...(API_CONFIG.allModels || []), ...(API_CONFIG.allImageModels || [])]) {
        const r = modelRates(m.id);
        if (r.in !== null || r.out !== null || r.image !== null) {
            out[m.id] = { in: r.in, out: r.out, image: r.image };
        }
    }
    return out;
}

/** 主要繪圖模型（Agent 生圖固定用它） */
function primaryImageModel() {
    return modelCfg().primaryImageModel || '';
}

async function setPrimaryImageModel(id) {
    const c = modelCfg();
    const m = c.imageModels.find(x => x.id === id);
    if (!m) { toast(t('models.noModel'), 'warn'); return false; }
    if (m.hidden) m.hidden = false;      // 設為主要的模型不該是隱藏的
    c.primaryImageModel = id;
    await saveModelConfig();
    toast(t('models.primaryToast', { name: m.displayName || id }), 'success', 2500);
    return true;
}

// ═══════════════════════════════════════════════════════════════
// 面板
// ═══════════════════════════════════════════════════════════════

let _mdlFilter = '';
let _mdlProvFilter = '';   // 供應商過濾（文字／繪圖分頁右上的 select，'' = 全部）
let _mdlTab = 'llm';       // llm | image | provider
let _mdlLoading = false;   // 防止面板重畫時重複發請求

function modelsHost() {
    const host = $('panel-models');
    if (!host) return null;
    if (host.dataset.ready === '1') return host;
    host.dataset.ready = '1';
    host.innerHTML = '';

    host.appendChild(el('div', { class: 'panel-head' },
        el('span', { class: 'panel-title' },
            el('span', { class: 'ms', text: 'tune' }),
            el('span', { text: t('panel.models') })),
        el('div', { class: 'panel-head-acts' },
            el('button', {
                class: 'btn btn-xs btn-ghost', title: t('models.new'),
                onclick: () => (_mdlTab === 'provider' ? openProviderEditor(null) : openModelEditor(null)),
            }, el('span', { class: 'ms', text: 'add' }), el('span', { text: t('models.new') })),
            el('button', {
                class: 'btn-icon', title: t('models.reset'),
                onclick: () => resetModelConfig(),
            }, el('span', { class: 'ms', text: 'restart_alt' }))
        )
    ));

    // 目前使用中的模型 —— 「模型 API 的選擇」搬到這裡，
    // 頂列只留一顆顯示用的膠囊鈕（Claude Code 的做法：狀態列顯示、選單切換）
    host.appendChild(el('div', { class: 'mdl-current', id: 'mdl-current' }));

    // 分頁：文字模型 / 繪圖模型 / 供應商
    host.appendChild(el('div', { class: 'mdl-tabs' },
        el('button', { class: 'mdl-tab active', 'data-tab': 'llm',
            onclick: () => { _mdlTab = 'llm'; renderModelsPanel(); },
        }, el('span', { class: 'ms', text: 'smart_toy' }), el('span', { text: t('models.tabLlm') })),
        el('button', { class: 'mdl-tab', 'data-tab': 'image',
            onclick: () => { _mdlTab = 'image'; renderModelsPanel(); },
        }, el('span', { class: 'ms', text: 'imagesmode' }), el('span', { text: t('models.tabImage') })),
        el('button', { class: 'mdl-tab', 'data-tab': 'provider',
            onclick: () => { _mdlTab = 'provider'; renderModelsPanel(); },
        }, el('span', { class: 'ms', text: 'lan' }), el('span', { text: t('models.tabProv') }))
    ));

    host.appendChild(el('div', { class: 'panel-search' },
        el('span', { class: 'ms', text: 'search' }),
        el('input', {
            class: 'inp', id: 'mdl-search', placeholder: t('models.searchPh'),
            oninput: (e) => { _mdlFilter = e.target.value.trim().toLowerCase(); paintModels(); },
        }),
        el('select', {
            class: 'sel sel-sm mdl-prov-filter', id: 'mdl-prov-filter', title: t('models.tabProv'),
            onchange: (e) => { _mdlProvFilter = e.target.value; paintModels(); },
        })
    ));

    host.appendChild(el('div', { class: 'panel-body', id: 'models-body' },
        el('div', { class: 'mdl-list', id: 'mdl-list' })
    ));
    return host;
}

function renderModelsPanel() {
    let host = modelsHost();
    if (!host) return;
    // 語系切換 → 靜態外殼（標頭／分頁／搜尋列）要重建，否則只換動態清單
    try {
        const loc = (typeof oc_locale === 'function' ? oc_locale() : 'en');
        if (host.dataset.loc && host.dataset.loc !== loc) {
            delete host.dataset.ready; host.innerHTML = '';
            host = modelsHost();
        }
        if (host) host.dataset.loc = loc;
    } catch {}
    if (!host) return;
    syncProvFilter();
    // 每次進面板都重讀一次 models.json（非同步，回來後再重畫一次）
    if (!_mdlLoading) {
        _mdlLoading = true;
        loadModelConfig().then(() => { _mdlLoading = false; paintCurrentModel(); paintModels(); })
                         .catch(() => { _mdlLoading = false; });
    }
    for (const b of $$('.mdl-tab', host)) b.classList.toggle('active', b.dataset.tab === _mdlTab);
    paintCurrentModel();
    paintModels();
}

/** 面板頂端的「目前使用中」卡片：文字模型 + Effort；繪圖分頁時改顯示主要繪圖模型。 */
function paintCurrentModel() {
    const box = $('mdl-current');
    if (!box) return;
    box.innerHTML = '';

    if (_mdlTab === 'image') {
        const pid = primaryImageModel();
        const pm = (API_CONFIG.allImageModels || []).find(m => m.id === pid);
        box.appendChild(el('div', { class: 'mdl-cur-lab', text: t('models.currentImg') }));
        box.appendChild(el('button', {
            class: 'mdl-cur-btn', title: t('models.findPrimary'),
            onclick: () => $('mdl-search')?.focus(),
        },
            el('span', { class: 'ms', text: 'imagesmode' }),
            el('span', { class: 'mdl-cur-name', text: pm ? (pm.displayName || pm.id) : t('models.noPrimary') }),
        ));
        if (!pm) {
            box.appendChild(el('div', { class: 'hint', text: t('models.noPrimaryHint') }));
        }
        return;
    }

    const info = getModelInfo(OC.cfg.model);
    const eff = window.resolveEffort ? resolveEffort(OC.cfg.model, OC.cfg.effortLevel) : OC.cfg.effortLevel;
    const L = API_CONFIG.effort.levels[eff] || {};

    box.appendChild(el('div', { class: 'mdl-cur-lab', text: t('models.current') }));
    box.appendChild(el('button', {
        class: 'mdl-cur-btn', title: t('models.switchModel'),
        onclick: () => window.openModelPicker?.(),
    },
        el('span', { class: 'ms', text: 'smart_toy' }),
        el('span', { class: 'mdl-cur-name', text: info.displayName || OC.cfg.model }),
        el('span', { class: 'ms mdl-cur-caret', text: 'expand_more' })
    ));
    box.appendChild(el('button', {
        class: 'mdl-cur-eff', title: t('models.switchEffort'),
        onclick: () => window.openEffortPicker?.(),
    },
        el('span', { class: 'ms', text: L.icon || 'neurology', style: `color:${L.color || 'var(--accent)'}` }),
        el('span', { text: 'Effort：' + (L.label || eff) })
    ));
}

/** 供應商下拉：只在文字／繪圖分頁顯示；選項是該分頁實際出現的供應商，第一項為「全部」。 */
function syncProvFilter() {
    const sel = $('mdl-prov-filter');
    if (!sel) return;
    const isModelTab = _mdlTab === 'llm' || _mdlTab === 'image';
    sel.style.display = isModelTab ? '' : 'none';
    if (!isModelTab) return;
    const list = (_mdlTab === 'image' ? API_CONFIG.allImageModels : API_CONFIG.allModels) || [];
    const seen = [];
    for (const m of list) {
        if (!m || seen.includes(m.provider)) continue;
        seen.push(m.provider);
    }
    if (_mdlProvFilter && !seen.includes(_mdlProvFilter)) _mdlProvFilter = '';
    sel.innerHTML = '';
    sel.appendChild(el('option', { value: '', text: t('models.allProv') }));
    for (const id of seen) {
        sel.appendChild(el('option', {
            value: id, text: API_CONFIG.providers[id]?.label || id,
            selected: _mdlProvFilter === id || undefined,
        }));
    }
    sel.value = _mdlProvFilter;
}

function paintModels() {
    const box = $('mdl-list');
    if (!box) return;
    if (_mdlTab === 'provider') { syncProvFilter(); paintProviders(); return; }
    syncProvFilter();
    box.innerHTML = '';

    const isImg = _mdlTab === 'image';
    const list = (isImg ? API_CONFIG.allImageModels : API_CONFIG.allModels) || [];
    const configured = new Set(configuredProviders());

    const shown = list.filter(m => {
        if (_mdlProvFilter && m.provider !== _mdlProvFilter) return false;
        if (!_mdlFilter) return true;
        return m.id.toLowerCase().includes(_mdlFilter)
            || String(m.displayName || '').toLowerCase().includes(_mdlFilter);
    });

    if (!shown.length) {
        box.appendChild(el('div', { class: 'panel-empty' },
            el('span', { class: 'ms', text: 'search_off' }),
            el('span', { text: (_mdlFilter || _mdlProvFilter) ? t('models.noMatch') : t('models.emptyHint') })));
        return;
    }

    // 依供應商分組
    const groups = {};
    for (const m of shown) (groups[m.provider] ||= []).push(m);

    for (const [prov, items] of Object.entries(groups)) {
        const label = API_CONFIG.providers[prov]?.label || prov;
        const hasKey = configured.has(prov);
        box.appendChild(el('div', { class: 'mdl-group' },
            el('span', { text: label }),
            el('span', { class: 'mdl-group-n', text: `${items.length}` }),
            hasKey ? null : el('span', { class: 'mdl-nokey', text: t('models.noKey') })
        ));
        for (const m of items) box.appendChild(modelRow(m, isImg));
    }

    // 沒填價格的提醒 —— 這直接影響流量面板算不算得出錢
    const unpriced = list.filter(m => {
        const r = modelRates(m.id);
        return isImg ? r.image === null : (r.in === null || r.out === null);
    });
    if (unpriced.length) {
        box.appendChild(el('div', { class: 'mdl-warn' },
            el('span', { class: 'ms', text: 'info' }),
            el('span', { text: t('models.unpriced', { n: unpriced.length }) })
        ));
    }
}

function modelRow(m, isImg) {
    const r = modelRates(m.id);
    const priced = isImg ? r.image !== null : (r.in !== null && r.out !== null);
    const isPrimary = isImg && m.id === primaryImageModel();

    const row = el('div', { class: 'card mdl-item' + (m.hidden ? ' hidden-model' : '') + (isPrimary ? ' mdl-primary-row' : '') });

    row.appendChild(el('div', { class: 'mdl-head' },
        el('button', {
            class: 'mdl-eye' + (m.hidden ? '' : ' on'),
            title: m.hidden ? t('common.show') : t('common.hide'),
            onclick: () => toggleModelHidden(m.id, isImg),
        }, el('span', { class: 'ms', text: m.hidden ? 'visibility_off' : 'visibility' })),
        el('div', { class: 'mdl-names' },
            el('div', { class: 'mdl-name', text: m.displayName || m.id }),
            el('div', { class: 'mdl-id', title: m.id, text: m.id })
        ),
        m._custom ? el('span', { class: 'chip mdl-badge', text: t('models.custom') }) : null,
        (!isImg && m.id === OC.cfg.model) ? el('span', { class: 'chip mdl-badge mdl-inuse', text: t('models.inuse') }) : null,
        isPrimary ? el('span', { class: 'chip mdl-badge mdl-inuse', title: t('models.currentImg'), text: t('models.primary') }) : null
    ));

    const meta = el('div', { class: 'mdl-meta' });
    if (!isImg) {
        if (m.context) meta.appendChild(el('span', { class: 'chip', text: t('models.ctx', { n: fmtTokens(m.context) }) }));
        if (m.multimodal) meta.appendChild(el('span', { class: 'chip', text: t('models.vision') }));
        if (m.tools === false) meta.appendChild(el('span', { class: 'chip chip-warn', text: t('models.noTools') }));
        if (m.thinking === false) meta.appendChild(el('span', { class: 'chip chip-warn', text: t('models.noThink') }));
        else if (m.effortMax) meta.appendChild(el('span', { class: 'chip', text: t('models.effortMax', { label: API_CONFIG.effort.levels[m.effortMax]?.label || m.effortMax }) }));
    }
    row.appendChild(meta);

    // 價格
    const price = el('div', { class: 'mdl-price' + (priced ? '' : ' unset') });
    if (isImg) {
        price.appendChild(el('span', { class: 'mdl-price-k', text: t('models.perImg') }));
        price.appendChild(el('span', { class: 'mdl-price-v', text: r.image === null ? t('models.unset') : '$' + r.image }));
    } else {
        price.appendChild(el('span', { class: 'mdl-price-k', text: t('models.priceIn') }));
        price.appendChild(el('span', { class: 'mdl-price-v', text: r.in === null ? t('models.unset') : '$' + r.in }));
        price.appendChild(el('span', { class: 'mdl-price-sep', text: '/' }));
        price.appendChild(el('span', { class: 'mdl-price-k', text: t('models.priceOut') }));
        price.appendChild(el('span', { class: 'mdl-price-v', text: r.out === null ? t('models.unset') : '$' + r.out }));
        price.appendChild(el('span', { class: 'mdl-price-u', text: t('models.perM') }));
    }
    row.appendChild(price);

    const acts = el('div', { class: 'mdl-acts' });
    if (isImg && !isPrimary) {
        acts.appendChild(el('button', {
            class: 'btn btn-xs btn-ghost', title: t('models.currentImg'),
            onclick: () => setPrimaryImageModel(m.id),
        }, el('span', { class: 'ms', text: 'star' }), el('span', { text: t('models.setPrimary') })));
    }
    acts.appendChild(el('button', { class: 'btn btn-xs btn-ghost', onclick: () => openModelEditor(m.id, isImg) },
        el('span', { class: 'ms', text: 'edit' }), el('span', { text: t('common.edit') })));
    if (m._builtin) {
        acts.appendChild(el('button', {
            class: 'btn btn-xs btn-ghost', title: t('common.revert'),
            onclick: () => revertModel(m.id, isImg),
        }, el('span', { class: 'ms', text: 'restart_alt' }), el('span', { text: t('common.revert') })));
    }
    acts.appendChild(el('button', {
        class: 'btn btn-xs btn-ghost mdl-del', title: t('common.del'),
        onclick: () => deleteModel(m.id, isImg),
    }, el('span', { class: 'ms', text: 'delete' }), el('span', { text: '刪除' })));
    row.appendChild(acts);

    return row;
}

// ─── 動作 ───────────────────────────────────────────────────────

function listOf(isImg) { const c = modelCfg(); return isImg ? c.imageModels : c.models; }

function toggleModelHidden(id, isImg) {
    const t = listOf(isImg).find(m => m.id === id);
    if (!t) return;
    t.hidden = !t.hidden;
    saveModelConfig();
}

/** 把有內建同 id 的模型還原成出廠值（自訂模型沒有出廠值，按鈕不會出現） */
async function revertModel(id, isImg) {
    const seed = (isImg ? API_CONFIG.builtinImageModels : API_CONFIG.builtinModels).find(m => m.id === id);
    if (!seed) { toast(t('models.noBuiltin'), 'info'); return; }
    const arr = listOf(isImg);
    const i = arr.findIndex(m => m.id === id);
    if (i >= 0) arr[i] = { ...seed, hidden: false };
    else arr.push({ ...seed, hidden: false });
    await saveModelConfig();
    toast(t('models.restoredBuiltin'), 'success');
}

async function deleteModel(id, isImg) {
    const c = modelCfg();
    const isPrimary = isImg && c.primaryImageModel === id;
    const inUse = !isImg && OC.cfg.model === id;
    const ok = await confirmModal(t('models.delModelT'),
        t('models.delModelB', { id: esc(id) })
        + (inUse ? t('models.delModelInUse') : '')
        + (isPrimary ? t('models.delModelPrimary') : ''),
        { okText: t('common.del'), danger: true });
    if (!ok) return;
    const key = isImg ? 'imageModels' : 'models';
    c[key] = c[key].filter(m => m.id !== id);
    await saveModelConfig();       // normalize 會處理主要繪圖模型／使用中模型的遞補
    toast(t('common.deleted'), 'success');
}

async function resetModelConfig() {
    const ok = await confirmModal(t('models.resetT'),
        t('models.resetB'),
        { okText: t('models.resetOk'), danger: true });
    if (!ok) return;
    OC.cfg.modelConfig = defaultModelConfig();
    await saveModelConfig();
    toast(t('models.restoredList'), 'success');
}

// ─── 編輯 / 新增 ────────────────────────────────────────────────

function openModelEditor(id, isImg = _mdlTab === 'image') {
    const list = (isImg ? API_CONFIG.allImageModels : API_CONFIG.allModels) || [];
    const m = id ? list.find(x => x.id === id) : null;
    const isNew = !m;
    const r = m ? modelRates(m.id) : { in: null, out: null, image: null };

    const provOpts = Object.entries(API_CONFIG.providers)
        .map(([k, p]) => `<option value="${k}"${(m?.provider || (isImg ? 'gemini' : 'anthropic')) === k ? ' selected' : ''}>${esc(p.label)}</option>`)
        .join('');

    $('modal-generic-title').textContent = isNew
        ? (isImg ? '新增繪圖模型' : '新增文字模型')
        : `編輯：${m.displayName || m.id}`;

    $('modal-generic-body').innerHTML = `
      <div class="mdl-form">
        <div class="ig">
          <label>模型編號（API 實際使用的 ID）</label>
          <input class="inp" id="mf-id" value="${esc(m?.id || '')}" placeholder="${isImg ? 'gemini-3.1-flash-image' : 'claude-sonnet-5'}">
          ${m ? '<div class="hint">改編號等於換一個模型：舊編號的用量紀錄仍會以舊編號顯示。</div>' : ''}
        </div>
        <div class="ig">
          <label>顯示名稱</label>
          <input class="inp" id="mf-name" value="${esc(m?.displayName || '')}" placeholder="選單上顯示的名字">
        </div>
        <div class="ig">
          <label>供應商</label>
          <select class="sel" id="mf-prov">${provOpts}</select>
          ${isImg ? '<div class="hint">目前生圖只走 Gemini 的 generateContent 端點；其他供應商的繪圖模型可以先登錄，但 Agent 還無法用它們生圖。</div>' : ''}
        </div>
        ${isImg ? '' : `
        <div class="ig ig-row">
          <div>
            <label>上下文長度（tokens）</label>
            <input class="inp" id="mf-ctx" type="number" min="0" value="${m?.context ?? ''}" placeholder="200000">
          </div>
          <div class="ig-checks">
            <label><input type="checkbox" id="mf-mm"${m?.multimodal !== false ? ' checked' : ''}> 支援看圖</label>
            <label><input type="checkbox" id="mf-tools"${m?.tools !== false ? ' checked' : ''}> 支援工具呼叫</label>
            <label><input type="checkbox" id="mf-think"${m?.thinking !== false ? ' checked' : ''}> 支援延伸推理</label>
          </div>
        </div>`}

        <div class="mdl-form-sec">價格（美金）</div>
        ${isImg ? `
        <div class="ig">
          <label>每張圖片成本（USD）</label>
          <input class="inp" id="mf-cimg" type="number" step="0.0001" min="0" value="${r.image ?? ''}" placeholder="例如 0.04">
        </div>` : `
        <div class="ig ig-row">
          <div>
            <label>輸入 IN（USD / 1M tokens）</label>
            <input class="inp" id="mf-cin" type="number" step="0.01" min="0" value="${r.in ?? ''}" placeholder="例如 3">
          </div>
          <div>
            <label>輸出 OUT（USD / 1M tokens）</label>
            <input class="inp" id="mf-cout" type="number" step="0.01" min="0" value="${r.out ?? ''}" placeholder="例如 15">
          </div>
        </div>`}
        ${isImg ? `
        <div class="ig ig-check">
          <label><input type="checkbox" id="mf-primary"${(m && m.id === primaryImageModel()) ? ' checked' : ''}>
            設為主要繪圖模型 <span class="dim">（Agent 生圖固定使用）</span></label>
        </div>` : ''}
        <div class="hint">
          留空代表「未設定價格」——流量面板會標示為未計價，<b>不會</b>當成 $0。
          價格請以你的供應商帳單為準，各家與各方案都不同。
        </div>
      </div>`;

    const acts = $('modal-generic-actions');
    acts.innerHTML = '';
    acts.appendChild(el('button', { class: 'btn btn-ghost', text: '取消', onclick: () => closeModal('modal-generic') }));
    acts.appendChild(el('button', {
        class: 'btn btn-primary', text: isNew ? '新增' : '儲存',
        onclick: () => saveModelEditor(m, isImg),
    }));
    openModal('modal-generic');
    setTimeout(() => $(isNew ? 'mf-id' : 'mf-name')?.focus(), 60);
}

async function saveModelEditor(existing, isImg) {
    const id = ($('mf-id')?.value || '').trim();
    if (!id) { toast(t('models.idEmpty'), 'warn'); return; }
    if (/\s/.test(id)) { toast(t('models.idSpace'), 'warn'); return; }

    const name = ($('mf-name')?.value || '').trim() || id;
    const prov = $('mf-prov')?.value || (isImg ? 'gemini' : 'anthropic');

    const c = modelCfg();
    const arr = listOf(isImg);
    const oldId = existing?.id || null;

    // 編號衝突：新增時不能撞既有；編輯改編號時不能撞「別的」模型
    if (arr.some(m => m.id === id && m.id !== oldId)) {
        toast(t('models.idDup', { id }), 'warn');
        return;
    }

    // 從既有項目起手，保留這個表單沒列出的欄位（tier、effortMax、_builtin 之外的自訂鍵…）
    const base = oldId ? (arr.find(m => m.id === oldId) || {}) : {};
    const entry = { ...base, id, displayName: name, provider: prov, hidden: !!base.hidden };
    if (isImg) {
        entry.costImage = numOrNull($('mf-cimg')?.value);
    } else {
        const ctx = numOrNull($('mf-ctx')?.value);
        if (ctx) entry.context = ctx; else delete entry.context;
        entry.multimodal = !!$('mf-mm')?.checked;
        entry.tools      = !!$('mf-tools')?.checked;
        entry.thinking   = !!$('mf-think')?.checked;
        entry.costIn     = numOrNull($('mf-cin')?.value);
        entry.costOut    = numOrNull($('mf-cout')?.value);
    }
    // _builtin / _custom 是 rebuild 時算出來的，不該落地
    delete entry._builtin; delete entry._custom;

    const i = oldId ? arr.findIndex(m => m.id === oldId) : -1;
    if (i >= 0) arr[i] = entry; else arr.push(entry);

    // 改了編號要把指向它的地方一起搬
    if (oldId && oldId !== id) {
        if (!isImg && OC.cfg.model === oldId) OC.cfg.model = id;
        if (isImg && c.primaryImageModel === oldId) c.primaryImageModel = id;
    }
    if (isImg && $('mf-primary')?.checked) { entry.hidden = false; c.primaryImageModel = id; }
    // 第一個繪圖模型自動成為主要
    if (isImg && !c.primaryImageModel) c.primaryImageModel = id;

    closeModal('modal-generic');
    await saveModelConfig();
    toast(existing ? t('models.saved') : t('models.added'), 'success');
}

function initModelsPanel() {
    rebuildModels();
    renderModelsPanel();
}


// ═══════════════════════════════════════════════════════════════
// 供應商編輯（模型管理面板的第三個分頁）
// ═══════════════════════════════════════════════════════════════
// 讓使用者自己接任何相容的 API：填端點、選格式、設認證標頭。
// 「格式」決定用哪一組請求／回應轉譯器 —— 只要對方的 API 長得像
// 這四種其中之一，不用改任何程式碼就能接上。

const PROVIDER_FORMATS = {
    openai:    { label: 'OpenAI Chat Completions', get hint() { return t('provfmt.openaiH'); } },
    anthropic: { label: 'Anthropic Messages',      get hint() { return t('provfmt.anthropicH'); } },
    gemini:    { label: 'Google Gemini',           get hint() { return t('provfmt.geminiH'); } },
    responses: { label: 'Responses API',           get hint() { return t('provfmt.responsesH'); } },
};

function paintProviders() {
    const box = $('mdl-list');
    if (!box) return;
    box.innerHTML = '';

    const entries = Object.entries(API_CONFIG.providers);
    const configured = new Set(configuredProviders());
    const shown = entries.filter(([id, p]) => !_mdlFilter
        || id.includes(_mdlFilter)
        || String(p.label || '').toLowerCase().includes(_mdlFilter));

    if (!shown.length) {
        box.appendChild(el('div', { class: 'panel-empty' },
            el('span', { class: 'ms', text: 'search_off' }),
            el('span', { text: t('models.noProvMatch') })));
        return;
    }

    for (const [id, p] of shown) {
        const modelCount = (API_CONFIG.allModels || []).filter(m => m.provider === id).length
                         + (API_CONFIG.allImageModels || []).filter(m => m.provider === id).length;
        const fmt = PROVIDER_FORMATS[p.format || 'openai'];
        const row = el('div', { class: 'card mdl-item' });

        row.appendChild(el('div', { class: 'mdl-head' },
            el('span', { class: 'ms mdl-eye ' + (configured.has(id) ? 'on' : ''),
                title: configured.has(id) ? t('models.keySet') : t('models.keyUnset'),
                text: configured.has(id) ? 'key' : 'key_off' }),
            el('div', { class: 'mdl-names' },
                el('div', { class: 'mdl-name', text: p.label || id }),
                el('div', { class: 'mdl-id', title: id, text: id })),
            p._custom ? el('span', { class: 'chip mdl-badge', text: t('models.custom') }) : null
        ));

        row.appendChild(el('div', { class: 'mdl-meta' },
            el('span', { class: 'chip', text: fmt?.label || p.format || 'openai' }),
            el('span', { class: 'chip', text: t('models.countN', { n: modelCount }) }),
            p.supportsStream === false ? el('span', { class: 'chip chip-warn', text: t('models.noStream') }) : null
        ));

        let url = '';
        try { url = typeof p.endpoint === 'function' ? p.endpoint('{model}') : String(p.endpoint || ''); } catch { url = '(無法取得)'; }
        row.appendChild(el('div', { class: 'prov-url', title: url, text: url }));

        row.appendChild(el('div', { class: 'mdl-acts' },
            el('button', { class: 'btn btn-xs btn-ghost', onclick: () => openProviderEditor(id) },
                el('span', { class: 'ms', text: 'edit' }), el('span', { text: t('models.edit') })),
            p._builtin
                ? el('button', { class: 'btn btn-xs btn-ghost', title: t('models.restoreFactory'),
                    onclick: () => revertProvider(id) },
                    el('span', { class: 'ms', text: 'restart_alt' }), el('span', { text: '還原' }))
                : el('button', { class: 'btn btn-xs btn-ghost mdl-del', onclick: () => deleteProvider(id) },
                    el('span', { class: 'ms', text: 'delete' }), el('span', { text: '刪除' }))
        ));
        box.appendChild(row);
    }

    box.appendChild(el('div', { class: 'mdl-warn' },
        el('span', { class: 'ms', text: 'lightbulb' }),
        el('span', { text: '「格式」決定用哪組請求／回應轉譯器。只要對方的 API 長得像其中一種，就不用改程式碼。端點可用 {model} 代入模型編號。' })
    ));
}

function openProviderEditor(id) {
    const p = id ? API_CONFIG.providers[id] : null;
    const isNew = !p;
    let url = '';
    try { url = p && typeof p.endpoint === 'function' ? p.endpoint('{model}') : ''; } catch {}

    const fmtOpts = Object.entries(PROVIDER_FORMATS)
        .map(([k, f]) => `<option value="${k}"${(p?.format || 'openai') === k ? ' selected' : ''}>${esc(f.label)}</option>`)
        .join('');

    $('modal-generic-title').textContent = isNew ? '新增供應商' : `編輯供應商：${p.label || id}`;
    $('modal-generic-body').innerHTML = `
      <div class="mdl-form">
        <div class="ig">
          <label>供應商代號（英數字，模型會用它指向這個供應商）</label>
          <input class="inp" id="pf-id" value="${esc(id || '')}" placeholder="myprovider"${p ? ' readonly' : ''}>
        </div>
        <div class="ig">
          <label>顯示名稱</label>
          <input class="inp" id="pf-label" value="${esc(p?.label || '')}" placeholder="My Provider">
        </div>
        <div class="ig">
          <label>API 端點</label>
          <input class="inp" id="pf-url" value="${esc(url)}" placeholder="https://api.example.com/v1/chat/completions">
          <div class="hint">可用 <code>{model}</code> 代入模型編號（Gemini 這類需要把模型放進網址的才需要）。</div>
        </div>
        <div class="ig">
          <label>請求格式</label>
          <select class="sel" id="pf-format">${fmtOpts}</select>
          <div class="hint" id="pf-fmt-hint"></div>
        </div>

        <div class="mdl-form-sec">認證與標頭</div>
        <div class="ig ig-row">
          <div>
            <label>認證標頭名稱</label>
            <input class="inp" id="pf-authh" value="${esc(p?.authHeader || 'authorization')}" placeholder="authorization">
          </div>
          <div>
            <label>金鑰前綴</label>
            <input class="inp" id="pf-authp" value="${esc(p?.authPrefix ?? 'Bearer ')}" placeholder="Bearer ">
          </div>
        </div>
        <div class="ig">
          <label>localStorage 金鑰名稱</label>
          <input class="inp" id="pf-keyname" value="${esc(p?.keyName || '')}" placeholder="oc_myprovider_key">
          <div class="hint">留空會自動用 <code>oc_&lt;代號&gt;_key</code>。改這個會讓已存的金鑰對不上。</div>
        </div>
        <div class="ig ig-check">
          <label><input type="checkbox" id="pf-stream"${p?.supportsStream !== false ? ' checked' : ''}>
            支援串流 <span class="dim">（關閉則一次回傳完整結果；對方不支援 SSE 時關掉）</span></label>
        </div>
        <div class="ig">
          <label>額外標頭（JSON，選填）</label>
          <textarea class="ta ta-sm" id="pf-headers" rows="2" placeholder='{"x-custom":"value"}'>${esc(p?.extraHeaders ? JSON.stringify(p.extraHeaders) : '')}</textarea>
        </div>
        <div class="ig">
          <label>額外請求欄位（JSON，選填）</label>
          <textarea class="ta ta-sm" id="pf-body" rows="2" placeholder='{"max_output_tokens":8192}'>${esc(p?.extraBody ? JSON.stringify(p.extraBody) : '')}</textarea>
          <div class="hint">會合併進請求主體。不確定對方支不支援的欄位別亂加，多送不認得的欄位可能整個請求被拒。</div>
        </div>
      </div>`;

    const acts = $('modal-generic-actions');
    acts.innerHTML = '';
    acts.appendChild(el('button', { class: 'btn btn-ghost', text: '取消', onclick: () => closeModal('modal-generic') }));
    acts.appendChild(el('button', { class: 'btn btn-primary', text: isNew ? '新增' : '儲存',
        onclick: () => saveProviderEditor(id) }));
    openModal('modal-generic');

    const syncHint = () => {
        const h = $('pf-fmt-hint');
        if (h) h.textContent = PROVIDER_FORMATS[$('pf-format').value]?.hint || '';
    };
    $('pf-format')?.addEventListener('change', syncHint);
    syncHint();
    setTimeout(() => $(isNew ? 'pf-id' : 'pf-label')?.focus(), 60);
}

async function saveProviderEditor(existingId) {
    const id = (existingId || $('pf-id')?.value || '').trim();
    if (!/^[a-z0-9_-]{1,32}$/i.test(id)) {
        toast(t('models.badProvId'), 'warn'); return;
    }
    const url = ($('pf-url')?.value || '').trim();
    if (!/^https?:\/\//i.test(url)) { toast(t('models.badUrl'), 'warn'); return; }

    const parseJsonField = (elId, label) => {
        const raw = ($(elId)?.value || '').trim();
        if (!raw) return null;
        try {
            const o = JSON.parse(raw);
            if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('必須是物件');
            return o;
        } catch (e) { toast(t('models.badJson', { label, msg: e.message }), 'warn'); return undefined; }
    };
    const extraHeaders = parseJsonField('pf-headers', '額外標頭');
    if (extraHeaders === undefined) return;
    const extraBody = parseJsonField('pf-body', '額外請求欄位');
    if (extraBody === undefined) return;

    const patch = {
        label: ($('pf-label')?.value || '').trim() || id,
        endpoint: url,
        format: $('pf-format')?.value || 'openai',
        authHeader: ($('pf-authh')?.value || '').trim() || 'authorization',
        authPrefix: $('pf-authp')?.value ?? 'Bearer ',
        supportsStream: !!$('pf-stream')?.checked,
    };
    const keyName = ($('pf-keyname')?.value || '').trim();
    if (keyName) patch.keyName = keyName;
    if (extraHeaders) patch.extraHeaders = extraHeaders;
    if (extraBody) patch.extraBody = extraBody;

    const c = modelCfg();
    const isBuiltin = !!API_CONFIG.builtinProviders?.[id];
    if (isBuiltin) {
        c.providers[id] = { ...(c.providers[id] || {}), ...patch };
    } else {
        const i = c.customProviders.findIndex(x => x.id === id);
        const entry = { id, ...patch };
        if (i >= 0) c.customProviders[i] = entry;
        else c.customProviders.push(entry);
    }

    closeModal('modal-generic');
    await saveModelConfig();
    toast(existingId ? t('models.provSaved') : t('models.provAdded'), 'success');
}

async function revertProvider(id) {
    const c = modelCfg();
    if (!c.providers[id]) { toast(t('models.provPristine'), 'info'); return; }
    delete c.providers[id];
    await saveModelConfig();
    toast(t('models.restoredBuiltin'), 'success');
}

async function deleteProvider(id) {
    const used = [...(API_CONFIG.allModels || []), ...(API_CONFIG.allImageModels || [])].filter(m => m.provider === id);
    const ok = await confirmModal(t('models.delProvT'),
        t('models.delProvB', { id: esc(id) })
        + (used.length ? t('models.delProvUsed', { n: used.length }) : ''),
        { okText: t('common.del'), danger: true });
    if (!ok) return;
    const c = modelCfg();
    c.customProviders = c.customProviders.filter(x => x.id !== id);
    await saveModelConfig();
    toast(t('common.deleted'), 'success');
}

Object.assign(window, {
    paintCurrentModel, paintModels, loadModelConfig,
    rebuildModels, saveModelConfig, modelCfg, defaultModelConfig,
    modelRates, allModelRates,
    primaryImageModel, setPrimaryImageModel,
    initModelsPanel, renderModelsPanel, openModelEditor,
    rebuildProviders, openProviderEditor,
});
