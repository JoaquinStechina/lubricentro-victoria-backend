import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { requireRole } from "../middleware/auth.js";

export const productosRouter = Router();

// Catálogo "vigente": la fila más reciente por proveedor+marca+SKU (ver
// publicarCanonicalRows en processCarga.ts, que marca vigente:false en la
// fila anterior al confirmar una carga nueva del mismo SKU). El
// distinct+orderBy es una red de seguridad para los datos cargados antes de
// que este mecanismo existiera: esas filas quedaron todas en vigente:true
// (no se puede reescribir retroactivamente cuál era "la última"), así que
// sin esto podrían aparecer duplicadas hasta que entre una carga nueva de
// ese proveedor+SKU. `total` no aplica ese mismo distinct (Prisma no lo
// soporta en `count`), así que puede sobrestimar temporalmente para
// proveedores con ese historial viejo — se autocorrige con cargas nuevas.
const COLUMNAS_TEXTO: Record<string, keyof Prisma.ProductoPrecioWhereInput> = {
  marca: "marca",
  sku: "skuInterno", // se resuelve especial más abajo (también matchea skuProveedor)
  descripcion: "descripcion",
  seccion: "seccion",
  fechaVigencia: "fechaVigencia",
  unidad: "unidad",
};
const COLUMNAS_NUMERO = ["precioNeto", "precioConIva", "alicuotaIva"] as const;

productosRouter.get("/", async (req, res) => {
  const proveedorId = req.query.proveedorId ? Number(req.query.proveedorId) : undefined;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 100));
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

  const filtros: Prisma.ProductoPrecioWhereInput[] = [];
  for (const [param, campo] of Object.entries(COLUMNAS_TEXTO)) {
    const raw = req.query[`f_${param}`];
    if (typeof raw !== "string" || !raw.trim()) continue;
    if (param === "sku") {
      filtros.push({
        OR: [
          { skuInterno: { contains: raw.trim() } },
          { skuProveedor: { contains: raw.trim() } },
        ],
      });
    } else {
      filtros.push({ [campo]: { contains: raw.trim() } } as Prisma.ProductoPrecioWhereInput);
    }
  }
  const rawProveedorFiltro = req.query.f_proveedor;
  if (typeof rawProveedorFiltro === "string" && rawProveedorFiltro.trim()) {
    filtros.push({ proveedor: { nombre: { contains: rawProveedorFiltro.trim() } } });
  }
  for (const campo of COLUMNAS_NUMERO) {
    const raw = req.query[`f_${campo}`];
    if (typeof raw !== "string" || !raw.trim()) continue;
    const num = Number(raw);
    if (Number.isFinite(num)) filtros.push({ [campo]: num } as Prisma.ProductoPrecioWhereInput);
  }
  if (search) {
    filtros.push({
      OR: [
        { proveedor: { nombre: { contains: search } } },
        { marca: { contains: search } },
        { skuInterno: { contains: search } },
        { skuProveedor: { contains: search } },
        { descripcion: { contains: search } },
        { seccion: { contains: search } },
        { fechaVigencia: { contains: search } },
      ],
    });
  }

  const where: Prisma.ProductoPrecioWhereInput = {
    vigente: true,
    eliminado: false,
    ...(proveedorId ? { proveedorId } : {}),
    AND: filtros,
  };

  const [total, items] = await Promise.all([
    prisma.productoPrecio.count({ where }),
    prisma.productoPrecio.findMany({
      where,
      distinct: ["proveedorId", "marca", "skuProveedor"],
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { proveedor: true },
    }),
  ]);

  res.json({ items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
});

const SINGLE_EDIT_FIELDS = [
  "marca",
  "skuProveedor",
  "skuInterno",
  "descripcion",
  "seccion",
  "precioNeto",
  "precioConIva",
  "alicuotaIva",
  "moneda",
  "unidad",
  "fechaVigencia",
] as const;
type SingleEditField = (typeof SINGLE_EDIT_FIELDS)[number];

const BULK_EDIT_FIELDS = [
  "seccion",
  "precioNeto",
  "precioConIva",
  "alicuotaIva",
  "moneda",
  "unidad",
  "fechaVigencia",
] as const;
type BulkEditField = (typeof BULK_EDIT_FIELDS)[number];

const CAMPOS_NUMERICOS = new Set<string>(["precioNeto", "precioConIva", "alicuotaIva"]);

// Valida y coerciona un valor según el tipo esperado del campo. Devuelve
// `{ok:false}` si el valor no es válido para ese campo (400 en el caller).
function coerceValor(campo: string, value: unknown): { ok: true; value: unknown } | { ok: false } {
  if (CAMPOS_NUMERICOS.has(campo)) {
    if (value === null) return { ok: true, value: null };
    const num = Number(value);
    if (!Number.isFinite(num)) return { ok: false };
    return { ok: true, value: num };
  }
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  return { ok: true, value };
}

function buildSingleEditData(body: unknown): Record<string, unknown> | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  for (const campo of SINGLE_EDIT_FIELDS) {
    if (!(campo in b)) continue;
    const coerced = coerceValor(campo, b[campo]);
    if (!coerced.ok) return null;
    data[campo] = coerced.value;
  }
  return data;
}

// IMPORTANTE: /editar-lote y /eliminar van ANTES de /:id — si no, Express
// intentaría matchear "editar-lote"/"eliminar" como si fueran un :id (pero
// como son rutas con método/verbo distinto de PATCH /:id no colisionan en
// la práctica; se registran en este orden igual por claridad y consistencia
// con el resto del archivo).
productosRouter.post("/editar-lote", requireRole("ADMINISTRADOR"), async (req, res) => {
  const b = (req.body ?? {}) as { ids?: unknown; field?: unknown; value?: unknown };
  const ids = Array.isArray(b.ids) ? b.ids.filter((v) => Number.isFinite(Number(v))).map(Number) : [];
  const field = typeof b.field === "string" ? b.field : "";
  if (ids.length === 0 || !(BULK_EDIT_FIELDS as readonly string[]).includes(field)) {
    res.status(400).json({
      error: `Body inválido: se esperaba {ids: number[], field, value} con field uno de: ${BULK_EDIT_FIELDS.join(", ")}`,
    });
    return;
  }
  const coerced = coerceValor(field, b.value);
  if (!coerced.ok) {
    res.status(400).json({ error: `Valor inválido para el campo "${field}"` });
    return;
  }
  const { count } = await prisma.productoPrecio.updateMany({
    where: { id: { in: ids }, eliminado: false },
    data: { [field as BulkEditField]: coerced.value } as Prisma.ProductoPrecioUpdateManyMutationInput,
  });
  res.json({ actualizados: count });
});

productosRouter.post("/eliminar", requireRole("ADMINISTRADOR"), async (req, res) => {
  const b = (req.body ?? {}) as { ids?: unknown };
  const ids = Array.isArray(b.ids) ? b.ids.filter((v) => Number.isFinite(Number(v))).map(Number) : [];
  if (ids.length === 0) {
    res.status(400).json({ error: "Body inválido: se esperaba {ids: number[]}" });
    return;
  }
  const { count } = await prisma.productoPrecio.updateMany({
    where: { id: { in: ids } },
    data: { eliminado: true },
  });
  res.json({ eliminados: count });
});

productosRouter.patch("/:id", requireRole("ADMINISTRADOR"), async (req, res) => {
  const id = Number(req.params.id);
  const objetivo = await prisma.productoPrecio.findUnique({ where: { id } });
  if (!objetivo || objetivo.eliminado) {
    res.status(404).json({ error: "Producto no encontrado" });
    return;
  }
  const data = buildSingleEditData(req.body);
  if (!data) {
    res.status(400).json({ error: `Body inválido. Campos permitidos: ${SINGLE_EDIT_FIELDS.join(", ")}` });
    return;
  }
  const producto = await prisma.productoPrecio.update({
    where: { id },
    data: data as Prisma.ProductoPrecioUpdateInput,
    include: { proveedor: true },
  });
  res.json(producto);
});
