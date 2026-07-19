import { prisma } from "../db.js";
import { getOpenRouterClient } from "../openrouter.js";
import { extractJsonObject } from "./llmJson.js";
import { toStringOrNull, toNumberOrNull } from "./mapping.js";
import {
  CANONICAL_FIELDS_OFERTAS,
  type OfertaField,
  type OfertaColumnMapping,
  type OfertaMetadata,
  type OfertaRowNormalized,
} from "./typesOfertas.js";
import type { ExtractedRow } from "./types.js";

// Paralelo a mapping.ts (ver decisiones en docs/plan-ofertas.md: funciones
// paralelas para catálogo/ofertas, no una abstracción genérica de "schema").

const MAPPING_MODEL = process.env.OPENROUTER_MAPPING_MODEL || "anthropic/claude-sonnet-5";

// Igual que getExistingMapping (mapping.ts) pero filtrando por
// tipoDatos: "oferta" — un proveedor puede tener una columna "SKU" mapeada
// distinto en su catálogo y en sus ofertas.
export async function getExistingMappingOferta(
  proveedorId: number,
  headers: string[]
): Promise<OfertaColumnMapping | null> {
  const guardados = await prisma.mapeoColumna.findMany({
    where: { proveedorId, tipoDatos: "oferta" },
  });
  if (guardados.length === 0) return null;

  const mapping: OfertaColumnMapping = {};
  let coincidencias = 0;
  for (const h of headers) {
    const encontrado = guardados.find((g) => g.columnaOrigen === h);
    if (encontrado) {
      mapping[h] = encontrado.campoDestino as OfertaField;
      coincidencias++;
    }
  }
  if (coincidencias === 0) return null;
  return mapping;
}

function isOfertaField(value: unknown): value is OfertaField {
  return typeof value === "string" && (CANONICAL_FIELDS_OFERTAS as readonly string[]).includes(value);
}

// Igual que suggestMapping (mapping.ts) pero con el prompt adaptado al
// schema de ofertas: aclara explícitamente que un sku_proveedor repetido
// con distinto desde_cantidad es un tramo de descuento válido, no algo a
// deduplicar (la diferencia clave #1 de docs/plan-ofertas.md).
export async function suggestMappingOfertas(
  headers: string[],
  sampleRows: ExtractedRow[]
): Promise<OfertaColumnMapping> {
  const client = getOpenRouterClient();

  const muestra = sampleRows.slice(0, 5).map((row) => {
    const limpio: ExtractedRow = {};
    for (const h of headers) limpio[h] = row[h];
    return limpio;
  });

  const prompt = `Tenés estas columnas detectadas en un archivo de OFERTAS (descuentos por SKU con tramos de cantidad) de un proveedor de repuestos automotores:
${JSON.stringify(headers)}

Filas de ejemplo:
${JSON.stringify(muestra, null, 2)}

Mapealas al schema canónico de ofertas. Los campos destino posibles son EXACTAMENTE estos (usá null si una columna no corresponde a ninguno):
${JSON.stringify(CANONICAL_FIELDS_OFERTAS)}

Reglas:
- "sku_proveedor" es el código del producto tal como lo identifica el proveedor.
- "desde_cantidad" es el umbral de unidades a partir del cual aplica ese "descuento_pct" (tramos de descuento por volumen). Un mismo sku_proveedor puede aparecer en varias filas con distinto desde_cantidad/descuento_pct — eso es válido, NO sugieras tratarlo como una columna única por SKU ni como duplicados.
- "numero_oferta", "marca", "fecha_oferta", "hora_oferta" a veces son columnas de la tabla y a veces no aparecen en ninguna columna (vienen de un banner o del nombre de archivo, eso se resuelve aparte) — si no ves una columna clara para alguno de estos, dejalo en null.
- "precio_unitario" es el precio final ya con el descuento de ese tramo aplicado.
- Si no estás seguro de una columna, dejala en null (mejor no mapear que mapear mal).

Devolvé ÚNICAMENTE un objeto JSON (sin texto antes ni después, sin markdown) de la forma:
{"<columna origen>": "<campo_canonico o null>", ...}
con una entrada por cada columna de la lista de arriba.`;

  const completion = await client.chat.completions.create({
    model: MAPPING_MODEL,
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  });

  if (completion.usage) {
    const { prompt_tokens, completion_tokens, total_tokens } = completion.usage;
    console.log(
      `[tokens] mapping-ofertas model=${MAPPING_MODEL} prompt=${prompt_tokens} completion=${completion_tokens} total=${total_tokens}`
    );
  }

  const text = completion.choices[0]?.message?.content;
  if (!text) {
    throw new Error("El modelo no devolvió una respuesta de texto.");
  }

  const parsed = JSON.parse(extractJsonObject(text)) as Record<string, unknown>;
  const mapping: OfertaColumnMapping = {};
  for (const [columna, destino] of Object.entries(parsed)) {
    if (isOfertaField(destino)) mapping[columna] = destino;
  }
  return mapping;
}

function toIntOrNull(value: unknown): number | null {
  const n = toNumberOrNull(value);
  return n === null ? null : Math.round(n);
}

// Arma un OfertaRowNormalized (parseo tolerante, mismo criterio que
// normalizeCanonicalRow) a partir de un objeto parcial con los campos
// canónicos de oferta. Puede quedar con nulls en campos obligatorios del
// schema — eso se valida recién al confirmar (ver processCarga.ts).
export function normalizeOfertaRow(
  input: Partial<Record<OfertaField, unknown>> & { raw_data?: unknown }
): OfertaRowNormalized {
  const rawData =
    input.raw_data && typeof input.raw_data === "object" && !Array.isArray(input.raw_data)
      ? (input.raw_data as Record<string, unknown>)
      : {};

  return {
    marca: toStringOrNull(input.marca),
    numero_oferta: toIntOrNull(input.numero_oferta),
    sku_proveedor: toStringOrNull(input.sku_proveedor),
    descripcion: toStringOrNull(input.descripcion),
    desde_cantidad: toIntOrNull(input.desde_cantidad),
    descuento_pct: toNumberOrNull(input.descuento_pct),
    precio_unitario: toNumberOrNull(input.precio_unitario),
    moneda: toStringOrNull(input.moneda) ?? "ARS",
    fecha_oferta: toStringOrNull(input.fecha_oferta),
    hora_oferta: toStringOrNull(input.hora_oferta),
    raw_data: rawData,
  };
}

// Igual que applyMapping (mapping.ts), pero además completa marca/
// numero_oferta/fecha_oferta/hora_oferta con la metadata detectada "de todo
// el archivo" (ver typesOfertas.ts) cuando esos campos no vinieron de una
// columna mapeada — así funciona tanto un proveedor donde "N° Oferta" es una
// columna real (caso BOR&UR) como uno donde ese dato solo está en el banner.
export function applyMappingOfertas(
  headers: string[],
  rows: ExtractedRow[],
  mapping: OfertaColumnMapping,
  metadata: OfertaMetadata
): OfertaRowNormalized[] {
  return rows.map((row) => {
    const canonical: Partial<Record<OfertaField, unknown>> = {};
    const rawData: Record<string, unknown> = {};

    for (const h of headers) {
      const destino = mapping[h];
      const valor = row[h];
      if (destino) {
        canonical[destino] = valor;
      } else if (valor !== null && valor !== undefined && valor !== "") {
        rawData[h] = valor;
      }
    }

    if (canonical.marca === undefined || canonical.marca === null || canonical.marca === "") {
      canonical.marca = metadata.marca;
    }
    if (
      canonical.numero_oferta === undefined ||
      canonical.numero_oferta === null ||
      canonical.numero_oferta === ""
    ) {
      canonical.numero_oferta = metadata.numero_oferta;
    }
    if (
      canonical.fecha_oferta === undefined ||
      canonical.fecha_oferta === null ||
      canonical.fecha_oferta === ""
    ) {
      canonical.fecha_oferta = metadata.fecha_oferta;
    }
    if (
      canonical.hora_oferta === undefined ||
      canonical.hora_oferta === null ||
      canonical.hora_oferta === ""
    ) {
      canonical.hora_oferta = metadata.hora_oferta;
    }

    return normalizeOfertaRow({ ...canonical, raw_data: rawData });
  });
}
