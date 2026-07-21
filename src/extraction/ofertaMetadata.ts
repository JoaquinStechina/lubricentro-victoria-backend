import { getOpenRouterClient } from "../openrouter.js";
import { extractJsonObject } from "./llmJson.js";
import type { OfertaMetadata } from "./typesOfertas.js";

const METADATA_MODEL = process.env.OPENROUTER_MAPPING_MODEL || "anthropic/claude-sonnet-5";

// Infiere marca/n° de oferta/fecha/hora "de todo el archivo" (ver
// docs/plan-ofertas.md, punto 2) a partir del nombre de archivo y el texto
// que haya antes de la tabla de datos (banner de excel, ver
// excel.ts#extractBannerLines; para pdf/imagen esto se resuelve en la misma
// llamada de vision.ts#extractOfertaWithVision, no hace falta esta función
// ahí). Es solo una sugerencia editable en la pantalla de revisión — nunca
// se confía ciegamente en lo que devuelva.
export async function detectOfertaMetadata(
  fileName: string,
  bannerLines: string[],
  sinFechaLimite = false
): Promise<OfertaMetadata> {
  const client = getOpenRouterClient();

  // Si el usuario ya marcó "hasta agotar stock" al subir el archivo, no
  // tiene sentido pedirle al modelo que busque una fecha de vencimiento (le
  // ahorra tokens y evita que alucine una fecha que no corresponde) — el
  // resultado se fuerza a null más abajo de todos modos, por las dudas.
  const fechaHastaInstruccion = sinFechaLimite
    ? `- "fecha_hasta": el usuario ya indicó que esta oferta es "hasta agotar stock" (sin fecha de cierre). Devolvé siempre null para este campo, no lo busques en el texto.`
    : `- "fecha_hasta": fecha de vencimiento de la oferta, en formato YYYY-MM-DD, SOLO si el texto da una fecha concreta (ej. "válida durante julio" -> el último día de julio de ese año). Si dice algo como "hasta agotar stock", "hasta fin de stock", o no menciona ningún vencimiento, dejalo en null — null significa que la oferta no tiene fecha de cierre conocida (se cierra manualmente más adelante), no que dure para siempre.`;

  const prompt = `Este archivo es una lista de OFERTAS (descuentos por SKU) de un proveedor de repuestos automotores. Nombre de archivo: "${fileName}".
${
  bannerLines.length > 0
    ? `Texto encontrado antes de la tabla de datos:\n${bannerLines.join("\n")}`
    : "No se detectó texto antes de la tabla de datos."
}

Estos 5 datos suelen aplicar a TODO el archivo, no ser una columna de la tabla. Inferí los que puedas:
- "marca": la marca de los productos en oferta. Normalmente se puede inferir del nombre de archivo (ej. "ofertas baterías autos bosch.xls" -> "Bosch Baterías", "OFERTAS Tecfil y WhatsApp Tecfil.xls" -> "Tecfil").
- "numero_oferta": el número de oferta del archivo, SOLO si aparece en el texto de arriba (no lo inventes; si no aparece ahí, puede que sea una columna de la tabla, en cuyo caso no hace falta acá — dejalo null).
- "fecha_oferta": fecha en formato YYYY-MM-DD, si aparece en el texto de arriba.
- "hora_oferta": hora en formato HH:MM, si aparece en el texto de arriba.
${fechaHastaInstruccion}

Devolvé ÚNICAMENTE un objeto JSON (sin texto antes ni después, sin markdown) con esta forma exacta, usando null en lo que no puedas inferir con confianza:
{"marca": <string o null>, "numero_oferta": <string o null>, "fecha_oferta": <string o null>, "hora_oferta": <string o null>, "fecha_hasta": <string o null>}`;

  const completion = await client.chat.completions.create({
    model: METADATA_MODEL,
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
  });

  if (completion.usage) {
    const { prompt_tokens, completion_tokens, total_tokens } = completion.usage;
    console.log(
      `[tokens] oferta-metadata model=${METADATA_MODEL} prompt=${prompt_tokens} completion=${completion_tokens} total=${total_tokens}`
    );
  }

  const text = completion.choices[0]?.message?.content;
  if (!text) return {};

  const parsed = JSON.parse(extractJsonObject(text)) as Record<string, unknown>;
  const asStringOrNull = (v: unknown): string | null =>
    typeof v === "string" || typeof v === "number" ? String(v).trim() || null : null;

  return {
    marca: asStringOrNull(parsed.marca),
    numero_oferta: asStringOrNull(parsed.numero_oferta),
    fecha_oferta: asStringOrNull(parsed.fecha_oferta),
    hora_oferta: asStringOrNull(parsed.hora_oferta),
    fecha_hasta: sinFechaLimite ? null : asStringOrNull(parsed.fecha_hasta),
  };
}
