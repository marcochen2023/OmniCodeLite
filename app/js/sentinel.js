'use strict';
// ═══════════════════════════════════════════════════════════════
// Omni Code — Sentinel 獨立監控層（借鏡 Meta Muse 的 Sentinel）
// ═══════════════════════════════════════════════════════════════
// 位置：在 checkPermission（使用者授權）之後、實際執行之前。
// 性質：單向收緊 —— 只能把 allow 翻成 ask/deny，絕不能把 deny 翻成 allow。
// allowRules / sessionAllow 對它無效：這是「第二隻眼」，不是第三個授權框。
//
// 為什麼不用背景 daemon：本機 PHP 沒有常駐行程，監控必須是同步閘門 ——
// 每次工具執行前呼叫 Sentinel.check()，幾微秒內回 verdict。
// 契約見 docs/ARCHITECTURE.md §13.5
// ═══════════════════════════════════════════════════════════════

// ─── 動作範圍判定 ───────────────────────────────────────────────
// Muse 按 App 授權的核心是「讀 vs 做」分離。Omni 的工具本來就按動作分了
// 一半（read_file vs write_file），缺口在「同一個工具內的不同動作」：
// usertools 的 GET vs POST、MCP 工具的讀 vs 寫、bash 的查看 vs 刪除。
// scopeOf 補上這一層：回傳 'read' | 'act' | null（null = 不適用，用 danger 原邏輯）。
function sentinelScopeOf(name, input) {
    input = input || {};
    // 檔案工具：名字即範圍
    if (/^(read_file|read_files|read_images|glob|grep|list_dir|project_tree|file_api|repo_map|find_refs|trace_calls|get_architecture|detect_changes)$/.test(name)) return 'read';
    if (/^(write_file|edit_file|multi_edit|delete_path|move_path|copy_path|make_dir)$/.test(name)) return 'act';
    // 網路唯讀
    if (name === 'web_fetch' || name === 'web_search' || name === 'analyze_video') return 'read';
    // bash 靜態判定不可靠（`echo hi` 跟 `rm -rf /` 長得一樣）—— 保守一律 act。
    // 放寬它等於給整個監控開天窗。
    if (name === 'bash' || name === 'git') return 'act';
    // 自撰 API 工具：看原始 HTTP 方法。方法存在 USER_TOOLS 的 _method 上
    // （前端呼叫時只送業務參數、不送 method，執行期要回查定義）。
    // getTool 找得到 _user 旗標就用它；找不到（快取未載入）保守當 act。
    if (name === 'edit_tool' || name === 'test_tool') {
        const m = String(input.method || input.tool?.request?.method || 'GET').toUpperCase();
        return m === 'GET' || m === 'HEAD' ? 'read' : 'act';
    }
    try {
        const t = window.getTool ? window.getTool(name) : null;
        if (t && t._user) {
            const m = String(t._method || 'GET').toUpperCase();
            return m === 'GET' || m === 'HEAD' ? 'read' : 'act';
        }
    } catch { /* 查不到定義就往下走保守路徑 */ }
    // MCP 工具：從工具名猜意圖，猜不出的一律 act（保守）
    if (name.startsWith('mcp__')) {
        const tail = name.split('__').pop().toLowerCase();
        if (/^(get|list|read|search|query|fetch|describe|show|stat|status|check|ping|health|info)_?/.test(tail)) return 'read';
        if (/(read|search|query|list|get)/.test(tail) && !/(write|post|send|delete|set|update|create|put|remove|publish|execute|run)/.test(tail)) return 'read';
        return 'act';
    }
    return null;
}

// ─── 關鍵操作識別 ───────────────────────────────────────────────
// 這些操作無論什麼模式都要強制問人（Muse「寄信／購買前確認」）。
// full 模式也不豁免 —— 全自動是「不用每步問」，不是「刪庫不用問」。
function sentinelCritical(name, input) {
    input = input || {};
    // 遞迴刪除
    if (name === 'delete_path' && (input.recursive || String(input.path || '').endsWith('/'))) {
        return '遞迴刪除不可復原';
    }
    // bash 高危動詞：靜態掃描命令頭，命中即關鍵
    if (name === 'bash' || name === 'git') {
        const cmd = String(input.command || input.args || '');
        if (/(^|[;&|]\s*)(rm\s+(-[a-z]*r|-[a-z]*f|--recursive)|mkfs|dd\s+[^|]*of=|:\(\)\s*\{|shutdown|reboot|format\s+[a-z]:)/i.test(cmd)) {
            return '高危系統命令';
        }
        // 對外 POST：curl / Invoke-WebRequest 帶寫動詞
        if (/curl[^\n]*(-X\s*(POST|PUT|DELETE|PATCH)|--data|--upload-file)/i.test(cmd)
            || /Invoke-(WebRequest|RestMethod)[^\n]*-Method\s*(Post|Put|Delete|Patch)/i.test(cmd)) {
            return '命令列對外寫入';
        }
    }
    // 自撰工具的寫動詞：方法回查 USER_TOOLS 定義（input 裡沒有 method）
    try {
        const t = window.getTool ? window.getTool(name) : null;
        if (t && t._user) {
            const m = String(t._method || 'GET').toUpperCase();
            if (m !== 'GET' && m !== 'HEAD') return `對外 ${m} 請求`;
            return null;
        }
    } catch { /* 查不到定義就當沒這條，後面的範圍閘會保守處理 */ }
    // 權限與憑證變更：改了就回不來，必須留痕
    if (name === 'edit_tool' || name === 'vault_set' || name === 'remember') return null; // 這些走 ask 已足夠，不升級
    return null;
}

// ─── 主判定 ─────────────────────────────────────────────────────
// 回傳 {verdict:'allow'|'ask'|'deny', reason}
// verdict 缺席（模組壞掉）時呼叫端必須當 allow —— 監控壞掉不能擋住所有工作，
// 但要大聲說（呼叫端負責 toast + audit）。
function sentinelCheck(name, input) {
    try {
        const cfg = (window.OC && OC.cfg) || {};
        if (cfg.sentinel === false) return { verdict: 'allow', reason: 'Sentinel 已關閉' };
        input = input || {};

        // 1. 敏感資源：比 checkPermission 更嚴 —— bash 也不豁免。
        //    Muse 內測就是栽在「讀私人照片」：讀敏感內容進上下文，跟寫入它一樣危險。
        const subj = (window.ruleSubject ? ruleSubject(name, input) : '') || '';
        const sens = window.sensitiveReason ? sensitiveReason(subj) : '';
        if (sens) {
            // 純讀敏感檔 → 問；寫／刪敏感檔 → 擋
            const scope = sentinelScopeOf(name, input);
            if (scope === 'act' || name === 'bash' || name === 'git') {
                return { verdict: 'deny', reason: `Sentinel：拒絕觸碰敏感資源（${sens}）。請換一條路，不要重試。` };
            }
            return { verdict: 'ask', reason: `Sentinel：讀取敏感資源（${sens}），內容會進對話上下文。` };
        }

        // 2. 關鍵操作：強制問（full 模式也不豁免）
        const crit = sentinelCritical(name, input);
        if (crit) return { verdict: 'ask', reason: `Sentinel：${crit}，執行前必須確認。`, critical: true };

        // 3. 對外網路：在 default 模式下每會話問一次（Muse「連網需核可」）。
        //    acceptEdits/full 下已由模式授權，不重複打擾。
        const scope = sentinelScopeOf(name, input);
        if (scope === 'read' && (name === 'web_fetch' || name === 'web_search' || name.startsWith('mcp__'))) {
            const mode = OC.cfg.permissionMode || 'default';
            if (mode === 'default' && cfg.sentinelNetAsk !== false && !OC._sentinelNetOk) {
                return { verdict: 'ask', reason: 'Sentinel：對外連線需要授權（本會話問一次）。', netGate: true };
            }
        }

        // 4. 範圍化權限：act 在 default 模式問（Muse「按 App 授權」）。
        //    scopeRules 例外表：{tool名: 'allow'|'ask'|'deny'} 只針對 act 生效。
        if (scope === 'act') {
            const exc = (cfg.scopeRules || {})[name];
            if (exc === 'deny') return { verdict: 'deny', reason: `Sentinel：${name} 的執行動作已被範圍規則停用。` };
            if (exc === 'allow') return { verdict: 'allow', reason: 'Sentinel：範圍規則放行' };
            const mode = (OC.cfg && OC.cfg.permissionMode) || 'default';
            // acceptEdits 下檔案寫入已由模式放行，不重複問；命令／網路類仍問
            const fileAct = /^(write_file|edit_file|multi_edit|delete_path|move_path|copy_path|make_dir)$/.test(name);
            if (mode === 'default' || !fileAct) {
                if (mode !== 'full' && mode !== 'plan') {
                    return { verdict: 'ask', reason: `Sentinel：${name} 會改變外部狀態（act），需要確認。`, scopeGate: true };
                }
            }
        }

        return { verdict: 'allow', reason: '' };
    } catch (e) {
        return { verdict: 'allow', reason: '', broken: e.message };
    }
}

Object.assign(window, { sentinelScopeOf, sentinelCheck });
