/* ============================================================
   charts.js — Gráficos Chart.js del tab TODOS
   Barras: ventas por marketplace · Pastel: distribución de
   ganancias · Línea: ventas diarias combinadas.
   Se destruyen y recrean al refrescar datos o cambiar de tema.
   Paleta cálida de baja saturación coherente con styles.css.
   ============================================================ */

"use strict";

const Charts = (function () {

  // Paleta sobria cálida (ámbar, terracota, oliva, grises)
  const PALETA = ["#b07d3a", "#b45a44", "#6f7d42", "#8a7f68", "#c9a15a", "#7d6a50"];

  // Registro de instancias para destruir antes de recrear
  const instancias = {};

  function coloresTexto() {
    const oscuro = document.documentElement.getAttribute("data-theme") === "dark";
    return {
      texto: oscuro ? "#e8e3d8" : "#3a352c",
      rejilla: oscuro ? "rgba(232, 227, 216, 0.12)" : "rgba(58, 53, 44, 0.10)"
    };
  }

  function destruir(id) {
    if (instancias[id]) {
      instancias[id].destroy();
      delete instancias[id];
    }
  }

  function baseTooltip() {
    return {
      callbacks: {
        label: function (ctx) {
          const valor = ctx.parsed && typeof ctx.parsed === "object" ? ctx.parsed.y : ctx.parsed;
          return " " + (ctx.dataset.label ? ctx.dataset.label + ": " : "") + formatoMoneda(valor);
        }
      }
    };
  }

  /** Gráfico de barras: ventas totales por marketplace activo. */
  function renderVentasPorMarketplace(canvasId, labels, valores) {
    destruir(canvasId);
    const colores = coloresTexto();
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;
    instancias[canvasId] = new Chart(ctx, {
      type: "bar",
      data: {
        labels: labels,
        datasets: [{
          label: "Ventas totales",
          data: valores,
          backgroundColor: labels.map(function (_, i) { return PALETA[i % PALETA.length]; }),
          borderRadius: 6,
          maxBarThickness: 70
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: baseTooltip()
        },
        scales: {
          x: { ticks: { color: colores.texto }, grid: { display: false } },
          y: {
            ticks: {
              color: colores.texto,
              callback: function (v) { return "$" + Number(v).toLocaleString("en-US"); }
            },
            grid: { color: colores.rejilla }
          }
        }
      }
    });
  }

  /** Gráfico de pastel: distribución de la ganancia neta por marketplace. */
  function renderDistribucionGanancias(canvasId, labels, valores) {
    destruir(canvasId);
    const colores = coloresTexto();
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;
    instancias[canvasId] = new Chart(ctx, {
      type: "pie",
      data: {
        labels: labels,
        datasets: [{
          data: valores,
          backgroundColor: labels.map(function (_, i) { return PALETA[i % PALETA.length]; }),
          borderColor: document.documentElement.getAttribute("data-theme") === "dark" ? "#322f28" : "#ffffff",
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom", labels: { color: colores.texto, padding: 14 } },
          tooltip: baseTooltip()
        }
      }
    });
  }

  /** Gráfico de línea: ventas diarias combinadas de todos los marketplaces. */
  function renderVentasDiarias(canvasId, ventasDiarias) {
    destruir(canvasId);
    const colores = coloresTexto();
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;
    const labels = (ventasDiarias || []).map(function (d) { return d.fecha; });
    const valores = (ventasDiarias || []).map(function (d) { return d.total; });
    instancias[canvasId] = new Chart(ctx, {
      type: "line",
      data: {
        labels: labels,
        datasets: [{
          label: "Ventas diarias",
          data: valores,
          borderColor: "#b07d3a",
          backgroundColor: "rgba(176, 125, 58, 0.15)",
          fill: true,
          tension: 0.25,
          pointRadius: 2,
          pointBackgroundColor: "#b07d3a"
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: baseTooltip()
        },
        scales: {
          x: {
            ticks: { color: colores.texto, maxTicksLimit: 12, maxRotation: 45 },
            grid: { display: false }
          },
          y: {
            ticks: {
              color: colores.texto,
              callback: function (v) { return "$" + Number(v).toLocaleString("en-US"); }
            },
            grid: { color: colores.rejilla }
          }
        }
      }
    });
  }

  // Al cambiar de tema se repintan con los datos actuales (dashboard.js re-renderiza)
  document.addEventListener("tema:cambiado", function () {
    document.dispatchEvent(new CustomEvent("graficos:repintar"));
  });

  return {
    renderVentasPorMarketplace: renderVentasPorMarketplace,
    renderDistribucionGanancias: renderDistribucionGanancias,
    renderVentasDiarias: renderVentasDiarias
  };
})();
