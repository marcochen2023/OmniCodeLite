'use strict';
// ═══════════════════════════════════════════════════════════════
// Omni Code — 工具參數驗證（JSON Schema 子集）
// ═══════════════════════════════════════════════════════════════
// 為什麼需要：較弱的模型（OpenRouter 長尾、被降級的呼叫）常送出
// 缺欄位或型別錯的參數。不驗的話，錯誤會在 PHP 深處以看不懂的形式
// 爆出來；驗了，模型下一步就拿到「哪個欄位、期望什麼型別」的
// 糾正訊息，自己修好重呼叫。
//
// 只實作工具 schema 實際用到的子集：type / properties / required /
// items / enum / additionalProperties。沒見過的關鍵字一律放行 ——
// 驗證器的職責是抓明顯的錯，不是完整實作規格。
// ═══════════════════════════════════════════════════════════════

function _typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;       // string / number / boolean / object / undefined
}

function _checkType(v, want) {
    const t = _typeOf(v);
    if (want === 'integer') return t === 'number' && Number.isInteger(v);
    if (want === 'number') return t === 'number';
    return t === want;
}

/** 驗證 value 是否符合 schema。回傳錯誤訊息陣列（空陣列 = 通過）。 */
function validateArgs(value, schema, path = '') {
    const errs = [];
    if (!schema || typeof schema !== 'object') return errs;
    const at = path || '(根)';

    if (schema.enum && !schema.enum.includes(value)) {
        errs.push(`${at}：必須是 ${schema.enum.map(x => JSON.stringify(x)).join(' / ')} 之一，收到 ${JSON.stringify(value)?.slice(0, 60)}`);
        return errs;
    }

    if (schema.type) {
        // schema.type 可能是陣列（例如 ['string','null']）
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        if (!types.some(t => _checkType(value, t))) {
            errs.push(`${at}：期望 ${types.join('|')}，收到 ${_typeOf(value)}`);
            return errs;   // 型別錯了，往下驗只會噴一堆連鎖錯誤
        }
    }

    if (schema.type === 'object' && value && typeof value === 'object') {
        for (const req of (schema.required || [])) {
            if (value[req] === undefined) errs.push(`${at ? at + '.' : ''}${req}：必填欄位缺失`);
        }
        for (const [k, v] of Object.entries(value)) {
            const sub = schema.properties?.[k];
            if (sub) errs.push(...validateArgs(v, sub, path ? `${path}.${k}` : k));
            // 未宣告的欄位不擋：模型多送一個無害欄位就整個拒絕太苛刻，
            // 供應商端（Gemini 嚴格模式）自己會處理
        }
    }

    if (schema.type === 'array' && Array.isArray(value) && schema.items) {
        value.forEach((v, i) => errs.push(...validateArgs(v, schema.items, `${path}[${i}]`)));
    }

    return errs;
}

Object.assign(window, { validateArgs });
