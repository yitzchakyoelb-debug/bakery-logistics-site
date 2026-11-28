// Inventory & logistics dashboard. Vanilla JS, no dependencies.
// Business rules (status, on-time, late PO, expiry) follow SPEC.md section 5.
'use strict';
const DATA_URLS = ['data/data.json', 'data/mock-data.json']; // fallback only when data/data.js is missing

// ---------- formatting ----------
const nf = new Intl.NumberFormat('he-IL');
const nf1 = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 1 });
const nis = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });
const pct = (v, d = 1) => (v * 100).toLocaleString('he-IL', { maximumFractionDigits: d }) + '%';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ddmm = iso => iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : '–';
// business rules + date helpers live in assets/model.js (shared with the build / weekly report)
const { toMin, addDays, daysBetween, buildModel, summarize } = globalThis.BakeryModel;
const short = v => v >= 1000 ? nf1.format(v / 1000) + 'K' : nf.format(Math.round(v)); // 2.5K, not a rounded 3K
const days = n => n === 1 ? 'יום אחד' : `${nf1.format(n)} ימים`;
const $ = (sel, root = document) => root.querySelector(sel);

const CAT = { raw: 'חומרי גלם', packaging: 'אריזות', finished: 'מוצרים מוגמרים' };
const STORAGE = { dry: 'יבש', chilled: 'קירור', frozen: 'הקפאה' };
const STATUS = { critical: 'קריטי', low: 'נמוך', ok: 'תקין', overstock: 'עודף' };
const STATUS_ORDER = { critical: 0, low: 1, overstock: 2, ok: 3 };
const WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

// ---------- model ----------
let M = null;

// ---------- shared UI pieces ----------
const pill = (cls, text) => `<span class="pill st-${cls}">${esc(text)}</span>`;
const kpi = (label, value, sub = '', alert = false) => `<div class="kpi${alert ? ' alert' : ''}"><span>${esc(label)}</span><b>${value}</b><small>${sub || '&nbsp;'}</small></div>`;
const delta = (cur, prev) => {
  if (!prev) return '';
  const d = (cur - prev) / prev;
  return `<span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${pct(Math.abs(d), 0)}</span> לעומת 4 השבועות הקודמים`;
};
function options(sel, list, allLabel, value) {
  sel.innerHTML = `<option value="">${esc(allLabel)}</option>` + list.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
  sel.value = value || '';
}

// Sortable table. cols: {k, t, n (numeric/LTR), f(row) -> html, sort(row) -> value}
function table(box, rows, cols, state, emptyText = 'אין נתונים לסינון הזה') {
  const col = cols.find(c => c.k === state.key) || cols[0];
  const val = r => (col.sort ? col.sort(r) : r[col.k]);
  const data = [...rows].sort((a, b) => { const x = val(a), y = val(b); return (x > y ? 1 : x < y ? -1 : 0) * (state.asc ? 1 : -1); });
  box.innerHTML = `<table><thead><tr>${cols.map(c => `<th scope="col" ${c.nosort ? '' : `data-k="${c.k}" tabindex="0"`} ${c.k === state.key ? `aria-sort="${state.asc ? 'ascending' : 'descending'}"` : ''}>${esc(c.t)}</th>`).join('')}</tr></thead><tbody>` +
    (data.length ? data.map(r => `<tr>${cols.map(c => `<td${c.n ? ' class="n"' : ''}>${c.f ? c.f(r) : esc(r[c.k])}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${cols.length}" class="empty">${esc(emptyText)}</td></tr>`) + '</tbody></table>';
  box.querySelectorAll('th[data-k]').forEach(th => {
    const go = () => { state.asc = state.key === th.dataset.k ? !state.asc : true; state.key = th.dataset.k; table(box, rows, cols, state, emptyText); };
    th.addEventListener('click', go);
    th.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
}

// ---------- charts (SVG, one scale, hover tooltip) ----------
function tip(box, html, x, y) {
  let t = box.querySelector('.tip');
  if (!t) { t = document.createElement('div'); t.className = 'tip'; box.appendChild(t); }
  t.innerHTML = html; t.hidden = false;
  t.style.left = Math.max(0, Math.min(box.clientWidth - t.offsetWidth, x - t.offsetWidth / 2)) + 'px';
  t.style.top = Math.max(-8, y - t.offsetHeight - 12) + 'px';
}
const untip = box => { const t = box.querySelector('.tip'); if (t) t.hidden = true; };
const niceMax = v => { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)), n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; };
const roundTop = (x, y0, w, y1, r) => { r = Math.min(r, w / 2, y0 - y1); return y0 - y1 <= 0 ? '' : `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`; };

// series: [{key, color}], data: [{label, values:{key:v}, tip}], stacked when series.length > 1
function columns(box, data, series, { max, axis = short, target, labelEvery = 1 } = {}) {
  const W = 900, H = 250, L = 46, R = target != null ? 62 : 10, T = 12, B = 26; // room for the target label outside the plot
  const totals = data.map(d => series.reduce((a, s) => a + (d.values[s.key] || 0), 0));
  const top = max ?? niceMax(Math.max(...totals, 0));
  const bw = (W - L - R) / Math.max(data.length, 1), gap = Math.max(2, bw * 0.26);
  const y = v => T + (H - T - B) * (1 - v / top);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(box.dataset.label || '')}">`;
  for (let i = 0; i <= 4; i++) { const v = top * i / 4; svg += `<line class="${i ? 'grid' : 'base'}" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${esc(axis(v))}</text>`; }
  data.forEach((d, i) => {
    const x = L + i * bw + gap / 2, w = bw - gap;
    svg += `<rect class="hit" data-i="${i}" x="${L + i * bw}" y="${T}" width="${bw}" height="${H - T - B}"/><g>`;
    let acc = 0;
    series.forEach((s, si) => {
      const v = d.values[s.key] || 0; if (!v) return;
      const y0 = y(acc), y1 = y(acc + v), last = si === series.length - 1 || series.slice(si + 1).every(n => !d.values[n.key]);
      // 2px surface gap between stacked segments
      svg += last ? `<path d="${roundTop(x, y0 - (acc ? 2 : 0), w, y1, 4)}" fill="var(${s.color})"/>` : `<rect x="${x}" y="${y1}" width="${w}" height="${Math.max(0, y0 - y1 - (acc ? 2 : 0))}" fill="var(${s.color})"/>`;
      acc += v;
    });
    svg += `</g>`;
    if (i % labelEvery === 0) svg += `<text x="${x + w / 2}" y="${H - 8}" text-anchor="middle">${esc(d.label)}</text>`;
  });
  if (target != null) svg += `<line class="target" x1="${L}" x2="${W - R}" y1="${y(target.v)}" y2="${y(target.v)}"/><text class="target-l" x="${W - R + 6}" y="${y(target.v) + 4}" text-anchor="start">${esc(target.label)}</text>`;
  box.innerHTML = svg + '</svg>';
  box.querySelectorAll('.hit').forEach(h => {
    h.addEventListener('mousemove', e => { const r = box.getBoundingClientRect(); tip(box, data[+h.dataset.i].tip, e.clientX - r.left, e.clientY - r.top); });
    h.addEventListener('mouseleave', () => untip(box));
  });
}
function bars(box, rows, fmt) {
  const max = Math.max(...rows.map(r => r.v), 1);
  box.innerHTML = `<div class="bars">${rows.map(r => `<div class="row" title="${esc(r.label)}: ${esc(fmt(r.v))}"><span>${esc(r.label)}</span><span class="track"><span class="fill" style="width:${(r.v / max * 100).toFixed(1)}%"></span></span><span class="val">${esc(fmt(r.v))}</span></div>`).join('')}</div>`;
}
function onTimeByDay(box, shipments) {
  const days = [...new Set(shipments.map(s => s.date))].sort();
  const data = days.map(d => {
    const del = shipments.filter(s => s.date === d && s.status === 'delivered');
    const ok = del.filter(s => s.onTime).length, rate = del.length ? ok / del.length : 0;
    const wd = WEEKDAYS[new Date(d + 'T00:00:00Z').getUTCDay()];
    return { label: ddmm(d), values: { v: rate * 100 },
             tip: `<span>יום ${wd} ${ddmm(d)}</span><b>${del.length ? pct(rate, 0) : '–'} בזמן</b><span class="muted">${ok} מתוך ${del.length} משלוחים${del.length - ok ? ` · ${del.length - ok} באיחור` : ''}</span>` };
  });
  columns(box, data, [{ key: 'v', color: '--s1' }], { max: 100, axis: v => v + '%', target: { v: 95, label: 'יעד 95%' }, labelEvery: data.length > 16 ? 2 : 1 });
}

// ---------- alerts ----------
function alerts() {
  const a = [];
  for (const r of M.stock.filter(r => r.status === 'critical'))
    a.push({ sev: 'critical', tag: 'מלאי קריטי', text: `${r.item.name}: ${nf1.format(r.on_hand)} ${r.item.unit}, מספיק ל-${nf1.format(r.cover)} ימים`, where: r.loc.name, tab: 'inventory' });
  for (const s of M.shipments.filter(s => s.tempBreach && s.date >= addDays(M.asOf, -7)))
    a.push({ sev: 'critical', tag: 'חריגת טמפרטורה', text: `${s.veh.id} בקו ${s.run} ל${s.loc.name}: ${nf1.format(s.max_temp_c)}°C (${ddmm(s.date)})`, where: s.loc.name, tab: 'logistics' });
  for (const p of M.pos.filter(p => p.late))
    a.push({ sev: 'warning', tag: 'רכש באיחור', text: `${p.po_id}: ${p.item.name} מ${p.sup.name}, באיחור של ${days(p.lateDays)}`, where: 'מרכז ייצור', tab: 'procurement' });
  for (const s of M.shipments.filter(s => s.date === M.asOf && s.status === 'delivered' && !s.onTime))
    a.push({ sev: 'warning', tag: 'משלוח באיחור', text: `קו ${s.run} ל${s.loc.name} הגיע ${s.delay} דקות אחרי המתוכנן`, where: s.loc.name, tab: 'logistics' });
  for (const r of M.stock.filter(r => r.expSoon))
    a.push({ sev: 'warning', tag: 'תפוגה קרובה', text: `${r.item.name}: ${nf1.format(r.on_hand)} ${r.item.unit} בתוקף עד ${ddmm(r.nearest_expiry)}`, where: r.loc.name, tab: 'inventory' });
  for (const r of M.stock.filter(r => r.status === 'low'))
    a.push({ sev: 'info', tag: 'מתחת לנקודת הזמנה', text: `${r.item.name}: ${nf1.format(r.on_hand)} ${r.item.unit} (נקודת הזמנה ${nf.format(r.reorder_point)})`, where: r.loc.name, tab: 'inventory' });
  // external source (Hebcal): holidays in the next 21 days that change production or deliveries
  if (CAL.status === 'ok')
    for (const e of CAL.data.events.filter(e => e.inDays >= 0 && e.inDays <= 21))
      a.push({ sev: e.kind === 'info' ? 'info' : 'warning', tag: `${e.title} ${inDaysText(e.inDays)}`, text: e.action, where: 'כל הסניפים', tab: 'calendar' });
  const order = { critical: 0, warning: 1, info: 2 };
  return a.sort((x, y) => order[x.sev] - order[y.sev]);
}

// ---------- screens ----------
const state = {
  inv: { loc: '', cat: '', storage: '', q: '', status: '', sort: { key: 'status', asc: true } },
  po: { sortOpen: { key: 'status', asc: true }, sortSup: { key: 'onTime', asc: true } },
  lg: { branch: '', sortFleet: { key: 'id', asc: true }, sortTemp: { key: 'date', asc: false } },
  ws: { branch: '', sort: { key: 'change', asc: false } },
  cal: { sort: { key: 'candles', asc: true } },
  alertsAll: false,
};

function renderOverview() {
  const S = summarize(M);
  $('#ov-kpis').innerHTML = [
    kpi('שווי מלאי', nis.format(S.inventoryValue), `${nf.format(S.stockRows)} שורות מלאי ב-${S.locations} מיקומים`),
    kpi('מתחת לנקודת הזמנה', nf.format(S.critical + S.low), `${S.critical} קריטיים · ${S.low} נמוכים`, S.critical > 0),
    kpi('תפוגה ב-48 שעות', nis.format(S.expiring.value), `${S.expiring.count} חומרי גלם`),
    kpi('משלוחים בזמן', pct(S.deliveries.rate), `${S.deliveries.late} איחורים מתוך ${S.deliveries.delivered} · 30 יום`),
    kpi('ספקים בזמן', pct(S.suppliers.rate), `${S.purchaseOrders.late.length} הזמנות פתוחות באיחור`, S.purchaseOrders.late.length > 0),
    kpi('פחת · 4 שבועות', nis.format(S.waste.cur), delta(S.waste.cur, S.waste.prev)),
  ].join('');

  const list = alerts(), show = state.alertsAll ? list : list.slice(0, 8);
  const sevLabel = { critical: 'critical', warning: 'warning', info: 'info' };
  $('#ov-alerts').innerHTML = show.map(a => `<li>${pill(sevLabel[a.sev], a.tag)}<a class="what" href="#${a.tab}" style="color:inherit;text-decoration:none">${esc(a.text)}</a><span class="where">${esc(a.where)}</span></li>`).join('');
  const c = list.filter(a => a.sev === 'critical').length, wn = list.filter(a => a.sev === 'warning').length;
  $('#ov-alert-sum').textContent = `${c} קריטיות · ${wn} אזהרות · ${list.length - c - wn} לידיעה`;
  const more = $('#ov-alerts-more');
  more.hidden = list.length <= 8;
  more.textContent = state.alertsAll ? 'הצג פחות' : `הצג את כל ${list.length} ההתראות`;
  more.onclick = () => { state.alertsAll = !state.alertsAll; renderOverview(); };

  const byStorage = Object.keys(STORAGE).map(k => ({ label: STORAGE[k], v: M.stock.filter(r => r.item.storage === k).reduce((a, r) => a + r.value, 0) })).sort((a, b) => b.v - a.v);
  bars($('#ov-storage'), byStorage, nis.format);
  const byLoc = M.raw.locations.map(l => ({ label: l.name, v: M.stock.filter(r => r.location_id === l.id).reduce((a, r) => a + r.value, 0) })).sort((a, b) => b.v - a.v);
  bars($('#ov-location'), byLoc, nis.format);
  $('#ov-ontime').dataset.label = 'אחוז משלוחים בזמן לפי יום';
  onTimeByDay($('#ov-ontime'), M.shipments);
}

function renderInventory() {
  const s = state.inv;
  options($('#inv-loc'), M.raw.locations.map(l => [l.id, l.name]), 'כל המיקומים', s.loc);
  options($('#inv-cat'), Object.entries(CAT), 'כל הקטגוריות', s.cat);
  options($('#inv-storage'), Object.entries(STORAGE), 'כל סוגי האחסון', s.storage);
  $('#inv-q').value = s.q;
  const bind = (id, key) => $(id).addEventListener('input', e => { s[key] = e.target.value; draw(); });
  bind('#inv-loc', 'loc'); bind('#inv-cat', 'cat'); bind('#inv-storage', 'storage'); bind('#inv-q', 'q');

  function draw() {
    const q = s.q.trim().toLowerCase();
    const base = M.stock.filter(r => (!s.loc || r.location_id === s.loc) && (!s.cat || r.item.category === s.cat) && (!s.storage || r.item.storage === s.storage)
      && (!q || r.item.name.toLowerCase().includes(q) || r.sku.toLowerCase().includes(q)));
    const counts = Object.fromEntries(Object.keys(STATUS).map(k => [k, base.filter(r => r.status === k).length]));
    $('#inv-chips').innerHTML = `<button class="chip" aria-pressed="${!s.status}" data-s="">הכל <b>${base.length}</b></button>` +
      ['critical', 'low', 'overstock', 'ok'].map(k => `<button class="chip" aria-pressed="${s.status === k}" data-s="${k}">${pill(k, STATUS[k])} <b>${counts[k]}</b></button>`).join('');
    $('#inv-chips').querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => { s.status = b.dataset.s; draw(); }));
    const rows = base.filter(r => !s.status || r.status === s.status);
    $('#inv-sum').textContent = `${rows.length} שורות · ${nis.format(rows.reduce((a, r) => a + r.value, 0))}`;
    const maxCover = 10;
    table($('#inv-table'), rows, [
      { k: 'name', t: 'פריט', sort: r => r.item.name, f: r => `${esc(r.item.name)}<span class="sub"><span class="mono">${esc(r.sku)}</span> · ${esc(CAT[r.item.category])}</span>` },
      { k: 'loc', t: 'מיקום', sort: r => r.loc.name, f: r => esc(r.loc.name) },
      { k: 'on_hand', t: 'כמות', n: 1, f: r => `${nf1.format(r.on_hand)} <span class="muted small">${esc(r.item.unit)}</span>` },
      { k: 'avg_daily_use', t: 'צריכה יומית', n: 1, f: r => nf1.format(r.avg_daily_use) },
      { k: 'reorder_point', t: 'נקודת הזמנה', n: 1, f: r => nf.format(r.reorder_point) },
      { k: 'cover', t: 'ימי כיסוי', n: 1, f: r => `<span class="cover"><i style="width:${Math.min(r.cover, maxCover) / maxCover * 90}px"></i>${nf1.format(r.cover)}</span>` },
      { k: 'nearest_expiry', t: 'תפוגה', n: 1, sort: r => r.nearest_expiry || '9999', f: r => r.nearest_expiry ? `<span${r.expSoon ? ' style="color:var(--warn);font-weight:700"' : ''}>${ddmm(r.nearest_expiry)}</span>` : '<span class="muted">–</span>' },
      { k: 'value', t: 'שווי', n: 1, f: r => nis.format(r.value) },
      { k: 'status', t: 'מצב', sort: r => STATUS_ORDER[r.status] * 1000 + Math.min(r.cover, 999), f: r => pill(r.status, STATUS[r.status]) },
    ], s.sort);
  }
  draw();
}

function renderProcurement() {
  const open = M.pos.filter(p => !p.received_at);
  const late = open.filter(p => p.late), transit = open.filter(p => p.status === 'in_transit' && !p.late);
  $('#po-kpis').innerHTML = [
    kpi('הזמנות פתוחות', nf.format(open.length), `שווי ${nis.format(open.reduce((a, p) => a + p.value, 0))}`),
    kpi('באיחור', nf.format(late.length), late.length ? `שווי ${nis.format(late.reduce((a, p) => a + p.value, 0))}` : '', late.length > 0),
    kpi('בדרך', nf.format(transit.length), 'צפויות להגיע היום או מחר'),
    kpi('רכש ב-40 יום', nis.format(M.pos.reduce((a, p) => a + p.value, 0)), `${M.pos.length} הזמנות מ-${M.raw.suppliers.length} ספקים`),
  ].join('');

  const stLabel = p => p.late ? pill('late', `באיחור ${days(p.lateDays)}`) : p.status === 'in_transit' ? pill('in_transit', 'בדרך') : pill('ordered', 'הוזמן');
  table($('#po-open'), open, [
    { k: 'po_id', t: 'הזמנה', f: r => `<span class="mono">${esc(r.po_id)}</span>` },
    { k: 'sup', t: 'ספק', sort: r => r.sup.name, f: r => esc(r.sup.name) },
    { k: 'item', t: 'פריט', sort: r => r.item.name, f: r => esc(r.item.name) },
    { k: 'qty', t: 'כמות', n: 1, f: r => `${nf.format(r.qty)} <span class="muted small">${esc(r.item.unit)}</span>` },
    { k: 'value', t: 'שווי', n: 1, f: r => nis.format(r.value) },
    { k: 'ordered_at', t: 'הוזמן', n: 1, f: r => ddmm(r.ordered_at) },
    { k: 'expected_at', t: 'צפוי', n: 1, f: r => ddmm(r.expected_at) },
    { k: 'status', t: 'מצב', sort: r => (r.late ? 0 : r.status === 'in_transit' ? 1 : 2) * 100 - r.lateDays, f: stLabel },
  ], state.po.sortOpen, 'אין הזמנות פתוחות');

  const sups = M.raw.suppliers.map(s => {
    const mine = M.pos.filter(p => p.supplier_id === s.id), rec = mine.filter(p => p.received_at), lateRec = rec.filter(p => p.delayDays > 0);
    return { ...s, count: mine.length, received: rec.length, onTime: rec.length ? (rec.length - lateRec.length) / rec.length : null,
             avgDelay: lateRec.length ? lateRec.reduce((a, p) => a + p.delayDays, 0) / lateRec.length : 0,
             value: mine.reduce((a, p) => a + p.value, 0), open: mine.filter(p => !p.received_at).length };
  });
  table($('#po-suppliers'), sups, [
    { k: 'name', t: 'ספק', f: r => `${esc(r.name)}<span class="sub">${esc(r.category)}</span>` },
    { k: 'lead_time_days', t: 'זמן אספקה', n: 1, f: r => days(r.lead_time_days) },
    { k: 'received', t: 'התקבלו', n: 1, f: r => nf.format(r.received) },
    { k: 'onTime', t: 'בזמן', n: 1, sort: r => r.onTime ?? 2, f: r => r.onTime === null ? '–' : `<span class="cover"><i style="width:${r.onTime * 90}px;background:var(${r.onTime < 0.85 ? '--s2' : '--s1'})"></i>${pct(r.onTime, 0)}</span>` },
    { k: 'avgDelay', t: 'איחור ממוצע', n: 1, f: r => r.avgDelay ? days(Math.round(r.avgDelay * 10) / 10) : '–' },
    { k: 'open', t: 'פתוחות', n: 1, f: r => nf.format(r.open) },
    { k: 'value', t: 'שווי רכש', n: 1, f: r => nis.format(r.value) },
  ], state.po.sortSup);
}

function renderLogistics() {
  const s = state.lg;
  options($('#lg-branch'), M.branches.map(b => [b.id, b.name]), 'כל הסניפים', s.branch);
  $('#lg-branch').addEventListener('input', e => { s.branch = e.target.value; draw(); });
  function draw() {
    const sh = M.shipments.filter(x => !s.branch || x.location_id === s.branch);
    const del = sh.filter(x => x.status === 'delivered'), late = del.filter(x => !x.onTime);
    const today = sh.filter(x => x.date === M.asOf);
    const breaches = sh.filter(x => x.tempBreach);
    $('#lg-kpis').innerHTML = [
      kpi('משלוחים בזמן', del.length ? pct((del.length - late.length) / del.length) : '–', `${del.length} משלוחים ב-30 יום`),
      kpi('איחורים', nf.format(late.length), late.length ? `איחור ממוצע ${Math.round(late.reduce((a, x) => a + x.delay, 0) / late.length)} דקות` : ''),
      kpi('משלוחי היום', `${today.filter(x => x.status === 'delivered').length}/${today.length}`, 'הגיעו מתוך המתוכננים'),
      kpi('חריגות טמפרטורה', nf.format(breaches.length), 'ב-30 יום', breaches.length > 0),
    ].join('');

    const wd = WEEKDAYS[new Date(M.asOf + 'T00:00:00Z').getUTCDay()];
    $('#lg-today-label').textContent = `יום ${wd} ${ddmm(M.asOf)} · נכון ל-${M.raw.meta.as_of.slice(11, 16)}`;
    $('#lg-today').innerHTML = today.map(x => {
      const st = x.status === 'planned' ? pill('planned', 'מתוכנן') : x.onTime ? pill('ontime', 'הגיע בזמן') : pill('late', `איחור ${x.delay} דק׳`);
      return `<article class="run"><header><h3>${esc(x.loc.name)} · קו ${esc(x.run)}</h3>${st}</header><dl>
        <dt>מתוכנן</dt><dd class="ltr">${esc(x.planned_at)}</dd><dt>הגיע</dt><dd class="ltr">${esc(x.arrived_at || '–')}</dd>
        <dt>רכב</dt><dd>${esc(x.veh.id)} <span class="mono muted">${esc(x.veh.plate)}</span></dd><dt>נהג</dt><dd>${esc(x.driver)}</dd>
        <dt>ארגזים</dt><dd>${nf.format(x.crates)} מתוך ${nf.format(x.veh.capacity_crates)}</dd></dl></article>`;
    }).join('') || '<p class="empty">אין משלוחים היום</p>';

    $('#lg-ontime').dataset.label = 'אחוז משלוחים בזמן לפי יום';
    onTimeByDay($('#lg-ontime'), sh);

    const fleet = M.raw.vehicles.map(v => {
      const mine = sh.filter(x => x.vehicle_id === v.id), util = run => { const r = mine.filter(x => x.run === run); return r.length ? r.reduce((a, x) => a + x.crates, 0) / (r.length * v.capacity_crates) : null; };
      return { ...v, runs: mine.length, am: util('בוקר'), pm: util('צהריים') };
    });
    const utilCell = u => u === null ? '<span class="muted">–</span>' : `<span class="cover"><i style="width:${Math.min(u, 1) * 90}px;background:var(${u < 0.4 ? '--s2' : '--s1'})"></i>${pct(u, 0)}</span>`;
    table($('#lg-fleet'), fleet, [
      { k: 'id', t: 'רכב', f: r => `${esc(r.id)}<span class="sub">${esc(r.type)} · ${r.capacity_crates} ארגזים</span>` },
      { k: 'runs', t: 'נסיעות', n: 1, f: r => nf.format(r.runs) },
      { k: 'am', t: 'קו בוקר', n: 1, sort: r => r.am ?? -1, f: r => utilCell(r.am) },
      { k: 'pm', t: 'קו צהריים', n: 1, sort: r => r.pm ?? -1, f: r => utilCell(r.pm) },
    ], s.sortFleet);
    table($('#lg-temp'), breaches, [
      { k: 'date', t: 'תאריך', n: 1, f: r => ddmm(r.date) },
      { k: 'loc', t: 'סניף', sort: r => r.loc.name, f: r => `${esc(r.loc.name)}<span class="sub">קו ${esc(r.run)}</span>` },
      { k: 'vehicle_id', t: 'רכב', f: r => esc(r.vehicle_id) },
      { k: 'max_temp_c', t: 'טמפ׳ מקסימלית', n: 1, f: r => `<b style="color:var(--crit)">${nf1.format(r.max_temp_c)}°C</b>` },
    ], s.sortTemp, 'אין חריגות טמפרטורה בתקופה');
  }
  draw();
}

const wasteWindows = rows => globalThis.BakeryModel.wasteWindows(M, rows);
function renderWaste() {
  const s = state.ws;
  options($('#ws-branch'), M.branches.map(b => [b.id, b.name]), 'כל הסניפים', s.branch);
  $('#ws-branch').addEventListener('input', e => { s.branch = e.target.value; draw(); });
  const SER = [{ key: 'unsold', color: '--s1' }, { key: 'expired', color: '--s2' }, { key: 'damaged', color: '--s3' }];
  $('#ws-legend').innerHTML = SER.map(x => `<span><i style="background:var(${x.color})"></i>${esc(M.reasons[x.key])}</span>`).join('');
  function draw() {
    const rows = M.raw.waste.filter(r => !s.branch || r.location_id === s.branch);
    const total = rows.reduce((a, r) => a + r.value, 0), w = wasteWindows(rows);
    const byReason = SER.map(x => ({ k: x.key, v: rows.filter(r => r.reason === x.key).reduce((a, r) => a + r.value, 0) })).sort((a, b) => b.v - a.v);
    $('#ws-kpis').innerHTML = [
      kpi('פחת · 13 שבועות', nis.format(total), `${nf.format(rows.reduce((a, r) => a + r.units, 0))} יחידות`),
      kpi('פחת · 4 שבועות', nis.format(w.cur), delta(w.cur, w.prev), w.prev && w.cur > w.prev * 1.1),
      kpi('סיבה עיקרית', esc(M.reasons[byReason[0].k]), `${pct(byReason[0].v / total, 0)} מהפחת`),
      kpi('ממוצע שבועי', nis.format(total / M.weeks.length), ''),
    ].join('');
    const data = M.weeks.map(wk => {
      const vals = Object.fromEntries(SER.map(x => [x.key, rows.filter(r => r.week === wk && r.reason === x.key).reduce((a, r) => a + r.value, 0)]));
      const tot = Object.values(vals).reduce((a, v) => a + v, 0);
      return { label: ddmm(wk), values: vals,
               tip: `<span>שבוע מ-${ddmm(wk)}</span>${SER.map(x => `<span class="row"><span><i style="background:var(${x.color})"></i> ${esc(M.reasons[x.key])}</span><b>${nis.format(vals[x.key])}</b></span>`).join('')}<span class="row"><span>סה״כ</span><b>${nis.format(tot)}</b></span>` };
    });
    $('#ws-weekly').dataset.label = 'פחת שבועי לפי סיבה';
    columns($('#ws-weekly'), data, SER);

    const br = M.branches.map(b => {
      const mine = M.raw.waste.filter(r => r.location_id === b.id), ww = wasteWindows(mine);
      const top = SER.map(x => ({ k: x.key, v: mine.filter(r => r.reason === x.key && M.weeks.slice(-4).includes(r.week)).reduce((a, r) => a + r.value, 0) })).sort((a, c) => c.v - a.v)[0];
      return { id: b.id, name: b.name, cur: ww.cur, prev: ww.prev, change: ww.prev ? (ww.cur - ww.prev) / ww.prev : 0, top: M.reasons[top.k] };
    });
    table($('#ws-branches'), br, [
      { k: 'name', t: 'סניף', f: r => r.id === s.branch ? `<b>${esc(r.name)}</b>` : esc(r.name) },
      { k: 'cur', t: '4 שבועות אחרונים', n: 1, f: r => nis.format(r.cur) },
      { k: 'prev', t: '4 שבועות קודמים', n: 1, f: r => nis.format(r.prev) },
      { k: 'change', t: 'שינוי', n: 1, f: r => r.change > 0.1 ? pill('late', `עלייה ${pct(r.change, 0)}`) : r.change < -0.05 ? pill('ok', `ירידה ${pct(-r.change, 0)}`) : `<span class="muted">${r.change >= 0 ? '+' : ''}${pct(r.change, 0)}</span>` },
      { k: 'top', t: 'סיבה עיקרית', f: r => esc(r.top) },
    ], s.sort);
  }
  draw();
}

// ---------- calendar (external API: Hebcal, see assets/calendar.js) ----------
let CAL = { status: 'loading' };
const inDaysText = n => n === 0 ? 'היום' : n === 1 ? 'מחר' : `בעוד ${n} ימים`;
const hhmm = isoDateTime => isoDateTime ? isoDateTime.slice(11, 16) : '–';
const minusMinutes = (isoDateTime, m) => { if (!isoDateTime) return '–'; const t = toMin(isoDateTime.slice(11, 16)) - m; return `${pad2(Math.floor(t / 60))}:${pad2(t % 60)}`; };
const pad2 = n => String(n).padStart(2, '0');
const KIND_PILL = { closed: 'critical', demand: 'warning', early: 'info', info: 'planned' };

function renderCalendar() {
  if (CAL.status !== 'ok') {
    const msg = CAL.status === 'error' ? `לא הצלחתי לטעון את לוח השנה מ-Hebcal (${esc(CAL.error)}). שאר הדשבורד עובד כרגיל.` : 'טוען לוח שנה מ-Hebcal…';
    $('#cal-events').innerHTML = `<li class="empty" style="display:block">${msg}</li>`;
    return;
  }
  const d = CAL.data, ev = d.events.filter(e => e.inDays >= 0 || daysBetween(d.today, e.end) >= 0);
  const next = ev.find(e => e.kind !== 'info'), closedDays = ev.filter(e => e.kind === 'closed').length;
  const ta = d.shabbat.find(s => s.id === 'FLO');
  $('#cal-kpis').innerHTML = [
    kpi('האירוע הבא שמשפיע', next ? esc(next.title) : '–', next ? `${inDaysText(next.inDays)} · ${ddmm(next.start)}` : ''),
    kpi('אירועים ב-150 ימים', nf.format(ev.length), `${closedDays} ימי סגירה`),
    kpi('כניסת שבת · ת"א', hhmm(ta?.candles), ta?.candles ? `יום שישי ${ddmm(ta.candles.slice(0, 10))}` : ''),
    kpi('משלוח שישי אחרון', minusMinutes(ta?.candles, 180), 'שלוש שעות לפני כניסת השבת'),
  ].join('');
  $('#cal-meta').textContent = `נמשך מ-Hebcal ${new Date(d.fetchedAt).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })}${d.cached ? ' · מהעותק בדפדפן' : ''}`;
  $('#cal-events').innerHTML = ev.map(e => `<li>
      <div class="when"><b>${ddmm(e.start)}</b><span>${e.end !== e.start ? 'עד ' + ddmm(e.end) : WEEKDAYS[new Date(e.start + 'T00:00:00Z').getUTCDay()]}</span></div>
      <div><h3>${esc(e.title)} ${pill(KIND_PILL[e.kind], e.label)}</h3><p>${esc(e.action)}</p></div>
      <span class="soon">${inDaysText(Math.max(e.inDays, 0))}</span></li>`).join('') || '<li class="empty" style="display:block">אין חגים משמעותיים בתקופה הקרובה.</li>';
  const parasha = d.shabbat.find(s => s.parasha)?.parasha;
  $('#cal-parasha').textContent = parasha || '';
  table($('#cal-shabbat'), d.shabbat.map(s => ({ ...s, name: M.loc[s.id]?.name || s.id })), [
    { k: 'name', t: 'מיקום' },
    { k: 'candles', t: 'כניסת שבת', n: 1, f: r => hhmm(r.candles) },
    { k: 'havdalah', t: 'יציאת שבת', n: 1, f: r => hhmm(r.havdalah) },
    { k: 'close', t: 'סגירה מוצעת', n: 1, sort: r => r.candles, f: r => minusMinutes(r.candles, 60) },
    { k: 'last', t: 'משלוח אחרון', n: 1, sort: r => r.candles, f: r => r.id === 'CW' ? '<span class="muted">–</span>' : minusMinutes(r.candles, 180) },
  ], state.cal.sort);
}

// ---------- router ----------
const SCREENS = { overview: renderOverview, inventory: renderInventory, procurement: renderProcurement, logistics: renderLogistics, waste: renderWaste, calendar: renderCalendar };
const TITLES = { overview: 'סקירה', inventory: 'מלאי', procurement: 'רכש וספקים', logistics: 'משלוחים וצי', waste: 'פחת', calendar: 'חגים ותכנון' };
function route() {
  const id = SCREENS[location.hash.slice(1)] ? location.hash.slice(1) : 'overview';
  document.querySelectorAll('.tab').forEach(t => { if (t.getAttribute('href') === '#' + id) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current'); });
  $('#main').replaceChildren($('#tpl-' + id).content.cloneNode(true));
  SCREENS[id]();
  document.title = `${TITLES[id]} · מלאי ולוגיסטיקה · מאפיית הבית`;
}

// ---------- data sources ----------
// data/data.js sets window.DATA_SOURCES = { airtable?, mock }. The built site carries both; the source tree only mock.
// "airtable" is the snapshot the deploy job pulled from Airtable - the token never reaches the browser.
const SOURCE_LABEL = { airtable: 'Airtable', mock: 'סטטי' };
const PREF_KEY = 'bakery-logistics:source';
let SOURCES = null, current = null;
const pref = {
  get() { try { return localStorage.getItem(PREF_KEY); } catch { return null; } },
  set(v) { try { localStorage.setItem(PREF_KEY, v); } catch { /* storage blocked: the choice lasts for this visit */ } },
};
const asOfText = meta => `${ddmm(meta.as_of.slice(0, 10))}.${meta.as_of.slice(0, 4)} ${meta.as_of.slice(11, 16)}`;

function useSource(key) {
  current = key;
  M = buildModel(SOURCES[key]);
  const meta = M.raw.meta;
  const synced = meta.synced_at ? new Date(meta.synced_at).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '';
  $('#source').innerHTML = meta.source === 'airtable'
    ? `<span class="dot airtable"></span>מקור: <b>Airtable</b> · סונכרן ${esc(synced)}`
    : `<span class="dot mock"></span>מקור: <b>סטטי (נתוני דמה)</b> · נכון ל-${esc(asOfText(meta))}`;
  $('#footer-asof').textContent = `תמונת מצב: ${asOfText(meta)}`;
  document.querySelectorAll('#source-switch button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.src === key)));
  const critical = alerts().filter(a => a.sev === 'critical').length;
  const cnt = $('#cnt-alerts'); cnt.hidden = !critical; cnt.textContent = critical; cnt.title = `${critical} התראות קריטיות`;
  route(); // re-render the current screen; filter choices live in `state` and are kept
}

async function start() {
  try {
    SOURCES = window.DATA_SOURCES || null;
    for (const url of DATA_URLS) { // fallback when data/data.js is missing
      if (SOURCES) break;
      const res = await fetch(url, { cache: 'no-cache' }).catch(() => null);
      if (res?.ok) { const raw = await res.json(); SOURCES = { [raw.meta.source]: raw }; }
    }
    if (!SOURCES || !Object.keys(SOURCES).length) throw new Error('no data file found');
  } catch (e) {
    $('#main').innerHTML = `<div class="error">לא הצלחתי לטעון את הנתונים (${esc(e.message)}). ודא שהקובץ data/data.js קיים: הרץ <span class="mono">npm run mock</span>.</div>`;
    $('#source').innerHTML = '<span class="dot"></span>אין נתונים';
    return;
  }
  const keys = ['airtable', 'mock'].filter(k => SOURCES[k]);
  if (keys.length > 1) {
    const sw = $('#source-switch');
    sw.innerHTML = keys.map(k => `<button type="button" data-src="${k}" aria-pressed="false" title="${k === 'airtable' ? 'הנתונים שנמשכו מ-Airtable בסנכרון האחרון' : 'נתוני הדמה שבקוד (data/mock-data.json)'}"><span class="dot ${k}"></span>${SOURCE_LABEL[k]}</button>`).join('');
    sw.hidden = false;
    sw.addEventListener('click', e => {
      const b = e.target.closest('button[data-src]');
      if (b && b.dataset.src !== current) { pref.set(b.dataset.src); useSource(b.dataset.src); }
    });
  }
  window.addEventListener('hashchange', route);
  useSource(keys.includes(pref.get()) ? pref.get() : keys[0]);

  // External calendar loads in the background; the dashboard never waits for it or breaks without it.
  const refresh = () => { if (['overview', 'calendar'].includes(location.hash.slice(1) || 'overview')) route(); };
  (window.Calendar ? window.Calendar.load() : Promise.reject(new Error('calendar.js did not load')))
    .then(data => { CAL = { status: 'ok', data }; refresh(); })
    .catch(e => { CAL = { status: 'error', error: e.message }; refresh(); });
}
start();
