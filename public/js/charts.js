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

  // Métricas comparadas en la gráfica de barras agrupadas (SPEC-v2 §4)
  const METRICAS_BARRAS = [
    { key: "ventas_totales", label: "Ventas totales" },
    { key: "costos_totales", label: "Costos totales" },
    { key: "ganancia_neta", label: "Ganancia neta" },
    { key: "cargo_venta", label: "Cargo por venta" },
    { key: "costo_publicidad", label: "Publicidad" },
    { key: "contracargos", label: "Contracargos" }
  ];

  /** Barras agrupadas: 6 métricas del mes actual vs el mes anterior. */
  function renderComparativaBarras(canvasId, comparativa) {
    destruir(canvasId);
    const colores = coloresTexto();
    const ctx = document.getElementById(canvasId);
    if (!ctx || !comparativa) return;
    const act = comparativa.mes_actual || {};
    const ant = comparativa.mes_anterior || {};
    const etq = comparativa.etiquetas || { actual: "Mes actual", anterior: "Mes anterior" };
    instancias[canvasId] = new Chart(ctx, {
      type: "bar",
      data: {
        labels: METRICAS_BARRAS.map(function (m) { return m.label; }),
        datasets: [
          {
            label: etq.actual,
            data: METRICAS_BARRAS.map(function (m) { return Number(act[m.key]) || 0; }),
            backgroundColor: "#b07d3a",
            borderRadius: 5,
            maxBarThickness: 42
          },
          {
            label: etq.anterior,
            data: METRICAS_BARRAS.map(function (m) { return Number(ant[m.key]) || 0; }),
            backgroundColor: "#8a7f68",
            borderRadius: 5,
            maxBarThickness: 42
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom", labels: { color: colores.texto, padding: 12 } },
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

  /** Líneas de ventas diarias del mes actual y el anterior, alineadas por día del mes. */
  function renderDiariasComparativa(canvasId, comparativa) {
    destruir(canvasId);
    const colores = coloresTexto();
    const ctx = document.getElementById(canvasId);
    if (!ctx || !comparativa) return;
    const etq = comparativa.etiquetas || { actual: "Mes actual", anterior: "Mes anterior" };

    function porDiaDelMes(serie) {
      const mapa = {};
      (serie || []).forEach(function (d) {
        const dia = Number(String(d.fecha).slice(8, 10));
        mapa[dia] = (mapa[dia] || 0) + (Number(d.total) || 0);
      });
      return mapa;
    }
    const actMap = porDiaDelMes(comparativa.ventas_diarias_actual);
    const antMap = porDiaDelMes(comparativa.ventas_diarias_anterior);
    const dias = [];
    for (let i = 1; i <= 31; i++) dias.push(i);

    instancias[canvasId] = new Chart(ctx, {
      type: "line",
      data: {
        labels: dias.map(function (d) { return "Día " + d; }),
        datasets: [
          {
            label: etq.actual,
            data: dias.map(function (d) { return actMap[d] || 0; }),
            borderColor: "#b07d3a",
            backgroundColor: "rgba(176, 125, 58, 0.12)",
            fill: true,
            tension: 0.25,
            pointRadius: 1.5,
            pointBackgroundColor: "#b07d3a"
          },
          {
            label: etq.anterior,
            data: dias.map(function (d) { return antMap[d] || 0; }),
            borderColor: "#8a7f68",
            backgroundColor: "rgba(138, 127, 104, 0.10)",
            fill: true,
            tension: 0.25,
            pointRadius: 1.5,
            pointBackgroundColor: "#8a7f68"
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom", labels: { color: colores.texto, padding: 12 } },
          tooltip: baseTooltip()
        },
        scales: {
          x: { ticks: { color: colores.texto, maxTicksLimit: 16 }, grid: { display: false } },
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
    renderVentasDiarias: renderVentasDiarias,
    renderComparativaBarras: renderComparativaBarras,
    renderDiariasComparativa: renderDiariasComparativa
  };
})();
