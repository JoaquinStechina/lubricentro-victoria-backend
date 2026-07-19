import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { prisma } from "../db.js";
import {
  procesarCarga,
  aprobarMapeoYPublicar,
  confirmarCargaYPublicar,
  confirmarCargaYPublicarOferta,
} from "../extraction/processCarga.js";
import { detectarAdvertencias } from "../extraction/advertencias.js";
import { detectarAdvertenciasOfertas } from "../extraction/advertenciasOfertas.js";
import {
  CANONICAL_FIELDS,
  type ColumnMapping,
  type CanonicalField,
  type ExtractedRow,
} from "../extraction/types.js";
import {
  CANONICAL_FIELDS_OFERTAS,
  type OfertaColumnMapping,
  type OfertaField,
  type OfertaMetadata,
} from "../extraction/typesOfertas.js";

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
// /aprobar-mapeo y /confirmar, contra el set de campos canónicos que
// corresponda (catálogo u ofertas, según carga.tipoDatos). No exige que
// tenga entradas: una carga con todos los valores tipeados a mano y ninguna
// columna mapeada es válida para /confirmar (no lo es para /aprobar-mapeo,
// que chequea eso aparte).
function parseMapeoBody(
  body: unknown,
  camposValidos: readonly string[]
): { mapping: Record<string, string> } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Falta 'mapeo' (objeto columnaOrigen -> campoDestino) en el body." };
  }
  const mapping: Record<string, string> = {};
  for (const [columna, destino] of Object.entries(body)) {
    if (camposValidos.includes(destino as string)) {
      mapping[columna] = destino as string;
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
  // "catalogo" (default, no rompe cargas existentes) | "oferta" — ver
  // docs/plan-ofertas.md. Cualquier otro valor recibido se ignora.
  const tipoDatos = req.body.tipoDatos === "oferta" ? "oferta" : "catalogo";

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
      tipoDatos,
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

// Etapa 5 (ver contexto.md) calculada como paso aparte, a pedido de la
// pantalla de revisión al abrirse — no durante procesarCarga, para no
// alargar el procesamiento síncrono con queries extra. Bifurca por
// tipoDatos: catálogo y ofertas tienen chequeos distintos (ver
// advertencias.ts / advertenciasOfertas.ts) porque el shape de "duplicado" y
// "salto de precio" no es el mismo en los dos casos.
uploadsRouter.get("/:id/advertencias", async (req, res) => {
  const id = Number(req.params.id);
  const carga = await prisma.carga.findUnique({ where: { id } });
  if (!carga) {
    res.status(404).json({ error: "Carga no encontrada." });
    return;
  }
  if (!carga.proveedorId) {
    res.status(400).json({ error: "La carga no tiene proveedor asociado." });
    return;
  }
  if (!carga.filasExtraidas) {
    res.status(400).json({ error: "La carga no tiene filas extraídas todavía." });
    return;
  }

  const { headers, rows } = carga.filasExtraidas as unknown as {
    headers: string[];
    rows: ExtractedRow[];
  };

  try {
    const advertencias =
      carga.tipoDatos === "oferta"
        ? await detectarAdvertenciasOfertas(
            carga.proveedorId,
            headers,
            rows,
            (carga.mapeoSugerido as OfertaColumnMapping | null) ?? {},
            (carga.metadataOferta as OfertaMetadata | null) ?? {}
          )
        : await detectarAdvertencias(
            carga.proveedorId,
            headers,
            rows,
            (carga.mapeoSugerido as ColumnMapping | null) ?? {}
          );
    res.json({ advertencias });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Aprueba (o corrige) el mapeo sugerido para una carga en
// "revision_pendiente": lo guarda en MapeoColumna (se reusa en próximas
// cargas del mismo proveedor) y publica los productos/ofertas, según
// carga.tipoDatos.
// Body: { "mapeo": { "<columna origen>": "<campo_canonico>", ... } }
uploadsRouter.post("/:id/aprobar-mapeo", async (req, res) => {
  const id = Number(req.params.id);
  const carga = await prisma.carga.findUnique({ where: { id } });
  if (!carga) {
    res.status(404).json({ error: "Carga no encontrada." });
    return;
  }
  const campos = carga.tipoDatos === "oferta" ? CANONICAL_FIELDS_OFERTAS : CANONICAL_FIELDS;

  const parsed = parseMapeoBody(req.body?.mapeo, campos);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  if (Object.keys(parsed.mapping).length === 0) {
    res.status(400).json({
      error: `Ninguna entrada de 'mapeo' tiene un campo destino válido. Válidos: ${campos.join(", ")}`,
    });
    return;
  }

  try {
    const publicados = await aprobarMapeoYPublicar(
      id,
      parsed.mapping as ColumnMapping | OfertaColumnMapping
    );
    const cargaFinal = await prisma.carga.findUnique({ where: { id }, include: { proveedor: true } });
    res.json({ carga: cargaFinal, publicados });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Confirma una carga en revisión: publica exactamente las filas finales que
// mandó el cliente (ya editadas a mano si hizo falta), a diferencia de
// /aprobar-mapeo que vuelve a derivar las filas de `filasExtraidas` en el
// servidor. Bifurca por carga.tipoDatos entre ProductoPrecio (catálogo) y
// Oferta. Body: { "mapeo": {...} (puede ir vacío), "filas": [{<campo
// canónico>: <valor>, ...}, ...] }.
uploadsRouter.post("/:id/confirmar", async (req, res) => {
  const id = Number(req.params.id);
  const carga = await prisma.carga.findUnique({ where: { id } });
  if (!carga) {
    res.status(404).json({ error: "Carga no encontrada." });
    return;
  }
  const campos = carga.tipoDatos === "oferta" ? CANONICAL_FIELDS_OFERTAS : CANONICAL_FIELDS;

  const parsed = parseMapeoBody(req.body?.mapeo ?? {}, campos);
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
    const publicados =
      carga.tipoDatos === "oferta"
        ? await confirmarCargaYPublicarOferta(
            id,
            parsed.mapping as OfertaColumnMapping,
            filas as Array<Partial<Record<OfertaField, unknown>> & { raw_data?: unknown }>
          )
        : await confirmarCargaYPublicar(
            id,
            parsed.mapping as ColumnMapping,
            filas as Array<Partial<Record<CanonicalField, unknown>> & { raw_data?: unknown }>
          );
    const cargaFinal = await prisma.carga.findUnique({ where: { id }, include: { proveedor: true } });
    res.json({ carga: cargaFinal, publicados });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
