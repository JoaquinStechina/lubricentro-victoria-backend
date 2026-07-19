// Schema canónico destino para ofertas (ver contexto.md, sección "Schema
// canónico (ofertas)", y docs/plan-ofertas.md). Paralelo a types.ts, no una
// generalización de CANONICAL_FIELDS: el shape es distinto (marca/n° oferta/
// fecha/hora son obligatorios acá, y "sección" no existe).
export const CANONICAL_FIELDS_OFERTAS = [
  "marca",
  "numero_oferta",
  "sku_proveedor",
  "descripcion",
  "desde_cantidad",
  "descuento_pct",
  "precio_unitario",
  "moneda",
  "fecha_oferta",
  "hora_oferta",
  "fecha_hasta",
] as const;

export type OfertaField = (typeof CANONICAL_FIELDS_OFERTAS)[number];

// columnaOrigen -> campoDestino. Igual que ColumnMapping en types.ts pero
// contra los campos de oferta.
export type OfertaColumnMapping = Record<string, OfertaField>;

// Marca/n° de oferta/fecha/hora "de todo el archivo" (ver plan-ofertas.md,
// punto 2): normalmente no son una columna de la tabla, sino un dato del
// banner o del nombre de archivo. Se auto-detectan por IA (ver
// ofertaMetadata.ts) y quedan editables por el usuario antes de confirmar.
// Se usan como fallback en applyMappingOfertas solo para las filas donde el
// campo correspondiente no vino de una columna mapeada.
export type OfertaMetadata = {
  marca?: string | null;
  numero_oferta?: string | null;
  fecha_oferta?: string | null;
  hora_oferta?: string | null;
  // Vencimiento de la oferta (YYYY-MM-DD), si el archivo/banner lo declara
  // con una fecha concreta ("válida todo julio"). null = sin fecha fija
  // ("hasta agotar stock") — se cierra manualmente, no expira solo.
  fecha_hasta?: string | null;
};

// Fila ya resuelta (mapeo aplicado + fallback de metadata) pero antes de
// validar que los campos obligatorios estén completos — puede tener nulls
// mientras el usuario todavía la está corrigiendo en la pantalla de
// revisión. La validación final ocurre recién al confirmar (ver
// processCarga.ts), igual que CanonicalRow permite nulls hasta el momento
// de insertar.
export type OfertaRowNormalized = {
  marca: string | null;
  numero_oferta: number | null;
  sku_proveedor: string | null;
  descripcion: string | null;
  desde_cantidad: number | null;
  descuento_pct: number | null;
  precio_unitario: number | null;
  moneda: string | null;
  fecha_oferta: string | null;
  hora_oferta: string | null;
  fecha_hasta: string | null;
  raw_data: Record<string, unknown>;
};
