# Esquema REAL de los archivos Excel del usuario (inspeccionado 2026-08-07)

El parser debe mapear ESTAS columnas reales (no las del brief teórico). Los nombres de archivo pueden venir con doble extensión (.xlsx.xlsx).

## 1. ventas_mercadolibre.xlsx — 12,390 filas, 61 cols, hoja "Hoja1"
Columnas clave:
- `Fecha de venta` → TEXTO español: "30 de septiembre de 2025 23:47 hs." (requiere parser de fecha en español)
- `Estado` → "Entregado", "Cancelada por el comprador", "Devolución finalizada con reembolso al comprador", etc. (135 valores distintos; anulación = estado contiene "cancelad", reembolso = contiene "devol"/"reembolso")
- `Unidades` (número)
- `Ingresos por productos (MXN)` → ingreso bruto
- `Cargo por venta e impuestos (MXN)` → comisión (valor NEGATIVO)
- `Costos de envío (MXN)` → negativo, puede ser NaN
- `Anulaciones y reembolsos (MXN)` → puede ser NaN
- `Total (MXN)` → neto
- `Venta por publicidad` → "Sí" o vacío (bandera, NO monto)
- `SKU` (string, mezcla códigos propios y códigos de barras)
- `Título de la publicación` → nombre producto
- `Precio unitario de venta de la publicación (MXN)`
- NO hay columnas de retención ISR/IVA → $0.00

## 2. ventas_amazon.xlsx — 980 filas, 33 cols (reporte agregado por MSKU por mes)
- `Fecha de inicio` (datetime) y `Fecha de finalización`
- `MSKU` → SKU
- `Unidades vendidas`, `Unidades devueltas`, `Unidades netas vendidas`
- `Ventas` → ingreso bruto; `Ventas netas`
- `Tarifa por referencia en total` → comisión
- `Cantidad: Tarifa mensual por almacenamiento de inventario`, `Recargo por uso de almacenamiento`, `Tarifas por retiro de inventario de Logística de Amazon` → costos
- `Costo de la mercancía vendida por unidad` (puede ser NaN → usar costeo)
- `Ingresos netos en total`
- NO hay columna de nombre de producto usable → cruzar con costeo/FBA por SKU

## 3. ventas_tiktok.xlsx — 63 filas, 41 cols, hoja "Orders" (formato export tipo Shopify)
- `Created At` (datetime), `Cancelled At`
- `Line: SKU`, `Line: Quantity`
- `Price: Total Line Items` → ingreso; `Price: Total` → total con envío
- `Price: Total Shipping`, `Price: Total Refund`, `Price: Total Discount`
- `Payment: Status` → "paid" / "refunded"
- NO hay comisión → $0.00

## 4. publicidad_mercadolibre.xlsx — 12 filas, 2 cols (¡no es el formato del brief!)
- `Fecha` → nombre de MES en español ("Enero", "Febreo" [sic], "Marzo"...)
- `porcentaje del costo de publicida respecto a la venta total` → fracción (0.1049 = 10.49%)
- IMPORTANTE: el archivo trae el % de publicidad sobre ventas totales, NO montos. Costo_Publicidad = Ventas_Totales_ML_del_mes × porcentaje. Ventas por publicidad: usar bandera `Venta por publicidad` == "Sí" del archivo de ventas ML para estimar ventas atribuidas; si el archivo de publicidad trae montos reales (formato del brief), usarlos directo. El parser debe soportar AMBOS formatos.

## 5. costeo_actualizado.xlsx — 798 filas, 7 cols, hoja "Sheet1"
- `Tipo de Producto` (categoría), `Producto`, `Variante`, `Código Barras`
- `SKU` (string; códigos de barras numéricos largos guardados como texto/número)
- `Stock` → Stock_Sucursal
- `Costo Neto Prom. Unitario` → Costo_Unitario
- NO tiene Precio_Venta_Actual → estimar precio desde ventas (precio unitario promedio por SKU) como fallback

## 6. inventario_full_ml.xlsx — hoja "Resumen", encabezado de 3 FILAS (datos desde fila 4)
- Col 3 `SKU`, col 6 `Producto`
- Col 11 `Ventas últimos 30 días (u.)`
- Col 18 `Unidades en Full` → Stock_Full_ML
- Col 29 `Tiempo hasta agotar stock...` → días de inventario
- No trae costo de almacenaje → $0

## 7. inventario_fba_amazon.xlsx — 63 cols (reporte FBA estándar en inglés)
- `sku`, `product-name`, `available` → Stock_FBA
- `estimated-storage-cost-next-month` → costo almacenaje
- `days-of-supply`, `your-price`

## 8. historico_promociones.xlsx — OPCIONAL, puede no existir

## Overlap SKU con costeo (de 798 SKUs)
- ML ventas: 620 SKUs únicos, 269 coinciden con costeo
- AMZ: 140 únicos, 60 coinciden | TikTok: 27 únicos, 21 coinciden
- Matching debe ser por string exacto normalizado (trim, sin ceros a la izquierda si numérico); los no encontrados usan costo 0 y se marcan "SKU sin costeo".
