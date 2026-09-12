import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { app } from "../app.js";

export type Respuesta<T = any> = { status: number; body: T };

// Cliente mínimo contra la app real, levantada en un puerto efímero. Se
// testea por HTTP y no llamando a los handlers de Express directamente para
// que lo que se verifica sea el contrato que consume el frontend: status,
// JSON, y todo el middleware en el medio (json parser, manejo de errores).
export type ClienteApi = {
  get<T = any>(ruta: string): Promise<Respuesta<T>>;
  post<T = any>(ruta: string, body?: unknown): Promise<Respuesta<T>>;
  patch<T = any>(ruta: string, body?: unknown): Promise<Respuesta<T>>;
  cerrar(): Promise<void>;
};

export async function levantarApi(): Promise<ClienteApi> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  async function pedir<T>(metodo: string, ruta: string, body?: unknown): Promise<Respuesta<T>> {
    const res = await fetch(`${base}${ruta}`, {
      method: metodo,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const texto = await res.text();
    // Un 500 puede venir en HTML si el error escapó al handler de Express;
    // devolver el texto crudo hace que el assert falle con algo legible en vez
    // de con un "Unexpected token <".
    let parsed: unknown;
    try {
      parsed = texto ? JSON.parse(texto) : null;
    } catch {
      parsed = texto;
    }
    return { status: res.status, body: parsed as T };
  }

  return {
    get: (ruta) => pedir("GET", ruta),
    post: (ruta, body) => pedir("POST", ruta, body),
    patch: (ruta, body) => pedir("PATCH", ruta, body),
    cerrar: () => new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    ),
  };
}
