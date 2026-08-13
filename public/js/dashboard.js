/* ============================================================
   dashboard.js — Módulo 1
   Tabs de marketplaces, filtros de fecha, fetch de
   GET /api/dashboard/:mp y GET /api/dashboard-all, render de
   las 16 tarjetas (siempre visibles), banner "sin datos",
   colores condicionales según umbrales del SPEC, tabla de
   transacciones con DataTables y tab TODOS (comparativa +
   gráficos).
   ============================================================ */

"use strict";

/* Idioma español para todas las DataTables (CDN oficial) */
const DT_IDIOMA_ES = { url: "https://cdn.datatables.net/plug-ins/1.13.8/i18n/es-MX.json" };

/** Definición de las 16 métricas en el orden del SPEC §6. */
const METRICAS_DEF = [
  { key: "ventas_totales",        label: "Ventas Totales",        tipo: "moneda" },
  { key: "ventas_por_publicidad", label: "Ventas por Publicidad", tipo: "moneda" },
  { key: "ventas_organicas",      label: "Ventas Orgánicas",      tipo: "moneda" },
  { key: "ganancia_neta_pct",     label: "Ganancia Neta %",       tipo: "pct" },
  { key: "ganancia_neta",         label: "Ganancia Neta",         tipo: "moneda" },
  { key: "cargo_venta",           label: "Cargo por Venta",       tipo: "moneda" },
  { key: "costo_adquisicion",     label: "Costo de Adquisición",  tipo: "moneda" },
  { key: "anulaciones",           label: "Anulaciones",           tipo: "moneda" },
  { key: "reembolsos",            label: "Reembolsos",            tipo: "moneda" },
  { key: "costo_publicidad",      label: "Costo de Publicidad",   tipo: "moneda" },
  { key: "costo_envio",           label: "Costo de Envío",        tipo: "moneda" },
  { key: "acos",                  label: "ACOS",                  tipo: "pct" },
  { key: "tacos",                 label: "TACOS",                 tipo: "pct" },
  { key: "costos_totales",        label: "Costos Totales",        tipo: "moneda" },
  { key: "ret_isr",               label: "Retención ISR",         tipo: "moneda" },
  { key: "ret_iva",               label: "Retención IVA",         tipo: "moneda" }
];

const Dashboard = {
  mpActual: "mercadolibre",
  tablaTransacciones: null,
  ultimoTodos: null       // cache de /api/dashboard-all para repintar al cambiar tema
};

/* ---------- Utilidades de formato por métrica ---------- */

function valorMetrica(metricas, key, tipo) {
  const v = metricas ? metricas[key] : null;
  if ((key === "acos" || key === "tacos") && (v === null || v === undefined)) {
    return "N/A - Solo ML";
  }
  if (tipo === "pct") return formatoPct(v);
  return formatoMoneda(v);
}

/* ---------- Colores condicionales (umbrales SPEC §8) ---------- */

function limpiarEstados(card) {
  card.classList.remove("estado-verde", "estado-amarillo", "estado-rojo", "estado-gris");
}

function aplicarColorCondicional(key, valor, sinDatos) {
  const card = document.getElementById("card-" + key);
  if (!card) return;
  limpiarEstados(card);

  if (sinDatos) {
    card.classList.add("estado-gris");
    return;
  }
  if (key === "ganancia_neta_pct") {
    const v = Number(valor) || 0;
    if (v === 0) card.classList.add("estado-gris");
    else if (v > 25) card.classList.add("estado-verde");
    else if (v >= 10) card.classList.add("estado-amarillo");
    else card.classList.add("estado-rojo");
  } else if (key === "acos") {
    if (valor === null || valor === undefined) { card.classList.add("estado-gris"); return; }
    const v = Number(valor);
    if (v < 15) card.classList.add("estado-verde");
    else if (v <= 30) card.classList.add("estado-amarillo");
    else card.classList.add("estado-rojo");
  } else if (key === "tacos") {
    if (valor === null || valor === undefined) { card.classList.add("estado-gris"); return; }
    const v = Number(valor);
    if (v < 10) card.classList.add("estado-verde");
    else if (v <= 20) card.classList.add("estado-amarillo");
    else card.classList.add("estado-rojo");
  }
}

/* ---------- Render de las 16 tarjetas ---------- */

function renderTarjetas(metricas, sinDatos) {
  const grid = document.getElementById("metricas-grid");
  grid.classList.toggle("sin-datos", !!sinDatos);

  METRICAS_DEF.forEach(function (def) {
    const el = document.querySelector('[data-metrica="' + def.key + '"]');
    if (!el) return;
    let valor = metricas ? metricas[def.key] : null;
    if (sinDatos) {
      // Sin datos: $0.00 en gris tenue; ACOS/TACOS siempre "N/A - Solo ML"
      el.textContent = def.tipo === "pct"
        ? (def.key === "acos" || def.key === "tacos" ? "N/A - Solo ML" : formatoPct(0))
        : formatoMoneda(0);
    } else {
      el.textContent = valorMetrica(metricas, def.key, def.tipo);
    }
    aplicarColorCondicional(def.key, sinDatos ? null : valor, !!sinDatos);
  });
}

/* ---------- Banner sin datos ---------- */

function renderBanner(mp, sinDatos) {
  const banner = document.getElementById("banner-sin-datos");
  const texto = document.getElementById("banner-texto");
  if (sinDatos) {
    texto.textContent = "No se ha subido el archivo de ventas de " + MP_NOMBRES[mp] +
      ". Las métricas se mostrarán automáticamente cuando subas tu reporte.";
    banner.classList.remove("d-none");
  } else {
    banner.classList.add("d-none");
  }
}

/* ---------- Resumen rápido ---------- */

function renderResumen(metricas) {
  document.getElementById("info-unidades").textContent = formatoEntero(metricas && metricas.unidades_vendidas);
  document.getElementById("info-transacciones").textContent = formatoEntero(metricas && metricas.num_transacciones);
  document.getElementById("info-skus-sin-costeo").textContent = formatoEntero(metricas && metricas.skus_sin_costeo);
}

/* ---------- Tabla de transacciones ---------- */

function renderTransacciones(transacciones) {
  const filas = (transacciones || []).map(function (t) {
    return [
      t.fecha ? escapeHtml(String(t.fecha).slice(0, 10)) : "",
      escapeHtml(t.sku),
      escapeHtml(t.producto),
      formatoEntero(t.unidades),
      formatoMoneda(t.ingreso),
      formatoMoneda(t.comision),
      formatoMoneda(t.envio),
      formatoMoneda(t.anulacion),
      formatoMoneda(t.reembolso),
      escapeHtml(t.estado)
    ];
  });

  if (Dashboard.tablaTransacciones) {
    Dashboard.tablaTransacciones.clear().rows.add(filas).draw();
  } else {
    Dashboard.tablaTransacciones = $("#tabla-transacciones").DataTable({
      data: filas,
      language: DT_IDIOMA_ES,
      pageLength: 15,
      lengthMenu: [15, 25, 50, 100],
      order: [[0, "desc"]],
      autoWidth: false
    });
  }
}

/* ---------- Carga por marketplace ---------- */

function parametrosFechas() {
  const desde = document.getElementById("fecha-desde").value;
  const hasta = document.getElementById("fecha-hasta").value;
  const params = new URLSearchParams();
  if (desde) params.set("desde", desde);
  if (hasta) params.set("hasta", hasta);
  const qs = params.toString();
  return qs ? "?" + qs : "";
}

async function cargarDashboard(mp) {
  try {
    const data = await apiFetch("/api/dashboard/" + encodeURIComponent(mp) + parametrosFechas());
    const sinDatos = data.estado === "sin_datos";
    renderBanner(mp, sinDatos);
    renderTarjetas(data.metricas, sinDatos);
    renderResumen(data.metricas);
    renderTransacciones(data.transacciones);
  } catch (err) {
    mostrarToast("No se pudo cargar el dashboard de " + MP_NOMBRES[mp] + ": " + err.message, "error");
    // Degradación elegante: mostrar estado "sin datos"
    renderBanner(mp, true);
    renderTarjetas(null, true);
    renderResumen(null);
    renderTransacciones([]);
  }
}

/* ---------- Tab TODOS ---------- */

function renderComparativa(data) {
  const porMp = data.por_marketplace || {};
  const activos = Array.isArray(data.activos) ? data.activos : null;
  const totales = data.totales || {};

  function mpSinDatos(mp) {
    if (activos) return activos.indexOf(mp) === -1;
    const m = porMp[mp];
    return !m || m.estado === "sin_datos";
  }

  // Encabezado: métrica + 5 marketplaces + TOTAL
  let head = '<tr><th class="comparativa-label">Métrica</th>';
  MARKETPLACES.forEach(function (mp) {
    const sinDatos = mpSinDatos(mp);
    head += '<th class="' + (sinDatos ? "col-sin-datos" : "") + '">' +
      escapeHtml(MP_NOMBRES[mp]) + (sinDatos ? ' <span title="Sin datos">🔒</span>' : "") + "</th>";
  });
  head += '<th class="total-col">TOTAL</th></tr>';
  document.getElementById("comparativa-head").innerHTML = head;

  // Filas: 16 métricas
  let body = "";
  METRICAS_DEF.forEach(function (def) {
    body += '<tr><td class="comparativa-label">' + escapeHtml(def.label) + "</td>";
    MARKETPLACES.forEach(function (mp) {
      const sinDatos = mpSinDatos(mp);
      // por_marketplace[mp] llega como {estado, metricas} → desenvolver
      const metricas = (porMp[mp] && porMp[mp].metricas) || {};
      const txt = sinDatos
        ? (def.tipo === "pct" && (def.key === "acos" || def.key === "tacos") ? "N/A - Solo ML" : (def.tipo === "pct" ? formatoPct(0) : formatoMoneda(0)))
        : valorMetrica(metricas, def.key, def.tipo);
      body += '<td class="' + (sinDatos ? "col-sin-datos" : "") + '">' + txt + "</td>";
    });
    body += '<td class="total-col">' + valorMetrica(totales, def.key, def.tipo) + "</td></tr>";
  });
  document.getElementById("comparativa-body").innerHTML = body;
}

function renderGraficosTodos(data) {
  const porMp = data.por_marketplace || {};
  const activos = Array.isArray(data.activos)
    ? data.activos
    : MARKETPLACES.filter(function (mp) { return porMp[mp] && porMp[mp].estado !== "sin_datos"; });

  const labels = [];
  const ventas = [];
  const ganancias = [];
  activos.forEach(function (mp) {
    const m = (porMp[mp] && porMp[mp].metricas) || porMp[mp];
    if (!m) return;
    labels.push(MP_NOMBRES[mp]);
    ventas.push(Number(m.ventas_totales) || 0);
    ganancias.push(Number(m.ganancia_neta) || 0);
  });

  Charts.renderVentasPorMarketplace("chart-ventas-mp", labels, ventas);
  Charts.renderDistribucionGanancias("chart-ganancias", labels, ganancias);
  Charts.renderVentasDiarias("chart-ventas-diarias", data.ventas_diarias);
}

async function cargarTodos() {
  try {
    const data = await apiFetch("/api/dashboard-all" + parametrosFechas());
    Dashboard.ultimoTodos = data;
    renderComparativa(data);
    renderGraficosTodos(data);
  } catch (err) {
    mostrarToast("No se pudo cargar el resumen general: " + err.message, "error");
    Dashboard.ultimoTodos = { por_marketplace: {}, totales: {}, ventas_diarias: [], activos: [] };
    renderComparativa(Dashboard.ultimoTodos);
    renderGraficosTodos(Dashboard.ultimoTodos);
  }
}

/* ---------- Navegación y eventos ---------- */

function seleccionarTab(mp) {
  Dashboard.mpActual = mp;
  document.querySelectorAll("#mp-tabs .nav-link").forEach(function (btn) {
    btn.classList.toggle("active", btn.getAttribute("data-mp") === mp);
  });
  const esTodos = mp === "todos";
  document.getElementById("vista-marketplace").classList.toggle("d-none", esTodos);
  document.getElementById("vista-todos").classList.toggle("d-none", !esTodos);
  if (esTodos) cargarTodos(); else cargarDashboard(mp);
}

function recargarActual() {
  if (Dashboard.mpActual === "todos") cargarTodos();
  else cargarDashboard(Dashboard.mpActual);
}

function initDashboard() {
  // Tabs
  document.querySelectorAll("#mp-tabs .nav-link").forEach(function (btn) {
    btn.addEventListener("click", function () {
      seleccionarTab(btn.getAttribute("data-mp"));
    });
  });

  // Filtros de fecha
  document.getElementById("btn-aplicar-fechas").addEventListener("click", recargarActual);
  document.getElementById("btn-limpiar-fechas").addEventListener("click", function () {
    document.getElementById("fecha-desde").value = "";
    document.getElementById("fecha-hasta").value = "";
    recargarActual();
  });

  // Banner: abrir upload preseleccionando el marketplace actual
  document.getElementById("btn-subir-ahora").addEventListener("click", function () {
    if (typeof abrirModalUpload === "function") {
      abrirModalUpload(MP_TIPO_ARCHIVO[Dashboard.mpActual]);
    }
  });

  // Exportar dashboard actual a Excel
  document.getElementById("btn-export-dashboard").addEventListener("click", function () {
    const mp = Dashboard.mpActual === "todos" ? "dashboard" : Dashboard.mpActual;
    window.open("/api/export/" + encodeURIComponent(mp), "_blank");
  });

  // Repintar gráficos con los datos cacheados al cambiar de tema
  document.addEventListener("graficos:repintar", function () {
    if (Dashboard.ultimoTodos && Dashboard.mpActual === "todos") {
      renderGraficosTodos(Dashboard.ultimoTodos);
    }
  });

  // Carga inicial del marketplace activo
  cargarDashboard(Dashboard.mpActual);
}

/** Refresca estado y dashboard tras un upload exitoso (usado por upload.js). */
async function refrescarTrasUpload() {
  await cargarStatus();
  recargarActual();
}
