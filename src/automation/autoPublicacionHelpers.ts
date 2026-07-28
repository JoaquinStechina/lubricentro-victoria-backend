// Decide si una carga de auto-descarga puede publicarse sola: solo si el
// mapeo ya era conocido (confirmacion_pendiente — un mapeo recién sugerido
// por IA en revision_pendiente nunca se auto-publica, sin excepción) y no
// hay ninguna advertencia (ver detectarAdvertencias en advertencias.ts).
// Separado de autoPublicacion.ts (que sí toca Prisma/DB) para poder testear
// esta regla sin mockear la base — ver
// docs/superpowers/specs/2026-07-28-borur-auto-descarga-design.md.
export function debePublicarAutomaticamente(estado: string, cantidadAdvertencias: number): boolean {
  return estado === "confirmacion_pendiente" && cantidadAdvertencias === 0;
}
