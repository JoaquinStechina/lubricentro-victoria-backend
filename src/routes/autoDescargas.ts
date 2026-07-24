import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { requireRole } from "../middleware/auth.js";
import { correrAutoDescargasAbc } from "../automation/abcAutoDescarga.js";

export const autoDescargasRouter = Router();

autoDescargasRouter.use(requireRole("ADMINISTRADOR"));

autoDescargasRouter.get("/", async (_req, res) => {
  const filas = await prisma.autoDescargaMarca.findMany({
    include: { proveedor: true },
    orderBy: [{ proveedor: { nombre: "asc" } }, { marca: "asc" }],
  });
  res.json(filas);
});

autoDescargasRouter.post("/", async (req, res) => {
  const proveedorNombre =
    typeof req.body.proveedorNombre === "string" ? req.body.proveedorNombre.trim() : "";
  const marca = typeof req.body.marca === "string" ? req.body.marca.trim() : "";
  if (!proveedorNombre || !marca) {
    res.status(400).json({ error: "Faltan 'proveedorNombre' y/o 'marca'." });
    return;
  }
  const porcentajeGanancia =
    req.body.porcentajeGanancia === null || req.body.porcentajeGanancia === undefined
      ? null
      : Number(req.body.porcentajeGanancia);
  const activo = req.body.activo !== false;

  const proveedor = await prisma.proveedor.upsert({
    where: { nombre: proveedorNombre },
    update: {},
    create: { nombre: proveedorNombre },
  });

  try {
    const fila = await prisma.autoDescargaMarca.create({
      data: { proveedorId: proveedor.id, marca, porcentajeGanancia, activo },
      include: { proveedor: true },
    });
    res.status(201).json(fila);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      res.status(409).json({ error: "Ya existe una fila para ese proveedor y esa marca." });
      return;
    }
    throw err;
  }
});

autoDescargasRouter.patch("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const data: { marca?: string; porcentajeGanancia?: number | null; activo?: boolean } = {};
  if (typeof req.body.marca === "string") data.marca = req.body.marca.trim();
  if ("porcentajeGanancia" in req.body) {
    data.porcentajeGanancia =
      req.body.porcentajeGanancia === null ? null : Number(req.body.porcentajeGanancia);
  }
  if (typeof req.body.activo === "boolean") data.activo = req.body.activo;

  try {
    const fila = await prisma.autoDescargaMarca.update({
      where: { id },
      data,
      include: { proveedor: true },
    });
    res.json(fila);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      res.status(409).json({ error: "Ya existe una fila para ese proveedor y esa marca." });
      return;
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      res.status(404).json({ error: "Fila no encontrada." });
      return;
    }
    throw err;
  }
});

autoDescargasRouter.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  try {
    await prisma.autoDescargaMarca.delete({ where: { id } });
    res.json({ id });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      res.status(404).json({ error: "Fila no encontrada." });
      return;
    }
    throw err;
  }
});

// Corre la auto-descarga para una sola fila, al toque (no espera al cron
// diario). Tarda ~10-20s: abre navegador, loguea, descarga una marca.
autoDescargasRouter.post("/:id/probar", async (req, res) => {
  const id = Number(req.params.id);
  const existente = await prisma.autoDescargaMarca.findUnique({ where: { id } });
  if (!existente) {
    res.status(404).json({ error: "Fila no encontrada." });
    return;
  }
  await correrAutoDescargasAbc([id]);
  const fila = await prisma.autoDescargaMarca.findUnique({
    where: { id },
    include: { proveedor: true },
  });
  res.json(fila);
});
