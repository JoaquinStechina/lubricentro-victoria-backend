import { prisma } from "../db.js";
import { getOpenRouterClient } from "../openrouter.js";
import { extractJsonObject } from "./llmJson.js";
import {
  CANONICAL_FIELDS,
  type CanonicalField,
  type CanonicalRow,
  type CanonicalRowUpload,
  type ColumnMapping,
  type ExtractedRow,
} from "./types.js";

const MAPPING_MODEL = process.env.OPENROUTER_MAPPING_MODEL || "anthropic/claude-sonnet-5";

const MAX_SAMPLE_ROWS = 60;

// Antes se mandaban las primeras 5 filas de `sampleRows` sin más: para un
// archivo de una sola hoja alcanza, pero en archivos con muchas hojas de
// layout distinto (ej. BOR&UR, 43 hojas — ver contexto.md) esas 5 filas son
// casi siempre de la primera hoja nada más, así que las columnas exclusivas
// de las hojas 2..43 le llegaban al LLM sin ningún dato de ejemplo (todo
// `null`), y terminaba adivinando el mapeo solo por el nombre de columna.
// Agrupamos por `__hoja` (lo deja excel.ts en cada fila, ver mapping.ts más
// abajo) para asegurar que toda hoja aporte al menos una fila de muestra.
export function buildRepresentativeSample(
  headers: string[],
  rows: ExtractedRow[],
  cap = MAX_SAMPLE_ROWS
): ExtractedRow[] {
  const grupos = new Map<string, ExtractedRow[]>();
  for (const row of rows) {
    const clave = typeof row.__hoja === "string" ? row.__hoja : "";
    const grupo = grupos.get(clave);
    if (grupo) grupo.push(row);
    else grupos.set(clave, [row]);
  }

  // Con pocas hojas priorizamos profundidad (más filas por hoja, mejor
  // contexto); con muchas priorizamos amplitud (al menos 1 por hoja para no
  // dejar ninguna sin representar, aunque eso implique superar el cap).
  const porGrupo = grupos.size <= 5 ? 5 : Math.max(1, Math.floor(cap / grupos.size));

  const muestra: ExtractedRow[] = [];
  for (const filasGrupo of grupos.values()) {
    muestra.push(...filasGrupo.slice(0, porGrupo));
  }
  return muestra;
}

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

  const muestra = buildRepresentativeSample(headers, sampleRows).map((row) => {
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
- "precio_lista" es el precio de lista/sugerido de fábrica del proveedor, no necesariamente el que paga el cliente — distinto de "precio_neto" (sin IVA) y "precio_con_iva" (con IVA).
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
  const limpio = String(value).replace(/[^\d,.-]/g, "");
  const tieneComa = limpio.includes(",");
  const puntos = (limpio.match(/\./g) ?? []).length;

  let normalizado: string;
  if (tieneComa) {
    // La coma marca los decimales sin ambigüedad -> todo "." es separador
    // de miles.
    normalizado = limpio.replace(/\./g, "").replace(",", ".");
  } else if (puntos > 1) {
    // Más de un "." sin coma: un número real nunca tiene dos puntos
    // decimales, así que solo puede ser miles agrupados ("1.234.567").
    normalizado = limpio.replace(/\./g, "");
  } else if (/^-?\d{1,3}\.\d{3}$/.test(limpio)) {
    // Único "." con exactamente 3 dígitos a cada lado del rango típico de
    // miles ("1.985"). Es ambiguo en abstracto (podría ser 1985 o 1.985),
    // pero un separador de miles real agrupa desde el final del entero, así
    // que la parte antes del punto tiene que tener como máximo 3 dígitos
    // -si tuviera más, harían falta más puntos, como en "101.243.285"-.
    // Con 4+ dígitos antes del único punto (ej. "101243.285", precio real
    // con 3 decimales) no puede ser miles y se deja como decimal.
    normalizado = limpio.replace(".", "");
  } else {
    normalizado = limpio;
  }

  const n = Number(normalizado);
  return Number.isFinite(n) ? n : null;
}

// Arma un CanonicalRow completo (con parseo tolerante de números/strings) a
// partir de un objeto parcial con los campos canónicos. La usan tanto
// applyMapping (con valores recién resueltos del mapeo) como
// confirmarCargaYPublicar en processCarga.ts (con filas ya editadas a mano
// por un humano en el frontend) — mismo parseo tolerante en los dos casos,
// sin duplicarlo.
export function normalizeCanonicalRow(input: CanonicalRowUpload): CanonicalRow {
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
    precio_lista: toNumberOrNull(input.precio_lista),
    alicuota_iva: toNumberOrNull(input.alicuota_iva),
    moneda: toStringOrNull(input.moneda) ?? "ARS",
    unidad: toStringOrNull(input.unidad),
    fecha_vigencia: toStringOrNull(input.fecha_vigencia),
    // No es un CanonicalField (no se mapea desde una columna del archivo):
    // llega ya calculado desde ReviewTable.tsx a partir del % de ganancia.
    precio_sugerido: toNumberOrNull(input.precio_sugerido),
    raw_data: rawData,
  };
}

// Si dos o más columnas de origen apuntan al mismo campo destino (ej.
// "Producto" y "Envase" -> descripcion), se concatenan en el orden en que
// aparecen en `headers`, separadas por espacio, salteando valores vacíos.
function combinarValores(valores: unknown[]): string {
  return valores
    .map((v) => (v === null || v === undefined ? "" : String(v).trim()))
    .filter((v) => v !== "")
    .join(" ");
}

export function applyMapping(
  headers: string[],
  rows: ExtractedRow[],
  mapping: ColumnMapping
): CanonicalRow[] {
  return rows.map((row) => {
    const valoresPorDestino = new Map<CanonicalField, unknown[]>();
    const rawData: Record<string, unknown> = {};

    for (const h of headers) {
      const destino = mapping[h];
      const valor = row[h];
      if (destino) {
        const lista = valoresPorDestino.get(destino) ?? [];
        lista.push(valor);
        valoresPorDestino.set(destino, lista);
      } else if (valor !== null && valor !== undefined && valor !== "") {
        rawData[h] = valor;
      }
    }

    const canonical: Partial<Record<CanonicalField, unknown>> = {};
    for (const [destino, valores] of valoresPorDestino) {
      // Una sola columna mapeada: se deja el valor crudo tal cual (puede ser
      // number) para no cambiar el comportamiento existente. Dos o más: se
      // combinan como texto.
      canonical[destino] = valores.length === 1 ? valores[0] : combinarValores(valores);
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
