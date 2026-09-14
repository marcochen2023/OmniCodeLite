'use strict';
// ═══════════════════════════════════════════════════════════════
// Omni Code — 技能面板（#panel-skills）
// ═══════════════════════════════════════════════════════════════
// 契約見 docs/ARCHITECTURE.md §14。
// 技能的掃描與載入邏輯在後端（api/sessions.php）與 agent.js（window.loadSkills），
// 本檔只負責「呈現與維護」：列出、檢視內文、新增、刪除、一鍵套用。
//
// 漸進式揭露：system prompt 只放 name — description，
// 模型呼叫 skill(name) 後才注入 SKILL.md 全文，所以描述寫得好壞決定了技能會不會被用到。
// ═══════════════════════════════════════════════════════════════

const SKILL_SCOPES = [
    { id: 'builtin', label: '內建', icon: 'inventory_2', hint: 'OmniCode/skills/ 下的共用技能，所有工作區都看得到' },
    { id: 'project', label: '本專案', icon: 'folder_special', hint: '<工作區>/.omni/skills/ 下的技能，只在這個專案生效' },
];

// 分區標籤跟著介面語系走（跟 memTypeLabel 同一招）
function skillScopeMeta(id) {
    const base = SKILL_SCOPES.find(s => s.id === id) || SKILL_SCOPES[0];
    if (typeof t !== 'function') return base;
    if (id === 'builtin') return { ...base, label: t('skl.scopeBuiltin'), hint: t('skl.scopeBuiltinH') };
    return { ...base, label: t('skl.scopeProj'), hint: t('skl.scopeProjH') };
}

// 8 段固定章節（agency-agents 風格）。文件版完整模板見 skills/SKILL-TEMPLATE.md。
// 唯一差異：第八段「Advanced Capabilities」改為「與其他技能的協作」——
// Omni Code 一次只跑一個 skill，但可以接力其他 skill 的產出。
const SKILL_TEMPLATE = `## 1. 你的身份與人格
- **角色**：
- **性格**：
- **你記得的事**：

## 2. 核心使命
（這個技能存在的目的，一句話講完）

### 子使命
- 子使命 A
- 子使命 B

## 3. 必須遵守的鐵則
（不可妥協的行為準則，做了就會壞的那種）

## 4. 技術交付物
（要給使用者什麼具體成果：檔案、訊息、UI、報表…）

\`\`\`
（範例輸出格式或程式碼片段）
\`\`\`

## 5. 工作流程
1. 步驟一
2. 步驟二
3. 步驟三

## 6. 溝通風格
- 例句 1
- 例句 2

## 7. 成功指標
（怎樣算「這次做對了」）
- 指標 A
- 指標 B

## 8. 與其他技能的協作
- 這個技能可能會接力哪個 skill 的輸出
- 它的產出可能被哪個 skill 接著用
`;

// ═══════════════════════════════════════════════════════════════
// 面板骨架
// ═══════════════════════════════════════════════════════════════

function skillsHost(force = false) {
    const host = $('panel-skills');
    if (!host) return null;
    if (!force && host.dataset.ready === '1') return host;
    host.dataset.ready = '1';
    host.innerHTML = '';

    host.appendChild(el('div', { class: 'panel-head' },
        el('span', { class: 'panel-title' },
            el('span', { class: 'ms', text: 'auto_awesome' }),
            el('span', { text: t('panel.skills') })),
        el('div', { class: 'panel-head-acts' },
            el('button', {
                class: 'btn btn-xs btn-ghost', title: t('skl.newT'),
                onclick: () => createSkill(),
            }, el('span', { class: 'ms', text: 'add' }), el('span', { text: t('skl.newOne') })),
            el('button', {
                class: 'btn-icon', title: t('skl.rescan'),
                onclick: () => { window.loadSkills?.(true); },
            }, el('span', { class: 'ms', text: 'refresh' }))
        )
    ));

    // 清單一定要包在 .panel-body 裡：.oc-panel 是 flex 直向容器，
    // 只有 .panel-body 帶 flex:1 + min-height:0 + overflow-y:auto。
    // 直接掛在面板上的清單超出高度後會被裁掉，而且捲不到——技能一多就看不到後面的。
    const body = el('div', { class: 'panel-body', id: 'skills-body' },
        el('div', { class: 'skill-list', id: 'skill-list' })
    );
    host.appendChild(body);
    return host;
}

function skillRow(s) {
    const tools = Array.isArray(s.allowedTools) ? s.allowedTools : [];
    const vibe = String(s.vibe || '').trim();
    const emoji = String(s.emoji || '').trim();
    const icon = String(s.icon || '').trim();
    const color = String(s.color || '').trim();

    const card = el('div', { class: 'card skill-item', 'data-name': s.name });
    // 給技能卡片套自訂色：顏色以「左邊色帶」形式表現，不灌滿整張卡。
    if (color) card.style.setProperty('--skill-accent', color);

    const head = el('div', { class: 'skill-head' });
    // 圖示優先序：emoji（人格強）> Material Symbol icon > 預設 bolt
    if (emoji) {
        head.appendChild(el('span', { class: 'skill-emoji', text: emoji }));
    } else {
        head.appendChild(el('span', { class: 'ms skill-icon', text: icon || 'bolt' }));
    }
    head.appendChild(el('span', { class: 'skill-name', text: s.name }));
    if (s.path) head.appendChild(el('span', { class: 'skill-path hint', title: s.path, text: s.path }));
    card.appendChild(head);

    // vibe 一行人格定位：放在名稱正下方，比 description 更搶眼。
    // 這是 agency-agents 給的最大槓桿點：模型光看 vibe 就知道「這個人是誰」。
    if (vibe) card.appendChild(el('div', { class: 'skill-vibe', text: vibe }));

    card.appendChild(el('div', {
        class: 'skill-desc',
        text: s.description || t('skl.noDesc'),
    }));

    if (tools.length) {
        const box = el('div', { class: 'skill-tools' });
        box.appendChild(el('span', { class: 'hint', text: t('skl.toolsLim') }));
        for (const t of tools) box.appendChild(el('span', { class: 'chip skill-tool', text: t }));
        card.appendChild(box);
    }

    card.appendChild(el('div', { class: 'skill-acts' },
        el('button', {
            class: 'btn btn-xs btn-primary', title: t('skl.checkTip'),
            onclick: () => useSkill(s.name),
        }, el('span', { class: 'ms', text: 'play_arrow' }), el('span', { text: t('skl.useNow') })),
        el('button', {
            class: 'btn btn-xs btn-ghost', title: t('skl.viewT'),
            onclick: () => viewSkill(s.name),
        }, el('span', { class: 'ms', text: 'visibility' }), el('span', { text: t('skl.view') })),
        s.scope === 'project'
            ? el('button', {
                class: 'btn btn-xs btn-danger', title: t('skl.delT2'),
                onclick: () => deleteSkill(s.name),
            }, el('span', { class: 'ms', text: 'delete' }), el('span', { text: t('skl.delOne') }))
            : null
    ));

    return card;
}

function renderSkillsPanel(force = false) {
    const host = skillsHost(force);
    if (!host) return;
    const box = $('skill-list');
    if (!box) return;
    box.innerHTML = '';

    const all = Array.isArray(OC.skills) ? OC.skills : [];
    if (!all.length) {
        box.appendChild(el('div', { class: 'panel-empty' },
            el('span', { class: 'ms', text: 'auto_awesome' }),
            el('div', { class: 'hint', text: t('skl.emptyHint') }),
            el('button', { class: 'btn btn-sm btn-primary', onclick: () => createSkill() },
                el('span', { class: 'ms', text: 'add' }), el('span', { text: t('skl.firstOne') }))
        ));
        return;
    }

    for (const sc of SKILL_SCOPES) {
        const meta = skillScopeMeta(sc.id);
        const list = all.filter(s => (s.scope || 'builtin') === sc.id);
        if (!list.length) continue;
        box.appendChild(el('div', { class: 'skill-group', title: meta.hint },
            el('span', { class: 'ms', text: sc.icon }),
            el('span', { text: `${meta.label}（${list.length}）` })
        ));
        list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        for (const s of list) box.appendChild(skillRow(s));
    }

    box.appendChild(el('div', { class: 'hint skill-foot', text: t('skl.foot') }));
}

// ═══════════════════════════════════════════════════════════════
// 立即使用
// ═══════════════════════════════════════════════════════════════
function useSkill(name) {
    const inp = $('chat-input');
    if (!inp) { toast(t('skl.noInput'), 'error'); return false; }
    inp.value = t('skl.useT', { n: name });
    inp.focus();
    try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch {}
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
}

// ═══════════════════════════════════════════════════════════════
// 檢視
// ═══════════════════════════════════════════════════════════════
async function viewSkill(name) {
    let r;
    try { r = await SESS.skillGet(name); }
    catch (e) { toast(t('skl.readFail', { msg: e.message }), 'error'); return; }

    const body = $('modal-generic-body');
    if (!body) { alertModal(name, renderMarkdown(r.content || '')); return; }

    $('modal-generic-title').textContent = t('skl.viewHead', { n: r.name });
    body.innerHTML = '';

    const tools = Array.isArray(r.allowedTools) ? r.allowedTools : [];
    const head = el('div', { class: 'skill-view-meta' });
    if (r.color) head.appendChild(el('span', { class: 'skill-accent-dot', style: `background:${esc(r.color)}` }));
    if (r.emoji) head.appendChild(el('span', { class: 'skill-emoji', text: r.emoji }));
    head.appendChild(el('span', { class: 'chip', text: r.scope === 'project' ? t('skl.scopeProj') : t('skl.scopeBuiltin') }));
    if (r.path) head.appendChild(el('code', { class: 'skill-path', text: r.path }));
    for (const t of tools) head.appendChild(el('span', { class: 'chip skill-tool', text: t }));
    body.appendChild(head);

    if (r.vibe) body.appendChild(el('div', { class: 'skill-vibe skill-view-vibe', text: r.vibe }));
    if (r.description) body.appendChild(el('div', { class: 'skill-view-desc', text: r.description }));

    const md = el('div', { class: 'skill-view-md msg-body', html: renderMarkdown(r.content || t('skl.noBody')) });
    decorateCodeBlocks(md);
    body.appendChild(md);

    const acts = $('modal-generic-actions');
    acts.innerHTML = '';
    acts.appendChild(el('button', {
        class: 'btn btn-ghost', onclick: () => copyText(r.content || ''),
    }, el('span', { class: 'ms', text: 'content_copy' }), el('span', { text: t('skl.copyAll') })));
    if (r.scope === 'project' && r.path) {
        acts.appendChild(el('button', {
            class: 'btn btn-ghost',
            onclick: () => { closeModal('modal-generic'); window.openFile?.(r.path); },
        }, el('span', { class: 'ms', text: 'edit' }), el('span', { text: t('skl.openEd') })));
    }
    acts.appendChild(el('button', {
        class: 'btn btn-primary', text: t('skl.useNow'),
        onclick: () => { closeModal('modal-generic'); useSkill(r.name); },
    }));
    openModal('modal-generic');
}

// ═══════════════════════════════════════════════════════════════
// 新增
// ═══════════════════════════════════════════════════════════════
function createSkill() {
    const body = $('modal-generic-body');
    if (!body) { toast(t('skl.noDlg'), 'error'); return Promise.resolve(null); }

    return new Promise(resolve => {
        $('modal-generic-title').textContent = t('skl.createT');
        body.innerHTML = '';

        body.appendChild(el('div', { class: 'ig' },
            el('label', { text: t('skl.fName') }),
            el('input', { class: 'inp', id: 'skl-name', placeholder: 'php-review' })
        ));
        body.appendChild(el('div', { class: 'ig' },
            el('label', { text: t('skl.fVibe') }),
            el('input', { class: 'inp', id: 'skl-vibe', placeholder: t('skl.phVibe') })
        ));
        body.appendChild(el('div', { class: 'ig' },
            el('label', { text: t('skl.fDesc') }),
            el('input', { class: 'inp', id: 'skl-desc', placeholder: t('skl.phDesc') })
        ));
        body.appendChild(el('div', { class: 'ig-row' },
            el('div', { class: 'ig' },
                el('label', { text: t('skl.fEmoji') }),
                el('input', { class: 'inp', id: 'skl-emoji', placeholder: '🔍' })
            ),
            el('div', { class: 'ig' },
                el('label', { text: t('skl.fColor') }),
                el('input', { class: 'inp', id: 'skl-color', placeholder: '#3B82F6' })
            )
        ));
        body.appendChild(el('div', { class: 'ig' },
            el('label', { text: t('skl.fTools') }),
            el('input', { class: 'inp', id: 'skl-tools', placeholder: 'read_file, grep, glob' })
        ));
        body.appendChild(el('div', { class: 'ig' },
            el('label', { text: t('skl.fBody') }),
            el('textarea', { class: 'ta', id: 'skl-body', rows: '18', text: SKILL_TEMPLATE })
        ));
        body.appendChild(el('div', { class: 'hint', text: t('skl.pathHint') }));

        const acts = $('modal-generic-actions');
        acts.innerHTML = '';
        acts.appendChild(el('button', {
            class: 'btn btn-ghost', text: t('common.cancel'),
            onclick: () => { closeModal('modal-generic'); resolve(null); },
        }));
        acts.appendChild(el('button', {
            class: 'btn btn-primary', text: t('skl.create'),
            onclick: async () => {
                const raw = ($('skl-name')?.value || '').trim();
                const desc = ($('skl-desc')?.value || '').trim();
                const tools = ($('skl-tools')?.value || '').split(',').map(s => s.trim()).filter(Boolean);
                const content = $('skl-body')?.value || '';

                const slug = slugify(raw);
                if (!slug) { toast(t('skl.needName'), 'error'); return; }
                if (!desc) { toast(t('skl.needDesc'), 'error'); return; }

                const path = `.omni/skills/${slug}/SKILL.md`;
                // frontmatter 多塞了 vibe / emoji / color——YAML 標準欄位，
                // 既存的 name / description / allowed-tools 行為不變。
                const fmLines = [
                    `name: ${slug}`,
                    `description: ${desc.replace(/\n/g, ' ')}`,
                ];
                if (vibe) fmLines.push(`vibe: ${vibe.replace(/\n/g, ' ').replace(/"/g, "'")}`);
                if (emoji) fmLines.push(`emoji: ${emoji}`);
                if (/^#[0-9A-Fa-f]{3,8}$/.test(color)) fmLines.push(`color: ${color}`);
                if (tools.length) fmLines.push(`allowed-tools: ${tools.join(', ')}`);
                const md = '---\n' + fmLines.join('\n') + '\n---\n\n' + content.trim() + '\n';

                try {
                    const st = await FS.stat(path);
                    if (st.exists) {
                        const ok = await confirmModal(t('skl.existsT'),
                            `<div class="cf-msg">${t('skl.existsB', { p: esc(path) })}</div>`,
                            { danger: true, okText: t('skl.overwrite') });
                        if (!ok) return;
                    }
                } catch { /* stat 失敗當作不存在 */ }

                try {
                    await FS.write(path, md, true);
                } catch (e) {
                    toast(t('skl.createFail', { msg: e.message }), 'error');
                    return;
                }

                closeModal('modal-generic');
                toast(t('skl.createdT', { n: slug }), 'success');
                window.refreshFileTreeSoon?.();
                await window.loadSkills?.(true);
                renderSkillsPanel();
                resolve(slug);
            },
        }));

        openModal('modal-generic');
        setTimeout(() => $('skl-name')?.focus(), 60);
    });
}

// ═══════════════════════════════════════════════════════════════
// 刪除
// ═══════════════════════════════════════════════════════════════
async function deleteSkill(name) {
    const s = (OC.skills || []).find(x => x.name === name);
    if (!s) { toast(t('skl.noSkill', { n: name }), 'error'); return false; }
    if (s.scope !== 'project') {
        alertModal(t('skl.builtinT'),
            `<div class="cf-msg">${t('skl.builtinB', { n: esc(name), p: esc(s.path || 'skills/…') })}</div>`);
        return false;
    }

    const dir = dirName(s.path || '');
    const ok = await confirmModal(t('skl.delT'),
        `<div class="cf-msg">${t('skl.delB', { d: esc(dir) })}</div>`,
        { danger: true, okText: t('common.del') });
    if (!ok) return false;

    try { await FS.remove(dir, true); }
    catch (e) { toast(t('skl.delFail', { msg: e.message }), 'error'); return false; }

    toast(t('skl.deletedT', { n: name }), 'success', 2000);
    window.refreshFileTreeSoon?.();
    await window.loadSkills?.(true);
    renderSkillsPanel();
    return true;
}

// ═══════════════════════════════════════════════════════════════
// 啟動
// ═══════════════════════════════════════════════════════════════
function initSkillsPanel() {
    skillsHost();
    renderSkillsPanel();
    window.loadSkills?.(false);
}

// ═══════════════════════════════════════════════════════════════
Object.assign(window, {
    renderSkillsPanel, initSkillsPanel, createSkill, viewSkill, deleteSkill, useSkill,
    SKILL_SCOPES,
});
