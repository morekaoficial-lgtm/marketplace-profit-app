/* ============================================================
   app.js — Bootstrap de la aplicación
   Navegación del sidebar, toggle de tema (persistente),
   carga inicial de GET /api/status, badges en tabs y helpers
   compartidos (fetch, formato de moneda MXN, toasts).
   ============================================================ */

"use strict";

/* ---------- Helpers globales ---------- */

/** Wrapper de fetch con manejo de errores en español. */
async function apiFetch(url, options) {
  const resp = await fetch(url, options);
  let data = null;
  try { data = await resp.json(); } catch (e) { data = null; }
  if (!resp.ok) {
    const msg = (data && (data.error || data.mensaje || data.message)) ||
      `Error del servidor (${resp.status})`;
    throw new Error(msg);
  }
  return data;
}

/** Formato de moneda MXN: $1,234.56 */
function formatoMoneda(valor) {
  const n = Number(valor) || 0;
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Formato de porcentaje con 1 decimal: 12.3% */
function formatoPct(valor) {
  const n = Number(valor) || 0;
  return n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "%";
}

/** Formato de número entero con separador de miles. */
function formatoEntero(valor) {
  const n = Number(valor) || 0;
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/** Muestra un toast (tipos: exito, error, info). */
function mostrarToast(mensaje, tipo) {
  tipo = tipo || "info";
  const iconos = { exito: "bi-check-circle-fill", error: "bi-x-circle-fill", info: "bi-info-circle-fill" };
  const titulos = { exito: "Éxito", error: "Error", info: "Aviso" };
  const cont = document.getElementById("toast-container");
  const el = document.createElement("div");
  el.className = "toast toast-" + tipo;
  el.setAttribute("role", "alert");
  el.innerHTML =
    '<div class="toast-header">' +
    '<i class="bi ' + (iconos[tipo] || iconos.info) + ' me-2"></i>' +
    '<strong class="me-auto">' + titulos[tipo] + '</strong>' +
    '<button type="button" class="btn-close" data-bs-dismiss="toast" aria-label="Cerrar"></button>' +
    "</div>" +
    '<div class="toast-body"></div>';
  el.querySelector(".toast-body").textContent = mensaje;
  cont.appendChild(el);
  const toast = new bootstrap.Toast(el, { delay: 5000 });
  el.addEventListener("hidden.bs.toast", function () { el.remove(); });
  toast.show();
}

/** Escapa texto para insertarlo en HTML sin riesgo de XSS. */
function escapeHtml(valor) {
  if (valor === null || valor === undefined) return "";
  return String(valor)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ---------- Constantes globales ---------- */

const MARKETPLACES = ["mercadolibre", "amazon", "walmart", "tiktok", "aliexpress"];

const MP_NOMBRES = {
  mercadolibre: "Mercado Libre",
  amazon: "Amazon",
  walmart: "Walmart",
  tiktok: "TikTok",
  aliexpress: "AliExpress"
};

/** Tipo de archivo de ventas asociado a cada marketplace. */
const MP_TIPO_ARCHIVO = {
  mercadolibre: "ventas_mercadolibre",
  amazon: "ventas_amazon",
  walmart: "ventas_walmart",
  tiktok: "ventas_tiktok",
  aliexpress: "ventas_aliexpress"
};

/* Estado global compartido entre módulos */
const AppState = {
  status: null,          // respuesta de GET /api/status
  moduloActual: "dashboard"
};

/* ---------- Tema claro/oscuro ---------- */

function aplicarTema(tema) {
  document.documentElement.setAttribute("data-theme", tema);
  const icono = document.getElementById("theme-icon");
  const label = document.getElementById("theme-label");
  if (tema === "dark") {
    icono.className = "bi bi-sun";
    label.textContent = "Modo claro";
  } else {
    icono.className = "bi bi-moon-stars";
    label.textContent = "Modo oscuro";
  }
}

function initTema() {
  const guardado = localStorage.getItem("tema") || "light";
  aplicarTema(guardado);
  document.getElementById("theme-toggle").addEventListener("click", function () {
    const actual = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    const nuevo = actual === "dark" ? "light" : "dark";
    localStorage.setItem("tema", nuevo);
    aplicarTema(nuevo);
    // Notificar a los gráficos para que ajusten sus colores
    document.dispatchEvent(new CustomEvent("tema:cambiado", { detail: { tema: nuevo } }));
  });
}

/* ---------- Sidebar y navegación de módulos ---------- */

function initSidebar() {
  const sidebar = document.getElementById("sidebar");
  const backdrop = document.getElementById("sidebar-backdrop");

  function cerrarSidebarMovil() {
    sidebar.classList.remove("open");
    backdrop.classList.remove("show");
  }

  document.getElementById("sidebar-open-btn").addEventListener("click", function () {
    sidebar.classList.add("open");
    backdrop.classList.add("show");
  });
  backdrop.addEventListener("click", cerrarSidebarMovil);

  document.querySelectorAll(".sidebar-link[data-module]").forEach(function (link) {
    link.addEventListener("click", function (ev) {
      ev.preventDefault();
      const modulo = link.getAttribute("data-module");
      document.querySelectorAll(".sidebar-link").forEach(function (l) { l.classList.remove("active"); });
      link.classList.add("active");
      document.getElementById("module-dashboard").classList.toggle("d-none", modulo !== "dashboard");
      document.getElementById("module-promociones").classList.toggle("d-none", modulo !== "promociones");
      AppState.moduloActual = modulo;
      if (modulo === "promociones" && typeof cargarPromociones === "function") {
        cargarPromociones();
      }
      cerrarSidebarMovil();
    });
  });

  document.getElementById("nav-subir").addEventListener("click", function (ev) {
    ev.preventDefault();
    cerrarSidebarMovil();
    if (typeof abrirModalUpload === "function") abrirModalUpload();
  });
}

/* ---------- Estado general (GET /api/status) ---------- */

function actualizarBadges(marketplaces) {
  MARKETPLACES.forEach(function (mp) {
    const badge = document.getElementById("badge-" + mp);
    if (!badge) return;
    const info = marketplaces && marketplaces[mp];
    if (info && info.estado === "activo") {
      badge.className = "badge-estado badge-activo";
      badge.textContent = "✅ Activo";
    } else {
      badge.className = "badge-estado badge-sin-datos";
      badge.textContent = "🔒 Sin datos";
    }
  });
}

function actualizarUltimaActualizacion(marketplaces) {
  let ultima = null;
  MARKETPLACES.forEach(function (mp) {
    const info = marketplaces && marketplaces[mp];
    if (info && info.ultima_actualizacion) {
      const fecha = new Date(info.ultima_actualizacion);
      if (!isNaN(fecha) && (!ultima || fecha > ultima)) ultima = fecha;
    }
  });
  const el = document.getElementById("ultima-actualizacion");
  el.textContent = ultima
    ? ultima.toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" })
    : "Sin datos cargados";
}

/** Carga (o recarga) el estado global desde la API y actualiza la UI base. */
async function cargarStatus() {
  try {
    const status = await apiFetch("/api/status");
    AppState.status = status;
    actualizarBadges(status.marketplaces);
    actualizarUltimaActualizacion(status.marketplaces);
    return status;
  } catch (err) {
    mostrarToast("No se pudo obtener el estado del servidor: " + err.message, "error");
    actualizarBadges(null);
    return null;
  }
}

/* ---------- Arranque ---------- */

document.addEventListener("DOMContentLoaded", function () {
  initTema();
  initSidebar();
  cargarStatus().then(function () {
    // Inicializar el dashboard con el estado ya disponible
    if (typeof initDashboard === "function") initDashboard();
    if (typeof initUpload === "function") initUpload();
    if (typeof initPromociones === "function") initPromociones();
  });
});
