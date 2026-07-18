import type OpenAI from "openai";
import { getOpenRouterClient } from "../openrouter.js";
import { extractJsonObject } from "./llmJson.js";

// Mismo modelo que el mapeo de columnas: acá tampoco hace falta visión, es
// texto estructurado (la grilla de la hoja ya viene como celdas, no como
// imagen), así que reusamos OPENROUTER_MAPPING_MODEL en vez de sumar una
// variable de entorno más para una tarea de la misma naturaleza.
const FALLBACK_MODEL = process.env.OPENROUTER_MAPPING_MODEL || "anthropic/claude-sonnet-5";

// Alcanza con las primeras filas para ubicar el header, incluso en hojas
// con banners/notas antes de la tabla real; no hace falta mandar la hoja
// entera (ahorra tokens y evita el límite de contexto en hojas gigantes).
const MAX_SAMPLE_ROWS = 40;

const PROMPT = `Sos un asistente que ayuda a ubicar la fila de encabezado de una tabla de precios de un proveedor de repuestos automotores, dentro de una hoja de cálculo que un parser automático por reglas no pudo identificar (headers atípicos, sin palabras como "precio"/"importe" ni símbolos de moneda).

Te paso las primeras filas de la hoja como un array de arrays (cada sub-array es una fila, en el mismo orden, empezando en el índice 0).

Buscá la fila que contiene los NOMBRES de columna de una tabla de productos/precios (por ejemplo: código, producto, descripción, precio, cantidad — no importa el idioma exacto ni si están abreviados). Puede haber filas de notas, banners o títulos antes; ignoralas.

Devolvé ÚNICAMENTE un objeto JSON (sin texto antes ni después, sin markdown) con esta forma exacta:
{"headerRowIndex": <número de índice de la fila de header, o null si esta hoja no parece tener ninguna tabla de productos/precios (por ejemplo, es una hoja de notas o de índice)>}`;

// Último recurso cuando la heurística de excel.ts no encuentra ninguna
// señal de header en una hoja: le pedimos al LLM solo que ubique el índice
// de la fila de header (una tarea chica y barata), y reusamos la misma
// lógica determinística de excel.ts (buildTableFromHeaderIndex) para armar
// la tabla a partir de ahí — no le pedimos al modelo que lea ni transcriba
// los datos, eso ya lo hace bien y gratis el parser de la celda.
export async function findHeaderRowWithLLM(grid: unknown[][]): Promise<number | null> {
  const client = getOpenRouterClient();
  const sample = grid.slice(0, MAX_SAMPLE_ROWS);
  if (sample.length === 0) return null;

  const completion = (await client.chat.completions.create({
    model: FALLBACK_MODEL,
    max_tokens: 256,
    messages: [{ role: "user", content: `${PROMPT}\n\nFilas:\n${JSON.stringify(sample)}` }],
  })) as OpenAI.Chat.ChatCompletion;

  if (completion.usage) {
    const { prompt_tokens, completion_tokens, total_tokens } = completion.usage;
    console.log(
      `[tokens] excel-fallback model=${FALLBACK_MODEL} prompt=${prompt_tokens} completion=${completion_tokens} total=${total_tokens}`
    );
  }

  const text = completion.choices[0]?.message?.content;
  if (!text) return null;

  const parsed = JSON.parse(extractJsonObject(text)) as { headerRowIndex?: unknown };
  const index = parsed.headerRowIndex;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= grid.length) {
    return null;
  }
  return index;
}
