import cron from "node-cron";
import { listarEventos, formatearEventosParaWhatsapp, eventosEnProximosMinutos } from "./calendar.js";
import { sendText } from "./whatsapp.js";

const MI_NUMERO = process.env.MY_WHATSAPP_NUMBER;

// Cache anti-duplicados: eventId -> timestamp en que se avisó. Un evento no
// se vuelve a avisar aunque el cron corra de nuevo antes de que empiece.
const yaAvisados = new Map();
const TTL_AVISO_MS = 60 * 60 * 1000; // 1 hora: pasado ese tiempo se limpia la entrada

function limpiarAvisosVencidos() {
  const ahora = Date.now();
  for (const [eventId, timestamp] of yaAvisados) {
    if (ahora - timestamp > TTL_AVISO_MS) yaAvisados.delete(eventId);
  }
}

function inicioYFinDeHoy() {
  const hoy = new Date();
  const desde = new Date(hoy.setHours(0, 0, 0, 0)).toISOString();
  const hasta = new Date(hoy.setHours(23, 59, 59, 999)).toISOString();
  return { desde, hasta };
}

function inicioYFinDeSemana() {
  const hoy = new Date();
  const desde = new Date(hoy.setHours(0, 0, 0, 0)).toISOString();
  const hasta = new Date(hoy.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  return { desde, hasta };
}

export function iniciarScheduler() {
  const tz = process.env.TIMEZONE;

  // Resumen diario.
  cron.schedule(
    process.env.CRON_RESUMEN_DIARIO || "0 8 * * *",
    async () => {
      const { desde, hasta } = inicioYFinDeHoy();
      const { eventos } = await listarEventos({ rango_o_fecha: "hoy" });
      const texto = `📅 *Resumen del día*\n\n${formatearEventosParaWhatsapp(eventos)}`;
      await sendText(MI_NUMERO, texto);
    },
    { timezone: tz }
  );

  // Resumen semanal.
  cron.schedule(
    process.env.CRON_RESUMEN_SEMANAL || "0 9 * * 1",
    async () => {
      const { eventos } = await listarEventos({ rango_o_fecha: "semana" });
      const texto = `🗓️ *Resumen de la semana*\n\n${formatearEventosParaWhatsapp(eventos)}`;
      await sendText(MI_NUMERO, texto);
    },
    { timezone: tz }
  );

  // Chequeo cada 5 min: avisa eventos que arrancan en los próximos 15 min,
  // una sola vez por evento (deduplicado por eventId).
  cron.schedule(
    process.env.CRON_CHEQUEO_EVENTOS || "*/5 * * * *",
    async () => {
      limpiarAvisosVencidos();
      const proximos = await eventosEnProximosMinutos(15);

      for (const ev of proximos) {
        if (yaAvisados.has(ev.eventId)) continue;

        const hora = new Date(ev.inicio).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
        await sendText(MI_NUMERO, `⏰ *Recordatorio:* En 15 minutos empieza *${ev.titulo}* (${hora})`);
        yaAvisados.set(ev.eventId, Date.now());
      }
    },
    { timezone: tz }
  );

  console.log("⏰ Scheduler iniciado (resumen diario, semanal y chequeo de recordatorios cada 5 min).");
}
