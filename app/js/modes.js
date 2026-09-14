'use strict';
// ═══════════════════════════════════════════════════════════════
// Omni Code — 使用模式（專案項目 / AI 對話 / 自我提升）
// ═══════════════════════════════════════════════════════════════
// 三種模式差在「Agent 面對的是什麼」：
//
//   project  針對工作路徑做專案生成與修改（原本的 Omni Code）
//   chat     通用問答。不綁定工作路徑、不讀寫檔案、不跑命令；
//            只留上網查資料、生圖、記憶這些跟專案無關的能力。
//   self     以 Omni Code 自己的安裝目錄為工作區，透過對話優化自身功能。
//            每一次改動都會寫進 data/selfimprove/state.json 的歷程，
//            並掛在語意化版本的規劃之下。
//
// 每個會話都記著它的 mode，對話紀錄依模式分開列；切模式 = 開新會話。
// 模式本身存在 localStorage（純 UI 偏好，不進 config.json）。
//
// ★ 自我提升的工作區切換是「借用」不是「覆蓋」：
//   進入時記下原本的工作區，離開時切回去。使用者的專案設定不該因為
//   點了一下自我提升就被改掉。
// ═══════════════════════════════════════════════════════════════

// MODES 留英文保底（modes.js 比 i18n.js 早載入，直接呼叫 t() 會炸）；
// 顯示層一律走 modeLabelOf() / modeDescOf()，跟著介面語系。
const MODES = {
    project: { label: 'Project', icon: 'folder_code',      desc: 'Generate and edit code in the workspace' },
    chat:    { label: 'AI chat',  icon: 'forum',            desc: 'General Q&A, no workspace, no file access' },
    self:    { label: 'Self-improve', icon: 'self_improvement', desc: 'Use Omni Code\u2019s own source as workspace, improve itself' },
};

// 模式顯示標籤走 cfgmode.*（跟著介面語系；MODES 只留英文保底，因為 modes.js 在 i18n.js 之前載入也能跑）
function modeLabelOf(mode) {
    if (mode === 'chat') return (typeof t === 'function' ? t('cfgmode.chatL') : null) || MODES.chat.label;
    if (mode === 'self') return (typeof t === 'function' ? t('cfgmode.selfL') : null) || MODES.self.label;
    return (typeof t === 'function' ? t('cfgmode.projectL') : null) || MODES.project.label;
}
function modeDescOf(mode) {
    if (mode === 'chat') return (typeof t === 'function' ? t('cfgmode.chatD') : null) || MODES.chat.desc;
    if (mode === 'self') return (typeof t === 'function' ? t('cfgmode.selfD') : null) || MODES.self.desc;
    return (typeof t === 'function' ? t('cfgmode.projectD') : null) || MODES.project.desc;
}

// chat 模式只留這些工具 —— 跟工作區完全無關的能力
// read_image / edit_image 吃的是工作區路徑，這裡沒有工作區 —— 圖片一律走對話附件。
const CHAT_TOOLS = new Set([
    'web_fetch', 'web_search', 'todo_write', 'remember', 'read_memory', 'forget_memory',
    'search_sessions', 'generate_image',
    'skill', 'ask_user', 'present_task', 'remember_error',
]);

const CHAT_IDENTITY = `你是 Omni Code 的「AI 對話」模式 —— 一個通用的 AI 助理。
這個模式不綁定任何專案或工作路徑：你不會讀寫檔案、不會執行命令、看不到任何程式碼。
使用者來這裡是為了問問題、討論想法、寫文章、翻譯、分析資料、查資料、生成圖片。

【行為準則】
1. 回覆語言見本輪【回覆語言】一節（跟著使用者的介面語系走）。程式碼、指令、識別字保持原文。
2. 直接回答，不要問「要我幫你做嗎」。答案有多種可能時給出你的建議，再列其他選項。
3. 絕不臆造。不確定的事實就用 web_search 查證後再答，並說明來源。
4. 需要程式碼時直接寫完整可跑的版本，不要只給片段。
5. 使用者表達偏好或糾正你時，用 remember 存下來（連同原因）。
6. 使用者若提到要改某個專案的檔案，告訴他們切換到「專案項目」模式（頂列的資料夾按鈕）。

你的記憶與技能在不同模式之間是共用的。`;

const SELF_IDENTITY = `
═══ 自我提升模式 ═══
你現在的工作區就是 Omni Code 自己的原始碼。使用者要跟你一起改進「你自己」。

【這個模式的鐵則】
1. 動手前先讀 docs/ARCHITECTURE.md 相關章節。Omni Code 是零建置的原生 JS + PHP 8.2，
   沒有 npm、沒有 bundler、沒有 TypeScript、沒有 composer；PHP 只有 curl/json/mbstring/openssl。
   任何引入建置工具或新依賴的提案都不成立。
2. 改完必須 verify（php -l / node --check），並實際驗證行為。改壞自己等於使用者下次
   重新整理就打不開 —— 這比一般專案的風險高得多。
3. 每一次完成的改動，用 selfimprove_log 記錄：標題、摘要、動到的檔案、版本推進幅度
   （只修 bug = patch，新功能 = minor，架構性變動 = major）。這不是可選的。
   即使你忘了，系統也會兜底補記，但那樣會少掉摘要 —— 請自己記。
4. 使用者提出的需求若不是這一輪要做的，用 selfimprove_roadmap 排進未來版本，
   讓規劃留下來，不要只在對話裡答應。
5. 不要碰 data/ 底下的使用者資料（會話、設定、金鑰）。那是使用者的，不是你的。
6. 註解只寫「程式碼本身表達不了的約束」；用繁體中文；風格跟周圍的程式碼走。`;

// ─── 目前模式 ────────────────────────────────────────────────────
function currentMode() {
    return MODES[OC.mode] ? OC.mode : 'project';
}

function modeOfSession(s) {
    return MODES[s?.mode] ? s.mode : 'project';
}

/** 模式顯示名稱（跟著介面語系走） */
function modeName(mode) {
    if (mode === 'chat') return t('mode.chat');
    if (mode === 'self') return t('mode.self');
    return t('mode.project');
}

/** 切換模式。切換 = 存目前會話 → 換工作區（self 專用）→ 開新會話。 */
async function setMode(mode, { silent = false } = {}) {
    if (!MODES[mode]) return false;
    if (OC.running) { toast(t('common.runningBusy'), 'warn'); return false; }
    const prev = currentMode();
    if (prev === mode) { renderModeUI(); return true; }

    if ((OC.session.messages || []).length) await window.saveSession?.();

    // ── 工作區：進 self 借用安裝目錄，離開時還回去 ──
    if (mode === 'self') {
        const root = OC.env?.root || '';
        if (!root) { toast(t('plug.noRoot'), 'error'); return false; }
        if (OC.ws !== root) {
            OC._wsBeforeSelf = OC.ws;
            OC.mode = mode;                         // applyWorkspace 會開新會話，要先換好 mode 才會記對
            const ok = await _switchWorkspaceQuiet(root);
            if (!ok) { OC.mode = prev; return false; }
        } else {
            OC.mode = mode;
            await window.newSession?.({ silent: true });
        }
    } else {
        OC.mode = mode;
        if (prev === 'self' && OC._wsBeforeSelf && OC._wsBeforeSelf !== OC.ws) {
            const back = OC._wsBeforeSelf;
            OC._wsBeforeSelf = '';
            const ok = await _switchWorkspaceQuiet(back);
            if (!ok) await window.newSession?.({ silent: true });
        } else {
            await window.newSession?.({ silent: true });
        }
    }

    try { localStorage.setItem('oc_mode', mode); } catch {}
    renderModeUI();
    window.chatRenderAll?.();
    window.refreshSessionList?.(true);
    if (!silent) toast(t('mode.switched', { name: modeName(mode) }), 'success', 2200);
    return true;
}

// applyWorkspace 會 toast「工作區已切換」—— 模式切換時那句話是雜訊，包一層靜音
async function _switchWorkspaceQuiet(path) {
    const origToast = window.toast;
    let swallowed = false;
    window.toast = (msg, kind, ms) => {
        if (typeof isWsSwitchedMsg === 'function' ? isWsSwitchedMsg(msg) : String(msg).startsWith('Workspace switched')) { swallowed = true; return; }
        return origToast(msg, kind, ms);
    };
    try {
        await window.applyWorkspace?.(path);
        return OC.ws === path || OC.ws.toLowerCase() === path.toLowerCase();
    } finally { window.toast = origToast; }
}

/** 把模式反映到介面上 */
function renderModeUI() {
    const mode = currentMode();
    document.documentElement.dataset.mode = mode;
    $('oc-app')?.setAttribute('data-mode', mode);

    const chatBtn = $('mode-chat-btn');
    if (chatBtn) {
        chatBtn.classList.toggle('active', mode === 'chat');
        chatBtn.title = t('top.chatTitle');
    }
    const selfBtn = $('chat-self');
    if (selfBtn) {
        selfBtn.classList.toggle('active', mode === 'self');
        selfBtn.title = t('chat.self');
    }
    paintModeChrome();
}

/** 模式相關的字串（工作區提示／輸入框 placeholder／hint）—— 語系切換時重套 */
function paintModeChrome() {
    const mode = (typeof currentMode === 'function' ? currentMode() : 'project');
    const ws = $('ws-picker');
    if (ws) ws.title = mode === 'chat'
        ? t('chat.wsChat')
        : mode === 'self' ? t('chat.wsSelf') : t('top.wsTitle');

    const hint = document.querySelector('#oc-chat .chat-hint');
    if (hint) hint.textContent = mode === 'chat'
        ? t('chat.hintChat')
        : mode === 'self' ? t('chat.hintSelf') : t('chat.hintProject');

    const ico = document.querySelector('#oc-chat .chat-head-ico');
    if (ico) ico.textContent = MODES[mode].icon === 'folder_code' ? 'smart_toy' : MODES[mode].icon;

    const inp = $('chat-input');
    if (inp) inp.placeholder = mode === 'chat'
        ? t('chat.inputChat')
        : mode === 'self' ? t('chat.inputSelf')
        : t('chat.inputProject');
}

// ═══════════════════════════════════════════════════════════════
// 入口 modal（每次重新整理進入時詢問用途）
// ═══════════════════════════════════════════════════════════════
function entryChoices() {
    return [
        { id: 'chat',    icon: 'forum',       title: t('entry.chatT'), desc: t('entry.chatD') },
        { id: 'project', icon: 'folder_code', title: t('entry.projT'), desc: t('entry.projD') },
        { id: 'image',   icon: 'imagesmode',  title: t('entry.imgT'), desc: t('entry.imgD') },
    ];
}

function showEntryModal() {
    try { if (localStorage.getItem('oc_entry_skip') === '1') return false; } catch {}
    const box = $('modal-entry-body');
    if (!box) return false;
    box.innerHTML = '';
    const grid = el('div', { class: 'entry-grid' });
    for (const c of entryChoices()) {
        grid.appendChild(el('button', {
            class: 'entry-card', type: 'button', 'data-choice': c.id,
            onclick: () => pickEntry(c.id),
        },
            el('span', { class: 'ms entry-ico', text: c.icon }),
            el('span', { class: 'entry-title', text: c.title }),
            el('span', { class: 'entry-desc', text: c.desc }),
        ));
    }
    box.appendChild(grid);
    const skipRow = el('label', { class: 'entry-skip' });
    const cb = el('input', { type: 'checkbox', id: 'entry-skip-cb' });
    skipRow.appendChild(cb);
    skipRow.appendChild(el('span', { text: t('entry.skip') }));
    box.appendChild(skipRow);

    const m = $('modal-entry');
    if (m) m.dataset.noBackdropClose = '1';       // 一定要選一個；按 Esc 等於維持目前模式
    openModal('modal-entry', () => {});
    setTimeout(() => box.querySelector(`[data-choice="${currentMode() === 'self' ? 'project' : currentMode()}"]`)?.focus(), 80);
    return true;
}

async function pickEntry(id) {
    try { if ($('entry-skip-cb')?.checked) localStorage.setItem('oc_entry_skip', '1'); } catch {}
    closeModal('modal-entry');
    if (id === 'image') {
        if (currentMode() === 'chat') await setMode('project', { silent: true });
        window.openImageStudio?.();
        return;
    }
    await setMode(id, { silent: true });
    $('chat-input')?.focus();
}

// ═══════════════════════════════════════════════════════════════
// 自我提升：面板、系統提示、兜底記錄
// ═══════════════════════════════════════════════════════════════
let _selfState = null;        // 最近一次從後端拿到的 state
let _selfPromptCache = { updated: -1, text: '' };

async function loadSelfState(force = false) {
    if (_selfState && !force) return _selfState;
    try {
        const r = await SELF.get(60);
        _selfState = r.state || null;
    } catch (e) {
        console.warn('[self] 讀取歷程失敗', e.message);
    }
    return _selfState;
}

/** 注入系統提示的區塊：目前版本、未完成的規劃、最近歷程。 */
async function selfPromptSection() {
    const s = await loadSelfState(true);
    if (!s) return SELF_IDENTITY;
    if (_selfPromptCache.updated === (s.updated || 0)) return _selfPromptCache.text;

    const L = [SELF_IDENTITY, `\n【目前版本】${s.version}`];
    const open = (s.roadmap || []).filter(r => r.status !== 'released');
    if (open.length) {
        L.push('\n【版本規劃（未發布）】');
        for (const r of open) {
            const items = (r.items || []);
            const todo = items.filter(i => !i.done);
            L.push(`- v${r.version}${r.title ? ' ' + r.title : ''}（${r.status}，${items.length - todo.length}/${items.length} 完成）`);
            for (const i of todo.slice(0, 12)) L.push(`    ○ [${i.id}] ${i.text}${i.priority === 'high' ? '（高優先）' : ''}`);
        }
        L.push('完成規劃中的項目時，selfimprove_log 帶 roadmapItem 就會自動打勾。');
    } else {
        L.push('\n【版本規劃】還沒有未發布的版本規劃。可以用 selfimprove_roadmap 建立。');
    }
    const hist = (s.history || []).slice(0, 8);
    if (hist.length) {
        L.push('\n【最近的自我提升歷程】');
        for (const h of hist) {
            L.push(`- v${h.version} ${new Date(h.at).toLocaleDateString(typeof oc_date_locale === 'function' ? oc_date_locale() : 'en-US')}：${h.title}`
                + (h.files?.length ? `（${h.files.length} 個檔案）` : ''));
        }
    }
    const text = L.join('\n');
    _selfPromptCache = { updated: s.updated || 0, text };
    return text;
}

/** runAgent 結束後的兜底：self 模式下有動檔案、但模型沒自己記 → 補一筆 */
async function selfAfterRun({ filesBefore = 0 } = {}) {
    if (currentMode() !== 'self') return;
    const touched = [...new Set(OC.session.files_touched || [])];
    if (OC._selfLogged || touched.length <= filesBefore) return;
    try {
        await SELF.log({
            title: (OC.session.title || OC._turnLabel || '自我提升').slice(0, 120),
            summary: '（系統兜底補記：模型未呼叫 selfimprove_log，此筆沒有摘要）',
            files: touched,
            session: OC.session.id,
            model: OC.cfg.model,
            auto: true,
            bump: 'none',
        });
        _selfState = null;
        window.chatSystemNote?.('已自動把這一輪的檔案異動記入自我提升歷程（沒有摘要）。', 'info');
        if (OC.panel === 'self') renderSelfPanel();
    } catch (e) { console.warn('[self] 兜底記錄失敗', e.message); }
}

// ─── 面板 ───────────────────────────────────────────────────────
function selfHost() {
    const host = $('panel-self');
    if (!host) return null;
    if (host.dataset.ready === '1') return host;
    host.dataset.ready = '1';
    host.innerHTML = '';
    host.appendChild(el('div', { class: 'panel-head' },
        el('span', { class: 'panel-title' },
            el('span', { class: 'ms', text: 'self_improvement' }),
            el('span', { text: '自我提升' })),
        el('div', { class: 'panel-head-acts' },
            el('button', { class: 'btn-icon', title: '重新整理', onclick: () => renderSelfPanel(true) },
                el('span', { class: 'ms', text: 'refresh' }))
        )
    ));
    host.appendChild(el('div', { class: 'panel-body', id: 'self-body' }));
    return host;
}

async function renderSelfPanel(force = true) {
    const host = selfHost();
    if (!host) return;
    const body = $('self-body');
    body.innerHTML = '<div class="hint" style="padding:12px">載入中…</div>';
    const s = await loadSelfState(force);
    body.innerHTML = '';
    if (!s) { body.appendChild(el('div', { class: 'panel-empty', text: '讀不到自我提升資料（api/selfimprove.php）' })); return; }

    // ── 版本卡 ──
    const inSelf = currentMode() === 'self';
    body.appendChild(el('div', { class: 'card self-ver' },
        el('div', { class: 'self-ver-lab', text: 'Omni Code 目前版本' }),
        el('div', { class: 'self-ver-num', text: 'v' + s.version }),
        el('div', { class: 'self-ver-meta', text: `${s.history_total || 0} 次自我提升 · 安裝於 ${s.root || ''}` }),
        el('button', {
            class: 'btn btn-primary self-start',
            onclick: async () => {
                if (!inSelf) await setMode('self');
                $('chat-input')?.focus();
            },
        }, el('span', { class: 'ms', text: inSelf ? 'chat' : 'self_improvement' }),
           el('span', { text: inSelf ? '目前在自我提升模式，直接在右側對話' : '開始自我提升對話' })),
        inSelf ? el('button', {
            class: 'btn btn-ghost btn-xs', onclick: () => setMode('project'),
        }, el('span', { class: 'ms', text: 'logout' }), el('span', { text: '離開，回到專案項目' })) : null
    ));

    // ── 版本規劃 ──
    const rm = el('div', { class: 'self-sec' });
    rm.appendChild(el('div', { class: 'self-sec-head' },
        el('span', { text: '版本規劃' }),
        el('button', { class: 'btn btn-xs btn-ghost', onclick: () => _selfAddVersion() },
            el('span', { class: 'ms', text: 'add' }), el('span', { text: '版本' }))
    ));
    const rmList = (s.roadmap || []).slice().sort((a, b) => _verCmp(a.version, b.version));
    if (!rmList.length) rm.appendChild(el('div', { class: 'hint', text: '還沒有規劃。在自我提升對話裡提需求，Agent 會排進版本；或按上方「版本」手動建立。' }));
    for (const r of rmList) {
        const items = r.items || [];
        const done = items.filter(i => i.done).length;
        const card = el('div', { class: 'card self-rm' + (r.status === 'released' ? ' released' : r.status === 'active' ? ' active' : '') });
        card.appendChild(el('div', { class: 'self-rm-head' },
            el('span', { class: 'self-rm-ver', text: 'v' + r.version }),
            el('span', { class: 'self-rm-title', text: r.title || '' }),
            el('span', { class: 'chip', text: { planned: '規劃中', active: '進行中', released: '已發布' }[r.status] || r.status }),
            el('span', { class: 'self-rm-n', text: `${done}/${items.length}` }),
            el('button', { class: 'btn-icon btn-xs', title: '狀態', onclick: () => _selfCycleStatus(r) },
                el('span', { class: 'ms', text: 'sync' })),
            el('button', { class: 'btn-icon btn-xs', title: '刪除這個版本的規劃', onclick: () => _selfRemoveVersion(r.version) },
                el('span', { class: 'ms', text: 'delete' }))
        ));
        const ul = el('div', { class: 'self-items' });
        for (const it of items) {
            ul.appendChild(el('label', { class: 'self-item' + (it.done ? ' done' : '') },
                el('input', { type: 'checkbox', checked: it.done ? 'checked' : null,
                    onchange: () => _selfRoadmap({ op: 'toggle', id: it.id }) }),
                el('span', { class: 'self-item-t', text: it.text }),
                it.priority === 'high' ? el('span', { class: 'chip chip-warn', text: '高' }) : null,
                el('button', { class: 'btn-icon btn-xs self-item-x', title: '移除', onclick: (e) => { e.preventDefault(); _selfRoadmap({ op: 'remove_item', id: it.id }); } },
                    el('span', { class: 'ms', text: 'close' }))
            ));
        }
        const addRow = el('form', { class: 'self-add', onsubmit: (e) => {
            e.preventDefault();
            const inp = e.target.querySelector('input');
            const t = inp.value.trim(); if (!t) return;
            _selfRoadmap({ op: 'add_item', version: r.version, text: t });
        } });
        addRow.appendChild(el('input', { class: 'inp', placeholder: '新增項目…' }));
        ul.appendChild(addRow);
        card.appendChild(ul);
        rm.appendChild(card);
    }
    body.appendChild(rm);

    // ── 歷程 ──
    const hs = el('div', { class: 'self-sec' });
    hs.appendChild(el('div', { class: 'self-sec-head' }, el('span', { text: `歷程（最近 ${(s.history || []).length} 筆）` })));
    if (!(s.history || []).length) hs.appendChild(el('div', { class: 'hint', text: '還沒有任何自我提升紀錄。' }));
    for (const h of (s.history || [])) {
        const card = el('div', { class: 'card self-h' + (h.auto ? ' auto' : '') });
        card.appendChild(el('div', { class: 'self-h-head' },
            el('span', { class: 'self-h-ver', text: 'v' + h.version + (h.bump && h.bump !== 'none' ? ' ↑' + h.bump : '') }),
            el('span', { class: 'self-h-time', text: fmtTime(h.at) }),
            h.auto ? el('span', { class: 'chip', title: '模型沒有自己記錄，系統兜底補的', text: '自動' }) : null
        ));
        card.appendChild(el('div', { class: 'self-h-title', text: h.title }));
        if (h.summary && !h.auto) card.appendChild(el('div', { class: 'self-h-sum', text: h.summary }));
        if (h.files?.length) {
            card.appendChild(el('div', { class: 'self-h-files', title: h.files.join('\n'),
                text: h.files.slice(0, 4).join('、') + (h.files.length > 4 ? ` …共 ${h.files.length} 個` : '') }));
        }
        if (h.session) {
            card.appendChild(el('button', { class: 'btn btn-xs btn-ghost', onclick: () => window.loadSession?.(h.session) },
                el('span', { class: 'ms', text: 'history' }), el('span', { text: '開啟該次對話' })));
        }
        hs.appendChild(card);
    }
    body.appendChild(hs);
}

function _verCmp(a, b) {
    const A = String(a).split('.').map(Number), B = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0);
    return 0;
}

async function _selfRoadmap(payload) {
    try { await SELF.roadmap(payload); _selfState = null; renderSelfPanel(true); }
    catch (e) { toast(t('common.roadmapFail', { msg: e.message }), 'error'); }
}
async function _selfAddVersion() {
    const cur = _selfState?.version || '1.0.0';
    const [a, b] = cur.split('.').map(Number);
    const v = await promptModal('新增版本規劃', '版本號（x.y.z）', `${a}.${b + 1}.0`);
    if (!v) return;
    const title = await promptModal('版本主題', '一句話說明這個版本要做什麼（可留空）', '');
    if (title === null) return;
    _selfRoadmap({ op: 'add_version', version: v.trim(), title: title.trim() });
}
function _selfCycleStatus(r) {
    const next = { planned: 'active', active: 'released', released: 'planned' }[r.status] || 'planned';
    if (next === 'released' && !confirm(`把 v${r.version} 標為已發布？目前版本號會前進到 ${r.version}。`)) return;
    _selfRoadmap({ op: 'set_status', version: r.version, status: next });
}
async function _selfRemoveVersion(v) {
    if (!await confirmModal('刪除版本規劃？', `會移除 v${esc(v)} 與它底下所有項目。歷程紀錄不受影響。`, { okText: '刪除', danger: true })) return;
    _selfRoadmap({ op: 'remove_version', version: v });
}

// ═══════════════════════════════════════════════════════════════
// 啟動
// ═══════════════════════════════════════════════════════════════
function initModes() {
    let saved = 'project';
    try { saved = localStorage.getItem('oc_mode') || 'project'; } catch {}
    // self 不從 localStorage 恢復 —— 那需要切工作區，重新整理後回到專案項目比較安全；
    // 使用者要繼續自我提升，從對話紀錄點回那個會話即可。
    OC.mode = (saved === 'chat') ? 'chat' : 'project';
    OC._wsBeforeSelf = '';
    OC._selfLogged = false;

    $('mode-chat-btn')?.addEventListener('click', () => setMode(currentMode() === 'chat' ? 'project' : 'chat'));
    $('chat-self')?.addEventListener('click', async () => {
        if (currentMode() !== 'self') await setMode('self');
        window.switchPanel?.('self');
    });
    renderModeUI();
}

Object.assign(window, {
    MODES, CHAT_TOOLS, CHAT_IDENTITY,
    currentMode, modeOfSession, modeName, modeLabelOf, modeDescOf, setMode, renderModeUI, paintModeChrome,
    showEntryModal, pickEntry,
    selfPromptSection, selfAfterRun, renderSelfPanel, loadSelfState,
    initModes,
});
