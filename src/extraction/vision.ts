import type OpenAI from "openai";
import { pdf } from "pdf-to-img";
import { getOpenRouterClient } from "../openrouter.js";
import { extractJsonObject } from "./llmJson.js";
import type { ExtractedRow, ExtractedTable } from "./types.js";
import type { OfertaMetadata } from "./typesOfertas.js";

// Configurable por env para poder cambiar de modelo sin tocar código (ver
// openrouter.ai/models para el catálogo completo de proveedores/modelos).
const VISION_MODEL = process.env.OPENROUTER_VISION_MODEL || "anthropic/claude-sonnet-5";

// Escala de renderizado al convertir cada página de PDF a imagen (ver
// renderPages más abajo). 2x da páginas legibles incluso con la letra chica
// de listas de precios densas (probado en vivo contra "260713 - Lista Unica
// Castrol.pdf", 8 páginas / ~490 filas) sin disparar demasiado el tamaño del
// PNG resultante.
const PDF_RENDER_SCALE = 2;

const EXTRACTION_PROMPT = `Sos un asistente que extrae tablas de listas de precios de proveedores de repuestos automotores, a partir de un documento (PDF o imagen) que puede estar prolijo o desprolijo (columnas variables, sin convención fija).

Devolvé ÚNICAMENTE un objeto JSON (sin texto antes ni después, sin markdown) con esta forma exacta:
{"headers": ["<nombre de columna tal cual aparece en el documento>", ...], "rows": [{"<header>": "<valor tal cual aparece>", ...}, ...]}

Reglas:
- Incluí TODAS las columnas que veas, con su nombre original (no traduzcas ni normalices nombres).
- Incluí TODAS las filas de producto que encuentres. Si hay varias tablas/páginas con la misma estructura, combinalas en "rows".
- Si una fila es un encabezado de sección (ej. "Filtros de Aceite", sin precio), no la incluyas como fila de producto; en cambio agregale a las filas de producto siguientes un campo extra "_seccion" con ese texto, hasta que cambie de sección.
- Los valores de precio quedan como aparecen en el documento (no los conviertas a número vos).
- Si el documento no tiene ninguna tabla de productos/precios reconocible, devolvé {"headers": [], "rows": []}.`;

// OpenRouter sigue el formato de contenido multimodal de OpenAI: las
// imágenes van como "image_url" con un data URI. El SDK de OpenAI no tipa
// este bloque (es una extensión de OpenRouter), así que lo definimos a mano.
type ImageContentPart = { type: "image_url"; image_url: { url: string } };

// Antes los PDF se mandaban enteros como bloque "file" + el plugin
// file-parser de OpenRouter (engine "pdf-text", con "mistral-ocr" como
// alternativa para escaneados). Probado en vivo contra un PDF real de 8
// páginas / ~490 filas, los dos engines fallaban: "pdf-text" no le hacía
// llegar nada de contenido al modelo (el modelo respondía headers/rows
// vacíos, sin error, porque nunca vio la tabla) y "mistral-ocr" sí extraía
// el documento entero pero la respuesta en una sola llamada se cortaba
// contra el tope de max_tokens antes de completar el JSON. En vez de
// depender de ese plugin de terceros, acá renderizamos cada página como
// imagen nosotros mismos (pdf-to-img, sin binarios nativos) y la mandamos
// por el mismo camino "image_url" que ya se usa para fotos sueltas —
// evitando el engine de PDF de OpenRouter por completo y, de paso,
// acotando el tamaño de cada respuesta a lo que entra en una sola página
// en vez de al documento completo. Ver backend/README.md para el detalle.
async function renderPages(buffer: Buffer, mimeType: "application/pdf" | "image/png" | "image/jpeg"): Promise<Buffer[]> {
  if (mimeType !== "application/pdf") return [buffer];

  const dataUrl = `data:application/pdf;base64,${buffer.toString("base64")}`;
  const documento = await pdf(dataUrl, { scale: PDF_RENDER_SCALE });
  const paginas: Buffer[] = [];
  for await (const pagina of documento) paginas.push(pagina as Buffer);
  // Las instancias de Pdf no se liberan solas (ver docs de pdf-to-img) — sin
  // esto, cada carga de un PDF grande deja el documento renderizado en
  // memoria.
  await documento.destroy();
  return paginas;
}

function toImageContentPart(
  imageBuffer: Buffer,
  mimeType: "application/pdf" | "image/png" | "image/jpeg"
): ImageContentPart {
  // Una página de PDF renderizada siempre sale como PNG, sea cual sea el
  // mimeType del archivo original.
  const mimeEfectivo = mimeType === "application/pdf" ? "image/png" : mimeType;
  return { type: "image_url", image_url: { url: `data:${mimeEfectivo};base64,${imageBuffer.toString("base64")}` } };
}

// Le agrega contexto de paginación al prompt solo cuando el documento se
// partió en más de una página — para una imagen suelta (el caso más común
// hoy, fotos de WhatsApp) el prompt queda idéntico al de antes.
//
// headersPrevios existe porque, probado en vivo contra un PDF real de 8
// páginas, muchas listas de precios exportadas a PDF NO repiten la fila de
// encabezado ("Codigo | Descripción | ...") en cada página impresa — solo
// aparece una vez, al principio del documento. Sin este contexto, el modelo
// no tiene forma de saberlo en una página que no la incluye y termina
// usando la primera fila de datos de esa página como si fuera el
// encabezado (visto en la práctica: encabezados como
// ["LCAAU-L0114.950", "810300001176", "TRANSMAX CVT 6X1USqt", ...] en vez
// de los nombres de columna reales).
export function conContextoDePagina(
  promptBase: string,
  pagina: number,
  totalPaginas: number,
  seccionPrevia: string | null,
  headersPrevios: string[] | null = null
): string {
  if (totalPaginas <= 1) return promptBase;

  const partes = [
    `Es la página ${pagina} de ${totalPaginas} de este documento (cada página se procesa por separado y las filas se combinan después).`,
  ];

  partes.push(
    headersPrevios && headersPrevios.length > 0
      ? `Las columnas de esta tabla ya se identificaron en una página anterior y son EXACTAMENTE estas, en este orden: ${JSON.stringify(headersPrevios)}. Es común que la fila de encabezado no se repita en cada página impresa: si no la ves en esta página, NO inventes otro encabezado ni tomes la primera fila de datos como si fuera el encabezado — asigná los valores de cada fila a estas mismas columnas, y devolvé exactamente esta misma lista en "headers".`
      : `Todavía no se detectaron las columnas de la tabla en páginas anteriores — identificalas en esta página como harías normalmente.`
  );

  partes.push(
    seccionPrevia
      ? `La sección vigente al terminar la página anterior era "${seccionPrevia}": si esta página arranca sin un encabezado de sección nuevo, seguí usando esa hasta que aparezca uno distinto.`
      : `Todavía no se detectó ninguna sección en páginas anteriores.`
  );

  return `${promptBase}\n\n${partes.join(" ")}`;
}

export function ultimaSeccion(rows: ExtractedRow[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const valor = rows[i]?._seccion;
    if (typeof valor === "string" && valor.trim() !== "") return valor;
  }
  return null;
}

async function callVisionModel(contentPart: ImageContentPart, prompt: string, logLabel: string): Promise<Record<string, unknown>> {
  const client = getOpenRouterClient();

  const requestBody = {
    model: VISION_MODEL,
    max_tokens: 24000,
    messages: [
      {
        role: "user" as const,
        content: [contentPart, { type: "text" as const, text: prompt }],
      },
    ],
  };

  // El bloque "image_url" es una extensión de OpenRouter que el SDK de
  // OpenAI no tipa; el cast es necesario acá.
  const completion = (await client.chat.completions.create(
    requestBody as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming
  )) as OpenAI.Chat.ChatCompletion;

  if (completion.usage) {
    const { prompt_tokens, completion_tokens, total_tokens } = completion.usage;
    console.log(
      `[tokens] ${logLabel} model=${VISION_MODEL} prompt=${prompt_tokens} completion=${completion_tokens} total=${total_tokens}`
    );
  }

  const text = completion.choices[0]?.message?.content;
  if (!text || typeof text !== "string") {
    throw new Error("El modelo no devolvió una respuesta de texto.");
  }

  try {
    return JSON.parse(extractJsonObject(text)) as Record<string, unknown>;
  } catch (err) {
    // Con el documento partido en una llamada por página, una sola página
    // con JSON inválido (el modelo se corta o mete una comilla sin escapar)
    // no debería ser un misterio a la hora de depurar — se incluye un
    // recorte de la respuesta cruda en el mensaje de error.
    const preview = text.length > 800 ? `${text.slice(0, 800)}…` : text;
    const motivo = err instanceof Error ? err.message : String(err);
    throw new Error(`No se pudo parsear como JSON la respuesta del modelo (${logLabel}): ${motivo}. Respuesta cruda: ${preview}`);
  }
}

export async function extractWithVision(
  buffer: Buffer,
  mimeType: "application/pdf" | "image/png" | "image/jpeg",
  fileName: string
): Promise<ExtractedTable[]> {
  const paginas = await renderPages(buffer, mimeType);
  const tables: ExtractedTable[] = [];
  let seccionPrevia: string | null = null;
  let headersPrevios: string[] | null = null;

  for (let i = 0; i < paginas.length; i++) {
    const contentPart = toImageContentPart(paginas[i], mimeType);
    const prompt = conContextoDePagina(EXTRACTION_PROMPT, i + 1, paginas.length, seccionPrevia, headersPrevios);
    const parsed = await callVisionModel(contentPart, prompt, "vision");

    if (!Array.isArray(parsed.headers) || !Array.isArray(parsed.rows)) {
      throw new Error("Respuesta del modelo no tiene la forma esperada (headers/rows).");
    }

    const rows = parsed.rows as ExtractedRow[];
    const headers = parsed.headers as string[];
    tables.push({ hoja: fileName, headers, rows });
    seccionPrevia = ultimaSeccion(rows) ?? seccionPrevia;
    if (!headersPrevios && headers.length > 0) headersPrevios = headers;
  }

  return tables;
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

function asStringOrNull(v: unknown): string | null {
  return typeof v === "string" || typeof v === "number" ? String(v).trim() || null : null;
}

// La metadata "de todo el archivo" (marca/n° de oferta/fecha/hora) suele
// venir de un banner que solo aparece en la primera página; al partir el
// documento en una llamada por página, cada página propone su propia
// metadata (probablemente null salvo la que tenga el banner) y acá nos
// quedamos con el primer valor no nulo por campo, priorizando las páginas
// tempranas. Separada como función pura para poder testearla sin mockear
// el cliente de OpenRouter.
export function mergeOfertaMetadata(candidatas: OfertaMetadata[]): OfertaMetadata {
  const elegir = (campo: keyof OfertaMetadata): string | null => {
    for (const candidata of candidatas) {
      const valor = candidata[campo];
      if (valor !== null && valor !== undefined) return valor;
    }
    return null;
  };

  return {
    marca: elegir("marca"),
    numero_oferta: elegir("numero_oferta"),
    fecha_oferta: elegir("fecha_oferta"),
    hora_oferta: elegir("hora_oferta"),
    fecha_hasta: elegir("fecha_hasta"),
  };
}

export async function extractOfertaWithVision(
  buffer: Buffer,
  mimeType: "application/pdf" | "image/png" | "image/jpeg",
  fileName: string,
  sinFechaLimite = false
): Promise<{ tables: ExtractedTable[]; metadata: OfertaMetadata }> {
  const paginas = await renderPages(buffer, mimeType);
  const promptBase = OFERTA_EXTRACTION_PROMPT.replace("{{fileName}}", fileName).replace(
    "{{fechaHastaBullet}}",
    sinFechaLimite ? FECHA_HASTA_BULLET_SIN_LIMITE : FECHA_HASTA_BULLET_NORMAL
  );

  const tables: ExtractedTable[] = [];
  const metadataCandidatas: OfertaMetadata[] = [];
  let headersPrevios: string[] | null = null;

  for (let i = 0; i < paginas.length; i++) {
    const contentPart = toImageContentPart(paginas[i], mimeType);
    // Las ofertas no tienen "sección" (ver typesOfertas.ts) — por eso acá
    // seccionPrevia siempre es null — pero sí pueden perder el encabezado
    // entre páginas igual que el catálogo, así que headersPrevios se
    // arrastra igual.
    const prompt = conContextoDePagina(promptBase, i + 1, paginas.length, null, headersPrevios);
    const parsed = await callVisionModel(contentPart, prompt, "vision-ofertas");

    if (!Array.isArray(parsed.headers) || !Array.isArray(parsed.rows)) {
      throw new Error("Respuesta del modelo no tiene la forma esperada (headers/rows).");
    }

    const headers = parsed.headers as string[];
    tables.push({ hoja: fileName, headers, rows: parsed.rows as ExtractedRow[] });
    if (!headersPrevios && headers.length > 0) headersPrevios = headers;

    const metadataRaw =
      parsed.metadata && typeof parsed.metadata === "object" && !Array.isArray(parsed.metadata)
        ? (parsed.metadata as Record<string, unknown>)
        : {};
    metadataCandidatas.push({
      marca: asStringOrNull(metadataRaw.marca),
      numero_oferta: asStringOrNull(metadataRaw.numero_oferta),
      fecha_oferta: asStringOrNull(metadataRaw.fecha_oferta),
      hora_oferta: asStringOrNull(metadataRaw.hora_oferta),
      fecha_hasta: sinFechaLimite ? null : asStringOrNull(metadataRaw.fecha_hasta),
    });
  }

  return { tables, metadata: mergeOfertaMetadata(metadataCandidatas) };
}
