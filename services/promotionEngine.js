// services/promotionEngine.js — Módulo 2: motor de sugerencias de promociones (SPEC §7).
// Cruza sales (unidades por SKU del último periodo disponible) + costeo + inventory_full.
const { db } = require('../database/db');
const { esAnulReembolsoPuro } = require('./excelParser');

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Percentil simple (lineal) sobre un arreglo numérico ordenado
const percentile = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
};

// Construye el universo de SKUs cruzando ventas + costeo + inventarios Full/FBA
const buildUniverso = () => {
  // Último periodo completo disponible: últimos 30 días desde la fecha máxima de ventas
  const maxFecha = db.prepare('SELECT MAX(fecha) AS f FROM sales').get().f;
  const limite30 = maxFecha
    ? new Date(new Date(maxFecha).getTime() - 30 * 86400 * 1000).toISOString().slice(0, 10)
    : null;

  const ventas = new Map(); // skuLower → agregados
  for (const r of db.prepare('SELECT sku, producto, unidades, ingreso, fecha, anulacion, reembolso FROM sales').all()) {
    if (!r.sku || esAnulReembolsoPuro(r)) continue;
    const k = String(r.sku).trim().toLowerCase();
    const v = ventas.get(k) || {
      sku: String(r.sku).trim(), producto: '', unidades_total: 0, unidades_30d: 0, ingreso_total: 0,
    };
    if (!v.producto && r.producto) v.producto = r.producto;
    v.unidades_total += r.unidades || 0;
    v.ingreso_total += r.ingreso || 0;
    if (limite30 && r.fecha && String(r.fecha).slice(0, 10) >= limite30) v.unidades_30d += r.unidades || 0;
    ventas.set(k, v);
  }

  const costeo = new Map();
  for (const c of db.prepare('SELECT * FROM costeo').all()) {
    costeo.set(String(c.sku).trim().toLowerCase(), c);
  }
  const fullML = new Map();
  const fba = new Map();
  for (const i of db.prepare('SELECT * FROM inventory_full').all()) {
    const k = String(i.sku).trim().toLowerCase();
    if (i.marketplace === 'mercadolibre') fullML.set(k, i);
    else if (i.marketplace === 'amazon') fba.set(k, i);
  }

  // Universo = unión de SKUs presentes en cualquiera de las fuentes
  const claves = new Set([...ventas.keys(), ...costeo.keys(), ...fullML.keys(), ...fba.keys()]);
  const skus = [];
  for (const k of claves) {
    const v = ventas.get(k) || null;
    const c = costeo.get(k) || null;
    const f = fullML.get(k) || null;
    const b = fba.get(k) || null;
    const costo = c ? (c.costo_unitario || 0) : 0;
    // Precio estimado: promedio de precio unitario de ventas; fallback precio_venta del costeo
    let precio = c ? (c.precio_venta || 0) : 0;
    if (v && v.unidades_total > 0) precio = v.ingreso_total / v.unidades_total;
    const stock_full_ml = f ? (f.stock || 0) : 0;
    const stock_fba = b ? (b.stock || 0) : 0;
    const stock_sucursal = c ? (c.stock_sucursal || 0) : 0;
    skus.push({
      sku: (v && v.sku) || (c && c.sku) || (f && f.sku) || (b && b.sku),
      producto: (v && v.producto) || (c && c.producto) || '',
      categoria: c ? (c.categoria || '') : '',
      costo,
      precio: r2(precio),
      unidades_total: v ? v.unidades_total : 0,
      unidades_mes: v ? v.unidades_30d : 0,
      ingreso_total: v ? r2(v.ingreso_total) : 0,
      stock_full_ml,
      stock_fba,
      stock_sucursal,
      stock_total_full: stock_full_ml + stock_fba,                 // Stock_Total_Full
      stock_total_general: stock_full_ml + stock_fba + stock_sucursal, // Stock_Total_General
      ventas_30d_full: f ? (f.ventas_30d || 0) : 0,
      dias_inventario_full: f ? (f.dias_inventario || 0) : 0,
      costo_almacenaje_fba: b ? (b.costo_almacenaje || 0) : 0,
      dias_inventario_fba: b ? (b.dias_inventario || 0) : 0,
    });
  }
  return skus;
};

// Motor principal: devuelve los 6 paneles
const getPromociones = () => {
  const skus = buildUniverso();
  const conVentas = skus.filter((s) => s.unidades_total > 0);
  const sinVentas = skus.filter((s) => s.unidades_total === 0);

  // Percentiles p25/p75 de unidades vendidas entre SKUs con ventas (SPEC §7)
  const p25u = percentile(conVentas.map((s) => s.unidades_total), 0.25);
  const p75u = percentile(conVentas.map((s) => s.unidades_total), 0.75);

  // ---------- Panel 1: top 20 por unidades vendidas con existencias ----------
  const panel1 = [...conVentas]
    .sort((a, b) => (b.unidades_mes - a.unidades_mes) || (b.unidades_total - a.unidades_total))
    .slice(0, 20)
    .map((s) => {
      let promocion;
      if (s.stock_total_full < s.unidades_mes && s.stock_total_general < s.unidades_mes) {
        promocion = '⭐ Producto estrella - Mantener precio';
      } else if (s.unidades_total > p75u && s.stock_total_full > 2 * s.unidades_mes) {
        promocion = 'Descuento 10% + promoción en marketplace';
      } else if (s.unidades_total > p75u && s.stock_sucursal > 2 * s.unidades_mes) {
        promocion = 'Descuento 5-10% en canal físico';
      } else if (s.unidades_total > p75u) {
        promocion = 'Descuento 10% + promoción en marketplace';
      } else {
        promocion = 'Mantener precio + monitorear rotación';
      }
      return {
        sku: s.sku, producto: s.producto, categoria: s.categoria,
        unidades_vendidas: s.unidades_mes, unidades_total: s.unidades_total,
        stock_full_ml: s.stock_full_ml, stock_fba: s.stock_fba, stock_sucursal: s.stock_sucursal,
        stock_total_full: s.stock_total_full, stock_total_general: s.stock_total_general,
        precio_estimado: s.precio, promocion_sugerida: promocion,
      };
    });

  // ---------- Panel 2: SKUs del costeo con 0 ventas ----------
  const candidatos2 = sinVentas
    .filter((s) => s.costo > 0 || s.precio > 0)
    .map((s) => ({ ...s, precio_ref: s.precio > 0 ? s.precio : r2(s.costo * 1.4) }));
  const p75precio = percentile(candidatos2.map((s) => s.precio_ref), 0.75);
  const p25precio = percentile(candidatos2.map((s) => s.precio_ref), 0.25);
  const p75stock2 = percentile(candidatos2.map((s) => s.stock_total_general), 0.75);
  const panel2 = candidatos2
    .sort((a, b) => b.precio_ref - a.precio_ref)
    .slice(0, 20)
    .map((s) => {
      const caro = s.precio_ref > p75precio;
      const bajo = s.precio_ref < p25precio;
      const stockAlto = s.stock_total_general > p75stock2 && s.stock_total_general > 0;
      let promocion;
      if (caro && stockAlto) promocion = '⚠️ Descuento 30-35% + envío gratis urgente';
      else if (caro) promocion = 'Bundle con producto estrella + descuento 20%';
      else if (bajo) promocion = 'Bundle con producto complementario';
      else promocion = 'Descuento 20-25% + cupón destacado';
      return {
        sku: s.sku, producto: s.producto, categoria: s.categoria,
        precio_estimado: s.precio_ref, costo_unitario: s.costo,
        stock_full_ml: s.stock_full_ml, stock_fba: s.stock_fba, stock_sucursal: s.stock_sucursal,
        stock_total: s.stock_total_general,
        valor_inmovilizado: r2(s.stock_total_general * s.costo),
        promocion_sugerida: promocion,
      };
    });

  // ---------- Panel 3: rotación lenta (1–5 unidades vendidas) ----------
  const panel3 = conVentas
    .filter((s) => s.unidades_total >= 1 && s.unidades_total <= 5)
    .sort((a, b) => b.precio - a.precio)
    .slice(0, 20)
    .map((s) => ({
      sku: s.sku, producto: s.producto, categoria: s.categoria,
      unidades_vendidas: s.unidades_total, precio_estimado: s.precio,
      stock_total: s.stock_total_general,
      promocion_sugerida: s.stock_total_general > 3 * Math.max(s.unidades_mes, s.unidades_total / 12)
        ? 'Liquidación 25% para rotación'
        : 'Cupón 15-20% + publicidad segmentada',
    }));

  // ---------- Panel 4: top 20 stock en sucursal ----------
  const panel4 = skus
    .filter((s) => s.stock_sucursal > 0)
    .sort((a, b) => b.stock_sucursal - a.stock_sucursal)
    .slice(0, 20)
    .map((s) => {
      const ventasMes = Math.max(s.unidades_mes, s.unidades_total / 12);
      const sobre = s.stock_sucursal > 3 * ventasMes;
      return {
        sku: s.sku, producto: s.producto, categoria: s.categoria,
        stock_sucursal: s.stock_sucursal,
        unidades_mes: r2(ventasMes),
        valor_inmovilizado: r2(s.stock_sucursal * s.costo),
        alerta: sobre ? '⚠️ Sobreinventario en sucursal' : '',
        promocion_sugerida: sobre
          ? 'Campaña local + descuento 15-20% en punto de venta'
          : 'Mantener surtido; promoción local opcional',
      };
    });

  // ---------- Panel 5: top 20 stock Full + FBA combinado ----------
  const candidatos5 = skus.filter((s) => s.stock_total_full > 0);
  const p75full = percentile(candidatos5.map((s) => s.stock_full_ml), 0.75);
  const p75fba = percentile(candidatos5.map((s) => s.stock_fba), 0.75);
  const panel5 = candidatos5
    .sort((a, b) => b.stock_total_full - a.stock_total_full)
    .slice(0, 20)
    .map((s) => {
      const ventasMes = Math.max(s.unidades_mes, s.ventas_30d_full, s.unidades_total / 12);
      const muchoML = s.stock_full_ml >= s.stock_fba && s.stock_full_ml > p75full;
      const muchoFBA = s.stock_fba > s.stock_full_ml && s.stock_fba > p75fba;
      let promocion;
      if (s.stock_full_ml > 3 * ventasMes && s.stock_full_ml > 0) {
        promocion = '⚡ ALERTA ALMACENAJE: Descuento 30-40% para liberar espacio YA';
      } else if (muchoML && s.stock_fba > 0) {
        promocion = '⚠️ ALERTA: Descuento 30-40% urgente en ambos canales';
      } else if (muchoML) {
        promocion = '⚡ Oferta relámpago en Mercado Libre 25-30%';
      } else if (muchoFBA) {
        promocion = '⚡ Liquidación en Amazon 25-30% para liberar espacio';
      } else {
        promocion = 'Monitorear almacenaje; promoción si baja la rotación';
      }
      return {
        sku: s.sku, producto: s.producto,
        stock_full_ml: s.stock_full_ml, stock_fba: s.stock_fba,
        stock_total_full: s.stock_total_full,
        ventas_30d: r2(ventasMes),
        dias_inventario: s.dias_inventario_full || s.dias_inventario_fba,
        costo_almacenaje_total: r2(s.costo_almacenaje_fba * s.stock_fba),
        promocion_sugerida: promocion,
      };
    });

  // ---------- Panel 6: bundles, ofertas del día, alertas y top 5 acciones ----------
  // Bundles: producto estrella (top ventas) + estancado (0 ventas) de la misma categoría
  const estrellas = [...conVentas].sort((a, b) => b.unidades_total - a.unidades_total).slice(0, 10);
  const estancadosPorCat = new Map();
  for (const s of sinVentas.filter((x) => x.stock_total_general > 0)) {
    const cat = s.categoria || 'Sin categoría';
    if (!estancadosPorCat.has(cat)) estancadosPorCat.set(cat, []);
    estancadosPorCat.get(cat).push(s);
  }
  const bundles = [];
  for (const e of estrellas) {
    const lista = estancadosPorCat.get(e.categoria || 'Sin categoría') || [];
    for (const est of lista.slice(0, 1)) { // 1 estancado por estrella
      bundles.push({
        estrella_sku: e.sku, estrella_producto: e.producto,
        estancado_sku: est.sku, estancado_producto: est.producto,
        categoria: e.categoria || 'Sin categoría',
        sugerencia: `Bundle: ${e.producto || e.sku} + ${est.producto || est.sku} con descuento 20%`,
      });
    }
    if (bundles.length >= 10) break;
  }

  // Ofertas del día: top margen con stock disponible
  const ofertas_dia = skus
    .filter((s) => s.stock_total_general > 0 && s.costo > 0 && s.precio > s.costo)
    .map((s) => ({
      sku: s.sku, producto: s.producto,
      precio: s.precio, costo: s.costo,
      margen_pct: r2(((s.precio - s.costo) / s.precio) * 100),
      stock_total: s.stock_total_general,
      sugerencia: 'Oferta del día: destacar con descuento 10-15% y franja destacada',
    }))
    .sort((a, b) => b.margen_pct - a.margen_pct)
    .slice(0, 10);

  // Alertas de riesgo financiero: valor inmovilizado > $5,000 con 0 ventas
  const alertas = sinVentas
    .map((s) => ({ ...s, valor_inmovilizado: r2(s.stock_total_general * s.costo) }))
    .filter((s) => s.valor_inmovilizado > 5000)
    .sort((a, b) => b.valor_inmovilizado - a.valor_inmovilizado)
    .map((s) => ({
      sku: s.sku, producto: s.producto, categoria: s.categoria,
      stock_total: s.stock_total_general, valor_inmovilizado: s.valor_inmovilizado,
      mensaje: `⚠️ Riesgo financiero: $${s.valor_inmovilizado.toLocaleString('es-MX')} inmovilizados sin ventas`,
    }));

  // Top 5 acciones urgentes priorizadas por impacto económico
  const acciones = [];
  for (const a of alertas.slice(0, 5)) {
    acciones.push({
      impacto: a.valor_inmovilizado,
      accion: `Liquidar ${a.producto || a.sku} (SKU ${a.sku}): descuento 30-40% + bundle`,
      motivo: 'Valor inmovilizado alto sin ventas',
    });
  }
  for (const p of panel5.filter((x) => x.promocion_sugerida.includes('ALERTA ALMACENAJE'))) {
    acciones.push({
      impacto: r2(p.stock_total_full * (skus.find((s) => s.sku === p.sku)?.costo || 0)),
      accion: `Liberar espacio Full de ${p.producto || p.sku} (SKU ${p.sku})`,
      motivo: 'Stock Full mayor a 3 meses de ventas (costo de almacenaje)',
    });
  }
  for (const p of panel4.filter((x) => x.alerta)) {
    acciones.push({
      impacto: p.valor_inmovilizado,
      accion: `Campaña local para ${p.producto || p.sku} (SKU ${p.sku}): descuento 15-20% en punto de venta`,
      motivo: 'Sobreinventario en sucursal',
    });
  }
  const top5_acciones = acciones
    .sort((a, b) => b.impacto - a.impacto)
    .slice(0, 5)
    .map((a, i) => ({ prioridad: i + 1, accion: a.accion, motivo: a.motivo, impacto_estimado: a.impacto }));

  return { panel1, panel2, panel3, panel4, panel5, panel6: { bundles, ofertas_dia, alertas, top5_acciones } };
};

module.exports = { getPromociones, buildUniverso };
