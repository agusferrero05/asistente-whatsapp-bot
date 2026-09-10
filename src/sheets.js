import { google } from "googleapis";
import { DateTime } from "luxon";
import { getOAuthClient } from "./googleAuth.js";

const sheets = google.sheets({ version: "v4", auth: getOAuthClient() });
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const TZ = process.env.TIMEZONE || "America/Argentina/Buenos_Aires";

// Pestañas esperadas en tu Google Sheet. Headers en fila 1:
// Gastos:  Fecha | Monto | Categoria | Concepto | Tipo de pago | Medio de pago
//          - Tipo de pago: Efectivo / Débito / Transferencia (default: Débito)
//          - Medio de pago: Naranja X, Uala, Mercado Pago, Brubank, etc.
//            (default: Naranja X cuando el tipo de pago es Débito o
//            Transferencia; vacío cuando es Efectivo)
// Deudas:  Fecha | Monto | Concepto  | Estado (pendiente/saldado)
// Cobros:  Fecha | Monto | Concepto  | Estado (pendiente/cobrado)
// Notas:   Fecha | Categoria | Item  | Estado (pendiente/completado/archivado)
//
// IMPORTANTE: si tu pestaña "Gastos" todavía no tiene las columnas E y F,
// agregá manualmente en la fila 1 los headers "Tipo de pago" (E1) y
// "Medio de pago" (F1) antes de usar esta versión.
const HOJAS = { gasto: "Gastos", deuda: "Deudas", cobro: "Cobros", nota: "Notas" };

// Tipos de pago válidos que puede mandar el agente, normalizados a un
// texto prolijo para la planilla.
const TIPOS_PAGO_VALIDOS = {
  efectivo: "Efectivo",
  debito: "Débito",
  débito: "Débito",
  transferencia: "Transferencia",
};
const TIPO_PAGO_DEFAULT = "Débito";
const MEDIO_PAGO_DEFAULT = "Naranja X";

let sheetIdCache = null; // { "Gastos": 0, "Deudas": 123456, ... }

/** Trae y cachea el mapeo nombre de pestaña -> sheetId numérico (necesario para borrar filas). */
async function getSheetIdMap() {
  if (sheetIdCache) return sheetIdCache;
  const { data } = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  sheetIdCache = {};
  for (const s of data.sheets) sheetIdCache[s.properties.title] = s.properties.sheetId;
  return sheetIdCache;
}

async function appendRow(hoja, values) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${hoja}!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [values] },
  });
}

/** Normaliza el valor crudo de una celda "Fecha" a YYYY-MM-DD. Google Sheets
 * reconoce el texto que escribimos como fecha real y la guarda como número
 * de serie (mostrándola con el formato regional de la planilla, ej.
 * DD/MM/YYYY) — eso está bien para que se vea prolijo, siempre que la
 * LEAMOS con valueRenderOption "UNFORMATTED_VALUE" (ver getRowsConIndice) y
 * la reconvirtamos acá a ISO para poder compararla. También soporta, por las
 * dudas, texto ISO directo o texto ya en DD/MM/YYYY. Nunca rompe: si no
 * reconoce el formato, devuelve el valor tal cual. */
function fechaCeldaAISO(valor) {
  if (valor === null || valor === undefined || valor === "") return "";

  if (typeof valor === "number") {
    // Serial de fecha de Sheets/Excel: días desde 1899-12-30.
    const ms = Math.round((valor - 25569) * 86400 * 1000);
    return new Date(ms).toISOString().slice(0, 10);
  }

  const str = String(valor).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);

  const match = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (match) {
    const [, d, m, y] = match;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  return str;
}

/** Trae todas las filas de una pestaña (sin headers) con su número de fila real (1-indexed, incluye header). */
async function getRowsConIndice(hoja) {
  // A2:F cubre de sobra tanto Gastos (6 columnas, con tipo/medio de pago)
  // como las pestañas más angostas (Deudas/Cobros/Notas, 4 columnas) — las
  // columnas E y F simplemente vienen vacías/undefined para esas otras.
  // UNFORMATTED_VALUE evita que Sheets nos devuelva números/fechas ya
  // formateados según el idioma de la planilla (rompía sumas y comparaciones
  // de fecha) — devuelve el valor "crudo" (número real, o serial de fecha).
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${hoja}!A2:F`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  return (data.values || []).map((row, i) => ({ filaIndex: i + 2, row })); // +2: fila 1 es header, A2 es index 0
}

async function borrarFila(hoja, filaIndex) {
  const sheetIdMap = await getSheetIdMap();
  const sheetId = sheetIdMap[hoja];
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: { sheetId, dimension: "ROWS", startIndex: filaIndex - 1, endIndex: filaIndex },
          },
        },
      ],
    },
  });
}

async function actualizarCelda(hoja, filaIndex, columnaLetra, valor) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${hoja}!${columnaLetra}${filaIndex}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[valor]] },
  });
}

// ---------------------------------------------------------------------------
// GASTOS
// ---------------------------------------------------------------------------

export async function registrarGasto({ monto, categoria, concepto, tipo_pago, medio_pago, fecha } = {}) {
  const hoyISO = DateTime.now().setZone(TZ).toISODate();
  // Si el agente manda una fecha pasada (ej. "el sábado pasado"), la
  // usamos — pero solo si es un YYYY-MM-DD válido y no es futura (para no
  // cargar un gasto en una fecha que todavía no pasó por un error del agente).
  const fechaFinal = /^\d{4}-\d{2}-\d{2}$/.test(fecha || "") && fecha <= hoyISO ? fecha : hoyISO;

  const tipoPagoNormalizado = TIPOS_PAGO_VALIDOS[(tipo_pago || "").trim().toLowerCase()] || TIPO_PAGO_DEFAULT;
  const esEfectivo = tipoPagoNormalizado === "Efectivo";
  const medioPagoFinal = esEfectivo ? "" : (medio_pago || "").trim() || MEDIO_PAGO_DEFAULT;

  await appendRow(HOJAS.gasto, [
    fechaFinal,
    monto,
    categoria || "sin categoría",
    concepto || "",
    tipoPagoNormalizado,
    medioPagoFinal,
  ]);

  return {
    ok: true,
    fecha: fechaFinal,
    monto,
    categoria: categoria || "sin categoría",
    concepto: concepto || "",
    tipo_pago: tipoPagoNormalizado,
    medio_pago: medioPagoFinal || null,
  };
}

/** Borra la última fila cargada en Gastos y devuelve qué se borró. */
export async function deshacerUltimoGasto() {
  const filas = await getRowsConIndice(HOJAS.gasto);
  if (filas.length === 0) return { ok: false, error: "No hay gastos registrados para deshacer." };

  const ultima = filas[filas.length - 1];
  await borrarFila(HOJAS.gasto, ultima.filaIndex);
  const [fecha, monto, categoria, concepto, tipo_pago, medio_pago] = ultima.row;
  return { ok: true, eliminado: { fecha: fechaCeldaAISO(fecha), monto, categoria, concepto, tipo_pago, medio_pago } };
}

// ---------------------------------------------------------------------------
// DEUDAS / COBROS
// ---------------------------------------------------------------------------

export async function registrarDeudaCobro({ tipo, monto, concepto }) {
  const hoja = tipo === "deuda" ? HOJAS.deuda : HOJAS.cobro;
  const fecha = new Date().toISOString().slice(0, 10);
  await appendRow(hoja, [fecha, monto, concepto || "", "pendiente"]);
  return { ok: true, tipo, fecha, monto, concepto: concepto || "" };
}

/** Busca la primera fila pendiente de Deudas/Cobros que matchee el concepto y la marca como saldada. */
export async function saldarCuenta({ tipo, concepto }) {
  const hoja = tipo === "deuda" ? HOJAS.deuda : HOJAS.cobro;
  const filas = await getRowsConIndice(hoja);

  const match = filas.find(
    ({ row }) => row[3] === "pendiente" && row[2]?.toLowerCase().includes((concepto || "").toLowerCase())
  );
  if (!match) {
    return { ok: false, error: `No encontré ${tipo === "deuda" ? "una deuda" : "un cobro"} pendiente que coincida con "${concepto}".` };
  }

  const nuevoEstado = tipo === "deuda" ? "saldado" : "cobrado";
  await actualizarCelda(hoja, match.filaIndex, "D", nuevoEstado);
  return { ok: true, tipo, concepto: match.row[2], monto: match.row[1], nuevoEstado };
}

// ---------------------------------------------------------------------------
// NOTAS / ANOTADOR
// ---------------------------------------------------------------------------

export async function guardarNotas({ items, categoria }) {
  const fecha = new Date().toISOString().slice(0, 10);
  for (const item of items) {
    await appendRow(HOJAS.nota, [fecha, categoria || "general", item, "pendiente"]);
  }
  return { ok: true, cantidad: items.length, categoria: categoria || "general" };
}

export async function consultarNotas({ categoria } = {}) {
  const filas = await getRowsConIndice(HOJAS.nota);
  const pendientes = filas
    .filter(({ row }) => row[3] === "pendiente" && (!categoria || row[1]?.toLowerCase() === categoria.toLowerCase()))
    .map(({ row }) => ({ categoria: row[1], item: row[2] }));
  return { ok: true, cantidad: pendientes.length, notas: pendientes };
}

/** Marca como completado el primer ítem pendiente que matchee el texto de búsqueda. */
export async function completarNota({ item_busqueda }) {
  const filas = await getRowsConIndice(HOJAS.nota);
  const match = filas.find(
    ({ row }) => row[3] === "pendiente" && row[2]?.toLowerCase().includes(item_busqueda.toLowerCase())
  );
  if (!match) return { ok: false, error: `No encontré ninguna nota pendiente que coincida con "${item_busqueda}".` };

  await actualizarCelda(HOJAS.nota, match.filaIndex, "D", "completado");
  return { ok: true, item: match.row[2] };
}

/** Archiva (no borra) todas las notas pendientes de una categoría, o todas si no se especifica. */
export async function limpiarNotas({ categoria } = {}) {
  const filas = await getRowsConIndice(HOJAS.nota);
  const objetivo = filas.filter(
    ({ row }) => row[3] === "pendiente" && (!categoria || row[1]?.toLowerCase() === categoria.toLowerCase())
  );
  for (const { filaIndex } of objetivo) {
    await actualizarCelda(HOJAS.nota, filaIndex, "D", "archivado");
  }
  return { ok: true, cantidad: objetivo.length, categoria: categoria || "todas" };
}

/**
 * Calcula el rango [desde, hasta] (YYYY-MM-DD, ambos inclusive) para un
 * período relativo a HOY (según TZ), tipo "últimos N días/semanas/meses".
 * "hasta" siempre es hoy. cantidad=1 significa el período más chico posible
 * de esa unidad (ej. unidad=dia, cantidad=1 → solo hoy).
 */
function rangoRelativo(unidad, cantidad) {
  const n = Math.max(1, Math.round(Number(cantidad) || 1));
  const hoy = DateTime.now().setZone(TZ).startOf("day");

  let inicio;
  if (unidad === "dia") inicio = hoy.minus({ days: n - 1 });
  else if (unidad === "semana") inicio = hoy.minus({ days: n * 7 - 1 });
  else if (unidad === "mes") inicio = hoy.minus({ months: n }).plus({ days: 1 });
  else inicio = hoy.startOf("month");

  return { desde: inicio.toISODate(), hasta: hoy.toISODate() };
}

/**
 * Consulta gastos en un período: relativo a hoy ("últimos N días/semanas/
 * meses", vía unidad+cantidad) o un mes calendario puntual (vía mes,
 * YYYY-MM). Sin parámetros, usa el mes calendario actual. Devuelve total,
 * cantidad, desglose por categoría/tipo de pago/medio de pago, y el detalle
 * (lista) de los gastos individuales encontrados en ese rango — pensado para
 * que el agente conteste tanto "¿cuánto gasté...?" como "¿qué gasté...?".
 */
export async function consultarGastos({ unidad, cantidad, mes } = {}) {
  let desde, hasta, periodo;

  if (unidad) {
    ({ desde, hasta } = rangoRelativo(unidad, cantidad));
    const n = Math.max(1, Math.round(Number(cantidad) || 1));
    periodo = `últimos ${n} ${unidad}(s)`;
  } else if (mes) {
    desde = `${mes}-01`;
    hasta = DateTime.fromISO(`${mes}-01`, { zone: TZ }).endOf("month").toISODate();
    periodo = mes;
  } else {
    const hoy = DateTime.now().setZone(TZ).startOf("day");
    desde = hoy.startOf("month").toISODate();
    hasta = hoy.toISODate();
    periodo = hoy.toFormat("yyyy-MM");
  }

  const filas = await getRowsConIndice(HOJAS.gasto);
  const enRango = filas
    .map(({ row }) => ({ ...rowAGasto(row) }))
    .filter((g) => g.fecha && g.fecha >= desde && g.fecha <= hasta);

  const acumular = (mapa, clave, monto) => {
    const k = (clave || "").trim() || "sin especificar";
    mapa[k] = (mapa[k] || 0) + monto;
  };

  let total = 0;
  const porCategoria = {};
  const porTipoPago = {};
  const porMedioPago = {};

  for (const g of enRango) {
    total += g.monto;
    acumular(porCategoria, g.categoria, g.monto);
    acumular(porTipoPago, g.tipo_pago, g.monto);
    if (g.tipo_pago && g.tipo_pago !== "Efectivo") acumular(porMedioPago, g.medio_pago, g.monto);
  }

  // Detalle ordenado del más viejo al más nuevo, para que quede prolijo en WhatsApp.
  enRango.sort((a, b) => a.fecha.localeCompare(b.fecha));

  return {
    ok: true,
    periodo,
    desde,
    hasta,
    total,
    cantidad_gastos: enRango.length,
    por_categoria: porCategoria,
    por_tipo_pago: porTipoPago,
    por_medio_pago: porMedioPago,
    detalle: enRango,
  };
}

function rowAGasto(row) {
  const [fechaRaw, montoStr, categoria, concepto, tipoPago, medioPago] = row;
  return {
    fecha: fechaCeldaAISO(fechaRaw),
    monto: Number(montoStr || 0),
    categoria: categoria || "sin categoría",
    concepto: concepto || "",
    tipo_pago: tipoPago || "",
    medio_pago: medioPago || "",
  };
}
