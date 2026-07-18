// El LLM a veces envuelve el JSON pedido con texto o markdown alrededor
// aunque se le pida que no lo haga; esto lo recorta antes de parsear.
export function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("El modelo no devolvió un JSON reconocible.");
  return trimmed.slice(start, end + 1);
}
