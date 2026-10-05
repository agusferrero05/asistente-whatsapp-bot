# Asistente de WhatsApp — Agenda, Finanzas y Notas (100% gratis)

Bot personal que vive en tu WhatsApp (chat "Mensajes a mí mismo") y te deja manejar **Google Calendar**, **gastos/deudas/cobros en Google Sheets** y **listas de notas** escribiendo o mandando audios, en lenguaje natural.

Stack: **Node.js + Evolution API v2 (Baileys) + PostgreSQL + Gemini (razonamiento y function calling) + Groq Whisper (audio → texto) + Google Calendar/Sheets**, todo corriendo en un **VPS Oracle Cloud Always Free** con Docker.

---

## 1. Qué hace

| Área | Ejemplos de lo que se le puede decir |
|---|---|
| **Calendario** | "Agendame dentista el viernes a las 10, prioridad alta" · "¿Qué tengo esta semana?" · "Cancelá la reunión del banco" |
| **Gastos** | "Gasté 8500 en pádel" · "Pagué 2000 de pan en efectivo" · "Ayer gasté 15000 en la peluquería" · "Deshacé el último gasto" |
| **Consultas de gastos** | "¿Cuánto gasté este mes?" · "¿En qué gasté los últimos 3 días?" · "¿Cuánto gasté en agosto?" |
| **Deudas / cobros** | "Le debo 5000 a Juan por la cena" · "Juan ya me pagó" |
| **Notas** | "Anotame leche y pan en el súper" · "¿Qué tengo pendiente del súper?" · "Ya compré la leche" |
| **Audios** | Cualquier nota de voz se transcribe con Whisper y se procesa como texto |
| **Automático** | Resumen diario (8:00), resumen semanal (lunes 9:00) y aviso 15 minutos antes de cada evento |

Detalles que conviene saber:

- **Prioridades del calendario**: alta 🔴, media 🟡, baja 🟢 (colores nativos de Google Calendar).
- **Conflictos de horario**: antes de crear un evento se chequea si se solapa con otro; si hay choque, el bot pregunta antes de agendar igual.
- **Borrado de eventos**: si hay varios eventos que coinciden con el texto, el bot lista los candidatos y pregunta cuál borrar (nunca borra "el más cercano" sin preguntar).
- **Gastos**: se registra tipo de pago (Efectivo / Débito / Transferencia) y medio (Naranja X, Uala, Mercado Pago, Brubank, etc.). Si no aclarás nada, se asume **Débito / Naranja X**. Se puede cargar con fecha pasada ("el sábado pasado"); las fechas futuras se descartan y se usa hoy.
- **Consultas de gastos**: por período relativo a hoy (últimos N días/semanas/meses) o por mes calendario; devuelve total, desglose por categoría/tipo/medio de pago y el detalle de cada gasto.

---

## 2. Costos

| Componente | Costo | Límite gratuito |
|---|---|---|
| Oracle Cloud VPS (Ampere A1) | $0 | 4 vCPU / 24 GB RAM / 200 GB disco, siempre (no es trial) |
| Evolution API (self-hosted, compilada localmente) | $0 | Sin límite, corre en tu VPS |
| PostgreSQL (self-hosted) | $0 | Mismo VPS |
| Gemini API (Google AI Studio) | $0 | Cuota gratuita que **depende del modelo** (ver sección 9) |
| Groq (solo Whisper) | $0 | Rate limits generosos en el free tier |
| Google Calendar API | $0 | 1.000.000 requests/día |
| Google Sheets API | $0 | 60 requests/min por usuario |

---

## 3. Arquitectura y estructura del proyecto

```
WhatsApp ⇄ Evolution API (Baileys) ──webhook──▶ bot (Express) ──▶ Gemini (function calling)
                                                     │                    │
                                                     │ audio              ├─▶ Google Calendar
                                                     └─▶ Groq Whisper     └─▶ Google Sheets
```

Los tres contenedores (`evolution-postgres`, `evolution-api`, `whatsapp-bot`) hablan entre sí por la red interna de Docker (`http://evolution-api:8080`, `http://bot:3000/webhook`). **No hace falta exponer ningún puerto a internet** (ver sección 10).

```
.
├── docker-compose.yml     # Postgres + Evolution API + bot
├── Dockerfile             # imagen del bot (node:20-alpine)
├── .env.example           # plantilla de variables (sin secretos)
├── package.json
├── PRIVACY.md             # política de privacidad (la usa la pantalla de consentimiento de Google;
│                          #   NO mover ni renombrar sin actualizar esa URL en Google Cloud Console)
└── src/
    ├── index.js           # servidor Express + webhook; delega todo al agente
    ├── whatsapp.js        # cliente de Evolution API (enviar/recibir, descarte del eco del propio bot)
    ├── transcription.js   # Groq Whisper (audio → texto)
    ├── geminiAgent.js     # cerebro: prompt, tools, bucle de function calling, historial, control de cuota
    ├── calendar.js        # Google Calendar (zona horaria explícita con luxon)
    ├── sheets.js          # Google Sheets (Gastos/Deudas/Cobros/Notas)
    ├── googleAuth.js      # OAuth2 + script de obtención del refresh token
    └── scheduler.js       # node-cron: resúmenes y recordatorios
```

---

## 4. Instalación desde cero

### 4.1 VPS en Oracle Cloud Always Free

1. Cuenta en [cloud.oracle.com](https://cloud.oracle.com) (pide tarjeta solo para verificar identidad).
2. **Compute → Instances → Create Instance**, shape **VM.Standard.A1.Flex** (ARM, Always Free), 2–4 OCPU y 12–24 GB RAM, imagen **Ubuntu 22.04**.
3. Descargá la clave SSH (`.key`) y guardala en una carpeta fija de tu PC.
4. Asegurate de que la instancia tenga IP pública y anotala.

> ⚠️ **Puertos**: no hace falta abrir el 3000 ni el 8080 en la Security List. Todo funciona por la red interna de Docker, y el QR se pide con `curl` desde el propio VPS. Si igualmente querés acceder desde tu PC, limitá el *Source CIDR* a tu IP (`TU_IP/32`), nunca `0.0.0.0/0`. Ver sección 10.

### 4.2 Conectarse por SSH (desde PowerShell)

```powershell
ssh -i "tu-clave.key" ubuntu@TU_IP_PUBLICA
```

Los comandos `sudo`, `apt` y `docker` se ejecutan **adentro del servidor** (el prompt cambia a `ubuntu@...:~$`). Los `scp` se ejecutan **en tu PC**, nunca dentro del servidor.

### 4.3 Instalar Docker, Docker Compose, Git, nano y unzip

En Ubuntu 22.04 ARM64 el paquete es `docker-compose` (con guión, versión 1.x), **no** `docker-compose-plugin`. La imagen minimizada de Oracle no trae `nano` ni `unzip`. Ejecutá de a un comando:

```bash
sudo apt update
sudo apt install -y docker.io docker-compose git nano unzip
sudo usermod -aG docker ubuntu
newgrp docker
docker --version
docker-compose --version
```

### 4.4 Groq (solo transcripción de audio)

1. [console.groq.com](https://console.groq.com) → **API Keys → Create API Key** (`gsk_...`; no se vuelve a mostrar).
2. Modelo usado: `whisper-large-v3-turbo`.

### 4.5 Gemini (cerebro del agente)

1. [aistudio.google.com/apikey](https://aistudio.google.com/apikey) → **Create API Key** (`AIzaSy...`).
2. Se configura con `GEMINI_MODEL`. En producción se usa `gemini-3.5-flash-lite`. El valor por defecto en el código, si no se define, es `gemini-flash-latest`.
3. Requiere `@google/genai` **≥ 1.15** (las versiones 0.x fallan con modelos Gemini 3.x: `Function call is missing a thought_signature`).

### 4.6 Google Cloud (Calendar + Sheets)

Se usa **OAuth2 de tu cuenta personal** (no Service Account: no puede escribir en tu Calendar/Sheets personal sin delegación de dominio).

1. [console.cloud.google.com](https://console.cloud.google.com) → crear proyecto → **APIs & Services → Library**: habilitar **Google Calendar API** y **Google Sheets API** (en el **mismo** proyecto).
2. **Google Auth Platform / Pantalla de consentimiento**: tipo **External**, nombre de la app y correo de contacto. En *Branding* completá URL de la página principal y de la política de privacidad (se puede usar el `PRIVACY.md` de este repo) y agregá `github.com` como dominio autorizado.
3. **Publicá la app a "En producción".** Si queda en modo *Testing*, el refresh token **vence a los 7 días** y el bot empieza a fallar con `invalid_grant`.
4. **Credenciales → ID de cliente de OAuth → Aplicación web**. En *URIs de redireccionamiento autorizados* (no en "Orígenes de JavaScript") agregá exactamente `http://localhost:3000/oauth2callback`. Guardá el Client ID y el Client Secret.
5. Creá una Google Sheet con 4 pestañas y estos headers en la fila 1:

| Pestaña | Columnas |
|---|---|
| `Gastos` | `Fecha \| Monto \| Categoria \| Concepto \| Tipo de pago \| Medio de pago` |
| `Deudas` | `Fecha \| Monto \| Concepto \| Estado` |
| `Cobros` | `Fecha \| Monto \| Concepto \| Estado` |
| `Notas` | `Fecha \| Categoria \| Item \| Estado` |

   Si falta una pestaña, las herramientas fallan con error de rango inválido. El ID de la hoja es la cadena entre `/d/` y `/edit` de la URL.

6. **Refresh token** (una vez, sin instalar nada): [OAuth 2.0 Playground](https://developers.google.com/oauthplayground) → engranaje ⚙️ → *Use your own OAuth credentials* (Client ID/Secret) → en *Input your own scopes* pegá:
   `https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/spreadsheets` → **Authorize APIs** → **Exchange authorization code for tokens** → copiá el `refresh_token` (`1//0...`).

### 4.7 Evolution API v2 (WhatsApp)

Evolution API v2 **requiere PostgreSQL** (ya no soporta almacenamiento local) y los tags públicos de imagen a veces devuelven `pull access denied`. La solución que no depende de registros externos es compilar la imagen en el VPS:

```bash
cd ~
git clone https://github.com/EvolutionAPI/evolution-api.git
cd evolution-api
docker build -t local/evolution-api:latest .
```

El `docker-compose.yml` de este repo ya usa `local/evolution-api:latest`. Al no ser la API oficial de WhatsApp, Meta puede banear el número si detecta patrones de bot (mucho volumen, mensajes masivos); para uso personal el riesgo es bajo.

### 4.8 Subir el proyecto al VPS

No pegues archivos largos dentro de `nano` por SSH (en varias terminales el pegado corrompe caracteres). Armalos en tu PC y subilos con `scp` **desde PowerShell, en tu PC**:

```powershell
scp -i "tu-clave.key" "C:\ruta\a\whatsapp-bot.zip" ubuntu@TU_IP_PUBLICA:~/
```

En el VPS:

```bash
unzip whatsapp-bot.zip
cd whatsapp-bot
cp .env.example .env
```

Completá el `.env` **en tu PC** (ver sección 5) y subilo sobrescribiendo:

```powershell
scp -i "tu-clave.key" "C:\ruta\a\.env" ubuntu@TU_IP_PUBLICA:~/whatsapp-bot/.env
```

### 4.9 Levantar y vincular WhatsApp

```bash
cd ~/whatsapp-bot
docker-compose up -d --build
docker-compose ps
```

Deben figurar `evolution-postgres`, `evolution-api` y `whatsapp-bot` en estado **Up**. Después:

1. Crear la instancia (el bot también la crea solo al arrancar):

```bash
curl -X POST http://localhost:8080/instance/create \
  -H "apikey: TU_EVOLUTION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"instanceName": "mi-asistente", "integration": "WHATSAPP-BAILEYS", "qrcode": true}'
```

2. Pedir el QR:

```bash
curl http://localhost:8080/instance/connect/mi-asistente -H "apikey: TU_EVOLUTION_API_KEY"
```

3. Copiá el valor completo del campo `base64` (`data:image/png;base64,...`), pegalo en la barra de direcciones del navegador y escaneá la imagen desde WhatsApp → **Dispositivos vinculados → Vincular un dispositivo**.

El webhook se registra solo al arrancar el bot. Para forzarlo:

```bash
curl -X POST http://localhost:8080/webhook/set/mi-asistente \
  -H "apikey: TU_EVOLUTION_API_KEY" -H "Content-Type: application/json" \
  -d '{"webhook":{"url":"http://bot:3000/webhook","enabled":true,"events":["MESSAGES_UPSERT"]}}'
```

---

## 5. Variables de entorno (`.env`)

| Variable | Descripción |
|---|---|
| `EVOLUTION_API_URL` | `http://evolution-api:8080` (red interna de Docker) |
| `EVOLUTION_API_KEY` | Clave que protege Evolution API. **Larga y aleatoria; nunca el ejemplo de ningún README** |
| `EVOLUTION_INSTANCE_NAME` | Nombre de la instancia (ej. `mi-asistente`) |
| `MY_WHATSAPP_NUMBER` | Tu número con código de país, sin `+`. Para Argentina normalmente lleva `9` después del `54` (ej. `5493400000000`). Confirmalo mirando el `remoteJid` en los logs de `evolution-api` |
| `GEMINI_API_KEY` | Clave de Google AI Studio |
| `GEMINI_MODEL` | En producción: `gemini-3.5-flash-lite` |
| `GROQ_API_KEY` | Clave de Groq (solo Whisper) |
| `GROQ_WHISPER_MODEL` | `whisper-large-v3-turbo` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Credenciales OAuth |
| `GOOGLE_REDIRECT_URI` | `http://localhost:3000/oauth2callback` |
| `GOOGLE_REFRESH_TOKEN` | Ver 4.6 |
| `GOOGLE_CALENDAR_ID` | `primary` |
| `GOOGLE_SHEET_ID` | ID de la hoja |
| `CRON_RESUMEN_DIARIO` | `0 8 * * *` |
| `CRON_RESUMEN_SEMANAL` | `0 9 * * 1` |
| `CRON_CHEQUEO_EVENTOS` | `*/5 * * * *` |
| `TIMEZONE` | `America/Argentina/Buenos_Aires` |
| `PORT` | `3000` |

El `.env` real **nunca** se sube al repo (`.gitignore`). Tampoco notas con credenciales ni claves SSH.

---

## 6. Operación diaria — comandos

Desde **PowerShell en tu PC**, parado en la carpeta donde está tu clave. Reemplazá `tu-clave.key` y `TU_IP_PUBLICA`.

**Ver estado de los contenedores**
```powershell
ssh -i "tu-clave.key" ubuntu@TU_IP_PUBLICA "cd ~/whatsapp-bot && docker-compose ps"
```

**Iniciar todo** (si estaba detenido)
```powershell
ssh -i "tu-clave.key" ubuntu@TU_IP_PUBLICA "cd ~/whatsapp-bot && docker-compose up -d && docker-compose ps"
```

**Detener todo**
```powershell
ssh -i "tu-clave.key" ubuntu@TU_IP_PUBLICA "cd ~/whatsapp-bot && docker-compose down"
```

**Reiniciar solo el bot** (no recrea contenedores)
```powershell
ssh -i "tu-clave.key" ubuntu@TU_IP_PUBLICA "cd ~/whatsapp-bot && docker-compose restart bot"
```

**Reinicio completo** (si lo anterior no alcanza)
```powershell
ssh -i "tu-clave.key" ubuntu@TU_IP_PUBLICA "cd ~/whatsapp-bot && docker-compose down && docker-compose up -d && docker-compose ps"
```

**Logs del bot** (últimas 200 líneas / en vivo con `Ctrl+C` para salir)
```powershell
ssh -i "tu-clave.key" ubuntu@TU_IP_PUBLICA "cd ~/whatsapp-bot && docker-compose logs --tail=200 bot 2>&1"
ssh -i "tu-clave.key" ubuntu@TU_IP_PUBLICA "cd ~/whatsapp-bot && docker-compose logs -f bot"
```

**Logs de Evolution API** (sesión de WhatsApp, desconexiones, pedido de QR)
```powershell
ssh -i "tu-clave.key" ubuntu@TU_IP_PUBLICA "cd ~/whatsapp-bot && docker-compose logs --tail=50 evolution-api 2>&1"
```

**Guardar los logs en un archivo local antes de reiniciar** (para no perder la evidencia de un fallo)
```powershell
ssh -i "tu-clave.key" ubuntu@TU_IP_PUBLICA "cd ~/whatsapp-bot && docker-compose logs --tail=300 bot 2>&1" | Tee-Object -FilePath ".\log-bot-$(Get-Date -Format 'yyyyMMdd-HHmm').txt"
```

**Espacio en disco y memoria del servidor**
```powershell
ssh -i "tu-clave.key" ubuntu@TU_IP_PUBLICA "df -h / ; free -h ; docker system df"
```

**Reiniciar el servidor (VPS) completo**
```powershell
ssh -i "tu-clave.key" ubuntu@TU_IP_PUBLICA "sudo reboot"
```
Esperá 1–2 minutos y verificá con `docker-compose ps`. Los contenedores tienen `restart: always`, así que deberían volver solos. Si el VPS está apagado desde Oracle, iniciarlo en **Compute → Instances → Start**.

> ⚠️ **Nunca** levantes un servicio suelto con `docker-compose up -d bot`: el `docker-compose` 1.29 (el del repo de Ubuntu) puede fallar con `KeyError: 'ContainerConfig'` y dejar un contenedor con nombre raro. Para recrear: `down` completo y `up -d` con los tres servicios.

---

## 7. Actualizar el código (flujo recomendado)

1. Editá/copiá los archivos en `repo-final\src` (en tu PC).
2. Subí **solo los archivos cambiados** al VPS (en tu PC):
```powershell
scp -i "tu-clave.key" ".\repo-final\src\archivo.js" ubuntu@TU_IP_PUBLICA:~/whatsapp-bot/src/archivo.js
```
3. Reconstruí y reiniciá (si cambió `package.json`, usá `build --no-cache`):
```powershell
ssh -i "tu-clave.key" ubuntu@TU_IP_PUBLICA "cd ~/whatsapp-bot && docker-compose build bot && docker-compose down && docker-compose up -d && docker-compose logs --tail=20 bot"
```
4. Commit al repo (revisá `git status` antes: nunca debe aparecer `.env`):
```powershell
cd .\repo-final
git status
git add -A
git commit -m "Descripción del cambio"
git push
```

---

## 8. Errores conocidos y soluciones

| Síntoma | Causa | Solución |
|---|---|---|
| El bot responde `⚠️ Tuve un error procesando tu mensaje` | El webhook llegó pero falló el procesamiento (el contenedor está vivo) | Mirar `docker-compose logs --tail=200 bot` y buscar la causa en las filas siguientes |
| `400 ... function response turn comes immediately after a function call turn` en **todos** los mensajes, y reiniciar lo arregla | Historial de conversación inválido en memoria: el recorte por posición podía dejarlo empezando por una `functionResponse` huérfana y el array guardado quedaba corrupto hasta el reinicio. Aparecía tras ~10 mensajes con herramientas desde el último reinicio | **Corregido** en `geminiAgent.js` (recorte por turnos completos, historial sobre copia y reintento automático con historial limpio; deja el log `♻️ Historial inconsistente`). Si ves ese error, verificá que el VPS tenga la versión nueva: `grep -c esTurnoUsuarioDeTexto ~/whatsapp-bot/src/geminiAgent.js` debe dar un número > 0 |
| `invalid_grant: Token has been expired or revoked` | Refresh token vencido (app en *Testing*: vence a los 7 días) o revocado | Publicar la app a *En producción* y regenerar el token en el OAuth Playground; actualizar `GOOGLE_REFRESH_TOKEN` en el `.env` del VPS y hacer `down` + `up -d` |
| `Function call is missing a thought_signature` (400) | `@google/genai` 0.x con modelos Gemini 3.x | Usar `@google/genai` `^1.15.0` |
| `[Gemini 503] Demanda alta en Google. Reintentando...` | Sobrecarga momentánea de Gemini | Normal: se reintenta hasta 3 veces solo |
| `Se me acabó el cupo gratuito de IA por hoy` | El contador interno llegó a `LIMITE_POR_DIA` | Se reinicia a medianoche **hora del Pacífico** (≈ 04:00–05:00 hora Argentina). Los límites son constantes en `geminiAgent.js` y hay que ajustarlos al modelo configurado |
| `connect ECONNREFUSED ...:8080` y `Intento N/10 falló` al arrancar | El bot levanta antes que Evolution API | Normal si termina en `✅ Instancia y webhook de Evolution API listos` |
| El bot no responde nada (sin error) | `MY_WHATSAPP_NUMBER` no coincide con el `remoteJid` (ej. falta el `9` tras `54`), o la sesión de WhatsApp se cayó | Copiar el número exacto de los logs de `evolution-api`; si pide QR, volver a vincular |
| El bot se contesta a sí mismo / no procesa tus mensajes | Filtrar por `fromMe` no sirve en el chat "Mensajes a mí mismo" (todo viene con `fromMe:true`) | Ya resuelto: se descarta únicamente el eco por `id` de los mensajes que envió el propio bot |
| "¿Cuánto gasté?" dice que no hay datos | Sheets reformatea las fechas según el idioma de la planilla y la comparación de texto fallaba | Ya resuelto: se leen con `UNFORMATTED_VALUE` y se normalizan a `YYYY-MM-DD` |
| `Google Sheets API has not been used in project ... (403)` | API no habilitada en el proyecto correcto | Habilitarla desde el link del error y esperar 1–2 min |
| Error de rango inválido al usar notas/gastos | Falta una pestaña o columna en la hoja | Crear las pestañas/headers de la sección 4.6 |
| `pull access denied for ...evolution-api` | Tags públicos no disponibles | Compilar la imagen local (4.7) |
| `Error: Database provider invalid.` en bucle | Evolution API v2 sin Postgres | Usar el `docker-compose.yml` del repo (incluye Postgres) |
| `E: Unable to locate package docker-compose-plugin` | No existe en ARM64 | `sudo apt install -y docker.io docker-compose git nano unzip` |
| `El token '&&' no es un separador de instrucciones válido` | Comando de Linux pegado en PowerShell sin entrar por SSH | Conectarse primero, o usar `ssh ... "comando"` |
| `unknown shorthand flag: 'd' in -d` | Se usó `docker compose` (plugin moderno) | Usar `docker-compose` con guión |

---

## 9. Notas de diseño (para mantenimiento)

- **Historial de conversación**: vive en memoria, por número, últimas ~20 interacciones. Se pierde al reiniciar el bot (alcanza para uso personal). Se guarda solo si el turno terminó bien y siempre arranca en un mensaje de texto del usuario.
- **Cola por número**: dos mensajes seguidos del mismo número se procesan en orden, no en paralelo.
- **Cuota de Gemini**: contador propio en memoria (`LIMITE_POR_MINUTO`, `LIMITE_POR_DIA` en `geminiAgent.js`). Los límites reales del free tier dependen del modelo en `GEMINI_MODEL`; revisalos en la [documentación de rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) al cambiar de modelo. El contador se reinicia con el bot, así que no refleja la cuota real de Google si hubo reinicios.
- **Zona horaria**: `calendar.js` y `sheets.js` calculan rangos con `luxon` usando `TIMEZONE`, no la hora local del contenedor (UTC).
- **Fechas en Sheets**: se escriben como fecha real (se ven con el formato de la planilla) y se leen con `UNFORMATTED_VALUE`.
- **Recordatorios**: `scheduler.js` chequea cada 5 minutos y avisa eventos que empiezan en ≤ 15 minutos, una sola vez por evento.

---

## 10. Seguridad

- **Evolution API (8080) y el webhook del bot (3000) no necesitan estar expuestos a internet.** Dejalos cerrados en la Security List de Oracle, o limitados a tu IP. Quien llegue al 8080 con la `EVOLUTION_API_KEY` puede enviar mensajes desde tu número.
- El `/webhook` del bot no valida ningún secreto: solo ignora mensajes que no vengan de `MY_WHATSAPP_NUMBER`.
- `EVOLUTION_API_KEY`: usá un valor largo y aleatorio. **No pongas la clave real en ningún README ni ejemplo**: queda en el historial de git aunque después lo borres.
- Nunca subas al repo: `.env`, archivos con credenciales, claves SSH (`*.key`, `*.pub`).
- Si una credencial llegó a un lugar público, rotarla es la única mitigación real.

---

## 11. Pendientes sugeridos

- HTTPS con dominio propio (Caddy) si se quiere exponer algo.
- Validar un secreto compartido en `/webhook`.
- Backup periódico del `.env`, del volumen `evolution_instances` (sesión de WhatsApp) y de `postgres_data`.
- Persistir el historial de conversación fuera de memoria, si se necesitara continuidad entre reinicios.
- Rotación de log de Docker (los logs de los contenedores crecen sin límite por defecto).
