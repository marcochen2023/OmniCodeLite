'use strict';
// ═══════════════════════════════════════════════════════════════
// Omni Code — 聊天面板渲染
// ═══════════════════════════════════════════════════════════════
// agent.js 唯一的「輸出裝置」：串流文字、思考區塊、工具卡、
// diff / 圖片 / 終端機富卡片、Todo、Token 儀表、選項卡。
// 契約見 docs/ARCHITECTURE.md §10 §12 §15
//
// 對外（agent.js / tools.js / memory.js / api.js 會呼叫）：
//   chatAppendUser / chatBeginAssistant / chatStreamText / chatStreamThinking
//   chatToolPending / chatToolInputDelta / chatToolStart / chatToolWaiting
//   chatToolResume / chatToolEnd / chatEndAssistant
//   chatSystemNote / chatSystemNoteUpdate / chatRenderAll / chatClear
//   renderTodos / renderTokenMeter / renderSessionTitle / setRunningUI
//   askUserCard / OCLog
// ═══════════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════════
// 工具的中文標籤 / 圖示 / 參數摘要
// ═══════════════════════════════════════════════════════════════

const CHAT_TOOL_LABEL = {
    read_file: '讀取',
    read_image: '檢視圖片',
    write_file: '寫入',
    edit_file: '編輯',
    multi_edit: '批次編輯',
    list_dir: '列出目錄',
    glob: '尋找檔案',
    grep: '搜尋內容',
    bash: '執行命令',
    bash_output: '讀取輸出',
    kill_shell: '終止程序',
    make_dir: '建立目錄',
    delete_path: '刪除',
    move_path: '移動',
    copy_path: '複製',
    todo_write: '更新任務',
    web_fetch: '抓取網頁',
    web_search: '網路搜尋',
    generate_image: '生成圖片',
    edit_image: '編修圖片',
    ui_control: '操作介面',
    spawn_agent: '派子代理',
    remember: '記住',
    read_memory: '讀取記憶',
    skill: '載入技能',
    ask_user: '詢問你',
    project_tree: '專案結構',
    git: 'Git',
    open_preview: '開啟預覽',
};

// mcp__<server>__<tool> → 「MCP：<tool>」；一般工具名走字典跟語系
// （常數本體留中文保底，跟 memTypeLabel 同一招）
function chatToolLabel(name) {
    name = String(name || '');
    if (name.startsWith('mcp__')) {
        const parts = name.split('__');
        return 'MCP：' + (parts.slice(2).join('__') || parts[1] || name);
    }
    if (typeof t !== 'function') return CHAT_TOOL_LABEL[name] || name;
    const v = t('chat.tool.' + name);
    return (v && v !== 'chat.tool.' + name) ? v : (CHAT_TOOL_LABEL[name] || name);
}

function chatToolLabelI18n(name) {
    return chatToolLabel(name);
}

const CHAT_TOOL_ICON = {
    read_file: 'description',
    read_image: 'image',
    write_file: 'note_add',
    edit_file: 'edit',
    multi_edit: 'edit_document',
    list_dir: 'folder_open',
    glob: 'search',
    grep: 'manage_search',
    bash: 'terminal',
    bash_output: 'receipt_long',
    kill_shell: 'stop_circle',
    make_dir: 'create_new_folder',
    delete_path: 'delete',
    move_path: 'drive_file_move',
    copy_path: 'content_copy',
    todo_write: 'checklist',
    web_fetch: 'language',
    web_search: 'travel_explore',
    generate_image: 'auto_awesome',
    edit_image: 'tune',
    ui_control: 'ads_click',
    spawn_agent: 'smart_toy',
    remember: 'bookmark_add',
    read_memory: 'menu_book',
    skill: 'school',
    ask_user: 'help',
    project_tree: 'account_tree',
    git: 'commit',
    open_preview: 'preview',
};

// mcp__<server>__<tool> → 「MCP：<tool>」；一般工具名走字典跟語系
// （常數本體留中文保底，跟 memTypeLabel 同一招）
function chatToolLabel(name) {
    name = String(name || '');
    if (name.startsWith('mcp__')) {
        const parts = name.split('__');
        return 'MCP：' + (parts.slice(2).join('__') || parts[1] || name);
    }
    if (typeof t !== 'function') return CHAT_TOOL_LABEL[name] || name;
    const v = t('chat.tool.' + name);
    return (v && v !== 'chat.tool.' + name) ? v : (CHAT_TOOL_LABEL[name] || name);
}

function chatToolIcon(name) {
    name = String(name || '');
    if (name.startsWith('mcp__')) return 'extension';
    return CHAT_TOOL_ICON[name] || 'build';
}

function _trunc(s, n) {
    s = String(s ?? '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// 一行參數摘要：讓使用者掃一眼就知道 AI 在動哪個東西
function chatToolArg(name, input) {
    const i = input || {};
    try {
        switch (name) {
            case 'read_file': case 'read_image': case 'write_file': case 'edit_file':
            case 'multi_edit': case 'make_dir': case 'delete_path':
                return shortPath(String(i.path || ''), 52);
            case 'list_dir': case 'project_tree':
                return i.path ? shortPath(String(i.path), 52) : '（工作區根目錄）';
            case 'move_path': case 'copy_path':
                return `${shortPath(String(i.from || ''), 26)} → ${shortPath(String(i.to || ''), 26)}`;
            case 'bash':
                return _trunc(i.command, 64) + (i.background ? '（背景）' : '');
            case 'bash_output': case 'kill_shell':
                return String(i.shell_id || '');
            case 'glob':
                return String(i.pattern || '') + (i.path ? `  於 ${shortPath(String(i.path), 24)}` : '');
            case 'grep':
                return _trunc(i.pattern, 44) + (i.glob ? `  在 ${i.glob}` : '');
            case 'todo_write': {
                const t = i.todos || [];
                const doing = t.find(x => x.status === 'in_progress');
                return `${t.length} 項${doing ? `　進行中：${_trunc(doing.content, 28)}` : ''}`;
            }
            case 'web_fetch': case 'open_preview':
                return _trunc(i.url, 60);
            case 'web_search':
                return _trunc(i.query, 60);
            case 'generate_image':
                return _trunc(i.prompt, 60);
            case 'edit_image':
                return `${i.op || ''}　${shortPath(String(i.path || ''), 40)}`;
            case 'ui_control': {
                const extra = i.path || i.panel || i.dock || i.theme || i.model || i.mode || i.url || i.selector || i.message || '';
                return String(i.action || '') + (extra ? `　${_trunc(extra, 40)}` : '');
            }
            case 'spawn_agent':
                return _trunc(i.task, 62);
            case 'remember': case 'skill':
                return String(i.name || '');
            case 'read_memory':
                return i.name ? String(i.name) : '（記憶索引）';
            case 'ask_user':
                return _trunc(i.question, 60);
            case 'git':
                return _trunc(i.args, 60);
        }
    } catch { /* 摘要失敗就退回泛用邏輯 */ }

    // 泛用：取第一個有值的字串欄位
    for (const [k, v] of Object.entries(i)) {
        if (k.startsWith('_')) continue;
        if (typeof v === 'string' && v.trim()) return _trunc(v, 60);
    }
    const keys = Object.keys(i).filter(k => !k.startsWith('_'));
    return keys.length ? _trunc(JSON.stringify(i), 60) : '';
}


// ═══════════════════════════════════════════════════════════════
// 捲動：只有使用者已經在底部附近才自動跟隨
// ═══════════════════════════════════════════════════════════════

const CHAT_STICK_PX = 80;

function _chatBox() { return $('chat-scroll'); }

function _nearBottom() {
    const s = _chatBox();
    if (!s) return false;
    return s.scrollHeight - s.scrollTop - s.clientHeight <= CHAT_STICK_PX;
}

function _scrollBottom() {
    const s = _chatBox();
    if (s) s.scrollTop = s.scrollHeight;
}

// 先量再改，改完只有原本貼底時才跟著捲
function _keepBottom(fn) {
    const stick = _nearBottom();
    const r = fn();
    if (stick) _scrollBottom();
    return r;
}

// 顯示 / 隱藏（不用 hidden 屬性，避免被 .btn{display:flex} 蓋掉）
function _show(node, on) {
    if (!node) return;
    node.style.display = on ? '' : 'none';
}


// ═══════════════════════════════════════════════════════════════
// 空狀態：歡迎卡 + 範例提示
// ═══════════════════════════════════════════════════════════════

const CHAT_EXAMPLE_KEYS = {
    chat: ['chat.exChat1', 'chat.exChat2', 'chat.exChat3', 'chat.exChat4', 'chat.exChat5', 'chat.exChat6'],
    self: ['chat.exSelf1', 'chat.exSelf2', 'chat.exSelf3', 'chat.exSelf4', 'chat.exSelf5'],
    project: ['chat.exProj1', 'chat.exProj2', 'chat.exProj3', 'chat.exProj4', 'chat.exProj5', 'chat.exProj6'],
};
const CHAT_EXAMPLE_ICONS = {
    chat: ['lightbulb', 'translate', 'edit_note', 'travel_explore', 'palette', 'calculate'],
    self: ['bug_report', 'speed', 'checklist', 'security', 'history'],
    project: ['account_tree', 'join_inner', 'bug_report', 'palette', 'auto_stories', 'route'],
};
// 建議卡文案跟著介面語系走；舊常數保留中文當保底（其他地方若有引用不會炸）
const CHAT_EXAMPLES_BY_MODE = {
    chat: [
        { icon: 'lightbulb',   text: '用三段話解釋量子糾纏，給高中生聽' },
        { icon: 'translate',   text: '把這段英文翻成自然的台灣用語' },
        { icon: 'edit_note',   text: '幫我把這封信改得更有禮貌' },
        { icon: 'travel_explore', text: '查一下 2026 年台灣的電動車補助政策' },
        { icon: 'palette',     text: '生成一張夜晚雨中東京街頭的插畫' },
        { icon: 'calculate',   text: '幫我算這筆房貸每月要繳多少' },
    ],
    self: [
        { icon: 'bug_report',  text: '找出 Omni Code 目前最明顯的三個 UX 問題並修掉' },
        { icon: 'speed',       text: '分析 agent.js 的執行流程，找出可以省 token 的地方' },
        { icon: 'checklist',   text: '把還沒做完的版本規劃項目列出來，挑一個開始做' },
        { icon: 'security',    text: '審查 api/ 底下的端點有沒有權限漏洞' },
        { icon: 'history',     text: '整理最近的自我提升歷程，規劃下一個版本' },
    ],
};
const CHAT_EXAMPLES = [
    { icon: 'account_tree', text: '幫我看看這個專案的結構' },
    { icon: 'join_inner', text: '把 app/js 裡的重複程式碼抽成共用函式' },
    { icon: 'bug_report', text: '跑一次測試並修好失敗的地方' },
    { icon: 'palette', text: '幫我生一組深色系的 UI 圖示' },
    { icon: 'auto_stories', text: '初始化 OMNI.md' },
    { icon: 'route', text: '解釋 agent.js 的執行流程' },
];

/** 依目前語系取建議卡（圖示固定、文案走字典） */
function chatExamples(mode) {
    const keys = CHAT_EXAMPLE_KEYS[mode] || CHAT_EXAMPLE_KEYS.project;
    const icons = CHAT_EXAMPLE_ICONS[mode] || CHAT_EXAMPLE_ICONS.project;
    if (typeof t !== 'function') {
        return (CHAT_EXAMPLES_BY_MODE[mode] || CHAT_EXAMPLES).map(e => ({ ...e }));
    }
    return keys.map((k, i) => ({ icon: icons[i] || 'lightbulb', text: t(k) }));
}

function _submitExample(text) {
    const inp = $('chat-input');
    if (!inp) { window.runAgent?.(text); return; }
    inp.value = text;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.focus();
    const form = $('chat-form');
    if (form) {
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    } else {
        inp.value = '';
        window.runAgent?.(text);
    }
}

function _emptyState() {
    const box = _chatBox();
    if (!box || box.querySelector('.chat-welcome')) return;
    const mode = window.currentMode?.() || 'project';
    const M = window.MODES?.[mode];
    const mLabel = (typeof modeLabelOf === 'function' ? modeLabelOf(mode) : null) || M?.label || '';
    const grid = el('div', { class: 'welcome-grid' });
    for (const ex of chatExamples(mode)) {
        grid.appendChild(el('button', {
            class: 'card welcome-ex', type: 'button',
            onclick: () => _submitExample(ex.text),
        },
            el('span', { class: 'ms', text: ex.icon }),
            el('span', { class: 'welcome-ex-t', text: ex.text })
        ));
    }
    box.appendChild(el('div', { class: 'chat-welcome' },
        el('div', { class: 'welcome-logo' }, el('span', { class: 'ms', text: mode === 'project' ? 'deployed_code' : (M?.icon || 'deployed_code') })),
        el('div', { class: 'welcome-title', text: mode === 'project' ? 'Omni Code' : `Omni Code · ${mLabel}` }),
        el('div', { class: 'welcome-pitch', text:
            mode === 'chat' ? t('chat.pitchChat')
          : mode === 'self' ? t('chat.pitchSelf')
          : t('chat.pitchProj') }),
        grid,
        el('div', { class: 'welcome-tip', text: t('chat.welcomeTip') })
    ));
}

function _clearEmpty() {
    _chatBox()?.querySelector('.chat-welcome')?.remove();
}


// ═══════════════════════════════════════════════════════════════
// 訊息動作列（複製 / 重新產生）
// ═══════════════════════════════════════════════════════════════

function _msgActions(getText) {
    const acts = el('div', { class: 'msg-actions' });
    acts.appendChild(el('button', {
        class: 'btn btn-icon btn-xs', title: t('chat.copyTip'), type: 'button',
        onclick: () => copyText(getText() || ''),
    }, el('span', { class: 'ms', text: 'content_copy' })));
    return acts;
}

// 只有「最後一則」AI 訊息才掛重新產生
function _refreshRetry() {
    const box = _chatBox();
    if (!box) return;
    const bubbles = $$('.msg.ai', box);
    bubbles.forEach(b => $1('[data-act=retry]', b)?.remove());
    const last = bubbles[bubbles.length - 1];
    const acts = last ? $1('.msg-actions', last) : null;
    if (!acts) return;
    acts.appendChild(el('button', {
        class: 'btn btn-icon btn-xs', title: t('chat.rerunTip'), type: 'button',
        'data-act': 'retry', onclick: retryLastTurn,
    }, el('span', { class: 'ms', text: 'refresh' })));
}

// 回捲到最後一則使用者訊息之前，再跑一次同樣的輸入
function retryLastTurn() {
    if (OC.running) { toast(t('chat.busy'), 'warn'); return; }
    const msgs = OC.messages || [];
    let idx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
        const c = msgs[i].content || [];
        if (msgs[i].role !== 'user') continue;
        if (msgs[i]._carrier) continue;                        // 工具附圖的載體訊息
        if (msgs[i]._runtime) continue;                        // runtime-context 快照
        if (c.some(b => b.type === 'tool_result')) continue;   // 工具回填，不是真正的使用者輸入
        if (!c.some(b => b.type === 'text' || b.type === 'image')) continue;
        idx = i; break;
    }
    if (idx < 0) { toast(t('chat.noRerun'), 'warn'); return; }
    const c = msgs[idx].content || [];
    const text = c.filter(b => b.type === 'text').map(b => b.text).join('\n');
    const imgs = c.filter(b => b.type === 'image').map(b => ({ mime: b.mime, data: b.data }));
    OC.messages = msgs.slice(0, idx);
    chatRenderAll();
    window.runAgent?.(text, imgs);
}


// ═══════════════════════════════════════════════════════════════
// 使用者訊息
// ═══════════════════════════════════════════════════════════════

function chatAppendUser(text, attachments = [], mentioned = []) {
    const box = _chatBox();
    if (!box) return null;
    _clearEmpty();

    const node = el('div', { class: 'msg user' });
    const body = el('div', { class: 'msg-body' });

    if (attachments && attachments.length) {
        const strip = el('div', { class: 'msg-imgs' });
        for (const a of attachments) {
            const src = a.dataUrl || `data:${a.mime || 'image/png'};base64,${a.data || ''}`;
            strip.appendChild(el('img', {
                class: 'msg-img', src, alt: a.name || '附件圖片',
                style: { maxWidth: '160px', maxHeight: '160px' },
                onclick: () => openLightbox(src),
            }));
        }
        body.appendChild(strip);
    }

    const t = String(text ?? '');
    if (t.trim()) {
        // @path 標成 chip，讓使用者一眼看出哪些檔案被附進去了
        const html = esc(t)
            .replace(/(^|\s)@([^\s@]+)/g, (m, sp, p) => `${sp}<span class="men-tag">@${p}</span>`)
            .replace(/\n/g, '<br>');
        body.appendChild(el('div', { class: 'msg-text', html }));
    }

    if (mentioned && mentioned.length) {
        body.appendChild(el('div', { class: 'men-attached' },
            el('span', { class: 'ms', text: 'attach_file' }),
            el('span', { text: t('chat.attachedN', { n: mentioned.length }) })
        ));
    }

    node.appendChild(body);
    node.appendChild(_msgActions(() => t));
    _keepBottom(() => box.appendChild(node));
    return node;
}


// ═══════════════════════════════════════════════════════════════
// 助理訊息（串流）
// ═══════════════════════════════════════════════════════════════

const CHAT_RENDER_MS = 60;

function chatBeginAssistant() {
    const box = _chatBox();
    _clearEmpty();

    const body = el('div', { class: 'msg-body' });
    const tools = el('div', { class: 'tool-list' });
    const wait = el('div', { class: 'msg-wait' },
        el('span', { class: 'spinner' }),
        el('span', { class: 'msg-wait-t', text: t('chat.thinking') })
    );
    const node = el('div', { class: 'msg ai' }, wait, body, tools);

    const bubble = {
        root: node, body, tools, wait,
        text: '', think: '',
        thinkWrap: null, thinkBody: null, thinkCount: null,
        cards: new Map(),
        caret: el('span', { class: 'stream-caret', text: '▍' }),
        streaming: true,
        timer: null, lastRender: 0,
    };

    if (box) _keepBottom(() => box.appendChild(node));
    return bubble;
}

function _dropWait(b) {
    if (b?.wait) { b.wait.remove(); b.wait = null; }
}

function _flushBubble(b) {
    if (!b || !b.body) return;
    b.lastRender = Date.now();
    _keepBottom(() => {
        b.body.innerHTML = renderMarkdown(b.text);
        decorateCodeBlocks(b.body);
        if (b.streaming) b.body.appendChild(b.caret);
    });
}

// 串流期間最多每 60ms 重繪一次 markdown
function _scheduleRender(b) {
    if (!b || b.timer) return;
    const wait = Math.max(0, CHAT_RENDER_MS - (Date.now() - b.lastRender));
    b.timer = setTimeout(() => {
        b.timer = null;
        requestAnimationFrame(() => _flushBubble(b));
    }, wait);
}

function chatStreamText(bubble, delta) {
    if (!bubble || !delta) return;
    _dropWait(bubble);
    bubble.text += delta;
    _scheduleRender(bubble);
}

function chatStreamThinking(bubble, delta) {
    if (!bubble || !delta) return;
    _dropWait(bubble);
    if (!bubble.thinkWrap) {
        bubble.thinkBody = el('div', { class: 'think-body' });
        bubble.thinkCount = el('span', { class: 'think-n', text: '' });
        bubble.thinkWrap = el('details', { class: 'think-block' },
            el('summary', { class: 'think-head' },
                el('span', { class: 'ms', text: 'neurology' }),
                el('span', { class: 'think-title', text: t('chat.thinking') }),
                bubble.thinkCount
            ),
            bubble.thinkBody
        );
        _keepBottom(() => bubble.root.insertBefore(bubble.thinkWrap, bubble.body));
    }
    bubble.think += delta;
    _keepBottom(() => {
        bubble.thinkBody.textContent = bubble.think;
        bubble.thinkCount.textContent = `${bubble.think.length} 字`;
    });
}

function chatEndAssistant(bubble, res) {
    if (!bubble) return;
    bubble.streaming = false;
    if (bubble.timer) { clearTimeout(bubble.timer); bubble.timer = null; }
    _dropWait(bubble);
    _flushBubble(bubble);
    bubble.caret.remove();

    if (bubble.thinkWrap) {
        const t = $1('.think-title', bubble.thinkWrap);
        if (t) t.textContent = t('chat.thinkingLog');
    }

    // 沒有文字也沒有工具卡 → 收掉空泡泡
    if (!bubble.text.trim() && !bubble.cards.size && !bubble.think) {
        bubble.root.remove();
        _refreshRetry();
        return;
    }

    if (!$1('.msg-actions', bubble.root)) {
        bubble.root.appendChild(_msgActions(() => bubble.text));
    }
    _refreshRetry();

    if (res?.usage) {
        const u = res.usage;
        bubble.root.title = t('chat.usageTip', { i: fmtTokens(u.input || 0), o: fmtTokens(u.output || 0) });
    }
}


// ═══════════════════════════════════════════════════════════════
// 工具卡
// ═══════════════════════════════════════════════════════════════

function _makeToolCard(bubble, id, name) {
    const ico = el('span', { class: 'ms tool-ico', text: chatToolIcon(name) });
    const nameEl = el('span', { class: 'tool-name', text: chatToolLabel(name) });
    const argEl = el('span', { class: 'tool-arg', text: '' });
    const metaEl = el('span', { class: 'tool-meta' });
    const caret = el('span', { class: 'ms tool-caret', text: 'expand_more' });

    const head = el('div', { class: 'tool-head', title: name }, ico, nameEl, argEl, metaEl, caret);
    const rich = el('div', { class: 'tool-rich' });
    // .tool-body 的展開／收合由 CSS 的 .open + grid 動畫處理，這裡不要寫 inline display
    const body = el('div', { class: 'tool-body' });

    const root = el('div', { class: 'tool-card', 'data-state': 'pending', 'data-tool': name }, head, rich, body);

    const card = { id, name, root, head, ico, nameEl, argEl, metaEl, caret, rich, body, t0: Date.now(), raw: '', open: false };

    head.addEventListener('click', () => _toggleCard(card));

    if (bubble?.tools) {
        // 泡泡可能因為「純工具、無文字」被收掉了，這裡把它接回來
        const box = _chatBox();
        if (box && !bubble.root.isConnected) box.appendChild(bubble.root);
        _keepBottom(() => bubble.tools.appendChild(root));
        bubble.cards.set(id, card);
        _dropWait(bubble);
    }
    return card;
}

function _toggleCard(card) {
    card.open = !card.open;
    card.root.classList.toggle('open', card.open);
    card.caret.textContent = card.open ? 'expand_less' : 'expand_more';
}

// 模型開始吐工具呼叫（參數還沒完整）
function chatToolPending(bubble, id, name) {
    if (!bubble) return null;
    if (bubble.cards.has(id)) return bubble.cards.get(id);
    const card = _makeToolCard(bubble, id, name);
    card.metaEl.appendChild(el('span', { class: 'spinner' }));
    return card;
}

// 參數 JSON 一片片進來：即時顯示截斷預覽，讓人看得到「正在準備什麼」
function chatToolInputDelta(bubble, id, delta) {
    const card = bubble?.cards?.get(id);
    if (!card || !delta) return;
    card.raw += delta;
    const preview = card.raw.replace(/[{}"\\]/g, '').replace(/\s+/g, ' ').trim();
    card.argEl.textContent = _trunc(preview, 62);
}

// 工具即將執行：拿到完整參數，換成正式摘要
function chatToolStart(bubble, toolUse) {
    if (!toolUse) return null;
    const id = toolUse.id;
    let card = bubble?.cards?.get(id);
    if (!card) card = _makeToolCard(bubble, id, toolUse.name);

    card.name = toolUse.name;
    card.input = toolUse.input || {};
    card.nameEl.textContent = chatToolLabel(toolUse.name);
    card.head.title = toolUse.name;
    card.ico.textContent = chatToolIcon(toolUse.name);
    card.argEl.textContent = chatToolArg(toolUse.name, toolUse.input);
    card.root.dataset.state = 'running';
    card.root.dataset.tool = toolUse.name;
    card.t0 = Date.now();
    card.metaEl.innerHTML = '';
    card.metaEl.appendChild(el('span', { class: 'spinner' }));
    return card;
}

function chatToolWaiting(card) {
    if (!card) return;
    card.root.dataset.state = 'waiting';
    card.metaEl.innerHTML = '';
    card.metaEl.appendChild(el('span', { class: 'tool-wait' },
        el('span', { class: 'ms', text: 'lock' }),
        document.createTextNode(t('chat.waitAuth'))
    ));
}

function chatToolResume(card) {
    if (!card) return;
    card.root.dataset.state = 'running';
    card.t0 = Date.now();
    card.metaEl.innerHTML = '';
    card.metaEl.appendChild(el('span', { class: 'spinner' }));
}

const CHAT_TOOL_TEXT_CAP = 20000;

function chatToolEnd(card, result) {
    if (!card) return;
    const r = result || {};
    const ms = r.ms != null ? r.ms : (Date.now() - card.t0);

    card.root.dataset.state = r.is_error ? 'error' : 'ok';
    card.metaEl.innerHTML = '';
    if (r.is_error) card.metaEl.appendChild(el('span', { class: 'ms tool-x', text: 'error' }));
    card.metaEl.appendChild(el('span', { class: 'tool-dur', text: fmtDur(ms) }));

    // 完整輸出（收合區）
    let text = typeof r.content === 'string' ? r.content : JSON.stringify(r.content ?? '', null, 2);
    let capped = false;
    if (text.length > CHAT_TOOL_TEXT_CAP) { text = text.slice(0, CHAT_TOOL_TEXT_CAP); capped = true; }
    card.body.innerHTML = '';
    card.body.appendChild(el('pre', { class: 'pre-scroll', text: text || t('chat.noOutput') }));
    if (capped) card.body.appendChild(el('div', { class: 'hint', text: t('chat.outputCut') }));

    // 富卡片
    card.rich.innerHTML = '';
    try {
        const node = chatRenderToolUI(r.ui);
        if (node) _keepBottom(() => card.rich.appendChild(node));
    } catch (e) {
        card.rich.appendChild(el('div', { class: 'hint', text: `結果渲染失敗：${e.message}` }));
    }

    // 失敗時直接把錯誤攤開，不用點
    if (r.is_error && !card.open) _toggleCard(card);
}

function chatRenderToolUI(ui) {
    if (!ui || !ui.type) return null;
    if (ui.type === 'diff') return chatRenderDiff(ui);
    if (ui.type === 'image') return chatRenderImage(ui);
    if (ui.type === 'terminal') return chatRenderTerminal(ui);
    return null;
}


// ─── ui:{type:'diff'} ───────────────────────────────────────────

const CHAT_DIFF_ROW_CAP = 400;

function chatRenderDiff(ui) {
    const rows = ui.rows || [];
    const wrap = el('div', { class: 'diff-view' });

    const stat = el('div', { class: 'diff-stat' },
        el('span', { class: 'ms', text: ui.created ? 'note_add' : 'difference' }),
        el('span', { class: 'diff-path', text: shortPath(String(ui.path || ''), 48), title: ui.path || '' }),
        el('span', { class: 'diff-plus', text: `+${ui.add || 0}` }),
        el('span', { class: 'diff-minus', text: `−${ui.del || 0}` }),
        ui.created ? el('span', { class: 'chip', text: '新檔案' }) : null,
        el('button', {
            class: 'btn btn-ghost btn-xs', type: 'button', title: '在編輯器開啟',
            onclick: (e) => { e.stopPropagation(); window.openFile?.(ui.path); },
        }, el('span', { class: 'ms', text: 'open_in_new' }), document.createTextNode('開啟'))
    );
    wrap.appendChild(stat);

    const list = el('div', { class: 'diff-rows' });
    const total = rows.length;
    const shownRows = Math.min(total, CHAT_DIFF_ROW_CAP);
    for (let i = 0; i < shownRows; i++) list.appendChild(_diffRow(rows[i]));
    wrap.appendChild(list);

    if (total > shownRows) {
        let expanded = false;
        const btn = el('button', {
            class: 'btn btn-ghost btn-xs diff-more', type: 'button',
            text: `展開全部（還有 ${total - shownRows} 行）`,
        });
        btn.addEventListener('click', () => {
            if (expanded) return;
            expanded = true;
            const frag = document.createDocumentFragment();
            for (let i = shownRows; i < total; i++) frag.appendChild(_diffRow(rows[i]));
            list.appendChild(frag);
            btn.remove();
        });
        wrap.appendChild(btn);
    }
    return wrap;
}

function _diffRow(r) {
    const type = r.type === 'add' || r.type === 'del' || r.type === 'gap' ? r.type : 'ctx';
    if (type === 'gap') {
        return el('div', { class: 'diff-line gap' },
            el('span', { class: 'diff-txt', text: r.text || '⋯' }));
    }
    const sign = type === 'add' ? '+' : type === 'del' ? '-' : ' ';
    return el('div', { class: 'diff-line ' + type },
        el('span', { class: 'diff-ln', text: r.aLine != null ? String(r.aLine) : '' }),
        el('span', { class: 'diff-ln', text: r.bLine != null ? String(r.bLine) : '' }),
        el('span', { class: 'diff-sign', text: sign }),
        el('span', { class: 'diff-txt', text: r.text ?? '' })
    );
}


// ─── ui:{type:'image'} ──────────────────────────────────────────

function chatRenderImage(ui) {
    const src = ui.src || '';
    const wrap = el('div', { class: 'img-card' });

    wrap.appendChild(el('img', {
        class: 'img-out', src, alt: ui.path || '生成的圖片',
        style: { maxWidth: '100%' },
        title: '點一下放大',
        onclick: () => openLightbox(src),
    }));

    const caption = el('div', { class: 'img-cap' },
        el('span', { class: 'ms', text: 'image' }),
        el('span', { class: 'img-path', text: ui.path || '', title: ui.path || '' })
    );
    wrap.appendChild(caption);

    if (ui.prompt) wrap.appendChild(el('div', { class: 'hint img-prompt', text: _trunc(ui.prompt, 140) }));

    const acts = el('div', { class: 'img-acts' },
        el('button', {
            class: 'btn btn-ghost btn-xs', type: 'button',
            onclick: () => openLightbox(src),
        }, el('span', { class: 'ms', text: 'zoom_in' }), document.createTextNode('開啟')),
        el('button', {
            class: 'btn btn-ghost btn-xs', type: 'button',
            onclick: () => _saveImage(src, ui.path),
        }, el('span', { class: 'ms', text: 'download' }), document.createTextNode('另存')),
        el('button', {
            class: 'btn btn-ghost btn-xs', type: 'button',
            onclick: () => {
                if (window.openImageStudioWith) window.openImageStudioWith(src);
                else toast(t('chat.imgStudioBusy'), 'warn');
            },
        }, el('span', { class: 'ms', text: 'palette' }), document.createTextNode('送進圖片工作室'))
    );
    wrap.appendChild(acts);
    return wrap;
}

function _saveImage(src, path) {
    const name = baseName(path || '') || `omni-${Date.now()}.png`;
    const a = el('a', { href: src, download: name.includes('.') ? name : name + '.png' });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 800);
}

// 燈箱：沿用 .modal-overlay 的樣式，避免另造一套
function openLightbox(src) {
    if (!src) return;
    const overlay = el('div', { class: 'modal-overlay active img-lightbox' });
    const img = el('img', {
        class: 'lightbox-img', src, alt: '',
        style: { maxWidth: '92vw', maxHeight: '88vh', borderRadius: 'var(--r)' },
    });
    const close = () => {
        // 對稱退場：先拿掉 active 跑淡出，動畫跑完才 remove
        overlay.classList.remove('active');
        setTimeout(() => overlay.remove(), 240);
        document.removeEventListener('keydown', onKey, true);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    overlay.addEventListener('click', close);
    img.addEventListener('click', e => e.stopPropagation());
    document.addEventListener('keydown', onKey, true);
    overlay.appendChild(img);
    document.body.appendChild(overlay);
}


// ─── ui:{type:'terminal'} ───────────────────────────────────────

const CHAT_TERM_CAP = 4000;

function chatRenderTerminal(ui) {
    const full = String(ui.output ?? '');
    const exit = ui.exit;
    const okExit = exit === 0;

    const wrap = el('div', { class: 'term-card' });
    wrap.appendChild(el('div', { class: 'term-head' },
        el('span', { class: 'ms', text: 'terminal' }),
        el('code', { class: 'term-cmd', text: _trunc(ui.command, 70), title: ui.command || '' }),
        el('span', {
            class: 'term-exit ' + (okExit ? 'ok' : 'bad'),
            text: `結束碼 ${exit == null ? '?' : exit}`,
        })
    ));

    const pre = el('pre', { class: 'pre-scroll term-out' });
    const capped = full.length > CHAT_TERM_CAP;
    pre.textContent = capped ? full.slice(0, CHAT_TERM_CAP) : (full || '（沒有輸出）');
    wrap.appendChild(pre);

    if (capped) {
        let expanded = false;
        const more = `展開全部（共 ${fmtNum(full.length)} 字）`;
        const btn = el('button', { class: 'btn btn-ghost btn-xs', type: 'button', text: more });
        btn.addEventListener('click', () => {
            expanded = !expanded;
            pre.textContent = expanded ? full : full.slice(0, CHAT_TERM_CAP);
            btn.textContent = expanded ? '收合' : more;
        });
        wrap.appendChild(btn);
    }
    return wrap;
}


// ═══════════════════════════════════════════════════════════════
// 系統訊息（置中細線）
// ═══════════════════════════════════════════════════════════════

const _notes = new Map();

const CHAT_NOTE_ICON = {
    error: 'error', warn: 'warning', stop: 'stop_circle',
    compact: 'bolt', compacting: 'bolt', skill: 'school',
    subagent: 'smart_toy', log: 'more_horiz', info: 'info',
};

function chatSystemNote(text, kind = 'info') {
    const box = _chatBox();
    if (!box) { console.log('[sys]', text); return ''; }
    _clearEmpty();
    const id = uid('sn-');
    const label = el('span', { class: 'sys-text', text: String(text ?? '') });
    const node = el('div', { class: 'msg sys sys-' + kind },
        el('span', { class: 'ms', text: CHAT_NOTE_ICON[kind] || 'info' }),
        label
    );
    _notes.set(id, label);
    _keepBottom(() => box.appendChild(node));
    return id;
}

function chatSystemNoteUpdate(id, text) {
    const label = _notes.get(id);
    if (!label) return;
    _keepBottom(() => { label.textContent = String(text ?? ''); });
}

// api.js 的重試提示等：低調的一行
function OCLog(msg) {
    console.log('[Omni]', msg);
    return chatSystemNote(String(msg ?? ''), 'log');
}


// ═══════════════════════════════════════════════════════════════
// 詢問使用者（ask_user 工具的阻塞式選項卡）
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// 計畫批准卡（present_plan）
// ═══════════════════════════════════════════════════════════════
// 計畫模式的核心：Agent 研究完提出計畫 → 使用者批准 → 自動切換權限並執行。
// 回傳 {approved, feedback, modeLabel}，中止則回傳 null。
function presentPlanCard(plan) {
    return new Promise(resolve => {
        const box = _chatBox();
        if (!box) { resolve(null); return; }
        _clearEmpty();

        const steps = Array.isArray(plan?.steps) ? plan.steps : [];
        const card = el('div', { class: 'msg sys plan-card' });

        card.appendChild(el('div', { class: 'plan-head' },
            el('span', { class: 'ms', text: 'schema' }),
            el('span', { class: 'plan-head-t', text: t('plan.title') }),
            el('span', { class: 'plan-badge', text: t('plan.steps', { n: steps.length }) })
        ));

        if (plan?.summary) card.appendChild(el('div', { class: 'plan-summary', text: String(plan.summary) }));

        const list = el('ol', { class: 'plan-steps' });
        for (const s of steps) {
            const li = el('li', { class: 'plan-step' },
                el('div', { class: 'plan-step-t', text: String(s?.title || '') })
            );
            if (s?.detail) li.appendChild(el('div', { class: 'plan-step-d', text: String(s.detail) }));
            const files = Array.isArray(s?.files) ? s.files.filter(Boolean) : [];
            if (files.length) {
                const fb = el('div', { class: 'plan-step-f' });
                for (const f of files) {
                    // 檔案可點開，讓使用者批准前先看一眼要被動的東西
                    fb.appendChild(el('button', {
                        class: 'plan-file', text: String(f), title: t('plan.openFileT', { f: String(f) }),
                        onclick: () => window.openFile?.(String(f)),
                    }));
                }
                li.appendChild(fb);
            }
            list.appendChild(li);
        }
        card.appendChild(list);

        if (plan?.risks) {
            card.appendChild(el('div', { class: 'plan-risks' },
                el('span', { class: 'ms', text: 'warning' }),
                el('span', { text: String(plan.risks) })));
        }
        if (plan?.verification) {
            card.appendChild(el('div', { class: 'plan-verify' },
                el('span', { class: 'ms', text: 'fact_check' }),
                el('span', { text: String(plan.verification) })));
        }

        let done = false;
        const acts = el('div', { class: 'plan-acts' });
        const fb = el('input', {
            class: 'inp plan-feedback',
            placeholder: t('plan.feedbackPh'),
        });

        const finish = async (approved) => {
            if (done) return;
            done = true;
            OC.abort?.signal?.removeEventListener('abort', onAbort);
            const feedback = fb.value.trim();
            $$('button, input', card).forEach(n => { n.disabled = true; });
            card.classList.add('answered', approved ? 'approved' : 'rejected');

            let modeLabel = '';
            if (approved) {
                // 批准 = 授權執行。切到「自動編輯」：檔案改動免問，
                // 但命令與網路仍要確認 —— 批准一份計畫不等於交出整台機器。
                await window.setPermissionMode?.('acceptEdits', { silent: true });
                modeLabel = (window.permModeMeta ? permModeMeta('acceptEdits') : window.PERM_MODES?.acceptEdits)?.label || '';
            }
            card.appendChild(el('div', { class: 'plan-verdict' },
                el('span', { class: 'ms', text: approved ? 'play_circle' : 'edit' }),
                el('span', {
                    text: approved
                        ? t('plan.approved', { label: modeLabel }) + (feedback ? t('plan.approvedExtra', { fb: feedback }) : '')
                        : t('plan.needChange') + (feedback ? t('plan.needChangeExtra', { fb: feedback }) : ''),
                })
            ));
            box.scrollTop = box.scrollHeight;
            resolve({ approved, feedback, modeLabel });
        };
        const onAbort = () => {
            if (done) return;
            done = true;
            $$('button, input', card).forEach(n => { n.disabled = true; });
            resolve(null);
        };

        acts.appendChild(fb);
        acts.appendChild(el('button', {
            class: 'btn btn-sm btn-ghost', onclick: () => finish(false),
        }, el('span', { class: 'ms', text: 'edit' }), el('span', { text: t('plan.modify') })));
        acts.appendChild(el('button', {
            class: 'btn btn-sm btn-primary', onclick: () => finish(true),
        }, el('span', { class: 'ms', text: 'play_arrow' }), el('span', { text: t('plan.approve') })));        card.appendChild(acts);

        box.appendChild(card);
        box.scrollTop = box.scrollHeight;
        setTimeout(() => fb.focus(), 60);
        OC.abort?.signal?.addEventListener('abort', onAbort);
    });
}

function askUserCard(question, options = [], multi = false) {
    return new Promise(resolve => {
        const box = _chatBox();
        if (!box) { resolve(null); return; }
        _clearEmpty();

        const opts = (options || []).map(o =>
            typeof o === 'string' ? { label: o, description: '' } : { label: o.label || '', description: o.description || '' }
        ).filter(o => o.label);

        if (!opts.length) { resolve(null); return; }

        const card = el('div', { class: 'msg sys ask-card' });
        card.appendChild(el('div', { class: 'ask-q' },
            el('span', { class: 'ms', text: 'help' }),
            el('span', { text: String(question || '') })
        ));

        const list = el('div', { class: 'ask-opts' });
        const boxes = [];
        let done = false;

        const finish = (val) => {
            if (done) return;
            done = true;
            OC.abort?.signal?.removeEventListener('abort', onAbort);
            $$('button, input', card).forEach(n => { n.disabled = true; });
            card.classList.add('answered');
            const answerText = val === null ? t('ask.aborted')
                : Array.isArray(val) ? (val.join('、') || t('ask.none')) : val;
            card.appendChild(el('div', { class: 'ask-answer' },
                el('span', { class: 'ms', text: val === null ? 'block' : 'check_circle' }),
                el('span', { text: t('ask.answer') + answerText })
            ));
            resolve(val);
        };
        const onAbort = () => finish(null);

        if (multi) {
            for (const o of opts) {
                const cb = el('input', { type: 'checkbox', class: 'ask-cb' });
                boxes.push({ cb, label: o.label });
                list.appendChild(el('label', { class: 'ask-opt ask-multi' },
                    cb,
                    el('span', { class: 'ask-opt-b' },
                        el('b', { class: 'ask-label', text: o.label }),
                        o.description ? el('span', { class: 'ask-desc', text: o.description }) : null
                    )
                ));
            }
            card.appendChild(list);
            card.appendChild(el('div', { class: 'ask-acts' },
                el('button', {
                    class: 'btn btn-primary btn-sm', type: 'button', text: t('ask.submit'),
                    onclick: () => finish(boxes.filter(b => b.cb.checked).map(b => b.label)),
                })
            ));
        } else {
            for (const o of opts) {
                list.appendChild(el('button', {
                    class: 'btn btn-ghost ask-opt', type: 'button',
                    onclick: () => finish(o.label),
                },
                    el('b', { class: 'ask-label', text: o.label }),
                    o.description ? el('span', { class: 'ask-desc', text: o.description }) : null
                ));
            }
            card.appendChild(list);
        }

        _keepBottom(() => box.appendChild(card));
        _scrollBottom();

        if (OC.abort?.signal) {
            if (OC.abort.signal.aborted) { finish(null); return; }
            OC.abort.signal.addEventListener('abort', onAbort, { once: true });
        }
    });
}


// ═══════════════════════════════════════════════════════════════
// 全量重繪：從 OC.messages 還原整段對話
// （壓縮後、載入舊會話時使用；必須跟即時渲染長得一樣）
// ═══════════════════════════════════════════════════════════════

function chatRenderAll() {
    const box = _chatBox();
    if (!box) return;
    box.innerHTML = '';
    _notes.clear();

    const msgs = OC.messages || [];
    if (!msgs.length) {
        _emptyState();
        renderTodos();
        return;
    }

    // tool_use_id → tool_result（跨訊息配對）
    const results = new Map();
    for (const m of msgs) {
        for (const b of (m.content || [])) {
            if (b.type === 'tool_result' && b.tool_use_id) results.set(b.tool_use_id, b);
        }
    }

    for (const m of msgs) {
        const content = m.content || [];

        if (m.role === 'user') {
            // 工具回填訊息不重畫（結果會掛在對應的工具卡上）
            if (content.some(b => b.type === 'tool_result')) continue;

            const texts = content.filter(b => b.type === 'text').map(b => b.text || '');
            const imgs = content.filter(b => b.type === 'image').map(b => ({ mime: b.mime, data: b.data }));
            const joined = texts.join('\n');

            // 載體訊息靠標記判斷，不能靠文字比對 —— 舊圖被剪成 stub 後文字就對不上了
            if (m._carrier) continue;
            if (m._runtime) continue;   // runtime-context 快照不是使用者說的話
            if (joined.trim() === '（以上是工具回傳的圖片）') continue;   // 舊會話沒有標記，保留文字比對
            if (m._compacted) { _compactCard(joined); continue; }

            chatAppendUser(joined, imgs);
            continue;
        }

        if (m.role !== 'assistant') continue;
        if (m._compacted) continue;   // 壓縮後的固定回覆，不必重播

        const bubble = chatBeginAssistant();
        _dropWait(bubble);
        bubble.streaming = false;

        const think = content.filter(b => b.type === 'thinking').map(b => b.text || '').join('');
        if (think) {
            chatStreamThinking(bubble, think);
            const t = $1('.think-title', bubble.thinkWrap);
            if (t) t.textContent = t('chat.thinkingLog');
        }

        bubble.text = content.filter(b => b.type === 'text').map(b => b.text || '').join('');
        _flushBubble(bubble);

        for (const b of content) {
            if (b.type !== 'tool_use') continue;
            const card = chatToolStart(bubble, b);
            const res = results.get(b.id);
            if (res) {
                const c = typeof res.content === 'string' ? res.content : JSON.stringify(res.content ?? '');
                chatToolEnd(card, { content: c, is_error: !!res.is_error, ms: 0 });
                card.metaEl.innerHTML = '';   // 重播沒有真實耗時，不要顯示假數字
                if (res.is_error) card.metaEl.appendChild(el('span', { class: 'ms tool-x', text: 'error' }));
            } else {
                card.root.dataset.state = 'error';
                card.metaEl.innerHTML = '';
                card.metaEl.appendChild(el('span', { class: 'tool-dur', text: '未完成' }));
            }
        }

        if (!bubble.text.trim() && !bubble.cards.size && !think) { bubble.root.remove(); continue; }
        if (!$1('.msg-actions', bubble.root)) bubble.root.appendChild(_msgActions(() => bubble.text));
    }

    _refreshRetry();
    renderTodos();
    _scrollBottom();
}

// 壓縮紀要：預設收合，點開才看得到全文
function _compactCard(text) {
    const box = _chatBox();
    if (!box) return;
    const body = el('div', { class: 'compact-body' });
    body.innerHTML = renderMarkdown(text || '');
    decorateCodeBlocks(body);
    box.appendChild(el('details', { class: 'msg sys compact-card' },
        el('summary', { class: 'compact-head' },
            el('span', { class: 'ms', text: 'bolt' }),
            el('span', { text: `先前對話摘要（已壓縮 ${OC.session?.compactions || 1} 次）` })
        ),
        body
    ));
}

function chatClear() {
    const box = _chatBox();
    if (box) box.innerHTML = '';
    _notes.clear();
    _emptyState();
    renderTodos();
    renderTokenMeter();
}


// ═══════════════════════════════════════════════════════════════
// Todo 清單
// ═══════════════════════════════════════════════════════════════

const CHAT_TODO_ICON = { completed: '✅', in_progress: '⏳', pending: '⬜' };
let _todoCollapsed = false;

function renderTodos() {
    const box = $('chat-todo');
    if (!box) return;
    const todos = OC.todos || [];

    if (!todos.length) {
        box.innerHTML = '';
        _show(box, false);
        return;
    }
    _show(box, true);
    box.innerHTML = '';

    const done = todos.filter(t => t.status === 'completed').length;
    const doing = todos.find(t => t.status === 'in_progress');

    const caret = el('span', { class: 'ms todo-caret', text: _todoCollapsed ? 'expand_more' : 'expand_less' });
    const list = el('div', { class: 'todo-list' });

    const head = el('div', { class: 'todo-head' },
        el('span', { class: 'ms', text: 'checklist' }),
        el('span', { class: 'todo-title', text: doing ? (doing.activeForm || doing.content) : '任務清單' }),
        el('span', { class: 'todo-prog', text: `${done}/${todos.length} 完成` }),
        caret
    );
    head.addEventListener('click', () => {
        _todoCollapsed = !_todoCollapsed;
        box.classList.toggle('collapsed', _todoCollapsed);
        _show(list, !_todoCollapsed);
        caret.textContent = _todoCollapsed ? 'expand_more' : 'expand_less';
    });

    for (const t of todos) {
        const cls = t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'doing' : '';
        list.appendChild(el('div', { class: 'todo-item ' + cls },
            el('span', { class: 'todo-ico', text: CHAT_TODO_ICON[t.status] || '⬜' }),
            el('span', { class: 'todo-text', text: t.content || '' })
        ));
    }

    box.classList.toggle('collapsed', _todoCollapsed);
    _show(list, !_todoCollapsed);
    box.appendChild(head);
    box.appendChild(list);
}


// ═══════════════════════════════════════════════════════════════
// Token 儀表
// ═══════════════════════════════════════════════════════════════

function renderTokenMeter() {
    const box = $('token-meter');
    if (!box) return;
    if (typeof contextUsage !== 'function') return;

    let u;
    try { u = contextUsage(); } catch { return; }
    const ratio = Math.max(0, Math.min(1, u.ratio || 0));
    const pct = Math.round(ratio * 100);
    const level = ratio >= 0.8 ? 'danger' : ratio >= 0.6 ? 'warn' : 'ok';
    const color = level === 'danger' ? 'var(--danger)' : level === 'warn' ? 'var(--warning)' : 'var(--accent)';

    let fill = $1('.tok-fill', box);
    let text = $1('.tok-text', box);
    if (!fill || !text) {
        box.innerHTML = '';
        fill = el('div', { class: 'tok-fill' });
        text = el('span', { class: 'tok-text' });
        box.appendChild(el('div', { class: 'tok-bar' }, fill));
        box.appendChild(text);
    }

    box.dataset.level = level;
    fill.style.width = pct + '%';
    fill.style.background = color;
    text.textContent = `${fmtTokens(u.used)} / ${fmtTokens(u.limit)}`;

    // 滑鼠停留看分佈
    try {
        const bd = contextBreakdown();
        const lines = [t('chat.ctxUse', { u: fmtTokens(u.used), l: fmtTokens(u.limit), p: pct })];
        for (const r of (bd.rows || [])) {
            lines.push(`　${r.label}：${fmtTokens(r.tokens)}（${Math.round(r.tokens / u.limit * 100)}%）`);
        }
        const usage = OC.usage || {};
        lines.push(t('chat.sessTotal', { i: fmtTokens(usage.in || 0), o: fmtTokens(usage.out || 0) }));
        if (ratio >= (OC.cfg.autoCompactAt || 0.75)) lines.push(t('chat.compactNext'));
        box.title = lines.join('\n');
    } catch {
        box.title = t('chat.ctxUse', { u: fmtTokens(u.used), l: fmtTokens(u.limit), p: pct });
    }
}


// ═══════════════════════════════════════════════════════════════
// 會話標題
// ═══════════════════════════════════════════════════════════════

function renderSessionTitle() {
    const title = OC.session?.title || t('chat.new');
    const node = $('session-title') || $('chat-title');
    if (node) {
        node.textContent = title;
        node.title = title;
    }
    document.title = `${title} — Omni Code`;
}


// ═══════════════════════════════════════════════════════════════
// 執行中狀態
// ═══════════════════════════════════════════════════════════════

let _runTimer = null;
let _runStart = 0;

function _runningBar() {
    let bar = $('chat-running');
    if (bar) return bar;
    const form = $('chat-form');
    if (!form || !form.parentNode) return null;
    bar = el('div', { class: 'chat-running', id: 'chat-running' },
        el('span', { class: 'spinner' }),
        el('span', { class: 'run-text', text: 'Omni Code 執行中…' }),
        el('span', { class: 'run-dur', text: '' }),
        el('button', {
            class: 'btn btn-ghost btn-xs', type: 'button', title: '中止（Esc）',
            onclick: () => window.stopAgent?.(),
        }, el('span', { class: 'ms', text: 'stop' }), document.createTextNode('停止'))
    );
    form.parentNode.insertBefore(bar, form);
    return bar;
}

// ═══════════════════════════════════════════════════════════════
// 排隊訊息（執行中打的字）
// ═══════════════════════════════════════════════════════════════
// 立刻顯示成「待送出」的泡泡，讓使用者確定自己打的東西沒有掉，
// 送進對話後再轉成正式的使用者訊息樣式。

function chatAppendQueued(text, attachments = [], idx = 0) {
    const box = _chatBox();
    if (!box) return;
    _clearEmpty();
    const bubble = el('div', { class: 'msg user queued', 'data-qidx': String(idx) },
        el('div', { class: 'q-tag' },
            el('span', { class: 'ms', text: 'schedule' }),
            el('span', { text: '待送出 — Agent 跑完這一輪就會看到' }),
            el('button', {
                class: 'q-cancel', title: '取消這則',
                onclick: (e) => {
                    e.stopPropagation();
                    const i = OC.queued.findIndex(q => q.text === text);
                    if (i >= 0) OC.queued.splice(i, 1);
                    bubble.remove();
                    window.renderQueueBadge?.();
                },
            }, el('span', { class: 'ms', text: 'close' }))
        ),
        el('div', { class: 'msg-body', text })
    );
    if (attachments.length) {
        bubble.appendChild(el('div', { class: 'q-atts', text: `（附 ${attachments.length} 張圖片）` }));
    }
    box.appendChild(bubble);
    _scrollBottom();
}

// 佇列送進對話了 → 拿掉「待送出」的外觀
function chatMarkQueuedSent() {
    for (const n of $$('.msg.queued', _chatBox())) {
        n.classList.remove('queued');
        $1('.q-tag', n)?.remove();
    }
}

function chatClearQueued() {
    for (const n of $$('.msg.queued', _chatBox())) n.remove();
}

// 停止按鈕旁的佇列計數
function renderQueueBadge() {
    const stop = $('chat-stop');
    if (!stop) return;
    let b = $1('.q-badge', stop.parentElement);
    const n = OC.queued.length;
    if (!n) { b?.remove(); return; }
    if (!b) {
        b = el('span', { class: 'q-badge', title: '待送出的訊息' });
        stop.parentElement.insertBefore(b, stop);
    }
    b.textContent = `+${n}`;
}

// 本回合建立了還原點 → 讓使用者知道 /rewind 有東西可還原。
// 一輪只會出現一次（ensureCheckpoint 只在第一次寫入時建立檢查點）。
function renderRewindHint() {
    const box = _chatBox();
    if (!box || !OC.checkpointId) return;
    if ($1(`[data-cp="${OC.checkpointId}"]`, box)) return;   // 同一個檢查點不重複提示
    _keepBottom(() => box.appendChild(el('div', {
        class: 'msg sys cp-hint', 'data-cp': OC.checkpointId,
    },
        el('span', { class: 'ms', text: 'history' }),
        el('span', { text: '已建立還原點，這一輪的檔案改動可以復原' }),
        el('button', {
            class: 'btn btn-xs btn-ghost', text: '/rewind',
            title: '查看並還原到某一輪動手前的狀態',
            onclick: () => window.handleSlash?.('/rewind'),
        })
    )));
}

function setRunningUI(running) {
    const send = $('chat-send');
    const stop = $('chat-stop');
    const input = $('chat-input');
    const attach = $('chat-attach');

    _show(send, !running);
    _show(stop, !!running);
    // 執行中「不」禁用輸入框：使用者常在看到工具輸出的當下就想補充，
    // 擋著他打字只會讓那個念頭消失。送出的訊息進佇列，下一輪邊界注入。
    if (input) {
        input.disabled = false;
        input.placeholder = running
            ? '執行中…可以先打，會排進佇列（Esc 中止）'
            : '交代一件事，或用 / 開頭下指令…';
    }
    if (attach) attach.disabled = false;
    $('oc-app')?.classList.toggle('running', !!running);

    const bar = _runningBar();
    if (!bar) return;

    if (running) {
        _runStart = Date.now();
        _show(bar, true);
        const dur = $1('.run-dur', bar);
        const tick = () => { if (dur) dur.textContent = fmtDur(Date.now() - _runStart); };
        tick();
        clearInterval(_runTimer);
        _runTimer = setInterval(tick, 1000);
    } else {
        clearInterval(_runTimer);
        _runTimer = null;
        _show(bar, false);
        if (input && !input.disabled) setTimeout(() => input.focus(), 40);
    }
}


// ═══════════════════════════════════════════════════════════════
// 零門檻任務卡（present_task）
// ═══════════════════════════════════════════════════════════════
// 跟 present_plan 的差別：plan 是計畫模式的正式提案（會切權限）；
// task 卡只是「動手前讓使用者一眼看懂」的確認，不切模式。
// 回傳 {started, label, feedback}，中止則回傳 null。
function presentTaskCard(task) {
    return new Promise(resolve => {
        const box = _chatBox();
        if (!box) { resolve(null); return; }
        _clearEmpty();

        const card = el('div', { class: 'msg sys task-card' });
        card.appendChild(el('div', { class: 'task-head' },
            el('span', { class: 'ms', text: 'assignment_turned_in' }),
            el('span', { class: 'task-head-t', text: String(task?.title || t('task.default')) })
        ));
        if (task?.plan) card.appendChild(el('div', { class: 'task-plan', text: String(task.plan) }));
        if (task?.next) card.appendChild(el('div', { class: 'task-next' },
            el('span', { class: 'ms', text: 'play_arrow' }),
            el('span', { text: t('task.next') + String(task.next) })));
        let done = false;
        const acts = el('div', { class: 'task-acts' });
        const fb = el('input', {
            class: 'inp task-feedback',
            placeholder: t('task.feedbackPh'),
        });
        const startLabel = String(task?.confirm_label || t('task.startDefault')).slice(0, 12) || t('task.startDefault');
        const finish = (started) => {
            if (done) return;
            done = true;
            OC.abort?.signal?.removeEventListener('abort', onAbort);
            const feedback = fb.value.trim();
            $$('button, input', card).forEach(n => { n.disabled = true; });
            card.classList.add('answered', started ? 'approved' : 'rejected');
            card.appendChild(el('div', { class: 'task-verdict' },
                el('span', { class: 'ms', text: started ? 'play_circle' : 'edit' }),
                el('span', {
                    text: started
                        ? t('task.started') + (feedback ? t('task.startedExtra', { fb: feedback }) : '')
                        : t('task.skip') + (feedback ? t('task.skippedExtra', { fb: feedback }) : ''),
                })
            ));
            box.scrollTop = box.scrollHeight;
            resolve({ started, label: startLabel, feedback });
        };
        const onAbort = () => {
            if (done) return;
            done = true;
            $$('button, input', card).forEach(n => { n.disabled = true; });
            resolve(null);
        };

        acts.appendChild(fb);
        acts.appendChild(el('button', {
            class: 'btn btn-sm btn-ghost', onclick: () => finish(false),
        }, el('span', { class: 'ms', text: 'edit' }), el('span', { text: t('task.skip') })));
        acts.appendChild(el('button', {
            class: 'btn btn-sm btn-primary', onclick: () => finish(true),
        }, el('span', { class: 'ms', text: 'play_arrow' }), el('span', { text: startLabel })));
        card.appendChild(acts);

        box.appendChild(card);
        box.scrollTop = box.scrollHeight;
        setTimeout(() => fb.focus(), 60);
        OC.abort?.signal?.addEventListener('abort', onAbort);
    });
}

// ═══════════════════════════════════════════════════════════════
// 稽核卡：這一輪「已做／待做」一眼看懂（借鏡 Muse 的稽核時間線）
// ═══════════════════════════════════════════════════════════════
// entries: [{tool, ok, denied, ms, sentinel}] —— 只記元數據，不記參數內容。
// pending: 還沒執行的工具名（例如被拒後剩下的、或使用者中止時沒跑的）。
function auditCard({ entries = [], pending = [], title = '' } = {}) {
    const box = _chatBox();
    if (!box) return;
    _clearEmpty();
    const ok = entries.filter(e => e.ok && !e.denied).length;
    const fail = entries.length - ok;
    const card = el('div', { class: 'msg sys audit-card' });
    card.appendChild(el('div', { class: 'audit-head' },
        el('span', { class: 'ms', text: 'receipt_long' }),
        el('span', { class: 'audit-head-t', text: title || t('audit.defaultT') }),
        el('span', { class: 'audit-badge', text: `✅ ${ok}${fail ? ` ／ ❌ ${fail}` : ''}` })
    ));
    if (entries.length) {
        const list = el('ul', { class: 'audit-list' });
        for (const e of entries.slice(-12)) {
            const mark = e.denied ? '⛔' : (e.ok ? '✅' : '❌');
            const tag = e.sentinel ? t('audit.sentinelTag') : '';
            list.appendChild(el('li', { class: 'audit-item' + (e.ok && !e.denied ? '' : ' bad') },
                el('span', { class: 'audit-mark', text: mark }),
                el('code', { class: 'audit-tool', text: String(e.tool || '?') }),
                el('span', { class: 'audit-note', text: tag + (e.ms != null ? ` ／ ${e.ms}ms` : '') })
            ));
        }
        card.appendChild(list);
    }
    if (pending.length) {
        card.appendChild(el('div', { class: 'audit-pending' },
            el('span', { class: 'ms', text: 'hourglass_top' }),
            el('span', { text: t('audit.pending') + pending.join('、') })));
    }
    card.appendChild(el('div', { class: 'hint', text: t('audit.foot') }));
    box.appendChild(card);
    box.scrollTop = box.scrollHeight;
}


// ═══════════════════════════════════════════════════════════════
// 啟動：沒有訊息就先畫歡迎卡
// ═══════════════════════════════════════════════════════════════

function _chatBoot() {
    if (!(OC.messages || []).length) _emptyState();
    renderTodos();
    renderTokenMeter();
    renderSessionTitle();
    setRunningUI(false);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _chatBoot);
else _chatBoot();


Object.assign(window, {
    // agent.js 契約
    chatAppendUser, chatBeginAssistant, chatStreamText, chatStreamThinking,
    chatToolPending, chatToolInputDelta, chatToolStart, chatToolWaiting,
    chatToolResume, chatToolEnd, chatEndAssistant,
    chatSystemNote, chatSystemNoteUpdate, chatRenderAll, chatClear,
    renderTodos, renderTokenMeter, renderSessionTitle, setRunningUI,
    askUserCard, presentPlanCard, presentTaskCard, auditCard, OCLog,
    chatAppendQueued, chatMarkQueuedSent, chatClearQueued, renderQueueBadge, renderRewindHint,
    // 其他模組可能用得到
    chatToolLabel, chatToolIcon, chatToolArg, openLightbox,
    chatRenderToolUI, chatRenderDiff, chatRenderImage, chatRenderTerminal,
    chatScrollBottom: _scrollBottom, retryLastTurn,
});
