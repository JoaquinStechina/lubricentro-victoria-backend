import { Router } from "express";
import { prisma } from "../db.js";
import { requireRole } from "../middleware/auth.js";

export const ofertasRouter = Router();

// "Activa" es una condición calculada, no un solo campo: combina el cierre
// manual (activa:false, ver /cerrar más abajo) con el vencimiento por fecha
// (fechaHasta en formato YYYY-MM-DD, comparación lexicográfica sin parsear)
// — evita necesitar un cron/worker que cierre solas las que ya vencieron.
// null en fechaHasta = "hasta agotar stock", solo se cierra a mano.
ofertasRouter.get("/", async (req, res) => {
  const proveedorId = req.query.proveedorId ? Number(req.query.proveedorId) : undefined;
  const incluirCerradas = req.query.incluirCerradas === "true";
  const hoyISO = new Date().toISOString().slice(0, 10);

  const where = {
    ...(proveedorId ? { proveedorId } : {}),
    ...(incluirCerradas
      ? {}
      : {
          activa: true,
          OR: [{ fechaHasta: null }, { fechaHasta: { gte: hoyISO } }],
        }),
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
