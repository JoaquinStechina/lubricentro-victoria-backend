import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { requireRole } from "../middleware/auth.js";

export const ofertasRouter = Router();

const COLUMNAS_TEXTO_CONTAINS: Record<string, keyof Prisma.OfertaWhereInput> = {
  marca: "marca",
  sku: "skuProveedor",
  descripcion: "descripcion",
  fechaOferta: "fechaOferta",
  horaOferta: "horaOferta",
};
const COLUMNAS_NUMERO_EXACTO = ["numeroOferta", "desdeCantidad", "descuentoPct", "precioUnitario"] as const;

// "Activa" es una condición calculada, no un solo campo: combina el cierre
// manual (activa:false, ver /cerrar más abajo) con el vencimiento por fecha
// (fechaHasta en formato YYYY-MM-DD, comparación lexicográfica sin parsear)
// — evita necesitar un cron/worker que cierre solas las que ya vencieron.
// null en fechaHasta = "hasta agotar stock", solo se cierra a mano.
ofertasRouter.get("/", async (req, res) => {
  const proveedorId = req.query.proveedorId ? Number(req.query.proveedorId) : undefined;
  const incluirCerradas = req.query.incluirCerradas === "true";
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const hoyISO = new Date().toISOString().slice(0, 10);

  const filtros: Prisma.OfertaWhereInput[] = [];
  for (const [param, campo] of Object.entries(COLUMNAS_TEXTO_CONTAINS)) {
    const raw = req.query[`f_${param}`];
    if (typeof raw !== "string" || !raw.trim()) continue;
    filtros.push({ [campo]: { contains: raw.trim() } } as Prisma.OfertaWhereInput);
  }
  const rawProveedorFiltro = req.query.f_proveedor;
  if (typeof rawProveedorFiltro === "string" && rawProveedorFiltro.trim()) {
    filtros.push({ proveedor: { nombre: { contains: rawProveedorFiltro.trim() } } });
  }
  for (const campo of COLUMNAS_NUMERO_EXACTO) {
    const raw = req.query[`f_${campo}`];
    if (typeof raw !== "string" || !raw.trim()) continue;
    const num = Number(raw);
    if (Number.isFinite(num)) filtros.push({ [campo]: num } as Prisma.OfertaWhereInput);
  }
  if (search) {
    filtros.push({
      OR: [
        { proveedor: { nombre: { contains: search } } },
        { marca: { contains: search } },
        { skuProveedor: { contains: search } },
        { descripcion: { contains: search } },
        { fechaOferta: { contains: search } },
        { horaOferta: { contains: search } },
      ],
    });
  }

  const where: Prisma.OfertaWhereInput = {
    eliminado: false,
    ...(proveedorId ? { proveedorId } : {}),
    ...(incluirCerradas
      ? {}
      : {
          activa: true,
          OR: [{ fechaHasta: null }, { fechaHasta: { gte: hoyISO } }],
        }),
    AND: filtros,
  };

  const ofertas = await prisma.oferta.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: { proveedor: true },
  });
  res.json({ ofertas });
});

type CerrarBody = { proveedorId?: unknown; numeroOferta?: unknown; skuProveedor?: unknown };

function parseCerrarBody(body: unknown): { proveedorId: number; numeroOferta: number; skuProveedor: string } | null {
  const b = (body ?? {}) as CerrarBody;
  const proveedorId = Number(b.proveedorId);
  const numeroOferta = Number(b.numeroOferta);
  const skuProveedor = typeof b.skuProveedor === "string" ? b.skuProveedor : "";
  if (!Number.isFinite(proveedorId) || !Number.isFinite(numeroOferta) || !skuProveedor) return null;
  return { proveedorId, numeroOferta, skuProveedor };
}

// Cierran (o reabren) TODOS los tramos (desde_cantidad distintos) de un
// mismo sku_proveedor dentro de una misma oferta — "se acabó el stock" es
// un hecho del producto, no de un tramo puntual de cantidad/descuento.
ofertasRouter.post("/cerrar", requireRole("ADMINISTRADOR"), async (req, res) => {
  const parsed = parseCerrarBody(req.body);
  if (!parsed) {
    res.status(400).json({ error: "Body inválido: se esperaba {proveedorId, numeroOferta, skuProveedor}." });
    return;
  }
  const { count } = await prisma.oferta.updateMany({
    where: {
      proveedorId: parsed.proveedorId,
      numeroOferta: parsed.numeroOferta,
      skuProveedor: parsed.skuProveedor,
    },
    data: { activa: false },
  });
  res.json({ actualizadas: count });
});

ofertasRouter.post("/reactivar", requireRole("ADMINISTRADOR"), async (req, res) => {
  const parsed = parseCerrarBody(req.body);
  if (!parsed) {
    res.status(400).json({ error: "Body inválido: se esperaba {proveedorId, numeroOferta, skuProveedor}." });
    return;
  }
  const { count } = await prisma.oferta.updateMany({
    where: {
      proveedorId: parsed.proveedorId,
      numeroOferta: parsed.numeroOferta,
      skuProveedor: parsed.skuProveedor,
    },
    data: { activa: true },
  });
  res.json({ actualizadas: count });
});

const SINGLE_EDIT_FIELDS = [
  "marca",
  "numeroOferta",
  "skuProveedor",
  "descripcion",
  "desdeCantidad",
  "descuentoPct",
  "precioUnitario",
  "moneda",
  "fechaOferta",
  "horaOferta",
  "fechaHasta",
] as const;

const BULK_EDIT_FIELDS = [
  "desdeCantidad",
  "descuentoPct",
  "precioUnitario",
  "moneda",
  "fechaOferta",
  "horaOferta",
  "fechaHasta",
] as const;
type BulkEditField = (typeof BULK_EDIT_FIELDS)[number];

const CAMPOS_NUMERICOS = new Set<string>(["numeroOferta", "desdeCantidad", "descuentoPct", "precioUnitario"]);
const CAMPOS_NULEABLES = new Set<string>(["fechaHasta"]);

function coerceValor(campo: string, value: unknown): { ok: true; value: unknown } | { ok: false } {
  if (value === null) {
    if (CAMPOS_NULEABLES.has(campo)) return { ok: true, value: null };
    return { ok: false };
  }
  if (CAMPOS_NUMERICOS.has(campo)) {
    const num = Number(value);
    if (!Number.isFinite(num)) return { ok: false };
    return { ok: true, value: num };
  }
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

ofertasRouter.post("/editar-lote", requireRole("ADMINISTRADOR"), async (req, res) => {
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
  const { count } = await prisma.oferta.updateMany({
    where: { id: { in: ids }, eliminado: false },
    data: { [field as BulkEditField]: coerced.value } as Prisma.OfertaUpdateManyMutationInput,
  });
  res.json({ actualizados: count });
});

ofertasRouter.post("/eliminar", requireRole("ADMINISTRADOR"), async (req, res) => {
  const b = (req.body ?? {}) as { ids?: unknown };
  const ids = Array.isArray(b.ids) ? b.ids.filter((v) => Number.isFinite(Number(v))).map(Number) : [];
  if (ids.length === 0) {
    res.status(400).json({ error: "Body inválido: se esperaba {ids: number[]}" });
    return;
  }
  const { count } = await prisma.oferta.updateMany({
    where: { id: { in: ids } },
    data: { eliminado: true },
  });
  res.json({ eliminados: count });
});

ofertasRouter.patch("/:id", requireRole("ADMINISTRADOR"), async (req, res) => {
  const id = Number(req.params.id);
  const objetivo = await prisma.oferta.findUnique({ where: { id } });
  if (!objetivo || objetivo.eliminado) {
    res.status(404).json({ error: "Oferta no encontrada" });
    return;
  }
  const data = buildSingleEditData(req.body);
  if (!data) {
    res.status(400).json({ error: `Body inválido. Campos permitidos: ${SINGLE_EDIT_FIELDS.join(", ")}` });
    return;
  }
  const oferta = await prisma.oferta.update({
    where: { id },
    data: data as Prisma.OfertaUpdateInput,
    include: { proveedor: true },
  });
  res.json(oferta);
});
