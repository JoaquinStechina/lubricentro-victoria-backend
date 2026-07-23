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

// columnaOrigen -> campoDestino. Las columnas no incluidas acá quedan en
// raw_data.
export type ColumnMapping = Record<string, CanonicalField>;

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
  // Calculado en la pantalla de revisión (ReviewTable.tsx) a partir de
  // precio_con_iva * porcentaje_ganancia, nunca mapeado desde una columna del
  // archivo — por eso no forma parte de CANONICAL_FIELDS/CanonicalField.
  precio_sugerido: number | null;
  raw_data: Record<string, unknown>;
};

// Shape que acepta confirmarCargaYPublicar (processCarga.ts) y
// normalizeCanonicalRow: los campos canónicos normales (mapeables desde una
// columna) más precio_sugerido, que viaja igual desde el frontend pero nunca
// es un CanonicalField (no aparece en el selector "Mapear columna a...").
export type CanonicalRowUpload = Partial<Record<CanonicalField, unknown>> & {
  raw_data?: unknown;
  precio_sugerido?: unknown;
};
