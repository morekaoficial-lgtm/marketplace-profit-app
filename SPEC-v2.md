# SPEC v2 — Cambios 2026-11: comparativa mensual, contracargos, nuevo formato ML, sin Módulo 2

Cambios sobre el proyecto existente en /mnt/agents/output/marketplace-profit-app/project (master). Mantener TODO lo que funciona hoy (16 tarjetas, reglas de negocio ya ajustadas: reembolsos sin costo de adquisición, retenciones ISR/IVA solo informativas calculadas (ventas/1.16)×2.5% y ×8%, anulaciones/reembolsos fuera de costos_totales, ganancia_neta = ventas − costos_totales, cargo TikTok = 15% solo ventas válidas).

## 1. Parser: nuevo formato Mercado Libre (20261102_Ventas_MX_...xlsx)

El nuevo export oficial trae 5 filas de metadatos antes del encabezado (que está en la fila 6 del Excel) y 67 columnas. REQUERIDO:
- **Detección inteligente de fila de encabezado** en `parseExcel` para ventas_mercadolibre: escanear las primeras 10 filas y usar como header la que contenga `# de venta` y `Fecha de venta`. Debe seguir funcionando el formato VIEJO (header en fila 1) y el NUEVO.
- Columnas duplicadas (`Estado` ×2, `Unidades` ×3, `Forma de entrega` ×2, etc.): al mapear por nombre, usar SIEMPRE la primera ocurrencia.
- Columnas clave (mismos nombres que antes): `Fecha de venta` (mismo formato español "2 de noviembre de 2026 07:40 hs."), `Estado`, `Unidades`, `Ingresos por productos (MXN)`, `Cargo por venta e impuestos (MXN)`, `Costos de envío (MXN)`, `Anulaciones y reembolsos (MXN)`, `Total (MXN)`, `Venta por publicidad` ("Sí"), `SKU`, `Título de la publicación`. Nuevas (`Depósito`, `Modelo de venta`, `Descuentos y bonificaciones`, etc.) se ignoran.
- La corrección de filas desplazadas ("Color : ..." → título desde `Tienda oficial`) debe seguir aplicando.
- **TikTok**: el nuevo archivo (204 columnas) mantiene los mismos nombres clave; verificar que el parser actual lo procesa sin cambios.

## 2. Contracargos (gasto adicional manual)

- Nueva tabla `contracargos` (marketplace TEXT, mes TEXT 'YYYY-MM', monto REAL, PRIMARY KEY(marketplace, mes)).
- API: `GET /api/contracargos` → {mercadolibre: [{mes, monto}], ...}; `POST /api/contracargos` {marketplace, mes, monto} → upsert.
- Métrica nueva `contracargos`: suma de los montos de los meses que intersectan el rango de fechas del filtro (sin filtro = todos).
- REGLA: contracargos SÍ entra en `costos_totales` y por tanto reduce `ganancia_neta` (es un gasto real, a diferencia de las retenciones). costos_totales = adquisición + cargo + envío + publicidad + contracargos.
- TARJETA 17 "Contracargos" (icono, color rojo, tooltip "Gasto adicional por contracargos/chargebacks — se captura manualmente por mes").
- En cada tab de marketplace: un mini-formulario junto a las tarjetas: "Contracargos de [mes actual]: $ [input] [Guardar]" → POST y refresca. También fila "Contracargos" en la tabla comparativa de TODOS.
- Parser: agregar keywords de detección "contracargo"/"chargeback" al campo canónico `contracargo` por si futuros archivos lo traen (si existe columna, sumar esas filas a la métrica además del monto manual).

## 3. Comparativa mes actual vs mes anterior (tarjetas + gráficas por marketplace)

- Backend: `GET /api/dashboard/:mp` añade:
  - `mes_actual` y `mes_anterior`: objetos con las 17 métricas calculadas para el mes calendario actual (fecha del servidor) y el mes anterior completo. Independiente del filtro de fechas.
  - `ventas_diarias_actual`: [{dia: 1..31, total}] y `ventas_diarias_anterior`: [{dia, total}].
  - `etiquetas`: {actual: "noviembre 2026", anterior: "octubre 2026"} (en español).
  - `GET /api/dashboard-all` añade lo mismo agregado (suma de activos) + contracargos en `totales` y `por_marketplace`.
- Tarjetas: bajo cada valor, línea pequeña gris: "Mes anterior: $X (▲ 12.3% / ▼ 5.1%)". Verde si mejora, rojo si empeora (para costos: invertir semáforo). Si mes anterior = 0, mostrar "Mes anterior: $0.00" sin %.
- Gráficas NUEVAS en CADA tab de marketplace (2 por tab, encima de la tabla de transacciones):
  1. **Barras agrupadas** "Mes actual vs mes anterior": métricas [Ventas totales, Costos totales, Ganancia neta, Cargo por venta, Publicidad, Contracargos].
  2. **Líneas** "Ventas diarias": mes actual vs mes anterior (eje X = día 1..31, dos series con colores de la paleta).
- Tab TODOS: mantener sus 3 gráficas + agregar fila Contracargos en la comparativa y las 2 gráficas comparativas con datos agregados.
- Marketplaces sin datos: gráficas vacías con mensaje, igual que las tarjetas en $0.00.

## 4. Eliminar Módulo 2 (solo UI)

- Quitar del sidebar el enlace a Promociones y toda la sección Módulo 2 del HTML; no cargar promociones.js. El endpoint /api/promociones puede quedar en backend (no estorba).

## 5. Verificación obligatoria

Con los archivos NUEVOS del usuario (en /mnt/agents/upload/):
- `20261102_Ventas_MX_Mercado_Libre_y_Mercado_Shops_2026-11-02_11-36hs_790821872.xlsx` → ML: 2,898 filas; ventas_totales **$947,698.24**; cargo_venta $238,111.09; costo_envio $177,377.51; anulaciones $35,904.25; ventas_pub $299,995.27; unidades válidas 3,490. Por mes: 2026-10 = $136,777.92, 2026-11 = $2,777.20.
- `tiktok.xlsx` (nuevo, 74 filas, oct-2026) → debe importar sin cambios al parser.
- Contracargos: POST 1,000 a mercadolibre mes actual → tarjeta muestra $1,000, costos_totales sube 1,000, ganancia baja 1,000.
- mes_actual/mes_anterior correctos contra las cifras por mes de arriba.
- Regresión: viejos formatos siguen importando (ventas_mercadolibre.xlsx.xlsx viejo, ventas_amazon, publicidad, costeo, inventarios).
