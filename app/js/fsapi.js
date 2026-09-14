'use strict';
// ═══════════════════════════════════════════════════════════════
// Omni Code — 後端 API 封裝
// ═══════════════════════════════════════════════════════════════
// 所有 PHP 端點以 direct-hit 方式呼叫（../api/xxx.php?action=...），
// 不依賴任何 rewrite，可在任意子目錄部署。
// 統一封套：{ok:true,...} / {ok:false,error}
// 失敗一律 throw new Error(封套.error)，讓工具層把錯誤原文回給模型。
// ═══════════════════════════════════════════════════════════════

const API_BASE = '../api/';

class ApiError extends Error {
    constructor(msg, code, detail) { super(msg); this.name = 'ApiError'; this.code = code; this.detail = detail; }
}

async function _req(file, action, { method = 'GET', body = null, query = null, signal = null, raw = false } = {}) {
    let url = API_BASE + file + '?action=' + encodeURIComponent(action);
    if (query) {
        for (const [k, v] of Object.entries(query)) {
            if (v === undefined || v === null) continue;
            url += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(v);
        }
    }
    const opt = { method, signal, headers: {} };
    if (body !== null && method !== 'GET') {
        opt.headers['Content-Type'] = 'application/json';
        opt.body = JSON.stringify(body);
    }
    let res;
    try {
        res = await fetch(url, opt);
    } catch (e) {
        if (e.name === 'AbortError') throw e;
        throw new ApiError(`無法連線到後端 ${file}（請確認 Apache 正在執行）：${e.message}`, 0);
    }
    if (raw) return res;
    let data;
    const text = await res.text();
    try { data = JSON.parse(text); }
    catch {
        throw new ApiError(
            `後端 ${file} 回應非 JSON（HTTP ${res.status}）`,
            res.status,
            text.slice(0, 800)
        );
    }
    if (!data.ok) throw new ApiError(data.error || `後端錯誤 HTTP ${res.status}`, res.status, data.detail);
    return data;
}

const _get  = (f, a, query, signal) => _req(f, a, { method: 'GET', query, signal });
const _post = (f, a, body, signal) => _req(f, a, { method: 'POST', body, signal });

// ═══════════════════════════════════════════════════════════════
// FS — 檔案系統
// ═══════════════════════════════════════════════════════════════
const FS = {
    list:   (path = '', showHidden = false, signal) => _get('fs.php', 'list', { path, show_hidden: showHidden ? 1 : 0 }, signal),
    tree:   (path = '', depth = 2, limit = 2000, signal) => _get('fs.php', 'tree', { path, depth, limit }, signal),
    read:   (path, offset = 0, limit = 0, signal) => _get('fs.php', 'read', { path, offset, limit }, signal),

    // ★ 讀取「完整」檔案內容。
    // 後端單次回傳有 5000 行上限（OC_FS_MAX_LINES），limit=0 也一樣會被截斷並標記
    // truncated。任何「要拿去寫回磁碟」的緩衝區都必須用這個，不能用 FS.read()——
    // 否則對超過 5000 行的檔案按存檔，尾端的內容會被永久刪掉。
    // 回傳與 FS.read 相同的形狀，額外附上 complete（是否確實讀完整份）。
    async readAll(path, { maxLines = 200000, signal } = {}) {
        const first = await _get('fs.php', 'read', { path, offset: 0, limit: 0 }, signal);
        if (!first.truncated) return { ...first, complete: true };

        const parts = [first.content];
        let got = first.lines || 0;
        const total = first.total_lines || 0;
        let guard = 0;
        while (got < total && got < maxLines && guard++ < 500) {
            const next = await _get('fs.php', 'read', { path, offset: got + 1, limit: 0 }, signal);
            if (!next.lines) break;
            parts.push(next.content);
            got += next.lines;
            if (!next.truncated) break;
        }
        const eol = first.eol || '\n';
        return {
            ...first,
            content: parts.join(eol),
            lines: got,
            truncated: got < total,
            complete: got >= total,
        };
    },
    readB64:(path, max = 0, signal) => _get('fs.php', 'read_b64', { path, max }, signal),
    write:  (path, content, createDirs = true, signal) => _post('fs.php', 'write', { path, content, create_dirs: createDirs }, signal),
    writeB64:(path, data, createDirs = true, signal) => _post('fs.php', 'write_b64', { path, data, create_dirs: createDirs }, signal),
    edit:   (path, oldStr, newStr, replaceAll = false, signal) => _post('fs.php', 'edit', { path, old_string: oldStr, new_string: newStr, replace_all: replaceAll }, signal),
    multiEdit: (path, edits, signal) => _post('fs.php', 'multi_edit', { path, edits }, signal),
    mkdir:  (path, signal) => _post('fs.php', 'mkdir', { path }, signal),
    remove: (path, recursive = false, signal) => _post('fs.php', 'delete', { path, recursive }, signal),
    move:   (from, to, overwrite = false, signal) => _post('fs.php', 'move', { from, to, overwrite }, signal),
    copy:   (from, to, overwrite = false, signal) => _post('fs.php', 'copy', { from, to, overwrite }, signal),
    glob:   (pattern, path = '', limit = 500, signal) => _get('fs.php', 'glob', { pattern, path, limit }, signal),
    grep:   (opts, signal) => _post('fs.php', 'grep', opts, signal),
    stat:   (path, signal) => _get('fs.php', 'stat', { path }, signal),
    downloadUrl: (path) => API_BASE + 'fs.php?action=download&path=' + encodeURIComponent(path),
    rawUrl: (path) => API_BASE + 'fs.php?action=raw&path=' + encodeURIComponent(path) + '&t=' + Date.now(),
    async upload(files, destDir = '') {
        const fd = new FormData();
        fd.append('path', destDir);
        for (const f of files) fd.append('file[]', f, f.name);
        const res = await fetch(API_BASE + 'fs.php?action=upload', { method: 'POST', body: fd });
        const data = await res.json();
        if (!data.ok) throw new ApiError(data.error || '上傳失敗', res.status);
        return data;
    },
};

// ═══════════════════════════════════════════════════════════════
// CG — 結構化程式碼圖譜（Graft Tier-1 移植，見 api/codegraph.php）
// ═══════════════════════════════════════════════════════════════
// 每次查詢後端都會自動同步索引（只重解析變動檔），前端不必管快取。
const CG = {
    map:     (path = '', noRefresh = false, signal) => _get('codegraph.php', 'map', { path, no_refresh: noRefresh ? 1 : 0 }, signal),
    fileApi: (path, signal) => _get('codegraph.php', 'file_api', { path }, signal),
    trace:   (symbol, direction = 'in', depth = 2, signal) => _get('codegraph.php', 'trace', { symbol, direction, depth }, signal),
    search:  (opts, signal) => _get('codegraph.php', 'search', opts, signal),
    build:   (signal) => _get('codegraph.php', 'build', {}, signal),
    architecture: (noRefresh = false, signal) => _get('codegraph.php', 'architecture', { no_refresh: noRefresh ? 1 : 0 }, signal),
    detectChanges: (opts = {}, signal) => _get('codegraph.php', 'detect_changes', { no_refresh: 1, ...opts }, signal),
};

const ADR = {
    list:    (signal) => _get('adr.php', 'list', {}, signal),
    get:     (id, signal) => _get('adr.php', 'get', { id }, signal),
    suggest: (signal) => _get('adr.php', 'suggest', {}, signal),
    save:    (body, signal) => _post('adr.php', 'save', body, signal),
};

// ═══════════════════════════════════════════════════════════════
// EXEC — 命令執行
// ═══════════════════════════════════════════════════════════════
const EXEC = {
    run:    (command, cwd = '', timeout = 120000, signal) => _post('exec.php', 'run', { command, cwd, timeout }, signal),
    start:  (command, cwd = '', signal) => _post('exec.php', 'start', { command, cwd }, signal),
    output: (shellId, since = 0, signal) => _get('exec.php', 'output', { shell_id: shellId, since }, signal),
    kill:   (shellId, signal) => _post('exec.php', 'kill', { shell_id: shellId }, signal),
    list:   (signal) => _get('exec.php', 'list', {}, signal),
};

// ═══════════════════════════════════════════════════════════════
// RELAY — AI 中繼 / 網路
// ═══════════════════════════════════════════════════════════════
const SELF = {
    get:        (limit = 100, signal) => _get('selfimprove.php', 'get', { limit }, signal),
    log:        (entry, signal) => _post('selfimprove.php', 'log', entry, signal),
    roadmap:    (payload, signal) => _post('selfimprove.php', 'roadmap', payload, signal),
    setVersion: (version, signal) => _post('selfimprove.php', 'set_version', { version }, signal),
};

const UTOOLS = {
    list:       (signal) => _get('usertools.php', 'list', {}, signal),
    save:       (tool, signal) => _post('usertools.php', 'save', { tool }, signal),
    remove:     (name, signal) => _post('usertools.php', 'remove', { name }, signal),
    run:        (name, args, signal) => _post('usertools.php', 'run', { name, args }, signal),
    test:       (tool, args, signal) => _post('usertools.php', 'test', { tool, args }, signal),
    secretSet:  (key, value, signal) => _post('usertools.php', 'secret_set', { key, value }, signal),
    secretList: (signal) => _get('usertools.php', 'secret_list', {}, signal),
};

const VIDEO = {
    // 影片分析可能要好幾分鐘（上傳 + Google 轉檔 + 生成），不能用一般逾時
    analyze: (body, signal) => _post('video.php', 'analyze', body, signal),
};

// ═══════════════════════════════════════════════════════════════
// VAULT — 憑證保險庫（可用不可讀：只回 key 名單，絕不回值）
// ═══════════════════════════════════════════════════════════════
const VAULT = {
    list: (signal) => _get('vault.php', 'list', {}, signal),
    set:  (key, value, signal) => _post('vault.php', 'set', { key, value }, signal),
    has:  (key, signal) => _get('vault.php', 'has', { key }, signal),
};

const RELAY = {
    // 回傳原始 Response（供 SSE 串流讀取）
    async chatStream({ url, headers, body }, signal) {
        return fetch(API_BASE + 'relay.php?action=chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, headers, body, stream: true }),
            signal,
        });
    },
    async json({ url, headers, body }, signal) {
        const res = await fetch(API_BASE + 'relay.php?action=json', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, headers, body, stream: false }),
            signal,
        });
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); }
        catch { throw new ApiError('中繼回應非 JSON', res.status, text.slice(0, 500)); }
        if (data && data.ok === false && data.error) throw new ApiError(data.error, res.status, data.detail);
        return data;
    },
    fetchUrl: (url, maxChars = 100000, format = 'text', signal) => _post('relay.php', 'fetch', { url, max_chars: maxChars, format }, signal),
    search:   (query, limit = 5, signal) => _post('relay.php', 'search', { query, limit }, signal),
};

// ═══════════════════════════════════════════════════════════════
// SESS — 會話與記憶
// ═══════════════════════════════════════════════════════════════
const SESS = {
    list:   (limit = 60, signal) => _get('sessions.php', 'list', { limit }, signal),
    get:    (id, signal) => _get('sessions.php', 'get', { id }, signal),
    save:   (id, session, signal) => _post('sessions.php', 'save', { id, session }, signal),
    remove: (id, signal) => _post('sessions.php', 'delete', { id }, signal),
    rename: (id, title, signal) => _post('sessions.php', 'rename', { id, title }, signal),
    pin:    (id, pinned, signal) => _post('sessions.php', 'pin', { id, pinned }, signal),
    export: (id, format = 'md', signal) => _post('sessions.php', 'export', { id, format }, signal),
    search: (q, ws = '', limit = 30, signal) => _get('sessions.php', 'search', { q, ws, limit }, signal),
    agents:   (signal) => _get('sessions.php', 'agents', {}, signal),
    agentGet: (name, signal) => _get('sessions.php', 'agent_get', { name }, signal),
    commands: (signal) => _get('sessions.php', 'commands', {}, signal),

    errmemSearch: (query, tool = '', limit = 4, signal) => _get('sessions.php', 'errmem_search', { query, tool, limit }, signal),
    errmemWrite:  (rec, signal) => _post('sessions.php', 'errmem_write', rec, signal),
    memoryList:   (scope = 'all', signal) => _get('sessions.php', 'memory_list', { scope }, signal),
    memoryGet:    (name, scope = 'project', signal) => _get('sessions.php', 'memory_get', { name, scope }, signal),
    memorySave:   (name, content, scope = 'project', signal) => _post('sessions.php', 'memory_save', { name, content, scope }, signal),
    memoryDelete: (name, scope = 'project', signal) => _post('sessions.php', 'memory_delete', { name, scope }, signal),
    omniMd:       (signal) => _get('sessions.php', 'omni_md', {}, signal),
    skills:       (signal) => _get('sessions.php', 'skills', {}, signal),
    skillGet:     (name, signal) => _get('sessions.php', 'skill_get', { name }, signal),
};

// ═══════════════════════════════════════════════════════════════
// MCPAPI — MCP 代理
// ═══════════════════════════════════════════════════════════════
const MCPAPI = {
    servers: (signal) => _get('mcp.php', 'servers', {}, signal),
    tools:   (server = '', refresh = false, signal) => _get('mcp.php', 'tools', { server, refresh: refresh ? 1 : 0 }, signal),
    call:    (server, name, args, signal) => _post('mcp.php', 'call', { server, name, arguments: args }, signal),
    save:    (servers, signal) => _post('mcp.php', 'save', { servers }, signal),
    test:    (name, signal) => _post('mcp.php', 'test', { name }, signal),
};

// ═══════════════════════════════════════════════════════════════
// SETTINGS — 設定與工作區
// ═══════════════════════════════════════════════════════════════
// ─── 檢查點（回溯）───
// 每個使用者回合一個檢查點，寫入前捕捉原始內容，/rewind 可整批還原。
const CHECKPOINT = {
    begin:   (session, label, signal) => _post('checkpoint.php', 'begin', { session, label }, signal),
    capture: (session, id, paths, signal) => _post('checkpoint.php', 'capture', { session, id, paths }, signal),
    note:    (session, id, command, signal) => _post('checkpoint.php', 'note', { session, id, command }, signal),
    list:    (session, signal) => _get('checkpoint.php', 'list', { session }, signal),
    get:     (session, id, signal) => _get('checkpoint.php', 'get', { session, id }, signal),
    restore: (session, id, signal) => _post('checkpoint.php', 'restore', { session, id }, signal),
    remove:  (session, id, signal) => _post('checkpoint.php', 'delete', { session, id }, signal),
};

// ─── 用量與成本 ───
const USAGE = {
    query:  (period = '7d', signal) => _get('usage.php', 'query', { period }, signal),
    list:   (period = '7d', limit = 100, offset = 0, model = '', signal) =>
                _get('usage.php', 'list', { period, limit, offset, model }, signal),
    recalc: (rates, onlyMissing = false, signal) =>
                _post('usage.php', 'recalc', { rates, only_missing: onlyMissing }, signal),
    clear:  (before = 0, signal) => _post('usage.php', 'clear', { before }, signal),
    months: (signal) => _get('usage.php', 'months', {}, signal),
};

const SETTINGS = {
    get:          (signal) => _get('settings.php', 'get', {}, signal),
    set:          (config, signal) => _post('settings.php', 'set', { config }, signal),
    browse:       (path = '', signal) => _get('settings.php', 'browse', { path }, signal),
    setWorkspace: (path, signal) => _post('settings.php', 'set_workspace', { path }, signal),
    extraAdd:    (alias, path, signal) => _post('settings.php', 'extra_add', { alias, path }, signal),
    extraRemove: (alias, signal) => _post('settings.php', 'extra_remove', { alias }, signal),
    extraSync:   (roots, signal) => _post('settings.php', 'extra_sync', { roots }, signal),
    keysSet:      (provider, key, signal) => _post('settings.php', 'keys_set', { provider, key }, signal),
    keysStatus:   (signal) => _get('settings.php', 'keys_status', {}, signal),
    // 模型管理設定獨立存在 data/models.json
    modelsGet:    (signal) => _get('settings.php', 'models_get', {}, signal),
    modelsSave:   (models, signal) => _post('settings.php', 'models_save', { models }, signal),
    auditList:    (limit = 50, sess = '', signal) => _get('settings.php', 'audit_list', { limit, sess }, signal),
};

// ═══════════════════════════════════════════════════════════════
// SSE 行解析器（供 api.js 串流使用）
// 用法：for await (const evt of sseLines(response.body)) { ... }
// 每個 evt = {event, data}
// ═══════════════════════════════════════════════════════════════
async function* sseEvents(stream, signal) {
    const reader = stream.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    try {
        while (true) {
            if (signal?.aborted) break;
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx;
            // SSE 事件以空行分隔（\n\n 或 \r\n\r\n）
            while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
                const rawEvent = buf.slice(0, idx);
                buf = buf.slice(idx + (buf[idx] === '\r' ? 4 : 2));
                let event = 'message';
                const dataLines = [];
                for (const line of rawEvent.split(/\r?\n/)) {
                    if (line.startsWith('event:')) event = line.slice(6).trim();
                    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
                    else if (line.startsWith(':')) { /* comment / keep-alive */ }
                }
                if (dataLines.length) yield { event, data: dataLines.join('\n') };
            }
        }
        // 收尾：最後可能沒有結尾空行
        if (buf.trim()) {
            const dataLines = [];
            let event = 'message';
            for (const line of buf.split(/\r?\n/)) {
                if (line.startsWith('event:')) event = line.slice(6).trim();
                else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
            }
            if (dataLines.length) yield { event, data: dataLines.join('\n') };
        }
    } finally {
        try { reader.releaseLock(); } catch {}
    }
}

Object.assign(window, { API_BASE, ApiError, FS, CG, EXEC, RELAY, SESS, MCPAPI, SETTINGS, CHECKPOINT, USAGE, VAULT, sseEvents });
