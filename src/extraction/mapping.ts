import { prisma } from "../db.js";
import { getOpenRouterClient } from "../openrouter.js";
import { roundTo2 } from "../lib/numeros.js";
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
  // tipoDatos: "catalogo" explícito — antes esta query traía también los
  // mapeos de "oferta" del mismo proveedor (bug preexistente: si una columna
  // se llamaba igual en catálogo y en ofertas con destino distinto, podía
  // devolver el que no correspondía). getExistingMappingOferta ya filtraba
  // bien (ver mappingOfertas.ts); esto lo alinea.
  const guardados = await prisma.mapeoColumna.findMany({
    where: { proveedorId, tipoDatos: "catalogo" },
  });
  if (guardados.length === 0) return null;

  const mapping: ColumnMapping = {};
  let coincidencias = 0;
  for (const h of headers) {
    const encontrados = guardados.filter((g) => g.columnaOrigen === h);
    if (encontrados.length > 0) {
      mapping[h] = encontrados.map((g) => g.campoDestino as CanonicalField);
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
    // El LLM solo sugiere un destino por columna (ver prompt arriba) — se
    // envuelve en un array de un elemento para calzar con ColumnMapping. Un
    // segundo destino, si hace falta, lo agrega un humano en la revisión.
    if (isCanonicalField(destino)) mapping[columna] = [destino];
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
    // roundTo2 acá, no dentro de toNumberOrNull: el parseo tiene que
    // preservar la precisión real del string de origen para interpretar
    // bien miles/decimales (ver tests de toNumberOrNull) — el redondeo a 2
    // decimales es una regla de negocio sobre el valor ya parseado.
    precio_neto: roundTo2(toNumberOrNull(input.precio_neto)),
    precio_con_iva: roundTo2(toNumberOrNull(input.precio_con_iva)),
    precio_lista: roundTo2(toNumberOrNull(input.precio_lista)),
    alicuota_iva: roundTo2(toNumberOrNull(input.alicuota_iva)),
    moneda: toStringOrNull(input.moneda) ?? "ARS",
    unidad: toStringOrNull(input.unidad),
    fecha_vigencia: toStringOrNull(input.fecha_vigencia),
    // Ninguno de los dos es un CanonicalField (no se mapean desde una
    // columna del archivo): llegan ya calculados desde ReviewTable.tsx.
    precio_lista_con_iva: roundTo2(toNumberOrNull(input.precio_lista_con_iva)),
    precio_sugerido: roundTo2(toNumberOrNull(input.precio_sugerido)),
    raw_data: rawData,
  };
}

// Columnas que representan un código: al combinar varias columnas de origen
// en este destino, se unen sin separador (reconstruye un código partido en
// dos columnas, ej. "AB" + "1234" -> "AB1234"). El resto de los campos
// (descripción, etc.) sigue uniéndose con espacio.
const CAMPOS_CODIGO: ReadonlySet<CanonicalField> = new Set(["sku_interno", "sku_proveedor"]);

// Campos numéricos: nunca tiene sentido "combinarlos" concatenando texto (a
// diferencia de descripción, no hay una noción razonable de "unir" dos
// precios). Mapear el mismo campo de precio a dos columnas de origen casi
// siempre es un error de configuración del mapeo, no una combinación
// intencional — y concatenarlos es particularmente peligroso acá: toNumberOrNull
// limpia espacios antes de parsear, así que dos precios con decimales
// terminan mezclados en un solo entero gigante (ver mapping.test.ts, caso
// real: ABC tuvo "PRECIO LISTA C/IVA" + "PRECIO NETO CON IVA" mapeadas juntas
// a precio_con_iva y publicó precios de miles de millones de pesos).
export const CAMPOS_NUMERICOS: ReadonlySet<CanonicalField> = new Set([
  "precio_neto",
  "precio_con_iva",
  "precio_lista",
  "alicuota_iva",
]);

// Si dos o más columnas de origen apuntan al mismo campo destino (ej.
// "Producto" y "Envase" -> descripcion), se concatenan en el orden en que
// aparecen en `headers`, salteando valores vacíos.
function combinarValores(destino: CanonicalField, valores: unknown[]): string {
  const limpios = valores
    .map((v) => (v === null || v === undefined ? "" : String(v).trim()))
    .filter((v) => v !== "");
  return limpios.join(CAMPOS_CODIGO.has(destino) ? "" : " ");
}

// Para un campo numérico con más de una columna mapeada: nos quedamos con el
// primer valor no vacío en vez de concatenar (ver CAMPOS_NUMERICOS). No hay
// forma de saber cuál de las columnas es "la correcta" en este punto — eso
// se le avisa al humano como advertencia (ver detectarMapeoConflictivo en
// advertencias.ts), esto es solo la red de seguridad para no corromper el
// número mientras tanto.
function primerValorNoVacio(valores: unknown[]): unknown {
  return valores.find((v) => v !== null && v !== undefined && v !== "") ?? valores[0];
}

export function applyMapping(
  headers: string[],
  rows: ExtractedRow[],
  mapping: ColumnMapping,
  // Fallback cuando la fila no tiene columna de IVA mapeada (ver
  // Proveedor.alicuotaIvaDefault en schema.prisma). undefined/null = no
  // inventar nada, comportamiento de siempre.
  alicuotaIvaDefault?: number | null
): CanonicalRow[] {
  return rows.map((row) => {
    const valoresPorDestino = new Map<CanonicalField, unknown[]>();
    const rawData: Record<string, unknown> = {};

    for (const h of headers) {
      const destinos = mapping[h];
      const valor = row[h];
      if (destinos && destinos.length > 0) {
        for (const destino of destinos) {
          const lista = valoresPorDestino.get(destino) ?? [];
          lista.push(valor);
          valoresPorDestino.set(destino, lista);
        }
      } else if (valor !== null && valor !== undefined && valor !== "") {
        rawData[h] = valor;
      }
    }

    const canonical: Partial<Record<CanonicalField, unknown>> = {};
    for (const [destino, valores] of valoresPorDestino) {
      // Una sola columna mapeada: se deja el valor crudo tal cual (puede ser
      // number) para no cambiar el comportamiento existente. Dos o más: se
      // combinan como texto, salvo un campo numérico (ver CAMPOS_NUMERICOS),
      // que nunca se concatena.
      if (valores.length === 1) {
        canonical[destino] = valores[0];
      } else if (CAMPOS_NUMERICOS.has(destino)) {
        canonical[destino] = primerValorNoVacio(valores);
      } else {
        canonical[destino] = combinarValores(destino, valores);
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

    const normalizado = normalizeCanonicalRow({ ...canonical, raw_data: rawData });
    return aplicarAlicuotaIvaDefault(normalizado, alicuotaIvaDefault);
  });
}

// Extraído para reusar el mismo fallback en confirmarCargaYPublicar
// (processCarga.ts) — la confirmación manual desde ReviewTable.tsx no pasa
// por applyMapping (recibe las filas ya armadas por el frontend), así que
// sin esto el default de IVA por proveedor solo se aplicaría en el camino
// de auto-publicación, nunca cuando un humano confirma a mano (el camino
// más común). undefined/null = no inventar nada, comportamiento de siempre.
export function aplicarAlicuotaIvaDefault<T extends { alicuota_iva: number | null }>(
  row: T,
  alicuotaIvaDefault?: number | null
): T {
  if (row.alicuota_iva === null && alicuotaIvaDefault != null) {
    return { ...row, alicuota_iva: roundTo2(alicuotaIvaDefault) };
  }
  return row;
}
