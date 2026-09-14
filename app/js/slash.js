'use strict';
// ═══════════════════════════════════════════════════════════════
// Omni Code — 斜線指令
// ═══════════════════════════════════════════════════════════════
// 契約見 docs/ARCHITECTURE.md §16。
// agent.js 的 runAgent() 會先把開頭是「/」的輸入丟給 handleSlash()，
// 回傳 true 代表「已在本地處理完畢，不要送給模型」。
// 只有 /init 會真的呼叫模型（它把提示詞交回 runAgent 執行）。
// ═══════════════════════════════════════════════════════════════

// ─── 指令目錄（順序即 /help 的顯示順序）───────────────────────
// 顯示文字走 i18n（sl.group* / sl.d.*），這裡只留穩定的 key。
const SLASH_COMMANDS = [
    { cmd: '/help',      args: '',                  group: 'basic', desc: 'help' },
    { cmd: '/new',       args: '',                  group: 'basic', desc: 'new' },
    { cmd: '/clear',     args: '',                  group: 'basic', desc: 'clear' },
    { cmd: '/resume',    args: '',                  group: 'basic', desc: 'resume' },
    { cmd: '/sessions',  args: '',                  group: 'basic', desc: 'sessions' },
    { cmd: '/stop',      args: '',                  group: 'basic', desc: 'stop' },

    { cmd: '/context',   args: '',                  group: 'ctx', desc: 'context' },
    { cmd: '/compact',   args: '[指示]',            group: 'ctx', desc: 'compact' },
    { cmd: '/cost',      args: '',                  group: 'ctx', desc: 'cost' },
    { cmd: '/todo',      args: '',                  group: 'ctx', desc: 'todo' },
    { cmd: '/rewind',    args: '',                  group: 'ctx', desc: 'rewind' },
    { cmd: '/search',    args: '<關鍵字>',          group: 'ctx', desc: 'search' },
    { cmd: '/fork',      args: '',                  group: 'ctx', desc: 'fork' },

    { cmd: '/model',     args: '[模型]',            group: 'cfg', desc: 'model' },
    { cmd: '/mode',      args: '[模式]',            group: 'cfg', desc: 'mode' },
    { cmd: '/effort',    args: '[等級]',            group: 'cfg', desc: 'effort' },
    { cmd: '/tools',     args: '[群組 on|off]',     group: 'cfg', desc: 'tools' },
    { cmd: '/schedule',  args: '[cron|del id]',     group: 'tool', desc: 'schedule' },
    { cmd: '/apitool',   args: '[del 名稱|secret 鍵]', group: 'tool', desc: 'apitool' },
    { cmd: '/chat',      args: '',                  group: 'mode', desc: 'chat' },
    { cmd: '/project',   args: '',                  group: 'mode', desc: 'project' },
    { cmd: '/self',      args: '',                  group: 'mode', desc: 'self' },
    { cmd: '/keys',      args: '',                  group: 'cfg', desc: 'keys' },
    { cmd: '/workspace', args: '',                  group: 'cfg', desc: 'workspace' },
    { cmd: '/theme',     args: '',                  group: 'cfg', desc: 'theme' },

    { cmd: '/init',      args: '',                  group: 'proj', desc: 'init' },
    { cmd: '/memory',    args: '',                  group: 'proj', desc: 'memory' },
    { cmd: '/forget',    args: '<名稱>',            group: 'proj', desc: 'forget' },
    { cmd: '/vault',     args: '[set 代號|del 代號]', group: 'proj', desc: 'vault' },
    { cmd: '/skills',    args: '',                  group: 'proj', desc: 'skills' },
    { cmd: '/mcp',       args: '',                  group: 'proj', desc: 'mcp' },
    { cmd: '/diff',      args: '[路徑]',            group: 'proj', desc: 'diff' },
    { cmd: '/export',    args: '[md|json]',         group: 'proj', desc: 'export' },

    { cmd: '/terminal',  args: '',                  group: 'tool', desc: 'terminal' },
    { cmd: '/image',     args: '[提示詞]',          group: 'tool', desc: 'image' },
    { cmd: '/audit',     args: '[數量]',            group: 'tool', desc: 'audit' },
    { cmd: '/doctor',    args: '',                  group: 'tool', desc: 'doctor' },
];

/** 指令顯示文字（跟著介面語系走）。自訂專案指令維持原樣。 */
function slashCmdText(c) {
    if (!c || c.custom) {
        const g = c?.group === 'custom' ? t('sl.customGroup') : (c?.group || '');
        return { group: g, desc: c?.desc || t('sl.noDesc') };
    }
    const g = { basic: t('sl.groupBasic'), ctx: t('sl.groupCtx'), cfg: t('sl.groupCfg'), tool: t('sl.groupTool'), mode: t('sl.groupMode'), proj: t('sl.groupProj') }[c.group] || c.group;
    const d = t('sl.d.' + c.desc);
    return { group: g, desc: d === ('sl.d.' + c.desc) ? c.desc : d };
}

// 假設單價（USD / 1M tokens）——純粹是給費用量級用的參考尺，不是任何模型的實際定價
const COST_TIERS = [
    { label: '輕量級模型', in: 0.5, out: 2 },
    { label: '中階模型',   in: 3,   out: 15 },
    { label: '旗艦模型',   in: 15,  out: 75 },
];
const USD_TO_TWD = 32;   // 換匯假設值

// ═══════════════════════════════════════════════════════════════
// 輸出到聊天區
// ═══════════════════════════════════════════════════════════════

// 在聊天串流裡插入一張系統輸出卡（不進 OC.messages，模型看不到）
function slashOut(html, title = '') {
    const node = el('div', { class: 'msg sys slash-out' },
        el('div', { class: 'msg-body' },
            title ? el('div', { class: 'slash-title' },
                el('span', { class: 'ms', text: 'terminal' }),
                el('span', { text: title })) : null,
            el('div', { class: 'slash-content', html })
        )
    );
    const host = $('chat-scroll');
    if (!host) { alertModal(title || '指令輸出', html); return node; }
    host.appendChild(node);
    decorateCodeBlocks(node);
    host.scrollTop = host.scrollHeight;
    return node;
}

function slashMd(markdown, title = '') {
    return slashOut(renderMarkdown(markdown), title);
}

// 進度條字元（/context、/cost 用）
function slashBar(ratio, width = 16) {
    const n = Math.max(0, Math.min(width, Math.round((ratio || 0) * width)));
    return '█'.repeat(n) + '░'.repeat(width - n);
}

// 呼叫其他模組的入口，缺席時給明確提示而不是靜默失敗
function slashHook(name, ...args) {
    const f = window[name];
    if (typeof f !== 'function') { toast(t('common.notLoaded', { name }), 'warn'); return false; }
    f(...args);
    return true;
}

// ═══════════════════════════════════════════════════════════════
// 通用挑選對話框（/model、/resume 共用）
// ═══════════════════════════════════════════════════════════════
function slashPicker(title, groups, onPick) {
    const body = $('modal-generic-body');
    if (!body) { toast(t('common.noDialog'), 'error'); return; }
    $('modal-generic-title').textContent = title;
    body.innerHTML = '';

    for (const g of groups) {
        if (!g.items || !g.items.length) continue;
        if (g.label) body.appendChild(el('div', { class: 'pick-group', text: g.label }));
        for (const it of g.items) {
            body.appendChild(el('button', {
                class: 'btn btn-ghost pick-item' + (it.active ? ' active' : ''),
                onclick: () => { closeModal('modal-generic'); onPick(it); },
            },
                el('span', { class: 'pick-name', text: it.label }),
                it.hint ? el('span', { class: 'pick-hint', text: it.hint }) : null,
                it.active ? el('span', { class: 'ms', text: 'check' }) : null
            ));
        }
    }

    const acts = $('modal-generic-actions');
    acts.innerHTML = '';
    acts.appendChild(el('button', { class: 'btn btn-ghost', text: '取消', onclick: () => closeModal('modal-generic') }));
    openModal('modal-generic');
}

// ═══════════════════════════════════════════════════════════════
// 各指令實作
// ═══════════════════════════════════════════════════════════════

function cmdHelp() {
    const groups = {};
    for (const c of allSlashCommands()) {
        const tx = slashCmdText(c);
        (groups[tx.group] ||= []).push({ ...c, _g: tx.group, _d: tx.desc });
    }
    let md = t('sl.helpT') + '\n\n';
    for (const [g, list] of Object.entries(groups)) {
        md += `**${g}**\n\n`;
        for (const c of list) {
            md += `- \`${c.cmd}${c.args ? ' ' + c.args : ''}\` — ${c._d}\n`;
        }
        md += '\n';
    }
    md += t('sl.helpHint');
    slashMd(md, t('sl.helpTitle'));
}


// ─── /search：跨會話全文搜尋 ────────────────────────────────────
async function cmdSearch(q) {
    q = String(q || '').trim();
    if (q.length < 2) { window.chatSystemNote?.(t('sl.searchUsage'), 'info'); return; }
    try {
        const r = await SESS.search(q, '', 30);
        const rs = r.results || [];
        if (!rs.length) { window.chatSystemNote?.(t('sl.searchNone', { q }), 'info'); return; }
        const lines = rs.map(m => {
            const when = m.updated ? new Date(m.updated).toLocaleDateString(typeof oc_date_locale === 'function' ? oc_date_locale() : 'en-US') : '';
            const snips = (m.hits || []).map(h => `　└ ${String(h.snippet).replace(/\s+/g, ' ').slice(0, 110)}`).join('\n');
            return `▸ ${m.title || m.id}（${when}，${t('sl.searchMsgs', { n: m.msg_count })}）${t('sl.searchLoad')}\n${snips}`;
        });
        window.chatSystemNote?.(t('sl.searchHit', { q, n: rs.length }) + '\n' + lines.join('\n'), 'info');
        window.renderSessionsPanel?.();
    } catch (e) { window.chatSystemNote?.(t('sl.searchFail', { msg: e.message }), 'error'); }
}

// ─── /fork：把目前對話分支成新會話 ──────────────────────────────
// 「想試另一個做法但不想毀掉現在的進度」—— 原會話原封不動，
// 分支帶著完整歷史另起爐灶，parent 記著從哪裡分出來的。
async function cmdFork() {
    if (OC.running) { window.chatSystemNote?.(t('sl.forkBusy'), 'warn'); return; }
    if (!(OC.messages || []).length) { window.chatSystemNote?.(t('sl.forkEmpty'), 'info'); return; }
    await window.saveSession?.();                          // 先保住原會話
    const parentId = OC.session.id;
    const parentTitle = OC.session.title || t('sess.untitled');
    // 複製完整歷史。懸空的 tool_use 不用在這裡煩惱 ——
    // normalizeSession 的尾端修復會在載入時補上合成結果。
    // （不能用 safeSplitIndex：那是給壓縮找「尾段起點」用的，語意相反）
    const forked = structuredClone(OC.messages);
    OC.session = Object.assign(emptySession(), {
        id: 's-' + Date.now(),
        title: parentTitle + t('sl.forkSuffix'),
        ws: OC.ws, model: OC.cfg.model,
        parent: parentId,
        messages: forked,
        todos: structuredClone(OC.todos || []),
    });
    OC._anchor = null; OC._rcHash = 0; OC.readCache = {}; OC.turn = 0;
    await window.saveSession?.();
    window.chatRenderAll?.(); window.renderSessionTitle?.(); window.refreshSessionList?.(true);
    window.chatSystemNote?.(t('sl.forkDone', { t: parentTitle }), 'success');
}

function cmdContext() {
    const b = contextBreakdown();
    const pct = (n) => (b.limit ? (n / b.limit) : 0);
    let rows = '';
    for (const r of b.rows) {
        rows += `<tr><td>${esc(r.label)}</td>`
             + `<td class="mono">${slashBar(pct(r.tokens))}</td>`
             + `<td class="num">${esc(fmtTokens(r.tokens))}</td>`
             + `<td class="num">${(pct(r.tokens) * 100).toFixed(1)}%</td></tr>`;
    }
    const warn = b.ratio >= (OC.cfg.autoCompactAt || 0.75)
        ? `<div class="hint">${esc(t('sl.ctxOverT', { p: Math.round((OC.cfg.autoCompactAt || 0.75) * 100) }))}</div>`
        : `<div class="hint">${esc(t('sl.ctxAutoT', { p: Math.round((OC.cfg.autoCompactAt || 0.75) * 100) }))}</div>`;

    const [c0, c1, c2, c3] = t('sl.ctxCols').split('|');
    slashOut(
        `<div class="ctx-total">${esc(t('sl.ctxNow'))}<b>${esc(fmtTokens(b.used))}</b> / ${esc(fmtTokens(b.limit))}`
        + `（<b>${Math.round(b.ratio * 100)}%</b>）　${esc(t('sl.ctxModel'))}${esc(getModelInfo(OC.cfg.model).displayName)}</div>`
        + `<div class="mono ctx-bar">${slashBar(b.ratio, 32)}</div>`
        + `<table class="slash-table"><thead><tr><th>${esc(c0)}</th><th>${esc(c1)}</th><th class="num">${esc(c2)}</th><th class="num">${esc(c3)}</th></tr></thead>`
        + `<tbody>${rows}</tbody></table>`
        + `<div class="hint">${esc(t('sl.ctxMeta', { n: OC.messages.length, c: OC.session.compactions || 0 }))}</div>`
        + warn,
        t('sl.ctxTitle')
    );
}

function cmdCost() {
    const u = OC.usage || { in: 0, out: 0 };
    const total = (u.in || 0) + (u.out || 0);
    const dur = Date.now() - (OC.session.created || OC.stats.startedAt || Date.now());

    let tiers = '';
    for (const t of COST_TIERS) {
        const usd = (u.in / 1e6) * t.in + (u.out / 1e6) * t.out;
        tiers += `<tr><td>${esc(t.label)}</td>`
              + `<td class="num">$${t.in} / $${t.out}</td>`
              + `<td class="num">US$${usd.toFixed(4)}</td>`
              + `<td class="num">NT$${(usd * USD_TO_TWD).toFixed(1)}</td></tr>`;
    }

    const [tc0, tc1, tc2, tc3] = t('sl.costTierCol').split('|');
    slashOut(
        `<table class="slash-table"><tbody>`
        + `<tr><td>${esc(t('sl.costIn'))}</td><td class="num">${esc(fmtNum(u.in || 0))}</td></tr>`
        + `<tr><td>${esc(t('sl.costOut'))}</td><td class="num">${esc(fmtNum(u.out || 0))}</td></tr>`
        + `<tr><td>${esc(t('sl.costTotal'))}</td><td class="num"><b>${esc(fmtNum(total))}</b></td></tr>`
        + `<tr><td>${esc(t('sl.costTools'))}</td><td class="num">${esc(t('sl.costTimes', { n: fmtNum(OC.stats.toolCalls || 0) }))}</td></tr>`
        + `<tr><td>${esc(t('sl.costFiles'))}</td><td class="num">${esc(t('sl.costFilesN', { n: fmtNum((OC.session.files_touched || []).length) }))}</td></tr>`
        + `<tr><td>${esc(t('sl.costCompacts'))}</td><td class="num">${esc(t('sl.costTimes', { n: fmtNum(OC.session.compactions || 0) }))}</td></tr>`
        + `<tr><td>${esc(t('sl.costDur'))}</td><td class="num">${esc(fmtDur(dur))}</td></tr>`
        + `</tbody></table>`
        + `<div class="slash-sub">${esc(t('sl.costRef'))}</div>`
        + `<table class="slash-table"><thead><tr><th>${tc0}</th><th class="num">${tc1}</th><th class="num">${esc(tc2)}</th><th class="num">${esc(tc3)}</th></tr></thead>`
        + `<tbody>${tiers}</tbody></table>`
        + `<div class="hint">${t('sl.costWarn', { r: USD_TO_TWD })}</div>`,
        t('sl.costTitle')
    );
}

// ─── /rewind：把工作區還原到某一輪動手之前 ───
// 這是「敢放手讓 Agent 跑」的前提：改壞了一鍵回去。
async function cmdRewind() {
    if (!OC.session?.id) { slashMd(t('sl.noSession'), t('sl.rwTitle')); return; }

    let list = [];
    try {
        list = (await CHECKPOINT.list(OC.session.id)).checkpoints || [];
    } catch (e) {
        slashMd(t('sl.rwFail', { msg: e.message }), t('sl.rwTitle'));
        return;
    }
    if (!list.length) {
        slashMd(t('sl.rwEmpty'), t('sl.rwTitle'));
        return;
    }

    const box = el('div', { class: 'rewind-list' });
    for (const cp of list) {
        const when = fmtTime(cp.created);
        const files = cp.files.slice(0, 6).join('、') + (cp.fileCount > 6 ? ` …${t('sl.etcFiles', { n: cp.fileCount })}` : '');
        box.appendChild(el('div', { class: 'rewind-item' + (cp.restored ? ' used' : '') },
            el('div', { class: 'rewind-main' },
                el('div', { class: 'rewind-label', text: cp.label || t('sl.rwUnnamed') }),
                el('div', { class: 'rewind-meta' },
                    el('span', { text: when }),
                    el('span', { text: t('sl.rwFilesN', { n: cp.fileCount }) }),
                    cp.commands ? el('span', { class: 'rewind-warn', text: t('sl.rwCmdsN', { n: cp.commands }) }) : null,
                    cp.restored ? el('span', { class: 'rewind-used', text: t('sl.rwRestored') }) : null),
                el('div', { class: 'rewind-files', text: files })),
            el('button', {
                class: 'btn btn-xs btn-danger', text: t('sl.rwGo'),
                onclick: () => doRewind(cp),
            })
        ));
    }
    slashOut('', t('sl.rwListT')).querySelector('.slash-content').appendChild(box);
}

async function doRewind(cp) {
    const warn = cp.commands
        ? t('sl.rwCmdWarn', { n: cp.commands })
        : '';
    const ok = await confirmModal(
        t('sl.rwConfirmT'),
        t('sl.rwConfirmB', { n: cp.fileCount, label: esc(cp.label || t('sl.rwUnnamed')), warn }),
        { okText: t('sl.rwOkBtn'), danger: true }
    );
    if (!ok) return;

    try {
        const r = await CHECKPOINT.restore(OC.session.id, cp.id);
        const parts = [];
        if (r.restored?.length) parts.push(t('sl.rwFiles', { n: r.restored.length }));
        if (r.deleted?.length)  parts.push(t('sl.rwDel', { n: r.deleted.length }));
        if (r.failed?.length)   parts.push(t('sl.rwFails', { n: r.failed.length }));
        toast(parts.join('、') || t('sl.rwNothing'), r.failed?.length ? 'warn' : 'ok');

        let md = t('sl.rwDone', { label: cp.label || t('sl.rwUnnamed') });
        if (r.restored?.length) md += t('sl.rwDoneFiles', { n: r.restored.length }) + r.restored.map(p => `- \`${p}\``).join('\n') + '\n\n';
        if (r.deleted?.length)  md += t('sl.rwDoneDel', { n: r.deleted.length }) + r.deleted.map(p => `- \`${p}\``).join('\n') + '\n\n';
        if (r.failed?.length)   md += t('sl.rwDoneFail', { n: r.failed.length }) + r.failed.map(f => `- \`${f.path}\`：${f.error}`).join('\n') + '\n\n';
        if (r.commands?.length) {
            md += t('sl.rwCmdSideT') + r.commands.map(c => `- \`${c}\``).join('\n')
                + t('sl.rwCmdSideB');
        }
        slashMd(md, t('sl.rwDoneT'));

        // 磁碟變了，把畫面上的檢視同步回來 ——
        // 不重載的話，編輯器分頁還顯示著已經被還原掉的舊內容，
        // 使用者一按存檔就把還原成果又覆蓋回去了。
        await window.refreshFileTree?.();
        const touched = new Set([...(r.restored || []), ...(r.deleted || [])]);
        for (const f of [...OC.openFiles]) {
            if (touched.has(f.path)) await window.reloadOpenFile?.(f.path);
        }
        window.listSessionChanges?.();
    } catch (e) {
        slashMd(t('sl.rwFail', { msg: e.message }), t('sl.rwTitle'));
    }
}

function cmdTodo() {
    if (!OC.todos.length) {
        slashMd('目前沒有任務清單。任務比較複雜時，Omni Code 會自己用 `todo_write` 列出計畫。', '任務清單');
        return;
    }
    const icon = { completed: 'check_circle', in_progress: 'autorenew', pending: 'radio_button_unchecked' };
    const cls = { completed: 'done', in_progress: 'doing', pending: '' };
    const box = el('div', { class: 'slash-todos' });
    for (const t of OC.todos) {
        box.appendChild(el('div', { class: 'todo-item ' + (cls[t.status] || '') },
            el('span', { class: 'ms', text: icon[t.status] || 'radio_button_unchecked' }),
            el('span', { text: t.status === 'in_progress' ? (t.activeForm || t.content) : t.content })
        ));
    }
    const done = OC.todos.filter(t => t.status === 'completed').length;
    const node = slashOut('', `任務清單（${done}/${OC.todos.length} 完成）`);
    $1('.slash-content', node)?.appendChild(box);
}

async function cmdModel(arg) {
    const models = availableModels();
    if (arg) {
        const q = arg.trim().toLowerCase();
        const m = models.find(x => x.id.toLowerCase() === q)
               || API_CONFIG.models.find(x => x.id.toLowerCase() === q)
               || models.find(x => x.displayName.toLowerCase() === q)
               || models.find(x => x.id.toLowerCase().includes(q) || x.displayName.toLowerCase().includes(q));
        if (!m) {
            slashMd(t('sl.modelNoHit', { q: arg })
                + models.map(x => `- \`${x.id}\` — ${x.displayName}`).join('\n'), t('sl.modelTitle'));
            return;
        }
        slashApplyModel(m.id);
        return;
    }

    // 跟頂列的模型鈕共用同一個選單 —— 兩份清單各自維護遲早會長不一樣
    window.openModelPicker?.();
}

function slashApplyModel(id) {
    if (typeof window.setModel === 'function') window.setModel(id);
    else {
        OC.cfg.model = id;
        SETTINGS.set({ model: id }).catch(() => {});
    }
    toast(t('common.modelSwitched', { name: getModelInfo(id).displayName }), 'success', 2200);
}




// ─── /schedule：排程執行 ────────────────────────────────────────
function cmdSchedule(arg) {
    const a = String(arg || '').trim();
    const list = window.listSchedules?.() || [];

    if (!a) {
        if (!list.length) {
            window.chatSystemNote?.(t('sl.schedEmpty'), 'info');
            return;
        }
        const rows = list.map(s =>
            `- ${s.enabled ? '●' : '○'} \`${s.id}\` **${s.name}** — ${cronDescribe(s.cron)}`
            + `\n　${s.prompt.slice(0, 70)}${s.prompt.length > 70 ? '…' : ''}`
            + (s.lastRun ? `\n　${t('sl.schedLast', { t: new Date(s.lastRun).toLocaleString(typeof oc_date_locale === 'function' ? oc_date_locale() : 'en-US') })}` : ''));
        window.chatSystemNote?.(
            t('sl.schedList', { on: list.filter(s => s.enabled).length, n: list.length }) + rows.join('\n')
            + t('sl.schedListTail'), 'info');
        return;
    }

    const del = a.match(/^del(?:ete)?\s+(\w+)$/i);
    if (del) {
        window.chatSystemNote?.(window.removeSchedule?.(del[1]) ? t('sl.schedDel', { id: del[1] }) : t('sl.schedNoHit', { id: del[1] }),
            'info');
        return;
    }
    const tog = a.match(/^toggle\s+(\w+)$/i);
    if (tog) {
        const on = window.toggleSchedule?.(tog[1]);
        window.chatSystemNote?.(on === false && !list.find(s => s.id === tog[1])
            ? t('sl.schedNoHit', { id: tog[1] }) : t('sl.schedToggled', { id: tog[1], on: on ? t('sl.schedOn') : t('sl.schedOff') }), 'info');
        return;
    }

    const parts = a.split('|').map(x => x.trim());
    if (parts.length < 2) {
        window.chatSystemNote?.(t('sl.schedUsage'), 'warn');
        return;
    }
    const cron = parts[0];
    const name = parts.length >= 3 ? parts[1] : '';
    const prompt = parts.length >= 3 ? parts.slice(2).join(' | ') : parts[1];
    const r = window.addSchedule?.(cron, name, prompt);
    if (!r?.ok) { window.chatSystemNote?.(t('sl.schedCreateFail', { msg: r?.error || '?' }), 'error'); return; }
    window.chatSystemNote?.(
        t('sl.schedCreated', { name: name || prompt.slice(0, 20), desc: cronDescribe(cron) }), 'success');
}

// ─── /tools：開關能力群組 ────────────────────────────────────────
// 每次請求都送全部 34 個 schema 要 ~3,479 tokens，而多數回合根本用不到
// 生圖、影片分析、Computer-Use。關掉的群組只在系統提示留一句說明。
function cmdTools(arg) {
    const G = window.TOOL_GROUPS || {};
    const off = OC.cfg.toolGroupsOff || [];
    const parts = String(arg || '').trim().split(/\s+/).filter(Boolean);

    if (!parts.length) {
        const rows = Object.entries(G).map(([k, v]) =>
            `- ${off.includes(k) ? '○ ' + t('sl.toolsOff') : '● ' + t('sl.toolsOn')}　**${k}** — ${v.label}（${v.desc}）`);
        const n = activeTools().length;
        window.chatSystemNote?.(
            t('sl.toolsList', { n }) + rows.join('\n')
            + t('sl.toolsUsage'), 'info');
        return;
    }
    const [g, act] = [parts[0], (parts[1] || '').toLowerCase()];
    if (!G[g]) {
        window.chatSystemNote?.(t('sl.toolsUnknown', { g }) + Object.keys(G).join(' / '), 'warn');
        return;
    }
    if (act !== 'on' && act !== 'off') {
        window.chatSystemNote?.(t('sl.toolsUsage2', { g }), 'warn');
        return;
    }
    const next = act === 'off' ? [...new Set([...off, g])] : off.filter(x => x !== g);
    OC.cfg.toolGroupsOff = next;
    SETTINGS.set({ toolGroupsOff: next })
        .catch(e => toast(t('common.groupSaveFail', { msg: e.message }), 'error', 6000));
    const n = activeTools().length;
    window.chatSystemNote?.(
        t('sl.toolsToggled', { act: act === 'off' ? t('sl.toolsActOff') : t('sl.toolsActOn'), label: G[g].label, n }), 'success');
}


// ─── /apitool：管理自撰的 API 工具 ──────────────────────────────
// 工具本身是 Agent 用 edit_tool 建的（見 skills/tool-author）。
// 這裡只做「人要做的那兩件事」：看目前有什麼、填金鑰。
// 金鑰刻意不走對話 —— 貼在聊天室裡的金鑰會進上下文、進會話存檔、
// 進之後每一次 API 請求。
async function cmdApiTool(arg) {
    const parts = String(arg || '').trim().split(/\s+/).filter(Boolean);
    const sub = (parts[0] || '').toLowerCase();

    if (sub === 'del') {
        const name = parts[1];
        if (!name) { window.chatSystemNote?.(t('sl.apiDelUsage'), 'warn'); return; }
        if (!await confirmModal(t('sl.apiDelT'), t('sl.apiDelB', { name: esc(name) }))) return;
        try {
            await UTOOLS.remove(name);
            await window.loadUserTools?.(true);
            window.chatSystemNote?.(t('sl.apiDeleted', { name }), 'success');
        } catch (e) { toast(t('common.secretDelFail', { msg: e.message }), 'error', 6000); }
        return;
    }

    if (sub === 'secret') {
        const key = parts[1];
        if (!key) { window.chatSystemNote?.(t('sl.apiSecUsage'), 'warn'); return; }
        const v = await promptModal(t('sl.apiSecT', { key }), t('sl.apiSecPh'), '', {
            type: 'password', okText: t('common.save'),
            hint: t('sl.apiSecHint', { key }),
        });
        if (v === null) return;
        try {
            const r = await UTOOLS.secretSet(key, v);
            window.chatSystemNote?.(
                (v === '' ? t('sl.apiSecDel', { key }) : t('sl.apiSecSet', { key }))
                + t('sl.apiKeysN', { n: r.keys.length }) + (r.keys.join('、') || t('sl.apiKeysNone')), 'success');
        } catch (e) { toast(t('common.secretSaveFail', { msg: e.message }), 'error', 6000); }
        return;
    }

    // 清單
    try {
        const [tl, sl] = await Promise.all([UTOOLS.list(), UTOOLS.secretList()]);
        const tools = tl.tools || [];
        const on = window.TOOL_GROUPS && !(OC.cfg.toolGroupsOff || []).includes('usertools');
        const rows = tools.length
            ? tools.map(x => `- **${x.name}** — ${String(x.description || '').split('\n')[0]}\n  `
                + `\`${(x.request?.method || 'GET')} ${String(x.request?.url || '').slice(0, 70)}\``).join('\n')
            : t('sl.apiEmpty');
        window.chatSystemNote?.(
            t('sl.apiToolsT') + (on ? '' : t('sl.apiOffWarn')) + '：\n'
            + rows
            + t('sl.apiListTail') + ((sl.keys || []).join('、') || t('sl.apiKeysNone'))
            + t('sl.apiListHelp'), 'info');
    } catch (e) {
        window.chatSystemNote?.(t('sl.apiListFail', { msg: e.message }), 'error');
    }
}

// ─── /forget：忘記一則記憶（使用者的忘記權）────────────────────────
async function cmdForget(arg) {
    const name = String(arg || '').trim();
    if (!name) {
        window.chatSystemNote?.(t('sl.forgetUsage'), 'warn');
        return;
    }
    const ok = await confirmModal(t('sl.forgetT'),
        `<div class="cf-msg">${t('sl.forgetB', { name: esc(name) })}</div>`,
        { danger: true, okText: t('sl.forgetOk') });
    if (!ok) return;
    for (const scope of ['project', 'user']) {
        try {
            await window.deleteMemory?.(name, scope);
            window.chatSystemNote?.(t('sl.forgot', { name }), 'success');
            return;
        } catch { /* 換另一個範圍試試 */ }
    }
    window.chatSystemNote?.(t('sl.forgetNoHit', { name }), 'warn');
}

// ─── /vault：憑證保險庫（值永不顯示）────────────────────────────────
async function cmdVault(arg) {
    const parts = String(arg || '').trim().split(/\s+/).filter(Boolean);
    const sub = (parts[0] || '').toLowerCase();
    if (sub === 'set') {
        const key = parts[1] || '';
        if (!key) { window.chatSystemNote?.(t('sl.vaultSetUsage'), 'warn'); return; }
        // 金鑰刻意不走對話 —— 貼在聊天室的值會進上下文、進會話存檔
        const v = await promptModal(t('sl.vaultSetT', { key }), t('sl.vaultSetPh'), '', {
            type: 'password', okText: t('common.save'),
            hint: t('sl.vaultSetHint', { key }),
        });
        if (v === null) return;
        try {
            const r = await VAULT.set(key, v);
            window.chatSystemNote?.(
                (v === '' ? t('sl.vaultSetDel', { key }) : t('sl.vaultSetPut', { key }))
                + t('sl.vaultCount', { n: r.keys.length }) + (r.keys.join('、') || t('sl.vaultNone')), 'success');
        } catch (e) { toast(t('common.secretSaveFail', { msg: e.message }), 'error', 6000); }
        return;
    }
    if (sub === 'del' || sub === 'delete' || sub === 'rm') {
        const key = parts[1] || '';
        if (!key) { window.chatSystemNote?.(t('sl.vaultDelUsage'), 'warn'); return; }
        if (!await confirmModal(t('sl.vaultDelT'), t('sl.vaultDelB', { key: esc(key) }), { danger: true, okText: t('common.del') })) return;
        try {
            await VAULT.set(key, '');
            window.chatSystemNote?.(t('sl.vaultDeleted', { key }), 'success');
        } catch (e) { toast(t('common.secretDelFail', { msg: e.message }), 'error', 6000); }
        return;
    }
    try {
        const r = await VAULT.list();
        const keys = r.keys || [];
        window.chatSystemNote?.(
            t('sl.vaultListT', { n: keys.length })
            + (keys.length ? keys.map(k => `- \`${k}\`（引用寫法：\`{{VAULT:${k}}}\`）`).join('\n') : t('sl.vaultNone'))
            + t('sl.vaultHelp'), 'info');
    } catch (e) {
        window.chatSystemNote?.(t('sl.vaultListFail', { msg: e.message }), 'error');
    }
}

// ─── /effort：推理強度（同 Claude Code 的 /effort）───────────────
function cmdEffort(arg) {
    const a = String(arg || '').trim().toLowerCase();
    if (!a) { window.openEffortPicker?.(); return; }
    if (API_CONFIG.effort.levels[a]) { window.setEffortLevel?.(a); return; }
    window.chatSystemNote?.(
        t('sl.effortUnknown', { a }) + API_CONFIG.effort.order.join(' / '), 'warn');
}

async function cmdMode(arg) {
    if (!arg) { await cyclePermissionMode(); return; }
    const q = arg.trim().toLowerCase();
    const byLabel = Object.entries(window.PERM_MODES).find(([, v]) => v.label === arg.trim());
    const key = Object.keys(window.PERM_MODES).find(k => k.toLowerCase() === q) || byLabel?.[0];
    if (!key) {
        const metaOf = (k) => (typeof permModeMeta === 'function' ? permModeMeta(k) : null) || window.PERM_MODES[k] || {};
        slashMd(t('sl.modeUnknown')
            + Object.keys(window.PERM_MODES).map(k => `- \`${k}\`（${metaOf(k).label || k}）— ${metaOf(k).desc || ''}`).join('\n'),
            t('sl.modeTitle'));
        return;
    }
    await setPermissionMode(key);
}

async function cmdDiff(arg) {
    slashHook('switchDock', 'diff');
    const path = (arg || '').trim() || OC.activeFile;
    if (path) {
        if (typeof window.showFileDiff === 'function') await window.showFileDiff(path);
        else toast(t('common.diffNotLoaded'), 'warn');
        return;
    }
    const files = [...new Set(OC.session.files_touched || [])];
    if (!files.length) { slashMd(t('sl.diffNoChange'), t('sl.diffSessFilesT')); return; }
    const node = slashOut('', t('sl.diffFilesT'));
    const box = el('div', { class: 'slash-files' });
    for (const f of files) {
        box.appendChild(el('button', {
            class: 'chip', title: f,
            onclick: () => window.showFileDiff?.(f),
        }, el('span', { class: 'ms', text: fileIcon(f) }), el('span', { text: shortPath(f, 40) })));
    }
    $1('.slash-content', node)?.appendChild(box);
}

async function cmdResume() {
    let list = [];
    try { const r = await SESS.list(20); list = r.sessions || []; }
    catch (e) { toast(t('common.sessListFail', { msg: e.message }), 'error'); return; }
    if (!list.length) { slashMd(t('sl.resumeNone'), t('sl.resumeT')); return; }
    const curWs = OC.ws || OC.cfg.workspace || '';
    // 置頂的排前面，並掛上圖釘標示（後端 list 已依 updated 新→舊，置頂區內維持該順序）
    const sorted = list.slice().sort((a, b) => (!!b.pinned - !!a.pinned) || (b.updated - a.updated));
    const items = sorted.map(s => ({
        label: (s.pinned ? '📌 ' : '') + (s.title || t('sess.untitled')),
        hint: `${fmtTime(s.updated)}　${t('sl.searchMsgs', { n: s.msg_count })}　${fmtTokens(s.tokens)} tokens`
            // slash.js 在 sessions.js 之後載入，_sameWs 取得到（見 ARCHITECTURE.md §9）
            + (s.ws && !_sameWs(s.ws, curWs) ? t('sl.otherWs') : ''),
        active: s.id === OC.session.id,
        id: s.id,
    }));
    slashPicker(t('sl.resumePick'), [{ label: '', items }], (it) => window.loadSession?.(it.id));
}

function cmdInit() {
    const prompt = `請幫這個專案建立 OMNI.md（等同 Claude Code 的 CLAUDE.md），流程如下：

1. 先用 project_tree（depth 3）看整體結構。
2. 讀取實際存在的關鍵檔案來判斷專案性質——例如 package.json、composer.json、requirements.txt、
   go.mod、Cargo.toml、README.md、Makefile、docker-compose.yml、.env.example、既有的設定檔。
   不要臆測；沒有的檔案就別提。
3. 用 glob / grep 抽樣看幾個主要原始碼檔，歸納出真正在用的命名、縮排、註解、模組化與錯誤處理慣例。
4. 用 write_file 在工作區根目錄寫出 OMNI.md，內容用繁體中文（台灣用語），包含且只包含這六節：

## 專案用途
一到三句話講清楚這個專案在做什麼、給誰用。

## 技術棧
語言、框架、資料庫、重要套件與版本；註明是從哪個檔案讀到的。

## 目錄結構
只列有意義的目錄與代表性檔案，每行一句話說明它負責什麼。不要貼完整檔案樹。

## 開發常用指令
安裝、啟動、建置、測試、lint。指令要能直接複製執行，並註明從 package.json scripts 或 README 何處取得。
沒有找到就寫「未定義」，不要自己編。

## 程式風格慣例
從實際程式碼歸納：縮排、引號、命名、檔案組織、註解語言、錯誤處理方式。寫成「請這樣做」的形式。

## 注意事項
接手的人容易踩到的坑：不可修改的檔案、生成物、環境依賴、已知限制、部署前提。

規則：
- 這份文件每一輪都會被注入到系統提示裡，所以要精簡、可執行，控制在 200 行以內。
- 只寫「從程式碼看不出來、或要翻很久才知道」的事，不要複述顯而易見的內容。
- 若 OMNI.md 已存在，先讀它，保留仍然正確的內容再增修，不要整份覆蓋掉人工寫的段落。
- 寫完後用一句話回報你放了哪些重點。`;

    slashMd(t('sl.initDoing'), t('sl.initT'));
    // 不 await：讓 handleSlash 立刻回傳，交由 runAgent 自己的迴圈與 UI 狀態接手
    window.runAgent?.(prompt);
}

// ─── /audit：工具稽核紀錄 ───────────────────────────────────────
// 「剛才 AI 到底做了什麼？」—— 只看做了什麼、成功失敗，不看參數內容。
// 稽核只記元數據（學 OpenClaw 的 audit ledger），參數與輸出不會落地。
async function cmdAudit(arg) {
    const n = Math.max(1, Math.min(200, parseInt(arg, 10) || 50));
    let r;
    try {
        r = await SETTINGS.auditList(n, OC.session?.id || '');
    } catch (e) {
        slashMd(t('sl.auditReadFail', { msg: e.message }), t('sl.auditT'));
        return;
    }
    const es = r.entries || [];
    if (!es.length) {
        slashMd(t('sl.auditEmpty'), t('sl.auditT'));
        return;
    }
    const fail = es.filter(e => !e.ok).length;
    const rows = es.map(e => {
        const t = String(e.ts || '').replace('T', ' ').slice(0, 19);
        const mark = e.denied ? '⛔' : (e.ok ? '✅' : '❌');
        const ms = e.ms != null ? ` ／ ${e.ms}ms` : '';
        const st = e.sentinel ? ' 🛡' : '';
        return `<tr><td class="mono">${esc(t)}</td><td>${mark} <code>${esc(e.tool)}</code>${st}${ms}</td></tr>`;
    }).join('');
    slashOut(
        `<div class="ctx-total">${esc(t('sl.auditSum', { n: es.length, ok: es.length - fail, fail }))}</div>`
        + `<table class="slash-table"><thead><tr><th>${esc(t('sl.auditTime'))}</th><th>${esc(t('sl.auditTool'))}</th></tr></thead><tbody>${rows}</tbody></table>`
        + `<div class="hint">${t('sl.auditHint')}</div>`,
        t('sl.auditT')
    );
}

// ─── /doctor 健檢 ───────────────────────────────────────────────
async function cmdDoctor() {
    const node = slashOut(`<div class="doctor-wait"><span class="spinner"></span> ${esc(t('sl.docDoing'))}</div>`, t('sl.docT'));
    const rows = [];
    const add = (ok, label, detail, fix) => rows.push({ ok, label, detail, fix });

    // 1) 後端設定端點
    let cfg = null, env = null;
    try {
        const r = await SETTINGS.get();
        cfg = r.config || {};
        env = r.env || {};
        add(true, t('sl.docBackend'), `PHP ${env.php || '?'}／${env.os || '?'}`);
    } catch (e) {
        add(false, t('sl.docBackend'), e.message, t('sl.docBackendFail'));
    }

    // 2) 工作區
    if (env) {
        const okWs = !!env.workspace_exists;
        add(okWs && !!env.workspace_writable, t('sl.docWs'),
            `${cfg?.workspace || OC.ws || t('sl.docUnset')}`
            + `｜${t('sl.docExist')}：${env.workspace_exists ? t('sl.docYes') : t('sl.docNo')}｜${t('sl.docWritable')}：${env.workspace_writable ? t('sl.docYes') : t('sl.docNo')}`,
            okWs ? (env.workspace_writable ? '' : t('sl.docWsReadonly'))
                 : t('sl.docWsMissing'));
    }

    // 3) 檔案系統讀取
    try {
        const st = await FS.stat('');
        add(!!st.exists, t('sl.docFs'), st.exists ? t('sl.docFsOk') : t('sl.docFsBad'),
            st.exists ? '' : t('sl.docFsFix'));
    } catch (e) {
        add(false, t('sl.docFs'), e.message, t('sl.docFsPhpFix'));
    }

    // 4) 命令執行
    try {
        const r = await EXEC.run('echo ok', '', 15000);
        const out = (r.stdout || '').trim();
        add(r.exit_code === 0 && /ok/i.test(out), t('sl.docExec'),
            t('sl.docExecDetail', { code: r.exit_code, out: esc(out.slice(0, 40)) }),
            r.exit_code === 0 ? '' : t('sl.docExecFix'));
    } catch (e) {
        add(false, t('sl.docExec'), e.message, t('sl.docExecIniFix'));
    }

    // 5) API 金鑰
    const serverKeys = cfg?.keysOnServer || {};
    let anyKey = false;
    for (const [pid, p] of Object.entries(API_CONFIG.providers)) {
        const local = !!getProviderKey(pid);
        const onServer = !!serverKeys[pid];
        if (local || onServer) anyKey = true;
        add(local || onServer, t('sl.docKey', { label: p.label }),
            local ? t('sl.docKeyLocal') : (onServer ? t('sl.docKeyServer') : t('sl.docKeyNone')),
            (local || onServer) ? '' : t('sl.docKeyFix', { u: p.keyUrlText }));
    }
    if (!anyKey) add(false, t('sl.docNoModel'), t('sl.docNoModelD'), t('sl.docNoModelFix'));

    // 6) CDN 全域物件
    const cdn = [
        ['marked', typeof marked !== 'undefined', t('sl.docCdnMarked')],
        ['DOMPurify', typeof DOMPurify !== 'undefined', t('sl.docCdnPurify')],
        ['highlight.js', typeof hljs !== 'undefined', t('sl.docCdnHljs')],
        ['CodeMirror', typeof CodeMirror !== 'undefined', t('sl.docCdnCm')],
        ['diff_match_patch', typeof diff_match_patch !== 'undefined', t('sl.docCdnDmp')],
    ];
    for (const [name, ok, impact] of cdn) {
        add(ok, t('sl.docCdn', { name }), ok ? t('sl.docCdnOk') : t('sl.docCdnBad'), ok ? '' : t('sl.docCdnFix', { impact }));
    }

    // 7) MCP
    try {
        const r = await MCPAPI.servers();
        const srvs = r.servers || {};
        const names = Object.keys(srvs);
        if (!names.length) add(null, t('sl.docMcp'), t('sl.docMcpNone'), t('sl.docMcpFix'));
        else {
            const bad = names.filter(n => srvs[n].error);
            add(!bad.length, t('sl.docMcp'),
                names.map(n => `${n}（${srvs[n].type}${srvs[n].enabled ? '' : t('sl.docMcpDisabledSuffix')}${srvs[n].error ? t('sl.docMcpErrSuffix') : t('sl.docMcpToolsSuffix', { n: srvs[n].tool_count })}）`).join('、'),
                bad.length ? t('sl.docMcpBad', { names: bad.join('、') }) : '');
        }
    } catch (e) {
        add(false, t('sl.docMcp'), e.message, t('sl.docMcpPhpFix'));
    }

    // ─── 輸出 ───
    const icon = (ok) => ok === null ? '<span class="ms doctor-skip">remove</span>'
        : (ok ? '<span class="ms doctor-ok">check_circle</span>' : '<span class="ms doctor-bad">cancel</span>');
    let html = '<div class="doctor-list">';
    for (const r of rows) {
        html += `<div class="doctor-row${r.ok === false ? ' bad' : ''}">`
             + `${icon(r.ok)}<div class="doctor-body">`
             + `<div class="doctor-label">${esc(r.label)}</div>`
             + (r.detail ? `<div class="doctor-detail">${esc(r.detail)}</div>` : '')
             + (r.fix ? `<div class="doctor-fix">→ ${esc(r.fix)}</div>` : '')
             + `</div></div>`;
    }
    html += '</div>';
    const bad = rows.filter(r => r.ok === false).length;
    html += `<div class="hint">${bad ? esc(t('sl.docNeedFix', { n: bad })) : esc(t('sl.docAllOk'))}</div>`;
    const content = $1('.slash-content', node);
    if (content && document.body.contains(node)) content.innerHTML = html;
    else alertModal(t('sl.docT'), html);   // 沒有聊天區可插入時（例如面板還沒建好）改用對話框
}

// ═══════════════════════════════════════════════════════════════
// 主派送
// ═══════════════════════════════════════════════════════════════
async function handleSlash(text) {
    const raw = String(text || '').trim();
    // 只吃「/指令」形式；像 /usr/bin/php 這種路徑不會被誤判成指令
    const m = raw.match(/^\/([A-Za-z][A-Za-z0-9-]*)(?:\s+([\s\S]*))?$/);
    if (!m) return false;

    const cmd = '/' + m[1].toLowerCase();
    const arg = (m[2] || '').trim();
    const known = SLASH_COMMANDS.some(c => c.cmd === cmd);

    if (!known) {
        const near = slashSuggestions(cmd).slice(0, 5);
        slashMd(t('sl.unknown', { cmd })
            + (near.length ? t('sl.maybe') + near.map(c => `- \`${c.cmd}\` — ${slashCmdText(c).desc}`).join('\n') : '')
            + t('sl.seeHelp'), t('sl.title'));
        return true;
    }

    // 送出後就把輸入框清空（app.js 通常也會做，這裡保險）
    const inp = $('chat-input');
    if (inp && inp.value.trim() === raw) { inp.value = ''; inp.dispatchEvent(new Event('input', { bubbles: true })); }
    hideSlashPopup();

    try {
        switch (cmd) {
            case '/help':      cmdHelp(); break;
            case '/new':       await window.newSession?.(); break;
            case '/clear':     await window.newSession?.(); break;
            case '/resume':    await cmdResume(); break;
            case '/sessions':  slashHook('switchPanel', 'sessions'); window.renderSessionsPanel?.(); break;
            case '/stop':      window.stopAgent?.(); break;

            case '/context':   cmdContext(); break;
            case '/compact':   await compactContext({ instruction: arg }); break;
            case '/cost':      cmdCost(); break;
            case '/todo':      cmdTodo(); break;
            case '/rewind':    await cmdRewind(); break;
            case '/search':    await cmdSearch(arg); break;
            case '/fork':      await cmdFork(); break;

            case '/model':     await cmdModel(arg); break;
            case '/effort':    cmdEffort(arg); break;
            case '/tools':     cmdTools(arg); break;
            case '/schedule':  cmdSchedule(arg); break;
            case '/apitool':   await cmdApiTool(arg); break;
            case '/mode':      await cmdMode(arg); break;
            case '/keys':      slashHook('openKeysModal'); break;
            case '/chat':      await window.setMode?.('chat'); break;
            case '/project':   await window.setMode?.('project'); break;
            case '/self':      await window.setMode?.('self'); slashHook('switchPanel', 'self'); break;
            case '/workspace': slashHook('openWorkspacePicker'); break;
            case '/theme':     toggleTheme(); break;

            case '/init':      cmdInit(); break;
            case '/memory':    slashHook('switchPanel', 'memory'); window.renderMemoryPanel?.(); break;
            case '/forget':    await cmdForget(arg); break;
            case '/vault':     await cmdVault(arg); break;
            case '/skills':    slashHook('switchPanel', 'skills'); window.renderSkillsPanel?.(); window.loadSkills?.(true); break;
            case '/mcp':       slashHook('switchPanel', 'mcp'); window.renderMcpPanel?.(); break;
            case '/diff':      await cmdDiff(arg); break;
            case '/export':    await window.exportSession?.(arg === 'json' ? 'json' : 'md'); break;

            case '/terminal':  slashHook('switchDock', 'terminal'); break;
            case '/image':     slashHook('openImageStudio', arg); break;
            case '/audit':     await cmdAudit(arg); break;
            case '/doctor':    await cmdDoctor(); break;

            default: {
                // 不是內建指令 → 查專案自訂指令（.omni/commands/*.md）
                const name = cmd.slice(1).toLowerCase();
                const def = (OC.commands || []).find(c => c.name.toLowerCase() === name);
                if (!def) return false;          // 交還給 runAgent 當成普通訊息
                const prompt = expandCommandPrompt(def.prompt, arg);
                if (!prompt.trim()) {
                    slashMd(`指令 \`${cmd}\` 的內容是空的（${def.path}）。`, '專案指令');
                    return true;
                }
                if (def.model) setModel(def.model);
                slashMd(`執行專案指令 \`${cmd}\`（${def.path}）`, '專案指令');
                // 不 await：跟 /init 一樣把展開後的提示交給 runAgent 自己的迴圈
                window.runAgent?.(prompt);
                return true;
            }
        }
    } catch (e) {
        console.error('[slash]', cmd, e);
        slashMd(`指令 \`${cmd}\` 執行失敗：${e.message}`, '錯誤');
    }
    return true;
}

// ═══════════════════════════════════════════════════════════════
// 自動補全
// ═══════════════════════════════════════════════════════════════

// prefix 可帶或不帶開頭的斜線
// 內建 + 專案自訂（.omni/commands/*.md）
function allSlashCommands() {
    const custom = (OC.commands || []).map(c => ({
        cmd: '/' + c.name,
        args: c.args || '',
        group: 'custom',
        desc: c.description || t('sl.noDesc'),
        custom: true,
    }));
    // 自訂指令排在後面，不會蓋掉同名內建指令的位置
    const builtinNames = new Set(SLASH_COMMANDS.map(c => c.cmd));
    return [...SLASH_COMMANDS, ...custom.filter(c => !builtinNames.has(c.cmd))];
}

function slashSuggestions(prefix) {
    const all = allSlashCommands();
    const q = String(prefix || '').replace(/^\//, '').trim().toLowerCase();
    if (!q) return all.slice();
    const name = (c) => c.cmd.slice(1);
    const starts = all.filter(c => name(c).startsWith(q));
    const inside = all.filter(c => !name(c).startsWith(q) && (name(c).includes(q) || slashCmdText(c).desc.includes(q)));
    return [...starts, ...inside];
}

// 載入專案自訂指令
async function loadCommands(force = false) {
    try {
        const r = await SESS.commands();
        OC.commands = r.commands || [];
    } catch { OC.commands = []; }
    return OC.commands;
}

// 自訂指令：把正文當提示模板送給模型
// $ARGUMENTS = 全部參數；$1..$9 = 依空白切開的第 n 個
function expandCommandPrompt(tpl, argStr) {
    const args = String(argStr || '').trim();
    const parts = args ? args.split(/\s+/) : [];
    // 先換 $ARGUMENTS，再由大到小換 $9..$1
    //（由小到大的話，$1 會先把 $10 的前綴吃掉）
    let out = String(tpl || '').replace(/\$ARGUMENTS/g, args);
    for (let i = 9; i >= 1; i--) {
        out = out.replace(new RegExp('\\$' + i, 'g'), parts[i - 1] || '');
    }
    return out;
}

let _slashPop = null;
let _slashPopItems = [];
let _slashPopSel = 0;
let _slashPopQuery = null;

function slashPopupEl() {
    if (_slashPop && document.body.contains(_slashPop)) return _slashPop;
    _slashPop = el('div', { class: 'card slash-pop', id: 'slash-pop' });
    _slashPop.hidden = true;
    _slashPop.style.display = 'none';
    _slashPop.style.overflowY = 'auto';
    document.body.appendChild(_slashPop);
    return _slashPop;
}

// 以輸入框的實際位置定位（fixed + 執行期算出的座標，不寫死在 CSS）
function positionSlashPopup() {
    const inp = $('chat-input');
    const pop = slashPopupEl();
    if (!inp) return;
    const r = inp.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.left = Math.round(r.left) + 'px';
    pop.style.width = Math.round(Math.max(280, r.width)) + 'px';
    pop.style.bottom = Math.round(window.innerHeight - r.top + 8) + 'px';
    pop.style.maxHeight = Math.round(Math.max(120, Math.min(340, r.top - 24))) + 'px';
    pop.style.zIndex = '90';
}

function hideSlashPopup() {
    if (_slashPop) { _slashPop.hidden = true; _slashPop.style.display = 'none'; }
    _slashPopItems = [];
    _slashPopSel = 0;
    _slashPopQuery = null;
}

function paintSlashPopup() {
    const pop = slashPopupEl();
    pop.innerHTML = '';
    _slashPopItems.forEach((c, i) => {
        pop.appendChild(el('div', {
            class: 'slash-opt' + (i === _slashPopSel ? ' sel' : ''),
            onmousedown: (e) => { e.preventDefault(); _slashPopSel = i; acceptSlashSuggestion(); },
            onmouseenter: () => { _slashPopSel = i; paintSlashPopup(); },
        },
            el('span', { class: 'slash-opt-cmd', text: c.cmd }),
            c.args ? el('span', { class: 'slash-opt-args', text: c.args }) : null,
            el('span', { class: 'slash-opt-desc', text: slashCmdText(c).desc })
        ));
    });
    pop.hidden = false;
    pop.style.display = 'block';
    positionSlashPopup();
    // 讓選中項保持在可視範圍內
    pop.children[_slashPopSel]?.scrollIntoView({ block: 'nearest' });
}

function updateSlashPopup() {
    const inp = $('chat-input');
    if (!inp) return;
    const v = inp.value;
    // 只在「第一行、只有指令本身、還沒開始打參數」時提示
    if (!/^\/[A-Za-z0-9-]*$/.test(v)) { hideSlashPopup(); return; }
    // 已經是完整指令就收起來，否則 Enter 會一直在補全而送不出去
    if (SLASH_COMMANDS.some(c => c.cmd === v.toLowerCase())) { hideSlashPopup(); return; }
    _slashPopItems = slashSuggestions(v).slice(0, 12);
    if (!_slashPopItems.length) { hideSlashPopup(); return; }
    if (_slashPopQuery !== v) { _slashPopQuery = v; _slashPopSel = 0; }
    if (_slashPopSel >= _slashPopItems.length) _slashPopSel = 0;
    paintSlashPopup();
}

function acceptSlashSuggestion() {
    const c = _slashPopItems[_slashPopSel];
    const inp = $('chat-input');
    if (!c || !inp) return false;
    inp.value = c.cmd + (c.args ? ' ' : '');
    hideSlashPopup();
    inp.focus();
    try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch {}
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
}

function onSlashKeydown(e) {
    if (!_slashPop || _slashPop.hidden || !_slashPopItems.length) return;
    if (e.key === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation();
        _slashPopSel = (_slashPopSel + 1) % _slashPopItems.length; paintSlashPopup();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        _slashPopSel = (_slashPopSel - 1 + _slashPopItems.length) % _slashPopItems.length; paintSlashPopup();
    // 只吃純 Tab：Shift+Tab 是全域的 Mode 循環，選單開著時也不該被搶走
    } else if ((e.key === 'Tab' && !e.shiftKey) || (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey)) {
        e.preventDefault(); e.stopPropagation();
        acceptSlashSuggestion();
    } else if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        hideSlashPopup();
    }
}

function initSlash() {
    const inp = $('chat-input');
    if (!inp) return;
    inp.addEventListener('input', updateSlashPopup);
    inp.addEventListener('keydown', onSlashKeydown, true);   // 捕獲階段：搶在「Enter 送出」之前
    inp.addEventListener('blur', () => setTimeout(hideSlashPopup, 120));
    window.addEventListener('resize', () => { if (_slashPop && !_slashPop.hidden) positionSlashPopup(); });
}

// ═══════════════════════════════════════════════════════════════
Object.assign(window, {
    handleSlash, slashSuggestions, initSlash, SLASH_COMMANDS,
    allSlashCommands, loadCommands, expandCommandPrompt,
    slashOut, slashMd, hideSlashPopup,
});
