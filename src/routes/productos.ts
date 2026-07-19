import { Router } from "express";
import { prisma } from "../db.js";

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
productosRouter.get("/", async (req, res) => {
  const proveedorId = req.query.proveedorId ? Number(req.query.proveedorId) : undefined;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 100));

  const where = { vigente: true, ...(proveedorId ? { proveedorId } : {}) };

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
