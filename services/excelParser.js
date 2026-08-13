// services/excelParser.js — Lectura y normalización de archivos Excel/CSV (SPEC §4).
// Incluye: parseExcel, suggestMapping, normalizeNumber, parseSpanishDate,
// mapas de columnas REALES por fileType (ver data_schema.md) con fallback a keywords,
// y las reglas especiales de ML / Amazon / TikTok / publicidad-porcentaje.
const XLSX = require('xlsx');

// ---------- Utilidades de normalización ----------

// Quita acentos y normaliza para comparaciones case-insensitive
const stripAccents = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
const norm = (s) => stripAccents(String(s == null ? '' : s)).toLowerCase().trim();

// Meses en español → índice (0-11). Tolera el typo real "Febreo" del archivo de publicidad.
const MESES = {
  enero: 0, febrero: 1, febreo: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
  julio: 6, agosto: 7, septiembre: 8, setiembre: 8, octubre: 9,
  noviembre: 10, diciembre: 11,
};
const MESES_NOMBRES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// Normalización global de SKU: String + trim (conservar tal cual, sin quitar ceros).
const normalizeSku = (v) => {
  if (v == null) return '';
  if (typeof v === 'number') {
    // SKUs numéricos largos (códigos de barras): evitar notación científica/decimales
    return Number.isInteger(v) ? String(v) : String(v);
  }
  return String(v).trim();
};

// Parsea números con formato MXN: "$1,234.56", negativos, paréntesis, NaN → 0
const normalizeNumber = (v) => {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  let s = String(v).trim();
  if (!s) return 0;
  let negativo = false;
  if (/^\(.*\)$/.test(s)) { negativo = true; s = s.slice(1, -1); }
  s = s.replace(/[$\s]|MXN/gi, '');
  const tieneComa = s.includes(',');
  const tienePunto = s.includes('.');
  if (tieneComa && tienePunto) {
    // "$1,234.56" → coma = miles
    s = s.replace(/,/g, '');
  } else if (tieneComa) {
    // "1234,56" (decimal europeo) solo si hay 1-2 dígitos tras la última coma
    s = /,\d{1,2}$/.test(s) && (s.match(/,/g).length === 1) ? s.replace(',', '.') : s.replace(/,/g, '');
  }
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return 0;
  return negativo ? -n : n;
};

// Convierte fecha a ISO local 'YYYY-MM-DDTHH:mm:ss' (o 'YYYY-MM-DD').
const toISO = (d, conHora) => {
  const pad = (x) => String(x).padStart(2, '0');
  const fecha = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return conHora ? `${fecha}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : fecha;
};

// Convierte "30 de septiembre de 2025 23:47 hs." (español) a ISO.
// También acepta objetos Date, seriales de Excel y cadenas parseables por Date.
const parseSpanishDate = (v) => {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return toISO(v, true);
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Serial de Excel (días desde 1899-12-30)
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return isNaN(d) ? null : toISO(d, false);
  }
  const s = String(v).trim();
  // Formato español: "30 de septiembre de 2025 23:47 hs."
  const m = norm(s).match(/(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m && MESES[m[2]] !== undefined) {
    const pad = (x) => String(x).padStart(2, '0');
    const fecha = `${m[3]}-${pad(MESES[m[2]] + 1)}-${pad(m[1])}`;
    if (m[4] !== undefined) return `${fecha}T${pad(m[4])}:${pad(m[5])}:${pad(m[6] || '0')}`;
    return fecha;
  }
  const d = new Date(s);
  return isNaN(d) ? null : toISO(d, true);
};

// Interpreta el texto de "Tiempo hasta agotar stock" (Full ML) como días aproximados.
// Ejemplos reales: "Sin stock", "Hasta 4 semanas", "Entre 5 y 8 semanas", "Más de 12 semanas".
const parseDiasInventario = (v) => {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = norm(v);
  if (!s || s.includes('sin stock')) return 0;
  let m = s.match(/(\d+)\s*y\s*(\d+)\s*semana/) || s.match(/(\d+)\s*a\s*(\d+)\s*semana/);
  if (m) return Math.max(+m[1], +m[2]) * 7;
  m = s.match(/(\d+)\s*semana/);
  if (m) return +m[1] * 7;
  m = s.match(/(\d+)\s*mes/);
  if (m) return +m[1] * 30;
  m = s.match(/(\d+)\s*dia/);
  if (m) return +m[1];
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};

// ---------- Mapeos DEFAULT por fileType (columnas REALES, ver data_schema.md) ----------
// Cada campo canónico lista nombres exactos de columnas reales en orden de preferencia.
const DEFAULT_MAPS = {
  ventas_mercadolibre: {
    fecha: ['Fecha de venta'],
    estado: ['Estado'],
    unidades: ['Unidades'],
    ingreso: ['Ingresos por productos (MXN)'],
    comision: ['Cargo por venta e impuestos (MXN)'],
    envio: ['Costos de envío (MXN)'],
    venta_por_publicidad: ['Venta por publicidad'],
    sku: ['SKU'],
    producto: ['Título de la publicación'],
  },
  ventas_amazon: {
    fecha: ['Fecha de inicio'],
    sku: ['MSKU'],
    unidades: ['Unidades vendidas'],
    ingreso: ['Ventas'],
    comision: ['Tarifa por referencia en total', 'Cantidad: Tarifa por referencia'],
    reembolso_unidades: ['Unidades devueltas'],
    precio_medio: ['Precio de venta medio'],
    // Cargos de almacenamiento: se SUMAN a la comisión de la fila (son cargos del marketplace)
    costo_almacenaje: ['Tarifa mensual por almacenamiento de inventario en total', 'Cantidad: Tarifa mensual por almacenamiento de inventario'],
    recargo_almacenaje: ['Recargo por uso de almacenamiento en total', 'Cantidad: Recargo por uso de almacenamiento'],
    retiro_inventario: ['Tarifas por retiro de inventario de Logística de Amazon en total', 'Cantidad: Tarifas por retiro de inventario de Logística de Amazon'],
  },
  ventas_tiktok: {
    order_id: ['ID'],
    fecha: ['Created At'],
    sku: ['Line: SKU'],
    unidades: ['Line: Quantity'],
    ingreso: ['Price: Total Line Items'],
    envio: ['Price: Total Shipping'],
    reembolso: ['Price: Total Refund'],
    estado: ['Payment: Status'],
  },
  publicidad_mercadolibre: {
    // (a) Formato real del usuario: porcentaje mensual
    fecha: ['Fecha'],
    porcentaje: ['porcentaje del costo de publicida respecto a la venta total'],
    // (b) Formato del brief con montos directos
    inversion: ['Inversion_Publicidad', 'Inversión', 'Inversion'],
    ventas_generadas: ['Ventas_Generadas', 'Ventas generadas'],
    clicks: ['Clicks', 'Clics'],
    impresiones: ['Impresiones'],
    sku: ['SKU'],
  },
  costeo: {
    categoria: ['Tipo de Producto'],
    producto: ['Producto'],
    sku: ['SKU'],
    stock_sucursal: ['Stock'],
    costo_unitario: ['Costo Neto Prom. Unitario'],
  },
  inventario_full_ml: {
    sku: ['SKU'],
    producto: ['Producto'],
    ventas_30d: ['Ventas últimos 30 días (u.)'],
    stock: ['Unidades en Full'],
    dias_inventario: ['Tiempo hasta agotar stock'],
  },
  inventario_fba_amazon: {
    sku: ['sku'],
    producto: ['product-name'],
    stock: ['available'],
    costo_almacenaje: ['estimated-storage-cost-next-month'],
    dias_inventario: ['days-of-supply'],
    ventas_30d: ['units-shipped-t30'],
    precio: ['your-price'],
  },
  historico_promociones: {
    fecha: ['Fecha'],
    sku: ['SKU'],
    producto: ['Producto'],
    promocion: ['Promoción', 'Promocion'],
    descuento: ['Descuento'],
    resultado: ['Resultado'],
  },
};

// Keywords de respaldo (es/en, case-insensitive, sin acentos) — SPEC §4
const KEYWORDS = {
  fecha: ['fecha', 'date', 'created'],
  sku: ['sku', 'msku', 'fnsku', 'line: sku'],
  producto: ['producto', 'product', 'item', 'title', 'nombre', 'publicacion', 'product-name'],
  unidades: ['unidades', 'quantity', 'qty', 'cantidad', 'units'],
  ingreso: ['ingresos por productos', 'ventas', 'price: total line items', 'total', 'amount', 'importe', 'precio'],
  comision: ['cargo por venta', 'comision', 'fee', 'tarifa por referencia'],
  envio: ['costos de envio', 'shipping', 'flete'],
  anulacion: ['anulaciones', 'cancel'],
  reembolso: ['reembolso', 'refund'],
  ret_isr: ['isr'],
  ret_iva: ['iva'],
};

// Campos canónicos ofrecidos por tipo de archivo (para el modal de mapeo del frontend)
const CANONICAL_FIELDS = {
  ventas_mercadolibre: ['fecha', 'sku', 'producto', 'unidades', 'ingreso', 'comision', 'envio', 'anulacion', 'reembolso', 'ret_isr', 'ret_iva', 'venta_por_publicidad', 'estado'],
  ventas_amazon: ['fecha', 'sku', 'producto', 'unidades', 'ingreso', 'comision', 'envio', 'reembolso', 'reembolso_unidades', 'precio_medio', 'costo_almacenaje', 'recargo_almacenaje', 'retiro_inventario', 'estado'],
  ventas_tiktok: ['order_id', 'fecha', 'sku', 'unidades', 'ingreso', 'envio', 'reembolso', 'estado'],
  publicidad_mercadolibre: ['fecha', 'porcentaje', 'inversion', 'ventas_generadas', 'clicks', 'impresiones', 'sku'],
  costeo: ['sku', 'producto', 'categoria', 'costo_unitario', 'stock_sucursal'],
  inventario_full_ml: ['sku', 'producto', 'stock', 'ventas_30d', 'dias_inventario'],
  inventario_fba_amazon: ['sku', 'producto', 'stock', 'costo_almacenaje', 'dias_inventario', 'ventas_30d', 'precio'],
  historico_promociones: ['fecha', 'sku', 'producto', 'promocion', 'descuento', 'resultado'],
};

// Sugiere mapeo {campoCanónico: nombreColumna} — SPEC §4
const suggestMapping = (headers, fileType) => {
  const out = {};
  const defaults = DEFAULT_MAPS[fileType] || {};
  const usados = new Set();

  const buscarExacta = (candidatos) => {
    for (const cand of candidatos) {
      // 1) Coincidencia exacta (trim)
      let hit = headers.find((h) => h.trim() === cand && !usados.has(h));
      // 2) Coincidencia normalizada (sin acentos, minúsculas)
      if (!hit) hit = headers.find((h) => norm(h) === norm(cand) && !usados.has(h));
      // 3) La columna real "empieza con" el nombre default (encabezados con salto de línea)
      if (!hit) hit = headers.find((h) => norm(h).startsWith(norm(cand)) && !usados.has(h));
      if (hit) return hit;
    }
    return null;
  };

  for (const [campo, candidatos] of Object.entries(defaults)) {
    const hit = buscarExacta(candidatos);
    if (hit) { out[campo] = hit; usados.add(hit); }
  }
  // Fallback por keywords para campos canónicos comunes sin mapeo aún
  for (const [campo, kws] of Object.entries(KEYWORDS)) {
    if (out[campo] || !(CANONICAL_FIELDS[fileType] || []).includes(campo)) continue;
    const hit = headers.find((h) => !usados.has(h) && kws.some((k) => norm(h).includes(norm(k))));
    if (hit) { out[campo] = hit; usados.add(hit); }
  }
  return out;
};

// ---------- Lectura del archivo ----------

// parseExcel(buffer, fileType) → { headers, rows, suggestedMapping, preview }
// Soporta encabezados multi-fila: inventario_full_ml usa skiprows=3 equivalente
// (fila 1 = encabezados reales, datos desde la fila 4 del Excel).
const parseExcel = (buffer, fileType) => {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
  if (!aoa.length) return { headers: [], rows: [], suggestedMapping: {}, preview: [] };

  const esFullML = fileType === 'inventario_full_ml';
  const headerRow = aoa[0];
  // Nombres de columna únicos: duplicados reciben sufijo " (2)", " (3)"...
  const vistos = {};
  const headers = headerRow.map((h, i) => {
    let name = h instanceof Date ? toISO(h, false) : String(h == null ? '' : h).trim();
    if (!name) name = `columna_${i + 1}`;
    vistos[name] = (vistos[name] || 0) + 1;
    return vistos[name] > 1 ? `${name} (${vistos[name]})` : name;
  });

  const dataRows = aoa.slice(esFullML ? 3 : 1);
  const rows = [];
  for (const arr of dataRows) {
    if (!arr || arr.every((c) => c == null || c === '')) continue; // saltar filas vacías
    const obj = {};
    headers.forEach((h, i) => { obj[h] = arr[i] !== undefined ? arr[i] : null; });
    rows.push(obj);
  }

  // Vista previa: máx 8 filas, fechas formateadas como texto
  const preview = rows.slice(0, 8).map((r) => {
    const o = {};
    for (const [k, v] of Object.entries(r)) o[k] = v instanceof Date ? toISO(v, true) : v;
    return o;
  });

  return { headers, rows, suggestedMapping: suggestMapping(headers, fileType), preview };
};

// ---------- Procesamiento con mapping confirmado (reglas especiales §4) ----------

const val = (row, mapping, campo) => (mapping[campo] ? row[mapping[campo]] : null);

// Determina si una fila de venta es anulación/reembolso "pura" (se excluye de ventas_totales)
const esAnulReembolsoPuro = (r) => r.anulacion > 0 || (r.reembolso > 0 && r.reembolso >= r.ingreso && r.ingreso > 0);

// Regla usuario: una fila anulada/devuelta/reembolsada NO aporta costo de adquisición
// (el producto vale 0 en ese costo). Cubre filas puras y filas con estado de
// cancelación/devolución aunque no traigan monto de anulación/reembolso.
const REGEX_ESTADO_ANUL = /cancelad|devol|reembolso|refund/i;
const sinCostoAdquisicion = (r) =>
  esAnulReembolsoPuro(r) || REGEX_ESTADO_ANUL.test(String(r.estado || ''));

// Procesa las filas según el tipo de archivo. Devuelve registros listos para insertar.
const processRows = (fileType, rows, mapping) => {
  switch (fileType) {
    case 'ventas_mercadolibre':
      return rows.map((row) => {
        const estado = String(val(row, mapping, 'estado') || '').trim();
        const estN = norm(estado);
        const ingreso = normalizeNumber(val(row, mapping, 'ingreso'));
        let producto = String(val(row, mapping, 'producto') || '').trim();
        // Algunas filas del export ML vienen desplazadas una columna desde
        // "Canal de venta": "Título de la publicación" trae la variante
        // ("Color : Rojo") y el título real queda en "Tienda oficial".
        if (/^(color|tamaño|tamano|talla)\s*:/i.test(producto)) {
          const alt = row['Tienda oficial'];
          if (typeof alt === 'string' && alt.trim()) producto = alt.trim();
        }
        // Regla ML: comisión y envío vienen NEGATIVOS → valor absoluto
        const r = {
          marketplace: 'mercadolibre',
          fecha: parseSpanishDate(val(row, mapping, 'fecha')),
          sku: normalizeSku(val(row, mapping, 'sku')),
          producto,
          unidades: normalizeNumber(val(row, mapping, 'unidades')),
          ingreso,
          comision: Math.abs(normalizeNumber(val(row, mapping, 'comision'))),
          envio: Math.abs(normalizeNumber(val(row, mapping, 'envio'))),
          anulacion: 0,
          reembolso: 0,
          ret_isr: 0,
          ret_iva: 0,
          venta_por_publicidad: /^s[ií]/i.test(String(val(row, mapping, 'venta_por_publicidad') || '').trim()) ? 1 : 0,
          estado,
        };
        // Regla ML: el monto de anulación/reembolso es el ingreso de esa fila según el estado
        if (estN.includes('cancelad')) r.anulacion = ingreso;
        else if (estN.includes('devol') || estN.includes('reembolso')) r.reembolso = ingreso;
        return r;
      }).filter((r) => r.fecha || r.ingreso !== 0 || r.unidades !== 0);

    case 'ventas_amazon':
      return rows.map((row) => {
        // Regla Amazon: reporte agregado por MSKU/mes.
        // Los costos de almacenamiento/retiro son cargos del marketplace:
        // se SUMAN a la comisión de la fila (documentado en SPEC §4).
        const cargosAlmacen =
          Math.abs(normalizeNumber(val(row, mapping, 'costo_almacenaje'))) +
          Math.abs(normalizeNumber(val(row, mapping, 'recargo_almacenaje'))) +
          Math.abs(normalizeNumber(val(row, mapping, 'retiro_inventario')));
        const unidadesDevueltas = normalizeNumber(val(row, mapping, 'reembolso_unidades'));
        const precioMedio = normalizeNumber(val(row, mapping, 'precio_medio'));
        const unidadesVendidas = normalizeNumber(val(row, mapping, 'unidades'));
        return {
          marketplace: 'amazon',
          fecha: parseSpanishDate(val(row, mapping, 'fecha')),
          sku: normalizeSku(val(row, mapping, 'sku')),
          producto: String(val(row, mapping, 'producto') || '').trim(),
          // Regla usuario: las unidades devueltas no generan costo de adquisición.
          // Amazon es agregado SKU/mes con devoluciones parciales → usar unidades NETAS.
          unidades: unidadesVendidas - unidadesDevueltas,
          ingreso: normalizeNumber(val(row, mapping, 'ingreso')),
          comision: Math.abs(normalizeNumber(val(row, mapping, 'comision'))) + cargosAlmacen,
          envio: 0,
          anulacion: 0,
          // Regla Amazon: reembolso = Unidades devueltas × Precio de venta medio
          reembolso: unidadesDevueltas * precioMedio,
          ret_isr: 0,
          ret_iva: 0,
          venta_por_publicidad: 0,
          estado: '',
        };
      }).filter((r) => r.sku || r.ingreso !== 0 || r.unidades !== 0);

    case 'ventas_tiktok': {
      // Regla TikTok: montos (ingreso/envío/reembolso) son a NIVEL ORDEN y se repiten
      // en cada línea del pedido → solo la primera línea de cada orden conserva los montos.
      const vistos = new Set();
      return rows.map((row) => {
        const orderId = String(val(row, mapping, 'order_id') || '').trim();
        const primeraLinea = !orderId || !vistos.has(orderId);
        if (orderId) vistos.add(orderId);
        const ingreso = primeraLinea ? normalizeNumber(val(row, mapping, 'ingreso')) : 0;
        const reembolso = primeraLinea ? normalizeNumber(val(row, mapping, 'reembolso')) : 0;
        // Órdenes 100% reembolsadas no cuentan como venta → tampoco generan cargo
        const esReembolsoTotal = reembolso > 0 && ingreso > 0 && reembolso >= ingreso;
        return {
          marketplace: 'tiktok',
          fecha: parseSpanishDate(val(row, mapping, 'fecha')),
          sku: normalizeSku(val(row, mapping, 'sku')),
          producto: '',
          unidades: normalizeNumber(val(row, mapping, 'unidades')),
          ingreso,
          // Regla usuario: cargo por venta TikTok = 15% del precio de venta (solo ventas válidas)
          comision: esReembolsoTotal ? 0 : ingreso * 0.15,
          envio: primeraLinea ? normalizeNumber(val(row, mapping, 'envio')) : 0,
          anulacion: 0,
          reembolso,
          ret_isr: 0,
          ret_iva: 0,
          venta_por_publicidad: 0,
          estado: String(val(row, mapping, 'estado') || '').trim(),
        };
      }).filter((r) => r.sku || r.ingreso !== 0 || r.unidades !== 0);
    }

    case 'publicidad_mercadolibre': {
      // Dos formatos soportados:
      // (a) Porcentaje mensual (archivo real del usuario): Fecha = nombre de mes en español
      //     (tolera typo "Febreo") + columna de porcentaje como fracción (0.1049 = 10.49%).
      //     Se guarda en ads con marketplace='mercadolibre_pct' (sentinela "porcentaje"),
      //     fecha = nombre del mes normalizado, inversion = fracción.
      //     El dataProcessor calcula: costo_publicidad_mes = ventas_totales_ML_mes × pct.
      // (b) Formato del brief con montos: filas directas en ads (marketplace='mercadolibre').
      const esPorcentaje = !!mapping.porcentaje;
      if (esPorcentaje) {
        return rows.map((row) => {
          const mesN = norm(val(row, mapping, 'fecha'));
          const idx = MESES[mesN];
          return {
            marketplace: 'mercadolibre_pct',
            fecha: idx !== undefined ? MESES_NOMBRES[idx] : mesN,
            sku: '',
            inversion: normalizeNumber(val(row, mapping, 'porcentaje')), // fracción
            ventas_generadas: 0,
            clicks: 0,
            impresiones: 0,
          };
        }).filter((r) => MESES[r.fecha] !== undefined);
      }
      return rows.map((row) => ({
        marketplace: 'mercadolibre',
        fecha: parseSpanishDate(val(row, mapping, 'fecha')),
        sku: normalizeSku(val(row, mapping, 'sku')),
        inversion: normalizeNumber(val(row, mapping, 'inversion')),
        ventas_generadas: normalizeNumber(val(row, mapping, 'ventas_generadas')),
        clicks: normalizeNumber(val(row, mapping, 'clicks')),
        impresiones: normalizeNumber(val(row, mapping, 'impresiones')),
      })).filter((r) => r.fecha || r.inversion !== 0);
    }

    case 'costeo':
      // SKU puede ser numérico largo → SIEMPRE como string (normalizeSku).
      // El archivo no trae precio de venta → se estima después en dataProcessor.
      return rows.map((row) => ({
        sku: normalizeSku(val(row, mapping, 'sku')),
        producto: String(val(row, mapping, 'producto') || '').trim(),
        categoria: String(val(row, mapping, 'categoria') || '').trim(),
        costo_unitario: normalizeNumber(val(row, mapping, 'costo_unitario')),
        precio_venta: 0,
        stock_sucursal: normalizeNumber(val(row, mapping, 'stock_sucursal')),
      })).filter((r) => r.sku);

    case 'inventario_full_ml':
      return rows.map((row) => ({
        sku: normalizeSku(val(row, mapping, 'sku')),
        marketplace: 'mercadolibre',
        stock: normalizeNumber(val(row, mapping, 'stock')),
        costo_almacenaje: 0, // el reporte Full no trae costo de almacenaje
        dias_inventario: parseDiasInventario(val(row, mapping, 'dias_inventario')),
        ventas_30d: normalizeNumber(val(row, mapping, 'ventas_30d')),
      })).filter((r) => r.sku);

    case 'inventario_fba_amazon':
      return rows.map((row) => ({
        sku: normalizeSku(val(row, mapping, 'sku')),
        marketplace: 'amazon',
        stock: normalizeNumber(val(row, mapping, 'stock')),
        costo_almacenaje: normalizeNumber(val(row, mapping, 'costo_almacenaje')),
        dias_inventario: normalizeNumber(val(row, mapping, 'dias_inventario')),
        ventas_30d: normalizeNumber(val(row, mapping, 'ventas_30d')),
      })).filter((r) => r.sku);

    case 'historico_promociones':
      // Archivo OPCIONAL: se conservan las filas genéricas en meta (JSON)
      return rows.map((row) => {
        const o = {};
        for (const [k, v] of Object.entries(row)) o[k] = v instanceof Date ? toISO(v, true) : v;
        return o;
      });

    default:
      throw new Error(`Tipo de archivo no soportado: ${fileType}`);
  }
};

module.exports = {
  parseExcel,
  suggestMapping,
  processRows,
  normalizeNumber,
  parseSpanishDate,
  parseDiasInventario,
  normalizeSku,
  norm,
  esAnulReembolsoPuro,
  sinCostoAdquisicion,
  MESES_NOMBRES,
  CANONICAL_FIELDS,
  FILE_TYPES: Object.keys(DEFAULT_MAPS),
};
