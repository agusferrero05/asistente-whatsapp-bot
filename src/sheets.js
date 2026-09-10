import { google } from "googleapis";
import { getOAuthClient } from "./googleAuth.js";

const sheets = google.sheets({ version: "v4", auth: getOAuthClient() });
const SHEET_ID = process.env.GOOGLE_SHEET_ID;

// Pestañas esperadas en tu Google Sheet. Headers en fila 1:
// Gastos:  Fecha | Monto | Categoria | Concepto
// Deudas:  Fecha | Monto | Concepto  | Estado (pendiente/saldado)
// Cobros:  Fecha | Monto | Concepto  | Estado (pendiente/cobrado)
// Notas:   Fecha | Categoria | Item  | Estado (pendiente/completado/archivado)
const HOJAS = { gasto: "Gastos", deuda: "Deudas", cobro: "Cobros", nota: "Notas" };

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

/** Trae todas las filas de una pestaña (sin headers) con su número de fila real (1-indexed, incluye header). */
async function getRowsConIndice(hoja) {
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${hoja}!A2:D` });
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

export async function registrarGasto({ monto, categoria, concepto }) {
  const fecha = new Date().toISOString().slice(0, 10);
  await appendRow(HOJAS.gasto, [fecha, monto, categoria || "sin categoría", concepto || ""]);
  return { ok: true, fecha, monto, categoria: categoria || "sin categoría", concepto: concepto || "" };
}

/** Borra la última fila cargada en Gastos y devuelve qué se borró. */
export async function deshacerUltimoGasto() {
  const filas = await getRowsConIndice(HOJAS.gasto);
  if (filas.length === 0) return { ok: false, error: "No hay gastos registrados para deshacer." };

  const ultima = filas[filas.length - 1];
  await borrarFila(HOJAS.gasto, ultima.filaIndex);
  const [fecha, monto, categoria, concepto] = ultima.row;
  return { ok: true, eliminado: { fecha, monto, categoria, concepto } };
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

/** Suma los gastos del mes dado (YYYY-MM), para resúmenes. */
export async function totalGastosDelMes(mesISO) {
  const filas = await getRowsConIndice(HOJAS.gasto);
  return filas
    .filter(({ row }) => row[0]?.startsWith(mesISO))
    .reduce((acc, { row }) => acc + Number(row[1] || 0), 0);
}
