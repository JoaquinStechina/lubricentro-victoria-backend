import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import type { Request, Response, NextFunction } from "express";

export const IMAGENES_DIR = path.join(process.cwd(), "uploads", "imagenes");
fs.mkdirSync(IMAGENES_DIR, { recursive: true });

const EXT_A_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, IMAGENES_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`);
  },
});

// A diferencia del upload de uploads.ts (que solo mira la extensión, porque
// el archivo se procesa server-side), acá se valida extensión Y mimetype: el
// archivo se sirve de vuelta al navegador como <img>, así que conviene ser
// más estricto sobre qué termina en uploads/imagenes.
export const imagenUpload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB, alcanza para una foto de producto
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const mimeEsperado = EXT_A_MIME[ext];
    if (mimeEsperado && file.mimetype === mimeEsperado) {
      cb(null, true);
    } else {
      cb(new Error("Tipo de archivo no soportado. Usar JPG, PNG o WEBP."));
    }
  },
});

// Envuelve imagenUpload.single("imagen") para devolver 400 con un mensaje
// legible en vez de dejar que el error de multer (tipo/tamaño inválido)
// llegue al handler global de errores como 500.
export function imagenUploadSingle(req: Request, res: Response, next: NextFunction): void {
  imagenUpload.single("imagen")(req, res, (err: unknown) => {
    if (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    next();
  });
}

export function imagenPublicUrl(filename: string): string {
  return `/uploads/imagenes/${filename}`;
}

// Borra el archivo físico asociado a una imagenUrl guardada en la fila. Se
// reconstruye el path desde el basename (nunca se confía en el string
// completo) para no quedar expuesto a path traversal si imagenUrl viniera
// manipulado. Ignora ENOENT: si el archivo ya no está, no es un error.
export async function eliminarArchivoImagen(imagenUrl: string | null): Promise<void> {
  if (!imagenUrl) return;
  const nombre = path.basename(imagenUrl);
  const ruta = path.join(IMAGENES_DIR, nombre);
  try {
    await fs.promises.unlink(ruta);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
