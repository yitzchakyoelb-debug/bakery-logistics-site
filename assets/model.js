// Business rules and summary metrics (SPEC.md section 5), shared by the browser (assets/app.js)
// and the build (scripts/build-site.mjs -> report.json), so the dashboard and the weekly report
// can never disagree. Plain script: sets globalThis.BakeryModel; also importable from Node.
'use strict';
(function () {
  const ON_TIME_MIN = 15;
  const toMin = t => +t.slice(0, 2) * 60 + +t.slice(3, 5);
  const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);

  function buildModel(raw) {
    const asOf = raw.meta.as_of.slice(0, 10), asOfMin = toMin(raw.meta.as_of.slice(11, 16));
    const item = Object.fromEntries(raw.items.map(i => [i.sku, i]));
    const loc = Object.fromEntries(raw.locations.map(l => [l.id, l]));
    const sup = Object.fromEntries(raw.suppliers.map(s => [s.id, s]));
    const veh = Object.fromEntries(raw.vehicles.map(v => [v.id, v]));

    const stock = raw.stock.map(r => {
      const it = item[r.sku], cover = r.avg_daily_use ? r.on_hand / r.avg_daily_use : Infinity;
      let status = 'ok';
      if (r.on_hand <= r.safety_stock || cover < r.lead_time_days) status = 'critical';
      else if (r.on_hand <= r.reorder_point) status = 'low';
      else if (it.shelf_life_days ? cover > it.shelf_life_days : cover > 60) status = 'overstock';
      const expSoon = it.category === 'raw' && r.nearest_expiry && r.nearest_expiry <= addDays(asOf, 2);
      return { ...r, item: it, loc: loc[r.location_id], cover, status, value: r.on_hand * it.unit_cost, expSoon };
    });

    const shipments = raw.shipments.map(s => {
      const delay = s.arrived_at ? toMin(s.arrived_at) - toMin(s.planned_at) : null;
      return { ...s, loc: loc[s.location_id], veh: veh[s.vehicle_id], delay, onTime: delay !== null && delay <= ON_TIME_MIN,
               tempBreach: s.max_temp_c !== null && s.max_temp_c > 5 && veh[s.vehicle_id].refrigerated };
    });

    const pos = raw.purchase_orders.map(p => {
      const late = !p.received_at && p.expected_at < asOf;
      return { ...p, item: item[p.sku], sup: sup[p.supplier_id], late, lateDays: late ? daysBetween(p.expected_at, asOf) : 0,
               delayDays: p.received_at ? daysBetween(p.expected_at, p.received_at) : null };
    });

    const weeks = [...new Set(raw.waste.map(w => w.week))].sort();
    return { raw, asOf, asOfMin, item, loc, sup, veh, stock, shipments, pos, weeks, reasons: raw.meta.reasons,
             branches: raw.locations.filter(l => l.type === 'branch') };
  }

  // Waste in the last 4 weeks vs the 4 before.
  function wasteWindows(M, rows) {
    const cur = M.weeks.slice(-4), prev = M.weeks.slice(-8, -4);
    const sum = set => rows.filter(r => set.includes(r.week)).reduce((a, r) => a + r.value, 0);
    return { cur: sum(cur), prev: sum(prev) };
  }

  // Every headline number, computed once.
  function summarize(M) {
    const crit = M.stock.filter(r => r.status === 'critical'), low = M.stock.filter(r => r.status === 'low');
    const exp = M.stock.filter(r => r.expSoon);
    const del = M.shipments.filter(s => s.status === 'delivered'), onTime = del.filter(s => s.onTime).length;
    const rec = M.pos.filter(p => p.received_at), recOk = rec.filter(p => p.delayDays <= 0).length;
    const open = M.pos.filter(p => !p.received_at), lateOpen = open.filter(p => p.late);
    const waste = wasteWindows(M, M.raw.waste);
    const wasteByBranch = M.branches.map(b => {
      const w = wasteWindows(M, M.raw.waste.filter(r => r.location_id === b.id));
      return { id: b.id, name: b.name, cur: w.cur, prev: w.prev, change: w.prev ? (w.cur - w.prev) / w.prev : 0 };
    });
    return {
      inventoryValue: M.stock.reduce((a, r) => a + r.value, 0),
      stockRows: M.stock.length, locations: M.raw.locations.length,
      critical: crit.length, low: low.length,
      criticalItems: [...crit].sort((a, b) => a.cover - b.cover)
        .map(r => ({ name: r.item.name, unit: r.item.unit, onHand: r.on_hand, cover: r.cover, location: r.loc.name })),
      expiring: { count: exp.length, value: exp.reduce((a, r) => a + r.value, 0) },
      deliveries: { delivered: del.length, onTime, late: del.length - onTime, rate: del.length ? onTime / del.length : null,
                    tempBreaches: M.shipments.filter(s => s.tempBreach).length },
      suppliers: { received: rec.length, onTime: recOk, rate: rec.length ? recOk / rec.length : null },
      purchaseOrders: { open: open.length, openValue: open.reduce((a, p) => a + p.value, 0),
                        late: lateOpen.map(p => ({ id: p.po_id, item: p.item.name, supplier: p.sup.name, lateDays: p.lateDays })) },
      waste: { cur: waste.cur, prev: waste.prev, change: waste.prev ? (waste.cur - waste.prev) / waste.prev : 0, byBranch: wasteByBranch },
    };
  }

  globalThis.BakeryModel = { ON_TIME_MIN, toMin, addDays, daysBetween, buildModel, wasteWindows, summarize };
})();
