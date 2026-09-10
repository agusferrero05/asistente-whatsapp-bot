import Groq from "groq-sdk";
import fs from "fs";
import os from "os";
import path from "path";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/**
 * Transcribe un audio (base64, formato ogg/opus tal cual llega de WhatsApp)
 * usando Whisper alojado en Groq (gratuito, muy rápido).
 */
export async function transcribeAudio(base64Audio) {
  const tmpFile = path.join(os.tmpdir(), `audio-${Date.now()}.ogg`);
  fs.writeFileSync(tmpFile, Buffer.from(base64Audio, "base64"));

  try {
    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(tmpFile),
      model: process.env.GROQ_WHISPER_MODEL || "whisper-large-v3-turbo",
      language: "es",
      response_format: "text",
    });
    return typeof transcription === "string" ? transcription : transcription.text;
  } finally {
    fs.unlinkSync(tmpFile);
  }
}
