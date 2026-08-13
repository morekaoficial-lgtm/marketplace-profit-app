// database/db.js — Conexión SQLite vía sql.js (WASM, 100% JS, sin compilación nativa).
// Implementa SPEC §3. Mantiene la misma interfaz que la versión anterior (better-sqlite3):
//   { db, getMeta, setMeta, saveMapping, getMapping }
// con db.prepare().all/get/run, db.exec, db.pragma (no-op) y db.transaction.
//
// sql.js es in-memory: la BD se carga de database/app.db al iniciar (si existe) y se
// persiste a disco tras cada escritura (write-atómico: archivo temporal + rename).
//
// initSqlJs es asíncrono: exportamos `dbReady` (promesa). server.js espera dbReady
// antes de app.listen, por lo que todos los métodos de `db` son síncronos en uso real.
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const DB_DIR = path.join(__dirname);
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const DB_PATH = path.join(DB_DIR, 'app.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  marketplace TEXT,
  fecha TEXT,                 -- ISO: YYYY-MM-DD o YYYY-MM-DDTHH:mm:ss
  sku TEXT,
  producto TEXT,
  unidades REAL,
  ingreso REAL,
  comision REAL,
  envio REAL,
  anulacion REAL,
  reembolso REAL,
  ret_isr REAL,
  ret_iva REAL,
  venta_por_publicidad INTEGER DEFAULT 0,  -- 0/1
  estado TEXT
);
CREATE INDEX IF NOT EXISTS idx_sales_mp_fecha ON sales(marketplace, fecha);
CREATE INDEX IF NOT EXISTS idx_sales_sku ON sales(sku);

CREATE TABLE IF NOT EXISTS ads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  marketplace TEXT,           -- 'mercadolibre' (montos directos) o 'mercadolibre_pct' (sentinela porcentaje)
  fecha TEXT,                 -- ISO, o nombre de mes normalizado cuando marketplace='mercadolibre_pct'
  sku TEXT,
  inversion REAL,             -- monto; si marketplace='mercadolibre_pct' guarda la FRACCIÓN (0.1049 = 10.49%)
  ventas_generadas REAL,
  clicks REAL,
  impresiones REAL
);

CREATE TABLE IF NOT EXISTS costeo (
  sku TEXT PRIMARY KEY,
  producto TEXT,
  categoria TEXT,
  costo_unitario REAL,
  precio_venta REAL,          -- el archivo no lo trae: se estima desde ventas (promedio precio unitario)
  stock_sucursal REAL
);

CREATE TABLE IF NOT EXISTS inventory_full (
  sku TEXT,
  marketplace TEXT,           -- 'mercadolibre' (Full) o 'amazon' (FBA)
  stock REAL,
  costo_almacenaje REAL,
  dias_inventario REAL,
  ventas_30d REAL,
  PRIMARY KEY (sku, marketplace)
);

CREATE TABLE IF NOT EXISTS mappings (
  file_type TEXT,
  original_column TEXT,
  canonical_field TEXT,
  PRIMARY KEY (file_type, original_column)
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

let realDb = null;   // instancia SQL.Database
let txDepth = 0;     // >0 cuando estamos dentro de db.transaction()

// Persiste la BD completa a disco (write-atómico: tmp + rename).
const persist = () => {
  if (!realDb || txDepth > 0) return; // dentro de una transacción se guarda al COMMIT
  const buf = Buffer.from(realDb.export());
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, DB_PATH);
};

// Normaliza parámetros al formato de sql.js:
// - args posicionales (?, ?, ...) -> array
// - objeto (named params) -> claves con prefijo '@' (better-sqlite3 las usa sin prefijo
//   al llamar run({marketplace: ...}); sql.js requiere {'@marketplace': ...})
// - undefined -> null; booleanos -> 0/1
const normalizeValue = (v) => {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
};
const normalizeParams = (args) => {
  if (args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0])) {
    const out = {};
    for (const [k, v] of Object.entries(args[0])) {
      const key = /^[@:$]/.test(k) ? k : '@' + k;
      out[key] = normalizeValue(v);
    }
    return out;
  }
  return args.map(normalizeValue);
};

const wrapStmt = (stmt) => ({
  all(...args) {
    if (args.length) stmt.bind(normalizeParams(args));
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.reset();
    return rows;
  },
  get(...args) {
    if (args.length) stmt.bind(normalizeParams(args));
    const row = stmt.step() ? stmt.getAsObject() : undefined;
    stmt.reset();
    return row;
  },
  run(...args) {
    if (args.length) stmt.bind(normalizeParams(args));
    stmt.step();
    stmt.reset();
    const info = { changes: realDb.getRowsModified() };
    persist();
    return info;
  },
});

// Interfaz compatible con better-sqlite3 (subset usado por la app).
const db = {
  prepare(sql) {
    if (!realDb) throw new Error('DB no inicializada: espera dbReady');
    return wrapStmt(realDb.prepare(sql));
  },
  exec(sql) {
    if (!realDb) throw new Error('DB no inicializada: espera dbReady');
    const res = realDb.exec(sql);
    persist();
    return res;
  },
  pragma() {
    // no-op: journal_mode WAL y similares no aplican en sql.js (in-memory + export)
  },
  transaction(fn) {
    return (...args) => {
      if (!realDb) throw new Error('DB no inicializada: espera dbReady');
      txDepth++;
      realDb.exec('BEGIN');
      try {
        const result = fn(...args);
        realDb.exec('COMMIT');
        txDepth--;
        persist();
        return result;
      } catch (err) {
        realDb.exec('ROLLBACK');
        txDepth--;
        throw err;
      }
    };
  },
};

const dbReady = initSqlJs({
  locateFile: (f) => path.join(path.dirname(require.resolve('sql.js')), f),
}).then((SQL) => {
  realDb = fs.existsSync(DB_PATH)
    ? new SQL.Database(fs.readFileSync(DB_PATH))
    : new SQL.Database();
  realDb.exec(SCHEMA);
  return db;
});

// Helpers de metadatos (última actualización por sección, etc.)
const getMeta = (key) => {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
};
const setMeta = (key, value) => {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
};

// Guarda el mapeo confirmado de columnas para un tipo de archivo.
// mapping viene como {campoCanónico: columnaOriginal}
const saveMapping = (fileType, mapping) => {
  const del = db.prepare('DELETE FROM mappings WHERE file_type = ?');
  const ins = db.prepare('INSERT OR REPLACE INTO mappings (file_type, original_column, canonical_field) VALUES (?, ?, ?)');
  const tx = db.transaction((m) => {
    del.run(fileType);
    for (const [canonical, original] of Object.entries(m)) {
      if (original) ins.run(fileType, String(original), canonical);
    }
  });
  tx(mapping);
};

const getMapping = (fileType) => {
  const rows = db.prepare('SELECT original_column, canonical_field FROM mappings WHERE file_type = ?').all(fileType);
  const out = {};
  for (const r of rows) out[r.canonical_field] = r.original_column;
  return out;
};

module.exports = { db, getMeta, setMeta, saveMapping, getMapping, dbReady };
