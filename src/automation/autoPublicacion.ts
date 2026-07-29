// Se llama después de procesarCarga() para cargas creadas por un worker de
// auto-descarga (ABC o dropbox_directo) — nunca para cargas subidas a mano
// (ver Carga.origen en schema.prisma). procesarCarga() en sí no cambia: deja
// toda carga en confirmacion_pendiente/revision_pendiente, nunca completado
// por sí sola; esto es un paso extra encima, no un reemplazo. No se testea
// unitariamente (toca Prisma) — la regla de decisión sí está testeada en
// autoPublicacionHelpers.test.ts. Ver
// docs/superpowers/specs/2026-07-28-borur-auto-descarga-design.md.
import { prisma } from "../db.js";
import { detectarAdvertencias } from "../extraction/advertencias.js";
import { confirmarCargaYPublicar } from "../extraction/processCarga.js";
import { applyMapping } from "../extraction/mapping.js";
import type { ColumnMapping, ExtractedRow } from "../extraction/types.js";
import { debePublicarAutomaticamente, filasSonPublicables } from "./autoPublicacionHelpers.js";

// Devuelve true si la carga se publicó sola.
export async function intentarAutoPublicar(cargaId: number): Promise<boolean> {
  const carga = await prisma.carga.findUniqueOrThrow({ where: { id: cargaId } });
  if (carga.origen !== "auto_descarga") return false;
  if (!carga.proveedorId || !carga.filasExtraidas || !carga.mapeoSugerido) return false;
  // Chequeo barato antes de detectarAdvertencias (round-trip real a la DB):
  // ninguna carga en revision_pendiente puede auto-publicarse sin importar
  // cuántas advertencias tenga (ver debePublicarAutomaticamente), así que no
  // vale la pena pagar esa query para una carga que igual va a rechazarse.
  // Importa en particular al onboardear muchas marcas nuevas de una
  // (ej. BORUR), donde la primera corrida de cada marca siempre cae acá.
  if (carga.estado !== "confirmacion_pendiente") return false;

  const { headers, rows } = carga.filasExtraidas as unknown as {
    headers: string[];
    rows: ExtractedRow[];
  };
  const mapping = carga.mapeoSugerido as unknown as ColumnMapping;

  const advertencias = await detectarAdvertencias(carga.proveedorId, headers, rows, mapping);
  if (!debePublicarAutomaticamente(carga.estado, advertencias.length)) return false;

  const proveedor = await prisma.proveedor.findUniqueOrThrow({ where: { id: carga.proveedorId } });
  const canonicalRows = applyMapping(headers, rows, mapping, proveedor.alicuotaIvaDefault);
  // Chequeo de sanidad además de "sin advertencias" — ver el comentario de
  // filasSonPublicables para el caso real que lo motivó (mapeo parcial
  // reusado por casualidad entre marcas de un mismo proveedor).
  if (!filasSonPublicables(canonicalRows)) return false;
  await confirmarCargaYPublicar(cargaId, mapping, canonicalRows);
  return true;
}
