'use strict';
// ═══════════════════════════════════════════════════════════════
// Omni Code — Token 流量與成本（記錄 + 面板）
// ═══════════════════════════════════════════════════════════════
// 每次 LLM／繪圖呼叫都留一筆紀錄，面板可依 24H～365天 篩選查詢。
//
// 成本在「記錄當下」用當時的價格算好送給後端存起來。
// 事後改價格不會動到歷史帳目（那才叫紀錄），要回頭套用新價格
// 有明確的「重算」按鈕。
// ═══════════════════════════════════════════════════════════════

const USAGE_PERIOD_IDS = ['24h', '7d', '15d', '30d', '90d', '180d', '365d', 'all'];
const USAGE_PERIOD_KEYS = { '24h': 'usage.p24h', '7d': 'usage.p7d', '15d': 'usage.p15d', '30d': 'usage.p30d', '90d': 'usage.p90d', '180d': 'usage.p180d', '365d': 'usage.p365d', all: 'usage.pAll' };
const USAGE_PERIODS = USAGE_PERIOD_IDS.map(id => ({ id, get label() { return (typeof t === 'function' ? t(USAGE_PERIOD_KEYS[id]) : id); } }));

const PURPOSE_KEYS = { agent: 'usage.pAgent', subagent: 'usage.pSub', compact: 'usage.pCompact', title: 'usage.pTitle', image: 'usage.pImage', tool: 'usage.pTool', other: 'usage.pOther' };
function purposeLabel(p) { return (typeof t === 'function' ? t(PURPOSE_KEYS[p] || 'usage.pOther') : p) || p; }
const PURPOSE_LABEL = new Proxy({}, { get: (_, p) => purposeLabel(p) });

// ─── 記錄 ───────────────────────────────────────────────────────
// 絕不讓記錄失敗影響主流程：全部 catch 掉，最多寫進主控台。
function recordUsage({ model, provider, usage, ms, purpose = 'agent', images = 0, ok = true, error = '' }) {
    try {
        const u = usage || {};
        const rates = window.modelRates ? modelRates(model) : { in: null, out: null, image: null };
        const body = {
            model: model || '',
            provider: provider || (window.getProviderForModel ? getProviderForModel(model) : ''),
            in: u.input || 0,
            out: u.output || 0,
            cache_read: u.cache_read || 0,
            cache_write: u.cache_write || 0,
            images,
            ms: ms || 0,
            purpose,
            session: OC.session?.id || '',
            ok, error,
            rate_in: rates.in,
            rate_out: rates.out,
            rate_image: rates.image,
        };
        // 沒有任何量就不必留紀錄（例如立刻失敗的呼叫）
        if (!body.in && !body.out && !body.images && ok) return;
        _post_usage(body);
    } catch (e) {
        console.warn('[usage] 記錄失敗', e);
    }
}

function _post_usage(body) {
    fetch(API_BASE + 'usage.php?action=record', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,          // 關閉分頁時也盡量送出
    }).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════
// 面板
// ═══════════════════════════════════════════════════════════════

let _uPeriod = '7d';
let _uData = null;
let _uRecords = [];
let _uOffset = 0;
let _uModelFilter = '';
const U_PAGE = 60;

function usageHost() {
    const host = $('panel-usage');
    if (!host) return null;
    if (host.dataset.ready === '1') return host;
    host.dataset.ready = '1';
    host.innerHTML = '';

    host.appendChild(el('div', { class: 'panel-head' },
        el('span', { class: 'panel-title' },
            el('span', { class: 'ms', text: 'monitoring' }),
            el('span', { text: t('panel.usage') })),
        el('div', { class: 'panel-head-acts' },
            el('button', {
                class: 'btn-icon', title: t('usage.recalcT'),
                onclick: () => recalcUsageCosts(),
            }, el('span', { class: 'ms', text: 'calculate' })),
            el('button', {
                class: 'btn-icon', title: t('usage.refreshT'),
                onclick: () => loadUsage(true),
            }, el('span', { class: 'ms', text: 'refresh' })),
            el('button', {
                class: 'btn-icon', title: t('usage.clearT'),
                onclick: () => clearUsage(),
            }, el('span', { class: 'ms', text: 'delete_sweep' }))
        )
    ));

    // 期間篩選
    const per = el('div', { class: 'u-periods', id: 'u-periods' });
    for (const p of USAGE_PERIODS) {
        per.appendChild(el('button', {
            class: 'u-period' + (p.id === _uPeriod ? ' active' : ''),
            'data-p': p.id, text: p.label,
            onclick: () => { _uPeriod = p.id; _uOffset = 0; loadUsage(true); },
        }));
    }
    host.appendChild(per);

    host.appendChild(el('div', { class: 'panel-body', id: 'usage-body' },
        el('div', { class: 'u-content', id: 'u-content' })
    ));
    return host;
}

async function loadUsage(force = false) {
    let host = usageHost();
    if (!host) return;
    // 語系切換 → 靜態外殼（標頭／期間按鈕）要重建
    try {
        const loc = (typeof oc_locale === 'function' ? oc_locale() : 'en');
        if (host.dataset.loc && host.dataset.loc !== loc) {
            delete host.dataset.ready; host.innerHTML = '';
            host = usageHost();
        }
        if (host) host.dataset.loc = loc;
    } catch {}
    if (!host) return;
    for (const b of $$('.u-period', host)) b.classList.toggle('active', b.dataset.p === _uPeriod);

    const box = $('u-content');
    if (!box) return;
    if (force || !_uData) box.innerHTML = `<div class="u-loading"><span class="spinner"></span><span>${esc(t('common.loading'))}</span></div>`;

    try {
        const [q, l] = await Promise.all([
            USAGE.query(_uPeriod),
            USAGE.list(_uPeriod, U_PAGE, 0, _uModelFilter),
        ]);
        _uData = q;
        _uRecords = l.records || [];
        _uTotalRecords = l.total || 0;
        _uOffset = 0;
    } catch (e) {
        box.innerHTML = '';
        box.appendChild(el('div', { class: 'panel-empty' },
            el('span', { class: 'ms', text: 'error' }),
            el('span', { text: t('usage.readFail', { msg: e.message }) })));
        return;
    }
    paintUsage();
}
let _uTotalRecords = 0;

function paintUsage() {
    const box = $('u-content');
    if (!box || !_uData) return;
    box.innerHTML = '';

    const tot = _uData.total;

    if (!tot.calls) {
        box.appendChild(el('div', { class: 'panel-empty' },
            el('span', { class: 'ms', text: 'monitoring' }),
            el('span', { text: t('usage.empty') }),
            el('span', { class: 'hint', text: t('usage.emptyHint') })));
        return;
    }

    // ─── 總覽卡片 ───
    const cards = el('div', { class: 'u-cards' });
    cards.appendChild(uCard(t('usage.cCalls'), String(tot.calls), 'call_made',
        tot.errors ? t('usage.errN', { n: tot.errors }) : ''));
    cards.appendChild(uCard(t('usage.cIn'), fmtTokens(tot.in), 'south_west',
        tot.cache_read ? t('usage.cacheIn', { n: fmtTokens(tot.cache_read) }) : ''));
    cards.appendChild(uCard(t('usage.cOut'), fmtTokens(tot.out), 'north_east', ''));
    cards.appendChild(uCard(t('usage.cCost'), tot.cost > 0 ? '$' + tot.cost.toFixed(4) : (tot.unpriced ? '—' : '$0'),
        'payments',
        tot.unpriced ? t('usage.unpricedN', { n: tot.unpriced }) : t('usage.approxNT', { n: Math.round(tot.cost * 32) }),
        tot.unpriced ? 'warn' : ''));
    box.appendChild(cards);

    if (tot.unpriced) {
        box.appendChild(el('div', { class: 'u-notice' },
            el('span', { class: 'ms', text: 'info' }),
            el('span', { text: t('usage.notice', { n: tot.unpriced }) })
        ));
    }

    // ─── 每日趨勢 ───
    const days = _uData.byDay || [];
    if (days.length > 1) {
        box.appendChild(el('div', { class: 'u-sec', text: t('usage.secDay') }));
        box.appendChild(uDayChart(days));
    }

    // ─── 依模型 ───
    box.appendChild(el('div', { class: 'u-sec', text: t('usage.secModel') }));
    box.appendChild(uModelTable(_uData.byModel || []));

    // ─── 依用途 ───
    const purposes = (_uData.byPurpose || []).slice().sort((a, b) => (b.in + b.out) - (a.in + a.out));
    if (purposes.length > 1) {
        box.appendChild(el('div', { class: 'u-sec', text: t('usage.secPurpose') }));
        const pb = el('div', { class: 'u-purposes' });
        const maxP = Math.max(...purposes.map(p => p.in + p.out), 1);
        for (const p of purposes) {
            const tot = p.in + p.out;
            pb.appendChild(el('div', { class: 'u-purpose' },
                el('span', { class: 'u-purpose-n', text: PURPOSE_LABEL[p.purpose] || p.purpose }),
                el('div', { class: 'u-purpose-bar' },
                    el('div', { class: 'u-purpose-fill', style: { width: (tot / maxP * 100) + '%' } })),
                el('span', { class: 'u-purpose-v', text: fmtTokens(tot) }),
                el('span', { class: 'u-purpose-c', text: p.cost > 0 ? '$' + p.cost.toFixed(4) : '—' })
            ));
        }
        box.appendChild(pb);
    }

    // ─── 逐筆明細 ───
    box.appendChild(el('div', { class: 'u-sec' },
        el('span', { text: t('usage.secDetail') }),
        el('span', { class: 'u-sec-n', text: String(_uTotalRecords) }),
        _uModelFilter ? el('button', {
            class: 'btn btn-xs btn-ghost', text: t('usage.clearFilter', { m: _uModelFilter }),
            onclick: () => { _uModelFilter = ''; loadUsage(true); },
        }) : null
    ));
    box.appendChild(uRecordTable(_uRecords));

    if (_uRecords.length < _uTotalRecords) {
        box.appendChild(el('button', {
            class: 'btn btn-sm btn-ghost u-more',
            text: t('usage.more', { n: _uTotalRecords - _uRecords.length }),
            onclick: () => loadMoreUsage(),
        }));
    }
}

function uCard(label, value, icon, sub, tone) {
    return el('div', { class: 'u-card' + (tone ? ' u-card-' + tone : '') },
        el('div', { class: 'u-card-top' },
            el('span', { class: 'ms', text: icon }),
            el('span', { class: 'u-card-l', text: label })),
        el('div', { class: 'u-card-v', text: value }),
        sub ? el('div', { class: 'u-card-s', text: sub }) : null
    );
}

// 每日長條圖（純 CSS，不引外部圖表庫）
function uDayChart(days) {
    const max = Math.max(...days.map(d => d.in + d.out), 1);
    const wrap = el('div', { class: 'u-chart' });
    const bars = el('div', { class: 'u-chart-bars' });
    for (const d of days) {
        const tot = d.in + d.out;
        const h = tot ? Math.max(2, tot / max * 100) : 0;
        const inH = tot ? (d.in / tot * 100) : 0;
        bars.appendChild(el('div', {
            class: 'u-bar' + (tot ? '' : ' empty'),
            title: `${d.day}\n${t('usage.thIn')} ${fmtTokens(d.in)}／${t('usage.thOut')} ${fmtTokens(d.out)}\n${d.calls} ${t('usage.cCalls')}`
                 + (d.cost > 0 ? `\n$${d.cost.toFixed(4)}` : ''),
        },
            el('div', { class: 'u-bar-stack', style: { height: h + '%' } },
                el('div', { class: 'u-bar-in', style: { height: inH + '%' } }),
                el('div', { class: 'u-bar-out' })
            )
        ));
    }
    wrap.appendChild(bars);
    // 只標首尾日期，中間留白避免擠成一團
    wrap.appendChild(el('div', { class: 'u-chart-x' },
        el('span', { text: days[0]?.day || '' }),
        el('span', { class: 'u-chart-legend' },
            el('i', { class: 'lg-in' }), el('span', { text: t('usage.in') }),
            el('i', { class: 'lg-out' }), el('span', { text: t('usage.out') })),
        el('span', { text: days[days.length - 1]?.day || '' })
    ));
    return wrap;
}

function uModelTable(rows) {
    if (!rows.length) return el('div', { class: 'hint', text: t('usage.noData') });
    const tbl = el('table', { class: 'u-table' });
    tbl.appendChild(el('thead', {}, el('tr', {},
        el('th', { text: t('usage.thModel') }),
        el('th', { class: 'num', text: t('usage.thCalls') }),
        el('th', { class: 'num', text: t('usage.thIn') }),
        el('th', { class: 'num', text: t('usage.thOut') }),
        el('th', { class: 'num', text: t('usage.thCost') })
    )));
    const tb = el('tbody');
    for (const r of rows) {
        const info = getModelInfo(r.model);
        tb.appendChild(el('tr', { class: 'u-row-click', title: '只看這個模型的明細',
            onclick: () => { _uModelFilter = r.model; loadUsage(true); } },
            el('td', {},
                el('div', { class: 'u-m-name', text: info.displayName || r.model }),
                el('div', { class: 'u-m-id', text: r.model })),
            el('td', { class: 'num', text: String(r.calls) }),
            el('td', { class: 'num', text: fmtTokens(r.in) }),
            el('td', { class: 'num', text: fmtTokens(r.out) }),
            el('td', { class: 'num' + (r.unpriced ? ' unpriced' : '') },
                r.unpriced && !r.cost ? t('usage.unpriced') : '$' + r.cost.toFixed(4))
        ));
    }
    tbl.appendChild(tb);
    return tbl;
}

function uRecordTable(recs) {
    if (!recs.length) return el('div', { class: 'hint', text: t('usage.noDetail') });
    const tbl = el('table', { class: 'u-table u-detail' });
    tbl.appendChild(el('thead', {}, el('tr', {},
        el('th', { text: t('usage.thTime') }),
        el('th', { text: t('usage.thPurpose') }),
        el('th', { class: 'num', text: t('usage.thIn') }),
        el('th', { class: 'num', text: t('usage.thOut') }),
        el('th', { class: 'num', text: t('usage.thDur') }),
        el('th', { class: 'num', text: t('usage.thCost') })
    )));
    const tb = el('tbody');
    for (const r of recs) {
        const info = getModelInfo(r.model);
        const d = new Date(r.ts);
        const time = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} `
                   + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
        tb.appendChild(el('tr', { class: r.ok === false ? 'u-err' : '' },
            el('td', { class: 'u-time', text: time }),
            el('td', {},
                el('div', { class: 'u-m-name', text: info.displayName || r.model || '(未知)' }),
                el('div', { class: 'u-m-id' },
                    el('span', { class: 'chip chip-xs', text: purposeLabel(r.purpose) || r.purpose || 'agent' }),
                    r.ok === false ? el('span', { class: 'chip chip-xs chip-err', text: t('usage.failed') }) : null,
                    r.images ? el('span', { class: 'chip chip-xs', text: t('usage.imgN', { n: r.images }) }) : null)),
            el('td', { class: 'num', text: fmtTokens(r.in) }),
            el('td', { class: 'num', text: fmtTokens(r.out) }),
            el('td', { class: 'num u-ms', text: r.ms ? (r.ms >= 1000 ? (r.ms / 1000).toFixed(1) + 's' : r.ms + 'ms') : '—' }),
            el('td', { class: 'num' + (r.cost === null ? ' unpriced' : '') },
                r.cost === null ? t('usage.unpriced') : '$' + Number(r.cost).toFixed(6))
        ));
    }
    tbl.appendChild(tb);
    return tbl;
}

async function loadMoreUsage() {
    try {
        const l = await USAGE.list(_uPeriod, U_PAGE, _uRecords.length, _uModelFilter);
        _uRecords = _uRecords.concat(l.records || []);
        _uTotalRecords = l.total || _uRecords.length;
        paintUsage();
    } catch (e) { toast(t('usage.loadFail', { msg: e.message }), 'error'); }
}

// ─── 重算 / 清除 ────────────────────────────────────────────────

async function recalcUsageCosts() {
    const rates = window.allModelRates ? allModelRates() : {};
    const n = Object.keys(rates).length;
    if (!n) {
        alertModal(t('usage.recalcNoneT'),
            t('usage.recalcNoneB'));
        return;
    }
    const ok = await confirmModal(t('usage.recalcT2'),
        t('usage.recalcB', { n }),
        { okText: t('usage.recalcOk') });
    if (!ok) return;
    try {
        const r = await USAGE.recalc(rates, false);
        toast(t('usage.recalcDone', { c: r.changed, s: r.scanned }), 'success');
        loadUsage(true);
    } catch (e) { toast(t('usage.recalcFail', { msg: e.message }), 'error'); }
}

async function clearUsage() {
    const ok = await confirmModal(t('usage.clearT2'),
        t('usage.clearB'),
        { okText: t('usage.clearOk'), danger: true });
    if (!ok) return;
    try {
        await USAGE.clear(0);
        toast(t('usage.cleared'), 'success');
        _uData = null; _uRecords = []; _uTotalRecords = 0;
        loadUsage(true);
    } catch (e) { toast(t('usage.clearFail', { msg: e.message }), 'error'); }
}

function initUsagePanel() { usageHost(); }

Object.assign(window, {
    recordUsage, initUsagePanel, loadUsage, renderUsagePanel: loadUsage,
    USAGE_PERIODS,
});
