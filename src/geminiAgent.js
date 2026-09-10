import { GoogleGenAI } from "@google/genai";
import * as calendarTools from "./calendar.js";
import * as sheetsTools from "./sheets.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const TZ = process.env.TIMEZONE || "America/Argentina/Buenos_Aires";

const MAX_TOOL_ITERATIONS = 6;
const MAX_TURNOS_HISTORIAL = 20;

const historiales = new Map();

// --- Control de cuota gratuita de Gemini ---
// Estos límites son un tope propio para no rozar el free tier real, que
// depende del MODELO configurado en GEMINI_MODEL (no siempre es el mismo
// modelo con el que se armaron originalmente estos números). Antes de tocar
// el modelo, conviene revisar los límites vigentes en
// https://ai.google.dev/gemini-api/docs/rate-limits y ajustar estas dos
// constantes a ese modelo puntual, dejando un margen chico (no usar el
// límite exacto).
const LIMITE_POR_MINUTO = 13;
const LIMITE_POR_DIA = 480;
const llamadasUltimoMinuto = [];
let diaActual = null;
let llamadasHoy = 0;

class CuotaDiariaError extends Error {}

// Google resetea el cupo diario (RPD) a medianoche hora Pacífico (EE.UU.), no en
// la zona horaria del usuario. Por eso este contador usa America/Los_Angeles y
// no la constante TZ (que sigue usándose para las fechas que ve el usuario).
const TZ_CUPO = "America/Los_Angeles";

function fechaHoyTZ() {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ_CUPO }); // YYYY-MM-DD
}

async function esperarCupo() {
  const hoy = fechaHoyTZ();
  if (diaActual !== hoy) {
    diaActual = hoy;
    llamadasHoy = 0;
  }
  if (llamadasHoy >= LIMITE_POR_DIA) {
    throw new CuotaDiariaError("Cupo diario de IA agotado.");
  }

  const ahora = Date.now();
  while (llamadasUltimoMinuto.length && ahora - llamadasUltimoMinuto[0] > 60000) {
    llamadasUltimoMinuto.shift();
  }
  if (llamadasUltimoMinuto.length >= LIMITE_POR_MINUTO) {
    const esperar = 60000 - (ahora - llamadasUltimoMinuto[0]) + 250;
    console.log(`⏳ Cupo por minuto lleno, esperando ${Math.ceil(esperar / 1000)}s...`);
    await new Promise((res) => setTimeout(res, esperar));
    return esperarCupo();
  }

  llamadasUltimoMinuto.push(Date.now());
  llamadasHoy++;
}

function systemInstruction() {
  const ahora = new Date().toLocaleString("es-AR", {
    timeZone: TZ,
    dateStyle: "full",
    timeStyle: "short",
  });

  return `Sos un asistente personal de productividad y finanzas que habla por WhatsApp con tu usuario, en español rioplatense, tono cercano y directo.

Fecha y hora actual: ${ahora} (zona horaria ${TZ}). Usala como referencia para interpretar "hoy", "mañana", "en una hora", etc., y para construir fechas ISO 8601 con esa zona horaria.

Reglas operativas obligatorias:
1. Calendario:
   - Para agendar, llamá a crear_evento. Si el usuario no especificó la fecha o la hora, PREGUNTALE antes de asumir un horario arbitrario.
   - Si crear_evento devuelve { conflicto: true }, informale con qué evento choca y a qué hora, y preguntale si quiere reprogramar o forzar el turno. NUNCA envíes forzar: true sin que el usuario te lo confirme de forma explícita.
   - Para eventos de día completo (cumpleaños, feriados), pasá la fecha en formato YYYY-MM-DD en fecha_hora_inicio.
   - Para listar eventos, usá listar_eventos.
   - Para eliminar un evento, usá eliminar_evento con criterio_busqueda. Si la herramienta devuelve { ambiguo: true, candidatos: [...] }, NO seguiste eliminando nada todavía: mostrale al usuario los candidatos (título y horario de cada uno) y preguntale cuál quiere borrar. Una vez que el usuario elige, volvé a llamar a eliminar_evento pasando el event_id de ese candidato. Nunca asumas cuál de varios candidatos es "el correcto" sin preguntar.

2. Finanzas (Sheets):
   - Registrar gastos: usá registrar_gasto con monto, categoría y concepto. Además, fijate si el usuario menciona CÓMO pagó:
     * tipo_pago: "efectivo", "debito" o "transferencia", según lo que diga (ej. "pagué en efectivo" → efectivo; "con la tarjeta", "débito" → debito; "transferí", "por transferencia" → transferencia).
     * medio_pago: el nombre de la cuenta/tarjeta virtual si lo menciona (ej. Naranja X, Uala, Mercado Pago, Brubank, Personal Pay, etc.), solo aplica cuando el pago es débito o transferencia.
     Si el usuario NO aclara el tipo de pago, NO se lo preguntes ni asumas nada vos: simplemente no incluyas tipo_pago ni medio_pago en la llamada — el sistema ya aplica el default (débito en Naranja X) automáticamente. Si dice "efectivo" y nada más, mandá solo tipo_pago: "efectivo" sin medio_pago.
     Si el usuario aclara que el gasto fue en otro momento (no hoy) — "ayer", "anteayer", "el sábado pasado", "el 5 de septiembre", "hace 3 días", etc. — calculá la fecha real en formato YYYY-MM-DD usando la fecha de hoy que tenés arriba como referencia, y pasala en el parámetro fecha. Si no dice nada sobre cuándo fue, no incluyas fecha (se usa la de hoy automáticamente). Nunca calcules una fecha futura para un gasto.
   - Deshacer gastos erróneos: si el usuario pide anular, deshacer o borrar el último gasto, usá deshacer_ultimo_gasto.
   - Consultar gastos: usá consultar_gastos para CUALQUIER pregunta sobre gastos pasados (cuánto, en qué, cuándo, con qué medio de pago, etc.). SIEMPRE se calcula en base a la fecha de HOY (la de este mensaje), nunca años anteriores salvo que el usuario los mencione.
     * Si el usuario pide un período relativo — "último día", "últimos 3 días", "esta semana"/"última semana", "últimas 2 semanas", "último mes", "últimos 2 meses", etc. — pasá unidad ("dia", "semana" o "mes") y cantidad (el número; si dice "último/a X" sin número, cantidad es 1). La herramienta ya calcula el rango correcto contando hacia atrás desde hoy — vos solo interpretás cuántas unidades pidió.
     * Si el usuario menciona un mes calendario por nombre ("en agosto", "en julio"), pasá mes en formato YYYY-MM en vez de unidad/cantidad.
     * Si no da ninguna referencia temporal (pregunta genérica "¿cuánto gasté?"), no pases nada: usa el mes calendario actual por defecto.
     La herramienta devuelve el rango de fechas usado (desde/hasta), el total, la cantidad de gastos, desgloses por categoría/tipo de pago/medio de pago, y detalle: la lista de cada gasto individual (fecha, monto, categoría, concepto, tipo_pago, medio_pago) encontrado en ese rango, ordenados del más viejo al más nuevo. Si preguntan "cuánto" respondé con el total (y el desglose puntual que corresponda, ej. por_tipo_pago.Efectivo si preguntan por efectivo); si preguntan "qué gasté" o piden el detalle, listá los ítems de detalle de forma breve para WhatsApp.
   - Deudas y Cobros: 'deuda' es lo que el usuario debe a otros; 'cobro' es lo que le deben al usuario. Para asentar usá registrar_deuda_cobro. Cuando se salde, usá saldar_cuenta.

3. Anotador / Notas:
   - Para listas del súper, compras, pendientes o tareas rápidas, usá guardar_notas, consultar_notas, completar_nota o limpiar_notas.

4. Respuestas generales:
   - Si el usuario te hace consultas abiertas, dudas o charla cotidiana, respondé con naturalidad sin invocar herramientas.
   - Respuestas concisas y directas para WhatsApp, con emojis justos.`;
}

const toolDeclarations = [
  {
    name: "crear_evento",
    description: "Agenda un nuevo evento o recordatorio en Google Calendar.",
    parameters: {
      type: "OBJECT",
      properties: {
        titulo: { type: "STRING", description: "Título descriptivo del evento." },
        fecha_hora_inicio: {
          type: "STRING",
          description: "Fecha y hora de inicio en formato ISO 8601 con huso horario o YYYY-MM-DD si es todo el día.",
        },
        fecha_hora_fin: {
          type: "STRING",
          description: "Fecha y hora de finalización en ISO 8601 (opcional).",
        },
        prioridad: {
          type: "STRING",
          description: "Prioridad: alta, media o baja.",
          enum: ["alta", "media", "baja"],
        },
        forzar: {
          type: "BOOLEAN",
          description: "Solo true si el usuario confirmó explícitamente forzar la creación ante un conflicto previo.",
        },
      },
      required: ["titulo", "fecha_hora_inicio"],
    },
  },
  {
    name: "listar_eventos",
    description: "Consulta eventos agendados en Google Calendar.",
    parameters: {
      type: "OBJECT",
      properties: {
        rango_o_fecha: {
          type: "STRING",
          description: "Rango a consultar: 'hoy', 'semana', 'mes', o fecha ISO (YYYY-MM-DD).",
        },
      },
    },
  },
  {
    name: "eliminar_evento",
    description:
      "Busca un evento por título y lo elimina de Google Calendar. Si hay más de un evento que coincide con criterio_busqueda, la herramienta NO borra nada: devuelve ambiguo:true y una lista candidatos:[{event_id, titulo, inicio}] para que se le pregunte al usuario cuál quiere borrar. Una vez que el usuario elige, hay que volver a llamar a esta misma herramienta pasando ese event_id (y sin criterio_busqueda).",
    parameters: {
      type: "OBJECT",
      properties: {
        criterio_busqueda: {
          type: "STRING",
          description: "Título o palabra clave del evento a eliminar. No hace falta si ya se tiene event_id.",
        },
        event_id: {
          type: "STRING",
          description:
            "Id puntual del evento a borrar (viene de candidatos[].event_id de una llamada anterior que devolvió ambiguo:true). Usalo SOLO después de que el usuario eligió entre varios candidatos; si se pasa, se ignora criterio_busqueda.",
        },
      },
    },
  },
  {
    name: "registrar_gasto",
    description:
      "Registra un gasto en Google Sheets, incluyendo cómo se pagó. Si el usuario no aclara tipo_pago ni medio_pago, no los incluyas: el sistema aplica el default (débito en Naranja X) automáticamente, no hace falta preguntar.",
    parameters: {
      type: "OBJECT",
      properties: {
        monto: { type: "NUMBER", description: "Monto numérico gastado." },
        categoria: { type: "STRING", description: "Categoría (comida, súper, transporte, etc.)." },
        concepto: { type: "STRING", description: "Detalle opcional del gasto." },
        tipo_pago: {
          type: "STRING",
          description:
            "Cómo se pagó, SOLO si el usuario lo menciona explícitamente. Si no dice nada, omitir este campo (el default es débito).",
          enum: ["efectivo", "debito", "transferencia"],
        },
        medio_pago: {
          type: "STRING",
          description:
            "Cuenta o tarjeta virtual usada (ej. 'Naranja X', 'Uala', 'Mercado Pago', 'Brubank'), SOLO si el usuario la menciona y el pago fue débito o transferencia. Si no la menciona, omitir este campo (el default es Naranja X).",
        },
        fecha: {
          type: "STRING",
          description:
            "Fecha real del gasto en formato YYYY-MM-DD, SOLO si el usuario aclara que fue en otro día (ej. 'ayer', 'el sábado pasado', 'el 5 de septiembre'). Calculala vos usando la fecha de hoy como referencia. Si no dice nada, omitir este campo (se usa hoy).",
        },
      },
      required: ["monto", "categoria"],
    },
  },
  {
    name: "deshacer_ultimo_gasto",
    description: "Elimina el último gasto registrado en Google Sheets.",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "consultar_gastos",
    description:
      "Busca en Google Sheets los gastos de un período y devuelve total, cantidad, desglose por categoría/tipo de pago/medio de pago, y el detalle (lista) de cada gasto individual encontrado. Usalo para responder cualquier pregunta sobre gastos pasados, sea 'cuánto' o 'qué' gastó.",
    parameters: {
      type: "OBJECT",
      properties: {
        unidad: {
          type: "STRING",
          description:
            "Para períodos relativos a HOY tipo 'último/os día(s)/semana(s)/mes(es)'. Usar junto con cantidad.",
          enum: ["dia", "semana", "mes"],
        },
        cantidad: {
          type: "NUMBER",
          description:
            "Cuántas unidades hacia atrás desde hoy (ej. 'último día' = 1, 'últimas 2 semanas' = 2). Requiere unidad. Si el usuario dice 'último/a' sin número, usar 1.",
        },
        mes: {
          type: "STRING",
          description:
            "Mes calendario puntual en formato YYYY-MM, SOLO cuando el usuario nombra un mes específico (ej. 'en agosto'). No usar junto con unidad/cantidad.",
        },
      },
    },
  },
  {
    name: "registrar_deuda_cobro",
    description: "Registra una deuda o cobro en Sheets.",
    parameters: {
      type: "OBJECT",
      properties: {
        tipo: { type: "STRING", enum: ["deuda", "cobro"] },
        monto: { type: "NUMBER" },
        concepto: { type: "STRING" },
      },
      required: ["tipo", "monto", "concepto"],
    },
  },
  {
    name: "saldar_cuenta",
    description: "Marca una deuda o cobro como saldado.",
    parameters: {
      type: "OBJECT",
      properties: {
        tipo: { type: "STRING", enum: ["deuda", "cobro"] },
        concepto: { type: "STRING" },
      },
      required: ["tipo", "concepto"],
    },
  },
  {
    name: "guardar_notas",
    description: "Guarda notas o pendientes en Sheets.",
    parameters: {
      type: "OBJECT",
      properties: {
        items: { type: "ARRAY", items: { type: "STRING" } },
        categoria: { type: "STRING" },
      },
      required: ["items"],
    },
  },
  {
    name: "consultar_notas",
    description: "Consulta notas pendientes en Sheets.",
    parameters: {
      type: "OBJECT",
      properties: {
        categoria: { type: "STRING" },
      },
    },
  },
  {
    name: "completar_nota",
    description: "Marca un ítem de nota como completado.",
    parameters: {
      type: "OBJECT",
      properties: {
        item_busqueda: { type: "STRING" },
      },
      required: ["item_busqueda"],
    },
  },
  {
    name: "limpiar_notas",
    description: "Archiva notas completadas en Sheets.",
    parameters: {
      type: "OBJECT",
      properties: {
        categoria: { type: "STRING" },
      },
    },
  },
];

const toolHandlers = {
  crear_evento: calendarTools.crearEvento,
  listar_eventos: calendarTools.listarEventos,
  eliminar_evento: calendarTools.eliminarEvento,
  registrar_gasto: sheetsTools.registrarGasto,
  deshacer_ultimo_gasto: sheetsTools.deshacerUltimoGasto,
  consultar_gastos: sheetsTools.consultarGastos,
  registrar_deuda_cobro: sheetsTools.registrarDeudaCobro,
  saldar_cuenta: sheetsTools.saldarCuenta,
  guardar_notas: sheetsTools.guardarNotas,
  consultar_notas: sheetsTools.consultarNotas,
  completar_nota: sheetsTools.completarNota,
  limpiar_notas: sheetsTools.limpiarNotas,
};

function recortarHistorial(historial) {
  if (!Array.isArray(historial)) return [];
  if (historial.length <= MAX_TURNOS_HISTORIAL * 2) return historial;
  return historial.slice(-MAX_TURNOS_HISTORIAL * 2);
}

async function ejecutarConReintento(params, maxIntentos = 3) {
  for (let i = 0; i < maxIntentos; i++) {
    try {
      await esperarCupo();
      return await ai.models.generateContent(params);
    } catch (err) {
      const msg = err?.message || "";
      const es503 = err?.status === 503 || msg.includes("503") || msg.includes("high demand") || msg.includes("UNAVAILABLE");
      if (es503 && i < maxIntentos - 1) {
        console.warn(`⚠️ [Gemini 503] Demanda alta en Google. Reintentando (${i + 1}/${maxIntentos}) en 2s...`);
        await new Promise((res) => setTimeout(res, 2000));
      } else {
        throw err;
      }
    }
  }
}

// Cola por número: evita que dos mensajes del MISMO usuario se procesen en
// paralelo y corrompan el array de historial compartido (causa del error
// "function response turn comes immediately after a function call turn").
// Mensajes de números distintos siguen procesándose sin bloquearse entre sí.
const colasPorNumero = new Map();

export function procesarMensajeConAgente(numero, texto) {
  const anterior = colasPorNumero.get(numero) || Promise.resolve();
  const actual = anterior.catch(() => {}).then(() => procesarMensajeInterno(numero, texto));
  colasPorNumero.set(numero, actual.catch(() => {}));
  return actual;
}

async function procesarMensajeInterno(numero, texto) {
  let contents = historiales.get(numero) || [];

  contents.push({
    role: "user",
    parts: [{ text: texto }],
  });

  let respuestaFinal = "";

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    let response;
    try {
      response = await ejecutarConReintento({
        model: MODEL,
        contents: contents,
        config: {
          systemInstruction: systemInstruction(),
          tools: [{ functionDeclarations: toolDeclarations }],
        },
      });
    } catch (err) {
      if (err instanceof CuotaDiariaError) {
        respuestaFinal = "Se me acabó el cupo gratuito de IA por hoy 😅. Volvé a escribirme después de medianoche (hora Argentina) y sigo funcionando normal. Mientras tanto seguí anotando lo que necesites, lo proceso cuando vuelva el cupo.";
        break;
      }
      throw err;
    }

    const candidate = response.candidates?.[0];
    const candidateContent = candidate?.content;
    if (!candidateContent) break;

    contents.push(candidateContent);

    const calls = response.functionCalls;
    if (!calls || calls.length === 0) {
      respuestaFinal = response.text || "Listo.";
      break;
    }

    const responseParts = [];
    for (const call of calls) {
      let resultado;
      try {
        const handler = toolHandlers[call.name];
        if (!handler) throw new Error(`Herramienta desconocida: ${call.name}`);
        console.log(`🔧 Tool: ${call.name}`, call.args);
        resultado = await handler(call.args || {});
      } catch (err) {
        console.error(`Error ejecutando tool ${call.name}:`, err);
        resultado = { ok: false, error: err.message };
      }
      responseParts.push({
        functionResponse: {
          name: call.name,
          response: resultado,
        },
      });
    }

    contents.push({
      role: "user",
      parts: responseParts,
    });
  }

  historiales.set(numero, recortarHistorial(contents));
  return respuestaFinal || "Listo.";
}
