// routes/analyzer.js — Dashboards, promociones y exportación a Excel (SPEC §5).
const express = require('express');
const XLSX = require('xlsx');

const { getDashboard, getDashboardAll, MARKETPLACES } = require('../services/dataProcessor');
const { getPromociones } = require('../services/promotionEngine');

const router = express.Router();

// Valida el formato de fecha YYYY-MM-DD de los filtros (null si no viene)
const fechaParam = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

// GET /api/dashboard/:marketplace?desde=&hasta=
router.get('/dashboard/:marketplace', (req, res) => {
  try {
    const mp = req.params.marketplace;
    if (!MARKETPLACES.includes(mp)) {
      return res.status(400).json({ ok: false, error: `Marketplace no válido: ${mp}` });
    }
    const desde = fechaParam(req.query.desde);
    const hasta = fechaParam(req.query.hasta);
    res.json(getDashboard(mp, desde, hasta));
  } catch (e) {
    console.error('Error en dashboard:', e);
    res.status(500).json({ ok: false, error: 'Error al calcular el dashboard.' });
  }
});

// GET /api/dashboard-all — comparativa de los 5 marketplaces
router.get('/dashboard-all', (req, res) => {
  try {
    const desde = fechaParam(req.query.desde);
    const hasta = fechaParam(req.query.hasta);
    res.json(getDashboardAll(desde, hasta));
  } catch (e) {
    console.error('Error en dashboard-all:', e);
    res.status(500).json({ ok: false, error: 'Error al calcular la comparativa.' });
  }
});

// GET /api/promociones — Módulo 2: 6 paneles de sugerencias
router.get('/promociones', (req, res) => {
  try {
    res.json(getPromociones());
  } catch (e) {
    console.error('Error en promociones:', e);
    res.status(500).json({ ok: false, error: 'Error al generar las promociones.' });
  }
});

// Convierte un objeto de métricas en filas [{metrica, valor}] para Excel
const metricasAfilas = (metricas) => Object.entries(metricas).map(([metrica, valor]) => ({ metrica, valor }));

// Agrega una hoja JSON al libro con manejo de arreglos vacíos
const addSheet = (wb, nombre, datos) => {
  const ws = XLSX.utils.json_to_sheet(datos.length ? datos : [{ mensaje: 'Sin datos' }]);
  XLSX.utils.book_append_sheet(wb, ws, nombre.slice(0, 31));
};

// GET /api/export/:panel — panel = dashboard | <marketplace> | panel1..panel6
router.get('/export/:panel', (req, res) => {
  try {
    const panel = req.params.panel;
    const desde = fechaParam(req.query.desde);
    const hasta = fechaParam(req.query.hasta);
    const wb = XLSX.utils.book_new();
    let nombreArchivo = `reporte_${panel}.xlsx`;

    if (panel === 'dashboard') {
      const all = getDashboardAll(desde, hasta);
      addSheet(wb, 'Totales', metricasAfilas(all.totales));
      for (const mp of MARKETPLACES) {
        addSheet(wb, mp, metricasAfilas(all.por_marketplace[mp].metricas));
      }
      addSheet(wb, 'Ventas diarias', all.ventas_diarias);
    } else if (MARKETPLACES.includes(panel)) {
      const d = getDashboard(panel, desde, hasta);
      addSheet(wb, 'Metricas', metricasAfilas(d.metricas));
      addSheet(wb, 'Transacciones', d.transacciones);
    } else if (/^panel[1-6]$/.test(panel)) {
      const promo = getPromociones();
      if (panel === 'panel6') {
        addSheet(wb, 'Bundles', promo.panel6.bundles);
        addSheet(wb, 'Ofertas del dia', promo.panel6.ofertas_dia);
        addSheet(wb, 'Alertas', promo.panel6.alertas);
        addSheet(wb, 'Top 5 acciones', promo.panel6.top5_acciones);
      } else {
        addSheet(wb, panel, promo[panel]);
      }
    } else {
      return res.status(400).json({ ok: false, error: `Panel no válido para exportar: ${panel}` });
    }

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo}"`);
    res.send(buffer);
  } catch (e) {
    console.error('Error al exportar:', e);
    res.status(500).json({ ok: false, error: 'Error al generar el Excel de exportación.' });
  }
});

module.exports = router;
