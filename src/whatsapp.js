import axios from "axios";

const API_URL = process.env.EVOLUTION_API_URL;
const API_KEY = process.env.EVOLUTION_API_KEY;
const INSTANCE = process.env.EVOLUTION_INSTANCE_NAME;

const client = axios.create({
  baseURL: API_URL,
  headers: { apikey: API_KEY, "Content-Type": "application/json" },
});

// IDs de mensajes que mandó el propio bot, para no reprocesarlos si Evolution
// API los vuelve a mandar por webhook (eco). No usamos `fromMe` para esto:
// como el bot le escribe al mismo número que lo conecta (chat "Mensajes a mí
// mismo"), TODOS los mensajes de ese chat vienen con fromMe:true — tanto los
// que escribís vos desde el celu como los que manda el bot — así que fromMe
// no sirve para distinguir uno de otro acá.
const idsEnviadosPorBot = new Set();
const TTL_ID_MS = 5 * 60 * 1000; // 5 minutos alcanza de sobra para ver el eco

function recordarIdEnviado(id) {
  if (!id) return;
  idsEnviadosPorBot.add(id);
  setTimeout(() => idsEnviadosPorBot.delete(id), TTL_ID_MS).unref?.();
}

/** Crea (si no existe) e inicia la instancia de WhatsApp. Devuelve el QR para vincular. */
export async function ensureInstance() {
  try {
    await client.post("/instance/create", {
      instanceName: INSTANCE,
      qrcode: true,
      integration: "WHATSAPP-BAILEYS",
    });
  } catch (err) {
    // Si ya existe, seguimos: no es un error real.
    if (err.response?.status !== 403) console.warn("instance/create:", err.response?.data || err.message);
  }
}

/** Registra la URL de webhook donde Evolution API va a mandar los mensajes entrantes. */
export async function setWebhook(webhookUrl) {
  await client.post(`/webhook/set/${INSTANCE}`, {
    webhook: { url: webhookUrl, enabled: true, events: ["MESSAGES_UPSERT"] },
  });
}

/** Envía un mensaje de texto simple. */
export async function sendText(numberE164, text) {
  const { data } = await client.post(`/message/sendText/${INSTANCE}`, {
    number: numberE164,
    text,
  });
  recordarIdEnviado(data?.key?.id);
  return data;
}

/** Descarga el audio de una nota de voz recibida (base64) para transcribirlo. */
export async function downloadMedia(messageKey) {
  const { data } = await client.post(`/chat/getBase64FromMediaMessage/${INSTANCE}`, {
    message: { key: messageKey },
    convertToMp4: false,
  });
  return data.base64; // string base64 del audio (ogg/opus)
}

/** Extrae texto/tipo de un payload entrante estándar de Evolution API. */
export function parseIncoming(body) {
  const msg = body?.data;
  if (!msg) return null;

  // Ignoramos únicamente el eco de un mensaje que mandó el propio bot (ver
  // recordarIdEnviado más arriba). Todo lo demás se procesa normalmente,
  // incluidos tus propios mensajes (que también vienen con fromMe:true).
  if (msg.key?.id && idsEnviadosPorBot.has(msg.key.id)) {
    console.log("🔁 Ignorando eco del propio bot:", msg.key.id);
    return null;
  }

  const from = msg.key?.remoteJid?.replace("@s.whatsapp.net", "");
  const isAudio = !!msg.message?.audioMessage;
  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    null;

  return { from, isAudio, text, key: msg.key };
}
