// Funciones puras del worker de descarga directa (ver dropboxAutoDescarga.ts
// para la orquestación con fetch/Prisma, que no se testea unitariamente: no
// hay forma de mockear Dropbox real en CI. Se verifica a mano contra el link
// real de BORUR — ver docs/superpowers/specs/2026-07-28-borur-auto-descarga-design.md).
import type { ExtractedRow } from "../extraction/types.js";

// Dropbox sirve la página de vista previa con dl=0 (o sin el parámetro) y el
// archivo crudo con dl=1.
export function dropboxDirectUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.set("dl", "1");
  return u.toString();
}

// Nombre del archivo físico compartido por todas las marcas de un mismo
// proveedor "dropbox_directo" (a diferencia de ABC, donde cada marca
// descarga su propio archivo por separado).
export function nombreArchivoCompartido(proveedorNombre: string, timestamp: number, extension: string): string {
  const slug = proveedorNombre.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${timestamp}_${slug}.${extension}`;
}

// Filtra la extracción combinada (todas las hojas) a una sola hoja/marca, y
// recalcula los headers como las columnas que efectivamente tienen algún
// dato en ese subconjunto (mismo criterio que headersConDatos en excel.ts:
// una columna que solo tiene datos en otras hojas no aporta nada acá y solo
// ensuciaría el mapeo).
export function filtrarPorHoja(
  headers: string[],
  rows: ExtractedRow[],
  hoja: string
): { headers: string[]; rows: ExtractedRow[] } {
  const hojaObjetivo = hoja.trim();
  const filtradas = rows.filter((r) => typeof r.__hoja === "string" && r.__hoja.trim() === hojaObjetivo);

  const headerSet = new Set<string>();
  for (const row of filtradas) {
    for (const h of headers) {
      const valor = row[h];
      if (valor !== null && valor !== undefined && valor !== "") headerSet.add(h);
    }
  }

  return { headers: Array.from(headerSet), rows: filtradas };
}

export type FilaParaCargaDropbox = {
  proveedorId: number;
  marca: string;
  porcentajeGanancia: number | null;
};

// A diferencia de datosNuevaCarga (abcAutoDescargaHelpers.ts), acá
// filasExtraidas viene pre-cargado: el archivo físico es compartido por
// todas las marcas del proveedor, así que procesarCarga() no debe volver a
// parsearlo entero (recombinaría las otras hojas bajo esta misma carga) —
// usa directamente este subconjunto ya filtrado por filtrarPorHoja.
export function datosNuevaCargaDropbox(
  fila: FilaParaCargaDropbox,
  nombreArchivo: string,
  rutaArchivo: string,
  tipoArchivo: string,
  filasExtraidas: { headers: string[]; rows: ExtractedRow[] }
) {
  return {
    proveedorId: fila.proveedorId,
    nombreArchivo,
    rutaArchivo,
    tipoArchivo,
    tipoDatos: "catalogo",
    estado: "pendiente",
    origen: "auto_descarga",
    porcentajeGananciaDefault: fila.porcentajeGanancia,
    filasExtraidas,
  };
}
