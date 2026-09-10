import { google } from "googleapis";
import { DateTime } from "luxon";
import { getOAuthClient } from "./googleAuth.js";

const calendar = google.calendar({ version: "v3", auth: getOAuthClient() });
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "primary";
const TZ = process.env.TIMEZONE || "America/Argentina/Buenos_Aires";

// colorId nativos de Google Calendar
const PRIORIDAD_A_COLOR = { alta: "11", media: "5", baja: "10" };
const COLOR_A_EMOJI = { "11": "🔴", "5": "🟡", "10": "🟢" };
const COLOR_A_PRIORIDAD = { "11": "alta", "5": "media", "10": "baja" };

/**
 * Convierte una fecha/hora "naive" (sin offset, ej. "2026-09-05T10:00:00" o
 * "2026-09-05") a un ISO 8601 CON offset, interpretándola como hora de pared
 * en la zona horaria TZ. Esto es necesario porque `timeMin`/`timeMax` de la
 * API de Google Calendar exigen offset explícito (a diferencia de
 * `start.dateTime`/`end.dateTime`, que aceptan hora naive + un campo
 * `timeZone` aparte).
 */
function aISOConOffset(fechaHoraNaive) {
  const dt = DateTime.fromISO(fechaHoraNaive, { zone: TZ });
  if (!dt.isValid) {
    throw new Error(`Fecha/hora inválida: "${fechaHoraNaive}" (${dt.invalidExplanation})`);
  }
  return dt.toISO();
}

/**
 * Crea un evento. Usada por la tool `crear_evento`.
 * Devuelve un objeto plano (no la respuesta cruda de Google) para que Gemini
 * pueda leerlo fácil y confirmarle al usuario.
 *
 * Soporta dos modos:
 * - Evento con horario: `fecha_hora_inicio`/`fecha_hora_fin` en ISO 8601 con hora (ej. "2026-09-05T10:00:00").
 * - Evento de todo el día: se detecta automáticamente si `fecha_hora_inicio` es
 *   solo una fecha (sin "T"), o si se pasa `todo_el_dia: true` explícito.
 *   `fecha_hora_fin` (opcional, también solo fecha) es el ÚLTIMO día INCLUSIVE
 *   del evento — la función se encarga de convertirlo al `end.date` exclusivo
 *   que exige la API de Google Calendar.
 *
 * Antes de insertar, chequea solapamientos con eventos existentes. Si
 * encuentra alguno y no se pasó `forzar: true`, NO crea el evento y devuelve
 * `conflicto: true` con el detalle, para que el agente le pregunte al usuario
 * qué hacer en vez de agendar encima de algo que ya tenía.
 *
 * El chequeo de solapamiento (rangoChequeoInicio/rangoChequeoFin) siempre se
 * construye con offset explícito vía `aISOConOffset`, interpretando la fecha
 * dada como hora de pared en TZ — antes se mandaba tal cual a `timeMin`/
 * `timeMax`, que exigen offset, lo que producía errores 400 de Google o,
 * peor, un chequeo de conflicto corrido de zona horaria.
 */
export async function crearEvento({
  titulo,
  fecha_hora_inicio,
  fecha_hora_fin,
  prioridad = "media",
  todo_el_dia,
  forzar = false,
}) {
  if (!fecha_hora_inicio) {
    // Nunca se debe asumir "ahora" ni "en una hora" en silencio. Si falta el
    // dato, se corta acá con un error claro para que el agente le pregunte
    // la fecha/hora exacta al usuario en vez de agendar algo no pedido.
    throw new Error(
      "Falta fecha_hora_inicio: no se puede crear el evento sin una fecha y hora (o fecha, si es todo el día) explícitas."
    );
  }

  const esTodoElDia = todo_el_dia ?? !fecha_hora_inicio.includes("T");

  let start, end, rangoChequeoInicio, rangoChequeoFin;

  if (esTodoElDia) {
    const fechaInicio = fecha_hora_inicio.slice(0, 10);
    const fechaFinInclusive = (fecha_hora_fin || fecha_hora_inicio).slice(0, 10);
    const fechaFinExclusiva = sumarDias(fechaFinInclusive, 1); // Google exige end.date exclusivo

    start = { date: fechaInicio };
    end = { date: fechaFinExclusiva };
    rangoChequeoInicio = aISOConOffset(fechaInicio);
    rangoChequeoFin = aISOConOffset(fechaFinExclusiva);
  } else {
    const inicioDT = DateTime.fromISO(fecha_hora_inicio, { zone: TZ });
    if (!inicioDT.isValid) {
      throw new Error(`fecha_hora_inicio inválida: "${fecha_hora_inicio}" (${inicioDT.invalidExplanation})`);
    }
    // Si no vino fecha_hora_fin, asumimos 1 hora después, en la misma zona
    // horaria (naive, para que quede consistente con lo que espera `start.dateTime`).
    const finNaive = fecha_hora_fin || inicioDT.plus({ hours: 1 }).toISO({ includeOffset: false, suppressMilliseconds: true });

    start = { dateTime: fecha_hora_inicio, timeZone: TZ };
    end = { dateTime: finNaive, timeZone: TZ };
    rangoChequeoInicio = aISOConOffset(fecha_hora_inicio);
    rangoChequeoFin = aISOConOffset(finNaive);
  }

  if (!forzar) {
    const solapados = await buscarSolapamientos(rangoChequeoInicio, rangoChequeoFin);
    if (solapados.length > 0) {
      return {
        ok: false,
        conflicto: true,
        error: `Ya tenés ${solapados.length} evento(s) que se solapan con ese horario. Si igual querés agendarlo, confirmá y volvé a llamar la herramienta con forzar=true.`,
        eventosSolapados: solapados,
      };
    }
  }

  const { data } = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: {
      summary: titulo,
      start,
      end,
      colorId: PRIORIDAD_A_COLOR[prioridad] || PRIORIDAD_A_COLOR.media,
    },
  });

  return {
    ok: true,
    eventId: data.id,
    titulo: data.summary,
    inicio: data.start?.dateTime || data.start?.date,
    todoElDia: esTodoElDia,
    prioridad,
  };
}

/**
 * Devuelve los eventos existentes que se solapan con el rango [inicioISO, finISO).
 * `events.list` con timeMin/timeMax ya filtra por superposición real de intervalos
 * (start < timeMax AND end > timeMin), así que no hace falta reimplementar esa
 * lógica a mano — solo pedirle a Google exactamente ese rango.
 * `inicioISO`/`finISO` deben venir con offset de zona horaria explícito (ver
 * `aISOConOffset`); la API de Google rechaza timeMin/timeMax sin offset.
 */
async function buscarSolapamientos(inicioISO, finISO) {
  const { data } = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: inicioISO,
    timeMax: finISO,
    singleEvents: true,
    orderBy: "startTime",
  });

  return (data.items || []).map((ev) => ({
    eventId: ev.id,
    titulo: ev.summary,
    inicio: ev.start?.dateTime || ev.start?.date,
    fin: ev.end?.dateTime || ev.end?.date,
  }));
}

function sumarDias(fechaISO, dias) {
  const d = new Date(`${fechaISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/**
 * Lista eventos en un rango. `rango_o_fecha` acepta "hoy", "semana", "mes",
 * o una fecha ISO (YYYY-MM-DD) como punto de partida de un día completo.
 */
export async function listarEventos({ rango_o_fecha = "hoy" } = {}) {
  const { desde, hasta } = calcularRango(rango_o_fecha);

  const { data } = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: desde,
    timeMax: hasta,
    singleEvents: true,
    orderBy: "startTime",
  });

  const eventos = (data.items || []).map((ev) => ({
    eventId: ev.id,
    titulo: ev.summary,
    inicio: ev.start?.dateTime || ev.start?.date,
    fin: ev.end?.dateTime || ev.end?.date,
    prioridad: COLOR_A_PRIORIDAD[ev.colorId] || "media",
  }));

  return { ok: true, cantidad: eventos.length, eventos };
}

/**
 * Busca un evento por texto (título) dentro de los próximos 30 días.
 *
 * - Si se pasa `event_id`, borra ESE evento puntual sin volver a buscar (se
 *   usa cuando el usuario ya eligió entre varios candidatos ambiguos).
 * - Si no, busca por `criterio_busqueda`:
 *   - 0 resultados → error.
 *   - 1 resultado → lo borra directo (caso sin ambigüedad, igual que antes).
 *   - 2+ resultados → NO borra nada. Devuelve `ambiguo: true` con la lista de
 *     candidatos (título + horario + event_id) para que el agente le
 *     pregunte al usuario cuál quiere borrar, y vuelva a llamar a esta misma
 *     herramienta con el `event_id` elegido.
 *
 * Antes, ante ambigüedad, se borraba directamente el evento más próximo en
 * el tiempo sin preguntar — esto podía borrar el evento equivocado.
 */
export async function eliminarEvento({ criterio_busqueda, event_id } = {}) {
  if (event_id) {
    let evento;
    try {
      const { data } = await calendar.events.get({ calendarId: CALENDAR_ID, eventId: event_id });
      evento = data;
    } catch (err) {
      return { ok: false, error: `No encontré el evento (event_id="${event_id}"), puede que ya se haya borrado.` };
    }

    await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: event_id });
    return {
      ok: true,
      eliminado: { titulo: evento.summary, inicio: evento.start?.dateTime || evento.start?.date },
    };
  }

  if (!criterio_busqueda) {
    throw new Error("Falta criterio_busqueda o event_id para saber qué evento eliminar.");
  }

  const ahora = new Date();
  const en30dias = new Date(ahora.getTime() + 30 * 24 * 60 * 60 * 1000);

  const { data } = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: ahora.toISOString(),
    timeMax: en30dias.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    q: criterio_busqueda,
  });

  const candidatos = data.items || [];
  if (candidatos.length === 0) {
    return { ok: false, error: `No encontré ningún evento que coincida con "${criterio_busqueda}".` };
  }

  if (candidatos.length > 1) {
    return {
      ok: false,
      ambiguo: true,
      error: `Encontré ${candidatos.length} eventos que coinciden con "${criterio_busqueda}". Hay que preguntarle al usuario cuál quiere borrar antes de eliminar nada.`,
      candidatos: candidatos.map((ev) => ({
        event_id: ev.id,
        titulo: ev.summary,
        inicio: ev.start?.dateTime || ev.start?.date,
      })),
    };
  }

  const evento = candidatos[0];
  await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: evento.id });

  return {
    ok: true,
    eliminado: { titulo: evento.summary, inicio: evento.start?.dateTime || evento.start?.date },
  };
}

/** Formatea eventos con emoji de prioridad para mandarlos por WhatsApp (uso interno/legacy). */
export function formatearEventosParaWhatsapp(eventos) {
  if (!eventos.length) return "No tenés eventos programados. 🎉";
  return eventos
    .map((ev) => {
      const emoji = { alta: "🔴", media: "🟡", baja: "🟢" }[ev.prioridad] || "🟡";
      const hora = ev.inicio?.includes("T")
        ? new Date(ev.inicio).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })
        : "todo el día";
      return `${emoji} ${hora} - ${ev.titulo}`;
    })
    .join("\n");
}

/**
 * Calcula el rango [desde, hasta) para "hoy"/"semana"/"mes"/una fecha puntual,
 * siempre en la zona horaria TZ configurada (no la hora local del proceso,
 * que en un contenedor Docker suele ser UTC). Antes usaba `Date#setHours`,
 * que fija la hora en la zona del proceso: en un contenedor en UTC, "hoy"
 * terminaba corrido ~3hs respecto del día real en Argentina.
 */
function calcularRango(rango_o_fecha) {
  const ahora = DateTime.now().setZone(TZ);

  if (rango_o_fecha === "semana") {
    const desde = ahora.startOf("day");
    return { desde: desde.toISO(), hasta: desde.plus({ days: 7 }).toISO() };
  }
  if (rango_o_fecha === "mes") {
    const desde = ahora.startOf("day");
    return { desde: desde.toISO(), hasta: desde.plus({ days: 30 }).toISO() };
  }
  if (rango_o_fecha === "hoy" || !rango_o_fecha) {
    return { desde: ahora.startOf("day").toISO(), hasta: ahora.endOf("day").toISO() };
  }

  // fecha ISO puntual (YYYY-MM-DD): día completo de esa fecha, en TZ.
  const base = DateTime.fromISO(rango_o_fecha, { zone: TZ });
  if (!base.isValid) {
    throw new Error(`Fecha inválida: "${rango_o_fecha}" (${base.invalidExplanation})`);
  }
  return { desde: base.startOf("day").toISO(), hasta: base.endOf("day").toISO() };
}

/** Usado directamente por el scheduler para el chequeo de recordatorios próximos. */
export async function eventosEnProximosMinutos(minutos) {
  const ahora = new Date();
  const limite = new Date(ahora.getTime() + minutos * 60 * 1000);
  const { data } = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: ahora.toISOString(),
    timeMax: limite.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });
  return (data.items || []).map((ev) => ({
    eventId: ev.id,
    titulo: ev.summary,
    inicio: ev.start?.dateTime,
  }));
}
