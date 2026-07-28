// Schema canónico destino (ver contexto.md). `proveedor` no está acá porque
// ya viene fijado por la Carga (proveedorId), no se mapea columna a columna.
export const CANONICAL_FIELDS = [
  "marca",
  "sku_proveedor",
  "sku_interno",
  "descripcion",
  "seccion",
  "precio_neto",
  "precio_con_iva",
  "precio_lista",
  "alicuota_iva",
  "moneda",
  "unidad",
  "fecha_vigencia",
] as const;

export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

export type ExtractedRow = Record<string, unknown>;

export type ExtractedTable = {
  hoja: string;
  headers: string[];
  rows: ExtractedRow[];
};

// columnaOrigen -> lista de campoDestino. Antes era Record<string,
// CanonicalField> (una columna, un solo destino) — pasa a array para poder
// mapear una misma columna a más de un campo canónico a la vez (ej. una
// columna "Precio" que alimenta precio_lista Y precio_neto). Un array de un
// solo elemento es el caso de siempre, sin cambio de comportamiento. Las
// columnas no incluidas acá quedan en raw_data.
export type ColumnMapping = Record<string, CanonicalField[]>;

export type CanonicalRow = {
  marca: string | null;
  sku_proveedor: string | null;
  sku_interno: string | null;
  descripcion: string | null;
  seccion: string | null;
  precio_neto: number | null;
  precio_con_iva: number | null;
  precio_lista: number | null;
  alicuota_iva: number | null;
  moneda: string | null;
  unidad: string | null;
  fecha_vigencia: string | null;
  // Calculados en la pantalla de revisión (ReviewTable.tsx), nunca mapeados
  // desde una columna del archivo — por eso no forman parte de
  // CANONICAL_FIELDS/CanonicalField:
  // - precio_con_iva ya es un CanonicalField mapeable, pero si además se
  //   mapea la columna "IVA" (alicuota_iva), ReviewTable.tsx lo recalcula
  //   como precio_neto + precio_neto * alicuota_iva / 100 (salvo que el
  //   usuario haya corregido esa celda a mano).
  // - precio_lista_con_iva es igual pero a partir de precio_lista, y nunca
  //   se mapea directamente (no tiene sentido sin precio_lista + IVA).
  precio_lista_con_iva: number | null;
  // Calculado a partir de precio_con_iva * porcentaje_ganancia.
  precio_sugerido: number | null;
  raw_data: Record<string, unknown>;
};

// Shape que acepta confirmarCargaYPublicar (processCarga.ts) y
// normalizeCanonicalRow: los campos canónicos normales (mapeables desde una
// columna) más los calculados en la pantalla de revisión (precio_sugerido,
// precio_lista_con_iva), que viajan igual desde el frontend pero nunca son
// un CanonicalField (no aparecen en el selector "Mapear columna a...").
export type CanonicalRowUpload = Partial<Record<CanonicalField, unknown>> & {
  raw_data?: unknown;
  precio_sugerido?: unknown;
  precio_lista_con_iva?: unknown;
};
