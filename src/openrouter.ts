import OpenAI from "openai";

let client: OpenAI | null = null;

// OpenRouter expone una API compatible con la de OpenAI (Chat Completions),
// así que reusamos el SDK oficial de OpenAI apuntando a otro baseURL en vez
// de instalar un cliente aparte.
export function getOpenRouterClient(): OpenAI {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error(
      "Falta OPENROUTER_API_KEY en el entorno. Es necesaria para extraer PDF/PNG y para sugerir el mapeo de columnas de proveedores nuevos."
    );
  }
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        // Opcionales: OpenRouter los usa solo para mostrar la app en su
        // ranking público, no afectan el funcionamiento si se omiten.
        ...(process.env.OPENROUTER_SITE_URL ? { "HTTP-Referer": process.env.OPENROUTER_SITE_URL } : {}),
        ...(process.env.OPENROUTER_APP_NAME ? { "X-Title": process.env.OPENROUTER_APP_NAME } : {}),
      },
    });
  }
  return client;
}
