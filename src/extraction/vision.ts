import type OpenAI from "openai";
import { getOpenRouterClient } from "../openrouter.js";
import { extractJsonObject } from "./llmJson.js";
import type { ExtractedRow, ExtractedTable } from "./types.js";
import type { OfertaMetadata } from "./typesOfertas.js";

// Configurable por env para poder cambiar de modelo sin tocar código (ver
// openrouter.ai/models para el catálogo completo de proveedores/modelos).
const VISION_MODEL = process.env.OPENROUTER_VISION_MODEL || "anthropic/claude-sonnet-5";

const EXTRACTION_PROMPT = `Sos un asistente que extrae tablas de listas de precios de proveedores de repuestos automotores, a partir de un documento (PDF o imagen) que puede estar prolijo o desprolijo (columnas variables, sin convención fija).

Devolvé ÚNICAMENTE un objeto JSON (sin texto antes ni después, sin markdown) con esta forma exacta:
{"headers": ["<nombre de columna tal cual aparece en el documento>", ...], "rows": [{"<header>": "<valor tal cual aparece>", ...}, ...]}

Reglas:
- Incluí TODAS las columnas que veas, con su nombre original (no traduzcas ni normalices nombres).
- Incluí TODAS las filas de producto que encuentres. Si hay varias tablas/páginas con la misma estructura, combinalas en "rows".
- Si una fila es un encabezado de sección (ej. "Filtros de Aceite", sin precio), no la incluyas como fila de producto; en cambio agregale a las filas de producto siguientes un campo extra "_seccion" con ese texto, hasta que cambie de sección.
- Los valores de precio quedan como aparecen en el documento (no los conviertas a número vos).
- Si el documento no tiene ninguna tabla de productos/precios reconocible, devolvé {"headers": [], "rows": []}.`;

// OpenRouter sigue el formato de contenido multimodal de OpenAI: imágenes van
// como "image_url" con un data URI, PDFs van como "file" con su propio data
// URI. El SDK de OpenAI no tipa estos bloques (son una extensión de
// OpenRouter), así que los definimos a mano.
type ImageContentPart = { type: "image_url"; image_url: { url: string } };
type FileContentPart = { type: "file"; file: { filename: string; file_data: string } };

export async function extractWithVision(
  buffer: Buffer,
  mimeType: "application/pdf" | "image/png" | "image/jpeg",
  fileName: string
): Promise<ExtractedTable[]> {
  const client = getOpenRouterClient();
  const base64 = buffer.toString("base64");

  const contentPart: ImageContentPart | FileContentPart =
    mimeType === "application/pdf"
      ? { type: "file", file: { filename: fileName, file_data: `data:application/pdf;base64,${base64}` } }
      : { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } };

  const requestBody = {
    model: VISION_MODEL,
    max_tokens: 8192,
    messages: [
      {
        role: "user" as const,
        content: [contentPart, { type: "text" as const, text: EXTRACTION_PROMPT }],
      },
    ],
    // El plugin file-parser de OpenRouter es lo que le permite a un modelo
    // sin soporte nativo de PDF leer el archivo. "pdf-text" alcanza para
    // listas de precios con texto real; para PDFs escaneados (imagen pura)
    // conviene cambiar a engine "mistral-ocr".
    ...(mimeType === "application/pdf"
      ? { plugins: [{ id: "file-parser", pdf: { engine: "pdf-text" } }] }
      : {}),
  };

  // Los bloques "image_url"/"file" y el parámetro "plugins" son extensiones
  // de OpenRouter que el SDK de OpenAI no tipa; los casts son necesarios acá.
  const completion = (await client.chat.completions.create(
    requestBody as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming
  )) as OpenAI.Chat.ChatCompletion;

  if (completion.usage) {
    const { prompt_tokens, completion_tokens, total_tokens } = completion.usage;
    console.log(
      `[tokens] vision model=${VISION_MODEL} prompt=${prompt_tokens} completion=${completion_tokens} total=${total_tokens}`
    );
  }

  const text = completion.choices[0]?.message?.content;
  if (!text || typeof text !== "string") {
    throw new Error("El modelo no devolvió una respuesta de texto.");
  }

  const parsed = JSON.parse(extractJsonObject(text)) as {
    headers?: unknown;
    rows?: unknown;
  };
  if (!Array.isArray(parsed.headers) || !Array.isArray(parsed.rows)) {
    throw new Error("Respuesta del modelo no tiene la forma esperada (headers/rows).");
  }

  return [
    {
      hoja: fileName,
      headers: parsed.headers as string[],
      rows: parsed.rows as ExtractedRow[],
    },
  ];
}

// El bullet de "fecha_hasta" cambia según sinFechaLimite (ver más abajo):
// si el usuario ya lo marcó al subir el archivo, le decimos al modelo que
// no lo busque, en vez de dejar que intente inferirlo del documento.
const FECHA_HASTA_BULLET_NORMAL = `- "fecha_hasta" es el vencimiento de la oferta, SOLO si el documento da una fecha concreta (ej. "válida durante julio"). Si dice "hasta agotar stock" o no menciona vencimiento, dejalo null — no asumas que no vence, solo que no tiene fecha fija (se cierra manualmente más adelante).`;
const FECHA_HASTA_BULLET_SIN_LIMITE = `- "fecha_hasta": el usuario ya indicó que esta oferta es "hasta agotar stock" (sin fecha de cierre). Devolvé siempre null para este campo, no lo busques en el documento.`;

const OFERTA_EXTRACTION_PROMPT = `Sos un asistente que extrae tablas de OFERTAS (descuentos por SKU con tramos de cantidad) de proveedores de repuestos automotores, a partir de un documento (PDF o imagen) que puede estar prolijo o desprolijo.

Devolvé ÚNICAMENTE un objeto JSON (sin texto antes ni después, sin markdown) con esta forma exacta:
{"headers": ["<nombre de columna tal cual aparece en el documento>", ...], "rows": [{"<header>": "<valor tal cual aparece>", ...}, ...], "metadata": {"marca": <string o null>, "numero_oferta": <string o null>, "fecha_oferta": <string YYYY-MM-DD o null>, "hora_oferta": <string HH:MM o null>, "fecha_hasta": <string YYYY-MM-DD o null>}}

Reglas:
- Incluí TODAS las columnas que veas, con su nombre original (no traduzcas ni normalices nombres).
- Incluí TODAS las filas de oferta que encuentres. Un mismo código de producto puede repetirse varias veces con distinto umbral de cantidad/descuento (tramos de descuento por volumen) — son filas válidas, NO las deduplique.
- Los valores quedan como aparecen en el documento (no los conviertas a número vos).
- "metadata" son datos que suelen aplicar a TODO el archivo, no ser una columna de la tabla: fijate si hay un renglón banner al principio del documento (ej. "PROVEEDOR S.R.L.  01/07/2026 - 15:00") del que se puedan sacar fecha_oferta/hora_oferta/numero_oferta, y si "marca" se puede inferir del nombre de archivo (te lo paso abajo) o de algún título del documento. Si alguno de estos datos SÍ es una columna de la tabla, dejalo también ahí como columna y podés poner null en metadata para ese campo.
{{fechaHastaBullet}}
- Si el documento no tiene ninguna tabla de ofertas reconocible, devolvé {"headers": [], "rows": [], "metadata": {}}.

Nombre de archivo: "{{fileName}}"`;

export async function extractOfertaWithVision(
  buffer: Buffer,
  mimeType: "application/pdf" | "image/png" | "image/jpeg",
  fileName: string,
  sinFechaLimite = false
): Promise<{ tables: ExtractedTable[]; metadata: OfertaMetadata }> {
  const client = getOpenRouterClient();
  const base64 = buffer.toString("base64");

  const contentPart: ImageContentPart | FileContentPart =
    mimeType === "application/pdf"
      ? { type: "file", file: { filename: fileName, file_data: `data:application/pdf;base64,${base64}` } }
      : { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } };

  const prompt = OFERTA_EXTRACTION_PROMPT.replace("{{fileName}}", fileName).replace(
    "{{fechaHastaBullet}}",
    sinFechaLimite ? FECHA_HASTA_BULLET_SIN_LIMITE : FECHA_HASTA_BULLET_NORMAL
  );

  const requestBody = {
    model: VISION_MODEL,
    max_tokens: 8192,
    messages: [
      {
        role: "user" as const,
        content: [contentPart, { type: "text" as const, text: prompt }],
      },
    ],
    ...(mimeType === "application/pdf"
      ? { plugins: [{ id: "file-parser", pdf: { engine: "pdf-text" } }] }
      : {}),
  };

  const completion = (await client.chat.completions.create(
    requestBody as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming
  )) as OpenAI.Chat.ChatCompletion;

  if (completion.usage) {
    const { prompt_tokens, completion_tokens, total_tokens } = completion.usage;
    console.log(
      `[tokens] vision-ofertas model=${VISION_MODEL} prompt=${prompt_tokens} completion=${completion_tokens} total=${total_tokens}`
    );
  }

  const text = completion.choices[0]?.message?.content;
  if (!text || typeof text !== "string") {
    throw new Error("El modelo no devolvió una respuesta de texto.");
  }

  const parsed = JSON.parse(extractJsonObject(text)) as {
    headers?: unknown;
    rows?: unknown;
    metadata?: unknown;
  };
  if (!Array.isArray(parsed.headers) || !Array.isArray(parsed.rows)) {
    throw new Error("Respuesta del modelo no tiene la forma esperada (headers/rows).");
  }

  const metadataRaw =
    parsed.metadata && typeof parsed.metadata === "object" && !Array.isArray(parsed.metadata)
      ? (parsed.metadata as Record<string, unknown>)
      : {};
  const asStringOrNull = (v: unknown): string | null =>
    typeof v === "string" || typeof v === "number" ? String(v).trim() || null : null;

  return {
    tables: [
      {
        hoja: fileName,
        headers: parsed.headers as string[],
        rows: parsed.rows as ExtractedRow[],
      },
    ],
    metadata: {
      marca: asStringOrNull(metadataRaw.marca),
      numero_oferta: asStringOrNull(metadataRaw.numero_oferta),
      fecha_oferta: asStringOrNull(metadataRaw.fecha_oferta),
      hora_oferta: asStringOrNull(metadataRaw.hora_oferta),
      fecha_hasta: sinFechaLimite ? null : asStringOrNull(metadataRaw.fecha_hasta),
    },
  };
}
