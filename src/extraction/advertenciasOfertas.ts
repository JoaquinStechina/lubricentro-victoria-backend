import { prisma } from "../db.js";
import { applyMappingOfertas } from "./mappingOfertas.js";
import { OFERTA_REQUIRED_FIELDS } from "./processCarga.js";
import { SALTO_PRECIO_UMBRAL, type Advertencia } from "./advertencias.js";
import type { ExtractedRow } from "./types.js";
import type { OfertaColumnMapping, OfertaMetadata } from "./typesOfertas.js";

export type { Advertencia };

// Paralelo a advertencias.ts (mismo criterio del proyecto: funciones
// paralelas para catálogo/ofertas, no una abstracción genérica — ver
// mapping.ts/mappingOfertas.ts). Dos diferencias de fondo respecto al de
// catálogo:
// - Un sku_proveedor repetido con distinto desde_cantidad es un tramo de
//   descuento válido (ver docs/plan-ofertas.md), así que "duplicado" y
//   "salto de precio" se comparan por el tramo (sku_proveedor,
//   desde_cantidad), no por sku solo.
// - marca/numero_oferta/fecha_oferta/hora_oferta pueden venir de
//   metadataOferta (fallback de archivo) en vez de una columna — hace falta
//   aplicar ese fallback antes de poder chequear nada.
export async function detectarAdvertenciasOfertas(
  proveedorId: number,
  headers: string[],
  rows: ExtractedRow[],
  mapping: OfertaColumnMapping,
  metadata: OfertaMetadata
): Promise<Advertencia[]> {
  const filas = applyMappingOfertas(headers, rows, mapping, metadata);
  const advertencias: Advertencia[] = [];

  // 1. precio_unitario <= 0
  filas.forEach((row, fila) => {
    if (row.precio_unitario !== null && row.precio_unitario <= 0) {
      advertencias.push({
        fila,
        campo: "precio_unitario",
        mensaje: `Precio ${row.precio_unitario < 0 ? "negativo" : "en cero"} (${row.precio_unitario})`,
      });
    }
  });

  // 1b. cantidad_disponible negativa (campo opcional — null es válido y no
  // genera advertencia, es "no informado", distinto de "cero unidades").
  filas.forEach((row, fila) => {
    if (row.cantidad_disponible !== null && row.cantidad_disponible < 0) {
      advertencias.push({
        fila,
        campo: "cantidad_disponible",
        mensaje: `Cantidad disponible negativa (${row.cantidad_disponible})`,
      });
    }
  });

  // 2. Tramo duplicado: mismo (sku_proveedor, desde_cantidad) repetido.
  const filasPorTramo = new Map<string, number[]>();
  filas.forEach((row, fila) => {
    if (!row.sku_proveedor || row.desde_cantidad === null) return;
    const clave = `${row.sku_proveedor}::${row.desde_cantidad}`;
    const lista = filasPorTramo.get(clave) ?? [];
    lista.push(fila);
    filasPorTramo.set(clave, lista);
  });
  for (const [clave, filasDelTramo] of filasPorTramo) {
    if (filasDelTramo.length <= 1) continue;
    const [sku, desdeCantidad] = clave.split("::");
    for (const fila of filasDelTramo) {
      advertencias.push({
        fila,
        campo: "desde_cantidad",
        mensaje: `Tramo "desde ${desdeCantidad}" de SKU "${sku}" repetido en ${filasDelTramo.length} filas de esta carga`,
      });
    }
  }

  // 3. Salto de precio vs. la última oferta conocida del mismo tramo exacto
  // (sku_proveedor + desde_cantidad) — comparar contra otro tramo daría
  // falsos positivos, ya que el precio baja a propósito con más cantidad.
  const skus = Array.from(
    new Set(filas.map((r) => r.sku_proveedor).filter((s): s is string => s !== null))
  );
  if (skus.length > 0) {
    const anteriores = await prisma.oferta.findMany({
      where: { proveedorId, skuProveedor: { in: skus } },
      orderBy: { createdAt: "desc" },
      distinct: ["skuProveedor", "desdeCantidad"],
      select: { skuProveedor: true, desdeCantidad: true, precioUnitario: true },
    });
    const ultimoPrecioPorTramo = new Map(
      anteriores.map((o) => [`${o.skuProveedor}::${o.desdeCantidad}`, o.precioUnitario])
    );

    filas.forEach((row, fila) => {
      if (!row.sku_proveedor || row.desde_cantidad === null || row.precio_unitario === null) return;
      const anterior = ultimoPrecioPorTramo.get(`${row.sku_proveedor}::${row.desde_cantidad}`);
      if (anterior === undefined || anterior === 0) return;
      const variacion = (row.precio_unitario - anterior) / anterior;
      if (Math.abs(variacion) < SALTO_PRECIO_UMBRAL) return;
      const signo = variacion > 0 ? "subió" : "bajó";
      advertencias.push({
        fila,
        campo: "precio_unitario",
        mensaje: `Precio ${signo} ${(Math.abs(variacion) * 100).toFixed(0)}% vs. último valor conocido de ese tramo (${anterior})`,
      });
    });
  }

  // 4. Campos obligatorios faltantes (advertencia temprana, no bloqueante —
  // la misma lista se valida como error duro recién al confirmar, ver
  // validarFilasOferta en processCarga.ts).
  filas.forEach((row, fila) => {
    for (const campo of OFERTA_REQUIRED_FIELDS) {
      if (row[campo] === null || row[campo] === undefined) {
        advertencias.push({
          fila,
          campo,
          mensaje: `Falta completar "${campo}" (obligatorio para publicar la oferta)`,
        });
      }
    }
  });

  return advertencias;
}
