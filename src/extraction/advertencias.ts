import { prisma } from "../db.js";
import { applyMapping } from "./mapping.js";
import type { ColumnMapping, ExtractedRow } from "./types.js";

// Etapa 5 del plan original (contexto.md) — nunca se construyó como paso
// separado; hoy la pantalla de revisión humana era la única validación.
// Esto le agrega, al abrir esa pantalla, chequeos determinísticos sobre las
// filas ya mapeadas. No bloquea ni corrige nada solo: son advertencias que
// el humano ve y decide si ignorar, corregir a mano, o excluir la fila.
export type Advertencia = {
  fila: number; // índice dentro de filasExtraidas.rows (mismo orden que ve el frontend)
  campo: string;
  mensaje: string;
};

// Un salto de precio mayor a esto vs. el último valor conocido del mismo
// proveedor+SKU se marca como sospechoso (podría ser un error de parseo, no
// necesariamente un aumento real). Exportado para reusarlo tal cual en
// advertenciasOfertas.ts (mismo criterio de "sospechoso", ahí comparado por
// tramo sku+desde_cantidad en vez de por sku solo).
export const SALTO_PRECIO_UMBRAL = 0.3;

export async function detectarAdvertencias(
  proveedorId: number,
  headers: string[],
  rows: ExtractedRow[],
  mapping: ColumnMapping
): Promise<Advertencia[]> {
  const canonicalRows = applyMapping(headers, rows, mapping);
  const advertencias: Advertencia[] = [];

  canonicalRows.forEach((row, fila) => {
    const precio = row.precio_neto ?? row.precio_con_iva;
    if (precio !== null && precio <= 0) {
      advertencias.push({
        fila,
        campo: "precio_neto",
        mensaje: `Precio ${precio < 0 ? "negativo" : "en cero"} (${precio})`,
      });
    }
  });

  // SKU repetido dentro de la misma carga. A diferencia de Oferta (donde un
  // mismo sku_proveedor con distinto desde_cantidad es un tramo válido, ver
  // ofertaMetadata.ts), en catálogo cada SKU debería aparecer una sola vez.
  const filasPorSku = new Map<string, number[]>();
  canonicalRows.forEach((row, fila) => {
    if (!row.sku_proveedor) return;
    const filas = filasPorSku.get(row.sku_proveedor) ?? [];
    filas.push(fila);
    filasPorSku.set(row.sku_proveedor, filas);
  });
  for (const [sku, filas] of filasPorSku) {
    if (filas.length <= 1) continue;
    for (const fila of filas) {
      advertencias.push({
        fila,
        campo: "sku_proveedor",
        mensaje: `SKU "${sku}" repetido en ${filas.length} filas de esta carga`,
      });
    }
  }

  // Salto de precio vs. el último precio conocido de este proveedor+SKU
  // (carga anterior, la que sea). Compara contra ProductoPrecio ya
  // publicado, no contra otras filas de esta misma carga.
  const skus = Array.from(
    new Set(canonicalRows.map((r) => r.sku_proveedor).filter((s): s is string => s !== null))
  );
  if (skus.length > 0) {
    const anteriores = await prisma.productoPrecio.findMany({
      where: { proveedorId, skuProveedor: { in: skus }, precioNeto: { not: null } },
      orderBy: { createdAt: "desc" },
      distinct: ["skuProveedor"],
      select: { skuProveedor: true, precioNeto: true },
    });
    const ultimoPrecioPorSku = new Map(
      anteriores.map((p) => [p.skuProveedor as string, p.precioNeto as number])
    );

    canonicalRows.forEach((row, fila) => {
      if (!row.sku_proveedor || row.precio_neto === null) return;
      const anterior = ultimoPrecioPorSku.get(row.sku_proveedor);
      if (anterior === undefined || anterior === 0) return;
      const variacion = (row.precio_neto - anterior) / anterior;
      if (Math.abs(variacion) < SALTO_PRECIO_UMBRAL) return;
      const signo = variacion > 0 ? "subió" : "bajó";
      advertencias.push({
        fila,
        campo: "precio_neto",
        mensaje: `Precio ${signo} ${(Math.abs(variacion) * 100).toFixed(0)}% vs. último valor conocido (${anterior})`,
      });
    });
  }

  return advertencias;
}
