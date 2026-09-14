'use strict';
// ═══════════════════════════════════════════════════════════════
// Omni Code — MCP（Model Context Protocol）整合與面板
// ═══════════════════════════════════════════════════════════════
// 契約見 docs/ARCHITECTURE.md §7。
//   設定存於 data/config.json 的 mcpServers，經 api/mcp.php 代理呼叫。
//   工具對外名稱一律 mcp__<server>__<tool>，由 tools.js 的 execTool 直送 callMcpTool。
//   任何 MCP 錯誤都只呈現給使用者／回給模型，絕不往外拋以免打斷 Agent 迴圈。
// ═══════════════════════════════════════════════════════════════

const MCP_TOOLS_TTL = 60000;    // 工具清單前端快取

const MCPS = {
    status: {},        // name -> {type,enabled,status,tool_count,error,checked,target}
    errors: {},        // name -> 最近一次 tools/list 的錯誤訊息
    loadedAt: 0,
    loading: false,
    formOpen: false,
    editing: null,     // 正在編輯的伺服器名稱（null = 新增）
    expanded: {},      // name -> bool（工具清單是否展開）
    notified: {},      // 同一個錯誤只 toast 一次
};

// ─── 範本（一鍵帶入表單）───────────────────────────────────────
const MCP_PRESETS = [
    {
        id: 'filesystem',
        label: '檔案系統',
        icon: 'folder_open',
        hint: '讓模型透過官方 MCP 伺服器存取指定資料夾',
        fill: () => ({
            name: 'filesystem', type: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', OC.ws || 'D:/xampp/htdocs'],
            env: '', url: '', headers: '',
        }),
    },
    {
        id: 'http',
        label: 'HTTP 端點',
        icon: 'public',
        hint: '連到任何相容 MCP 的 HTTP／SSE 伺服器',
        fill: () => ({
            name: 'my-server', type: 'http',
            url: 'http://localhost:3001/mcp',
            headers: 'Authorization=Bearer YOUR_TOKEN',
            command: '', args: [], env: '',
        }),
    },
    {
        id: 'playwright',
        label: 'Playwright 瀏覽器',
        icon: 'travel_explore',
        hint: '讓模型開真的瀏覽器點頁面、截圖、抓 DOM',
        fill: () => ({
            name: 'playwright', type: 'stdio',
            command: 'npx',
            args: ['-y', '@playwright/mcp@latest'],
            env: '', url: '', headers: '',
        }),
    },
];

// 範本標籤跟著介面語系走（跟 memTypeLabel 同一招：常數本體留中文保底）
function mcpPresetMeta(id) {
    const base = MCP_PRESETS.find(x => x.id === id);
    if (!base || typeof t !== 'function') return base;
    if (id === 'filesystem') return { ...base, label: t('mcp.presetFs'), hint: t('mcp.presetFsH') };
    if (id === 'http') return { ...base, label: t('mcp.presetHttp'), hint: t('mcp.presetHttpH') };
    return { ...base, label: t('mcp.presetPw'), hint: t('mcp.presetPwH') };
}

// ═══════════════════════════════════════════════════════════════
// 設定讀寫
// ═══════════════════════════════════════════════════════════════

function mcpConfig() {
    const m = OC.cfg.mcpServers;
    if (!m || typeof m !== 'object' || Array.isArray(m)) return {};
    return m;
}

async function saveMcpConfig(next) {
    const r = await MCPAPI.save(next);
    const saved = r.servers;
    OC.cfg.mcpServers = (saved && typeof saved === 'object' && !Array.isArray(saved)) ? saved : next;
    return r;
}

// 從後端重新取得設定與各伺服器狀態（不連線，只讀快取狀態）
async function refreshMcpServers() {
    try {
        const r = await SETTINGS.get();
        if (r.config && typeof r.config === 'object') {
            const m = r.config.mcpServers;
            OC.cfg.mcpServers = (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
        }
    } catch { /* 設定讀不到就沿用記憶體裡的 */ }
    try {
        const r = await MCPAPI.servers();
        MCPS.status = (r.servers && typeof r.servers === 'object' && !Array.isArray(r.servers)) ? r.servers : {};
    } catch { MCPS.status = {}; }
    return MCPS.status;
}

// ═══════════════════════════════════════════════════════════════
// 工具載入與呼叫
// ═══════════════════════════════════════════════════════════════

// 載入所有啟用中伺服器的工具 → OC.mcpTools
// 永不拋錯：錯誤以 toast + 面板徽章呈現
async function loadMcpTools(force = false) {
    if (MCPS.loading) return OC.mcpTools;
    if (!force && MCPS.loadedAt && Date.now() - MCPS.loadedAt < MCP_TOOLS_TTL) return OC.mcpTools;

    // 強制重載時先把伺服器設定重新抓一次：設定可能是在別的分頁、
    // 或直接編輯 data/config.json 改的，只看本地快取會誤判成「沒有伺服器」。
    if (force) {
        try {
            const s = await SETTINGS.get();
            if (s.config?.mcpServers) OC.cfg.mcpServers = s.config.mcpServers;
        } catch { /* 抓不到就沿用本地設定 */ }
    }

    const names = Object.keys(mcpConfig());
    if (!names.length) { OC.mcpTools = []; MCPS.errors = {}; renderMcpPanel(); return OC.mcpTools; }

    MCPS.loading = true;
    renderMcpPanel();
    try {
        const r = await MCPAPI.tools('', force);
        OC.mcpTools = Array.isArray(r.tools) ? r.tools : [];
        const errs = (r.errors && typeof r.errors === 'object' && !Array.isArray(r.errors)) ? r.errors : {};
        MCPS.errors = errs;
        for (const [srv, msg] of Object.entries(errs)) {
            if (MCPS.notified[srv] === msg) continue;      // 同樣的錯誤不重複吵
            MCPS.notified[srv] = msg;
            toast(t('mcp.connFail', { s: srv, m: String(msg).slice(0, 80) }), 'warn', 6000);
        }
        MCPS.loadedAt = Date.now();
    } catch (e) {
        OC.mcpTools = [];
        MCPS.errors = { _: e.message };
        if (MCPS.notified._ !== e.message) {
            MCPS.notified._ = e.message;
            toast(t('mcp.listFail', { msg: e.message }), 'error', 6000);
        }
    } finally {
        MCPS.loading = false;
    }
    renderMcpPanel();
    return OC.mcpTools;
}

// 拆解 mcp__<server>__<tool>
function splitMcpName(prefixed) {
    const m = String(prefixed || '').match(/^mcp__(.+?)__(.+)$/);
    return m ? { server: m[1], tool: m[2] } : null;
}

// 由 tools.js 的 execTool 呼叫；回傳字串，失敗則 throw（讓工具層標成 is_error）
async function callMcpTool(prefixedName, args, signal) {
    const parsed = splitMcpName(prefixedName);
    if (!parsed) throw new Error(`不是合法的 MCP 工具名稱：${prefixedName}`);

    const r = await MCPAPI.call(parsed.server, parsed.tool, args || {}, signal);
    const res = r.result || {};
    const blocks = Array.isArray(res.content) ? res.content : [];

    const parts = [];
    for (const b of blocks) {
        if (!b || typeof b !== 'object') { parts.push(String(b ?? '')); continue; }
        if (b.type === 'text') parts.push(String(b.text ?? ''));
        else if (b.type === 'image') parts.push(`（伺服器回傳一張 ${b.mimeType || 'image'} 圖片，${fmtBytes((b.data || '').length * 0.75)}）`);
        else if (b.type === 'resource') parts.push(`（資源 ${b.resource?.uri || ''}）\n${b.resource?.text || ''}`);
        else parts.push(JSON.stringify(b));
    }
    const text = parts.join('\n').trim();

    if (res.isError) throw new Error(text || `MCP 工具 ${prefixedName} 回報錯誤（沒有附上訊息）`);
    return text || '（MCP 工具執行成功，但沒有回傳內容）';
}

// 給 tools.js 的 getTool() 用的合成工具描述
function mcpToolStub(name) {
    const t = (OC.mcpTools || []).find(x => x.name === name);
    const parsed = splitMcpName(name);
    return {
        name,
        description: t
            ? `[MCP／${t.server}] ${t.description || ''}`
            : `[MCP${parsed ? '／' + parsed.server : ''}] 這個 MCP 工具的說明尚未載入（伺服器可能離線）。`,
        params: t?.input_schema || { type: 'object', properties: {} },
        danger: 'net',
        readonly: false,
        run: (input, ctx) => callMcpTool(name, input, ctx?.signal),
    };
}

// ═══════════════════════════════════════════════════════════════
// 伺服器操作
// ═══════════════════════════════════════════════════════════════

async function testMcpServer(name) {
    toast(t('mcp.testing', { n: name }), 'info', 2000);
    try {
        const r = await MCPAPI.test(name);
        if (r.status === 'ok') {
            toast(t('mcp.testOk', { n: name, c: r.tool_count }), 'success', 4000);
            delete MCPS.notified[name];
        } else {
            toast(t('mcp.testErr', { n: name, m: r.error || t('mcp.testFail') }), 'error', 8000);
        }
    } catch (e) {
        toast(t('mcp.testErr', { n: name, m: e.message }), 'error', 8000);
    }
    await refreshMcpServers();
    await loadMcpTools(true);
    renderMcpPanel();
}

async function toggleMcpServer(name, enabled) {
    const cfgs = Object.assign({}, mcpConfig());
    if (!cfgs[name]) return false;
    cfgs[name] = Object.assign({}, cfgs[name], { enabled: !!enabled });
    try { await saveMcpConfig(cfgs); }
    catch (e) { toast(t('mcp.saveFail', { msg: e.message }), 'error'); renderMcpPanel(); return false; }
    toast(enabled ? t('mcp.toggledOn', { n: name }) : t('mcp.toggledOff', { n: name }), 'success', 1800);
    await refreshMcpServers();
    await loadMcpTools(true);
    renderMcpPanel();
    return true;
}

async function removeMcpServer(name) {
    const ok = await confirmModal(t('mcp.delT'),
        `<div class="cf-msg">${t('mcp.delB', { n: esc(name) })}</div>`,
        { danger: true, okText: t('common.del') });
    if (!ok) return false;

    const cfgs = Object.assign({}, mcpConfig());
    delete cfgs[name];
    try { await saveMcpConfig(cfgs); }
    catch (e) { toast(t('mcp.delFail', { msg: e.message }), 'error'); return false; }

    delete MCPS.status[name];
    delete MCPS.errors[name];
    delete MCPS.notified[name];
    toast(t('mcp.deletedT', { n: name }), 'success', 1800);
    await loadMcpTools(true);
    renderMcpPanel();
    return true;
}

// 開啟新增／編輯表單（preset 為 MCP_PRESETS 的 id 或設定物件）
function addMcpServer(preset) {
    MCPS.formOpen = true;
    MCPS.editing = null;
    renderMcpPanel();
    if (preset) applyMcpPreset(typeof preset === 'string' ? preset : null, typeof preset === 'object' ? preset : null);
    $('mcp-f-name')?.focus();
}

function editMcpServer(name) {
    const srv = mcpConfig()[name];
    if (!srv) return;
    MCPS.formOpen = true;
    MCPS.editing = name;
    renderMcpPanel();
    fillMcpForm({
        name,
        type: srv.type === 'stdio' || !srv.url ? 'stdio' : 'http',
        command: srv.command || '',
        args: Array.isArray(srv.args) ? srv.args : [],
        env: mcpKvToText(srv.env),
        url: srv.url || '',
        headers: mcpKvToText(srv.headers),
    });
}

function applyMcpPreset(id, obj) {
    const p = obj ? { fill: () => obj } : MCP_PRESETS.find(x => x.id === id);
    if (!p) return;
    fillMcpForm(p.fill());
}

// ═══════════════════════════════════════════════════════════════
// 表單
// ═══════════════════════════════════════════════════════════════

// {KEY:value} → "KEY=value" 逐行
function mcpKvToText(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '';
    return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('\n');
}

// "KEY=value" 逐行 → {KEY:value}；空行與 # 開頭略過
function mcpTextToKv(text) {
    const out = {};
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const i = line.indexOf('=');
        if (i < 1) continue;
        out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return out;
}

function fillMcpForm(v) {
    const set = (id, val) => { const n = $(id); if (n) n.value = val ?? ''; };
    set('mcp-f-name', v.name);
    set('mcp-f-command', v.command);
    set('mcp-f-args', Array.isArray(v.args) ? v.args.join('\n') : (v.args || ''));
    set('mcp-f-env', v.env);
    set('mcp-f-url', v.url);
    set('mcp-f-headers', v.headers);
    const t = $('mcp-f-type');
    if (t) { t.value = v.type || 'stdio'; }
    syncMcpFormType();
}

function syncMcpFormType() {
    const type = $('mcp-f-type')?.value || 'stdio';
    // hidden 屬性 + display 雙保險：避免 CSS 給 .mcp-f-group 設了 display 而蓋掉 [hidden]
    const show = (node, on) => {
        if (!node) return;
        node.hidden = !on;
        node.style.display = on ? '' : 'none';
    };
    show($('mcp-f-stdio'), type === 'stdio');
    show($('mcp-f-http'), type === 'http');
}

async function submitMcpForm() {
    const name = ($('mcp-f-name')?.value || '').trim();
    const type = $('mcp-f-type')?.value || 'stdio';
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
        toast(t('mcp.nameBad'), 'error');
        return false;
    }

    const entry = { type, enabled: true };
    if (type === 'http') {
        const url = ($('mcp-f-url')?.value || '').trim();
        if (!/^https?:\/\//i.test(url)) { toast(t('mcp.urlBad'), 'error'); return false; }
        entry.url = url;
        entry.headers = mcpTextToKv($('mcp-f-headers')?.value);
    } else {
        const command = ($('mcp-f-command')?.value || '').trim();
        if (!command) { toast(t('mcp.cmdBad'), 'error'); return false; }
        entry.command = command;
        entry.args = String($('mcp-f-args')?.value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        entry.env = mcpTextToKv($('mcp-f-env')?.value);
    }

    const cfgs = Object.assign({}, mcpConfig());
    if (MCPS.editing && MCPS.editing !== name) delete cfgs[MCPS.editing];   // 改名等於搬家
    if (cfgs[name]) entry.enabled = mcpEnabled(cfgs[name]);                 // 沿用原本的啟用狀態
    cfgs[name] = entry;

    try { await saveMcpConfig(cfgs); }
    catch (e) { toast(t('mcp.saveFail', { msg: e.message }), 'error'); return false; }

    MCPS.formOpen = false;
    MCPS.editing = null;
    delete MCPS.notified[name];
    toast(t('mcp.savedTesting', { n: name }), 'success', 2200);
    await testMcpServer(name);
    return true;
}

function mcpEnabled(srv) {
    if (!srv || !('enabled' in srv)) return true;
    return !!srv.enabled;
}

// ═══════════════════════════════════════════════════════════════
// 面板（#panel-mcp）
// ═══════════════════════════════════════════════════════════════

function mcpHost(force = false) {
    const host = $('panel-mcp');
    if (!host) return null;
    if (!force && host.dataset.ready === '1') return host;
    host.dataset.ready = '1';
    host.innerHTML = '';

    host.appendChild(el('div', { class: 'panel-head' },
        el('span', { class: 'panel-title' },
            el('span', { class: 'ms', text: 'hub' }),
            el('span', { text: t('panel.mcp') })),
        el('div', { class: 'panel-head-acts' },
            el('button', {
                class: 'btn btn-xs btn-ghost', title: t('mcp.newT'),
                onclick: () => addMcpServer(),
            }, el('span', { class: 'ms', text: 'add' }), el('span', { text: t('mcp.newOne') })),
            el('button', {
                class: 'btn-icon', title: t('mcp.reconnect'),
                onclick: () => { refreshMcpServers().then(() => loadMcpTools(true)); },
            }, el('span', { class: 'ms', text: 'refresh' }))
        )
    ));

    // 表單與清單都要包進 .panel-body（唯一有 overflow-y:auto 的捲動容器）。
    // 直接掛在 .oc-panel 上的話，伺服器一多或展開工具清單後就會被裁掉且捲不到。
    const body = el('div', { class: 'panel-body', id: 'mcp-body' },
        el('div', { class: 'mcp-form-host', id: 'mcp-form-host' }),
        el('div', { class: 'mcp-list', id: 'mcp-list' })
    );
    host.appendChild(body);
    return host;
}

function mcpStatusColor(st) {
    if (st === 'ok') return 'var(--success)';
    if (st === 'error') return 'var(--danger)';
    return 'var(--ink-faint)';
}

function mcpServerCard(name, srv) {
    const st = MCPS.status[name] || {};
    const enabled = mcpEnabled(srv);
    const type = srv.type === 'stdio' || !srv.url ? 'stdio' : 'http';
    const err = MCPS.errors[name] || st.error || '';
    const tools = (OC.mcpTools || []).filter(t => t.server === name);
    const count = tools.length || st.tool_count || 0;
    const target = type === 'http' ? (srv.url || '') : [srv.command, ...(srv.args || [])].join(' ');
    const status = !enabled ? 'off' : (err ? 'error' : (count ? 'ok' : (st.status || 'unknown')));

    const card = el('div', { class: 'card mcp-item' + (enabled ? '' : ' off') });

    // ─ 標頭 ─
    card.appendChild(el('div', { class: 'mcp-head' },
        el('span', { class: 'mcp-dot', style: { background: mcpStatusColor(status) }, title: status }),
        el('span', { class: 'mcp-name', text: name }),
        el('span', { class: 'chip mcp-type', text: type }),
        el('span', { class: 'mcp-count hint', text: enabled ? t('mcp.toolsN', { n: count }) : t('mcp.off') }),
        el('label', { class: 'mcp-toggle', title: enabled ? t('mcp.disable') : t('mcp.enable') },
            el('input', {
                type: 'checkbox', checked: enabled ? 'checked' : null,
                onchange: (e) => toggleMcpServer(name, e.target.checked),
            }),
            el('span', { class: 'ms', text: enabled ? 'toggle_on' : 'toggle_off' })
        )
    ));

    card.appendChild(el('div', {
        class: 'mcp-target mono', title: target,
        text: target.length > 72 ? target.slice(0, 72) + '…' : target,
    }));

    if (err) {
        card.appendChild(el('div', { class: 'mcp-err' },
            el('span', { class: 'ms', text: 'error' }),
            el('span', { text: String(err).slice(0, 240) })
        ));
    }

    // ─ 動作 ─
    card.appendChild(el('div', { class: 'mcp-acts' },
        el('button', { class: 'btn btn-xs btn-ghost', onclick: () => testMcpServer(name) },
            el('span', { class: 'ms', text: 'network_check' }), el('span', { text: t('mcp.test') })),
        el('button', { class: 'btn btn-xs btn-ghost', onclick: () => editMcpServer(name) },
            el('span', { class: 'ms', text: 'edit' }), el('span', { text: t('mcp.edit') })),
        el('button', { class: 'btn btn-xs btn-danger', onclick: () => removeMcpServer(name) },
            el('span', { class: 'ms', text: 'delete' }), el('span', { text: t('mcp.delOne') }))
    ));

    // ─ 工具清單（可展開）─
    if (tools.length) {
        const open = !!MCPS.expanded[name];
        card.appendChild(el('button', {
            class: 'btn btn-xs btn-ghost mcp-expand',
            onclick: () => { MCPS.expanded[name] = !open; renderMcpPanel(); },
        },
            el('span', { class: 'ms', text: open ? 'expand_less' : 'expand_more' }),
            el('span', { text: t('mcp.expandT', { o: open ? t('mcp.collapse') : t('mcp.expand'), n: tools.length }) })
        ));
        if (open) {
            const box = el('div', { class: 'mcp-tools' });
            for (const t of tools) {
                box.appendChild(el('div', { class: 'mcp-tool' },
                    el('code', { class: 'mcp-tool-name', title: t.name, text: t.raw_name || t.name }),
                    el('div', { class: 'mcp-tool-desc hint', text: (t.description || t('mcp.noDesc')).slice(0, 220) })
                ));
            }
            card.appendChild(box);
        }
    }

    return card;
}

function mcpFormCard() {
    const editing = MCPS.editing;
    const box = el('div', { class: 'card mcp-form' });

    box.appendChild(el('div', { class: 'mcp-form-head' },
        el('span', { class: 'ms', text: editing ? 'edit' : 'add_circle' }),
        el('span', { text: editing ? t('mcp.formEditT', { n: editing }) : t('mcp.formNewT') }),
        el('button', {
            class: 'modal-x ms', text: 'close', title: t('common.close'),
            onclick: () => { MCPS.formOpen = false; MCPS.editing = null; renderMcpPanel(); },
        })
    ));

    if (!editing) {
        const presets = el('div', { class: 'mcp-presets' });
        for (const p of MCP_PRESETS) {
            const meta = mcpPresetMeta(p.id) || p;
            presets.appendChild(el('button', {
                class: 'chip mcp-preset', title: meta.hint,
                onclick: () => applyMcpPreset(p.id),
            }, el('span', { class: 'ms', text: p.icon }), el('span', { text: meta.label })));
        }
        box.appendChild(el('div', { class: 'hint', text: t('mcp.presetHint') }));
        box.appendChild(presets);
    }

    box.appendChild(el('div', { class: 'ig' },
        el('label', { text: t('mcp.fName') }),
        el('input', { class: 'inp', id: 'mcp-f-name', placeholder: 'filesystem', value: editing || '' })
    ));

    box.appendChild(el('div', { class: 'ig' },
        el('label', { text: t('mcp.fType') }),
        el('select', { class: 'sel', id: 'mcp-f-type', onchange: syncMcpFormType },
            el('option', { value: 'stdio', text: t('mcp.stdioOpt') }),
            el('option', { value: 'http', text: t('mcp.httpOpt') })
        )
    ));

    // stdio 欄位
    box.appendChild(el('div', { class: 'mcp-f-group', id: 'mcp-f-stdio' },
        el('div', { class: 'ig' },
            el('label', { text: t('mcp.fCmd') }),
            el('input', { class: 'inp', id: 'mcp-f-command', placeholder: 'npx' })
        ),
        el('div', { class: 'ig' },
            el('label', { text: t('mcp.fArgs') }),
            el('textarea', { class: 'ta', id: 'mcp-f-args', rows: '4', placeholder: '-y\n@modelcontextprotocol/server-filesystem\nD:/xampp/htdocs' })
        ),
        el('div', { class: 'ig' },
            el('label', { text: t('mcp.fEnv') }),
            el('textarea', { class: 'ta', id: 'mcp-f-env', rows: '2', placeholder: 'API_TOKEN=xxxx' })
        )
    ));

    // http 欄位
    box.appendChild(el('div', { class: 'mcp-f-group', id: 'mcp-f-http' },
        el('div', { class: 'ig' },
            el('label', { text: t('mcp.fUrl') }),
            el('input', { class: 'inp', id: 'mcp-f-url', placeholder: 'http://localhost:3001/mcp' })
        ),
        el('div', { class: 'ig' },
            el('label', { text: t('mcp.fHeaders') }),
            el('textarea', { class: 'ta', id: 'mcp-f-headers', rows: '2', placeholder: 'Authorization=Bearer xxxx' })
        )
    ));

    box.appendChild(el('div', { class: 'modal-actions mcp-form-acts' },
        el('button', {
            class: 'btn btn-ghost', text: t('common.cancel'),
            onclick: () => { MCPS.formOpen = false; MCPS.editing = null; renderMcpPanel(); },
        }),
        el('button', { class: 'btn btn-primary', text: t('mcp.saveTest'), onclick: () => submitMcpForm() })
    ));

    box.appendChild(el('div', { class: 'hint', text: t('mcp.stdioHint') }));
    return box;
}

function renderMcpPanel(force = false) {
    const host = mcpHost(force);
    if (!host) return;

    // ─ 表單 ─
    const fh = $('mcp-form-host');
    if (fh) {
        const wasEditing = fh.dataset.for || '';
        const nowKey = MCPS.formOpen ? (MCPS.editing || '__new__') : '';
        if (wasEditing !== nowKey) {
            fh.innerHTML = '';
            fh.dataset.for = nowKey;
            if (MCPS.formOpen) { fh.appendChild(mcpFormCard()); syncMcpFormType(); }
        }
    }

    // ─ 伺服器清單 ─
    const box = $('mcp-list');
    if (!box) return;
    box.innerHTML = '';

    const cfgs = mcpConfig();
    const names = Object.keys(cfgs).sort();

    if (MCPS.loading) {
        box.appendChild(el('div', { class: 'mcp-loading' },
            el('span', { class: 'spinner' }),
            el('span', { class: 'hint', text: t('mcp.loading') })
        ));
    }

    if (!names.length) {
        box.appendChild(el('div', { class: 'panel-empty' },
            el('span', { class: 'ms', text: 'hub' }),
            el('div', { class: 'hint', text: t('mcp.emptyHint') }),
            el('button', { class: 'btn btn-sm btn-primary', onclick: () => addMcpServer() },
                el('span', { class: 'ms', text: 'add' }), el('span', { text: t('mcp.firstOne') }))
        ));
        return;
    }

    for (const n of names) box.appendChild(mcpServerCard(n, cfgs[n]));

    const total = (OC.mcpTools || []).length;
    box.appendChild(el('div', { class: 'hint mcp-foot', text: t('mcp.foot', { n: total }) }));
}

// ═══════════════════════════════════════════════════════════════
// 啟動
// ═══════════════════════════════════════════════════════════════
async function initMcp() {
    mcpHost();
    await refreshMcpServers();
    renderMcpPanel();
    // 有設定才連線：stdio 伺服器會真的開程序，沒必要在沒設定時付這個成本
    if (Object.keys(mcpConfig()).length) await loadMcpTools(false);
}

// ═══════════════════════════════════════════════════════════════
Object.assign(window, {
    MCPS, MCP_PRESETS,
    initMcp, loadMcpTools, callMcpTool, mcpToolStub, splitMcpName,
    renderMcpPanel, refreshMcpServers,
    addMcpServer, editMcpServer, testMcpServer, toggleMcpServer, removeMcpServer,
    submitMcpForm, mcpConfig,
});
