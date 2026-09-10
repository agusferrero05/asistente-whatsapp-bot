import { google } from "googleapis";
import http from "http";
import open from "open";
import "dotenv/config";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/spreadsheets",
];

export function getOAuthClient() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  if (process.env.GOOGLE_REFRESH_TOKEN) {
    client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  }
  return client;
}

// --- Ejecutar UNA SOLA VEZ con `npm run auth:google` para obtener el refresh_token ---
async function runOneTimeAuth() {
  const client = getOAuthClient();
  const authUrl = client.generateAuthUrl({ access_type: "offline", scope: SCOPES, prompt: "consent" });

  console.log("\nAbriendo el navegador para autorizar acceso a Calendar y Sheets...\n");
  open(authUrl);

  const server = http.createServer(async (req, res) => {
    if (!req.url.startsWith("/oauth2callback")) return;
    const code = new URL(req.url, "http://localhost").searchParams.get("code");
    const { tokens } = await client.getToken(code);
    res.end("Listo, ya podés cerrar esta pestaña y volver a la terminal.");
    server.close();

    console.log("\n✅ Copiá esta línea a tu archivo .env:\n");
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
  });

  server.listen(3000, () => console.log("Esperando autorización en http://localhost:3000 ..."));
}

if (process.argv[1]?.endsWith("googleAuth.js")) {
  runOneTimeAuth();
}
