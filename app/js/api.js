'use strict';
// ═══════════════════════════════════════════════════════════════
// Omni Code — AI 呼叫層（串流 + 原生 function calling）
// ═══════════════════════════════════════════════════════════════
// 四家供應商統一為同一組介面：
//   streamChat({model, system, messages, tools, ...callbacks})
//     → {content:[blocks], stopReason, usage}
//
// 訊息採「供應商中立」格式（見 ARCHITECTURE.md §10.2）：
//   {role:'user'|'assistant', content:[
//      {type:'text',text} | {type:'thinking',text} | {type:'image',mime,data}
//      | {type:'tool_use',id,name,input} | {type:'tool_result',tool_use_id,content,is_error}
//   ]}
//
// 傳輸：預設 direct 直連（快、金鑰不離開瀏覽器）；
//       CORS/網路錯誤自動改走 ../api/relay.php（同一份解析邏輯）。
// ═══════════════════════════════════════════════════════════════

// ─── 工具 schema 轉譯 ────────────────────────────────────────────

// 通用 → Anthropic
function toolsForAnthropic(tools) {
    return tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: normalizeSchema(t.params, 'anthropic'),
    }));
}

// 通用 → OpenAI / OpenRouter
function toolsForOpenAI(tools) {
    return tools.map(t => ({
        type: 'function',
        function: {
            name: t.name,
            description: t.description,
            parameters: normalizeSchema(t.params, 'openai'),
        },
    }));
}

// 通用 → Gemini（functionDeclarations）
function toolsForGemini(tools) {
    return [{ functionDeclarations: tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: normalizeSchema(t.params, 'gemini'),
    })) }];
}

// JSON Schema 清洗。Gemini 只吃 OpenAPI 3.0 子集，不接受
// additionalProperties / $schema / examples / const / oneOf 等關鍵字。
function normalizeSchema(schema, target) {
    const base = schema && typeof schema === 'object' ? schema : { type: 'object', properties: {} };
    const clone = JSON.parse(JSON.stringify(base));
    if (target !== 'gemini') {
        if (clone.type === 'object' && !clone.properties) clone.properties = {};
        return clone;
    }
    const STRIP = new Set([
        '$schema', 'additionalProperties', 'examples', 'example', 'const',
        'default', 'oneOf', 'anyOf', 'allOf', 'not', '$ref', '$defs', 'definitions',
        'patternProperties', 'minLength', 'maxLength', 'pattern', 'minimum',
        'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
        'minItems', 'maxItems', 'uniqueItems', 'title',
    ]);
    const walk = (node) => {
        if (Array.isArray(node)) return node.map(walk);
        if (!node || typeof node !== 'object') return node;
        const out = {};
        for (const [k, v] of Object.entries(node)) {
            if (STRIP.has(k)) continue;
            if (k === 'properties') {
                out.properties = {};
                for (const [pk, pv] of Object.entries(v || {})) out.properties[pk] = walk(pv);
            } else if (k === 'items') out.items = walk(v);
            else if (k === 'enum') out.enum = Array.isArray(v) ? v.map(String) : v;
            else out[k] = walk(v);
        }
        if (out.type === 'object' && !out.properties) out.properties = {};
        // Gemini 拒絕沒有 items 的 array
        if (out.type === 'array' && !out.items) out.items = { type: 'string' };
        return out;
    };
    const g = walk(clone);
    if (!g.type) g.type = 'object';
    if (g.type === 'object' && !g.properties) g.properties = {};
    // Gemini 不接受空的 properties 物件搭配 required
    if (g.required && (!g.properties || !Object.keys(g.properties).length)) delete g.required;
    return g;
}

// ─── 訊息轉譯 ───────────────────────────────────────────────────

function msgsForAnthropic(messages) {
    return messages.map(m => ({
        role: m.role,
        content: (m.content || []).map(b => {
            switch (b.type) {
                case 'text':      return { type: 'text', text: b.text || '' };

                // ★ 開啟擴展思考時，帶工具呼叫的 assistant 回合必須把 thinking
                // 區塊連同簽章原樣送回，而且要排在該回合的最前面，否則 Anthropic
                // 直接拒絕（"Expected thinking or redacted_thinking..."）。
                // 沒有簽章的思考內容送回去反而會被判定竄改，所以只回送有簽章的；
                // 其餘（其他供應商產生的、或壓縮後遺失簽章的）一律略過。
                case 'thinking':
                    if (b._redacted) return { type: 'redacted_thinking', data: b._redacted };
                    if (b._sig && b.text) return { type: 'thinking', thinking: b.text, signature: b._sig };
                    return null;
                case 'image':     return { type: 'image', source: { type: 'base64', media_type: b.mime, data: b.data } };
                case 'tool_use':  return { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} };
                case 'tool_result': return {
                    type: 'tool_result',
                    tool_use_id: b.tool_use_id,
                    content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content),
                    is_error: !!b.is_error,
                };
                default: return null;
            }
        }).filter(Boolean),
    })).filter(m => m.content.length);
}

function msgsForOpenAI(messages, system) {
    const out = [];
    if (system) out.push({ role: 'system', content: system });
    for (const m of messages) {
        const blocks = m.content || [];
        if (m.role === 'assistant') {
            const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
            const calls = blocks.filter(b => b.type === 'tool_use').map(b => ({
                id: b.id, type: 'function',
                function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
            }));
            if (!text && !calls.length) continue;
            const msg = { role: 'assistant', content: text || null };
            if (calls.length) msg.tool_calls = calls;
            out.push(msg);
            continue;
        }
        // user：tool_result 必須拆成獨立的 role:'tool' 訊息
        const results = blocks.filter(b => b.type === 'tool_result');
        for (const r of results) {
            out.push({
                role: 'tool',
                tool_call_id: r.tool_use_id,
                content: (typeof r.content === 'string' ? r.content : JSON.stringify(r.content)) || '(無輸出)',
            });
        }
        const rest = blocks.filter(b => b.type === 'text' || b.type === 'image');
        if (!rest.length) continue;
        const hasImage = rest.some(b => b.type === 'image');
        if (!hasImage) {
            out.push({ role: 'user', content: rest.map(b => b.text).join('\n') });
        } else {
            out.push({
                role: 'user',
                content: rest.map(b => b.type === 'image'
                    ? { type: 'image_url', image_url: { url: `data:${b.mime};base64,${b.data}` } }
                    : { type: 'text', text: b.text || '' }),
            });
        }
    }
    return out;
}

function msgsForGemini(messages) {
    const out = [];

    // 沒有 thoughtSignature 的工具呼叫，Gemini 3 會直接 400 擋掉整個請求。
    // 這種訊息一定會出現，而且不是使用者的錯：
    //   (a) 這個修正之前存下來的舊會話；
    //   (b) 中途從 Claude / GPT 切換到 Gemini —— 那些回合根本不可能有 Gemini 的簽章。
    // 對這些回合，把 functionCall / functionResponse 降級成純文字敘述：
    // 語意保留、不需要簽章，對話因此能繼續，而新回合仍走原生工具呼叫。
    const degraded = new Set();
    for (const m of messages) {
        if (m.role !== 'assistant') continue;
        for (const b of (m.content || [])) {
            if (b.type === 'tool_use' && !b._sig) degraded.add(b.id);
        }
    }

    for (const m of messages) {
        const blocks = m.content || [];
        if (m.role === 'assistant') {
            const parts = [];
            for (const b of blocks) {
                // thoughtSignature 必須跟著原本的 part 一起送回去（見 parseGeminiStream 的說明）
                if (b.type === 'text' && b.text) {
                    const p = { text: b.text };
                    if (b._sig) p.thoughtSignature = b._sig;
                    parts.push(p);
                } else if (b.type === 'tool_use') {
                    if (degraded.has(b.id)) {
                        parts.push({ text: `（先前呼叫了工具 ${b.name}，參數：${JSON.stringify(b.input || {}).slice(0, 800)}）` });
                    } else {
                        const p = { functionCall: { name: b.name, args: b.input || {} } };
                        if (b._sig) p.thoughtSignature = b._sig;
                        parts.push(p);
                    }
                }
            }
            if (parts.length) out.push({ role: 'model', parts });
            continue;
        }
        const parts = [];
        for (const b of blocks) {
            if (b.type === 'text' && b.text) parts.push({ text: b.text });
            else if (b.type === 'image') parts.push({ inlineData: { mimeType: b.mime, data: b.data } });
            else if (b.type === 'tool_result') {
                const raw = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
                // 對應的 functionCall 已降級成文字時，回應也必須降級 ——
                // functionResponse 沒有配對的 functionCall 一樣會被 API 拒絕。
                if (degraded.has(b.tool_use_id)) {
                    const label = b._name || '工具';
                    parts.push({ text: `（${label} 的執行結果${b.is_error ? '｜失敗' : ''}）\n${raw.slice(0, 4000)}` });
                } else {
                    parts.push({
                        functionResponse: {
                            name: (b._name || b.tool_use_id || 'tool').replace(/^toolu_/, ''),
                            response: b.is_error ? { error: raw } : { result: raw },
                        },
                    });
                }
            }
        }
        if (parts.length) out.push({ role: 'user', parts });
    }
    return out;
}

// ─── 串流主函式 ─────────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════
// 模型冷卻與備援（建議 #5）
// ═══════════════════════════════════════════════════════════════
// 重試同一個模型直到放棄，等於一個 529 就讓整輪死掉 ——
// 即使設定裡躺著一把完全可用的另一家金鑰。
// classifyLlmError() 本來就分得出 RATE_LIMIT / OVERLOADED，
// 這裡只是把那個資訊真的拿來分流。
const MODEL_COOLDOWN = new Map();        // model id → 解除冷卻的時間戳
const COOLDOWN_MS = 30 * 60 * 1000;

function coolDownModel(model, ms = COOLDOWN_MS) {
    if (!model) return;
    MODEL_COOLDOWN.set(model, Date.now() + ms);
    window.OCLog?.(`模型 ${model} 進入冷卻 ${Math.round(ms / 60000)} 分鐘`);
}
function isCoolingDown(model) {
    const until = MODEL_COOLDOWN.get(model);
    if (!until) return false;
    if (Date.now() >= until) { MODEL_COOLDOWN.delete(model); return false; }
    return true;
}
/** 使用者明確選了某個模型 → 清掉它的冷卻，不要跟使用者的意圖作對 */
function clearCooldown(model) { MODEL_COOLDOWN.delete(model); }

/** 找下一個可用的備援模型。
 *  ★ 關鍵限制：開著延伸思考時只能在「同一種請求格式」內換。
 *    Anthropic 規定帶工具呼叫的 assistant 回合要把 thinking 連同簽章原樣送回，
 *    換到別家再換回來，簽章就對不上了 —— msgsForOpenAI / msgsForGemini
 *    本來就會略過 thinking，所以 Anthropic → 其他是安全的單向。 */
function nextHealthyModel(current) {
    const chain = API_CONFIG.fallbackChain || [];
    const think = OC?.cfg?.effortLevel;
    const thinking = think && think !== 'off';
    const curFmt = API_CONFIG.providers[getProviderForModel(current)]?.format || 'anthropic';

    for (const id of chain) {
        if (id === current) continue;
        const prov = getProviderForModel(id);
        if (!getProviderKey(prov)) continue;          // 沒金鑰
        if (isCoolingDown(id)) continue;              // 冷卻中
        if (thinking) {
            const fmt = API_CONFIG.providers[prov]?.format || 'anthropic';
            if (fmt !== curFmt) continue;             // 見上方說明
        }
        return id;
    }
    return null;
}

async function streamChat(opts) {
    const {
        model, system = '', messages = [], tools = [],
        maxTokens, temperature, signal,
        onText, onThinking, onToolStart, onToolInput, onDone, onError,
        forceTransport,
    } = opts;

    const provider = getProviderForModel(model);
    const key = getProviderKey(provider);
    if (!key) {
        const err = new Error(`尚未設定 ${API_CONFIG.providers[provider]?.label || provider} 的 API Key`);
        err.code = 'NO_KEY'; err.provider = provider;
        throw err;
    }

    const transport = forceTransport || OC?.cfg?.transport || 'direct';

    // 思考等級：呼叫端指定 > 使用者設定 > 預設。已知不支援的模型直接跳過。
    // Effort：呼叫端指定 > 使用者設定 > 預設，再依模型上限降級（CC 的規則）
    let think = opts.thinking
        ?? (window.resolveEffort ? resolveEffort(model, OC?.cfg?.effortLevel) : OC?.cfg?.effortLevel)
        ?? API_CONFIG.effort.default;
    if (think !== 'off' && thinkingUnsupported(model)) think = 'off';

    let req = buildRequest(provider, { model, system, messages, tools, maxTokens, temperature, key, think });

    // 只要已經有內容送到畫面上，這次請求就不能重試——
    // 重試會把新一輪的文字接在舊文字後面，使用者看到的是重複的半截回覆。
    let emitted = false;
    const mark = (fn) => fn ? ((...a) => { emitted = true; return fn(...a); }) : fn;
    const cbs = {
        onText: mark(onText), onThinking: mark(onThinking),
        onToolStart: mark(onToolStart), onToolInput: mark(onToolInput),
    };
    const maxRetry = API_CONFIG.retry.max;

    const _t0 = Date.now();
    for (let attempt = 0; ; attempt++) {
        try {
            const res = await openStream(req, transport, signal, attempt);
            const result = await parseStream(req.format, res, cbs, signal, req.stream);

            // 空回應（stop 卻一個內容塊都沒有）偶爾發生在供應商端 ——
            // 對呼叫端而言就是壞回應，安靜地回空只會讓代理迴圈莫名終止
            if (!result.content?.length && !emitted) {
                const ee = new Error('模型回傳了空回應');
                ee.code = 'EMPTY_RESPONSE';
                throw ee;
            }

            // 回覆因長度上限被截斷時，殘缺的 tool_use 參數「不能執行」——
            // parseJsonLoose 會把截斷的 JSON「修」成看似合理實則錯誤的參數，
            // 執行下去就是拿錯誤參數去改檔案。截斷回合一律拔掉工具呼叫，
            // 讓呼叫端提示使用者「繼續」。
            if ((result.stopReason === 'max_tokens' || result.stopReason === 'length'
                 || result.stopReason === 'MAX_TOKENS')
                && result.content.some(b => b.type === 'tool_use')) {
                result.content = result.content.filter(b => b.type !== 'tool_use');
                result.truncatedToolCalls = true;
            }
            // 逐筆記錄流量與成本（失敗不影響主流程，見 usage.js）
            window.recordUsage?.({
                model, provider, usage: result.usage, ms: Date.now() - _t0,
                purpose: opts.purpose || 'agent',
            });
            onDone?.(result);
            return result;
        } catch (e) {
            if (e.name === 'AbortError' || signal?.aborted) throw e;

            // 這個模型不吃思考參數 → 記下來、拿掉、重試一次。
            // 不這樣做的話，只要使用者選到不支援思考的模型就完全無法對話，
            // 而錯誤訊息（"unknown field thinking"）也完全看不出是設定問題。
            if (think !== 'off' && !emitted && e.status === 400 && isThinkingRejection(e)) {
                markThinkingUnsupported(model);
                window.OCLog?.(`模型 ${model} 不支援擴展思考，已自動關閉並重試`);
                think = 'off';
                req = buildRequest(provider, { model, system, messages, tools, maxTokens, temperature, key, think });
                attempt--;   // 這不是「失敗重試」而是換一組參數，不該吃掉 429/5xx 的重試額度
                continue;
            }

            const retriable = (e.status === 429 || (e.status >= 500 && e.status < 600)
                               || e.code === 'NETWORK' || e.code === 'EMPTY_RESPONSE')
                              && !emitted;
            if (retriable && attempt < maxRetry) {
                const backoff = API_CONFIG.retry.baseDelayMs * Math.pow(2, attempt) + Math.random() * 400;
                const wait = Math.max(backoff, e.retryAfterMs || 0);
                window.OCLog?.(`供應商回應 ${e.status || e.code}，${Math.round(wait / 1000)} 秒後重試（第 ${attempt + 1}/${maxRetry} 次）`);
                await sleep(wait);
                continue;
            }
            // 重試用盡且是「這個模型現在不行」類的錯誤 → 記冷卻，
            // 讓呼叫端可以換一個模型繼續，而不是整輪結束
            if (e.code === 'RATE_LIMIT' || e.code === 'OVERLOADED'
                || (e.status >= 500 && e.status < 600)) {
                coolDownModel(model);
            }
            onError?.(e);
            throw e;
        }
    }
}

// ─── 擴展思考：哪些模型被 API 明確拒絕過 ───
// 供應商不提供「這個模型支不支援思考」的查詢，硬寫白名單又會過期。
// 改為：被拒絕一次就記下來，之後不再對該模型送思考參數。
const THINK_NG_KEY = 'oc_thinking_unsupported';
function thinkingUnsupported(model) {
    try { return (JSON.parse(localStorage.getItem(THINK_NG_KEY) || '[]')).includes(model); }
    catch { return false; }
}
function markThinkingUnsupported(model) {
    try {
        const l = JSON.parse(localStorage.getItem(THINK_NG_KEY) || '[]');
        if (!l.includes(model)) { l.push(model); localStorage.setItem(THINK_NG_KEY, JSON.stringify(l)); }
    } catch {}
}
// 這個錯誤是不是「模型不支援思考參數」造成的
function isThinkingRejection(e) {
    const m = String(e?.detail || e?.message || '').toLowerCase();
    return /thinking|reasoning|budget_tokens|thinkingbudget|reasoning_effort|thought/.test(m);
}
window.resetThinkingSupport = () => localStorage.removeItem(THINK_NG_KEY);

// 建立各供應商的請求（url / headers / body）
// think：思考等級（'off'|'standard'|'deep'|'max'），null 代表這次不送思考參數
function buildRequest(provider, { model, system, messages, tools, maxTokens, temperature, key, think }) {
    const gen = API_CONFIG.generation;
    const mt = maxTokens || gen.maxTokens;
    const P = API_CONFIG.providers;
    const TH = (think && think !== 'off') ? API_CONFIG.effort.levels[think] : null;
    const pcfg = P[provider] || {};
    // 以「格式」而非供應商名稱決定轉譯器，自訂供應商才能沿用既有實作
    const fmt = pcfg.format || (provider === 'anthropic' ? 'anthropic'
                              : provider === 'gemini' ? 'gemini' : 'openai');
    const wantStream = pcfg.supportsStream !== false;

    // ─── Responses API 格式（Meta AI 等）───
    if (fmt === 'responses') {
        const body = {
            model,
            input: msgsForResponses(messages),
            stream: wantStream,
        };
        if (system) body.instructions = system;
        if (tools.length) body.tools = toolsForResponses(tools);
        // 刻意不送 max_output_tokens：官方範例沒有這個欄位，
        // 而多送一個對方不認得的欄位可能讓整個請求 400。
        // 需要的話在供應商設定的 extraBody 自行加。
        if (pcfg.extraBody && typeof pcfg.extraBody === 'object') Object.assign(body, pcfg.extraBody);
        const headers = {
            'content-type': 'application/json',
            [pcfg.authHeader || 'authorization']: (pcfg.authPrefix ?? 'Bearer ') + key,
            ...(pcfg.extraHeaders || {}),
        };
        return { provider, format: fmt, stream: wantStream, url: pcfg.endpoint(model), headers, body };
    }

    if (fmt === 'anthropic') {
        const body = {
            model,
            max_tokens: mt,
            messages: msgsForAnthropic(messages),
            stream: wantStream,
        };
        // 提示快取：在前綴的三個穩定邊界放斷點（tools 尾端、system、訊息尾端）。
        // 沒有這些斷點的話，每一步都用未快取價格重算整個系統提示與工具定義 ——
        // 長會話下這是好幾倍的費用差距。訊息尾端的斷點讓「上一輪為止的對話」
        // 在下一步全部命中快取。
        if (system) body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
        if (tools.length) {
            body.tools = toolsForAnthropic(tools);
            body.tools[body.tools.length - 1].cache_control = { type: 'ephemeral' };
        }
        const lastMsg = body.messages[body.messages.length - 1];
        const lastBlk = lastMsg?.content?.[lastMsg.content.length - 1];
        // thinking 塊不接受 cache_control，其他常見塊都可以
        if (lastBlk && ['text', 'tool_result', 'image', 'tool_use'].includes(lastBlk.type)) {
            lastBlk.cache_control = { type: 'ephemeral' };
        }
        // 擴展思考：budget_tokens 必須小於 max_tokens，且最低 1024。
        // 預算吃掉的是 max_tokens 的額度，所以要一併把上限抬高，
        // 否則思考用完額度就沒有 token 留給實際回覆了。
        if (TH?.anthropic) {
            // budget_tokens 最低 1024，且必須小於 max_tokens。
            // 舊寫法把預算夾在 (maxTokens - 1024)=15360 以下，等於把 12288 以上的
            // 等級全部壓成同一個數字 —— high / xhigh / max 完全沒有差別。
            // 改成讓預算決定 max_tokens：思考預算是「額外」的，回覆本身還要留 mt。
            const budget = Math.max(1024, TH.anthropic);
            body.thinking = { type: 'enabled', budget_tokens: budget };
            body.max_tokens = Math.min(64000, budget + mt);   // 64000 是 Sonnet 級的輸出上限
        }
        // 新版 Claude 模型已移除取樣參數，傳入會被 API 拒絕 → 一律不傳
        return {
            provider, format: fmt, stream: wantStream,
            url: pcfg.endpoint ? pcfg.endpoint(model) : P.anthropic.endpoint(),
            headers: {
                'content-type': 'application/json',
                'x-api-key': key,
                'anthropic-version': P.anthropic.apiVersion,
                'anthropic-dangerous-direct-browser-access': 'true',
            },
            body,
        };
    }

    if (fmt === 'openai') {
        const body = {
            model,
            messages: msgsForOpenAI(messages, system),
            stream: wantStream,
            ...(wantStream ? { stream_options: { include_usage: true } } : {}),
        };
        if (tools.length) { body.tools = toolsForOpenAI(tools); body.tool_choice = 'auto'; }
        if (provider === 'openai') body.max_completion_tokens = mt;
        else body.max_tokens = mt;
        if (temperature !== undefined) body.temperature = temperature;
        // 擴展思考：OpenAI 用 reasoning_effort，OpenRouter 用 reasoning 物件。
        // xhigh / max 在等級表裡就已經寫成 'high' —— OpenAI 的 enum 只到 high，
        // 這是 CC 的降級規則，不是偷懶。
        if (TH?.effort) {
            if (provider === 'openai') body.reasoning_effort = TH.effort;
            else body.reasoning = { effort: TH.effort };
        }
        const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + key };
        if (provider === 'openrouter') {
            headers['HTTP-Referer'] = location.origin;
            headers['X-Title'] = 'Omni Code';
        }
        return { provider, format: fmt, stream: wantStream, url: pcfg.endpoint(model), headers, body };
    }

    // Gemini
    const body = {
        contents: msgsForGemini(messages),
        generationConfig: {
            temperature: temperature ?? gen.temperature,
            topP: gen.topP,
            maxOutputTokens: mt,
        },
        safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        ],
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    // 擴展思考：includeThoughts 讓思考摘要串流回來（會顯示在思考區塊）
    if (TH?.gemini) {
        body.generationConfig.thinkingConfig = { thinkingBudget: TH.gemini, includeThoughts: true };
    }
    if (tools.length) {
        body.tools = toolsForGemini(tools);
        body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    }
    return {
        provider, format: fmt, stream: wantStream,
        url: (wantStream && P.gemini.streamEndpoint ? P.gemini.streamEndpoint(model)
                                                    : P.gemini.endpoint(model)) + (wantStream ? '&' : '?') + 'key=' + encodeURIComponent(key),
        headers: { 'content-type': 'application/json' },
        body,
        // relay 走的是無金鑰 URL + header 帶金鑰（避免金鑰出現在後端日誌 URL）
        relayUrl: P.gemini.streamEndpoint(model),
        relayHeaders: { 'content-type': 'application/json', 'x-goog-api-key': key },
    };
}

// 開啟串流連線（direct，失敗時自動改走 relay）
async function openStream(req, transport, signal, attempt) {
    const doDirect = async () => {
        const res = await fetch(req.url, {
            method: 'POST',
            headers: req.headers,
            body: JSON.stringify(req.body),
            signal,
        });
        if (!res.ok) throw await providerError(res, req.provider);
        return res;
    };
    const doRelay = async () => {
        const res = await RELAY.chatStream({
            url: req.relayUrl || req.url,
            headers: req.relayHeaders || req.headers,
            body: req.body,
        }, signal);
        if (!res.ok) throw await providerError(res, req.provider);
        return res;
    };

    if (transport === 'relay') return doRelay();
    try {
        return await doDirect();
    } catch (e) {
        if (e.name === 'AbortError' || signal?.aborted) throw e;
        // TypeError = CORS / 網路層失敗 → 改走後端中繼
        if (e instanceof TypeError || e.code === 'NETWORK') {
            window.OCLog?.('直連失敗，改用後端中繼（relay）重試');
            try { return await doRelay(); }
            catch (e2) {
                if (e2.name === 'AbortError') throw e2;
                const err = new Error(`直連與中繼皆失敗：${e2.message}`);
                err.code = 'NETWORK';
                throw err;
            }
        }
        throw e;
    }
}

// 從供應商的錯誤回應萃取可讀訊息
/** 把四家供應商各說各話的錯誤訊息歸一成固定代碼，讓呼叫端能「按碼分流」：
 *  上下文爆了 → 壓縮後重試；限流 → 按 Retry-After 等；其他 → 照舊。
 *  比對的是錯誤本文 —— 上下文超限通常是 400，光看狀態碼分不出來。 */
function classifyLlmError(status, text) {
    const t = String(text || '');
    if (/prompt is too long|context[_ ]length|maximum context|context window|exceeds? the (maximum|token)|too many total (text bytes|tokens)|input token count.{0,40}exceeds|max_tokens.{0,30}exceeds/i.test(t)) {
        return 'CONTEXT_WINDOW_EXCEEDED';
    }
    if (status === 429 || /RESOURCE_EXHAUSTED|rate[_ ]?limit/i.test(t)) return 'RATE_LIMIT';
    if (status === 529 || /overloaded/i.test(t)) return 'OVERLOADED';
    if (status === 401 || status === 403) return 'AUTH';
    return '';
}

async function providerError(res, provider) {
    let msg = `HTTP ${res.status} ${res.statusText}`;
    let detail = '';
    try {
        const text = await res.text();
        detail = text.slice(0, 1200);
        const j = JSON.parse(text);
        msg = j.error?.message || j.error?.type || j.message
            || (Array.isArray(j) ? j[0]?.error?.message : '') || msg;
    } catch {}
    const label = API_CONFIG.providers[provider]?.label || provider;
    const e = new Error(`${label} 回應錯誤（${res.status}）：${msg}`);
    e.status = res.status;
    e.detail = detail;
    e.code = classifyLlmError(res.status, detail) || (res.status === 401 || res.status === 403 ? 'AUTH' : undefined);
    // 供應商明講要等多久就照它說的等，不要自己猜
    const ra = parseFloat(res.headers?.get?.('retry-after'));
    if (Number.isFinite(ra) && ra > 0) e.retryAfterMs = Math.min(ra * 1000, 120000);
    return e;
}

// ─── 串流解析 ───────────────────────────────────────────────────

// 依「格式」而非供應商名稱分派 —— 自訂供應商才能沿用既有轉譯器。
async function parseStream(format, res, cbs, signal, stream = true) {
    if (!stream) {
        // 非串流：整包 JSON 回來，用同一組結構回傳，呼叫端無感
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); }
        catch { throw new Error(`回應不是合法 JSON（前 200 字）：${text.slice(0, 200)}`); }
        switch (format) {
            case 'responses': return parseResponsesJson(data, cbs);
            case 'anthropic': return parseAnthropicJson(data, cbs);
            case 'gemini':    return parseGeminiJson(data, cbs);
            default:          return parseOpenAIJson(data, cbs);
        }
    }
    if (!res.body) throw new Error('瀏覽器不支援串流回應');
    switch (format) {
        case 'anthropic': return parseAnthropicStream(res, cbs, signal);
        case 'gemini':    return parseGeminiStream(res, cbs, signal);
        case 'responses': return parseResponsesStream(res, cbs, signal);
        default:          return parseOpenAIStream(res, cbs, signal);
    }
}

// Anthropic Messages API 串流
async function parseAnthropicStream(res, cbs, signal) {
    const content = [];
    const usage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
    let stopReason = null;
    const partial = {};   // index -> {type, ...}

    for await (const evt of sseEvents(res.body, signal)) {
        if (evt.data === '[DONE]') break;
        let d;
        try { d = JSON.parse(evt.data); } catch { continue; }

        if (d.type === 'error' || evt.event === 'oc_error') {
            const m = (typeof d.error === 'string' ? d.error : (d.error?.message || d.error?.type)) || d.message || '串流錯誤';
            const e = new Error(`Claude 串流錯誤：${m}`);
            e.status = d.status || d.error?.status;
            throw e;
        }
        if (d.type === 'message_start') {
            const u = d.message?.usage || {};
            usage.input += u.input_tokens || 0;
            usage.cache_read += u.cache_read_input_tokens || 0;
            usage.cache_write += u.cache_creation_input_tokens || 0;
            continue;
        }
        if (d.type === 'content_block_start') {
            const b = d.content_block || {};
            if (b.type === 'text') partial[d.index] = { type: 'text', text: '' };
            else if (b.type === 'thinking') partial[d.index] = { type: 'thinking', text: '', _sig: '' };
            // redacted_thinking：內容被加密，我們原封不動保存並回送
            else if (b.type === 'redacted_thinking') partial[d.index] = { type: 'thinking', text: '', _redacted: b.data || '' };
            else if (b.type === 'tool_use') {
                partial[d.index] = { type: 'tool_use', id: b.id, name: b.name, _json: '' };
                cbs.onToolStart?.({ id: b.id, name: b.name });
            }
            continue;
        }
        if (d.type === 'content_block_delta') {
            const p = partial[d.index];
            if (!p) continue;
            const dl = d.delta || {};
            if (dl.type === 'text_delta') { p.text += dl.text; cbs.onText?.(dl.text); }
            else if (dl.type === 'thinking_delta') { p.text += dl.thinking; cbs.onThinking?.(dl.thinking); }
            // ★ 思考區塊的簽章。開啟擴展思考又用工具時，下一輪必須把
            // thinking 區塊連同這組簽章原樣送回，否則 Anthropic 會拒絕整個請求
            // （與 Gemini 的 thoughtSignature 是同一類要求）。
            else if (dl.type === 'signature_delta') { p._sig = (p._sig || '') + (dl.signature || ''); }
            else if (dl.type === 'input_json_delta') { p._json += dl.partial_json; cbs.onToolInput?.(p.id, dl.partial_json); }
            continue;
        }
        if (d.type === 'content_block_stop') {
            const p = partial[d.index];
            if (!p) continue;
            if (p.type === 'tool_use') {
                p.input = safeJson(p._json);
                delete p._json;
            }
            content.push(p);
            delete partial[d.index];
            continue;
        }
        if (d.type === 'message_delta') {
            stopReason = d.delta?.stop_reason || stopReason;
            usage.output += d.usage?.output_tokens || 0;
            continue;
        }
    }
    // 保險：未收到 content_block_stop 的殘餘區塊
    for (const p of Object.values(partial)) {
        if (p.type === 'tool_use') { p.input = safeJson(p._json); delete p._json; }
        content.push(p);
    }
    return { content, stopReason, usage };
}

// OpenAI / OpenRouter chat.completions 串流
async function parseOpenAIStream(res, cbs, signal) {
    let text = '';
    let reasoning = '';
    const calls = [];       // index -> {id,name,args}
    const started = new Set();
    const usage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
    let stopReason = null;

    for await (const evt of sseEvents(res.body, signal)) {
        if (evt.data === '[DONE]') break;
        let d;
        try { d = JSON.parse(evt.data); } catch { continue; }

        if (evt.event === 'oc_error' || d.error) {
            const m = (typeof d.error === 'string' ? d.error : (d.error?.message || d.error?.type)) || d.message || '串流錯誤';
            const e = new Error(`供應商串流錯誤：${m}`);
            e.status = d.error?.code || d.status;
            throw e;
        }
        if (d.usage) {
            usage.input = d.usage.prompt_tokens || usage.input;
            usage.output = d.usage.completion_tokens || usage.output;
            usage.cache_read = d.usage.prompt_tokens_details?.cached_tokens || usage.cache_read;
        }
        const choice = d.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) stopReason = choice.finish_reason;
        const delta = choice.delta || {};

        if (delta.content) { text += delta.content; cbs.onText?.(delta.content); }
        // OpenRouter / 部分模型的思考鏈欄位
        const rc = delta.reasoning_content ?? delta.reasoning;
        if (typeof rc === 'string' && rc) { reasoning += rc; cbs.onThinking?.(rc); }

        for (const tc of (delta.tool_calls || [])) {
            const i = tc.index ?? 0;
            if (!calls[i]) calls[i] = { id: '', name: '', args: '' };
            if (tc.id) calls[i].id = tc.id;
            if (tc.function?.name) calls[i].name += tc.function.name;
            if (calls[i].name && !started.has(i)) {
                started.add(i);
                cbs.onToolStart?.({ id: calls[i].id || 'call_' + i, name: calls[i].name });
            }
            if (tc.function?.arguments) {
                calls[i].args += tc.function.arguments;
                cbs.onToolInput?.(calls[i].id || 'call_' + i, tc.function.arguments);
            }
        }
    }

    const content = [];
    if (reasoning) content.push({ type: 'thinking', text: reasoning });
    if (text) content.push({ type: 'text', text });
    calls.forEach((c, i) => {
        if (!c || !c.name) return;
        content.push({ type: 'tool_use', id: c.id || 'call_' + i, name: c.name, input: safeJson(c.args) });
    });
    return { content, stopReason, usage };
}

// Gemini streamGenerateContent?alt=sse
async function parseGeminiStream(res, cbs, signal) {
    let text = '';
    let thinking = '';
    let textSig = null;              // 文字 part 的 thoughtSignature（下一輪要原樣回送）
    const toolUses = [];
    const usage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
    let stopReason = null;
    let blockReason = null;
    let n = 0;

    for await (const evt of sseEvents(res.body, signal)) {
        if (evt.data === '[DONE]') break;
        let d;
        try { d = JSON.parse(evt.data); } catch { continue; }

        if (evt.event === 'oc_error' || d.error) {
            const m = (typeof d.error === 'string' ? d.error : (d.error?.message || d.error?.type)) || d.message || '串流錯誤';
            const e = new Error(`Gemini 串流錯誤：${m}`);
            e.status = d.error?.code || d.status;
            throw e;
        }
        if (d.promptFeedback?.blockReason) blockReason = d.promptFeedback.blockReason;
        if (d.usageMetadata) {
            usage.input = d.usageMetadata.promptTokenCount || usage.input;
            usage.output = d.usageMetadata.candidatesTokenCount || usage.output;
            usage.cache_read = d.usageMetadata.cachedContentTokenCount || usage.cache_read;
        }
        const cand = d.candidates?.[0];
        if (!cand) continue;
        if (cand.finishReason) stopReason = cand.finishReason;
        for (const part of (cand.content?.parts || [])) {
            // Gemini 3 起，帶思考的回應會在 part 上附一組 thoughtSignature。
            // 下一輪把對話送回去時「必須原封不動附回同一個 part」，否則 API 直接回 400：
            //   Function call is missing a thought_signature in functionCall parts
            // 這個欄位是不透明字串，我們只負責保存與回送，不解讀也不修改。
            const sig = part.thoughtSignature || part.thought_signature || null;

            if (part.functionCall) {
                const id = 'gcall_' + (++n) + '_' + Date.now().toString(36);
                const tu = { type: 'tool_use', id, name: part.functionCall.name, input: part.functionCall.args || {} };
                if (sig) tu._sig = sig;
                toolUses.push(tu);
                cbs.onToolStart?.({ id, name: tu.name });
                cbs.onToolInput?.(id, JSON.stringify(tu.input));
            } else if (typeof part.text === 'string' && part.text) {
                if (part.thought) { thinking += part.text; cbs.onThinking?.(part.text); }
                else {
                    text += part.text;
                    if (sig) textSig = sig;          // 純文字 part 也可能帶簽章
                    cbs.onText?.(part.text);
                }
            }
        }
    }

    if (!text && !toolUses.length) {
        if (blockReason) throw new Error(`提示詞被 Gemini 安全過濾攔截（${blockReason}），請改用其他模型`);
        if (stopReason && stopReason !== 'STOP') {
            const map = {
                SAFETY: '輸出被安全過濾攔截（SAFETY）',
                PROHIBITED_CONTENT: '輸出被安全過濾攔截（PROHIBITED_CONTENT）',
                RECITATION: '內容重複性攔截（RECITATION）',
                MAX_TOKENS: '輸出長度用盡（MAX_TOKENS）',
                MALFORMED_FUNCTION_CALL: '模型產生了格式錯誤的工具呼叫，請重試或換模型',
            };
            throw new Error('Gemini ' + (map[stopReason] || `異常結束（${stopReason}）`));
        }
    }

    const content = [];
    if (thinking) content.push({ type: 'thinking', text: thinking });
    if (text) {
        const tb = { type: 'text', text };
        if (textSig) tb._sig = textSig;
        content.push(tb);
    }
    content.push(...toolUses);
    return { content, stopReason, usage };
}

function safeJson(s) {
    if (!s || !s.trim()) return {};
    try { return JSON.parse(s); } catch {}
    try { return parseJsonLoose(s); } catch {}
    return { _parse_error: true, _raw: String(s).slice(0, 2000) };
}

// ═══════════════════════════════════════════════════════════════
// 非串流一次性呼叫（壓縮摘要、標題生成等內部用途）
// ═══════════════════════════════════════════════════════════════
async function callOnce(prompt, { system = '', model = null, maxTokens = 4096, signal = null, purpose = 'other' } = {}) {
    const mid = model || OC.cfg.model;
    let out = '';
    await streamChat({
        model: mid,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        tools: [],
        maxTokens,
        signal,
        onText: (t) => { out += t; },
    });
    return out.trim();
}

// 挑一個「有金鑰可用」的模型，優先用指定的 featureModel
function pickFeatureModel(featureKey) {
    const want = API_CONFIG.featureModels[featureKey]?.id;
    if (want && getProviderKey(getProviderForModel(want))) return want;
    const avail = availableModels();
    // 偏好 fast 級別以省成本
    return (avail.find(m => m.tier === 'fast') || avail[0] || API_CONFIG.models[0]).id;
}

// ═══════════════════════════════════════════════════════════════
// 圖片生成（Gemini generateContent，responseModalities: IMAGE）
// cutout:true = 綠幕生成＋前端去背，回傳多帶 cutoutDataUrl（失敗則為空字串，原圖不受影響）
// ═══════════════════════════════════════════════════════════════
async function generateImage({ model, prompt, refs = [], aspect = '1:1', size = '2K', cutout = false, signal } = {}) {
    const _imgT0 = Date.now();
    // 沒指定就用「主要繪圖模型」（模型管理面板設定，存在 data/models.json）。
    // 這是 Agent 生圖固定使用的那一個 —— 不再依清單順序碰運氣。
    const mid = model
        || (window.primaryImageModel ? primaryImageModel() : '')
        || OC.cfg.imageModel
        || API_CONFIG.imageModels[0]?.id;
    if (!mid) {
        const e = new Error('沒有可用的繪圖模型。請到「模型管理 → 繪圖模型」新增一個並設為主要。');
        e.code = 'NO_IMAGE_MODEL';
        throw e;
    }
    // 按模型的供應商分流：provider 判定優先，不依賴脆弱的 id 正則。
    // muse 直連走 Responses 圖生圖分支；openrouter 一律走 OR（再按 id 分
    // /v1/images 或 chat＋modalities）；其餘才走 Gemini 直連。
    // （之前用正則比 id，舊版快取或自訂 id 會靜默掉回 Gemini 分支，
    //  對著 generativelanguage 打 OR 的模型 id，吃 CORS 擋掉是應該的。）
    const imgProvider = getProviderForModel(mid);
    if (imgProvider === 'meta') {
        return generateImageMeta({ model: mid, prompt, refs, aspect, size, cutout, signal, _imgT0 });
    }
    if (imgProvider === 'openrouter') {
        if (/muse-image|gpt-image/i.test(mid)) {
            return generateImageOpenRouter({ model: mid, prompt, refs, aspect, size, cutout, signal, _imgT0 });
        }
        return generateImageORChat({ model: mid, prompt, refs, aspect, size, cutout, signal, _imgT0 });
    }
    const key = getProviderKey('gemini');
    if (!key) {
        const e = new Error('圖片生成需要 Google Gemini API Key，請先到「API Key 設定」填入');
        e.code = 'NO_KEY'; e.provider = 'gemini';
        throw e;
    }

    const parts = [];
    refs.forEach((r, i) => {
        parts.push({ inlineData: { mimeType: r.mime, data: r.data } });
        parts.push({ text: `參考圖 ${i + 1}${r.label ? `：${r.label}` : ''}` });
    });
    // cutout 走 Agent 工具時 prompt 還沒加綠幕指示，這裡補上（工作室 UI 版已由 _isFinalPrompt 加過，重複加也無害）
    const finalPrompt = cutout && !/chroma green/i.test(prompt)
        ? prompt + '\nThe background MUST be one solid pure chroma green (#00FF00), completely flat, no gradient, no pattern, no shadow on the background. '
            + 'Do not use any green colour on the subject, clothing, hair or accessories — green must appear only in the background. '
            + 'Composition: single subject, centred, with clear empty margin on all four sides.'
        : prompt;
    parts.push({ text: finalPrompt });

    const body = {
        contents: [{ role: 'user', parts }],
        generationConfig: {
            responseModalities: ['IMAGE', 'TEXT'],
            imageConfig: { aspectRatio: aspect, imageSize: size },
        },
        safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        ],
    };

    const url = API_CONFIG.providers.gemini.endpoint(mid);
    const transport = OC?.cfg?.transport || 'direct';
    let data;

    const viaRelay = () => RELAY.json({
        url, headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body,
    }, signal);

    if (transport === 'relay') {
        data = await viaRelay();
    } else {
        try {
            const res = await fetch(url + '?key=' + encodeURIComponent(key), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal,
            });
            if (!res.ok) throw await providerError(res, 'gemini');
            data = await res.json();
        } catch (e) {
            if (e.name === 'AbortError') throw e;
            if (e instanceof TypeError) data = await viaRelay();
            else throw e;
        }
    }

    if (data?.error) throw new Error(`圖片生成失敗：${data.error.message || JSON.stringify(data.error)}`);
    const parts2 = data?.candidates?.[0]?.content?.parts || [];
    const img = parts2.find(p => p.inlineData?.mimeType?.startsWith('image/'));
    if (!img) {
        const txt = parts2.map(p => p.text).filter(Boolean).join(' ').slice(0, 300);
        const fr = data?.candidates?.[0]?.finishReason;
        throw new Error(`模型未回傳圖片${fr ? `（${fr}）` : ''}${txt ? `：${txt}` : ''}`);
    }
    // 繪圖模型計價是「每張」而非 token，用 images 欄位記錄
    window.recordUsage?.({
        model: mid, provider: 'gemini',
        usage: { input: data?.usageMetadata?.promptTokenCount || 0, output: 0 },
        ms: Date.now() - _imgT0, purpose: 'image', images: 1,
    });

    return {
        dataUrl: `data:${img.inlineData.mimeType};base64,${img.inlineData.data}`,
        mime: img.inlineData.mimeType,
        text: parts2.map(p => p.text).filter(Boolean).join('\n'),
        // 去背是純前端演算：綠幕圖先請模型畫純 #00FF00 背景，再用工作室同款 chromaKey 挖掉
        cutoutDataUrl: cutout && window.studioChromaKey
            ? await window.studioChromaKey(`data:${img.inlineData.mimeType};base64,${img.inlineData.data}`).catch(() => '')
            : '',
    };
}

// ═══════════════════════════════════════════════════════════════
// 圖片生成（Meta Responses：muse-image-1.0）
// ═══════════════════════════════════════════════════════════════
// 請求形狀沿用文字鏈路已驗證的 Responses 格式（model / input / stream:false）。
// 圖片回傳欄位官方文件未公開 —— 這裡盡力從 output 裡撈 image 類 item，
// 撈不到就把原始回應前 500 字丟給呼叫端，第一次呼叫後按真實形狀調解析器。
// 圖片生成（Meta Responses：muse-image-1.0）
// ═══════════════════════════════════════════════════════════════
// 請求形狀：Responses 的 image_generation 工具宣告（沿用 OpenAI 公開規格，
// 同 Responses 家族）。沒帶 tools 的話模型只當文字任務回 reasoning，
// output 永遠沒有圖片 —— 這正是之前「模型未回傳圖片」的根因。
// muse 解析度只有三檔（官方 image-generation 文件附圖）：
//   1024x1024（1:1）/ 1024x1536（直）/ 1536x1024（橫）
// 舊的 1K/2K 標籤（Agent 工具鏈）自動對應到最接近的一檔。
const META_SIZE_MAP = {
    '1024x1024': '1024x1024',
    '1024x1536': '1024x1536',
    '1536x1024': '1536x1024',
    '1:1': '1024x1024', '3:4': '1024x1536', '2:3': '1024x1536', '9:16': '1024x1536',
    '4:3': '1536x1024', '3:2': '1536x1024', '16:9': '1536x1024',
    '512': '1024x1024', '1K': '1024x1024', '2K': '1024x1024', '4K': '1536x1024',
};
function metaImageSize(size, aspect) {
    if (META_SIZE_MAP[size]) return META_SIZE_MAP[size];
    // 沒給 size 就按長寬比猜方向
    const a = String(aspect || '1:1');
    const [w, h] = a.split(':').map(Number);
    if (w && h) return w >= h ? (w === h ? '1024x1024' : '1536x1024') : '1024x1536';
    return '1024x1024';
}
async function generateImageMeta({ model: mid, prompt, refs = [], aspect = '1:1', size = '2K', cutout = false, signal, _imgT0 = Date.now() } = {}) {
    const key = getProviderKey('meta');
    if (!key) {
        const e = new Error('圖片生成需要 Meta API Key，請先到「API Key 設定」填入');
        e.code = 'NO_KEY'; e.provider = 'meta';
        throw e;
    }
    const pcfg = API_CONFIG.providers.meta || {};
    // cutout 綠幕後綴跟 Gemini 分支同一份（Agent 工具鏈不加後綴時這裡補）
    const finalPrompt = cutout && !/chroma green/i.test(prompt)
        ? prompt + '\nThe background MUST be one solid pure chroma green (#00FF00), completely flat, no gradient, no pattern, no shadow on the background. '
            + 'Do not use any green colour on the subject, clothing, hair or accessories — green must appear only in the background. '
            + 'Composition: single subject, centred, with clear empty margin on all four sides.'
        : prompt;
    const content = [{ type: 'input_text', text: finalPrompt }];
    for (const r of refs.slice(0, 5)) {
        content.push({ type: 'input_image', image_url: `data:${r.mime};base64,${r.data}` });
    }
    const metaSize = metaImageSize(size, aspect);
    const body = {
        model: mid,
        input: [{ role: 'user', content }],
        stream: false,
        tools: [{ type: 'image_generation', size: metaSize }],
    };
    if (pcfg.extraBody && typeof pcfg.extraBody === 'object') Object.assign(body, pcfg.extraBody);
    const headers = {
        'content-type': 'application/json',
        [pcfg.authHeader || 'authorization']: (pcfg.authPrefix ?? 'Bearer ') + key,
        ...(pcfg.extraHeaders || {}),
    };
    const url = pcfg.endpoint ? pcfg.endpoint(mid) : 'https://api.meta.ai/v1/responses';
    const transport = OC?.cfg?.transport || 'direct';
    const viaRelay = () => RELAY.json({ url, headers, body }, signal);
    let data;
    if (transport === 'relay') {
        data = await viaRelay();
    } else {
        try {
            const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
            if (!res.ok) throw await providerError(res, 'meta');
            data = await res.json();
        } catch (e) {
            if (e.name === 'AbortError') throw e;
            if (e instanceof TypeError) data = await viaRelay();
            else throw e;
        }
    }
    if (data?.error) throw new Error(`圖片生成失敗：${data.error.message || JSON.stringify(data.error)}`);

    // output 裡撈圖片：優先 image_generation_call 的結果（base64），
    // 其次常見形狀 output_image / image_url / inlineData
    let dataUrl = '', outText = '';
    const seen = [];
    const visit = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(visit); return; }
        // image_generation_call 的結果：result 欄位即 base64 圖
        if ((node.type === 'image_generation_call' || node.type === 'image_generation')
            && typeof node.result === 'string' && node.result.length > 100) {
            dataUrl = node.result.startsWith('data:image/')
                ? node.result
                : `data:image/png;base64,${node.result}`;
            return;
        }
        if (typeof node.b64_json === 'string' && node.b64_json.length > 100) {
            dataUrl = `data:${node.mime_type || node.mimeType || 'image/png'};base64,${node.b64_json}`;
            return;
        }
        if (typeof node.image_url === 'string' && node.image_url.startsWith('data:image/')) {
            dataUrl = node.image_url;
            return;
        }
        if (node.inlineData?.data) {
            dataUrl = `data:${node.inlineData.mimeType || 'image/png'};base64,${node.inlineData.data}`;
            return;
        }
        if (typeof node.url === 'string' && /^https?:/.test(node.url)) seen.push(node.url);
        if (node.type === 'output_text' && node.text) outText += node.text;
        Object.values(node).forEach(visit);
    };
    visit(data?.output);
    if (!dataUrl && typeof data?.output_text === 'string') outText += data.output_text;
    if (!dataUrl) {
        // URL 形狀：先抓回來轉 dataURL，工作室後續流程才吃得動
        if (seen.length) {
            const dl = await fetch(seen[0], { signal });
            if (!dl.ok) throw new Error(`圖片 URL 下載失敗：HTTP ${dl.status}`);
            const buf = new Uint8Array(await dl.arrayBuffer());
            let bin = '';
            for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
            const mime = dl.headers.get('content-type')?.split(';')[0] || 'image/png';
            dataUrl = `data:${mime};base64,${btoa(bin)}`;
        } else {
            throw new Error(`模型未回傳圖片。原始回應前 500 字：${JSON.stringify(data).slice(0, 500)}`);
        }
    }
    window.recordUsage?.({
        model: mid, provider: 'meta',
        usage: { input: data?.usage?.input_tokens || 0, output: 0 },
        ms: Date.now() - _imgT0, purpose: 'image', images: 1,
    });
    return {
        dataUrl,
        mime: dataUrl.slice(5, dataUrl.indexOf(';')),
        text: outText,
        cutoutDataUrl: cutout && window.studioChromaKey
            ? await window.studioChromaKey(dataUrl).catch(() => '')
            : '',
    };
}

// ═══════════════════════════════════════════════════════════════
// 圖片生成（OpenRouter Images API：meta/muse-image、openai/gpt-image-2.5 系）
// ═══════════════════════════════════════════════════════════════
// 官方文件（OpenRouter Images 端點）：
//   POST https://openrouter.ai/api/v1/images
//   body {model, prompt} → result.data[] 每項 b64_json。
// gpt-image 系額外支援 aspect_ratio / quality（官方參數表）；muse 不吃這些，不送。
// quality 由 UI 的 size 反推（使用者指定的對照）：
//   512→low、1K→medium、2K→high、4K→max。
// 注意：這版 body 只有純文字 prompt —— 參考圖不送（文件沒給傳圖欄位，不猜），
// 尺寸不送（文件沒提 size 參數；要的尺寸請走「存入工作區後縮放」或改用直連版）。
// 去背綠幕後綴照加（跟另兩條分支同一份），cutout 照樣走 studioChromaKey。
const OR_GPT_QUALITY = { '512': 'low', '1K': 'medium', '2K': 'high', '4K': 'max' };
// 官方 aspect_ratio 枚舉；UI 選項若不在裡面就送 auto，不讓整個請求 400
const OR_GPT_ASPECTS = new Set(['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9', 'auto']);
async function generateImageOpenRouter({ model: mid, prompt, refs = [], aspect = '1:1', size = '2K', cutout = false, signal, _imgT0 = Date.now() } = {}) {
    const key = getProviderKey('openrouter');
    if (!key) {
        const e = new Error('圖片生成需要 OpenRouter API Key，請先到「API Key 設定」填入');
        e.code = 'NO_KEY'; e.provider = 'openrouter';
        throw e;
    }
    const pcfg = API_CONFIG.providers.openrouter || {};
    const finalPrompt = cutout && !/chroma green/i.test(prompt)
        ? prompt + '\nThe background MUST be one solid pure chroma green (#00FF00), completely flat, no gradient, no pattern, no shadow on the background. '
            + 'Do not use any green colour on the subject, clothing, hair or accessories — green must appear only in the background. '
            + 'Composition: single subject, centred, with clear empty margin on all four sides.'
        : prompt;
    const url = pcfg.imagesEndpoint || 'https://openrouter.ai/api/v1/images';
    const headers = {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + key,
        'HTTP-Referer': location.origin,
        'X-Title': 'Omni Code',
        ...(pcfg.extraHeaders || {}),
    };
    const body = { model: mid, prompt: finalPrompt };
    // gpt-image 系才吃 aspect_ratio / quality；muse 不吃就別送（多送未知欄位可能 400）
    if (/gpt-image/i.test(mid)) {
        const ar = String(aspect || 'auto');
        body.aspect_ratio = OR_GPT_ASPECTS.has(ar) ? ar : 'auto';
        body.quality = OR_GPT_QUALITY[size] || 'high';
    }
    if (pcfg.extraBody && typeof pcfg.extraBody === 'object') Object.assign(body, pcfg.extraBody);
    const transport = OC?.cfg?.transport || 'direct';
    const viaRelay = () => RELAY.json({ url, headers, body }, signal);
    let data;
    if (transport === 'relay') {
        data = await viaRelay();
    } else {
        try {
            const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
            if (!res.ok) throw await providerError(res, 'openrouter');
            data = await res.json();
        } catch (e) {
            if (e.name === 'AbortError') throw e;
            if (e instanceof TypeError) data = await viaRelay();
            else throw e;
        }
    }
    if (data?.error) throw new Error(`圖片生成失敗：${data.error.message || JSON.stringify(data.error)}`);
    const items = Array.isArray(data?.data) ? data.data : [];
    const first = items.find(i => typeof i?.b64_json === 'string' && i.b64_json.length > 100)
        || items.find(i => typeof i?.url === 'string' && /^https?:/.test(i.url));
    if (!first) {
        throw new Error(`模型未回傳圖片。原始回應前 500 字：${JSON.stringify(data).slice(0, 500)}`);
    }
    let dataUrl = '';
    if (first.b64_json) {
        dataUrl = `data:image/png;base64,${first.b64_json}`;
    } else {
        const dl = await fetch(first.url, { signal });
        if (!dl.ok) throw new Error(`圖片 URL 下載失敗：HTTP ${dl.status}`);
        const buf = new Uint8Array(await dl.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
        const mime = dl.headers.get('content-type')?.split(';')[0] || 'image/png';
        dataUrl = `data:${mime};base64,${btoa(bin)}`;
    }
    window.recordUsage?.({
        model: mid, provider: 'openrouter',
        usage: { input: 0, output: 0 },
        ms: Date.now() - _imgT0, purpose: 'image', images: 1,
    });
    return {
        dataUrl,
        mime: dataUrl.slice(5, dataUrl.indexOf(';')),
        text: '',
        cutoutDataUrl: cutout && window.studioChromaKey
            ? await window.studioChromaKey(dataUrl).catch(() => '')
            : '',
    };
}


// ═══════════════════════════════════════════════════════════════
// 圖片生成（OpenRouter chat/completions＋modalities：google/gemini-3.1-flash-image 系）
// ═══════════════════════════════════════════════════════════════
// 官方文件（使用者提供，OpenRouter chat/completions 端點）：
//   POST https://openrouter.ai/api/v1/chat/completions
//   body {model, messages:[{role:'user',content}], modalities:['image','text']}
//   → choices[0].message.images[] 每項 image.image_url.url（data URL）。
// 參考圖：沿用 OpenAI 多模態 content part（type:'image_url'）——
//   這是 OR 生態的通用寫法，但 Gemini 生圖支不支援 image_url 輸入未經實測，
//   有參考圖才帶，沒有就不帶，不影響純文字生圖。
// 尺寸：文件沒提 size 參數，不送（跟 muse 的 /v1/images 版同一策略）。
// 去背綠幕後綴＋studioChromaKey 跟其他分支同一套。
async function generateImageORChat({ model: mid, prompt, refs = [], aspect = '1:1', size = '2K', cutout = false, signal, _imgT0 = Date.now() } = {}) {
    const key = getProviderKey('openrouter');
    if (!key) {
        const e = new Error('圖片生成需要 OpenRouter API Key，請先到「API Key 設定」填入');
        e.code = 'NO_KEY'; e.provider = 'openrouter';
        throw e;
    }
    const pcfg = API_CONFIG.providers.openrouter || {};
    const finalPrompt = cutout && !/chroma green/i.test(prompt)
        ? prompt + '\nThe background MUST be one solid pure chroma green (#00FF00), completely flat, no gradient, no pattern, no shadow on the background. '
            + 'Do not use any green colour on the subject, clothing, hair or accessories — green must appear only in the background. '
            + 'Composition: single subject, centred, with clear empty margin on all four sides.'
        : prompt;
    // content 保持字串形狀（官方範例原樣）；有參考圖才升級成 parts 陣列
    let content = finalPrompt;
    if (refs.length) {
        content = [{ type: 'text', text: finalPrompt }];
        for (const r of refs.slice(0, 5)) {
            content.push({ type: 'image_url', image_url: { url: `data:${r.mime};base64,${r.data}` } });
        }
    }
    const url = pcfg.endpoint ? pcfg.endpoint(mid) : 'https://openrouter.ai/api/v1/chat/completions';
    const headers = {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + key,
        'HTTP-Referer': location.origin,
        'X-Title': 'Omni Code',
        ...(pcfg.extraHeaders || {}),
    };
    const body = {
        model: mid,
        messages: [{ role: 'user', content }],
        modalities: ['image', 'text'],
        stream: false,
    };
    if (pcfg.extraBody && typeof pcfg.extraBody === 'object') Object.assign(body, pcfg.extraBody);
    const transport = OC?.cfg?.transport || 'direct';
    const viaRelay = () => RELAY.json({ url, headers, body }, signal);
    let data;
    if (transport === 'relay') {
        data = await viaRelay();
    } else {
        try {
            const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
            if (!res.ok) throw await providerError(res, 'openrouter');
            data = await res.json();
        } catch (e) {
            if (e.name === 'AbortError') throw e;
            if (e instanceof TypeError) data = await viaRelay();
            else throw e;
        }
    }
    if (data?.error) throw new Error(`圖片生成失敗：${data.error.message || JSON.stringify(data.error)}`);
    const msg = data?.choices?.[0]?.message || {};
    const imgs = Array.isArray(msg.images) ? msg.images : [];
    // 盡力撈：message.images[].image_url.url 優先，其次全文遞迴找 data:URL
    let dataUrl = '';
    for (const im of imgs) {
        const u = im?.image_url?.url || im?.url;
        if (typeof u === 'string' && u.startsWith('data:image/')) { dataUrl = u; break; }
    }
    if (!dataUrl) {
        const seen = [];
        const visit = (node) => {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node)) { node.forEach(visit); return; }
            if (typeof node.url === 'string' && node.url.startsWith('data:image/')) { dataUrl = node.url; return; }
            if (typeof node.b64_json === 'string' && node.b64_json.length > 100) {
                dataUrl = `data:image/png;base64,${node.b64_json}`;
                return;
            }
            if (typeof node.url === 'string' && /^https?:/.test(node.url)) seen.push(node.url);
            Object.values(node).forEach(visit);
        };
        visit(msg);
        if (!dataUrl && seen.length) {
            const dl = await fetch(seen[0], { signal });
            if (!dl.ok) throw new Error(`圖片 URL 下載失敗：HTTP ${dl.status}`);
            const buf = new Uint8Array(await dl.arrayBuffer());
            let bin = '';
            for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
            const mime = dl.headers.get('content-type')?.split(';')[0] || 'image/png';
            dataUrl = `data:${mime};base64,${btoa(bin)}`;
        }
    }
    if (!dataUrl) {
        const txt = typeof msg.content === 'string' ? msg.content.slice(0, 200) : '';
        throw new Error(`模型未回傳圖片${txt ? `（附帶文字：${txt}）` : ''}。原始回應前 500 字：${JSON.stringify(data).slice(0, 500)}`);
    }
    window.recordUsage?.({
        model: mid, provider: 'openrouter',
        usage: { input: data?.usage?.prompt_tokens || 0, output: data?.usage?.completion_tokens || 0 },
        ms: Date.now() - _imgT0, purpose: 'image', images: 1,
    });
    return {
        dataUrl,
        mime: dataUrl.slice(5, dataUrl.indexOf(';')),
        text: typeof msg.content === 'string' ? msg.content : '',
        cutoutDataUrl: cutout && window.studioChromaKey
            ? await window.studioChromaKey(dataUrl).catch(() => '')
            : '',
    };
}


// ═══════════════════════════════════════════════════════════════
// Responses API 格式（Meta AI / OpenAI Responses 相容）
// ═══════════════════════════════════════════════════════════════
// 請求形狀完全依照官方 curl 範例：
//   POST https://api.meta.ai/v1/responses
//   { "model": "...", "input": [ {role, content:[{type:'input_text',text}]} ], "stream": false }
//
// ★ 已驗證 vs 未驗證，講清楚：
//   - 請求主體（input / input_text / stream）取自官方範例，可信。
//   - 工具呼叫與串流事件的欄位名稱，範例沒有涵蓋，這裡沿用
//     OpenAI Responses API 的慣例（function_call / call_id /
//     response.output_text.delta …）。未經實測。
//   - 因此 Meta 供應商預設 supportsStream:false，只走已驗證的非串流路徑；
//     串流要在「供應商」編輯器手動開啟，開了之後如果格式不符會如實報錯，
//     不會靜默吞掉內容。

// 通用工具 schema → Responses（扁平，不像 chat/completions 包一層 function）
function toolsForResponses(tools) {
    return tools.map(t => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: normalizeSchema(t.params, 'openai'),
    }));
}

// 訊息 → Responses 的 input 陣列。
// 注意：function_call / function_call_output 是 input 的「頂層項目」，
// 不是包在 message 裡面的 content block —— 這是 Responses 跟
// chat/completions 最容易搞混的差異。
function msgsForResponses(messages) {
    const out = [];
    for (const m of messages) {
        const blocks = m.content || [];

        if (m.role === 'assistant') {
            const texts = blocks.filter(b => b.type === 'text' && b.text);
            if (texts.length) {
                out.push({
                    role: 'assistant',
                    content: texts.map(b => ({ type: 'output_text', text: b.text })),
                });
            }
            for (const b of blocks.filter(x => x.type === 'tool_use')) {
                out.push({
                    type: 'function_call',
                    call_id: b.id,
                    name: b.name,
                    arguments: JSON.stringify(b.input || {}),
                });
            }
            continue;
        }

        // user：工具結果先拆成頂層項目
        for (const b of blocks.filter(x => x.type === 'tool_result')) {
            out.push({
                type: 'function_call_output',
                call_id: b.tool_use_id,
                output: (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)) || '(無輸出)',
            });
        }
        const rest = blocks.filter(b => b.type === 'text' || b.type === 'image');
        if (!rest.length) continue;
        out.push({
            role: 'user',
            content: rest.map(b => b.type === 'image'
                ? { type: 'input_image', image_url: `data:${b.mime};base64,${b.data}` }
                : { type: 'input_text', text: b.text || '' }),
        });
    }
    return out;
}

// 把 Responses 的 output 陣列轉成內部 content blocks
function responsesOutputToContent(output, cbs) {
    const content = [];
    let text = '';
    for (const item of (output || [])) {
        if (!item || typeof item !== 'object') continue;

        if (item.type === 'message' || item.role === 'assistant') {
            for (const c of (item.content || [])) {
                if (c?.type === 'output_text' && c.text) { text += c.text; cbs?.onText?.(c.text); }
                // 有些實作把推理內容放在 reasoning / summary_text
                else if (c?.type === 'reasoning' && c.text) { cbs?.onThinking?.(c.text); }
            }
        } else if (item.type === 'function_call') {
            const id = item.call_id || item.id || ('call_' + Math.random().toString(36).slice(2, 10));
            let input = {};
            try { input = item.arguments ? JSON.parse(item.arguments) : {}; }
            catch { input = { _parse_error: true, _raw: String(item.arguments).slice(0, 2000) }; }
            cbs?.onToolStart?.({ id, name: item.name });
            cbs?.onToolInput?.(id, item.arguments || '{}');
            content.push({ type: 'tool_use', id, name: item.name, input });
        } else if (item.type === 'reasoning') {
            const rt = (item.summary || []).map(s => s?.text || '').join('') || item.text || '';
            if (rt) cbs?.onThinking?.(rt);
        }
    }
    if (text) content.unshift({ type: 'text', text });
    return content;
}

function responsesUsage(u) {
    return {
        input: u?.input_tokens || u?.prompt_tokens || 0,
        output: u?.output_tokens || u?.completion_tokens || 0,
        cache_read: u?.input_tokens_details?.cached_tokens || 0,
        cache_write: 0,
    };
}

// 非串流（Meta 預設走這條，對應官方範例的 "stream": false）
function parseResponsesJson(data, cbs) {
    if (data?.error) {
        const m = data.error.message || data.error.type || JSON.stringify(data.error);
        throw new Error(`供應商回應錯誤：${m}`);
    }
    let content = responsesOutputToContent(data?.output, cbs);

    // 有些實作提供 output_text 便利欄位；output 解不出文字時用它兜底
    if (!content.some(b => b.type === 'text') && typeof data?.output_text === 'string' && data.output_text) {
        cbs?.onText?.(data.output_text);
        content.unshift({ type: 'text', text: data.output_text });
    }
    if (!content.length) {
        const status = data?.status ? `（status: ${data.status}）` : '';
        throw new Error(`模型沒有回傳任何內容${status}。原始回應前 300 字：${JSON.stringify(data).slice(0, 300)}`);
    }
    return {
        content,
        stopReason: data?.status === 'incomplete' ? 'max_tokens' : 'stop',
        usage: responsesUsage(data?.usage),
    };
}

// 串流（未經實測 —— 事件名稱依 OpenAI Responses 慣例）
async function parseResponsesStream(res, cbs, signal) {
    let text = '';
    const calls = new Map();          // item_id → {id, name, args}
    const usage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
    let stopReason = null;
    let sawAny = false;

    for await (const evt of sseEvents(res.body, signal)) {
        if (evt.data === '[DONE]') break;
        let d;
        try { d = JSON.parse(evt.data); } catch { continue; }
        const type = d.type || evt.event || '';

        if (d.error) {
            throw new Error(`串流錯誤：${d.error.message || d.error.type || JSON.stringify(d.error)}`);
        }

        if (type === 'response.output_text.delta' && typeof d.delta === 'string') {
            sawAny = true; text += d.delta; cbs.onText?.(d.delta);
        } else if (type === 'response.reasoning_summary_text.delta' && typeof d.delta === 'string') {
            sawAny = true; cbs.onThinking?.(d.delta);
        } else if (type === 'response.output_item.added' && d.item?.type === 'function_call') {
            sawAny = true;
            const key = d.item.id || d.item.call_id;
            const id = d.item.call_id || d.item.id;
            calls.set(key, { id, name: d.item.name, args: '' });
            cbs.onToolStart?.({ id, name: d.item.name });
        } else if (type === 'response.function_call_arguments.delta') {
            const c = calls.get(d.item_id);
            if (c) { c.args += d.delta || ''; cbs.onToolInput?.(c.id, d.delta || ''); }
        } else if (type === 'response.completed' || type === 'response.incomplete') {
            sawAny = true;
            const r = d.response || {};
            Object.assign(usage, responsesUsage(r.usage));
            stopReason = type === 'response.incomplete' ? 'max_tokens' : 'stop';
            // 收尾事件帶完整 output 時以它為準（補齊串流中漏接的部分）
            if (Array.isArray(r.output) && !text && !calls.size) {
                return { content: responsesOutputToContent(r.output, cbs), stopReason, usage };
            }
        }
    }

    if (!sawAny) {
        throw new Error('串流沒有回傳任何可辨識的事件。'
            + '這個供應商的串流格式可能與 Responses API 慣例不同——'
            + '請到「模型管理 → 供應商」把串流關閉，改用非串流模式。');
    }

    const content = [];
    if (text) content.push({ type: 'text', text });
    for (const c of calls.values()) {
        let input = {};
        try { input = c.args ? JSON.parse(c.args) : {}; }
        catch { input = { _parse_error: true, _raw: c.args.slice(0, 2000) }; }
        content.push({ type: 'tool_use', id: c.id, name: c.name, input });
    }
    return { content, stopReason: stopReason || 'stop', usage };
}

// ─── 非串流版的其他三家（供自訂供應商關閉串流時使用）───

function parseAnthropicJson(data, cbs) {
    if (data?.error) throw new Error(data.error.message || JSON.stringify(data.error));
    const content = [];
    for (const b of (data.content || [])) {
        if (b.type === 'text' && b.text) { cbs?.onText?.(b.text); content.push({ type: 'text', text: b.text }); }
        else if (b.type === 'thinking') { cbs?.onThinking?.(b.thinking || ''); content.push({ type: 'thinking', text: b.thinking || '', _sig: b.signature || '' }); }
        else if (b.type === 'redacted_thinking') content.push({ type: 'thinking', text: '', _redacted: b.data || '' });
        else if (b.type === 'tool_use') {
            cbs?.onToolStart?.({ id: b.id, name: b.name });
            content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input || {} });
        }
    }
    if (!content.length) throw new Error('模型沒有回傳任何內容');
    return {
        content,
        stopReason: data.stop_reason || 'stop',
        usage: {
            input: data.usage?.input_tokens || 0,
            output: data.usage?.output_tokens || 0,
            cache_read: data.usage?.cache_read_input_tokens || 0,
            cache_write: data.usage?.cache_creation_input_tokens || 0,
        },
    };
}

function parseOpenAIJson(data, cbs) {
    if (data?.error) throw new Error(data.error.message || JSON.stringify(data.error));
    const msg = data.choices?.[0]?.message || {};
    const content = [];
    const reasoning = msg.reasoning_content || msg.reasoning;
    if (reasoning) { cbs?.onThinking?.(reasoning); content.push({ type: 'thinking', text: reasoning }); }
    if (msg.content) { cbs?.onText?.(msg.content); content.push({ type: 'text', text: msg.content }); }
    for (const tc of (msg.tool_calls || [])) {
        const id = tc.id || ('call_' + Math.random().toString(36).slice(2, 10));
        let input = {};
        try { input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; }
        catch { input = { _parse_error: true, _raw: String(tc.function?.arguments).slice(0, 2000) }; }
        cbs?.onToolStart?.({ id, name: tc.function?.name });
        content.push({ type: 'tool_use', id, name: tc.function?.name, input });
    }
    if (!content.length) throw new Error('模型沒有回傳任何內容');
    return {
        content,
        stopReason: data.choices?.[0]?.finish_reason || 'stop',
        usage: {
            input: data.usage?.prompt_tokens || 0,
            output: data.usage?.completion_tokens || 0,
            cache_read: data.usage?.prompt_tokens_details?.cached_tokens || 0,
            cache_write: 0,
        },
    };
}

function parseGeminiJson(data, cbs) {
    if (data?.error) throw new Error(data.error.message || JSON.stringify(data.error));
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const content = [];
    let text = '';
    for (const p of parts) {
        const sig = p.thoughtSignature || p.thought_signature || null;
        if (p.functionCall) {
            const id = 'gcall_' + Math.random().toString(36).slice(2, 10);
            cbs?.onToolStart?.({ id, name: p.functionCall.name });
            const tu = { type: 'tool_use', id, name: p.functionCall.name, input: p.functionCall.args || {} };
            if (sig) tu._sig = sig;
            content.push(tu);
        } else if (typeof p.text === 'string' && p.text) {
            if (p.thought) cbs?.onThinking?.(p.text);
            else { text += p.text; cbs?.onText?.(p.text); }
        }
    }
    if (text) content.unshift({ type: 'text', text });
    if (!content.length) {
        const fr = data?.candidates?.[0]?.finishReason;
        throw new Error(`模型沒有回傳任何內容${fr ? `（${fr}）` : ''}`);
    }
    return {
        content,
        stopReason: data?.candidates?.[0]?.finishReason || 'stop',
        usage: {
            input: data?.usageMetadata?.promptTokenCount || 0,
            output: data?.usageMetadata?.candidatesTokenCount || 0,
            cache_read: data?.usageMetadata?.cachedContentTokenCount || 0,
            cache_write: 0,
        },
    };
}

Object.assign(window, {
    streamChat, callOnce, generateImage, pickFeatureModel,
    msgsForResponses, toolsForResponses, parseResponsesJson,
    toolsForAnthropic, toolsForOpenAI, toolsForGemini, normalizeSchema,
    msgsForAnthropic, msgsForOpenAI, msgsForGemini,
});
