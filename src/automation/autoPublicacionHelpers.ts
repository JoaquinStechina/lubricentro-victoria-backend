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

// Chequeo de sanidad mínimo antes de auto-publicar, además de "sin
// advertencias" (detectarAdvertencias solo mira precio<=0, SKU duplicado y
// salto de precio — nada de esto detecta un producto con SKU/descripción
// vacíos). Hace falta porque MapeoColumna es por proveedor, no por marca: un
// proveedor con muchas hojas/marcas en un solo archivo (ej. BORUR) puede
// tener un mapeo guardado de OTRA marca cuyos nombres de columna coinciden
// por casualidad con los de esta, y ese mapeo parcial alcanza para que
// procesarCarga la deje en confirmacion_pendiente sin que ningún header
// realmente relevante (ej. el código de producto) haya sido mapeado -
// confirmado en vivo: la primera corrida de Tecfil (BORUR) se auto-publicó
// con 1675 productos sin sku_proveedor ni sku_interno, ninguno detectado
// por detectarAdvertencias. No exige sku_proveedor específicamente (Silisur
// y Tribuno no lo tienen por diseño): alcanza con que la fila tenga ALGÚN
// identificador (sku_proveedor o sku_interno), una descripción, y algún
// precio.
export function filasSonPublicables(
  rows: Array<{
    sku_proveedor: unknown;
    sku_interno: unknown;
    descripcion: unknown;
    precio_neto: unknown;
    precio_con_iva: unknown;
    precio_lista: unknown;
  }>
): boolean {
  return rows.every(
    (r) =>
      (r.sku_proveedor != null || r.sku_interno != null) &&
      r.descripcion != null &&
      (r.precio_neto != null || r.precio_con_iva != null || r.precio_lista != null)
  );
}
