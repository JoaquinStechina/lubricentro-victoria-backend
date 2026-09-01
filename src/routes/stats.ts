import { Router } from "express";
import { prisma } from "../db.js";

export const statsRouter = Router();

// Smoke test rápido para confirmar que la data sembrada (seed) está
// disponible vía Prisma. La API de consulta con filtros/paginación
// completa sigue siendo la del frontend (lee productos_todos.json); esto
// solo prueba que la base de datos nueva tiene los datos correctos.
statsRouter.get("/", async (_req, res) => {
  const [proveedores, productos, ofertas, cargas] = await Promise.all([
    prisma.proveedor.count(),
    prisma.productoPrecio.count(),
    prisma.oferta.count(),
    prisma.carga.count(),
  ]);

  res.json({ proveedores, productos, ofertas, cargas });
});
