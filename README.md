# Asistente de WhatsApp — Productividad y Finanzas (100% gratis)

Stack real, probado de punta a punta: **Node.js + Evolution API v2 (Baileys) + PostgreSQL + Groq (Whisper/Llama) + Google Calendar/Sheets**, todo corriendo en un **VPS Oracle Cloud Always Free**.

Este README refleja el procedimiento **final y corregido** — incluye los ajustes que hicieron falta en el camino (nombres de paquetes distintos en ARM64, Evolution API v2 exige Postgres, imágenes públicas no disponibles, etc.), para que si tenés que repetir esto desde cero no te choques con los mismos errores.

---

## 0. Resumen de costos

| Componente | Costo | Límite gratuito |
|---|---|---|
| Oracle Cloud VPS (Ampere A1) | $0 | 4 vCPU / 24GB RAM / 200GB disco, siempre (no es trial) |
| Evolution API (self-hosted, compilado localmente) | $0 | Sin límite, corre en tu propio VPS |
| PostgreSQL (self-hosted) | $0 | Corre en el mismo VPS, sin límite |
| Groq (Whisper + Llama) | $0 | Rate limits generosos en su free tier |
| Google Calendar API | $0 | 1,000,000 requests/día |
| Google Sheets API | $0 | 60 requests/min por usuario |

No hay tarjeta de crédito recurrente, no hay trial que expire (Oracle Free Tier es permanente).

---

## 1. Crear el VPS en Oracle Cloud Always Free

1. Creá una cuenta en [cloud.oracle.com](https://cloud.oracle.com) (pide tarjeta solo para verificar identidad, nunca cobra en el tier free).
2. **Menú → Compute → Instances → Create Instance**.
3. Shape: elegí **VM.Standard.A1.Flex** (ARM, Always Free) con 2-4 OCPU y 12-24GB RAM.
4. Imagen: **Ubuntu 22.04**.
5. Generá o descargá tu clave SSH (archivo `.key`, guardalo en una carpeta fija de tu PC — lo vas a usar en cada conexión).
6. En "Networking", asegurate de que tenga una IP pública. Anotala (ej. `203.0.113.10`).
7. **Abrir los puertos** — en la consola de Oracle: menú ☰ → **Networking → Virtual Cloud Networks** → tu VCN → **Security Lists → Default Security List** → **Add Ingress Rules**:
   - Source Type: `CIDR`
   - Source CIDR: `0.0.0.0/0`
   - IP Protocol: `TCP`
   - Source Port Range: **vacío** (dejarlo así — el tráfico entrante llega desde puertos aleatorios del cliente, no restrinjas esto)
   - Destination Port Range: `3000,8080`
   - Description: `Puertos Bot y Evolution API`

### Conectarse por SSH

⚠️ Los comandos `ssh`, `scp`, `docker`, etc. son de **Linux**. Si estás en Windows, se ejecutan **desde PowerShell** (no hay diferencia de sistema para esto), pero cualquier comando que empiece con `sudo` o `apt` solo funciona **una vez que estás conectado adentro del servidor** (verás que el prompt cambia de `PS C:\...>` a `ubuntu@nombre-instancia:~$`).

Desde tu PowerShell, parado en la carpeta donde está tu clave:
```powershell
ssh -i "tu-clave.key" ubuntu@TU_IP_PUBLICA
```
Si pregunta `Are you sure you want to continue connecting?`, escribí `yes`.

### Instalar Docker, Docker Compose, Git, nano y unzip

⚠️ **Corrección importante**: en Ubuntu 22.04 ARM64, el paquete se llama `docker-compose` (con guión, versión clásica 1.x), **no** `docker-compose-plugin` — ese paquete no existe en este repositorio y aborta toda la instalación si lo incluís en la misma línea. Además, la imagen "minimizada" de Oracle no trae `nano` ni `unzip` por defecto.

Ejecutá **de a un comando por vez** (evitá pegar varios comandos juntos separados por `&&` en una sola pegada — en algunas terminales de Windows eso corrompe caracteres):

```bash
sudo apt update
sudo apt install -y docker.io docker-compose git nano unzip
sudo usermod -aG docker ubuntu
newgrp docker
```

Verificá que quedó todo instalado:
```bash
docker --version
docker-compose --version
```

---

## 2. Configurar Groq (transcripción + intención)

1. Andá a [console.groq.com](https://console.groq.com) y creá una cuenta gratis.
2. **API Keys → Create API Key**. Copiá la key (`gsk_...`) y guardala en un bloc de notas — Groq no la vuelve a mostrar.

Modelos usados (ambos gratis en el free tier):
- `whisper-large-v3-turbo` para transcribir audio a texto.
- `openai/gpt-oss-120b` para extraer la intención en JSON (reemplazo recomendado por Groq tras la deprecación de `llama-3.3-70b-versatile` el 16/08/2026).

---

## 3. Configurar Google Cloud (Calendar + Sheets)

Usamos **OAuth2 de tu cuenta personal** (no Service Account), porque un Service Account no puede escribir directamente en tu Google Calendar/Sheets personal sin delegación de dominio (que requiere Google Workspace).

1. Andá a [console.cloud.google.com](https://console.cloud.google.com) y creá un proyecto nuevo (ej. `bot-whatsapp`).
2. **APIs & Services → Library**: activá **Google Calendar API** y **Google Sheets API**.
3. **Pantalla de consentimiento de OAuth** (ahora vive bajo "Google Auth Platform" en la consola nueva):
   - Tipo de usuario: **External**.
   - Completá nombre de la app y tu correo de contacto.
   - En la pestaña **Permisos/Scopes**: no toques nada, "Guardar y continuar".
   - En **Usuarios de prueba**: agregá tu propio Gmail (el mismo que usás en Calendar/Sheets). Esto es obligatorio — si no lo agregás acá, el login te va a rechazar más adelante con `403: access_denied`.
4. **Credenciales → Crear credenciales → ID de cliente de OAuth**:
   - Tipo de aplicación: **Aplicación web**.
   - **URIs de redireccionamiento autorizados** (⚠️ no lo pongas en "Orígenes de JavaScript", es un campo distinto y no acepta rutas): agregá exactamente
     ```
     http://localhost:3000/oauth2callback
     ```
   - Copiá el **Client ID** y el **Client Secret** a tu bloc de notas.
5. Creá una Google Sheet nueva con 3 pestañas: `Gastos`, `Deudas`, `Cobros`, con estos headers en la fila 1:
   - Gastos: `Fecha | Monto | Categoria | Concepto`
   - Deudas: `Fecha | Monto | Concepto | Estado`
   - Cobros: `Fecha | Monto | Concepto | Estado`
6. Copiá el ID de la hoja (la cadena entre `/d/` y `/edit` en la URL) a tu bloc de notas como `GOOGLE_SHEET_ID`.

### Obtener el `GOOGLE_REFRESH_TOKEN` (una sola vez, sin instalar nada en el VPS)

La forma más simple es el **Google OAuth 2.0 Playground** (no requiere Node.js local):

1. Entrá a [OAuth 2.0 Playground](https://developers.google.com/oauthplayground).
2. Ícono de engranaje ⚙️ (arriba a la derecha) → tildá **Use your own OAuth credentials** → pegá tu Client ID y Client Secret → **Close**.
3. En el panel izquierdo, campo **Input your own scopes**, pegá:
   ```
   https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/spreadsheets
   ```
4. **Authorize APIs** → iniciá sesión con tu Gmail (el mismo agregado como test user) → si sale "Google no verificó esta app", click en **Advanced → Go to [tu app] (unsafe)** → aceptá los permisos.
5. Ya en el Step 2 del Playground, click **Exchange authorization code for tokens**.
6. En el panel derecho vas a ver `"refresh_token": "1//0g..."` — copiá ese valor completo.

Guardá en tu bloc de notas el bloque completo de variables que vas a necesitar:
```
GROQ_API_KEY=gsk_...
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
GOOGLE_SHEET_ID=...
GOOGLE_REFRESH_TOKEN=1//...
```

---

## 3.bis Configurar Gemini (cerebro del agente)

A partir de esta versión, Gemini reemplaza al clasificador de Groq como motor de razonamiento e intención — Groq queda solo para transcribir audio con Whisper.

1. Andá a [aistudio.google.com/apikey](https://aistudio.google.com/apikey) con tu cuenta de Google.
2. **Create API Key** → elegí (o creá) un proyecto de Google Cloud → copiá la clave (`AIzaSy...`).
3. Guardala como `GEMINI_API_KEY` en tu bloc de notas. El modelo por defecto es `gemini-2.0-flash` — no hace falta tocar `GEMINI_MODEL` salvo que quieras probar otro.
4. En tu Google Sheet, agregá una **cuarta pestaña llamada `Notas`** con estos headers en la fila 1:
   - `Fecha | Categoria | Item | Estado`
   (⚠️ si esta pestaña no existe, `guardar_notas`/`consultar_notas`/etc. van a fallar con un error de rango inválido).

---

## 4. Configurar Evolution API v2 (WhatsApp)

Evolution API corre como contenedor Docker y expone:
- Un endpoint para generar el **QR de vinculación** (escaneás con tu WhatsApp, como WhatsApp Web).
- Un **webhook** que le pega a tu backend cada vez que llega un mensaje.

No necesitás cuenta de Meta ni número de prueba — usa tu WhatsApp normal vinculado como un dispositivo más.

⚠️ **Riesgo real**: al no ser la API oficial, Meta puede banear el número si detecta patrones de bot (mucho volumen, mensajes masivos). Para uso 100% personal el riesgo es bajo, pero no lo uses para mandar mensajes masivos a terceros.

### Dos correcciones clave de esta versión (aprendidas en el despliegue real)

**A. Evolution API v2 requiere PostgreSQL — ya no soporta almacenamiento "local".**
Si ves el error `Error: Database provider invalid.` en los logs, es por esto: hay que declarar un servicio de Postgres en `docker-compose.yml` y las variables `DATABASE_ENABLED=true`, `DATABASE_PROVIDER=postgresql`, `DATABASE_CONNECTION_URI=postgresql://usuario:pass@postgres:5432/db`. Ya está resuelto en el `docker-compose.yml` de este proyecto (sección 5).

**B. Los tags públicos de imagen (`atendai/evolution-api`, `evolutionapi/evolution-api:vX.X.X`, `ghcr.io/...`) pueden devolver `pull access denied`** aunque estén bien escritos — el proyecto mueve sus tags con frecuencia y a veces quedan huérfanos. La solución que **no depende de que un tag público esté vivo en este momento** es compilar la imagen vos mismo desde el código fuente, directamente en el VPS:

```bash
cd ~
git clone https://github.com/EvolutionAPI/evolution-api.git
cd evolution-api
docker build -t local/evolution-api:latest .
cd ~/whatsapp-bot
```
Esto tarda unos minutos (compila TypeScript y genera el cliente de Prisma) pero no depende de ningún registro externo. El `docker-compose.yml` de este proyecto ya está configurado para usar `local/evolution-api:latest`.

---

## 5. Desplegar todo en el VPS

### Transferir el proyecto

⚠️ **Corrección importante**: para archivos con contenido largo o sensible (`.env`, `docker-compose.yml`), **no los peguen a mano dentro de `nano` vía SSH** — en varias terminales (especialmente PowerShell) el pegado de bloques largos pierde o mezcla caracteres. La forma confiable es subir el archivo ya armado con `scp` desde tu PC.

En tu PC local, comprimí la carpeta del proyecto y subila:
```powershell
scp -i "tu-clave.key" "C:\ruta\a\whatsapp-bot.zip" ubuntu@TU_IP_PUBLICA:~/
```

En el VPS:
```bash
unzip whatsapp-bot.zip
cd whatsapp-bot
cp .env.example .env
```

Completá el `.env` **en tu PC local** con un editor de texto normal (Notepad, VS Code) con todas tus credenciales (Groq, Google, y una clave inventada para `EVOLUTION_API_KEY`, ej. `mi-clave-super-secreta-2026`, y tu número de WhatsApp en `MY_WHATSAPP_NUMBER` con código de país sin el `+`, ej. `5493493520446`), y subilo así, sobrescribiendo:
```powershell
scp -i "tu-clave.key" "C:\ruta\a\.env" ubuntu@TU_IP_PUBLICA:~/whatsapp-bot/.env
```

### El `docker-compose.yml` final (con Postgres)

Este es el archivo correcto y ya probado — subilo también por `scp` desde tu PC (mismo motivo que el `.env`):

```yaml
version: "3.8"

services:
  postgres:
    image: postgres:16-alpine
    container_name: evolution-postgres
    restart: always
    environment:
      - POSTGRES_USER=evolution
      - POSTGRES_PASSWORD=evolution
      - POSTGRES_DB=evolution
    volumes:
      - postgres_data:/var/lib/postgresql/data
    networks:
      - bot-network

  evolution-api:
    image: local/evolution-api:latest
    container_name: evolution-api
    restart: always
    depends_on:
      - postgres
    ports:
      - "8080:8080"
    environment:
      - AUTHENTICATION_API_KEY=${EVOLUTION_API_KEY}
      - DATABASE_ENABLED=true
      - DATABASE_PROVIDER=postgresql
      - DATABASE_CONNECTION_URI=postgresql://evolution:evolution@postgres:5432/evolution
      - DATABASE_SAVE_DATA_INSTANCE=true
      - DATABASE_SAVE_DATA_NEW_MESSAGE=true
      - DATABASE_SAVE_MESSAGE_UPDATE=true
      - DATABASE_SAVE_DATA_CONTACTS=true
      - DATABASE_SAVE_DATA_CHATS=true
      - CACHE_REDIS_ENABLED=false
      - CACHE_LOCAL_ENABLED=true
      - LOG_LEVEL=ERROR
    volumes:
      - evolution_instances:/evolution/instances
    networks:
      - bot-network

  bot:
    build: .
    container_name: whatsapp-bot
    restart: always
    depends_on:
      - evolution-api
    env_file:
      - .env
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
    networks:
      - bot-network

networks:
  bot-network:
    driver: bridge

volumes:
  evolution_instances:
  postgres_data:
```

### Levantar todo

```bash
cd ~/whatsapp-bot
docker-compose up -d --build
```
(Si ya compilaste `local/evolution-api:latest` como se indica en la sección 4, este comando descarga Postgres, usa la imagen local de Evolution API y compila el `bot` — no necesita internet para Evolution API).

Verificá que los tres contenedores estén arriba:
```bash
docker-compose ps
docker-compose logs --tail=30 evolution-api
```
Deberías ver `evolution-postgres`, `evolution-api` y `whatsapp-bot` en estado **Up**, y en los logs de `evolution-api` algo como `Deploying migrations for postgresql` seguido de que el servidor arranca — no el bucle de `Error: Database provider invalid.`.

### Vincular tu WhatsApp

1. Crear la instancia:
```bash
curl -X POST http://localhost:8080/instance/create \
  -H "apikey: TU_EVOLUTION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"instanceName": "mi-asistente", "integration": "WHATSAPP-BAILEYS", "qrcode": true}'
```
2. Pedir el código QR:
```bash
curl http://localhost:8080/instance/connect/mi-asistente \
  -H "apikey: TU_EVOLUTION_API_KEY"
```
3. Copiá el valor completo del campo `base64` (empieza con `data:image/png;base64,...`) y pegalo directo en la barra de direcciones de tu navegador (Chrome/Edge lo renderiza como imagen sin necesidad de ningún conversor externo).
4. En tu celular: WhatsApp → **Menú (⋮) → Dispositivos vinculados → Vincular un dispositivo** → escaneá esa imagen.

### Registrar el webhook

Ya se registra automáticamente al levantar `index.js`, pero podés forzarlo:
```bash
curl -X POST http://localhost:8080/webhook/set/mi-asistente \
  -H "apikey: TU_EVOLUTION_API_KEY" -H "Content-Type: application/json" \
  -d '{"webhook":{"url":"http://bot:3000/webhook","enabled":true,"events":["MESSAGES_UPSERT"]}}'
```

---

## 6. (Opcional pero recomendado) HTTPS con Caddy

Si más adelante querés exponer el bot con dominio propio y HTTPS gratis, agregá Caddy al `docker-compose.yml` — hace el certificado Let's Encrypt automáticamente sin configuración manual. Preguntame si querés que te arme ese bloque.

---

## 7. Probar el bot

Escribite a vos mismo (o mandá una nota de voz) desde WhatsApp diciendo algo como:

- **Texto**: "Recordame reunión con el banco mañana a las 10, es urgente"
- **Audio**: nota de voz diciendo "Gasté 5000 pesos en el supermercado hoy"
- **Consulta**: "¿Qué tengo agendado esta semana?"

El bot debería responder confirmando la acción tomada.

---

## 8. Estructura del proyecto

```
whatsapp-bot/
├── docker-compose.yml       # Postgres + Evolution API + backend
├── Dockerfile
├── .env.example
├── package.json
└── src/
    ├── index.js             # servidor Express, delega todo al agente de Gemini
    ├── whatsapp.js           # cliente de Evolution API (enviar/recibir)
    ├── transcription.js      # Groq Whisper (audio → texto, se le pasa a Gemini como texto normal)
    ├── geminiAgent.js         # cerebro: tools, prompt del sistema, bucle de function calling, historial
    ├── calendar.js             # Google Calendar (crear/listar/eliminar eventos con retornos estructurados)
    ├── sheets.js                # Google Sheets (Gastos/Deudas/Cobros/Notas, deshacer, saldar)
    ├── googleAuth.js             # OAuth2 setup + cliente reutilizable
    └── scheduler.js               # node-cron (resúmenes + recordatorios cada 5 min con antiduplicados)
```

## 8.bis Migración a Gemini: cómo desplegar este cambio en tu VPS

Ya tenés el proyecto corriendo — estos son los pasos exactos para actualizar el código existente sin volver a hacer todo desde cero:

1. Subí los archivos nuevos/modificados (`package.json`, `.env.example` como referencia, y toda la carpeta `src/`) a tu VPS reemplazando los actuales — igual que la primera vez, vía `scp`, nunca pegando a mano en `nano`.
2. Agregá las variables nuevas a tu `.env` real en el VPS (no al `.env.example`, que es solo la plantilla):
   ```bash
   cd ~/whatsapp-bot
   nano .env
   ```
   Agregá estas dos líneas (con tu clave real de Gemini):
   ```
   GEMINI_API_KEY=AIzaSy...
   GEMINI_MODEL=gemini-2.0-flash
   ```
   La variable `GROQ_LLM_MODEL` ya no se usa (Gemini reemplaza esa función) — podés dejarla o borrarla, no molesta si queda.
3. Agregá la pestaña **`Notas`** a tu Google Sheet (ver sección 3.bis) si todavía no lo hiciste.
4. Actualizá `CRON_CHEQUEO_EVENTOS` en tu `.env` a `*/5 * * * *` (antes era `0 * * * *`, cada hora) para que los recordatorios de "15 minutos antes" tengan sentido.
5. Reconstruí **solo el contenedor `bot`** con las nuevas dependencias (no hace falta tocar Evolution API ni Postgres):
   ```bash
   docker-compose build --no-cache bot
   docker-compose up -d
   ```
   (Usamos `up -d` con todos los servicios juntos, no `up -d bot` suelto, por el bug conocido de `docker-compose` 1.29 que vimos antes — ver tabla de errores en la sección 9).
6. Mirá los logs y probá:
   ```bash
   docker-compose logs -f bot
   ```
   Mandate un mensaje conversacional (ej. "¿qué me conviene comer si estoy corto de tiempo?") y uno de acción (ej. "anotame comprar leche y pan en la lista del súper") para confirmar que tanto el modo charla como el function calling están funcionando.

---

## 9. Errores ya resueltos durante el despliegue (referencia rápida)

| Síntoma | Causa | Solución |
|---|---|---|
| `El token '&&' no es un separador de instrucciones válido` | Se pegaron comandos Linux directo en PowerShell, sin haber entrado por SSH primero | Conectate con `ssh -i ...` antes de correr comandos `apt`/`docker` |
| `E: Unable to locate package docker-compose-plugin` | Ese paquete no existe en este repo ARM64 | Usar `docker.io docker-compose git nano unzip` (con guión, no "-plugin") |
| `-bash: nano: command not found` / `unzip: command not found` | La imagen Ubuntu minimizada de Oracle no los trae | `sudo apt install -y nano unzip` |
| `pull access denied for atendai/evolution-api` (o `evolutionapi/evolution-api`, o `ghcr.io/...`) | Esos tags públicos no están disponibles en este momento | Compilar localmente: `git clone` + `docker build -t local/evolution-api:latest .` (sección 4) |
| `Error: Database provider invalid.` en bucle de reinicio | Evolution API v2 requiere Postgres, no soporta modo "local" | Agregar servicio `postgres` + variables `DATABASE_*` al `docker-compose.yml` (sección 5) |
| El `.env` o `docker-compose.yml` quedan con texto cortado/mezclado tras pegarlo en `nano` | Pegado de bloques largos se corrompe en algunas terminales SSH | Armar el archivo completo en la PC local y subirlo con `scp`, nunca pegarlo a mano dentro de `nano` |
| `unknown shorthand flag: 'd' in -d` al correr `docker compose up -d` | Está instalada la versión clásica (`docker-compose`, con guión), no el plugin moderno | Usar `docker-compose up -d --build` (con guión) |
| El bot no responde nunca a ningún mensaje (sin error visible) | `MY_WHATSAPP_NUMBER` en `.env` no coincide exactamente con el `remoteJid` que manda Evolution API (ej. falta el `9` después del `54` para números argentinos) | Confirmar el número exacto mirando los logs de `evolution-api` (`remoteJid: '549...'`) y copiarlo tal cual a `.env` |
| `getaddrinfo EAI_AGAIN bot` / contenedor con nombre raro (`<hash>_whatsapp-bot`) tras `docker-compose up -d bot` | Bug conocido de `docker-compose` 1.29.x (`KeyError: 'ContainerConfig'`) al recrear un solo servicio suelto | Nunca levantar un servicio solo: `docker-compose down` completo y después `docker-compose up -d` con los tres juntos |
| `The model \`llama-3.3-70b-versatile\` does not exist` | Groq deprecó el modelo el 16/08/2026 | Cambiar `GROQ_LLM_MODEL` en `.env` a `openai/gpt-oss-120b` y reiniciar el `bot` |
| `Google Sheets API has not been used in project ... or it is disabled` (403) | La API de Sheets no se habilitó en el proyecto de Google Cloud (o se habilitó en otro proyecto) | Entrar al link que da el propio error y hacer clic en "Habilitar"; esperar 1-2 min y reintentar |

## 10. Próximos pasos sugeridos

- Agregar `modificar_evento` / `eliminar_evento` end-to-end (el módulo `calendar.js` ya tiene las funciones, falta mapear la intención en `index.js`).
- Guardar el `eventId` de Google Calendar junto al mensaje para poder decir "cancelá esa reunión" y que el bot sepa a cuál te referís.
- Agregar autenticación básica al endpoint `/webhook` (hoy solo filtra por tu número, pero conviene validar también un secreto compartido con Evolution API).
- Backup automático del `.env`, del volumen `evolution_instances` (sesión de WhatsApp) y del volumen `postgres_data`.
