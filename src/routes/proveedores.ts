import { Router } from "express";
import { prisma } from "../db.js";
import { requireRole } from "../middleware/auth.js";

export const proveedoresRouter = Router();

proveedoresRouter.use(requireRole("ADMINISTRADOR"));

// Lista de proveedores existentes, para que el frontend pueda ofrecer un
// autocomplete al subir un archivo en vez de un texto libre a ciegas (un
// typo en el nombre crearía un proveedor duplicado, ya que se resuelve por
// upsert sobre `nombre` único).
proveedoresRouter.get("/", async (_req, res) => {
  const proveedores = await prisma.proveedor.findMany({
    select: { id: true, nombre: true },
    orderBy: { nombre: "asc" },
  });
  res.json(proveedores);
});
