import * as XLSX from "xlsx";
import { findHeaderRowWithLLM } from "./excelLlmFallback.js";
import type { ExtractedRow, ExtractedTable } from "./types.js";

// Heurística de detección de header y secciones, portada de la lógica
// descripta en contexto.md (script de parseo original en Python/pandas):
// busca la fila que parezca header por señal de precio/moneda, excluye
// filas banner (pocas celdas, texto largo tipo "PRECIOS EN PESOS - SIN
// IVA"), y entre candidatas prefiere la que tenga menos celdas numéricas
// (más "texto de columna", menos "fila de datos que se repite"). También
// detecta filas de encabezado de sección (precio nulo, poco contenido) y
// las propaga como `seccion` a los productos siguientes.

function normalizeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function countNonEmpty(row: unknown[]): number {
  return row.filter((c) => normalizeCell(c) !== "").length;
}

// Además de números "de verdad" (celda tipo number), algunos proveedores
// exportan los precios como texto con formato de moneda (ej. "$ 1.234,56").
// Sin contemplar esto, esas hojas quedaban indistinguibles entre la fila de
// header y una fila de datos para el desempate de countNumeric.
const NUMERIC_TEXT = /^(u\$s|us\$|ars|\$)?\s*\d{1,3}(\.\d{3})*(,\d+)?\s*(u\$s|usd|ars)?$/i;

function looksNumericText(value: unknown): boolean {
  if (typeof value === "number") return true;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed !== "" && NUMERIC_TEXT.test(trimmed);
}

function countNumeric(row: unknown[]): number {
  return row.filter(looksNumericText).length;
}

function looksLikeBanner(row: unknown[]): boolean {
  const nonEmpty = countNonEmpty(row);
  if (nonEmpty === 0 || nonEmpty > 2) return false;
  return row.some((c) => normalizeCell(c).length > 15);
}

// Ampliado más allá de "precio"/"$" literal: proveedores nuevos pueden
// llamar a la columna de precio "importe", "tarifa", "valor", "monto",
// "costo", o directamente poner el monto en dólares ("u$s"/"usd") sin decir
// "precio" en ningún lado.
const PRECIO_KEYWORDS = /precio|importe|tarifa|valor|monto|costo/;
const MONEDA_KEYWORDS = /\$|u\$s|usd|ars\b/;

function headerSignal(row: unknown[]): "precio" | "moneda" | null {
  const text = row.map(normalizeCell).join(" | ").toLowerCase();
  if (PRECIO_KEYWORDS.test(text)) return "precio";
  if (MONEDA_KEYWORDS.test(text)) return "moneda";
  return null;
}

function findHeaderRowIndex(grid: unknown[][]): number | null {
  const candidates = grid
    .map((row, index) => ({ row: row ?? [], index }))
    .filter(({ row }) => countNonEmpty(row) > 0 && !looksLikeBanner(row));

  const conPrecio = candidates.filter(({ row }) => headerSignal(row) === "precio");
  const conMoneda = candidates.filter(({ row }) => headerSignal(row) === "moneda");
  const pool = conPrecio.length > 0 ? conPrecio : conMoneda;
  if (pool.length === 0) return null;

  pool.sort((a, b) => countNumeric(a.row) - countNumeric(b.row));
  return pool[0].index;
}

function uniqueHeaders(rawHeaders: unknown[]): string[] {
  const seen = new Map<string, number>();
  return rawHeaders.map((h, i) => {
    const base = normalizeCell(h) || `col_${i}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

function rowsEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => normalizeCell(v) === normalizeCell(b[i]));
}

function isSectionRow(row: unknown[]): boolean {
  const nonEmpty = countNonEmpty(row);
  return nonEmpty > 0 && nonEmpty <= 2;
}

// Arma la tabla a partir de un índice de header ya conocido. Separado de la
// detección del header para poder reusar esta misma lógica tanto desde la
// heurística determinística como desde el fallback de IA
// (excelLlmFallback.ts), que solo se ocupa de encontrar el índice cuando la
// heurística no reconoce ninguna señal.
export function buildTableFromHeaderIndex(
  sheetName: string,
  grid: unknown[][],
  headerIndex: number
): ExtractedTable | null {
  const headerRow = grid[headerIndex] ?? [];
  const headers = uniqueHeaders(headerRow);

  const rows: ExtractedRow[] = [];
  let seccionActual: string | null = null;

  for (let i = headerIndex + 1; i < grid.length; i++) {
    const row = grid[i] ?? [];
    if (countNonEmpty(row) === 0) continue;
    if (rowsEqual(row, headerRow)) continue; // header repetido (salto de página)

    if (isSectionRow(row)) {
      const texto = row.map(normalizeCell).find((c) => c !== "");
      if (texto) seccionActual = texto;
      continue;
    }

    const entry: ExtractedRow = { __hoja: sheetName, __seccion: seccionActual };
    headers.forEach((h, idx) => {
      entry[h] = row[idx] ?? null;
    });
    rows.push(entry);
  }

  if (rows.length === 0) return null;

  // SheetJS a veces devuelve la grilla con el ancho declarado de la hoja,
  // que puede incluir cientos de columnas vacías al final (archivos xls
  // viejos con un `!ref` más ancho que los datos reales). Esas columnas no
  // aportan nada y solo ensucian el mapeo, así que se descartan.
  const headersConDatos = headers.filter((h) =>
    rows.some((r) => normalizeCell(r[h]) !== "")
  );

  return { hoja: sheetName, headers: headersConDatos, rows };
}

function extractSheetDeterministic(sheetName: string, grid: unknown[][]): ExtractedTable | null {
  const headerIndex = findHeaderRowIndex(grid);
  if (headerIndex === null) return null;
  return buildTableFromHeaderIndex(sheetName, grid, headerIndex);
}

function sheetToGrid(sheet: XLSX.WorkSheet): unknown[][] {
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: true });
}

export function readWorkbookGrids(buffer: Buffer): { sheetName: string; grid: unknown[][] }[] {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  return workbook.SheetNames.map((sheetName) => ({
    sheetName,
    grid: sheetToGrid(workbook.Sheets[sheetName]),
  }));
}

// Solo la heurística determinística, sin IA — la usa extractExcelWithFallback
// (processCarga.ts) como primer intento, y queda disponible sola para quien
// necesite el comportamiento 100% determinístico (ej. tests).
export function extractExcel(buffer: Buffer): ExtractedTable[] {
  const tables: ExtractedTable[] = [];
  for (const { sheetName, grid } of readWorkbookGrids(buffer)) {
    const table = extractSheetDeterministic(sheetName, grid);
    if (table) tables.push(table);
  }
  return tables;
}

// Igual que extractExcel, pero cuando la heurística no encuentra header en
// una hoja, antes de descartarla le pide al LLM que ubique la fila (ver
// excelLlmFallback.ts) en vez de rendirse. Es lo que usa processCarga.ts.
export async function extractExcelWithFallback(buffer: Buffer): Promise<ExtractedTable[]> {
  const tables: ExtractedTable[] = [];

  for (const { sheetName, grid } of readWorkbookGrids(buffer)) {
    const deterministic = extractSheetDeterministic(sheetName, grid);
    if (deterministic) {
      tables.push(deterministic);
      continue;
    }

    const headerIndex = await findHeaderRowWithLLM(grid);
    if (headerIndex === null) continue;

    const assisted = buildTableFromHeaderIndex(sheetName, grid, headerIndex);
    if (assisted) tables.push(assisted);
  }

  return tables;
}

export function combineTables(tables: ExtractedTable[]): {
  headers: string[];
  rows: ExtractedRow[];
} {
  const headerSet = new Set<string>();
  const rows: ExtractedRow[] = [];
  for (const table of tables) {
    table.headers.forEach((h) => headerSet.add(h));
    rows.push(...table.rows);
  }
  return { headers: Array.from(headerSet), rows };
}
