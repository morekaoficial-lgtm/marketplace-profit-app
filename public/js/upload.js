/* ============================================================
   upload.js — Subida de archivos Excel
   Drag & drop + selector, selector de los 10 tipos de archivo,
   barra de progreso (XHR), flujo:
     POST /api/upload/:type  → modal de mapeo de columnas
     POST /api/upload/confirm → toast de éxito + refresco.
   ============================================================ */

"use strict";

/** Campos canónicos disponibles por tipo de archivo (dropdown del mapeo). */
const CAMPOS_CANONICOS = {
  ventas: ["fecha", "sku", "producto", "unidades", "ingreso", "comision", "envio",
    "anulacion", "reembolso", "ret_isr", "ret_iva", "venta_por_publicidad", "estado"],
  publicidad_mercadolibre: ["fecha", "sku", "inversion", "ventas_generadas", "clicks", "impresiones", "porcentaje"],
  costeo: ["sku", "producto", "categoria", "costo_unitario", "precio_venta", "stock_sucursal"],
  inventario_full_ml: ["sku", "producto", "stock", "costo_almacenaje", "dias_inventario", "ventas_30d"],
  inventario_fba_amazon: ["sku", "producto", "stock", "costo_almacenaje", "dias_inventario", "ventas_30d"],
  historico_promociones: ["fecha", "sku", "producto", "tipo_promocion", "descuento", "unidades", "ingreso"]
};

const ETIQUETAS_CAMPOS = {
  fecha: "Fecha", sku: "SKU", producto: "Producto", unidades: "Unidades",
  ingreso: "Ingreso", comision: "Comisión", envio: "Envío", anulacion: "Anulación",
  reembolso: "Reembolso", ret_isr: "Retención ISR", ret_iva: "Retención IVA",
  venta_por_publicidad: "Venta por publicidad", estado: "Estado",
  inversion: "Inversión publicidad", ventas_generadas: "Ventas generadas",
  clicks: "Clicks", impresiones: "Impresiones", porcentaje: "Porcentaje de publicidad",
  categoria: "Categoría", costo_unitario: "Costo unitario", precio_venta: "Precio de venta",
  stock_sucursal: "Stock sucursal", stock: "Stock", costo_almacenaje: "Costo almacenaje",
  dias_inventario: "Días de inventario", ventas_30d: "Ventas 30 días",
  tipo_promocion: "Tipo de promoción", descuento: "Descuento"
};

const Upload = {
  archivo: null,
  session: null,   // {sessionId, fileType, headers, suggestedMapping, previewRows, totalRows}
  modalUpload: null,
  modalMapeo: null
};

/** Devuelve la lista de campos canónicos según el tipo de archivo. */
function camposParaTipo(fileType) {
  if (fileType && fileType.indexOf("ventas_") === 0) return CAMPOS_CANONICOS.ventas;
  return CAMPOS_CANONICOS[fileType] || CAMPOS_CANONICOS.ventas;
}

/** Abre el modal de upload, opcionalmente con un tipo preseleccionado. */
function abrirModalUpload(tipoPreseleccionado) {
  if (!Upload.modalUpload) {
    Upload.modalUpload = new bootstrap.Modal(document.getElementById("modal-upload"));
  }
  if (tipoPreseleccionado) {
    document.getElementById("upload-tipo").value = tipoPreseleccionado;
  }
  limpiarSeleccionArchivo();
  Upload.modalUpload.show();
}

/* ---------- Selección de archivo ---------- */

function limpiarSeleccionArchivo() {
  Upload.archivo = null;
  document.getElementById("upload-file").value = "";
  document.getElementById("upload-file-info").classList.add("d-none");
  document.getElementById("btn-upload-start").disabled = true;
  ocultarProgreso();
}

function validarArchivo(file) {
  const extOk = /\.(xlsx|xls|csv)$/i.test(file.name);
  if (!extOk) {
    mostrarToast("Formato no válido. Solo se aceptan archivos .xlsx, .xls o .csv", "error");
    return false;
  }
  if (file.size > 25 * 1024 * 1024) {
    mostrarToast("El archivo supera el máximo permitido de 25 MB", "error");
    return false;
  }
  return true;
}

function seleccionarArchivo(file) {
  if (!file || !validarArchivo(file)) return;
  Upload.archivo = file;
  document.getElementById("upload-file-name").textContent =
    file.name + " (" + (file.size / 1024).toFixed(1) + " KB)";
  document.getElementById("upload-file-info").classList.remove("d-none");
  document.getElementById("btn-upload-start").disabled = false;
}

/* ---------- Barra de progreso ---------- */

function mostrarProgreso(pct, texto) {
  const wrap = document.getElementById("upload-progress-wrap");
  const bar = document.getElementById("upload-progress");
  wrap.classList.remove("d-none");
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  bar.style.width = p + "%";
  bar.textContent = texto || (p + "%");
}

function ocultarProgreso() {
  document.getElementById("upload-progress-wrap").classList.add("d-none");
}

/* ---------- Paso 1: POST /api/upload/:type (con XHR para progreso) ---------- */

function subirArchivo() {
  if (!Upload.archivo) return;
  const tipo = document.getElementById("upload-tipo").value;
  const fd = new FormData();
  fd.append("file", Upload.archivo);

  const btn = document.getElementById("btn-upload-start");
  btn.disabled = true;

  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/upload/" + encodeURIComponent(tipo));
  xhr.responseType = "json";

  xhr.upload.addEventListener("progress", function (ev) {
    if (ev.lengthComputable) {
      mostrarProgreso((ev.loaded / ev.total) * 90);
    }
  });
  xhr.upload.addEventListener("load", function () {
    mostrarProgreso(95, "Procesando…");
  });

  xhr.addEventListener("load", function () {
    btn.disabled = false;
    const data = xhr.response;
    if (xhr.status >= 200 && xhr.status < 300 && data && data.ok) {
      mostrarProgreso(100, "Listo");
      Upload.session = data;
      Upload.modalUpload.hide();
      abrirModalMapeo(data);
    } else {
      ocultarProgreso();
      const msg = (data && (data.error || data.mensaje)) || "No se pudo procesar el archivo (" + xhr.status + ")";
      mostrarToast(msg, "error");
    }
  });

  xhr.addEventListener("error", function () {
    btn.disabled = false;
    ocultarProgreso();
    mostrarToast("Error de red al subir el archivo. Intenta de nuevo.", "error");
  });

  xhr.send(fd);
}

/* ---------- Paso 2: modal de mapeo de columnas ---------- */

function campoSugeridoParaHeader(suggestedMapping, header) {
  // suggestedMapping llega como {campoCanónico: nombreColumnaOriginal}
  if (!suggestedMapping) return "";
  const keys = Object.keys(suggestedMapping);
  for (let i = 0; i < keys.length; i++) {
    if (suggestedMapping[keys[i]] === header) return keys[i];
  }
  return "";
}

function abrirModalMapeo(data) {
  if (!Upload.modalMapeo) {
    Upload.modalMapeo = new bootstrap.Modal(document.getElementById("modal-mapeo"));
  }
  const campos = camposParaTipo(data.fileType);
  const tipoSelect = document.getElementById("upload-tipo");
  document.getElementById("mapeo-tipo-label").textContent =
    tipoSelect.options[tipoSelect.selectedIndex].text;
  document.getElementById("mapeo-total-rows").textContent = formatoEntero(data.totalRows);

  // Tabla header original → dropdown de campo canónico (preseleccionado)
  const tbody = document.querySelector("#tabla-mapeo tbody");
  tbody.innerHTML = "";
  (data.headers || []).forEach(function (header, idx) {
    const sugerido = campoSugeridoParaHeader(data.suggestedMapping, header);
    const opciones = campos.indexOf(sugerido) === -1 && sugerido
      ? campos.concat([sugerido])   // conservar sugerencias fuera del catálogo
      : campos;
    let opts = '<option value="">— Ignorar columna —</option>';
    opciones.forEach(function (campo) {
      const sel = campo === sugerido ? " selected" : "";
      opts += '<option value="' + escapeHtml(campo) + '"' + sel + ">" +
        escapeHtml(ETIQUETAS_CAMPOS[campo] || campo) + " (" + escapeHtml(campo) + ")</option>";
    });
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td><strong>" + escapeHtml(header) + "</strong></td>" +
      '<td><select class="form-select form-select-sm select-mapeo" data-header="' +
      escapeHtml(header) + '" data-idx="' + idx + '">' + opts + "</select></td>";
    tbody.appendChild(tr);
  });

  // Vista previa de las primeras 8 filas
  const tabla = document.getElementById("tabla-preview");
  let html = "<thead><tr>" + (data.headers || []).map(function (h) {
    return "<th>" + escapeHtml(h) + "</th>";
  }).join("") + "</tr></thead><tbody>";
  (data.previewRows || []).slice(0, 8).forEach(function (fila) {
    const celdas = Array.isArray(fila)
      ? fila
      : (data.headers || []).map(function (h) { return fila[h]; });
    html += "<tr>" + celdas.map(function (c) {
      return "<td>" + escapeHtml(c === null || c === undefined ? "" : c) + "</td>";
    }).join("") + "</tr>";
  });
  tabla.innerHTML = html + "</tbody>";

  Upload.modalMapeo.show();
}

/* ---------- Paso 3: POST /api/upload/confirm ---------- */

async function confirmarImportacion() {
  if (!Upload.session) return;
  const selects = document.querySelectorAll(".select-mapeo");

  // Mapeo confirmado en el mismo formato que suggestedMapping: {campoCanónico: columnaOriginal}
  const mapping = {};
  selects.forEach(function (sel) {
    const campo = sel.value;
    if (campo) mapping[campo] = sel.getAttribute("data-header");
  });
  if (Object.keys(mapping).length === 0) {
    mostrarToast("Asigna al menos un campo antes de importar.", "error");
    return;
  }

  const btn = document.getElementById("btn-mapeo-confirm");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Importando…';

  try {
    const resp = await apiFetch("/api/upload/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: Upload.session.sessionId,
        fileType: Upload.session.fileType,
        mapping: mapping
      })
    });
    Upload.modalMapeo.hide();
    mostrarToast("Archivo importado correctamente: " + formatoEntero(resp.inserted) + " filas insertadas.", "exito");
    Upload.session = null;
    limpiarSeleccionArchivo();
    if (typeof refrescarTrasUpload === "function") await refrescarTrasUpload();
  } catch (err) {
    mostrarToast("Error al importar: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-check2-circle"></i> Confirmar e importar';
  }
}

/* ---------- Eventos ---------- */

function initUpload() {
  const dropZone = document.getElementById("drop-zone");
  const inputFile = document.getElementById("upload-file");

  dropZone.addEventListener("click", function () { inputFile.click(); });
  inputFile.addEventListener("change", function () {
    if (inputFile.files && inputFile.files.length) seleccionarArchivo(inputFile.files[0]);
  });

  ["dragenter", "dragover"].forEach(function (evt) {
    dropZone.addEventListener(evt, function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      dropZone.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach(function (evt) {
    dropZone.addEventListener(evt, function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      dropZone.classList.remove("dragover");
    });
  });
  dropZone.addEventListener("drop", function (ev) {
    const files = ev.dataTransfer && ev.dataTransfer.files;
    if (files && files.length) seleccionarArchivo(files[0]);
  });

  document.getElementById("btn-upload-start").addEventListener("click", subirArchivo);
  document.getElementById("btn-mapeo-confirm").addEventListener("click", confirmarImportacion);
}
