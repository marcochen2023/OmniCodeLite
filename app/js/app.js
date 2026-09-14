'use strict';
// ═══════════════════════════════════════════════════════════════
// Omni Code — 啟動、佈局、快捷鍵、設定 UI
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// 啟動
// ═══════════════════════════════════════════════════════════════

function splashStatus(s) { const e = $('splash-status'); if (e) e.textContent = s; }

async function boot() {
    try {
        splashStatus(t('splash.cfg'));
        let r;
        try {
            r = await SETTINGS.get();
        } catch (e) {
            splashFail(e);
            return;
        }
        OC.cfg = { ...OC.cfg, ...r.config };
        // 語系：config.json 優先，沒有就沿用 localStorage（開機第一幀已套用）；預設英文
        try {
            const loc = OC.cfg.locale || localStorage.getItem('oc_locale') || 'en';
            if (window.OC_I18N?.[loc]) { OC.cfg.locale = loc; localStorage.setItem('oc_locale', loc); }
            else OC.cfg.locale = 'en';
            document.documentElement.lang = (window.oc_html_lang?.(OC.cfg.locale)) || 'en';
        } catch {}

        // 舊設定遷移：thinkingLevel → effortLevel。刻度是對齊的
        // （standard→Low 4096、deep→High 12288、max→XHigh 24576），
        // 所以升級後沒有人的 token 花費會變動。順手把舊鍵註銷 ——
        // oc_cfg_save 是 array_merge，鍵刪不掉，只能寫成 null。
        const migrated = window.migrateEffort?.(OC.cfg);
        if (migrated) {
            OC.cfg.effortLevel = migrated;
            OC.cfg.thinkingLevel = null;
            SETTINGS.set({ effortLevel: migrated, thinkingLevel: null })
                .catch(e => console.warn('[migrate] effortLevel 存檔失敗', e.message));
        }

        OC.env = r.env || {};
        OC.ws = r.env?.workspace || OC.cfg.workspace || '';

        // 主題：localStorage 優先（使用者當下的選擇）
        setTheme(localStorage.getItem('oc_theme') || OC.cfg.theme || 'dark');

        if (!OC.env.workspace_exists) {
            toast(t('ws.notExist', { ws: OC.ws }), 'error', 8000);
        } else if (!OC.env.workspace_writable) {
            toast(t('ws.noWrite', { ws: OC.ws }), 'warn', 8000);
        }

        splashStatus(t('splash.ui'));
        renderWorkspaceLabel();
        // 模型設定存在 data/models.json（獨立於 config.json）——
        // 一定要在畫模型選單之前載入，否則第一次請求會用到出廠清單
        await window.loadModelConfig?.({ silent: false });
        window.rebuildModels?.();   // 套用使用者的模型設定（必須在畫選單之前）
        renderModelButton();
        renderPermButton();
        renderEffortButton();
        wireTopBar();
        wireRail();
        wireDock();
        wireResizers();
        wireShortcuts();
        wireChatForm();
        wireExtraButton();
        wireGlobalErrors();
        window.initSchedules?.();   // 排程只在分頁開著時活著（見 schedule.js 檔頭）
        // 自撰 API 工具：開機讀一次就好，之後只在 edit_tool 存檔後重載
        window.loadUserTools?.().catch(() => {});
        restoreLayout();

        // 各模組初始化（缺任何一個都不該讓整個 App 掛掉）
        safeInit('編輯器', () => window.initEditor?.());
        safeInit('檔案樹', () => window.initFileTree?.());
        safeInit('終端機', () => window.initTerminal?.());
        safeInit('變更檢視', () => window.initDiffView?.());
        safeInit('圖片工作室', () => window.initImageStudio?.());
        safeInit('斜線指令', () => window.initSlash?.());
        safeInit('@ 提及', () => window.initMention?.());
        safeInit('技能面板', () => window.initSkillsPanel?.());
        safeInit('使用模式', () => window.initModes?.());   // 要在會話續接之前：續接只接同模式的會話
        safeInit('會話', () => window.initSessions?.());
        safeInit('MCP', () => window.initMcp?.());
        safeInit('記憶面板', () => window.initMemoryPanel?.());
        safeInit('模型管理', () => window.initModelsPanel?.());
        safeInit('流量面板', () => window.initUsagePanel?.());

        renderSettingsPanel();

        splashStatus(t('splash.proj'));
        await Promise.allSettled([
            window.refreshFileTree?.(),
            loadOmniMd(true),
            loadMemories(true),
            loadSkills(true),
            window.loadCommands?.(true),
        ]);

        // 背景載入（不擋啟動）
        loadMcpTools?.(false).catch(() => {});
        refreshGitInfo?.();

        splashStatus(t('splash.chat'));
        try { window.applyChromeI18n?.(); } catch {}
        await window.resumeLastSession?.();
        // 續接的會話若有掛載，loadSession 內已同步為作用中；這裡只重畫標籤
        window.renderExtraRoots?.();
        window.renderTokenMeter?.();
        window.renderTodos?.();
        window.chatRenderAll?.();

        OC.ready = true;
        hideSplash();

        // 沒有任何 API Key → 引導設定；否則每次進入先問今天要做什麼（modes.js）
        if (!configuredProviders().length) {
            setTimeout(() => {
                window.openKeysModal?.();
                toast(t('keys.needOne'), 'info', 6000);
            }, 500);
        } else {
            setTimeout(() => window.showEntryModal?.(), 250);
        }
        $('chat-input')?.focus();
    } catch (e) {
        console.error(e);
        splashFail(e);
    }
}

function safeInit(name, fn) {
    try { fn(); }
    catch (e) { console.error(`[${name}] 初始化失敗`, e); errorTicker(`${name}模組初始化失敗`, e.message); }
}

function hideSplash() {
    const s = $('splash');
    if (!s) return;
    s.classList.add('out');
    setTimeout(() => s.remove(), 500);
}

function splashFail(e) {
    const s = $('splash');
    if (!s) return;
    s.querySelector('.splash-spinner')?.remove();
    s.querySelector('.splash-inner').innerHTML += `
      <div class="splash-err">
        <div class="splash-err-title">${esc(t('splash.failT'))}</div>
        <div class="splash-err-msg">${esc(e.message)}</div>
        <div class="splash-err-hint">${t('splash.failH')}</div>
        <button class="btn btn-primary" onclick="location.reload()">${esc(t('splash.retry'))}</button>
      </div>`;
}

// ═══════════════════════════════════════════════════════════════
// 頂列
// ═══════════════════════════════════════════════════════════════

function renderWorkspaceLabel() {
    const e = $('ws-path');
    if (!e) return;
    const full = OC.ws || '';
    // 頂列只顯示最末端資料夾名，完整路徑放 title tooltip（hover 才看）
    const short = full ? full.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || full : '(未設定)';
    e.textContent = short;
    e.title = full || '(未設定)';
}

// ─── 通用選單（Model / Effort / Mode 三個 picker 共用一套渲染）───
// rows: [{ id, icon, iconColor, label, hint, meta, badges, active, disabled, group }]
function openPicker({ title, rows, foot, onPick }) {
    const body = el('div', {});
    const list = el('div', { class: 'pick-list' });
    let lastGroup = null;
    for (const r of rows) {
        if (r.sep) { list.appendChild(el('div', { class: 'pick-sep' })); continue; }
        if (r.group && r.group !== lastGroup) {
            list.appendChild(el('div', { class: 'pick-group', text: r.group }));
            lastGroup = r.group;
        }
        const btn = el('button', {
            class: 'pick-row' + (r.active ? ' active' : ''),
            disabled: r.disabled ? 'disabled' : null,
            onclick: () => { if (r.disabled) return; closeModal('modal-generic'); onPick(r.id); },
        });
        btn.appendChild(el('span', { class: 'ms pick-ico', text: r.icon || 'circle',
            style: r.iconColor ? `color:${r.iconColor}` : '' }));
        const txt = el('span', { class: 'pick-txt' });
        txt.appendChild(el('b', { text: r.label }));
        if (r.hint) txt.appendChild(el('span', { text: r.hint }));
        btn.appendChild(txt);
        if (r.badges?.length) {
            const bs = el('span', { class: 'pick-badges' });
            for (const b of r.badges) bs.appendChild(el('span', { class: 'pick-badge' + (b.warn ? ' warn' : ''), text: b.text || b }));
            btn.appendChild(bs);
        }
        if (r.meta) btn.appendChild(el('span', { class: 'pick-meta', html: r.meta }));
        if (r.active) btn.appendChild(el('span', { class: 'ms pick-check', text: 'check' }));
        list.appendChild(btn);
    }
    body.appendChild(list);
    if (foot) body.appendChild(el('div', { class: 'pick-foot', html: foot }));

    $('modal-generic-title').textContent = title;
    const mb = $('modal-generic-body');
    mb.innerHTML = '';
    mb.appendChild(body);
    $('modal-generic-actions').innerHTML = '';
    $('modal-generic-actions').appendChild(
        el('button', { class: 'btn btn-ghost', text: '關閉', onclick: () => closeModal('modal-generic') }));
    openModal('modal-generic');
    // 開啟時把焦點放在目前選中的那列，鍵盤上下鍵就能直接切換
    setTimeout(() => (mb.querySelector('.pick-row.active') || mb.querySelector('.pick-row'))?.focus(), 40);
}

// ─── Model ───────────────────────────────────────────────────────
function renderModelButton() {
    const lab = $('model-label');
    // 目前模型若不可用就自動換一個 —— 這個保底以前藏在 renderModelSelect 裡，
    // 是「剛填完第一把金鑰」那條路徑上唯一的守門員，不能弄丟
    const avail = availableModels();
    if (!avail.find(m => m.id === OC.cfg.model)) OC.cfg.model = avail[0]?.id || API_CONFIG.models[0].id;
    if (!lab) return;
    const info = getModelInfo(OC.cfg.model);
    lab.textContent = info.displayName || OC.cfg.model;
    const btn = $('model-btn');
    if (btn) btn.title = t('top.modelTitle');
}

function openModelPicker() {
    const configured = new Set(configuredProviders());
    const anyKey = configured.size > 0;
    const rows = [];
    for (const [pid, p] of Object.entries(API_CONFIG.providers)) {
        const list = API_CONFIG.models.filter(m => m.provider === pid);
        for (const m of list) {
            const has = configured.has(pid);
            const r = window.modelRates ? modelRates(m.id) : { in: null, out: null };
            const badges = [];
            if (!has) badges.push({ text: t('model.noKey'), warn: true });
            if (m.thinking === false) badges.push({ text: t('model.noThink') });
            else if (m.effortMax) badges.push({ text: t('model.capped', { label: API_CONFIG.effort.levels[m.effortMax]?.label || m.effortMax }) });
            rows.push({
                id: m.id, group: p.label, icon: 'smart_toy',
                label: m.displayName, hint: t('model.ctx', { n: fmtNum(m.context || 0) }),
                meta: (r.in !== null && r.out !== null)
                    ? `$${r.in} / $${r.out}<br><span style="opacity:.6">${esc(t('model.perM'))}</span>` : '',
                badges, active: m.id === OC.cfg.model,
                disabled: !has && anyKey,
            });
        }
    }
    const cur = resolveEffort(OC.cfg.model, OC.cfg.effortLevel);
    openPicker({
        title: t('model.menuT'),
        rows,
        foot: t('model.foot', { label: esc(API_CONFIG.effort.levels[cur].label) }),
        onPick: setModel,
    });
    // Claude Code 的 modelPicker:decreaseEffort / increaseEffort
    const mb = $('modal-generic-body');
    mb.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const O = API_CONFIG.effort.order;
        const i = O.indexOf(OC.cfg.effortLevel || API_CONFIG.effort.default);
        const next = O[Math.min(O.length - 1, Math.max(0, i + (e.key === 'ArrowRight' ? 1 : -1)))];
        setEffortLevel(next, { quiet: true });
        const f = mb.querySelector('.pick-foot');
        if (f) f.innerHTML = t('model.foot', { label: esc(API_CONFIG.effort.levels[resolveEffort(OC.cfg.model, next)].label) });
    });
}

function setModel(id) {
    OC.cfg.model = id;
    window.clearCooldown?.(id);      // 使用者明確選了它，別跟使用者的意圖作對
    SETTINGS.set({ model: id }).catch(e => toast(t('model.saveFail', { msg: e.message }), 'error'));
    renderModelButton();
    renderEffortButton();
    window.renderTokenMeter?.();
}

// ─── Effort ──────────────────────────────────────────────────────
// 等級名稱沿用 Claude Code 的 /effort。難題上讓模型多想幾千個 token 再動手，
// 比讓它急著改一輪錯一輪划算得多。
// 等級 label 是國際通用的檔位名（Off/Low/Medium/High…），不翻譯；hint 走 effort.h_* 鍵。
function renderEffortButton() {
    const btn = $('effort-btn');
    if (!btn) return;
    const want = OC.cfg.effortLevel || API_CONFIG.effort.default;
    const eff = resolveEffort(OC.cfg.model, want);
    const L = API_CONFIG.effort.levels[eff] || API_CONFIG.effort.levels[API_CONFIG.effort.default];
    btn.dataset.level = eff;
    btn.style.setProperty('--effort-color', L.color);
    const lab = $('effort-label');
    if (lab) lab.textContent = L.label;
    const ico = btn.querySelector('.effort-ico');
    if (ico) ico.textContent = L.icon || 'neurology';

    const na = typeof thinkingUnsupported === 'function' && thinkingUnsupported(OC.cfg.model);
    btn.classList.toggle('effort-na', !!na && eff !== 'off');
    btn.classList.toggle('effort-capped', eff !== want);
    btn.title = t('top.effortTitle') + `：${L.label}`;
}

function openEffortPicker() {
    const want = OC.cfg.effortLevel || API_CONFIG.effort.default;
    const na = typeof thinkingUnsupported === 'function' && thinkingUnsupported(OC.cfg.model);
    const cap = getModelInfo(OC.cfg.model)?.effortMax;
    const O = API_CONFIG.effort.order;

    const rows = [];
    for (const k of O) {
        if (k === 'off') rows.push({ sep: true });     // off 不是強度等級，用分隔線區隔
        const L = API_CONFIG.effort.levels[k];
        const capped = cap && O.indexOf(k) > O.indexOf(cap);
        rows.push({
            id: k, icon: L.icon, iconColor: L.color,
            label: L.label, hint: t('effort.h_' + k),
            badges: capped ? [{ text: t('effort.capped', { label: API_CONFIG.effort.levels[cap].label }), warn: true }] : [],
            active: want === k,
        });
    }
    // off 排在最後（order 是 off 開頭，這裡把它移到末尾比較符合「關閉」的語意）
    const offRow = rows.find(r => r.id === 'off');
    const sepIdx = rows.findIndex(r => r.sep);
    rows.splice(rows.indexOf(offRow), 1);
    rows.splice(sepIdx, 1);
    rows.push({ sep: true }, offRow);

    openPicker({
        title: t('effort.menuT'),
        rows,
        foot: na ? t('effort.footNa') : t('effort.foot'),
        onPick: setEffortLevel,
    });
}

function setEffortLevel(lv, { quiet = false } = {}) {
    if (!API_CONFIG.effort.levels[lv]) return false;
    OC.cfg.effortLevel = lv;
    // 存檔失敗要講 —— 以前這裡是 .catch(() => {})，後端擋掉時使用者
    // 只看到按鈕變了、toast 跳了，重開卻整個彈回去，完全不知道發生什麼事
    SETTINGS.set({ effortLevel: lv }).catch(e => toast(t('effort.saveFail', { msg: e.message }), 'error', 6000));
    renderEffortButton();
    if (!quiet) toast(t('effort.toast', { label: API_CONFIG.effort.levels[lv].label }), 'success', 2000);
    return true;
}

// ─── Mode（權限模式）───────────────────────────────────────────
function renderPermButton() {
    const btn = $('mode-btn');
    if (!btn) return;
    const mode = OC.cfg.permissionMode || 'default';
    const M = (window.permModeMeta ? permModeMeta(mode) : null) || window.PERM_MODES[mode] || window.PERM_MODES.default;
    btn.dataset.mode = mode;
    const g = btn.querySelector('.mode-glyph');
    if (g) g.textContent = M.glyph || '●';
    const lab = $('mode-label');
    if (lab) lab.textContent = M.label;
    btn.title = t('top.modeTitle');
    // 輸入框邊框跟著模式變色（Claude Code 的 planMode / autoAccept 提示）
    $('oc-app')?.setAttribute('data-perm-mode', mode);
}

function openModePicker() {
    const cur = OC.cfg.permissionMode || 'default';
    const rows = PERM_ORDER.map(k => {
        const M = (window.permModeMeta ? permModeMeta(k) : null) || window.PERM_MODES[k];
        return {
            id: k, icon: M.icon, iconColor: M.color,
            label: M.label, hint: M.desc,
            meta: M.glyph ? `<span style="font-size:13px">${M.glyph}</span>` : '',
            active: cur === k,
        };
    });
    openPicker({
        title: t('mode.menuT'),
        rows,
        foot: t('mode.menuF'),
        onPick: (m) => setPermissionMode(m),
    });
}

// Hooks 狀態（設定面板）。
// 設定檔語法錯誤要明講 —— 靜默忽略的話，使用者會以為 hook 沒生效，
// 但其實只是 JSON 少了一個逗號。
function renderHooksSection() {
    const box = $('set-hooks-body');
    if (!box) return;
    const err = window.hooksError?.();
    const sum = window.hooksSummary?.();

    box.innerHTML = '';
    if (err) {
        box.appendChild(el('div', { class: 'set-hook-err' },
            el('span', { class: 'ms', text: 'error' }),
            el('span', { text: t('settings.hooksErr', { msg: err }) })));
    } else if (!sum) {
        box.appendChild(el('div', { class: 'hint', text: t('settings.hooksNone') }));
    } else {
        const list = el('div', { class: 'set-hook-list' });
        for (const [ev, n] of Object.entries(sum)) {
            list.appendChild(el('div', { class: 'set-hook-row' },
                el('span', { class: 'chip', text: ev }),
                el('span', { class: 'hint', text: t('settings.hooksN', { n }) })));
        }
        box.appendChild(list);
    }

    const acts = el('div', { class: 'set-hook-acts' });
    acts.appendChild(el('button', {
        class: 'btn btn-sm btn-ghost',
        onclick: async () => {
            const st = await FS.stat(window.HOOKS_PATH).catch(() => null);
            if (st?.exists) window.openFile?.(window.HOOKS_PATH);
            else await window.createHooksFile?.();
        },
    }, el('span', { class: 'ms', text: 'edit_note' }), el('span', { text: sum || err ? t('settings.hooksEdit') : t('settings.hooksCreate') })));
    acts.appendChild(el('button', {
        class: 'btn btn-sm btn-ghost',
        onclick: async () => { window.invalidateHooks?.(); await window.loadHooks?.(true); renderHooksSection(); toast(t('settings.hooksReloaded'), 'info'); },
    }, el('span', { class: 'ms', text: 'refresh' }), el('span', { text: t('settings.hooksReload') })));
    box.appendChild(acts);
}
window.renderHooksSection = renderHooksSection;

// 舊名別名 —— models.js / app 開機流程等處還在呼叫
window.renderModelSelect = renderModelButton;
window.renderThinkButton = renderEffortButton;
window.setThinkingLevel = (lv) => setEffortLevel(lv);
Object.assign(window, {
    renderModelButton, openModelPicker, setModel,
    renderEffortButton, openEffortPicker, setEffortLevel,
    renderPermButton, openModePicker, openPicker,
});

function wireTopBar() {
    $('model-btn')?.addEventListener('click', () => openModelPicker());
    $('mode-btn')?.addEventListener('click', () => openModePicker());
    $('effort-btn')?.addEventListener('click', () => openEffortPicker());
    $('theme-btn')?.addEventListener('click', () => {
        toggleTheme();
        SETTINGS.set({ theme: document.documentElement.dataset.theme }).catch(() => {});
    });
    $('keys-btn')?.addEventListener('click', () => openKeysModal());
    $('ws-picker')?.addEventListener('click', () => openWorkspacePicker());
    $('chat-toggle-btn')?.addEventListener('click', () => toggleChat());
    $('layout-swap-btn')?.addEventListener('click', () => toggleChatWide());
    $('image-btn')?.addEventListener('click', () => window.openImageStudio?.());
    $('chat-new')?.addEventListener('click', () => window.newSession?.());
    $('sess-new')?.addEventListener('click', () => window.newSession?.());
    $('chat-history')?.addEventListener('click', () => switchPanel('sessions'));
    $('chat-compact')?.addEventListener('click', () => compactContext({}));
}

// ═══════════════════════════════════════════════════════════════
// 面板 / Dock 切換
// ═══════════════════════════════════════════════════════════════

function switchPanel(name) {
    if (!name) return;
    // 同一個面板再點一次 = 收合
    if (OC.panel === name && !$('oc-app').classList.contains('side-collapsed')) {
        toggleSide(false); return;
    }
    OC.panel = name;
    $('oc-app').classList.remove('side-collapsed');
    $$('.oc-panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
    $$('.rail-btn').forEach(b => b.classList.toggle('active', b.dataset.panel === name));
    localStorage.setItem('oc_panel', name);
    // 進入面板時刷新
    if (name === 'sessions') window.renderSessionsPanel?.();
    if (name === 'memory') window.renderMemoryPanel?.();
    if (name === 'skills') window.renderSkillsPanel?.();
    if (name === 'mcp') window.renderMcpPanel?.();
    if (name === 'search') window.renderSearchPanel?.();   // 面板自己會聚焦輸入框
    if (name === 'settings') renderSettingsPanel();
    if (name === 'models') window.renderModelsPanel?.();
    if (name === 'usage') window.loadUsage?.(true);        // 每次進入都重抓，用量隨時在變
    if (name === 'self') window.renderSelfPanel?.(true);   // 自我提升：版本、規劃、歷程
}

function toggleSide(force) {
    const app = $('oc-app');
    const collapsed = force === undefined ? !app.classList.contains('side-collapsed') : !force;
    app.classList.toggle('side-collapsed', collapsed);
    localStorage.setItem('oc_side_collapsed', collapsed ? '1' : '0');
}

function toggleChat(force) {
    const app = $('oc-app');
    const collapsed = force === undefined ? !app.classList.contains('chat-collapsed') : !force;
    app.classList.toggle('chat-collapsed', collapsed);
    localStorage.setItem('oc_chat_collapsed', collapsed ? '1' : '0');
    const ic = $('chat-toggle-btn')?.querySelector('.ms');
    if (ic) ic.textContent = collapsed ? 'right_panel_open' : 'right_panel_close';
}

// 對調版面：對話欄進中央大欄、編輯器去右側窄欄（CSS 只換 grid-column，DOM 不動）
function toggleChatWide(force) {
    const app = $('oc-app');
    const wide = force === undefined ? !app.classList.contains('chat-wide') : !!force;
    app.classList.toggle('chat-wide', wide);
    localStorage.setItem('oc_chat_wide', wide ? '1' : '0');
    const btn = $('layout-swap-btn');
    if (btn) btn.classList.toggle('active', wide);
    // 兩欄寬度互換，CodeMirror 量測失效，下一幀重算
    requestAnimationFrame(() => window.getActiveFile?.()?.cm?.refresh());
}

function switchDock(name) {
    if (!name) return;
    OC.dock = name;
    OC.dockOpen = true;
    $('oc-app').classList.remove('dock-collapsed');
    $$('.dock-view').forEach(v => v.classList.toggle('active', v.id === 'dock-' + name));
    $$('.dock-tab').forEach(t => t.classList.toggle('active', t.dataset.dock === name));
    localStorage.setItem('oc_dock', name);
    if (name === 'diff') window.listSessionChanges?.();
}

function toggleDock(force) {
    const app = $('oc-app');
    const collapsed = force === undefined ? !app.classList.contains('dock-collapsed') : !force;
    app.classList.toggle('dock-collapsed', collapsed);
    OC.dockOpen = !collapsed;
    localStorage.setItem('oc_dock_collapsed', collapsed ? '1' : '0');
    const ic = $('dock-toggle')?.querySelector?.('.ms') || $('dock-toggle');
    if (ic) ic.textContent = collapsed ? 'keyboard_double_arrow_up' : 'keyboard_double_arrow_down';
    // 高度突變時 CodeMirror 的量測就失效了，下一幀重算
    requestAnimationFrame(() => window.getActiveFile?.()?.cm?.refresh());
}

function wireRail() {
    $$('.rail-btn[data-panel]').forEach(b =>
        b.addEventListener('click', () => switchPanel(b.dataset.panel)));
}

function wireDock() {
    $$('.dock-tab[data-dock]').forEach(t =>
        t.addEventListener('click', () => switchDock(t.dataset.dock)));
    $('dock-toggle')?.addEventListener('click', () => toggleDock());
    $('preview-go')?.addEventListener('click', () => openPreview($('preview-url').value));
    $('preview-url')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); openPreview(e.target.value); }
    });
    $('preview-reload')?.addEventListener('click', () => {
        const f = $('dock-preview-frame');
        if (f) f.src = f.src;
    });
    $('preview-ext')?.addEventListener('click', () => {
        const u = $('dock-preview-frame')?.src;
        if (u && u !== 'about:blank') window.open(u, '_blank', 'noopener');
    });
}

function openPreview(url) {
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
    switchDock('preview');
    const f = $('dock-preview-frame');
    if (f) f.src = url;
    const i = $('preview-url');
    if (i) i.value = url;
}

// ═══════════════════════════════════════════════════════════════
// 版面拖曳
// ═══════════════════════════════════════════════════════════════

function wireResizers() {
    makeResizer('resizer-side', 'x', (dx, start) => {
        const w = Math.min(560, Math.max(180, start + dx));
        document.documentElement.style.setProperty('--side-w', w + 'px');
        localStorage.setItem('oc_side_w', w);
    }, () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--side-w')) || 260);

    makeResizer('resizer-chat', 'x', (dx, start) => {
        const w = Math.min(900, Math.max(300, start - dx));
        document.documentElement.style.setProperty('--chat-w', w + 'px');
        localStorage.setItem('oc_chat_w', w);
    }, () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--chat-w')) || 420);

    makeResizer('resizer-dock', 'y', (dy, start) => {
        const h = Math.min(window.innerHeight - 200, Math.max(80, start - dy));
        document.documentElement.style.setProperty('--dock-h', h + 'px');
        localStorage.setItem('oc_dock_h', h);
        window.getActiveFile?.()?.cm?.refresh();
    }, () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--dock-h')) || 200);

    // dock 把手連點兩下 = 收合／展開（跟 dock 分頁列右上角的按鈕同行為）
    $('resizer-dock')?.addEventListener('dblclick', () => toggleDock());
}

function makeResizer(id, axis, onMove, getStart) {
    const h = $(id);
    if (!h) return;
    h.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const p0 = axis === 'x' ? e.clientX : e.clientY;
        const start = getStart();
        h.setPointerCapture(e.pointerId);
        // y 軸拖曳用 resizing-v 才會出現 row-resize 游標（resizing 是橫向的）
        document.body.classList.add(axis === 'x' ? 'resizing' : 'resizing-v');
        h.classList.add('dragging');
        const move = (ev) => onMove((axis === 'x' ? ev.clientX : ev.clientY) - p0, start);
        const up = (ev) => {
            h.releasePointerCapture(ev.pointerId);
            document.body.classList.remove('resizing', 'resizing-v');
            h.classList.remove('dragging');
            h.removeEventListener('pointermove', move);
            h.removeEventListener('pointerup', up);
            window.getActiveFile?.()?.cm?.refresh();
        };
        h.addEventListener('pointermove', move);
        h.addEventListener('pointerup', up);
    });
}

function restoreLayout() {
    const set = (k, v) => v && document.documentElement.style.setProperty(k, v + 'px');
    set('--side-w', localStorage.getItem('oc_side_w'));
    set('--chat-w', localStorage.getItem('oc_chat_w'));
    set('--dock-h', localStorage.getItem('oc_dock_h'));
    if (localStorage.getItem('oc_side_collapsed') === '1') toggleSide(false);
    if (localStorage.getItem('oc_chat_collapsed') === '1') toggleChat(false);
    if (localStorage.getItem('oc_dock_collapsed') === '1') toggleDock(false);
    if (localStorage.getItem('oc_chat_wide') !== '0') toggleChatWide(true);
    // OC.panel 在 state.js 已預設為 'files'，若直接 switchPanel('files')
    // 會被當成「重複點同一個面板 → 收合側欄」，導致每次開啟都少了側欄。
    OC.panel = '';
    switchPanel(localStorage.getItem('oc_panel') || 'files');
    switchDock(localStorage.getItem('oc_dock') || 'terminal');
}

// ═══════════════════════════════════════════════════════════════
// 快捷鍵
// ═══════════════════════════════════════════════════════════════

function wireShortcuts() {
    document.addEventListener('keydown', (e) => {
        const mod = e.ctrlKey || e.metaKey;
        const tag = (document.activeElement?.tagName || '').toUpperCase();
        const inField = tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable;
        const inCM = !!document.activeElement?.closest?.('.CodeMirror');

        // Esc：關 modal → 停止 Agent
        if (e.key === 'Escape') {
            const m = topModal();
            // 一定要走 closeModal：它會觸發 Promise 型對話框註冊的「取消」回呼。
            // 直接拿掉 class 會讓 await confirmModal(...) 永遠不結算。
            if (m) { closeModal(m.id); e.preventDefault(); return; }
            if ($('image-studio')?.classList.contains('active')) { window.closeImageStudio?.(); e.preventDefault(); return; }
            if (OC.running) { stopAgent(); e.preventDefault(); return; }
        }

        // Shift+Tab：循環 Mode。
        // 以前擋掉「在輸入框內」，但這顆是 Claude Code 的招牌快捷鍵，
        // 而使用者九成時間游標都在聊天輸入框裡 —— 等於永遠按不到。
        // 聊天輸入框放行；程式碼編輯器（CodeMirror）維持攔截，那裡的
        // Shift+Tab 是反縮排。
        if (e.key === 'Tab' && e.shiftKey && !inCM) {
            const inChat = document.activeElement?.id === 'chat-input';
            if (!inField || inChat) { e.preventDefault(); cyclePermissionMode(); return; }
        }

        // Alt+M / Alt+E：模型與 Effort 選單（Claude Code 的 modelPicker）
        if (e.altKey && !mod && !e.shiftKey) {
            const k = e.key.toLowerCase();
            if (k === 'm') { e.preventDefault(); openModelPicker(); return; }
            if (k === 'e') { e.preventDefault(); openEffortPicker(); return; }
        }

        if (!mod) return;

        switch (e.key.toLowerCase()) {
            case 's':
                e.preventDefault();
                window.saveActiveFile?.();
                break;
            case 'p':
                if (e.shiftKey) return;
                e.preventDefault();
                window.quickOpen?.();
                break;
            case 'b':
                e.preventDefault(); toggleSide(); break;
            case 'f':
                if (e.shiftKey) { e.preventDefault(); switchPanel('search'); }
                break;
            case 'k':
                e.preventDefault(); window.quickOpen?.(); break;
            case 'l':
                if (!inCM) { e.preventDefault(); window.chatClear?.(); }
                break;
            case '`':
                e.preventDefault();
                if (OC.dock === 'terminal' && OC.dockOpen) toggleDock(false);
                else switchDock('terminal');
                break;
            case 'j':
                e.preventDefault(); toggleDock(); break;
            case 'i':
                if (e.shiftKey) { e.preventDefault(); window.openImageStudio?.(); }
                break;
            case 'enter':
                if (document.activeElement?.id === 'chat-input') {
                    e.preventDefault();
                    $('chat-form')?.requestSubmit();
                }
                break;
        }
    }, true);
}

// ═══════════════════════════════════════════════════════════════
// 對話輸入區
// ═══════════════════════════════════════════════════════════════

let _attachments = [];

function wireChatForm() {
    const form = $('chat-form');
    const input = $('chat-input');
    if (!form || !input) return;

    // 自動增高
    const grow = () => {
        input.style.height = 'auto';
        input.style.height = Math.min(220, input.scrollHeight) + 'px';
    };
    input.addEventListener('input', grow);

    // Enter 送出，Shift+Enter 換行
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !window._slashOpen) {
            e.preventDefault();
            form.requestSubmit();
        }
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text && !_attachments.length) return;

        // 執行中不擋輸入 —— 想到什麼就先打，排進佇列，
        // Agent 跑完這一輪自然會看到。這比「請等待」有用得多，
        // 因為使用者往往在看到工具輸出的當下就知道要補充什麼。
        if (OC.running) {
            input.value = '';
            input.style.height = 'auto';
            const atts = _attachments.slice();
            _attachments = [];
            renderAttachments();
            window.queueMessage?.(text, atts);
            return;
        }

        input.value = '';
        input.style.height = 'auto';
        const atts = _attachments.slice();
        _attachments = [];
        renderAttachments();
        await runAgent(text, atts);
    });

    $('chat-stop')?.addEventListener('click', () => stopAgent());
    $('chat-attach')?.addEventListener('click', () => $('chat-file-input')?.click());
    $('chat-file-input')?.addEventListener('change', async (e) => {
        for (const f of e.target.files) await addAttachment(f);
        e.target.value = '';
    });

    // 貼上圖片
    input.addEventListener('paste', async (e) => {
        const items = Array.from(e.clipboardData?.items || []);
        const imgs = items.filter(i => i.type.startsWith('image/'));
        if (!imgs.length) return;
        e.preventDefault();
        for (const i of imgs) { const f = i.getAsFile(); if (f) await addAttachment(f); }
    });

    // 拖放圖片到對話區
    const chat = $('oc-chat');
    chat?.addEventListener('dragover', e => { e.preventDefault(); chat.classList.add('drop-hint'); });
    chat?.addEventListener('dragleave', () => chat.classList.remove('drop-hint'));
    chat?.addEventListener('drop', async (e) => {
        e.preventDefault();
        chat.classList.remove('drop-hint');
        for (const f of e.dataTransfer.files) {
            if (f.type.startsWith('image/')) await addAttachment(f);
        }
    });
}

async function addAttachment(file) {
    if (_attachments.length >= 5) { toast(t('chat.attachMax'), 'warn'); return; }
    if (!file.type.startsWith('image/')) { toast(t('chat.attachImgOnly'), 'warn'); return; }
    try {
        const dataUrl = await compressImageFile(file, 1568, 0.85);
        const { mime, data } = splitDataUrl(dataUrl);
        _attachments.push({ mime, data, dataUrl, name: file.name });
        renderAttachments();
    } catch (e) { toast(t('chat.imgFail', { msg: e.message }), 'error'); }
}

function renderAttachments() {
    const box = $('chat-attachments');
    if (!box) return;
    box.innerHTML = '';
    box.classList.toggle('has', _attachments.length > 0);
    _attachments.forEach((a, i) => {
        const n = el('div', { class: 'att-thumb' },
            el('img', { src: a.dataUrl, alt: a.name }),
            el('button', { class: 'att-x ms', text: 'close', type: 'button',
                onclick: () => { _attachments.splice(i, 1); renderAttachments(); } })
        );
        box.appendChild(n);
    });
}

// ═══════════════════════════════════════════════════════════════
// 額外工作資料夾（對話欄 folder_open 按鈕，見 index.html #chat-extra）
// ═══════════════════════════════════════════════════════════════
// 跟著目前對話走：OC.session.extraRoots 是真相，OC.cfg.activeExtraRoots
// 是後端守門的作用中副本（loadSession 時同步）。掛載／卸載都要雙寫：
// 後端放行＋會話存檔，否則切換對話回來就丟了（或殘留上一個對話的授權）。

const EXTRA_MAX = 5;

function extraRoots() {
    if (!Array.isArray(OC.session.extraRoots)) OC.session.extraRoots = [];
    return OC.session.extraRoots;
}

function renderExtraRoots() {
    const box = $('chat-extras');
    if (!box) return;
    const roots = extraRoots();
    box.innerHTML = '';
    box.classList.toggle('has', roots.length > 0);
    roots.forEach((r) => {
        box.appendChild(el('span', { class: 'chip extra-chip', title: r.path },
            el('span', { class: 'ms', text: 'folder_open' }),
            el('span', { class: 'extra-alias', text: 'extra:' + r.alias }),
            el('button', { class: 'btn-icon btn-xs extra-x ms', text: 'close', type: 'button',
                title: t('ws.extraRemoved', { alias: r.alias }),
                onclick: () => removeExtraRoot(r.alias) })
        ));
    });
    const btn = $('chat-extra');
    if (btn) btn.classList.toggle('active', roots.length > 0);
}

async function persistExtraRoots() {
    const roots = extraRoots();
    OC.cfg.activeExtraRoots = roots.map(r => ({ alias: r.alias, path: r.path }));
    // 有對話內容才落盤會話；空會話的掛載只活在記憶體＋後端（開新會話會清空）
    if ((OC.session.messages || []).length) {
        try { await window.saveSession?.(); } catch (e) { console.warn('[extra] 會話存檔失敗', e.message); }
    }
    window.refreshSessionList?.(true);
    renderExtraRoots();
}

async function addExtraRoot(alias, path) {
    alias = String(alias || '').trim();
    path = String(path || '').trim();
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(alias)) { toast(t('ws.extraAliasPh'), 'warn'); return false; }
    if (!path) return false;
    const roots = extraRoots();
    if (roots.some(r => r.alias.toLowerCase() === alias.toLowerCase())) {
        toast(t('ws.extraDupAlias', { alias }), 'warn');
        return false;
    }
    if (roots.length >= EXTRA_MAX) { toast(t('ws.extraMax', { n: EXTRA_MAX }), 'warn'); return false; }
    try {
        const r = await SETTINGS.extraAdd(alias, path);
        const savedAlias = r.alias || alias;
        const saved = (r.roots || []).find(x => String(x.alias || '').toLowerCase() === String(savedAlias).toLowerCase());
        // 同一路徑已掛在別的 alias 下：後端回現況，直接同步回來就好
        if (saved && !roots.some(x => x.alias.toLowerCase() === String(saved.alias).toLowerCase())) {
            roots.push({ alias: String(saved.alias), path: String(saved.path) });
        } else if (!roots.some(x => x.alias.toLowerCase() === String(savedAlias).toLowerCase())) {
            roots.push({ alias: String(savedAlias), path: String(saved?.path || path) });
        }
        await persistExtraRoots();
        toast(t('ws.extraAdded', { alias: savedAlias, ws: saved?.path || path }), 'success');
        return true;
    } catch (e) {
        toast(t('ws.extraAddFail', { msg: e.message }), 'error');
        return false;
    }
}

async function removeExtraRoot(alias) {
    try {
        const r = await SETTINGS.extraRemove(alias);
        OC.session.extraRoots = (r.roots || []).map(x => ({ alias: String(x.alias), path: String(x.path) }));
        await persistExtraRoots();
        toast(t('ws.extraRemoved', { alias }), 'success', 2000);
        return true;
    } catch (e) {
        toast(t('ws.extraRmFail', { msg: e.message }), 'error');
        return false;
    }
}

// 額外資料夾選擇器：重用工作區選擇器的磁碟瀏覽（browse 不受工作區限制）
let _extraBrowsePath = '';

function openExtraPicker() {
    _extraBrowsePath = OC.ws || '';
    renderExtraBrowser();
    openModal('modal-extra');
}

async function renderExtraBrowser() {
    const body = $('modal-extra-body');
    if (!body) return;
    $('modal-extra-title').textContent = t('ws.extraT');
    body.innerHTML = `<div class="ws-loading"><span class="spinner"></span> ${esc(t('ws.loading'))}</div>`;
    let r;
    try { r = await SETTINGS.browse(_extraBrowsePath); }
    catch (e) { body.innerHTML = `<div class="ws-err">${esc(e.message)}</div>`; return; }

    const roots = extraRoots();
    const drives = (r.drives || []).map(d =>
        `<button class="chip ws-drive" data-path="${esc(d.path)}">${esc(d.name)}</button>`).join('');
    const dirs = (r.dirs || []).map(d =>
        `<button class="ws-dir" data-path="${esc(d.path)}">
            <span class="ms">folder</span><span>${esc(d.name)}</span></button>`).join('')
        || `<div class="ws-empty">${esc(t('ws.empty'))}</div>`;
    const mounted = roots.length
        ? `<div class="ws-section"><div class="ws-label">${esc(t('ws.extraT'))}（${roots.length}/${EXTRA_MAX}）</div>
           <div class="ws-recents">${roots.map(x =>
               `<span class="chip extra-chip" title="${esc(x.path)}">extra:${esc(x.alias)}</span>`).join('')}</div></div>`
        : `<div class="ws-empty">${esc(t('ws.extraEmpty'))}</div>`;

    body.innerHTML = `
      ${mounted}
      <div class="ws-section">
        <div class="ws-label">${esc(t('ws.drives'))}</div>
        <div class="ws-drives">${drives}</div>
      </div>
      <div class="ws-crumb">
        ${r.parent ? `<button class="btn-icon btn-xs ms" id="extra-up" title="${esc(t('ws.up'))}">arrow_upward</button>` : ''}
        <input class="inp inp-sm" id="extra-manual" value="${esc(r.cwd || '')}" placeholder="${esc(t('ws.manualPh'))}">
        <button class="btn btn-xs btn-ghost" id="extra-goto">${esc(t('common.go'))}</button>
      </div>
      <div class="ws-dirs">${dirs}</div>
      <div class="ws-section">
        <div class="ws-label">${esc(t('ws.extraAdd'))}</div>
        <div class="ws-crumb">
          <input class="inp inp-sm" id="extra-alias" placeholder="${esc(t('ws.extraAliasPh'))}" style="max-width:190px">
          <code id="extra-pick-path" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.cwd || '')}</code>
        </div>
      </div>
      <div class="hint">${esc(t('ws.extraHow'))}</div>`;

    $$('.ws-drive, .ws-dir', body).forEach(b => b.addEventListener('click', async () => {
        _extraBrowsePath = b.dataset.path;
        await renderExtraBrowser();
    }));
    $('extra-up')?.addEventListener('click', async () => { _extraBrowsePath = r.parent; await renderExtraBrowser(); });
    $('extra-goto')?.addEventListener('click', async () => { _extraBrowsePath = $('extra-manual').value.trim(); await renderExtraBrowser(); });
    $('extra-manual')?.addEventListener('keydown', async e => {
        if (e.key === 'Enter') { e.preventDefault(); _extraBrowsePath = e.target.value.trim(); await renderExtraBrowser(); }
    });

    const acts = $('modal-extra-actions');
    acts.innerHTML = '';
    acts.appendChild(el('button', { class: 'btn btn-ghost', text: t('common.cancel'), onclick: () => closeModal('modal-extra') }));
    acts.appendChild(el('button', {
        class: 'btn btn-primary', text: t('ws.extraAdd'),
        onclick: async () => {
            const ok = await addExtraRoot($('extra-alias').value, r.cwd);
            if (ok) { closeModal('modal-extra'); openExtraPicker(); }
        },
    }));
}

function wireExtraButton() {
    $('chat-extra')?.addEventListener('click', () => openExtraPicker());
}

// ═══════════════════════════════════════════════════════════════
// API Key Modal
// ═══════════════════════════════════════════════════════════════

function openKeysModal() {
    let html = `<div class="keys-note">
        <span class="ms">lock</span>
        <div>${t('keys.note')}</div>
    </div>`;
    for (const [pid, p] of Object.entries(API_CONFIG.providers)) {
        const saved = localStorage.getItem(p.keyName) || '';
        const note = (typeof t === 'function' ? t('prov.note.' + pid) : '') || p.keyNote || '';
        const noteShown = note && !note.startsWith('prov.note.') ? note : (p.keyNote || '');
        html += `
        <div class="ig">
            <label>${esc(p.label)} <span class="dim">${esc(noteShown)}</span></label>
            <div class="key-row">
                <input type="password" id="key-${pid}" class="inp" placeholder="${esc(p.keyPlaceholder)}" value="${esc(saved)}">
                <button type="button" class="btn-icon ms key-eye" data-for="key-${pid}" title="${esc(t('keys.show'))}">visibility</button>
            </div>
            <div class="hint">${esc(t('keys.get'))}<a href="${esc(p.keyUrl)}" target="_blank" rel="noopener">${esc(p.keyUrlText)}</a></div>
        </div>`;
    }
    $('modal-keys-body').innerHTML = html;
    $$('.key-eye', $('modal-keys-body')).forEach(b => b.addEventListener('click', () => {
        const i = $(b.dataset.for);
        i.type = i.type === 'password' ? 'text' : 'password';
        b.textContent = i.type === 'password' ? 'visibility' : 'visibility_off';
    }));
    const acts = $('modal-keys-actions');
    acts.innerHTML = '';
    acts.appendChild(el('button', { class: 'btn btn-ghost', text: t('common.cancel'), onclick: () => closeModal('modal-keys') }));
    acts.appendChild(el('button', {
        class: 'btn btn-primary', text: t('common.save'),
        onclick: () => {
            for (const pid of Object.keys(API_CONFIG.providers)) {
                setProviderKey(pid, $('key-' + pid)?.value?.trim() || '');
            }
            closeModal('modal-keys');
            renderModelSelect();
            toast(t('keys.saved'), 'success');
        },
    }));
    openModal('modal-keys');
}

// ═══════════════════════════════════════════════════════════════
// 工作區選擇器
// ═══════════════════════════════════════════════════════════════

let _wsBrowsePath = '';

async function openWorkspacePicker() {
    _wsBrowsePath = OC.ws || '';
    await renderWorkspaceBrowser();
    openModal('modal-workspace');
}

async function renderWorkspaceBrowser() {
    const body = $('modal-workspace-body');
    body.innerHTML = `<div class="ws-loading"><span class="spinner"></span> ${esc(t('ws.loading'))}</div>`;
    let r;
    try { r = await SETTINGS.browse(_wsBrowsePath); }
    catch (e) { body.innerHTML = `<div class="ws-err">${esc(e.message)}</div>`; return; }

    const recents = (OC.cfg.recentWorkspaces || []).slice(0, 8);
    const drives = (r.drives || []).map(d =>
        `<button class="chip ws-drive" data-path="${esc(d.path)}">${esc(d.name)}</button>`).join('');
    const dirs = (r.dirs || []).map(d =>
        `<button class="ws-dir" data-path="${esc(d.path)}">
            <span class="ms">folder</span><span>${esc(d.name)}</span></button>`).join('')
        || `<div class="ws-empty">${esc(t('ws.empty'))}</div>`;

    body.innerHTML = `
      ${recents.length ? `<div class="ws-section"><div class="ws-label">${esc(t('ws.recents'))}</div>
        <div class="ws-recents">${recents.map(p =>
            `<button class="chip ws-recent" data-pick="${esc(p)}">${esc(p)}</button>`).join('')}</div></div>` : ''}
      <div class="ws-section">
        <div class="ws-label">${esc(t('ws.drives'))}</div>
        <div class="ws-drives">${drives}</div>
      </div>
      <div class="ws-crumb">
        ${r.parent ? `<button class="btn-icon btn-xs ms" id="ws-up" title="${esc(t('ws.up'))}">arrow_upward</button>` : ''}
        <input class="inp inp-sm" id="ws-manual" value="${esc(r.cwd || '')}" placeholder="${esc(t('ws.manualPh'))}">
        <button class="btn btn-xs btn-ghost" id="ws-goto">${esc(t('common.go'))}</button>
      </div>
      <div class="ws-dirs">${dirs}</div>
      <div class="ws-current">${esc(t('ws.setTo'))}<code>${esc(r.cwd || t('ws.notYet'))}</code></div>
      <div class="hint">${esc(t('ws.warn'))}</div>`;

    $$('.ws-drive, .ws-dir', body).forEach(b => b.addEventListener('click', async () => {
        _wsBrowsePath = b.dataset.path;
        await renderWorkspaceBrowser();
    }));
    $$('.ws-recent', body).forEach(b => b.addEventListener('click', () => applyWorkspace(b.dataset.pick, { keepSession: true })));
    $('ws-up')?.addEventListener('click', async () => { _wsBrowsePath = r.parent; await renderWorkspaceBrowser(); });
    $('ws-goto')?.addEventListener('click', async () => { _wsBrowsePath = $('ws-manual').value.trim(); await renderWorkspaceBrowser(); });
    $('ws-manual')?.addEventListener('keydown', async e => {
        if (e.key === 'Enter') { e.preventDefault(); _wsBrowsePath = e.target.value.trim(); await renderWorkspaceBrowser(); }
    });

    const acts = $('modal-workspace-actions');
    acts.innerHTML = '';
    acts.appendChild(el('button', { class: 'btn btn-ghost', text: t('common.cancel'), onclick: () => closeModal('modal-workspace') }));
    acts.appendChild(el('button', {
        class: 'btn btn-primary', text: t('ws.set'),
        onclick: () => applyWorkspace(r.cwd, { keepSession: true }),
    }));
}

// keepSession:true 由工作區選擇器（設定面板／頂列）使用：
// 使用者只是把「目前這個對話」搬到另一個路徑，對話保留，
// 會話的 ws 改記新路徑並存檔（否則下次存檔還是舊 ws，切回來又跳回去）。
// 省略時維持舊行為（開新對話），供 loadSession／setMode 等流程使用。
async function applyWorkspace(path, { keepSession = false } = {}) {
    if (!path) return;
    // 選到跟目前相同的路徑就什麼都不做（大小寫不敏感，見 sessions.js）
    if (typeof _sameWs === 'function' && _sameWs(path, OC.ws || OC.cfg.workspace || '')) {
        closeModal('modal-workspace');
        return;
    }
    try {
        const r = await SETTINGS.setWorkspace(path);
        OC.ws = r.workspace;
        OC.cfg.workspace = r.workspace;
        OC.cfg.recentWorkspaces = r.recentWorkspaces || [];
        closeModal('modal-workspace');
        renderWorkspaceLabel();
        // 換路徑一律重載專案上下文：清空快取與檔案樹
        OC.readCache = {};
        OC.tree = {};
        // 必須逐一 await：closeFileTab 對未存檔的檔案會開 confirmModal，
        // 同時觸發多個對話框會互相蓋掉，剩下的 Promise 永遠不結算。
        for (const f of OC.openFiles.slice()) {
            try { await window.closeFileTab?.(f.path); } catch { /* 使用者取消就跳過 */ }
        }
        await Promise.allSettled([
            window.refreshFileTree?.(),
            loadOmniMd(true), loadMemories(true), loadSkills(true),
        ]);
        refreshGitInfo?.();
        if (keepSession) {
            if ((OC.session.messages || []).length) {
                OC.session.ws = OC.ws;
                await window.saveSession?.();
            }
            window.refreshSessionList?.(true);   // 「其他工作區」標籤重算
        } else {
            // 換工作區 = 換專案：開新對話
            await window.newSession?.({ silent: true });
        }
        toast(t('ws.switched', { ws: r.workspace }), 'success');
    } catch (e) {
        toast(t('ws.switchFail', { msg: e.message }), 'error');
    }
}

// ═══════════════════════════════════════════════════════════════
// 設定面板
// ═══════════════════════════════════════════════════════════════

function renderSettingsPanel() {
    const slot = $('settings-body');
    if (!slot) return;
    const c = OC.cfg;
    const loc = (typeof oc_locale === 'function' ? oc_locale() : 'en');
    const langOpts = (window.OC_LOCALES || []).map(l =>
        `<option value="${l.id}"${loc === l.id ? ' selected' : ''}>${esc(l.label)}</option>`).join('');
    // 外殼跟模型管理面板同構：靜態頭＋hero＋可捲清單（見 modelsHost）
    slot.innerHTML = `
      <div class="panel-head">
        <span class="panel-title"><span class="ms">settings</span><span>${esc(t('panel.settings'))}</span></span>
        <div class="panel-head-acts">
          <button class="btn-icon" id="set-doctor-top" title="${esc(t('settings.doctor'))}"><span class="ms">monitor_heart</span></button>
        </div>
      </div>
      <div class="mdl-current" id="set-hero">
        <div class="mdl-cur-lab">${esc(t('settings.heroK'))}</div>
        <div class="set-hero-row">
          <span class="ms set-hero-ico">tune</span>
          <div class="set-hero-txt">
            <div class="set-hero-t">${esc(t('settings.heroT'))}</div>
            <div class="set-hero-d">${esc(t('settings.heroD'))}</div>
          </div>
        </div>
        <div class="ig set-lang-row">
          <label>${esc(t('settings.lang'))} <span class="dim">${esc(t('settings.langHint'))}</span></label>
          <select id="set-locale" class="sel sel-sm">${langOpts}</select>
        </div>
      </div>
      <div class="panel-body"><div class="mdl-list" id="set-cards">

      <div class="mdl-group"><span>${esc(t('settings.secWs'))}</span></div>
      <div class="card mdl-item">
        <div class="set-row"><code class="set-path">${esc(OC.ws)}</code></div>
        <div class="mdl-acts">
          <button class="btn btn-xs btn-ghost" id="set-ws"><span class="ms">folder_open</span><span>${esc(t('settings.wsChange'))}</span></button>
        </div>
      </div>

      <div class="mdl-group"><span>${esc(t('settings.secAgent'))}</span></div>
      <div class="card mdl-item">
        <div class="ig">
          <label>${esc(t('settings.compact'))} <span class="dim">${esc(t('settings.compactHint'))}</span></label>
          <div class="set-slider">
            <input type="range" id="set-compact" min="40" max="90" step="5" value="${Math.round((c.autoCompactAt || 0.75) * 100)}">
            <span id="set-compact-val">${Math.round((c.autoCompactAt || 0.75) * 100)}%</span>
          </div>
        </div>
        <div class="ig">
          <label>${esc(t('settings.turns'))} <span class="dim">${esc(t('settings.turnsHint'))}</span></label>
          <input type="number" id="set-turns" class="inp inp-sm" min="1" max="200" value="${c.maxTurns || 40}">
        </div>
        <div class="ig">
          <label>${esc(t('settings.effort'))} <span class="dim">${esc(t('settings.effortHint'))}</span></label>
          <select id="set-effort" class="sel sel-sm">
            ${API_CONFIG.effort.order.map(k => {
              const L = API_CONFIG.effort.levels[k];
              return `<option value="${k}"${(c.effortLevel || API_CONFIG.effort.default) === k ? ' selected' : ''}>${esc(L.label)} — ${esc(t('effort.h_' + k))}</option>`;
            }).join('')}
          </select>
        </div>
        <div class="ig">
          <label>${esc(t('settings.mode'))} <span class="dim">${esc(t('settings.modeHint'))}</span></label>
          <select id="set-mode" class="sel sel-sm">
            ${PERM_ORDER.map(k => {
              const M = (window.permModeMeta ? permModeMeta(k) : null) || window.PERM_MODES[k];
              return `<option value="${k}"${(c.permissionMode || 'default') === k ? ' selected' : ''}>${esc(M.glyph)} ${esc(M.label)} — ${esc(M.desc)}</option>`;
            }).join('')}
          </select>
        </div>
        <div class="ig ig-check">
          <label><input type="checkbox" id="set-autoverify"${c.autoVerify !== false ? ' checked' : ''}>
            ${esc(t('settings.autoverify'))} <span class="dim">${esc(t('settings.autoverifyHint'))}</span></label>
        </div>
        <div class="ig ig-check">
          <label><input type="checkbox" id="set-entry-ask"${(() => { try { return localStorage.getItem('oc_entry_skip') === '1' ? '' : ' checked'; } catch { return ' checked'; } })()}>
            ${esc(t('settings.entryAsk'))} <span class="dim">${esc(t('settings.entryAskHint'))}</span></label>
        </div>
        <div class="ig">
          <label>${esc(t('settings.transport'))}</label>
          <select id="set-transport" class="sel sel-sm">
            <option value="direct"${c.transport === 'direct' ? ' selected' : ''}>${esc(t('settings.transportDirect'))}</option>
            <option value="relay"${c.transport === 'relay' ? ' selected' : ''}>${esc(t('settings.transportRelay'))}</option>
          </select>
        </div>
      </div>

      <div class="mdl-group"><span>${esc(t('settings.secRules'))}</span></div>
      <div class="card mdl-item">
        <div class="ig">
          <label>${esc(t('settings.allow'))} <span class="dim">${esc(t('settings.allowHint'))}</span></label>
          <textarea id="set-allow" class="ta ta-sm" rows="3">${esc((c.allowRules || []).join('\n'))}</textarea>
        </div>
        <div class="ig">
          <label>${esc(t('settings.deny'))}</label>
          <textarea id="set-deny" class="ta ta-sm" rows="2">${esc((c.denyRules || []).join('\n'))}</textarea>
        </div>
        <div class="mdl-acts">
          <button class="btn btn-xs btn-ghost" id="set-save-rules"><span class="ms">save</span><span>${esc(t('settings.rulesSave'))}</span></button>
        </div>
        <div class="hint">${esc(t('settings.rulesHint'))}</div>
      </div>

      <div class="mdl-group"><span>${esc(t('settings.secSentinel'))}</span><span class="mdl-group-n">${esc(t('settings.secSentinelHint'))}</span></div>
      <div class="card mdl-item">
        <div class="ig ig-check">
          <label><input type="checkbox" id="set-sentinel"${c.sentinel !== false ? ' checked' : ''}>
            ${esc(t('settings.sentinel'))} <span class="dim">${esc(t('settings.sentinelHint'))}</span></label>
        </div>
        <div class="ig ig-check">
          <label><input type="checkbox" id="set-sentinel-net"${c.sentinelNetAsk !== false ? ' checked' : ''}>
            ${esc(t('settings.sentinelNet'))} <span class="dim">${esc(t('settings.sentinelNetHint'))}</span></label>
        </div>
        <div class="ig">
          <label>${esc(t('settings.scope'))} <span class="dim">${esc(t('settings.scopeHint'))}</span></label>
          <textarea id="set-scope" class="ta ta-sm" rows="2">${esc(Object.entries(c.scopeRules || {}).map(([k, v]) => k + '=' + v).join('\n'))}</textarea>
        </div>
        <div class="mdl-acts">
          <button class="btn btn-xs btn-ghost" id="set-save-sentinel"><span class="ms">shield</span><span>${esc(t('settings.sentinelSave'))}</span></button>
        </div>
      </div>

      <div class="mdl-group"><span>${esc(t('settings.secVault'))}</span><span class="mdl-group-n">${esc(t('settings.secVaultHint'))}</span></div>
      <div class="card mdl-item">
        <div class="hint">${t('settings.vaultHint')}</div>
        <div class="ig">
          <label>${esc(t('settings.vaultCode'))}</label>
          <input id="set-vault-key" class="inp inp-sm" placeholder="${esc(t('settings.vaultCodePh'))}">
        </div>
        <div class="mdl-acts">
          <button class="btn btn-xs btn-ghost" id="set-vault-save"><span class="ms">lock</span><span>${esc(t('settings.vaultSave'))}</span></button>
          <button class="btn btn-xs btn-ghost" id="set-vault-list"><span class="ms">refresh</span><span>${esc(t('common.refresh'))}</span></button>
        </div>
        <div id="set-vault-keys" class="hint">${esc(t('settings.hooksLoading'))}</div>
      </div>

      <div class="mdl-group"><span>${esc(t('settings.secPrivacy'))}</span></div>
      <div class="card mdl-item">
        <div class="ig ig-check">
          <label><input type="checkbox" id="set-privacy-train"${c.privacyTrain ? ' checked' : ''}>
            ${esc(t('settings.train'))} <span class="dim">${esc(t('settings.trainHint'))}</span></label>
        </div>
        <div class="hint">${t('settings.memHint')}</div>
      </div>

      <div class="mdl-group"><span>${esc(t('settings.secHooks'))}</span></div>
      <div class="card mdl-item" id="set-hooks-group">
        <div id="set-hooks-body" class="hint">${esc(t('settings.hooksLoading'))}</div>
      </div>

      <div class="mdl-group"><span>${esc(t('settings.secEnv'))}</span></div>
      <div class="card mdl-item">
        <div class="set-kv"><span>${esc(t('settings.envPhp'))}</span><span>${esc(OC.env.php || '?')}</span></div>
        <div class="set-kv"><span>${esc(t('settings.envOs'))}</span><span>${esc(OC.env.os || '?')}</span></div>
        <div class="set-kv"><span>${esc(t('settings.envWritable'))}</span><span>${OC.env.workspace_writable ? '✅' : '❌'}</span></div>
        <div class="set-kv"><span>${esc(t('settings.envCurl'))}</span><span>${OC.env.curl ? '✅' : '❌'}</span></div>
        <div class="mdl-acts">
          <button class="btn btn-xs btn-ghost" id="set-doctor"><span class="ms">monitor_heart</span><span>${esc(t('settings.doctor'))}</span></button>
        </div>
      </div>

      <div class="mdl-group"><span>${esc(t('settings.secAbout'))}</span></div>
      <div class="card mdl-item">
        <div class="hint">${t('settings.aboutBody', { ver: esc(window.OC_VERSION || '1.0'), php: esc(OC.env.php || '') })}</div>
      </div>

      </div></div>`;

    $('set-ws')?.addEventListener('click', () => openWorkspacePicker());
    $('set-compact')?.addEventListener('input', e => {
        $('set-compact-val').textContent = e.target.value + '%';
        OC.cfg.autoCompactAt = parseInt(e.target.value, 10) / 100;
        SETTINGS.set({ autoCompactAt: OC.cfg.autoCompactAt }).catch(() => {});
    });
    $('set-turns')?.addEventListener('change', e => {
        OC.cfg.maxTurns = Math.max(1, Math.min(200, parseInt(e.target.value, 10) || 40));
        SETTINGS.set({ maxTurns: OC.cfg.maxTurns }).catch(() => {});
    });
    $('set-transport')?.addEventListener('change', e => {
        OC.cfg.transport = e.target.value;
        SETTINGS.set({ transport: OC.cfg.transport }).catch(() => {});
    });
    window.loadHooks?.().then(() => renderHooksSection());
    $('set-locale')?.addEventListener('change', async e => {
        const loc = e.target.value;
        const ok = await window.setLocale?.(loc, { save: true, rerender: false });
        if (ok) {
            const lab = (window.OC_LOCALES || []).find(l => l.id === loc)?.label || loc;
            renderSettingsPanel();
            try { window.applyChromeI18n?.(); } catch {}
            toast(t('settings.langDone', { label: lab }), 'success', 2500);
        }
    });
    $('set-effort')?.addEventListener('change', e => setEffortLevel(e.target.value));
    $('set-mode')?.addEventListener('change', e => setPermissionMode(e.target.value));
    $('set-entry-ask')?.addEventListener('change', e => {
        // 純瀏覽器偏好，跟入口 modal 裡的「下次不再詢問」是同一個開關
        try { if (e.target.checked) localStorage.removeItem('oc_entry_skip'); else localStorage.setItem('oc_entry_skip', '1'); } catch {}
        toast(e.target.checked ? t('settings.entryAskOn') : t('settings.entryAskOff'), 'success', 2500);
    });
    $('set-autoverify')?.addEventListener('change', e => {
        OC.cfg.autoVerify = e.target.checked;
        SETTINGS.set({ autoVerify: OC.cfg.autoVerify }).catch(() => {});
        toast(e.target.checked ? t('settings.autoverifyOn') : t('settings.autoverifyOff'), 'info');
    });
    $('set-save-rules')?.addEventListener('click', async () => {
        const split = v => v.split('\n').map(s => s.trim()).filter(Boolean);
        OC.cfg.allowRules = split($('set-allow').value);
        OC.cfg.denyRules = split($('set-deny').value);
        try {
            await SETTINGS.set({ allowRules: OC.cfg.allowRules, denyRules: OC.cfg.denyRules });
            toast(t('settings.rulesDone'), 'success');
        } catch (e) { toast(t('common.saveFail', { msg: e.message }), 'error'); }
    });
    $('set-sentinel')?.addEventListener('change', e => {
        OC.cfg.sentinel = e.target.checked;
        SETTINGS.set({ sentinel: OC.cfg.sentinel }).catch(() => {});
        toast(e.target.checked ? t('settings.sentinelOn') : t('settings.sentinelOff'), e.target.checked ? 'info' : 'warn');
    });
    $('set-sentinel-net')?.addEventListener('change', e => {
        OC.cfg.sentinelNetAsk = e.target.checked;
        SETTINGS.set({ sentinelNetAsk: OC.cfg.sentinelNetAsk }).catch(() => {});
    });
    $('set-save-sentinel')?.addEventListener('click', async () => {
        const sr = {};
        String($('set-scope').value || '').split('\n').map(s => s.trim()).filter(Boolean).forEach(line => {
            const m = line.match(/^(.+?)=(\w+)$/);
            if (m && ['allow', 'ask', 'deny'].includes(m[2].toLowerCase())) sr[m[1].trim()] = m[2].toLowerCase();
        });
        OC.cfg.scopeRules = sr;
        try {
            await SETTINGS.set({ scopeRules: sr });
            toast(t('settings.sentinelDone'), 'success');
        } catch (e) { toast(t('common.saveFail', { msg: e.message }), 'error'); }
    });
    const refreshVaultKeys = async () => {
        const box = $('set-vault-keys');
        if (!box) return;
        try {
            const r = await VAULT.list();
            const keys = r.keys || [];
            box.innerHTML = keys.length
                ? esc(t('settings.vaultHas')) + keys.map(k => `<code>{{VAULT:${esc(k)}}}</code>`).join('、')
                : esc(t('settings.vaultEmpty'));
        } catch (e) { box.textContent = t('settings.vaultReadFail', { msg: e.message }); }
    };
    refreshVaultKeys();
    $('set-vault-list')?.addEventListener('click', refreshVaultKeys);
    $('set-vault-save')?.addEventListener('click', async () => {
        const key = String($('set-vault-key').value || '').trim();
        if (!key) { toast(t('settings.vaultNeedCode'), 'warn'); return; }
        // 值走密碼框，不進設定面板的任何可見欄位
        const v = await promptModal(t('settings.vaultTitle', { k: key }), t('settings.vaultLab'), '', {
            type: 'password', okText: t('settings.vaultOk'),
            hint: t('settings.vaultLabHint'),
        });
        if (v === null) return;
        try {
            await VAULT.set(key, v);
            $('set-vault-key').value = '';
            await refreshVaultKeys();
            toast(v === '' ? t('settings.vaultDel', { k: key }) : t('settings.vaultSet', { k: key }), 'success');
        } catch (e) { toast(t('settings.vaultSaveFail', { msg: e.message }), 'error', 6000); }
    });
    $('set-privacy-train')?.addEventListener('change', e => {
        OC.cfg.privacyTrain = e.target.checked;
        SETTINGS.set({ privacyTrain: OC.cfg.privacyTrain }).catch(() => {});
        toast(e.target.checked ? t('settings.trainOn') : t('settings.trainOff'), 'info');
    });
    $('set-doctor')?.addEventListener('click', () => window.handleSlash?.('/doctor'));
    $('set-doctor-top')?.addEventListener('click', () => window.handleSlash?.('/doctor'));
}

// ═══════════════════════════════════════════════════════════════
// 全域錯誤處理
// ═══════════════════════════════════════════════════════════════

function wireGlobalErrors() {
    window.addEventListener('error', (e) => {
        if (!OC.ready) return;
        // 忽略 CDN 資源載入失敗（已有降級處理）
        if (e.target && e.target !== window) return;
        errorTicker('發生未預期的錯誤', `${e.message}\n${e.filename}:${e.lineno}`);
    });
    window.addEventListener('unhandledrejection', (e) => {
        if (!OC.ready) return;
        const m = e.reason?.message || String(e.reason);
        if (/AbortError/.test(m)) return;
        errorTicker('未處理的錯誤', m);
    });
    window.addEventListener('beforeunload', (e) => {
        const dirty = OC.openFiles.filter(f => f.dirty);
        if (dirty.length) {
            e.preventDefault();
            e.returnValue = `有 ${dirty.length} 個檔案尚未儲存`;
            return e.returnValue;
        }
    });
}

Object.assign(window, {
    boot, switchPanel, switchDock, toggleSide, toggleChat, toggleChatWide, toggleDock, openPreview,
    setModel, renderModelButton, renderPermButton, renderWorkspaceLabel,
    openKeysModal, openWorkspacePicker, applyWorkspace, renderSettingsPanel,
    addAttachment, renderAttachments,
    openExtraPicker, renderExtraRoots, addExtraRoot, removeExtraRoot, extraRoots,
});

document.addEventListener('DOMContentLoaded', boot);
