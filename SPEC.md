# SPEC — App "Análisis de Ganancias en Marketplaces + Promociones IA"

Fuente única de verdad. Implementar fielmente. Idioma de UI: español (México). Moneda: MXN.

## 1. Stack y estructura

- Backend: Node.js 18+ + Express 4, `xlsx` (SheetJS), `multer`, `better-sqlite3`, `dotenv`, `cors`.
- Frontend: HTML5 + Bootstrap 5 (CDN), JS vanilla, Chart.js 4 (CDN), DataTables (CDN). Sin frameworks.
- Persistencia: SQLite en `database/app.db` (tablas de datos procesados + mapeos guardados).
- Estructura EXACTA:

```
/
├── server.js
├── package.json
├── .env.example            (PORT=3000)
├── .gitignore              (node_modules, uploads/*, database/*.db, .env)
├── README.md               (instrucciones despliegue DigitalOcean App Platform)
├── data_schema.md          (ya existe — referencia de columnas reales)
├── public/
│   ├── index.html
│   ├── css/styles.css
│   └── js/{app.js, dashboard.js, promociones.js, upload.js, charts.js}
├── routes/{upload.js, analyzer.js}
├── services/{excelParser.js, dataProcessor.js, promotionEngine.js}
├── database/db.js
└── uploads/                (con .gitkeep)
```

## 2. Marketplaces

5 marketplaces con claves fijas: `mercadolibre`, `amazon`, `walmart`, `tiktok`, `aliexpress`.
Estado por marketplace: `activo` (tiene ventas cargadas) | `sin_datos`.
Tipos de archivo aceptados (upload `type`): `ventas_mercadolibre`, `ventas_amazon`, `ventas_walmart`, `ventas_tiktok`, `ventas_aliexpress`, `publicidad_mercadolibre`, `costeo`, `inventario_full_ml`, `inventario_fba_amazon`, `historico_promociones`.

## 3. Base de datos (database/db.js)

better-sqlite3, creación automática de tablas al iniciar:

- `sales` (id INTEGER PK, marketplace TEXT, fecha TEXT ISO, sku TEXT, producto TEXT, unidades REAL, ingreso REAL, comision REAL, envio REAL, anulacion REAL, reembolso REAL, ret_isr REAL, ret_iva REAL, venta_por_publicidad INTEGER 0/1, estado TEXT)
- `ads` (id PK, marketplace TEXT, fecha TEXT, sku TEXT, inversion REAL, ventas_generadas REAL, clicks REAL, impresiones REAL) — para ML puede ser mensual con porcentaje (ver §5.4)
- `costeo` (sku TEXT PK, producto TEXT, categoria TEXT, costo_unitario REAL, precio_venta REAL, stock_sucursal REAL)
- `inventory_full` (sku TEXT, marketplace TEXT, stock REAL, costo_almacenaje REAL, dias_inventario REAL, ventas_30d REAL, PRIMARY KEY(sku, marketplace))
- `mappings` (file_type TEXT, original_column TEXT, canonical_field TEXT, PRIMARY KEY(file_type, original_column))
- `meta` (key TEXT PK, value TEXT) — para "última actualización" por sección.

Exporta `db` y helpers. Campos canónicos de ventas: `fecha, sku, producto, unidades, ingreso, comision, envio, anulacion, reembolso, ret_isr, ret_iva, venta_por_publicidad, estado`.

## 4. services/excelParser.js

Funciones exportadas:
- `parseExcel(buffer, fileType)` → `{ headers, rows, suggestedMapping, preview }`. Lee con SheetJS (`{cellDates:true, raw:true}`). Soporta encabezados multi-fila: para `inventario_full_ml` usa `skiprows=3` equivalente (la fila 4 del Excel contiene los datos; el header real está en la fila 1).
- `suggestMapping(headers, fileType)` → objeto `{canonicalField: headerName}` usando keywords (es/en, case-insensitive, sin acentos): fecha: fecha/date/created; sku: sku/msku/fnsku/line: sku; producto: producto/product/item/title/nombre/publicacion/product-name; unidades: unidades/quantity/qty/cantidad/units; ingreso: ingresos por productos/ventas/price: total line items/total/amount/importe/precio; comision: cargo por venta/comision/fee/tarifa por referencia; envio: costos de envio/shipping/flete; anulacion/reembolso: anulaciones/reembolso/refund/cancel; ret_isr: isr; ret_iva: iva.
- `normalizeNumber(v)` → parsea números con formato MXN ("$1,234.56", negativos, NaN→0).
- `parseSpanishDate(str)` → convierte "30 de septiembre de 2025 23:47 hs." a ISO. Mapa de meses en español.
- Mapas de columnas REALES por tipo (ver data_schema.md — es la referencia obligatoria; los nombres exactos de columnas reales deben estar codificados como defaults por fileType, con fallback a keywords).
- Reglas especiales:
  - ML ventas: comision/envio vienen NEGATIVOS → usar valor absoluto. `Venta por publicidad` == "Sí" → venta_por_publicidad=1. Estado contiene "cancelad" → monto a `anulacion` (ingreso de esa fila); contiene "devol"/"reembolso" → monto a `reembolso`.
  - Amazon ventas: reporte agregado por MSKU/mes. ingreso=`Ventas`, comision=`Tarifa por referencia en total` (abs), envio=0, reembolso = `Unidades devueltas` × `Precio de venta medio`. Costos de almacenamiento (`Cantidad: Tarifa mensual...` + `Recargo por uso de almacenamiento` + `Tarifas por retiro...`) se suman en una fila de `ads` con inversion=0? NO — se agregan al campo `envio`=0 y se guardan sumados en `comision`? NO: guardarlos sumados en una tabla aparte NO; agregarlos al campo `comision` de esa fila (son cargos del marketplace). Documentar en código.
  - TikTok: ingreso=`Price: Total Line Items`, envio=`Price: Total Shipping`, reembolso=`Price: Total Refund`, estado=`Payment: Status`. Cargo por venta calculado: comision = 15% del precio de venta (ingreso × 0.15), entra en costos_totales y reduce ganancia_neta.
  - Publicidad ML (2 formatos): (a) formato porcentaje real del usuario: columnas `Fecha` (nombre de mes en español, tolerar typo "Febreo") + `porcentaje del costo de publicida respecto a la venta total` (fracción 0.1049). Guardar en `ads` una fila mensual con `inversion = -1` (sentinela "porcentaje") y guardar el porcentaje en `ventas_generadas`? NO — guardar porcentaje en `inversion` como fracción y marcar `marketplace='mercadolibre_pct'`. El dataProcessor calcula: costo_publicidad_mes = ventas_totales_ML_mes × pct. (b) formato del brief (Inversion_Publicidad, Ventas_Generadas, etc.) → filas directas en `ads`. Soportar ambos.
  - Costeo: SKU puede ser numérico largo → SIEMPRE leer como string (`raw:false` o String()). Normalizar SKUs: trim; si es numérico puro, quitar ceros a la izquierda NO — conservar tal cual; matching case-insensitive con trim.
  - Costeo no trae precio de venta → `precio_venta` se estima después en dataProcessor como promedio de precio unitario de ventas del SKU (0 si no hay).
  - SKU matching global: normalizar con `String(v).trim()`.

## 5. API

### routes/upload.js
- `POST /api/upload/:type` (multer, campo `file`, máx 25MB, .xlsx/.xls/.csv) → parsea, devuelve `{ok, fileType, headers, suggestedMapping, previewRows (máx 8), totalRows, sessionId}`. Guarda buffer temporal en `uploads/tmp_<sessionId>.xlsx`.
- `POST /api/upload/confirm` body `{sessionId, fileType, mapping}` → procesa archivo completo con mapping confirmado (aplica reglas especiales §4), borra datos previos del mismo fileType/marketplace, inserta en BD, guarda mapping en tabla `mappings`, actualiza `meta.ultima_actualizacion_<fileType>`. Devuelve `{ok, inserted, marketplaces}`.
- `GET /api/status` → `{ marketplaces: {mercadolibre:{estado,ultima_actualizacion,ventas_rows},...}, archivos: {costeo: bool, publicidad: bool, inventario_full_ml: bool, inventario_fba_amazon: bool} }`.

### routes/analyzer.js
- `GET /api/dashboard/:marketplace?desde=&hasta=` → `{ estado, metricas: {...16 métricas...}, transacciones: [...] }`.
- `GET /api/dashboard-all` → `{ por_marketplace: {mp: metricas}, totales: {...}, ventas_diarias: [{fecha, total}], activos: [...] }`.
- `GET /api/promociones` → `{ panel1: [...20], panel2: [...20], panel3: [...20], panel4: [...20], panel5: [...20], panel6: {bundles, ofertas_dia, alertas, top5_acciones} }`.
- `GET /api/export/:panel` (panel = dashboard|<mp>|panel1..panel6) → genera Excel con SheetJS y lo envía como descarga. PDF: el frontend usa window.print con CSS print — no hace falta endpoint PDF.

## 6. Métricas (dataProcessor.js) — las 16 tarjetas

Por marketplace y rango de fechas (sin rango = todo):
1. `ventas_totales` = Σ ingreso (solo filas que NO sean anulación/reembolso puras; ML: excluir filas cuyo estado indique cancelada/reembolso del ingreso, esas cuentan en tarjetas 8/9).
2. `ventas_por_publicidad`: ML = Σ ingreso de filas con venta_por_publicidad=1; otros = 0.
3. `ventas_organicas` = ventas_totales − ventas_por_publicidad.
4. `ganancia_neta_pct` = ganancia_neta / ventas_totales × 100 (0.0 si ventas=0).
5. `ganancia_neta` = ventas_totales − costos_totales (es decir, − adquisición − cargo_venta − envío − publicidad). Anulaciones/reembolsos no se restan: sus ventas ya no cuentan como ingreso.
6. `cargo_venta` = Σ comision.
7. `costo_adquisicion` = Σ (costo_unitario[sku] × unidades). SKU sin costeo → costo 0 (contar y reportar `skus_sin_costeo`). REGLA: filas anuladas/devueltas/reembolsadas NO aportan costo de adquisición (valor 0). Amazon usa unidades NETAS (vendidas − devueltas) desde el parseo.
8. `anulaciones` = Σ anulacion. 9. `reembolsos` = Σ reembolso.
10. `costo_publicidad`: ML = Σ ads.inversion directas + (para filas sentinela porcentaje) ventas_totales_mes × pct. Si no hay archivo de publicidad → 0. Otros = 0.
11. `costo_envio` = Σ envio.
12. `acos` = costo_publicidad / ventas_por_publicidad × 100; null si no aplica/ventas_pub=0 → frontend muestra "N/A - Solo ML".
13. `tacos` = costo_publicidad / ventas_totales × 100; null si no aplica.
14. `costos_totales` = adquisición + cargo + envío + publicidad (SIN anulaciones, reembolsos ni retenciones — se muestran en sus propias tarjetas y no intervienen en ningún cálculo).
15. `ret_isr` = (ventas_totales ÷ 1.16) × 2.5%. SOLO visualización, calculada; no se suma a costos ni afecta ganancia neta.
16. `ret_iva` = (ventas_totales ÷ 1.16) × 8%. SOLO visualización, calculada; no se suma a costos ni afecta ganancia neta.

Respuesta métricas incluye también: `unidades_vendidas`, `num_transacciones`, `skus_sin_costeo`. Marketplace `sin_datos`: devolver `estado:"sin_datos"` y todas las métricas en 0 / acos,tacos null.

## 7. promotionEngine.js (Módulo 2)

Cruza sales (unidades por SKU último periodo completo disponible) + costeo + inventory_full:
- Stock_Total_Full = stock_full_ml + stock_fba; Stock_Total_General = + stock_sucursal.
- Percentiles p25/p75 de unidades vendidas entre SKUs con ventas.
- Panel 1: top 20 por unidades vendidas con existencias y `promocion_sugerida` según lógica: ventas altas(>p75) + stock full alto(>2×ventas mes) → "Descuento 10% + promoción en marketplace"; + stock sucursal alto → "Descuento 5-10% en canal físico"; stock bajo → "⭐ Producto estrella - Mantener precio".
- Panel 2: SKUs del costeo con 0 ventas, orden por precio (precio estimado o costo×1.4 si no hay) desc: caro(>p75 precio) + stock alto → "⚠️ Descuento 30-35% + envío gratis urgente"; caro + poco stock → "Bundle con producto estrella + descuento 20%"; precio medio → "Descuento 20-25% + cupón destacado"; bajo → "Bundle con producto complementario". Incluir `valor_inmovilizado` = stock_total × costo.
- Panel 3: 1–5 unidades vendidas, orden precio desc → "Cupón 15-20% + publicidad segmentada" (o "Liquidación 25% para rotación" si stock > 3 meses de ventas).
- Panel 4: top 20 stock_sucursal; alerta "⚠️ Sobreinventario en sucursal" si stock > 3× ventas mes; sugerencia "Campaña local + descuento 15-20% en punto de venta".
- Panel 5: top 20 stock full+fba combinado con costo_almacenaje_total; mucho ML → "⚡ Oferta relámpago en Mercado Libre 25-30%"; mucho FBA → "⚡ Liquidación en Amazon 25-30% para liberar espacio"; ambos → "⚠️ ALERTA: Descuento 30-40% urgente en ambos canales"; si stock_full > 3 meses de ventas → "⚡ ALERTA ALMACENAJE: Descuento 30-40% para liberar espacio YA".
- Panel 6: bundles (estrella top ventas + estancado 0 ventas de misma categoría), ofertas del día (top margen con stock), alertas de riesgo financiero (valor inmovilizado > $5,000 con 0 ventas), top 5 acciones urgentes priorizadas.

## 8. Frontend

### Layout
Sidebar fija (colapsable en móvil) con: Módulo 1 Dashboard, Módulo 2 Promociones, Subir archivos, toggle modo oscuro/claro. Header con título + "Última actualización".

### Módulo 1 — Dashboard
- Tabs: [Mercado Libre] [Amazon] [Walmart] [TikTok] [AliExpress] [TODOS]. Badge: ✅ verde "Activo" / 🔒 amarillo "Sin datos".
- Filtro de rango de fechas (date inputs + botón Aplicar).
- Grid de 16 tarjetas SIEMPRE visibles (responsive: 4 cols desktop, 2 tablet, 1 móvil), cada una con icono Bootstrap Icons + tooltip (atributo title o bs tooltip) explicativo.
- Formato moneda `$1,234.56 MXN`. Sin datos: valores `$0.00` en gris tenue; ACOS/TACOS "N/A - Solo ML".
- Colores tarjeta Ganancia Neta %: verde >25%, amarillo 10–25%, rojo <10%, gris 0%. ACOS: verde <15, amarillo 15–30, rojo >30. TACOS: verde <10, amarillo 10–20, rojo >20. Tarjetas Cargo por venta y Costos totales en rojo.
- Marketplace sin datos: banner centrado "📂 No se ha subido el archivo de ventas de [Marketplace]. Las métricas se mostrarán automáticamente cuando subas tu reporte." + botón destacado "⬆️ SUBIR EXCEL AHORA" (abre modal de upload preseleccionando ese marketplace). Tabla de transacciones vacía con mensaje "Sin transacciones registradas".
- Tabla de transacciones con DataTables (búsqueda, orden, paginación, idioma español).
- Tab TODOS: tabla comparativa 5 columnas marketplace + TOTAL (filas = 16 métricas). Columnas sin datos con fondo #f9f9f9 y badge 🔒 en encabezado; TOTAL suma solo activos. Gráficos Chart.js: barras (ventas por marketplace activo), pastel (distribución de ganancias), línea (ventas diarias combinadas). Colores sobrios, paleta cálida de baja saturación (ámbar/terracota/verde oliva/grises — sin gradientes azul-morado).

### Módulo 2 — Promociones
6 paneles con tablas DataTables + tarjetas para panel 6 (bundles, ofertas del día, alertas riesgo, top 5 acciones). Botón "Exportar Excel" por panel (GET /api/export/:panel) y "Imprimir/PDF" (window.print con @media print).

### Upload (upload.js)
- Zona drag&drop + selector de archivo; selector de tipo de archivo (10 tipos, etiquetas en español).
- Barra de progreso durante subida/procesamiento.
- Modal de mapeo: tabla header original → dropdown de campo canónico (preseleccionado con suggestedMapping) + vista previa de 8 filas. Botón "Confirmar e importar".
- Tras confirmar: refrescar estado, mostrar toast de éxito con filas insertadas.
- Diseño: dashboard empresarial moderno, modo oscuro/claro (toggle persiste en localStorage), 100% responsive, tipografía Inter o system-ui.

## 9. server.js

Express: `express.static('public')`, JSON body parser, monta routes, `GET /api/health`, sirve index.html en `/`, escucha `process.env.PORT || 3000`. Crear `uploads/` y `database/` si no existen.

## 10. package.json

```json
{
  "name": "marketplace-profit-analyzer", "version": "1.0.0", "main": "server.js",
  "scripts": { "start": "node server.js", "dev": "node server.js" },
  "engines": { "node": ">=18" },
  "dependencies": { "express": "^4.19.2", "multer": "^1.4.5-lts.1", "xlsx": "^0.18.5", "better-sqlite3": "^11.3.0", "dotenv": "^16.4.5", "cors": "^2.8.5" }
}
```

## 11. README.md

Descripción, instalación local (`npm install && npm start`), cómo subir los Excel, y despliegue en DigitalOcean App Platform: conectar repo GitHub, build command `npm install`, run command `npm start`, HTTP port 3000, variable de entorno PORT la inyecta DO, nota sobre disco efímero (SQLite se reinicia en cada deploy — aceptable como persistencia temporal) y opción de volumes.

## 12. Reglas de calidad

- Sin `TODO` ni stubs: todo el código funcional.
- Manejo de errores: uploads inválidos → 400 con mensaje en español; try/catch en rutas.
- Comentarios en español en la lógica de negocio.
- Probar `node server.js` levanta sin errores antes de commit.
