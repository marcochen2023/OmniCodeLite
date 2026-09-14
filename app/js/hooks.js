'use strict';
// ═══════════════════════════════════════════════════════════════
// Omni Code — Hooks（事件自動化）
// ═══════════════════════════════════════════════════════════════
// 讓專案自己決定「Agent 做某件事的前後要跑什麼」，
// 不必every次都用提示詞拜託模型記得做。
//
// 設定檔：<工作區>/.omni/hooks.json
// {
//   "PreToolUse":  [{ "matcher": "write_file|edit_file", "command": "...", "timeout": 15000 }],
//   "PostToolUse": [{ "matcher": "write_file|edit_file", "command": "npx prettier -w \"$FILE\"" }],
//   "UserPromptSubmit": [{ "command": "git log --oneline -5" }],
//   "Stop":        [{ "command": "npm run lint --silent" }],
//   "SessionStart":[{ "command": "..." }]
// }
//
// 語意（刻意與 Claude Code 一致）：
//   PreToolUse       非零結束碼 = 阻擋這次工具執行，stderr 回饋給模型
//   PostToolUse      工具成功後執行；輸出附在工具結果後面給模型看
//   UserPromptSubmit stdout 當成額外上下文注入該輪對話
//   Stop             Agent 收尾時執行，輸出只顯示給使用者
//   SessionStart     載入／新建會話時執行一次
//
// 佔位符：$TOOL $FILE $ARGS（JSON）$WORKSPACE $PROMPT
// ═══════════════════════════════════════════════════════════════

const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart'];
const HOOKS_PATH = '.omni/hooks.json';
const HOOK_DEFAULT_TIMEOUT = 20000;
const HOOK_MAX_OUTPUT = 4000;

let _hooks = null;          // { event: [ {matcher, command, timeout} ] }
let _hooksAt = 0;
let _hooksError = '';

// ─── 載入 ───────────────────────────────────────────────────

async function loadHooks(force = false) {
    if (!force && _hooksAt && Date.now() - _hooksAt < 15000) return _hooks;
    _hooksAt = Date.now();
    _hooksError = '';
    try {
        const st = await FS.stat(HOOKS_PATH);
        if (!st.exists) { _hooks = null; return null; }
        const raw = (await FS.read(HOOKS_PATH)).content || '';
        const j = JSON.parse(raw);
        const out = {};
        for (const ev of HOOK_EVENTS) {
            const list = Array.isArray(j[ev]) ? j[ev] : [];
            out[ev] = list
                .filter(h => h && typeof h.command === 'string' && h.command.trim())
                .map(h => ({
                    matcher: typeof h.matcher === 'string' ? h.matcher : '',
                    command: h.command.trim(),
                    timeout: Math.min(120000, Math.max(1000, parseInt(h.timeout, 10) || HOOK_DEFAULT_TIMEOUT)),
                }));
        }
        _hooks = out;
    } catch (e) {
        // 設定壞掉要講清楚。靜默忽略的話，使用者會以為 hook 沒設定成功，
        // 但其實是 JSON 有語法錯誤。
        _hooks = null;
        _hooksError = e.message;
        window.OCLog?.(`.omni/hooks.json 讀取失敗：${e.message}`);
    }
    window.renderHooksSection?.();
    return _hooks;
}

function invalidateHooks() { _hooksAt = 0; }
function hooksError() { return _hooksError; }
function hooksSummary() {
    if (!_hooks) return null;
    const s = {};
    for (const ev of HOOK_EVENTS) if (_hooks[ev]?.length) s[ev] = _hooks[ev].length;
    return Object.keys(s).length ? s : null;
}

// ─── 佔位符替換 ─────────────────────────────────────────────
// 值一律用雙引號包起來再插入，避免路徑含空白時命令被拆開。

function fillPlaceholders(cmd, ctx) {
    const q = (v) => String(v ?? '').replace(/"/g, '\\"');
    return cmd
        .replace(/\$TOOL\b/g, q(ctx.tool))
        .replace(/\$FILE\b/g, q(ctx.file))
        .replace(/\$WORKSPACE\b/g, q(OC.ws))
        .replace(/\$PROMPT\b/g, q(ctx.prompt))
        .replace(/\$ARGS\b/g, q(JSON.stringify(ctx.args || {})));
}

// 這個 hook 適用於這次事件嗎
function matches(hook, ctx) {
    if (!hook.matcher) return true;               // 沒寫 matcher = 全部都跑
    try { return new RegExp(hook.matcher, 'i').test(ctx.tool || ''); }
    catch { return hook.matcher === ctx.tool; }   // 不是合法正則就當字面比對
}

// 從工具參數猜出「這次動到的檔案」，給 $FILE 用
function fileFromArgs(tool, args) {
    const a = args || {};
    return a.path || a.file_path || a.to || a.from || a.save_to || a.out || '';
}

// ─── 執行 ───────────────────────────────────────────────────

async function runHooks(event, ctx = {}) {
    const hooks = await loadHooks();
    const list = hooks?.[event] || [];
    if (!list.length) return { ran: 0, blocked: false, outputs: [] };

    const applicable = list.filter(h => matches(h, ctx));
    if (!applicable.length) return { ran: 0, blocked: false, outputs: [] };

    const outputs = [];
    let blocked = false;
    let blockReason = '';

    for (const h of applicable) {
        const cmd = fillPlaceholders(h.command, ctx);
        let r;
        try {
            r = await EXEC.run(cmd, '', h.timeout, ctx.signal);
        } catch (e) {
            // Hook 本身跑不起來，不該讓整個 Agent 停擺。
            // 但 PreToolUse 例外：它的用途就是把關，跑不起來時
            // 「放行」和「阻擋」都可能是錯的，所以據實回報並放行。
            outputs.push({ command: h.command, error: `無法執行：${e.message}` });
            window.chatSystemNote?.(`Hook 執行失敗（${event}）：${e.message}`, 'warn');
            continue;
        }

        const out = ((r.stdout || '') + (r.stderr || '')).trim().slice(0, HOOK_MAX_OUTPUT);
        outputs.push({ command: h.command, exit: r.exit_code, out });

        if (event === 'PreToolUse' && r.exit_code !== 0) {
            blocked = true;
            blockReason = out || `hook 以結束碼 ${r.exit_code} 阻擋`;
            break;                                 // 已經被擋了，後面的不用跑
        }
    }

    return { ran: applicable.length, blocked, blockReason, outputs };
}

// ─── 各事件的呼叫點包裝 ─────────────────────────────────────

// 工具執行前。回傳 {blocked, reason}
async function hookPreTool(tool, args, signal) {
    const r = await runHooks('PreToolUse', { tool, args, file: fileFromArgs(tool, args), signal });
    if (r.blocked) {
        window.chatSystemNote?.(`🛑 PreToolUse hook 阻擋了 ${tool}`, 'warn');
    }
    return { blocked: r.blocked, reason: r.blockReason || '' };
}

// 工具成功後。回傳要附在工具結果後面的文字（沒有就回空字串）
async function hookPostTool(tool, args, signal) {
    const r = await runHooks('PostToolUse', { tool, args, file: fileFromArgs(tool, args), signal });
    if (!r.ran) return '';
    const parts = r.outputs
        .filter(o => o.out || o.error)
        .map(o => `$ ${o.command}\n${o.error || o.out}`);
    if (!parts.length) return '';
    return `\n\n［PostToolUse hook］\n${parts.join('\n')}`;
}

// 使用者送出訊息時：stdout 當額外上下文
async function hookUserPrompt(prompt, signal) {
    const r = await runHooks('UserPromptSubmit', { prompt, signal });
    if (!r.ran) return '';
    const parts = r.outputs.filter(o => o.out).map(o => `$ ${o.command}\n${o.out}`);
    if (!parts.length) return '';
    return `［UserPromptSubmit hook 提供的額外上下文］\n${parts.join('\n\n')}`;
}

// Agent 收尾
async function hookStop(signal) {
    const r = await runHooks('Stop', { signal });
    if (!r.ran) return;
    for (const o of r.outputs) {
        if (o.error) { window.chatSystemNote?.(`Stop hook 失敗：${o.error}`, 'warn'); continue; }
        if (o.out) window.chatSystemNote?.(`［Stop hook］${o.command}\n${o.out}`, o.exit === 0 ? 'info' : 'warn');
    }
}

// 會話開始
async function hookSessionStart() {
    const r = await runHooks('SessionStart', {});
    if (!r.ran) return '';
    const parts = r.outputs.filter(o => o.out).map(o => o.out);
    return parts.join('\n\n');
}

// ─── 設定面板用 ─────────────────────────────────────────────

async function createHooksFile() {
    const sample = {
        _說明: [
            '事件：PreToolUse（非零結束碼=阻擋）／PostToolUse／UserPromptSubmit／Stop／SessionStart',
            'matcher 是比對工具名稱的正則，省略代表全部都跑',
            '佔位符：$TOOL $FILE $ARGS $WORKSPACE $PROMPT',
            '⚠ Windows cmd 陷阱：exit /b 寫在括號內只會設定 errorlevel，不會立刻結束，',
            '   後面的 || 反而會被觸發。要阻擋請用多行寫法，最後一行單獨 exit /b 1。',
        ],
        PreToolUse: [
            {
                _範例: '擋掉對機密檔的寫入',
                matcher: 'write_file|edit_file|multi_edit',
                command: 'echo $FILE | findstr /C:".secret" >nul || exit /b 0\necho 這是機密檔，不准改 1>&2\nexit /b 1',
            },
        ],
        PostToolUse: [
            {
                _範例: '改完自動格式化（把 echo 換成你的 formatter）',
                matcher: 'write_file|edit_file|multi_edit',
                command: 'echo 已修改 $FILE',
                timeout: 15000,
            },
        ],
        UserPromptSubmit: [],
        Stop: [],
        SessionStart: [],
    };
    await FS.write(HOOKS_PATH, JSON.stringify(sample, null, 2) + '\n');
    invalidateHooks();
    await loadHooks(true);
    window.openFile?.(HOOKS_PATH);
    toast(t('hook.created'), 'success');
}

Object.assign(window, {
    HOOK_EVENTS, HOOKS_PATH,
    loadHooks, invalidateHooks, hooksSummary, hooksError, createHooksFile,
    hookPreTool, hookPostTool, hookUserPrompt, hookStop, hookSessionStart,
});
