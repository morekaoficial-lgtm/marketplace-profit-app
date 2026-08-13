// server.js — Punto de entrada de la app (SPEC §9).
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');

// Crear carpetas necesarias si no existen
for (const dir of ['uploads', 'database']) {
  const p = path.join(__dirname, dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

const { dbReady } = require('./database/db'); // inicializa SQLite y crea tablas
const uploadRoutes = require('./routes/upload');
const analyzerRoutes = require('./routes/analyzer');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rutas de API
app.get('/api/health', (req, res) => res.json({ ok: true, servicio: 'Análisis de Ganancias en Marketplaces + Promociones IA' }));
app.use('/api', uploadRoutes);
app.use('/api', analyzerRoutes);

// Sirve el frontend en /
app.get('/', (req, res) => {
  const index = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  res.send('API en línea. El frontend (public/index.html) aún no está disponible.');
});

const PORT = process.env.PORT || 3000;
dbReady.then(() => {
  app.listen(PORT, () => {
    console.log(`Servidor escuchando en http://localhost:${PORT}`);
  });
}).catch((err) => {
  console.error('Error al inicializar la base de datos:', err);
  process.exit(1);
});
