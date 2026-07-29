import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { prisma } from "../db.js";
import { requireRole } from "../middleware/auth.js";
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
  type CanonicalRowUpload,
  type ExtractedRow,
} from "../extraction/types.js";
import {
  CANONICAL_FIELDS_OFERTAS,
  type OfertaColumnMapping,
  type OfertaField,
  type OfertaMetadata,
} from "../extraction/typesOfertas.js";

export const UPLOADS_DIR = path.join(process.cwd(), "uploads");
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

uploadsRouter.use(requireRole("ADMINISTRADOR"));

// Valida el shape de "mapeo" (columnaOrigen -> campoDestino) compartido por
// /aprobar-mapeo y /confirmar, contra el set de campos canónicos que
// corresponda (catálogo u ofertas, según carga.tipoDatos). No exige que
// tenga entradas: una carga con todos los valores tipeados a mano y ninguna
// columna mapeada es válida para /confirmar (no lo es para /aprobar-mapeo,
// que chequea eso aparte).
// Ofertas: un destino por columna (sin cambios, no admite uno-a-muchos).
function parseMapeoBodyOferta(
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

// Catálogo: cada columna admite un destino solo o una lista (mapeo
// uno-a-muchos, ver mapping.ts) — acepta ambas formas por columna en el
// body y siempre normaliza a array.
function parseMapeoBodyCatalogo(
  body: unknown,
  camposValidos: readonly string[]
): { mapping: Record<string, string[]> } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Falta 'mapeo' (objeto columnaOrigen -> campoDestino) en el body." };
  }
  const mapping: Record<string, string[]> = {};
  for (const [columna, destino] of Object.entries(body)) {
    const destinos = (Array.isArray(destino) ? destino : [destino]).filter(
      (d): d is string => typeof d === "string" && camposValidos.includes(d)
    );
    if (destinos.length > 0) mapping[columna] = destinos;
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
  // Solo tiene sentido para ofertas (ver sinFechaLimite en schema.prisma);
  // en catálogo se ignora aunque venga en el body.
  const sinFechaLimite = tipoDatos === "oferta" && req.body.sinFechaLimite === "true";

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
      sinFechaLimite,
      estado: "pendiente",
    },
  });

  res.status(201).json(carga);
});

// La lista de /cargas solo muestra archivo/proveedor/formato/tipo/estado/
// fecha (ver lubricentro-victoria-front/app/cargas/page.tsx) — nunca
// filasExtraidas, que puede pesar varios cientos de KB por carga (el
// contenido completo del archivo parseado). Traerlo igual para ordenar por
// createdAt en una tabla con archivos grandes puede superar el
// sort_buffer_size de MySQL ("Out of sort memory"). El detalle completo
// (incluido filasExtraidas) se sigue sirviendo aparte en GET /:id, que es
// lo único que la pantalla de revisión necesita.
uploadsRouter.get("/", async (_req, res) => {
  const cargas = await prisma.carga.findMany({
    select: {
      id: true,
      nombreArchivo: true,
      tipoArchivo: true,
      tipoDatos: true,
      estado: true,
      createdAt: true,
      proveedor: { select: { id: true, nombre: true } },
    },
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
  const esOferta = carga.tipoDatos === "oferta";
  const campos = esOferta ? CANONICAL_FIELDS_OFERTAS : CANONICAL_FIELDS;

  const parsed = esOferta
    ? parseMapeoBodyOferta(req.body?.mapeo, campos)
    : parseMapeoBodyCatalogo(req.body?.mapeo, campos);
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
    const publicados = esOferta
      ? await aprobarMapeoYPublicar(id, parsed.mapping as OfertaColumnMapping)
      : await aprobarMapeoYPublicar(id, parsed.mapping as ColumnMapping);
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
  const esOferta = carga.tipoDatos === "oferta";
  const campos = esOferta ? CANONICAL_FIELDS_OFERTAS : CANONICAL_FIELDS;

  const parsed = esOferta
    ? parseMapeoBodyOferta(req.body?.mapeo ?? {}, campos)
    : parseMapeoBodyCatalogo(req.body?.mapeo ?? {}, campos);
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
    const publicados = esOferta
      ? await confirmarCargaYPublicarOferta(
          id,
          parsed.mapping as OfertaColumnMapping,
          filas as Array<Partial<Record<OfertaField, unknown>> & { raw_data?: unknown }>
        )
      : await confirmarCargaYPublicar(id, parsed.mapping as ColumnMapping, filas as Array<CanonicalRowUpload>);
    const cargaFinal = await prisma.carga.findUnique({ where: { id }, include: { proveedor: true } });
    res.json({ carga: cargaFinal, publicados });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Cancela una carga todavía no publicada (botón "Cancelar carga" en la
// pantalla de revisión). Solo permitido en revision_pendiente/
// confirmacion_pendiente: son los únicos estados sin ProductoPrecio/Oferta
// ya vinculados (esos se crean recién al confirmar), así que borrar la
// Carga acá no deja nada huérfano de forma inesperada.
uploadsRouter.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const carga = await prisma.carga.findUnique({ where: { id } });
  if (!carga) {
    res.status(404).json({ error: "Carga no encontrada." });
    return;
  }
  if (carga.estado !== "revision_pendiente" && carga.estado !== "confirmacion_pendiente") {
    res.status(400).json({ error: "Solo se puede cancelar una carga en revisión, todavía no publicada." });
    return;
  }
  try {
    await prisma.carga.delete({ where: { id } });
    res.json({ id });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  // Limpieza del archivo en disco: best-effort, no bloquea la respuesta ya
  // enviada. La Carga (el dato que le importa al usuario) ya se borró; que
  // sobreviva un archivo huérfano en uploads/ es inofensivo (nada vuelve a
  // leer carga.rutaArchivo una vez borrada la fila), mientras que fallar acá
  // por un archivo bloqueado dejaría al usuario sin forma de cancelar la
  // carga desde la UI. Mismo criterio de "ignorar ENOENT" que
  // eliminarArchivoImagen (../lib/imagenes.ts), pero acá cualquier otro
  // error solo se loguea, no se relanza.
  fs.promises.unlink(carga.rutaArchivo).catch((err) => {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`No se pudo borrar el archivo de la carga ${id} (${carga.rutaArchivo}):`, err);
    }
  });
});
