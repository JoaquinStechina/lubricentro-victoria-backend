import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import type { Rol } from "@prisma/client";

export const SESSION_COOKIE = "session";

const RANGO: Record<Rol, number> = {
  EMPLEADO: 1,
  ADMINISTRADOR: 2,
  SYSADMIN: 3,
};

export interface SessionPayload {
  sub: number;
  email: string;
  nombre: string;
  rol: Rol;
}

declare global {
  namespace Express {
    interface Request {
      user?: SessionPayload;
    }
  }
}

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("Falta JWT_SECRET en el entorno");
  return secret;
}

export function firmarSesion(payload: SessionPayload): string {
  return jwt.sign(payload, jwtSecret(), { expiresIn: "7d" });
}

// Verifica la cookie de sesión y adjunta el usuario a `req.user`. El resto
// de las rutas (salvo /api/auth/login) esperan pasar primero por acá.
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  try {
    req.user = jwt.verify(token, jwtSecret()) as unknown as SessionPayload;
    next();
  } catch {
    res.status(401).json({ error: "Sesión inválida o vencida" });
  }
}

// Jerarquía acumulativa: SYSADMIN > ADMINISTRADOR > EMPLEADO. Debe montarse
// después de requireAuth.
export function requireRole(minRol: Rol) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || RANGO[req.user.rol] < RANGO[minRol]) {
      res.status(403).json({ error: "No tenés permisos para esta acción" });
      return;
    }
    next();
  };
}
