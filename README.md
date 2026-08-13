# Análisis de Ganancias en Marketplaces + Promociones IA

Aplicación web para analizar la rentabilidad de ventas en marketplaces (Mercado Libre, Amazon, Walmart, TikTok y AliExpress) a partir de los reportes Excel de cada plataforma, y generar sugerencias de promociones cruzando ventas, costeo e inventarios (Full ML / FBA Amazon).

## Características

- **Módulo 1 — Dashboard**: 16 métricas de rentabilidad por marketplace (ventas totales, ganancia neta, ACOS/TACOS, costo de publicidad, retenciones, etc.), filtro por rango de fechas, tabla de transacciones y comparativa entre marketplaces.
- **Módulo 2 — Promociones IA**: 6 paneles con sugerencias de promoción basadas en rotación, stock en Full/FBA/sucursal y valor inmovilizado.
- **Carga de Excel**: sube los reportes `.xlsx`/`.xls`/`.csv`, con mapeo de columnas asistido (sugerencia automática + confirmación manual).
- Persistencia en SQLite vía sql.js (WASM, sin compilación nativa), archivo `database/app.db`.

## Requisitos

- Node.js 18+

## Instalación local

```bash
npm install
cp .env.example .env   # opcional, por defecto PORT=3000
npm start
```

Abrir http://localhost:3000

## Cómo subir los Excel

1. Entra a **Subir archivos** en la barra lateral.
2. Selecciona el tipo de archivo (ventas de cada marketplace, publicidad ML, costeo, inventarios Full ML / FBA Amazon).
3. Arrastra el Excel o selecciónalo; se mostrará una vista previa con el mapeo de columnas sugerido.
4. Confirma la importación. Las métricas se actualizan automáticamente.

Notas de formato soportadas:

- **Ventas Mercado Libre**: reporte de ventas con fechas en español ("30 de septiembre de 2025 23:47 hs."), cargos negativos y bandera "Venta por publicidad".
- **Publicidad Mercado Libre**: formato de porcentaje mensual (`Fecha` = nombre del mes, columna de porcentaje como fracción) o formato con montos (Inversión/Ventas generadas).
- **Ventas Amazon**: reporte agregado por MSKU/mes (en español).
- **Ventas TikTok**: export tipo Shopify (hoja "Orders").
- **Inventario Full ML**: reporte "Resumen" con encabezado de 3 filas.
- **Inventario FBA Amazon**: reporte FBA estándar en inglés.

## Despliegue en DigitalOcean App Platform

1. Sube este repositorio a GitHub.
2. En DigitalOcean: **Create → App → GitHub** y selecciona el repositorio y la rama.
3. Configura el componente (Web Service):
   - **Build command**: `npm install`
   - **Run command**: `npm start`
   - **HTTP Port**: `3000`
4. Variables de entorno: DigitalOcean inyecta automáticamente `PORT`; no hace falta configurarla manualmente (la app usa `process.env.PORT || 3000`).
5. Despliega.

> **Nota sobre persistencia**: el disco del contenedor en App Platform es **efímero**; la base SQLite (`database/app.db`) y los archivos subidos se reinician en cada deploy/reinicio. Es aceptable como persistencia temporal (los Excel se pueden volver a subir). Si necesitas persistencia permanente, agrega un **Volume** montado en `/app/database` (y opcionalmente `/app/uploads`) desde la configuración del componente.

## Estructura

```
/
├── server.js
├── routes/{upload.js, analyzer.js}
├── services/{excelParser.js, dataProcessor.js, promotionEngine.js}
├── database/db.js
├── public/                 (frontend estático)
└── uploads/                (temporales de carga)
```
