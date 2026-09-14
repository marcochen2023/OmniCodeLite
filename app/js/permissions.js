'use strict';
// ═══════════════════════════════════════════════════════════════
// Omni Code — 權限系統
// ═══════════════════════════════════════════════════════════════
// 四種模式 × 規則引擎（allow / deny）× 授權對話框
// 契約見 ARCHITECTURE.md §13
// ═══════════════════════════════════════════════════════════════

// ─── 規則比對 ───────────────────────────────────────────────────
// 規則格式：tool(pattern)  例：bash(npm run *) / write_file(app/**) / delete_path(*)
//          或裸工具名：bash（等同 bash(*)）
function parseRule(rule) {
    const m = String(rule || '').match(/^\s*([A-Za-z0-9_*]+)\s*(?:\(([\s\S]*)\))?\s*$/);
    if (!m) return null;
    return { tool: m[1], pattern: m[2] !== undefined ? m[2] : '*' };
}

// 從工具輸入取出「用於規則比對的主體字串」
function ruleSubject(name, input) {
    input = input || {};
    if (name === 'bash' || name === 'git') return String(input.command || input.args || '');
    if (input.path) return String(input.path);
    if (input.from) return String(input.from);
    if (input.url) return String(input.url);
    if (input.pattern) return String(input.pattern);
    if (input.query) return String(input.query);
    if (input.action) return String(input.action);
    return '';
}

// 主體是「命令列」的工具：這類主體裡的 '/' 沒有路徑分隔語意
// （rm -rf /tmp、git log --oneline…），因此 '*' 必須能跨越 '/'。
// 若沿用路徑語意的 '*'→'[^/]*'，denyRules 的 bash(rm *) 會攔不到 "rm -rf /"。
const COMMAND_TOOLS = new Set(['bash', 'git', 'kill_shell', 'bash_output']);

function globMatch(pattern, subject, commandMode = false) {
    if (pattern === '*' || pattern === '') return true;
    let re = '';
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '*') {
            if (pattern[i + 1] === '*') { re += '.*'; i++; }
            else re += commandMode ? '.*' : '[^/]*';
        } else if (c === '?') re += '.';
        else if ('\\^$.|+()[]{}'.includes(c)) re += '\\' + c;
        else re += c;
    }
    try { return new RegExp('^' + re + '$', 'is').test(subject); }
    catch { return false; }
}

function matchRules(rules, name, input) {
    const subject = ruleSubject(name, input);
    const commandMode = COMMAND_TOOLS.has(name);
    for (const raw of (rules || [])) {
        const r = parseRule(raw);
        if (!r) continue;
        if (r.tool !== '*' && r.tool !== name) continue;
        if (globMatch(r.pattern, subject, commandMode)) return raw;
    }
    return null;
}


// ─── 敏感資源（建議 #3）─────────────────────────────────────────
// 與 includes/policy.php 同一份資料的前端副本。放前端是為了在
// checkPermission 這個同步函式裡就能判定 —— 為了問一句「這是不是
// .env」而多打一次後端往返，會讓每個工具呼叫都慢一拍。
// 後端那份才是強制點（oc_path 的唯一入口），這份只是提早攔截。
const SENSITIVE_DIRS  = ['.ssh', '.aws', '.gcloud', '.gnupg', '.gpg', '.docker', '.kube'];
const SENSITIVE_FILES = [
    /^id_(rsa|dsa|ecdsa|ed25519)/i, /^authorized_keys$/i, /^known_hosts$/i,
    /^ssh_host_.*_key/i, /^\.(bash|zsh|psql|mysql)_history$/i, /^_?\.?netrc$/i,
    /^\.git-credentials$/i, /^\.npmrc$/i, /^\.pypirc$/i,
    /^credentials(\.json)?$/i, /^service-account.*\.json$/i,
];
const SENSITIVE_EXTS = ['.pem', '.key', '.p12', '.pfx', '.cer', '.crt', '.keystore', '.jks'];

/** 回傳「為什麼敏感」的字串；空字串 = 不敏感。 */
function sensitiveReason(path) {
    const rel = String(path || '').split('\\').join('/').replace(/^\/+|\/+$/g, '');
    if (!rel) return '';
    const segs = rel.split('/');
    const name = segs[segs.length - 1];
    const lower = name.toLowerCase();

    for (const s of segs.slice(0, -1)) {
        if (SENSITIVE_DIRS.includes(s.toLowerCase())) return `位於敏感目錄 ${s}/ 之下`;
    }
    // 工作區根目錄自己的 .env 豁免 —— 那是天天在編輯的檔，
    // 每次都問會讓這個功能變成純阻力，然後被關掉
    if (lower === '.env') return segs.length === 1 ? '' : '巢狀目錄中的 .env';
    if (lower.startsWith('.env.')) return '敏感檔名前綴（.env.*）';
    for (const re of SENSITIVE_FILES) if (re.test(name)) return '憑證或金鑰類檔名';
    for (const e of SENSITIVE_EXTS) if (lower.endsWith(e)) return `敏感副檔名（${e}）`;
    return '';
}

// ─── 主判定 ─────────────────────────────────────────────────────
// 回傳 {decision:'allow'|'ask'|'deny', reason, rule}
function checkPermission(name, input) {
    const tool = (window.OC_TOOLS || []).find(t => t.name === name);
    const danger = tool?.danger || (name.startsWith('mcp__') ? 'net' : 'none');
    const mode = OC.cfg.permissionMode || 'default';

    // 1. deny 規則最優先（任何模式都擋）
    const denied = matchRules(OC.cfg.denyRules, name, input);
    if (denied) return { decision: 'deny', reason: `被拒絕規則攔截：${denied}`, rule: denied };

    // 2. 敏感資源：即使是唯讀操作也要問。
    //    讀 .env 或 id_rsa 的內容進上下文，跟寫入它一樣值得問一次 ——
    //    那些內容接下來會被送去供應商那邊。
    const sens = sensitiveReason(ruleSubject(name, input));
    if (sens && name !== 'bash') {
        return { decision: 'ask', reason: `碰到敏感資源：${sens}` };
    }

    // 3. 唯讀工具放行
    if (danger === 'none') return { decision: 'allow', reason: '唯讀操作' };

    // 4. plan 模式：任何有副作用的操作都拒絕
    if (mode === 'plan') {
        return {
            decision: 'deny',
            reason: '目前為「規劃模式」，不可寫入檔案或執行命令。請先完成調查並提出計畫；'
                  + '若需要實際動手，請提醒使用者切換到「標準」或「自動編輯」模式。',
        };
    }

    // 5. full 模式：全部放行
    if (mode === 'full') return { decision: 'allow', reason: '全自動模式' };

    // 6. allow 規則（設定檔 + 本會話暫時允許）
    const allowed = matchRules([...(OC.cfg.allowRules || []), ...(OC.sessionAllow || [])], name, input);
    if (allowed) return { decision: 'allow', reason: `符合允許規則：${allowed}`, rule: allowed };

    // 7. acceptEdits：檔案寫入免問，命令/網路仍問
    if (mode === 'acceptEdits' && danger === 'write') return { decision: 'allow', reason: '自動編輯模式' };

    return { decision: 'ask', reason: '需要使用者授權' };
}

// ─── 授權對話框 ─────────────────────────────────────────────────
// 回傳 Promise<{ok:boolean, scope:'once'|'session'|'always', feedback?:string}>
//
// 併發安全：授權對話框是整頁唯一的 modal，兩個工具同時彈會互相覆蓋、
// Promise 永遠等不到回應。所有併發路徑一律經 requestPermissionSerial ——
// 它用一條鏈把請求排成序列，前一個對話框關掉才彈下一個。
let _permChain = Promise.resolve();
function requestPermissionSerial(name, input, extraReason = '') {
    const p = _permChain.then(() => requestPermission(name, input, extraReason));
    // 這一筆被拒／拋錯不能毒掉整條鏈，否則之後的授權永遠不彈
    _permChain = p.catch(() => {}).then(() => {});
    return p;
}
function requestPermission(name, input, extraReason = '') {
    return new Promise(resolve => {
        const tool = (window.OC_TOOLS || []).find(t => t.name === name);
        const danger = tool?.danger || 'net';
        const dl = window.DANGER_LABEL[danger] || window.DANGER_LABEL.net;
        const subject = ruleSubject(name, input);
        const suggested = suggestRule(name, input);

        $('modal-permission-title').innerHTML =
            `<span class="ms" style="color:${dl.color}">shield_question</span> ${esc(t('perm.title'))}`;

        $('modal-permission-body').innerHTML = `
          <div class="perm-head">
            <span class="perm-tool">${esc(name)}</span>
            <span class="perm-danger" style="color:${dl.color};border-color:${dl.color}">${dl.text}</span>
          </div>
          <div class="perm-desc">${esc(tool?.description?.split('\n')[0] || '')}</div>
          ${extraReason ? `<div class="perm-sentinel"><span class="ms">shield</span><span>${esc(extraReason)}</span></div>` : ''}
          ${subject ? `<div class="perm-subject"><code>${esc(subject.length > 400 ? subject.slice(0, 400) + '…' : subject)}</code></div>` : ''}
          <details class="perm-detail"><summary>${esc(t('common.fullParams'))}</summary><pre class="pre-scroll">${esc(JSON.stringify(input, null, 2))}</pre></details>
          <div class="perm-rule">
            <label><input type="checkbox" id="perm-remember"> ${esc(t('perm.remember'))}<code>${esc(suggested)}</code></label>
            <select id="perm-scope" class="sel sel-sm">
              <option value="session">${esc(t('perm.scopeSession'))}</option>
              <option value="always">${esc(t('perm.scopeAlways'))}</option>
            </select>
          </div>
          <div class="ig" style="margin-top:10px">
            <label>${esc(t('common.optionalFeedback'))}</label>
            <input id="perm-feedback" class="inp" placeholder="${esc(t('perm.feedbackPh'))}">
          </div>`;

        const acts = $('modal-permission-actions');
        acts.innerHTML = '';
        let settled = false;
        const finish = (r) => {
            if (settled) return;          // 任何關閉途徑都只結算一次
            settled = true;
            $('modal-permission')?.classList.remove('active');
            document.removeEventListener('keydown', onKey, true);
            resolve(r);
        };
        const deny = () => finish({
            ok: false, scope: 'once',
            feedback: $('perm-feedback')?.value?.trim() || '',
        });
        const allow = () => {
            const remember = $('perm-remember')?.checked;
            const scope = remember ? ($('perm-scope')?.value || 'session') : 'once';
            if (remember) {
                if (scope === 'session') OC.sessionAllow.push(suggested);
                else {
                    OC.cfg.allowRules = [...new Set([...(OC.cfg.allowRules || []), suggested])];
                    SETTINGS.set({ allowRules: OC.cfg.allowRules }).catch(() => {});
                }
            }
            finish({ ok: true, scope });
        };
        const onKey = (e) => {
            if (!$('modal-permission')?.classList.contains('active')) return;
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); deny(); }
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); allow(); }
        };
        document.addEventListener('keydown', onKey, true);

        acts.appendChild(el('button', { class: 'btn btn-ghost', text: `${t('perm.deny')} (Esc)`, onclick: deny }));
        acts.appendChild(el('button', {
            class: 'btn ' + (danger === 'exec' ? 'btn-danger' : 'btn-primary'),
            html: `${esc(t('perm.allow'))} <kbd>Ctrl↵</kbd>`, onclick: allow,
        }));
        // 任何關閉方式（Esc、點背景、stopAgent 關掉它）都算「拒絕」，
        // 絕不能讓 Agent 迴圈永遠等在這個 Promise 上。
        openModal('modal-permission', () => finish({ ok: false, scope: 'once', feedback: '' }));
        setTimeout(() => acts.lastChild?.focus(), 80);
    });
}

// 依實際呼叫推薦一條規則（讓「記住」有意義的粒度）
function suggestRule(name, input) {
    input = input || {};
    if (name === 'bash' || name === 'git') {
        const cmd = String(input.command || input.args || '').trim();
        const head = cmd.split(/[\s&|;]/).filter(Boolean).slice(0, 2).join(' ');
        return `${name}(${head ? head + ' *' : '*'})`;
    }
    const p = input.path || input.from;
    if (p) {
        const d = dirName(String(p));
        return `${name}(${d ? d + '/**' : '*'})`;
    }
    if (input.url) {
        try { return `${name}(*${new URL(input.url).hostname}*)`; } catch { return `${name}(*)`; }
    }
    return `${name}(*)`;
}

// ─── 模式切換 ───────────────────────────────────────────────────
// Claude Code 的 Shift+Tab 順序：手動 → 自動編輯 → 規劃 → 全自動。
// 以前是 plan 開頭，從 acceptEdits 按一下會直接跳到最寬鬆的 full；
// 現在按一下是跳到最嚴格的 plan，誤觸的代價小得多。
const PERM_ORDER = ['default', 'acceptEdits', 'plan', 'full'];

// UI 用的模式標籤／說明（跟著介面語系走；state.js 的 PERM_MODES 只留中文保底，
// 因為 state.js 在 i18n.js 之前載入，不能直接呼叫 t()）
function permModeMeta(mode) {
    const base = window.PERM_MODES?.[mode] || window.PERM_MODES?.default;
    if (typeof t !== 'function') return base;
    const L = { plan: t('mode.planL'), default: t('mode.defaultL'), acceptEdits: t('mode.acceptL'), full: t('mode.fullL') };
    const D = { plan: t('mode.planD'), default: t('mode.defaultD'), acceptEdits: t('mode.acceptD'), full: t('mode.fullD') };
    return { ...base, label: L[mode] || base.label, desc: D[mode] || base.desc };
}

async function setPermissionMode(mode, { silent = false, skipConfirm = false } = {}) {
    if (!window.PERM_MODES[mode]) return false;
    if (mode === 'full' && !skipConfirm && OC.cfg.permissionMode !== 'full') {
        const ok = await confirmModal(t('perm.fullT'),
            `<div class="cf-msg">${t('perm.fullB', { ws: esc(OC.ws) })}</div>`,
            { danger: true, okText: t('perm.fullOk') });
        if (!ok) return false;
    }
    OC.cfg.permissionMode = mode;
    SETTINGS.set({ permissionMode: mode }).catch(e => toast(t('perm.saveFail', { msg: e.message }), 'error', 6000));
    window.renderPermButton?.();
    if (!silent) {
        const M = permModeMeta(mode);
        toast(t('perm.modeToast', { glyph: M.glyph || '', label: M.label }), mode === 'full' ? 'warn' : 'info', 2600);
    }
    return true;
}

function cyclePermissionMode() {
    const i = PERM_ORDER.indexOf(OC.cfg.permissionMode || 'default');
    return setPermissionMode(PERM_ORDER[(i + 1) % PERM_ORDER.length]);
}

// 供 system prompt 使用的模式說明
function permissionPromptSection() {
    const mode = OC.cfg.permissionMode || 'default';
    const M = window.PERM_MODES[mode];
    let s = `目前權限模式：【${M.label}】— ${M.desc}`;
    if (mode === 'plan') {
        s += '\n你現在只能調查與規劃，寫入與執行類工具會被拒絕。工作流程如下：'
           + '\n  1. 先用 read_file / grep / glob / project_tree 把現況徹底摸清楚——'
           + '該讀的檔案全部讀完，不要憑猜測寫計畫。'
           + '\n  2. 想清楚之後呼叫 present_plan 提交計畫，內容要具體到「改哪個檔案的哪一段、為什麼」，'
           + '並附上你打算怎麼驗證。'
           + '\n  3. 使用者批准後權限會自動放開，你直接照計畫做完即可，不必再問一次；'
           + '若他要求修改，就依他的意見調整後重新 present_plan。'
           + '\n不要用純文字描述計畫然後停住——那樣使用者沒有批准按鈕可以按。一定要用 present_plan。';
    } else if (mode === 'full') {
        s += '\n你已獲得完全授權，請直接動手完成任務，不需要徵求同意。'
           + '但仍要遵守：修改前先讀取、破壞性操作前先確認自己理解了現況、重要變更後回報做了什麼。';
    }
    const allow = OC.cfg.allowRules || [];
    const deny = OC.cfg.denyRules || [];
    if (allow.length) s += `\n免詢問的操作：${allow.join('、')}`;
    if (deny.length) s += `\n一律禁止的操作：${deny.join('、')}`;
    // Sentinel 第二隻眼：讓模型知道「有些事就算在 full 模式也會被問」，
    // 免得它在計畫裡寫「全自動所以不會被問」這種錯誤預期。
    if (OC.cfg.sentinel !== false && mode !== 'plan') {
        s += '\n獨立監控（Sentinel）：遞迴刪除、高危系統命令、對外寫入請求就算在全自動模式也會先問你；'
           + '敏感檔案（金鑰、憑證、.env）的讀寫會被問，寫入／刪除直接拒絕。'
           + '憑證一律用保險庫代號 {{VAULT:名稱}} 引用，絕不要把值寫進工具定義或回覆裡。';
    }
    return s;
}

Object.assign(window, {
    checkPermission, requestPermission, requestPermissionSerial,
    suggestRule, matchRules, ruleSubject, permModeMeta,
    setPermissionMode, cyclePermissionMode, permissionPromptSection, PERM_ORDER, sensitiveReason,
});
