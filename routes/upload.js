// routes/upload.js — Endpoints de carga de archivos Excel (SPEC §5).
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { parseExcel, processRows, CANONICAL_FIELDS, FILE_TYPES } = require('../services/excelParser');
const { saveMapping, setMeta } = require('../database/db');
const {
  insertSales, insertAds, insertCosteo, insertInventory,
  updatePreciosEstimados, getStatus, MARKETPLACES,
} = require('../services/dataProcessor');

const router = express.Router();

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// multer en memoria (máx 25MB, solo .xlsx/.xls/.csv)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    // Los nombres pueden traer doble extensión (.xlsx.xlsx) → se valida la última
    if (['.xlsx', '.xls', '.csv'].includes(ext)) return cb(null, true);
    cb(new Error('Formato no soportado. Sube un archivo .xlsx, .xls o .csv'));
  },
});

// fileType → marketplace de ventas (si aplica)
const marketplaceDeVentas = (fileType) => {
  const m = fileType.match(/^ventas_(.+)$/);
  return m && MARKETPLACES.includes(m[1]) ? m[1] : null;
};

// POST /api/upload/confirm — procesa el archivo completo con el mapping confirmado
// (declarada ANTES de /upload/:type para que "confirm" no se tome como :type)
router.post('/upload/confirm', (req, res) => {
  try {
    const { sessionId, fileType, mapping } = req.body || {};
    if (!sessionId || !fileType || !mapping) {
      return res.status(400).json({ ok: false, error: 'Faltan datos: sessionId, fileType y mapping son obligatorios.' });
    }
    if (!FILE_TYPES.includes(fileType)) {
      return res.status(400).json({ ok: false, error: `Tipo de archivo no válido: ${fileType}` });
    }
    const tmpPath = path.join(UPLOADS_DIR, `tmp_${path.basename(sessionId)}.xlsx`);
    if (!fs.existsSync(tmpPath)) {
      return res.status(400).json({ ok: false, error: 'La sesión de carga expiró. Vuelve a subir el archivo.' });
    }
    const buffer = fs.readFileSync(tmpPath);
    const parsed = parseExcel(buffer, fileType);
    // Mapping final: el confirmado por el usuario, completando huecos con el sugerido
    const finalMapping = { ...parsed.suggestedMapping };
    for (const [campo, columna] of Object.entries(mapping)) {
      if (columna && parsed.headers.includes(columna)) finalMapping[campo] = columna;
      else if (!columna) delete finalMapping[campo];
    }

    const records = processRows(fileType, parsed.rows, finalMapping);
    if (!records.length && fileType !== 'historico_promociones') {
      return res.status(400).json({ ok: false, error: 'No se encontraron filas válidas con el mapeo seleccionado.' });
    }

    // Inserción (borra datos previos del mismo fileType/marketplace) y metadatos
    let marketplaces = [];
    const mp = marketplaceDeVentas(fileType);
    if (mp) {
      // Algunos reportes de ventas (p. ej. el nuevo de Amazon) traen filas de
      // publicidad embebidas, marcadas con __esPublicidad por el parser.
      const adsExtra = records
        .filter((r) => r.__esPublicidad)
        .map((r) => {
          const { __esPublicidad, ...rest } = r;
          return rest;
        });
      const ventasRows = records.filter((r) => !r.__esPublicidad);
      insertSales(mp, ventasRows);
      if (adsExtra.length) insertAds(adsExtra, [mp]);
      marketplaces = [mp];
      updatePreciosEstimados();
    } else if (fileType === 'publicidad_mercadolibre') {
      insertAds(records, ['mercadolibre', 'mercadolibre_pct']);
      marketplaces = ['mercadolibre'];
    } else if (fileType === 'costeo') {
      insertCosteo(records);
      updatePreciosEstimados();
    } else if (fileType === 'inventario_full_ml') {
      insertInventory('mercadolibre', records);
    } else if (fileType === 'inventario_fba_amazon') {
      insertInventory('amazon', records);
    } else if (fileType === 'historico_promociones') {
      // Archivo opcional: se conserva como JSON en meta
      setMeta('historico_promociones', JSON.stringify(records));
      setMeta('ultima_actualizacion_historico_promociones', new Date().toISOString());
    }
    setMeta(`ultima_actualizacion_${fileType}`, new Date().toISOString());
    saveMapping(fileType, finalMapping);
    fs.unlinkSync(tmpPath); // limpiar temporal

    res.json({ ok: true, inserted: records.length, marketplaces });
  } catch (e) {
    console.error('Error en confirmación de upload:', e);
    res.status(400).json({ ok: false, error: `Error al importar: ${e.message}` });
  }
});

// POST /api/upload/:type — recibe el archivo, lo parsea y devuelve mapeo sugerido + vista previa
router.post('/upload/:type', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'El archivo excede el tamaño máximo de 25MB'
        : err.message;
      return res.status(400).json({ ok: false, error: msg });
    }
    try {
      const fileType = req.params.type;
      if (!FILE_TYPES.includes(fileType)) {
        return res.status(400).json({ ok: false, error: `Tipo de archivo no válido: ${fileType}` });
      }
      if (!req.file || !req.file.buffer || !req.file.buffer.length) {
        return res.status(400).json({ ok: false, error: 'No se recibió ningún archivo. Adjunta tu Excel en el campo "file".' });
      }
      const parsed = parseExcel(req.file.buffer, fileType);
      if (!parsed.headers.length) {
        return res.status(400).json({ ok: false, error: 'El archivo está vacío o no se pudo leer. Verifica que sea un Excel válido.' });
      }
      // Guardar buffer temporal para la confirmación
      const sessionId = crypto.randomUUID();
      fs.writeFileSync(path.join(UPLOADS_DIR, `tmp_${sessionId}.xlsx`), req.file.buffer);
      res.json({
        ok: true,
        fileType,
        headers: parsed.headers,
        suggestedMapping: parsed.suggestedMapping,
        canonicalFields: CANONICAL_FIELDS[fileType] || [],
        previewRows: parsed.preview.slice(0, 8),
        totalRows: parsed.rows.length,
        sessionId,
      });
    } catch (e) {
      console.error('Error al procesar upload:', e);
      res.status(400).json({ ok: false, error: `No se pudo procesar el archivo: ${e.message}` });
    }
  });
});

// GET /api/status — estado de marketplaces y archivos auxiliares
router.get('/status', (req, res) => {
  try {
    res.json(getStatus());
  } catch (e) {
    console.error('Error en /api/status:', e);
    res.status(500).json({ ok: false, error: 'Error al consultar el estado.' });
  }
});

module.exports = router;
