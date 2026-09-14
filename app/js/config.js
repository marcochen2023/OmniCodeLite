'use strict';
// ═══════════════════════════════════════════════════════════════
// Omni Code — 統一 API 設定檔
// ═══════════════════════════════════════════════════════════════
// 所有 AI 供應商端點、金鑰名稱、模型清單、功能指定模型集中於此。
// 要新增 / 更換模型或端點，只需修改這個檔案。
//
// API Key 由「⚙ API Key 設定」Modal 輸入，儲存在瀏覽器 localStorage；
// 也可選擇存到伺服器端（data/config.json，僅本機可讀）。
// ═══════════════════════════════════════════════════════════════

const API_CONFIG = {

    // ═══ AI 供應商 ═══
    providers: {
        gemini: {
            label: 'Google Gemini',
            keyName: 'oc_gemini_key',
            keyUrl: 'https://aistudio.google.com/app/apikey',
            keyUrlText: 'aistudio.google.com',
            keyPlaceholder: 'AIzaSy...',
            keyNote: '（文字 + 圖片生成）',
            format: 'gemini',
            endpoint: (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
            streamEndpoint: (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
            imagenEndpoint: (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict`,
        },
        openai: {
            label: 'OpenAI ChatGPT',
            keyName: 'oc_openai_key',
            keyUrl: 'https://platform.openai.com/api-keys',
            keyUrlText: 'platform.openai.com/api-keys',
            keyPlaceholder: 'sk-proj-...',
            keyNote: '（GPT 系列）',
            format: 'openai',
            endpoint: () => 'https://api.openai.com/v1/chat/completions',
        },
        anthropic: {
            label: 'Anthropic Claude',
            keyName: 'oc_anthropic_key',
            keyUrl: 'https://console.anthropic.com/settings/keys',
            keyUrlText: 'console.anthropic.com',
            keyPlaceholder: 'sk-ant-...',
            keyNote: '（Claude 系列 — 最推薦用於程式開發）',
            format: 'anthropic',
            endpoint: () => 'https://api.anthropic.com/v1/messages',
            apiVersion: '2023-06-01',
        },
        openrouter: {
            label: 'OpenRouter',
            keyName: 'oc_openrouter_key',
            keyUrl: 'https://openrouter.ai/keys',
            keyUrlText: 'openrouter.ai/keys',
            keyPlaceholder: 'sk-or-v1-...',
            keyNote: '（一組 Key 呼叫多家模型）',
            format: 'openai',
            endpoint: () => 'https://openrouter.ai/api/v1/chat/completions',
            imagesEndpoint: 'https://openrouter.ai/api/v1/images',
        },
        meta: {
            label: 'Meta AI',
            keyName: 'oc_meta_key',
            keyUrl: 'https://ai.meta.com/',
            keyUrlText: 'ai.meta.com',
            keyPlaceholder: 'sk-meta-...',
            keyNote: '（Muse Spark 系列）',
            endpoint: () => 'https://api.meta.ai/v1/responses',
            format: 'responses',
            // 官方範例只示範 "stream": false，串流事件格式未經實測驗證，
            // 所以預設走非串流（一次回傳完整結果）。
            // 確認可用後可在「供應商」編輯器手動開啟串流。
            supportsStream: false,
        },
    },

    // ═══ 模型清單 ═══
    // multimodal : 支援圖片輸入
    // tools      : 支援原生 function calling（Agent 必需）
    // context    : 上下文視窗（token），用於壓縮門檻計算
    // tier       : 'flagship' | 'balanced' | 'fast'  → UI 分組標記
    models: [
        // ─── Anthropic Claude（程式開發首選）───
        { id: 'claude-sonnet-5',            displayName: 'Claude Sonnet 5',   provider: 'anthropic',  multimodal: true, tools: true, context: 200000, tier: 'flagship' },
        { id: 'claude-opus-4-8',            displayName: 'Claude Opus 4.8',   provider: 'anthropic',  multimodal: true, tools: true, context: 200000, tier: 'flagship' },
        { id: 'claude-haiku-4-5-20251001',  displayName: 'Claude Haiku 4.5',  provider: 'anthropic',  multimodal: true, tools: true, context: 200000, tier: 'fast' },
        // ─── Google Gemini ───
        { id: 'gemini-3.7-flash',           displayName: 'Gemini 3.7 Flash',      provider: 'gemini', multimodal: true, tools: true, context: 1048576, tier: 'flagship' },
        { id: 'gemini-3.1-pro-preview',     displayName: 'Gemini 3.1 Pro',        provider: 'gemini', multimodal: true, tools: true, context: 1048576, tier: 'flagship' },
        { id: 'gemini-3.6-flash',           displayName: 'Gemini 3.6 Flash',      provider: 'gemini', multimodal: true, tools: true, context: 1048576, tier: 'balanced' },
        { id: 'gemini-3.5-flash',           displayName: 'Gemini 3.5 Flash',      provider: 'gemini', multimodal: true, tools: true, context: 1048576, tier: 'balanced' },
        { id: 'gemini-3.5-flash-lite',      displayName: 'Gemini 3.5 Flash-lite', provider: 'gemini', multimodal: true, tools: true, context: 1048576, tier: 'fast' },
        { id: 'gemini-3.1-flash-lite',      displayName: 'Gemini 3.1 Flash-lite', provider: 'gemini', multimodal: true, tools: true, context: 1048576, tier: 'fast' },
        { id: 'gemini-2.5-flash-lite',      displayName: 'Gemini 2.5 Flash-lite', provider: 'gemini', multimodal: true, tools: true, context: 1048576, tier: 'fast' },
        // ─── OpenAI ───
        { id: 'gpt-5.6-luna',               displayName: 'GPT-5.6 Luna',      provider: 'openai', multimodal: true, tools: true, context: 400000, tier: 'flagship' },
        { id: 'gpt-5.5',                    displayName: 'GPT-5.5',           provider: 'openai', multimodal: true, tools: true, context: 400000, tier: 'flagship' },
        { id: 'gpt-5.4',                    displayName: 'GPT-5.4',           provider: 'openai', multimodal: true, tools: true, context: 400000, tier: 'balanced' },
        { id: 'gpt-5.4-mini',               displayName: 'GPT-5.4 Mini',      provider: 'openai', multimodal: true, tools: true, context: 400000, tier: 'fast' },
        { id: 'gpt-5.4-nano',               displayName: 'GPT-5.4 Nano',      provider: 'openai', multimodal: true, tools: true, context: 400000, tier: 'fast' },
        // ─── OpenRouter ───
        { id: 'anthropic/claude-sonnet-5',      displayName: 'Claude Sonnet 5 (OR)',   provider: 'openrouter', multimodal: true, tools: true, context: 200000, tier: 'flagship' },
        { id: 'anthropic/claude-haiku-4.5',     displayName: 'Claude Haiku 4.5 (OR)',  provider: 'openrouter', multimodal: true, tools: true, context: 200000, tier: 'fast' },
        { id: 'openai/gpt-5.6-sol-pro',         displayName: 'GPT-5.6 Sol Pro (OR)',   provider: 'openrouter', multimodal: true, tools: true, context: 400000, tier: 'flagship' },
        { id: 'openai/gpt-5.6-terra-pro',       displayName: 'GPT-5.6 Terra Pro (OR)', provider: 'openrouter', multimodal: true, tools: true, context: 400000, tier: 'flagship' },
        { id: 'openai/gpt-5.6-luna-pro',        displayName: 'GPT-5.6 Luna Pro (OR)',  provider: 'openrouter', multimodal: true, tools: true, context: 400000, tier: 'flagship' },
        { id: 'openai/gpt-5.5',                 displayName: 'GPT-5.5 (OR)',           provider: 'openrouter', multimodal: true, tools: true, context: 400000, tier: 'balanced' },
        { id: 'x-ai/grok-4.5',                  displayName: 'Grok 4.5 (OR)',          provider: 'openrouter', multimodal: true, tools: true, context: 256000, tier: 'balanced' },
        { id: 'google/gemini-3.1-pro-preview',  displayName: 'Gemini 3.1 Pro (OR)',    provider: 'openrouter', multimodal: true, tools: true, context: 1048576, tier: 'flagship' },
        { id: 'google/gemini-3.7-flash',        displayName: 'Gemini 3.7 Flash (OR)',      provider: 'openrouter', multimodal: true, tools: true, context: 1048576, tier: 'flagship' },
        { id: 'google/gemini-3.6-flash',        displayName: 'Gemini 3.6 Flash (OR)',  provider: 'openrouter', multimodal: true, tools: true, context: 1048576, tier: 'balanced' },
        { id: 'google/gemini-3.5-flash-lite',   displayName: 'Gemini 3.5 Flash-lite (OR)', provider: 'openrouter', multimodal: true, tools: true, context: 1048576, tier: 'fast' },
        { id: 'google/gemini-3.1-flash-lite',   displayName: 'Gemini 3.1 Flash-lite (OR)', provider: 'openrouter', multimodal: true, tools: true, context: 1048576, tier: 'fast' },
        { id: 'moonshotai/kimi-k3',             displayName: 'Kimi K3 (OR)',           provider: 'openrouter', multimodal: true, tools: true, context: 256000, tier: 'balanced' },
        { id: 'minimax/minimax-m3',             displayName: 'MiniMax M3 (OR)',        provider: 'openrouter', multimodal: true, tools: true, context: 200000, tier: 'balanced' },
        { id: 'qwen/qwen3.7-flash',             displayName: 'Qwen 3.7 Flash (OR)',    provider: 'openrouter', multimodal: true, tools: true, context: 1048576, tier: 'fast' },
        { id: 'deepseek/deepseek-v4-pro',       displayName: 'DeepSeek V4 Pro (OR)',   provider: 'openrouter', multimodal: false, tools: true, context: 1048576, tier: 'flagship' },
        { id: 'deepseek/deepseek-v4-pro-0813',  displayName: 'DeepSeek V4 Pro 0813 (OR)',   provider: 'openrouter', multimodal: false, tools: true, context: 1048576, tier: 'flagship' },
        { id: 'deepseek/deepseek-v4-flash-0731', displayName: 'DeepSeek V4 Flash 0731 (OR)', provider: 'openrouter', multimodal: false, tools: true, context: 1048576, tier: 'balanced' },
        { id: 'deepseek/deepseek-v4-flash',     displayName: 'DeepSeek V4 Flash (OR)', provider: 'openrouter', multimodal: false, tools: true, context: 128000, tier: 'fast' },
        { id: 'mz-ai/glm-5.2',                  displayName: 'GLM 5.2 (OR)',           provider: 'openrouter', multimodal: false, tools: true, context: 128000, tier: 'balanced' },
        { id: 'xiaomi/mimo-v2.5-pro',           displayName: 'MiMo v2.5 Pro (OR)',     provider: 'openrouter', multimodal: false, tools: true, context: 128000, tier: 'balanced' },
        { id: 'xiaomi/mimo-v2.5',               displayName: 'MiMo v2.5 (OR)',         provider: 'openrouter', multimodal: true, tools: true, context: 128000, tier: 'fast' },

        // Meta（Responses API 格式）
        { id: 'muse-spark-1.2-contributor',     displayName: 'Muse Spark 1.2',         provider: 'meta',       multimodal: false, tools: true, context: 1048576, tier: 'flagship' },
    ],

    // ═══ 圖片生成模型 ═══
    imageModels: [
        { id: 'gemini-3.1-flash-image', displayName: 'Nano Banana 2', provider: 'gemini' },
        { id: 'muse-image-1.0', displayName: 'Muse Image 1.0', provider: 'meta' },
        { id: 'meta/muse-image', displayName: 'Muse Image (OR)', provider: 'openrouter' },
        { id: 'openai/gpt-image-2.5-flare', displayName: 'GPT Image 2.5 Flare (OR)', provider: 'openrouter' },
        { id: 'openai/gpt-image-2.5-sunburst', displayName: 'GPT Image 2.5 Sunburst (OR)', provider: 'openrouter' },
        { id: 'google/gemini-3.1-flash-image', displayName: 'Nano Banana 2 (OR)', provider: 'openrouter' },
        { id: 'google/gemini-3.1-flash-lite-imag', displayName: 'Nano Banana 2 Lite (OR)', provider: 'openrouter' },
    ],

    // ═══ 各功能指定模型 ═══
    featureModels: {
        // 上下文壓縮摘要（用便宜快速的模型即可）
        compact:     { id: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash' },
        // 會話標題自動命名
        title:       { id: 'gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash-lite' },
        // 子代理預設模型
        subagent:    { id: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5' },
        // 繪圖提示詞優化
        imagePrompt: { id: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash' },
        // 影片／音訊分析（只有 Gemini 能吃影音輸入）
        video:       { id: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash' },
    },

    // ═══ 生成參數 ═══
    // 備援鏈：主模型連線層失敗（限流／過載／5xx）時依序往下試。
    // 只列「不同供應商」的模型才有意義 —— 同一家掛掉時換同一家沒用。
    fallbackChain: [
        'claude-sonnet-5',
        'gemini-3.5-flash',
        'gpt-5.4-mini',
    ],

    generation: {
        temperature: 0.3,      // 程式開發用低溫
        topP: 0.95,
        maxTokens: 16384,
    },

    // ═══ 圖片生成參數 ═══
    image: {
        aspects: ['1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2'],
        sizes: ['512', '1K', '2K', '4K'],
        defaultAspect: '1:1',
        defaultSize: '2K',
        // muse-image-1.0 只有三檔（官方 image-generation 文件附圖），跟 Gemini 的 1K/2K 不通用
        metaSizes: ['1024x1024', '1024x1536', '1536x1024'],
        defaultMetaSize: '1024x1024',
        stylePresets: [
            { id: 'none',      label: '無風格',   prompt: '' },
            { id: 'ui',        label: 'UI 介面',  prompt: 'Clean modern UI design, flat vector, crisp edges, professional software interface aesthetic, ' },
            { id: 'icon',      label: '圖示',     prompt: 'Minimal app icon, centered subject, simple geometry, solid background, vector style, ' },
            { id: 'illust',    label: '插畫',     prompt: 'Digital illustration, soft lighting, rich colors, detailed, artstation quality, ' },
            { id: 'photo',     label: '寫實照片', prompt: 'Photorealistic, natural lighting, shallow depth of field, high detail, 50mm lens, ' },
            { id: '3d',        label: '3D 渲染',  prompt: '3D render, octane, soft studio lighting, subtle reflections, clay material, ' },
            { id: 'anime',     label: '動漫',     prompt: 'Anime style illustration, clean line art, cel shading, vibrant colors, ' },
            { id: 'banner',    label: '橫幅',     prompt: 'Wide web banner composition, negative space for text overlay, gradient background, ' },
            { id: 'sketch',    label: '線稿',     prompt: 'Black and white line sketch, hand-drawn, minimal shading, white background, ' },
        ],
    },

    // ═══ 節流（避免觸發供應商速率限制）═══
    // Agent 工具迴圈需要高頻呼叫，預設關閉；遇到 429 才由退避重試處理。
    throttle: { minGapSeconds: 0 },

    // ═══ 重試 ═══
    retry: { max: 2, baseDelayMs: 1500 },

    // ═══ 擴展思考（推理預算）═══
    // 難題上讓模型先想久一點再動手，是「智能體」跟「工具執行器」的分水嶺。
    // 四家供應商的參數名稱完全不同，這裡統一成四個等級再各自轉換。
    //
    // 不在這裡維護「哪些模型支援思考」的白名單 —— 那份清單會過期，
    // 而過期的白名單會讓新模型永遠用不到思考能力。改用樂觀策略：
    // 先送，被 API 拒絕就自動去掉思考參數重試一次，並把該模型記進
    // localStorage 的不支援清單，之後就不再送（見 api.js 的 thinkingUnsupported）。
    // 等級名稱沿用 Claude Code 的 /effort：low / medium / high / xhigh / max。
    // off 是 Omni Code 多的第六列（完全不送推理參數）—— CC 用獨立的
    // thinking on/off 開關表達同一件事，但這裡用一個下拉就夠了，
    // 而且 api.js 本來就拿 'off' 當內部哨兵值。
    //
    // 預算刻度是「讓舊設定無損遷移」倒推出來的：
    //   舊 standard(4096) → low、舊 deep(12288) → high、舊 max(24576) → xhigh，
    // 三者的預算完全不變，升級後沒有人的花費會動到。
    //
    // OpenAI 的 reasoning_effort enum 只到 high，所以 xhigh/max 都降成 high ——
    // 這正是 CC 的規則：「降到不超過你設定值的最高支援等級」。
    effort: {
        order: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
        levels: {
            off:    { label: 'Off',    hint: '完全不推理，最快，適合單純改字',      anthropic: 0,     gemini: 0,     effort: null,     color: 'var(--ink-faint)', icon: 'bolt' },
            low:    { label: 'Low',    hint: '短、範圍明確、對延遲敏感的任務',      anthropic: 4096,  gemini: 4096,  effort: 'low',    color: 'var(--info)',      icon: 'neurology' },
            medium: { label: 'Medium', hint: '省 token，願意換掉一點深度',          anthropic: 8192,  gemini: 8192,  effort: 'medium', color: 'var(--accent)',    icon: 'neurology' },
            high:   { label: 'High',   hint: 'token 與思考深度的平衡點（預設）',    anthropic: 12288, gemini: 12288, effort: 'high',   color: 'var(--accent)',    icon: 'neurology' },
            xhigh:  { label: 'XHigh',  hint: '更深的推理，token 花費明顯上升',      anthropic: 24576, gemini: 24576, effort: 'high',   color: 'var(--accent-2)',  icon: 'neurology' },
            max:    { label: 'Max',    hint: '最深；難題可能更好，也可能想太多',    anthropic: 40960, gemini: 40960, effort: 'high',   color: 'var(--danger)',    icon: 'neurology' },
        },
        default: 'high',
    },
};

// 舊名相容：thinking 指向同一個物件，讓還沒改到的呼叫端不會炸
API_CONFIG.thinking = API_CONFIG.effort;

// ─── 依模型上限降級 ───────────────────────────────────────────
// CC 的規則：設了模型不支援的等級，就降到「不超過設定值的最高支援等級」。
// 模型可在「模型管理」設 effortMax；沒設就是不限制。
function resolveEffort(mid, level) {
    const O = API_CONFIG.effort.order;
    let lv = O.includes(level) ? level : API_CONFIG.effort.default;
    const m = getModelInfo(mid);
    if (m?.thinking === false) return 'off';
    const cap = m?.effortMax;
    if (cap && O.includes(cap) && O.indexOf(lv) > O.indexOf(cap)) lv = cap;
    return lv;
}

/** 舊設定遷移：thinkingLevel → effortLevel。預算刻度刻意對齊，不會改到花費。 */
const EFFORT_LEGACY = { off: 'off', standard: 'low', deep: 'high', max: 'xhigh' };
function migrateEffort(cfg) {
    if (!cfg) return null;
    if (API_CONFIG.effort.order.includes(cfg.effortLevel)) return null;   // 已經是新值
    const old = cfg.thinkingLevel;
    return EFFORT_LEGACY[old] || API_CONFIG.effort.default;
}

// ═══ 內建模型清單的原始副本 ═══
// API_CONFIG.models / imageModels 會被「模型管理面板」的使用者設定覆寫，
// 這兩份保留出廠值，讓使用者隨時能還原，也讓內建清單日後更新時
// 不會被舊的使用者設定永久蓋掉（見 models.js 的 rebuildModels）。
API_CONFIG.builtinModels      = API_CONFIG.models.map(m => ({ ...m }));
API_CONFIG.builtinImageModels = API_CONFIG.imageModels.map(m => ({ ...m }));
// 含已隱藏模型的完整清單。歷史用量紀錄要查得到已隱藏模型的名稱與價格，
// 所以 metadata 查詢一律走這份，不能用只含可見模型的 models。
API_CONFIG.allModels = API_CONFIG.models.map(m => ({ ...m }));

// ─── 依模型 ID 解析供應商 ───
// 注意：imageModels 會被模型管理面板的使用者設定覆寫（rebuildModels），
// 所以這裡也要查 allImageModels，否則面板改過清單後新模型會掉回預設分支。
// （之前漏了這一份，OR 版 Gemini 被誤判成 gemini，直連 generativelanguage 吃 CORS。）
function getProviderForModel(mid) {
    if (!mid) return 'anthropic';
    const found = API_CONFIG.allModels.find(m => m.id === mid)
        || API_CONFIG.allImageModels?.find(m => m.id === mid)
        || API_CONFIG.imageModels.find(m => m.id === mid)
        || API_CONFIG.builtinImageModels.find(m => m.id === mid);
    if (found?.provider) return found.provider;
    if (mid.includes('/')) return 'openrouter';
    if (/^gpt-/i.test(mid) || /^o\d/i.test(mid)) return 'openai';
    if (/^claude-/i.test(mid)) return 'anthropic';
    return 'gemini';
}

// ─── 取得模型 metadata ───
// 走 allModels（含已隱藏），否則隱藏某個模型之後，歷史紀錄與
// 進行中的會話就查不到它的名稱與價格了。
function getModelInfo(mid) {
    return API_CONFIG.allModels.find(m => m.id === mid)
        || API_CONFIG.imageModels.find(m => m.id === mid)
        || API_CONFIG.builtinImageModels.find(m => m.id === mid)
        || { id: mid, displayName: mid, provider: getProviderForModel(mid), multimodal: true, tools: true, context: 200000, tier: 'balanced' };
}

// ─── 讀取供應商 API Key（localStorage 優先，其次伺服器端保存）───
function getProviderKey(provider) {
    const p = API_CONFIG.providers[provider];
    if (!p) return '';
    const local = localStorage.getItem(p.keyName);
    if (local) return local;
    const server = window.OC?.cfg?.keys?.[provider];
    return server || '';
}

function setProviderKey(provider, key) {
    const p = API_CONFIG.providers[provider];
    if (!p) return;
    if (key) localStorage.setItem(p.keyName, key);
    else localStorage.removeItem(p.keyName);
}

// ─── 有哪些供應商已設定金鑰 ───
function configuredProviders() {
    return Object.keys(API_CONFIG.providers).filter(p => !!getProviderKey(p));
}

// ─── 只列出「有金鑰可用」的模型；全無金鑰時回傳全部（讓 UI 仍能顯示）───
function availableModels() {
    const ok = new Set(configuredProviders());
    if (!ok.size) return API_CONFIG.models;
    const list = API_CONFIG.models.filter(m => ok.has(m.provider));
    return list.length ? list : API_CONFIG.models;
}

window.API_CONFIG = API_CONFIG;
window.getProviderForModel = getProviderForModel;
window.getModelInfo = getModelInfo;
window.getProviderKey = getProviderKey;
window.setProviderKey = setProviderKey;
window.configuredProviders = configuredProviders;
window.availableModels = availableModels;
window.resolveEffort = resolveEffort;
window.migrateEffort = migrateEffort;
