import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { prisma } from "../db.js";
import {
  procesarCarga,
  aprobarMapeoYPublicar,
  confirmarCargaYPublicar,
} from "../extraction/processCarga.js";
import { CANONICAL_FIELDS, type ColumnMapping, type CanonicalField } from "../extraction/types.js";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const EXT_TO_TIPO: Record<string, string> = {
  ".xlsx": "xlsx",
  ".xls": "xls",
  ".pdf": "pdf",
  ".png": "png",
  ".jpg": "jpg",
  ".jpeg": "jpeg",
};

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, "_");
    cb(null, `${Date.now()}_${base}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext in EXT_TO_TIPO) {
      cb(null, true);
    } else {
      cb(new Error(`Tipo de archivo no soportado: ${ext}`));
    }
  },
});

export const uploadsRouter = Router();

// Valida el shape de "mapeo" (columnaOrigen -> campoDestino) compartido por
// /aprobar-mapeo y /confirmar. No exige que tenga entradas: una carga con
// todos los valores tipeados a mano y ninguna columna mapeada es válida
// para /confirmar (no lo es para /aprobar-mapeo, que chequea eso aparte).
function parseMapeoBody(body: unknown): { mapping: ColumnMapping } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Falta 'mapeo' (objeto columnaOrigen -> campoDestino) en el body." };
  }
  const mapping: ColumnMapping = {};
  for (const [columna, destino] of Object.entries(body)) {
    if ((CANONICAL_FIELDS as readonly string[]).includes(destino as string)) {
      mapping[columna] = destino as ColumnMapping[string];
    }
  }
  return { mapping };
}

// Recibe un archivo (xlsx, xls, pdf, png, jpg) y lo deja en estado
// "pendiente". Disparar la extracción con POST /:id/procesar.
uploadsRouter.post("/", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "Falta el archivo (campo 'file')." });
    return;
  }

  const ext = path.extname(req.file.originalname).toLowerCase();
  const proveedorNombre = typeof req.body.proveedor === "string" ? req.body.proveedor.trim() : "";

  let proveedorId: number | undefined;
  if (proveedorNombre) {
    const proveedor = await prisma.proveedor.upsert({
      where: { nombre: proveedorNombre },
      update: {},
      create: { nombre: proveedorNombre },
    });
    proveedorId = proveedor.id;
  }

  const carga = await prisma.carga.create({
    data: {
      proveedorId,
      nombreArchivo: req.file.originalname,
      rutaArchivo: req.file.path,
      tipoArchivo: EXT_TO_TIPO[ext],
      estado: "pendiente",
    },
  });

  res.status(201).json(carga);
});

uploadsRouter.get("/", async (_req, res) => {
  const cargas = await prisma.carga.findMany({
    include: { proveedor: true },
    orderBy: { createdAt: "desc" },
  });
  res.json(cargas);
});

uploadsRouter.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const carga = await prisma.carga.findUnique({
    where: { id },
    include: { proveedor: true },
  });
  if (!carga) {
    res.status(404).json({ error: "Carga no encontrada." });
    return;
  }
  res.json(carga);
});

// Dispara la extracción + mapeo de columnas (etapas 2-4 del pipeline) para
// una carga ya recibida. Si el proveedor es nuevo (o le cambiaron los
// headers), la carga queda en "revision_pendiente" con un mapeo sugerido
// en vez de publicarse sola — hay que aprobarlo con POST /:id/aprobar-mapeo.
uploadsRouter.post("/:id/procesar", async (req, res) => {
  const id = Number(req.params.id);
  try {
    await procesarCarga(id);
  } catch (err) {
    // El error ya quedó guardado en la carga (estado=error); lo logueamos
    // igual para diagnóstico del lado del servidor.
    console.error(`Error procesando carga ${id}:`, err);
  }
  const carga = await prisma.carga.findUnique({ where: { id }, include: { proveedor: true } });
  if (!carga) {
    res.status(404).json({ error: "Carga no encontrada." });
    return;
  }
  res.json(carga);
});

// Aprueba (o corrige) el mapeo sugerido para una carga en
// "revision_pendiente": lo guarda en MapeoColumna (se reusa en próximas
// cargas del mismo proveedor) y publica los productos.
// Body: { "mapeo": { "<columna origen>": "<campo_canonico>", ... } }
uploadsRouter.post("/:id/aprobar-mapeo", async (req, res) => {
  const id = Number(req.params.id);
  const parsed = parseMapeoBody(req.body?.mapeo);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  if (Object.keys(parsed.mapping).length === 0) {
    res.status(400).json({
      error: `Ninguna entrada de 'mapeo' tiene un campo destino válido. Válidos: ${CANONICAL_FIELDS.join(", ")}`,
    });
    return;
  }

  try {
    const publicados = await aprobarMapeoYPublicar(id, parsed.mapping);
    const carga = await prisma.carga.findUnique({ where: { id }, include: { proveedor: true } });
    res.json({ carga, publicados });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Confirma una carga en revisión: publica exactamente las filas finales que
// mandó el cliente (ya editadas a mano si hizo falta), a diferencia de
// /aprobar-mapeo que vuelve a derivar las filas de `filasExtraidas` en el
// servidor. Body: { "mapeo": {...} (puede ir vacío), "filas": [{<campo
// canónico>: <valor>, ...}, ...] }.
uploadsRouter.post("/:id/confirmar", async (req, res) => {
  const id = Number(req.params.id);
  const parsed = parseMapeoBody(req.body?.mapeo ?? {});
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const filas = req.body?.filas;
  if (!Array.isArray(filas) || filas.length === 0) {
    res.status(400).json({ error: "Falta 'filas' (array no vacío de filas finales a publicar)." });
    return;
  }

  try {
    const publicados = await confirmarCargaYPublicar(
      id,
      parsed.mapping,
      filas as Array<Partial<Record<CanonicalField, unknown>> & { raw_data?: unknown }>
    );
    const carga = await prisma.carga.findUnique({ where: { id }, include: { proveedor: true } });
    res.json({ carga, publicados });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
