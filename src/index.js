import "dotenv/config";
import express from "express";
import { parseIncoming, downloadMedia, sendText, ensureInstance, setWebhook } from "./whatsapp.js";
import { transcribeAudio } from "./transcription.js";
import { procesarMensajeConAgente } from "./geminiAgent.js";
import { iniciarScheduler } from "./scheduler.js";

const app = express();
app.use(express.json({ limit: "20mb" }));

const MI_NUMERO = process.env.MY_WHATSAPP_NUMBER;

// --- Webhook: acá llegan todos los mensajes entrantes desde Evolution API ---
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // responder rápido, procesar en background

  try {
    const msg = parseIncoming(req.body);
    if (!msg || !msg.from) return;
    if (msg.from !== MI_NUMERO) return; // solo procesamos mensajes tuyos (uso personal)

    let texto = msg.text;

    if (msg.isAudio) {
      const base64 = await downloadMedia(msg.key);
      texto = await transcribeAudio(base64);
      console.log("🎙️ Transcripción:", texto);
    }

    if (!texto) return;

    const respuesta = await procesarMensajeConAgente(msg.from, texto);
    await sendText(MI_NUMERO, respuesta);
  } catch (err) {
    console.error("Error procesando webhook:", err);
    await sendText(MI_NUMERO, "⚠️ Tuve un error procesando tu mensaje. Revisá los logs.");
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;

/** Reintenta una función varias veces con espera entre intentos (Evolution API puede tardar en levantar). */
async function conReintentos(fn, intentos = 10, esperaMs = 3000) {
  for (let i = 1; i <= intentos; i++) {
    try {
      return await fn();
    } catch (err) {
      console.log(`Intento ${i}/${intentos} falló (${err.message}), reintentando en ${esperaMs / 1000}s...`);
      if (i === intentos) throw err;
      await new Promise((r) => setTimeout(r, esperaMs));
    }
  }
}

app.listen(PORT, async () => {
  console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
  try {
    await conReintentos(() => ensureInstance());
    await conReintentos(() => setWebhook("http://bot:3000/webhook"));
    console.log("✅ Instancia y webhook de Evolution API listos.");
  } catch (err) {
    console.error("⚠️ No se pudo inicializar Evolution API tras varios intentos:", err.message);
  }
  iniciarScheduler();
});
