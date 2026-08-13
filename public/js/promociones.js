/* ============================================================
   promociones.js — Módulo 2 (Promociones IA)
   Fetch GET /api/promociones y render de los 6 paneles:
   paneles 1-5 como DataTables, panel 6 como tarjetas
   (bundles, ofertas del día, alertas de riesgo financiero,
   top 5 acciones). Botones Exportar Excel e Imprimir/PDF.
   ============================================================ */

"use strict";

const Promociones = {
  tablas: {}   // instancias DataTable por panel, para destruir al recargar
};

/* Claves cuyos valores numéricos se muestran como moneda MXN */
const CLAVES_MONEDA = ["precio", "costo", "valor", "ingreso", "ganancia", "inversion", "almacenaje"];

/** Decide si una columna se formatea como moneda por su nombre. */
function esColumnaMoneda(clave) {
  const k = clave.toLowerCase();
  return CLAVES_MONEDA.some(function (p) { return k.indexOf(p) !== -1; });
}

/** Encabezado legible a partir del nombre de campo (snake_case → Título). */
function etiquetaColumna(clave) {
  const conEspacios = clave.replace(/_/g, " ");
  return conEspacios.charAt(0).toUpperCase() + conEspacios.slice(1);
}

/** Formatea un valor de celda según la clave de la columna. */
function formatearCelda(clave, valor) {
  if (valor === null || valor === undefined) return "";
  if (typeof valor === "number") {
    if (esColumnaMoneda(clave)) return formatoMoneda(valor);
    return Number.isInteger(valor) ? formatoEntero(valor) : valor.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  return escapeHtml(valor);
}

/* ---------- Paneles 1-5: DataTables dinámicas ---------- */

function renderPanelTabla(panelKey, filas) {
  const tablaId = "tabla-" + panelKey;
  const tabla = document.getElementById(tablaId);
  if (!tabla) return;

  // Destruir instancia previa al refrescar
  if (Promociones.tablas[panelKey]) {
    Promociones.tablas[panelKey].destroy();
    delete Promociones.tablas[panelKey];
    tabla.innerHTML = "";
  }

  const datos = Array.isArray(filas) ? filas : [];
  if (datos.length === 0) {
    tabla.innerHTML = '<tbody><tr><td class="text-muted fst-italic p-3">' +
      "Sin datos. Sube los archivos de ventas, costeo e inventarios para generar recomendaciones.</td></tr></tbody>";
    return;
  }

  // Columnas = unión de claves de todas las filas (todo viene del API)
  const columnas = [];
  datos.forEach(function (fila) {
    Object.keys(fila).forEach(function (k) {
      if (columnas.indexOf(k) === -1) columnas.push(k);
    });
  });

  let thead = "<thead><tr>" + columnas.map(function (c) {
    return "<th>" + escapeHtml(etiquetaColumna(c)) + "</th>";
  }).join("") + "</tr></thead>";
  tabla.innerHTML = thead + "<tbody></tbody>";

  const dataRows = datos.map(function (fila) {
    return columnas.map(function (c) { return formatearCelda(c, fila[c]); });
  });

  Promociones.tablas[panelKey] = $("#" + tablaId).DataTable({
    data: dataRows,
    language: DT_IDIOMA_ES,
    pageLength: 10,
    lengthMenu: [10, 20, 50],
    autoWidth: false,
    scrollX: true
  });
}

/* ---------- Panel 6: tarjetas ---------- */

/** Convierte un ítem (string u objeto) en HTML de tarjeta pequeña. */
function itemACard(item) {
  if (item === null || item === undefined) return "";
  if (typeof item === "string" || typeof item === "number") {
    return '<div class="panel6-item-card">' + escapeHtml(item) + "</div>";
  }
  if (typeof item === "object") {
    const claves = Object.keys(item);
    if (claves.length === 0) return "";
    // Primer campo como título; el resto como detalle "Etiqueta: valor"
    const titulo = item[claves[0]];
    const detalles = claves.slice(1).map(function (k) {
      const v = item[k];
      const txt = (typeof v === "number" && esColumnaMoneda(k)) ? formatoMoneda(v)
        : (typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(v));
      return escapeHtml(etiquetaColumna(k)) + ": " + escapeHtml(txt);
    });
    return '<div class="panel6-item-card">' +
      '<div class="item-titulo">' + escapeHtml(titulo) + "</div>" +
      (detalles.length ? '<div class="item-detalle">' + detalles.join(" · ") + "</div>" : "") +
      "</div>";
  }
  return "";
}

function renderPanel6Lista(elementId, items, mensajeVacio) {
  const cont = document.getElementById(elementId);
  if (!cont) return;
  const lista = Array.isArray(items) ? items : [];
  if (lista.length === 0) {
    cont.innerHTML = '<div class="panel6-vacio">' + escapeHtml(mensajeVacio) + "</div>";
    return;
  }
  cont.innerHTML = lista.map(itemACard).join("");
}

function renderPanel6(panel6) {
  const p = panel6 || {};
  renderPanel6Lista("panel6-bundles", p.bundles, "Sin bundles sugeridos por ahora.");
  renderPanel6Lista("panel6-ofertas", p.ofertas_dia, "Sin ofertas del día por ahora.");
  renderPanel6Lista("panel6-alertas", p.alertas, "Sin alertas de riesgo financiero. ¡Bien!");
  renderPanel6Lista("panel6-top5", p.top5_acciones, "Sin acciones urgentes pendientes.");
}

/* ---------- Carga principal ---------- */

async function cargarPromociones() {
  try {
    const data = await apiFetch("/api/promociones");
    renderPanelTabla("panel1", data.panel1);
    renderPanelTabla("panel2", data.panel2);
    renderPanelTabla("panel3", data.panel3);
    renderPanelTabla("panel4", data.panel4);
    renderPanelTabla("panel5", data.panel5);
    renderPanel6(data.panel6);
  } catch (err) {
    mostrarToast("No se pudieron cargar las promociones: " + err.message, "error");
  }
}

/* ---------- Eventos ---------- */

function initPromociones() {
  // Exportar Excel por panel (GET /api/export/:panel → descarga)
  document.querySelectorAll(".btn-export").forEach(function (btn) {
    btn.addEventListener("click", function () {
      const panel = btn.getAttribute("data-panel");
      window.open("/api/export/" + encodeURIComponent(panel), "_blank");
    });
  });

  // Imprimir / guardar como PDF (usa @media print de styles.css)
  document.querySelectorAll(".btn-print").forEach(function (btn) {
    btn.addEventListener("click", function () { window.print(); });
  });
}
