// services/dataProcessor.js — Cálculo de las 16 métricas, dashboard-all y helpers de inserción (SPEC §6).
const { db, getMeta, setMeta } = require('../database/db');
const { esAnulReembolsoPuro, sinCostoAdquisicion, MESES_NOMBRES } = require('./excelParser');

const MARKETPLACES = ['mercadolibre', 'amazon', 'walmart', 'tiktok', 'aliexpress'];

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const r1 = (n) => Math.round((n + Number.EPSILON) * 10) / 10;

// Plantilla de métricas en cero (marketplace sin_datos)
const metricasCeros = () => ({
  ventas_totales: 0,
  ventas_por_publicidad: 0,
  ventas_organicas: 0,
  ganancia_neta_pct: 0,
  ganancia_neta: 0,
  cargo_venta: 0,
  costo_adquisicion: 0,
  anulaciones: 0,
  reembolsos: 0,
  costo_publicidad: 0,
  costo_envio: 0,
  acos: null,
  tacos: null,
  costos_totales: 0,
  contracargos: 0,
  ret_isr: 0,
  ret_iva: 0,
  unidades_vendidas: 0,
  num_transacciones: 0,
  skus_sin_costeo: 0,
});

// Mapa SKU → costo_unitario (matching case-insensitive con trim)
const getCosteoMap = () => {
  const map = new Map();
  for (const row of db.prepare('SELECT sku, costo_unitario FROM costeo').all()) {
    map.set(String(row.sku).trim().toLowerCase(), row.costo_unitario || 0);
  }
  return map;
};

// Filtro de rango de fechas sobre la parte de fecha ISO (YYYY-MM-DD)
const enRango = (fecha, desde, hasta) => {
  if (!fecha) return !desde && !hasta;
  const d = String(fecha).slice(0, 10);
  if (desde && d < desde) return false;
  if (hasta && d > hasta) return false;
  return true;
};

// Suma de contracargos (cargo/chargeback manual) cuyo mes 'YYYY-MM' intersecta el rango
const getContracargosTotal = (marketplace, desde, hasta) => {
  const rows = marketplace
    ? db.prepare('SELECT mes, monto FROM contracargos WHERE marketplace = ?').all(marketplace)
    : db.prepare('SELECT mes, monto FROM contracargos').all();
  let total = 0;
  for (const r of rows) {
    const mes = String(r.mes || '');
    if (desde && mes < desde.slice(0, 7)) continue;
    if (hasta && mes > hasta.slice(0, 7)) continue;
    total += r.monto || 0;
  }
  return r2(total);
};

// Calcula las 17 métricas de un marketplace para un rango de fechas (sin rango = todo)
const getMetricas = (marketplace, desde, hasta) => {
  const rows = db.prepare('SELECT * FROM sales WHERE marketplace = ?').all(marketplace);
  const ccTotal = getContracargosTotal(marketplace, desde, hasta);
  if (!rows.length) {
    // Sin ventas: los contracargos capturados igual se muestran como gasto
    const m0 = metricasCeros();
    m0.contracargos = ccTotal;
    m0.costos_totales = ccTotal;
    m0.ganancia_neta = -ccTotal;
    return { estado: 'sin_datos', metricas: m0 };
  }

  const costeoMap = getCosteoMap();
  // Porcentajes mensuales de publicidad ML (sentinela marketplace='mercadolibre_pct')
  const pctPorMes = new Map();
  if (marketplace === 'mercadolibre') {
    for (const a of db.prepare("SELECT fecha, inversion FROM ads WHERE marketplace = 'mercadolibre_pct'").all()) {
      pctPorMes.set(String(a.fecha).toLowerCase(), a.inversion || 0);
    }
  }

  const m = metricasCeros();
  const skusSinCosteo = new Set();
  const ventasValidasPorMes = new Array(12).fill(0); // para publicidad porcentaje ML

  for (const r of rows) {
    if (!enRango(r.fecha, desde, hasta)) continue;
    m.num_transacciones += 1;
    m.cargo_venta += r.comision || 0;
    m.costo_envio += r.envio || 0;
    m.anulaciones += r.anulacion || 0;
    m.reembolsos += r.reembolso || 0;

    // Filas de anulación/reembolso puras no cuentan como venta (tarjetas 8/9 las capturan)
    if (esAnulReembolsoPuro(r)) continue;

    m.ventas_totales += r.ingreso || 0;
    m.unidades_vendidas += r.unidades || 0;
    if (marketplace === 'mercadolibre') {
      if (r.venta_por_publicidad === 1) m.ventas_por_publicidad += r.ingreso || 0;
      if (r.fecha) {
        const mes = new Date(r.fecha).getMonth();
        if (!isNaN(mes)) ventasValidasPorMes[mes] += r.ingreso || 0;
      }
    }
    // Costo de adquisición: costo_unitario[sku] × unidades (SKU sin costeo → costo 0)
    // Regla usuario: filas anuladas/devueltas/reembolsadas aportan costo 0.
    if (sinCostoAdquisicion(r)) continue;
    const costo = costeoMap.get(String(r.sku || '').trim().toLowerCase());
    if (costo === undefined) {
      if (r.sku) skusSinCosteo.add(String(r.sku).trim());
    } else {
      m.costo_adquisicion += costo * (r.unidades || 0);
    }
  }

  // Costo de publicidad: ML = ads directos + (sentinela porcentaje) ventas_totales_mes × pct
  if (marketplace === 'mercadolibre') {
    const directos = db.prepare("SELECT fecha, inversion FROM ads WHERE marketplace = 'mercadolibre'").all();
    for (const a of directos) {
      if (enRango(a.fecha, desde, hasta)) m.costo_publicidad += a.inversion || 0;
    }
    pctPorMes.forEach((pct, mesNombre) => {
      const idx = MESES_NOMBRES.indexOf(mesNombre);
      if (idx >= 0) m.costo_publicidad += ventasValidasPorMes[idx] * pct;
    });
  }

  m.ventas_organicas = m.ventas_totales - m.ventas_por_publicidad;
  // Contracargos: gasto adicional capturado manualmente por mes (SPEC-v2 §3)
  m.contracargos = ccTotal;
  // Regla usuario: ganancia neta = ventas totales − costos totales
  // (costos totales = adquisición + cargo + envío + publicidad + contracargos).
  // Anulaciones/reembolsos NO se restan aquí: sus ventas ya no cuentan como ingreso.
  m.ganancia_neta = m.ventas_totales - m.costo_adquisicion - m.cargo_venta - m.costo_envio
    - m.costo_publicidad - m.contracargos;
  m.ganancia_neta_pct = m.ventas_totales > 0 ? (m.ganancia_neta / m.ventas_totales) * 100 : 0;
  // Retenciones: SOLO visualización, calculadas sobre la base gravable (ventas ÷ 1.16).
  // NO se suman a costos_totales ni afectan la ganancia neta.
  m.ret_isr = (m.ventas_totales / 1.16) * 0.025;
  m.ret_iva = (m.ventas_totales / 1.16) * 0.08;
  // Regla usuario: anulaciones y reembolsos NO se suman a costos totales
  // (se muestran en sus tarjetas 8/9 y sí se restan en la ganancia neta).
  m.costos_totales = m.costo_adquisicion + m.cargo_venta + m.costo_envio + m.costo_publicidad
    + m.contracargos;
  // ACOS/TACOS: solo aplican a Mercado Libre (publicidad)
  if (marketplace === 'mercadolibre') {
    m.acos = m.ventas_por_publicidad > 0 ? (m.costo_publicidad / m.ventas_por_publicidad) * 100 : null;
    m.tacos = m.ventas_totales > 0 ? (m.costo_publicidad / m.ventas_totales) * 100 : null;
  }
  m.skus_sin_costeo = skusSinCosteo.size;

  // Redondeo de presentación
  const money = ['ventas_totales', 'ventas_por_publicidad', 'ventas_organicas', 'ganancia_neta',
    'cargo_venta', 'costo_adquisicion', 'anulaciones', 'reembolsos', 'costo_publicidad',
    'costo_envio', 'costos_totales', 'contracargos', 'ret_isr', 'ret_iva'];
  for (const k of money) m[k] = r2(m[k]);
  m.ganancia_neta_pct = r1(m.ganancia_neta_pct);
  if (m.acos !== null) m.acos = r1(m.acos);
  if (m.tacos !== null) m.tacos = r1(m.tacos);
  return { estado: 'activo', metricas: m };
};

// ---------- Comparativa mensual (SPEC-v2 §4): mes actual vs mes anterior ----------

const rangoMes = (y, mIdx) => {
  const mm = String(mIdx + 1).padStart(2, '0');
  const ultimo = new Date(Date.UTC(y, mIdx + 1, 0)).getUTCDate();
  return { desde: `${y}-${mm}-01`, hasta: `${y}-${mm}-${ultimo}`, clave: `${y}-${mm}` };
};

// Ventas diarias (solo filas de venta válidas) de un marketplace o de todos (null)
const getVentasDiarias = (marketplace, desde, hasta) => {
  const rows = marketplace
    ? db.prepare('SELECT fecha, ingreso, anulacion, reembolso FROM sales WHERE marketplace = ?').all(marketplace)
    : db.prepare('SELECT fecha, ingreso, anulacion, reembolso FROM sales').all();
  const porDia = new Map();
  for (const r of rows) {
    if (!r.fecha || !enRango(r.fecha, desde, hasta)) continue;
    if (esAnulReembolsoPuro(r)) continue;
    const dia = String(r.fecha).slice(0, 10);
    porDia.set(dia, (porDia.get(dia) || 0) + (r.ingreso || 0));
  }
  return [...porDia.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([fecha, total]) => ({ fecha, total: r2(total) }));
};

const getComparativaMensual = (marketplace) => {
  const hoy = new Date();
  const y = hoy.getFullYear();
  const mi = hoy.getMonth();
  const prev = new Date(y, mi - 1, 1);
  const ra = rangoMes(y, mi);
  const rp = rangoMes(prev.getFullYear(), prev.getMonth());

  let mes_actual, mes_anterior;
  if (marketplace) {
    mes_actual = getMetricas(marketplace, ra.desde, ra.hasta).metricas;
    mes_anterior = getMetricas(marketplace, rp.desde, rp.hasta).metricas;
  } else {
    // Agregado de todos los marketplaces
    const sumar = (desde, hasta) => {
      const t = metricasCeros();
      for (const mp of MARKETPLACES) {
        const m = getMetricas(mp, desde, hasta).metricas;
        for (const k of Object.keys(t)) {
          if (k === 'acos' || k === 'tacos' || k === 'ganancia_neta_pct') continue;
          t[k] += m[k] || 0;
        }
      }
      t.ganancia_neta_pct = t.ventas_totales > 0 ? r1((t.ganancia_neta / t.ventas_totales) * 100) : 0;
      t.acos = t.ventas_por_publicidad > 0 ? r1((t.costo_publicidad / t.ventas_por_publicidad) * 100) : null;
      t.tacos = t.ventas_totales > 0 ? r1((t.costo_publicidad / t.ventas_totales) * 100) : null;
      return t;
    };
    mes_actual = sumar(ra.desde, ra.hasta);
    mes_anterior = sumar(rp.desde, rp.hasta);
  }

  return {
    etiquetas: {
      actual: `${MESES_NOMBRES[mi]} ${y}`,
      anterior: `${MESES_NOMBRES[prev.getMonth()]} ${prev.getFullYear()}`,
      actual_mes: ra.clave,
      anterior_mes: rp.clave,
    },
    mes_actual,
    mes_anterior,
    ventas_diarias_actual: getVentasDiarias(marketplace, ra.desde, ra.hasta),
    ventas_diarias_anterior: getVentasDiarias(marketplace, rp.desde, rp.hasta),
  };
};

// GET /api/dashboard/:marketplace
const getDashboard = (marketplace, desde, hasta) => {
  const { estado, metricas } = getMetricas(marketplace, desde, hasta);
  const rows = db.prepare('SELECT * FROM sales WHERE marketplace = ? ORDER BY fecha DESC').all(marketplace);
  const transacciones = rows
    .filter((r) => enRango(r.fecha, desde, hasta))
    .map((r) => ({
      id: r.id, fecha: r.fecha, sku: r.sku, producto: r.producto, unidades: r.unidades,
      ingreso: r.ingreso, comision: r.comision, envio: r.envio, anulacion: r.anulacion,
      reembolso: r.reembolso, ret_isr: r.ret_isr, ret_iva: r.ret_iva,
      venta_por_publicidad: r.venta_por_publicidad, estado: r.estado,
    }));
  return { estado, metricas, transacciones, comparativa: getComparativaMensual(marketplace) };
};

// GET /api/dashboard-all — comparativa de los 5 marketplaces + totales + ventas diarias
const getDashboardAll = (desde, hasta) => {
  const por_marketplace = {};
  const activos = [];
  const totales = metricasCeros();

  for (const mp of MARKETPLACES) {
    const { estado, metricas } = getMetricas(mp, desde, hasta);
    por_marketplace[mp] = { estado, metricas };
    if (estado !== 'activo') continue;
    activos.push(mp);
    for (const k of Object.keys(totales)) {
      if (k === 'acos' || k === 'tacos' || k === 'ganancia_neta_pct') continue;
      totales[k] += metricas[k] || 0;
    }
  }
  // KPIs derivados del total (solo activos)
  totales.ganancia_neta_pct = totales.ventas_totales > 0 ? r1((totales.ganancia_neta / totales.ventas_totales) * 100) : 0;
  totales.acos = totales.ventas_por_publicidad > 0 ? r1((totales.costo_publicidad / totales.ventas_por_publicidad) * 100) : null;
  totales.tacos = totales.ventas_totales > 0 ? r1((totales.costo_publicidad / totales.ventas_totales) * 100) : null;
  for (const k of Object.keys(totales)) {
    if (typeof totales[k] === 'number' && k !== 'ganancia_neta_pct' && k !== 'acos' && k !== 'tacos'
      && k !== 'unidades_vendidas' && k !== 'num_transacciones' && k !== 'skus_sin_costeo') {
      totales[k] = r2(totales[k]);
    }
  }

  // Ventas diarias combinadas (solo filas de venta válidas) para la gráfica de línea
  const ventas_diarias = getVentasDiarias(null, desde, hasta);

  return {
    por_marketplace, totales, ventas_diarias, activos,
    comparativa: getComparativaMensual(null),
  };
};

// GET /api/status — estado de marketplaces y archivos auxiliares
const getStatus = () => {
  const marketplaces = {};
  for (const mp of MARKETPLACES) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM sales WHERE marketplace = ?').get(mp).n;
    marketplaces[mp] = {
      estado: n > 0 ? 'activo' : 'sin_datos',
      ultima_actualizacion: getMeta(`ultima_actualizacion_ventas_${mp}`),
      ventas_rows: n,
    };
  }
  const hay = (sql) => db.prepare(sql).get().n > 0;
  return {
    marketplaces,
    archivos: {
      costeo: hay('SELECT COUNT(*) AS n FROM costeo'),
      publicidad: hay("SELECT COUNT(*) AS n FROM ads WHERE marketplace IN ('mercadolibre','mercadolibre_pct')"),
      inventario_full_ml: hay("SELECT COUNT(*) AS n FROM inventory_full WHERE marketplace = 'mercadolibre'"),
      inventario_fba_amazon: hay("SELECT COUNT(*) AS n FROM inventory_full WHERE marketplace = 'amazon'"),
    },
  };
};

// Estima precio_venta del costeo como promedio del precio unitario de ventas del SKU (SPEC §4).
// Se ejecuta tras cargar ventas o costeo. SKUs sin ventas quedan en 0.
const updatePreciosEstimados = () => {
  const acum = new Map(); // skuLower → {suma, unidades}
  for (const r of db.prepare('SELECT sku, unidades, ingreso, anulacion, reembolso FROM sales').all()) {
    if (esAnulReembolsoPuro(r) || !r.sku || !r.unidades) continue;
    const k = String(r.sku).trim().toLowerCase();
    const a = acum.get(k) || { suma: 0, unidades: 0 };
    a.suma += r.ingreso || 0;
    a.unidades += r.unidades || 0;
    acum.set(k, a);
  }
  const upd = db.prepare('UPDATE costeo SET precio_venta = ? WHERE sku = ?');
  const tx = db.transaction(() => {
    for (const row of db.prepare('SELECT sku FROM costeo').all()) {
      const a = acum.get(String(row.sku).trim().toLowerCase());
      upd.run(a && a.unidades > 0 ? r2(a.suma / a.unidades) : 0, row.sku);
    }
  });
  tx();
};

// ---------- Helpers de inserción (borrado previo por fileType/marketplace) ----------

const insertSales = (marketplace, records) => {
  const ins = db.prepare(`INSERT INTO sales
    (marketplace, fecha, sku, producto, unidades, ingreso, comision, envio, anulacion, reembolso, ret_isr, ret_iva, venta_por_publicidad, estado)
    VALUES (@marketplace, @fecha, @sku, @producto, @unidades, @ingreso, @comision, @envio, @anulacion, @reembolso, @ret_isr, @ret_iva, @venta_por_publicidad, @estado)`);
  const tx = db.transaction((recs) => {
    db.prepare('DELETE FROM sales WHERE marketplace = ?').run(marketplace);
    for (const r of recs) ins.run(r);
  });
  tx(records);
  setMeta(`ultima_actualizacion_ventas_${marketplace}`, new Date().toISOString());
};

const insertAds = (records) => {
  const ins = db.prepare(`INSERT INTO ads (marketplace, fecha, sku, inversion, ventas_generadas, clicks, impresiones)
    VALUES (@marketplace, @fecha, @sku, @inversion, @ventas_generadas, @clicks, @impresiones)`);
  const tx = db.transaction((recs) => {
    db.prepare("DELETE FROM ads WHERE marketplace IN ('mercadolibre','mercadolibre_pct')").run();
    for (const r of recs) ins.run(r);
  });
  tx(records);
  setMeta('ultima_actualizacion_publicidad_mercadolibre', new Date().toISOString());
};

const insertCosteo = (records) => {
  const ins = db.prepare(`INSERT OR REPLACE INTO costeo (sku, producto, categoria, costo_unitario, precio_venta, stock_sucursal)
    VALUES (@sku, @producto, @categoria, @costo_unitario, @precio_venta, @stock_sucursal)`);
  const tx = db.transaction((recs) => {
    db.prepare('DELETE FROM costeo').run();
    for (const r of recs) ins.run(r);
  });
  tx(records);
  setMeta('ultima_actualizacion_costeo', new Date().toISOString());
};

const insertInventory = (marketplace, records) => {
  const ins = db.prepare(`INSERT OR REPLACE INTO inventory_full (sku, marketplace, stock, costo_almacenaje, dias_inventario, ventas_30d)
    VALUES (@sku, @marketplace, @stock, @costo_almacenaje, @dias_inventario, @ventas_30d)`);
  const tx = db.transaction((recs) => {
    db.prepare('DELETE FROM inventory_full WHERE marketplace = ?').run(marketplace);
    for (const r of recs) ins.run(r);
  });
  tx(records);
  setMeta(`ultima_actualizacion_inventario_${marketplace === 'amazon' ? 'fba_amazon' : 'full_ml'}`, new Date().toISOString());
};

// ---------- Contracargos (SPEC-v2 §3) ----------

const getContracargos = () =>
  db.prepare('SELECT marketplace, mes, monto FROM contracargos ORDER BY mes DESC, marketplace').all();

const setContracargo = (marketplace, mes, monto) => {
  if (!MARKETPLACES.includes(marketplace)) throw new Error('Marketplace inválido');
  if (!/^\d{4}-\d{2}$/.test(String(mes))) throw new Error('Mes inválido (formato YYYY-MM)');
  const val = Number(monto);
  if (!Number.isFinite(val) || val < 0) throw new Error('Monto inválido');
  db.prepare('INSERT OR REPLACE INTO contracargos (marketplace, mes, monto) VALUES (?, ?, ?)')
    .run(marketplace, mes, r2(val));
  return { marketplace, mes, monto: r2(val) };
};

module.exports = {
  MARKETPLACES,
  metricasCeros,
  getMetricas,
  getDashboard,
  getDashboardAll,
  getComparativaMensual,
  getContracargos,
  setContracargo,
  getStatus,
  updatePreciosEstimados,
  insertSales,
  insertAds,
  insertCosteo,
  insertInventory,
};
