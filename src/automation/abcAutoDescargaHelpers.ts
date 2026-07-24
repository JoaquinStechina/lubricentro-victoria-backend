// Funciones puras del worker de auto-descarga (ver abcAutoDescarga.ts para
// la orquestación con Playwright + Prisma, que no se testea unitariamente:
// no hay forma de mockear un sitio de terceros en CI, se verifica a mano
// contra el portal real — ver el spec, sección Testing).

import crypto from "node:crypto";
import type { ExtractedRow } from "../extraction/types.js";

// El .xlsx que exporta el portal trae metadata interna (nombre de hoja con
// timestamp propio, ej. "ABC_AP_1784913938678.xlsx") que cambia en cada
// descarga aunque los precios sean exactamente los mismos — confirmado
// descargando la misma marca dos veces seguidas y comparando el contenido
// parseado (idéntico fila por fila) contra el hash del archivo crudo
// (distinto). Por eso se hashea el contenido ya extraído (headers+filas),
// no los bytes del archivo, y se excluye `__hoja` (que combineTables llena
// con ese mismo nombre de hoja variable) de cada fila antes de hashear.
// `__seccion` sí se conserva: es agrupación real derivada del contenido de
// la hoja, no un artefacto de exportación (ver excel.ts).
export function hashContenidoExtraido(headers: string[], rows: ExtractedRow[]): string {
  const rowsParaHash = rows.map(({ __hoja, ...resto }) => resto);
  return crypto.createHash("sha256").update(JSON.stringify({ headers, rows: rowsParaHash })).digest("hex");
}

export function decidirAccion(
  hashNuevo: string,
  hashAnterior: string | null
): "sin_cambios" | "crear_carga" {
  return hashNuevo === hashAnterior ? "sin_cambios" : "crear_carga";
}

// Nombre propio para el archivo guardado en uploads/: el nombre que da el
// portal de ABC (ej. "ABC_AP_1784828962635.xlsx") no identifica la marca.
export function nombreArchivoDescarga(marca: string, timestamp: number): string {
  const marcaSlug = marca.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${timestamp}_ABC_${marcaSlug}.xlsx`;
}

// ultimoResultado es VARCHAR(191); los errores de Playwright suelen traer
// un "Call log:" de varias líneas que lo excede largo, lo que haría fallar
// el propio update() y (en el loop por marca) tumbaría la corrida entera.
// 170 es el máximo que deja el string final dentro de VARCHAR(191) incluso
// con el prefijo más largo, "error: login falló - " (21 caracteres): es un
// límite exacto, no un margen.
export const MAX_LARGO_RESULTADO = 170;

export function truncarMensaje(mensaje: string): string {
  return mensaje.length > MAX_LARGO_RESULTADO ? mensaje.slice(0, MAX_LARGO_RESULTADO) : mensaje;
}

export type FilaParaCarga = {
  proveedorId: number;
  marca: string;
  porcentajeGanancia: number | null;
};

// Datos para prisma.carga.create al detectar un archivo nuevo/distinto.
// porcentajeGananciaDefault viaja tal cual desde la fila de AutoDescargaMarca
// (ver Carga.porcentajeGananciaDefault en schema.prisma y ReviewTable.tsx).
export function datosNuevaCarga(fila: FilaParaCarga, nombreArchivo: string, rutaArchivo: string) {
  return {
    proveedorId: fila.proveedorId,
    nombreArchivo,
    rutaArchivo,
    tipoArchivo: "xlsx",
    tipoDatos: "catalogo",
    estado: "pendiente",
    porcentajeGananciaDefault: fila.porcentajeGanancia,
  };
}
