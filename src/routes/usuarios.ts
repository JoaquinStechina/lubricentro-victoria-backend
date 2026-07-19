import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../db.js";
import { requireRole } from "../middleware/auth.js";

export const usuariosRouter = Router();

usuariosRouter.use(requireRole("SYSADMIN"));

const SELECT_SEGURO = {
  id: true,
  email: true,
  nombre: true,
  rol: true,
  activo: true,
  creadoPorId: true,
  createdAt: true,
} as const;

// Roles que un sysadmin puede asignar desde esta pantalla. No incluye
// SYSADMIN a propósito: para eso está scripts/seed-sysadmin.ts.
const ROLES_ASIGNABLES = ["ADMINISTRADOR", "EMPLEADO"] as const;

usuariosRouter.get("/", async (_req, res) => {
  const usuarios = await prisma.usuario.findMany({
    select: SELECT_SEGURO,
    orderBy: { createdAt: "asc" },
  });
  res.json(usuarios);
});

usuariosRouter.post("/", async (req, res) => {
  const { email, password, nombre, rol } = req.body ?? {};
  if (
    typeof email !== "string" ||
    typeof password !== "string" ||
    typeof nombre !== "string" ||
    !ROLES_ASIGNABLES.includes(rol)
  ) {
    res.status(400).json({
      error: `Datos inválidos. rol debe ser uno de: ${ROLES_ASIGNABLES.join(", ")}`,
    });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: "La contraseña debe tener al menos 8 caracteres" });
    return;
  }

  const existente = await prisma.usuario.findUnique({ where: { email } });
  if (existente) {
    res.status(409).json({ error: "Ya existe un usuario con ese email" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const usuario = await prisma.usuario.create({
    data: { email, nombre, rol, passwordHash, creadoPorId: req.user!.sub },
    select: SELECT_SEGURO,
  });
  res.status(201).json(usuario);
});

usuariosRouter.patch("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { activo, rol, password, nombre } = req.body ?? {};

  const objetivo = await prisma.usuario.findUnique({ where: { id } });
  if (!objetivo) {
    res.status(404).json({ error: "Usuario no encontrado" });
    return;
  }
  if (objetivo.rol === "SYSADMIN") {
    res.status(403).json({ error: "No se puede modificar a otro sysadmin desde acá" });
    return;
  }

  const data: {
    activo?: boolean;
    rol?: "ADMINISTRADOR" | "EMPLEADO";
    nombre?: string;
    passwordHash?: string;
  } = {};

  if (typeof activo === "boolean") data.activo = activo;
  if (typeof nombre === "string" && nombre.trim()) data.nombre = nombre;
  if (rol !== undefined) {
    if (!ROLES_ASIGNABLES.includes(rol)) {
      res.status(400).json({
        error: `rol debe ser uno de: ${ROLES_ASIGNABLES.join(", ")}`,
      });
      return;
    }
    data.rol = rol;
  }
  if (password !== undefined) {
    if (typeof password !== "string" || password.length < 8) {
      res.status(400).json({ error: "La contraseña debe tener al menos 8 caracteres" });
      return;
    }
    data.passwordHash = await bcrypt.hash(password, 10);
  }

  const usuario = await prisma.usuario.update({
    where: { id },
    data,
    select: SELECT_SEGURO,
  });
  res.json(usuario);
});
