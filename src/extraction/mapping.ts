import { prisma } from "../db.js";
import { getOpenRouterClient } from "../openrouter.js";
import { extractJsonObject } from "./llmJson.js";
import {
  CANONICAL_FIELDS,
  type CanonicalField,
  type CanonicalRow,
  type ColumnMapping,
  type ExtractedRow,
} from "./types.js";

const MAPPING_MODEL = process.env.OPENROUTER_MAPPING_MODEL || "anthropic/claude-sonnet-5";

// Busca un mapeo ya aprobado para este proveedor (etapa 3 del pipeline).
// Si ninguna columna actual coincide con lo guardado, probablemente le
// cambiaron los headers al proveedor: mejor pedir revisión de nuevo en vez
// de aplicar un mapeo que ya no corresponde.
export async function getExistingMapping(
  proveedorId: number,
  headers: string[]
): Promise<ColumnMapping | null> {
  const guardados = await prisma.mapeoColumna.findMany({ where: { proveedorId } });
  if (guardados.length === 0) return null;

  const mapping: ColumnMapping = {};
  let coincidencias = 0;
  for (const h of headers) {
    const encontrado = guardados.find((g) => g.columnaOrigen === h);
    if (encontrado) {
      mapping[h] = encontrado.campoDestino as CanonicalField;
      coincidencias++;
    }
  }
  if (coincidencias === 0) return null;
  return mapping;
}

function isCanonicalField(value: unknown): value is CanonicalField {
  return typeof value === "string" && (CANONICAL_FIELDS as readonly string[]).includes(value);
}

// Proveedor nuevo (o headers cambiados): le pedimos al modelo una sugerencia
// de mapeo. Queda pendiente de aprobación humana (ver processCarga.ts) antes
// de escribirse en MapeoColumna — nunca se aplica en automático.
export async function suggestMapping(
  headers: string[],
  sampleRows: ExtractedRow[]
): Promise<ColumnMapping> {
  const client = getOpenRouterClient();

  const muestra = sampleRows.slice(0, 5).map((row) => {
    const limpio: ExtractedRow = {};
    for (const h of headers) limpio[h] = row[h];
    return limpio;
  });

  const prompt = `Tenés estas columnas detectadas en una lista de precios de un proveedor de repuestos automotores:
${JSON.stringify(headers)}

Filas de ejemplo:
${JSON.stringify(muestra, null, 2)}

Mapealas al schema canónico. Los campos destino posibles son EXACTAMENTE estos (usá null si una columna no corresponde a ninguno):
${JSON.stringify(CANONICAL_FIELDS)}

Reglas:
- "sku_proveedor" es el código del producto tal como lo identifica el proveedor.
- "sku_interno" es un código interno propio (si existe una columna separada para eso).
- "precio_neto" es el precio SIN IVA. "precio_con_iva" es CON IVA. "alicuota_iva" es el % de IVA (21, 10.5, etc.), no un monto.
- Un mismo campo destino no debería repetirse en dos columnas distintas salvo que genuinamente sea así en los datos.
- Si no estás seguro de una columna, dejala en null (mejor no mapear que mapear mal precios).

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
      `[tokens] mapping model=${MAPPING_MODEL} prompt=${prompt_tokens} completion=${completion_tokens} total=${total_tokens}`
    );
  }

  const text = completion.choices[0]?.message?.content;
  if (!text) {
    throw new Error("El modelo no devolvió una respuesta de texto.");
  }

  const parsed = JSON.parse(extractJsonObject(text)) as Record<string, unknown>;
  const mapping: ColumnMapping = {};
  for (const [columna, destino] of Object.entries(parsed)) {
    if (isCanonicalField(destino)) mapping[columna] = destino;
  }
  return mapping;
}

export function toStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

export function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  // Precios reales vienen como "$ 1.985,78" (separador de miles ".",
  // decimales ","); limpiamos antes de convertir.
  const limpio = String(value)
    .replace(/[^\d,.-]/g, "")
    .replace(/\.(?=\d{3}(?:\D|$))/g, "")
    .replace(",", ".");
  const n = Number(limpio);
  return Number.isFinite(n) ? n : null;
}

// Arma un CanonicalRow completo (con parseo tolerante de números/strings) a
// partir de un objeto parcial con los campos canónicos. La usan tanto
// applyMapping (con valores recién resueltos del mapeo) como
// confirmarCargaYPublicar en processCarga.ts (con filas ya editadas a mano
// por un humano en el frontend) — mismo parseo tolerante en los dos casos,
// sin duplicarlo.
export function normalizeCanonicalRow(
  input: Partial<Record<CanonicalField, unknown>> & { raw_data?: unknown }
): CanonicalRow {
  const rawData =
    input.raw_data && typeof input.raw_data === "object" && !Array.isArray(input.raw_data)
      ? (input.raw_data as Record<string, unknown>)
      : {};

  return {
    marca: toStringOrNull(input.marca),
    sku_proveedor: toStringOrNull(input.sku_proveedor),
    sku_interno: toStringOrNull(input.sku_interno),
    descripcion: toStringOrNull(input.descripcion),
    seccion: toStringOrNull(input.seccion),
    precio_neto: toNumberOrNull(input.precio_neto),
    precio_con_iva: toNumberOrNull(input.precio_con_iva),
    alicuota_iva: toNumberOrNull(input.alicuota_iva),
    moneda: toStringOrNull(input.moneda) ?? "ARS",
    unidad: toStringOrNull(input.unidad),
    fecha_vigencia: toStringOrNull(input.fecha_vigencia),
    raw_data: rawData,
  };
}

export function applyMapping(
  headers: string[],
  rows: ExtractedRow[],
  mapping: ColumnMapping
): CanonicalRow[] {
  return rows.map((row) => {
    const canonical: Partial<Record<CanonicalField, unknown>> = {};
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

    // seccion/marca pueden venir de una columna mapeada explícitamente, o
    // si no, de los campos especiales que dejan excel.ts (__hoja/__seccion)
    // y vision.ts (_seccion) al extraer.
    if (canonical.seccion === undefined) {
      canonical.seccion = row.__seccion ?? row._seccion;
    }
    if (canonical.marca === undefined) {
      canonical.marca = row.__hoja;
    }

    return normalizeCanonicalRow({ ...canonical, raw_data: rawData });
  });
}
