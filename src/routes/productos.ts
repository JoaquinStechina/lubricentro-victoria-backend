import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { requireRole } from "../middleware/auth.js";
import { enviarExport, type FilaExport } from "./exportar.js";
import { imagenUploadSingle, imagenPublicUrl, eliminarArchivoImagen } from "../lib/imagenes.js";

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
const COLUMNAS_TEXTO: Record<string, keyof Prisma.ProductoPrecioWhereInput> = {
  marca: "marca",
  sku: "skuInterno", // se resuelve especial más abajo (también matchea skuProveedor)
  descripcion: "descripcion",
  seccion: "seccion",
  fechaVigencia: "fechaVigencia",
  unidad: "unidad",
};
// Numéricos con filtro de rango (f_<campo>Min / f_<campo>Max, gte/lte);
// alicuotaIva queda con igualdad exacta (tiene un puñado de valores fijos).
const COLUMNAS_NUMERO_RANGO = ["precioNeto", "precioConIva"] as const;
const COLUMNAS_NUMERO_EXACTO = ["alicuotaIva"] as const;

// Orden por columna: whitelist explícita clave-de-columna -> orderBy de
// Prisma (nunca interpolar req.query directo en el orderBy). "sku" ordena
// solo por skuInterno aunque la celda muestre skuInterno ?? skuProveedor
// (Prisma no puede hacer coalesce en orderBy) — documentado en el README.
const PRODUCTOS_SORTABLE: Record<
  string,
  (o: "asc" | "desc") => Prisma.ProductoPrecioOrderByWithRelationInput
> = {
  proveedor: (o) => ({ proveedor: { nombre: o } }),
  marca: (o) => ({ marca: o }),
  sku: (o) => ({ skuInterno: o }),
  descripcion: (o) => ({ descripcion: o }),
  seccion: (o) => ({ seccion: o }),
  precioNeto: (o) => ({ precioNeto: o }),
  precioConIva: (o) => ({ precioConIva: o }),
  alicuotaIva: (o) => ({ alicuotaIva: o }),
  fechaVigencia: (o) => ({ fechaVigencia: o }),
};

// Papelera: con ?incluirEliminados=true la tabla pasa a mostrar SOLO las
// filas eliminadas (vista dedicada, no mezcladas con las vivas), y
// únicamente para ADMINISTRADOR+ — si un EMPLEADO manda el flag a mano se
// ignora (los GET no tienen requireRole, así que se chequea acá).
export function vistaPapelera(req: {
  query: Record<string, unknown>;
  user?: { rol: string };
}): boolean {
  return req.query.incluirEliminados === "true" && !!req.user && req.user.rol !== "EMPLEADO";
}

// Construye el where de GET / a partir de los query params — extraído para
// reusarlo en /export sin duplicar la lógica de filtros.
export function buildProductosWhere(req: {
  query: Record<string, unknown>;
  user?: { rol: string };
}): Prisma.ProductoPrecioWhereInput {
  const proveedorId = req.query.proveedorId ? Number(req.query.proveedorId) : undefined;
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

  const filtros: Prisma.ProductoPrecioWhereInput[] = [];
  for (const [param, campo] of Object.entries(COLUMNAS_TEXTO)) {
    const raw = req.query[`f_${param}`];
    if (typeof raw !== "string" || !raw.trim()) continue;
    if (param === "sku") {
      filtros.push({
        OR: [
          { skuInterno: { contains: raw.trim() } },
          { skuProveedor: { contains: raw.trim() } },
        ],
      });
    } else {
      filtros.push({ [campo]: { contains: raw.trim() } } as Prisma.ProductoPrecioWhereInput);
    }
  }
  const rawProveedorFiltro = req.query.f_proveedor;
  if (typeof rawProveedorFiltro === "string" && rawProveedorFiltro.trim()) {
    filtros.push({ proveedor: { nombre: { contains: rawProveedorFiltro.trim() } } });
  }
  for (const campo of COLUMNAS_NUMERO_EXACTO) {
    const raw = req.query[`f_${campo}`];
    if (typeof raw !== "string" || !raw.trim()) continue;
    const num = Number(raw);
    if (Number.isFinite(num)) filtros.push({ [campo]: num } as Prisma.ProductoPrecioWhereInput);
  }
  for (const campo of COLUMNAS_NUMERO_RANGO) {
    const rawMin = req.query[`f_${campo}Min`];
    const rawMax = req.query[`f_${campo}Max`];
    const min = typeof rawMin === "string" && rawMin.trim() ? Number(rawMin) : NaN;
    const max = typeof rawMax === "string" && rawMax.trim() ? Number(rawMax) : NaN;
    if (Number.isFinite(min)) filtros.push({ [campo]: { gte: min } } as Prisma.ProductoPrecioWhereInput);
    if (Number.isFinite(max)) filtros.push({ [campo]: { lte: max } } as Prisma.ProductoPrecioWhereInput);
  }
  if (search) {
    filtros.push({
      OR: [
        { proveedor: { nombre: { contains: search } } },
        { marca: { contains: search } },
        { skuInterno: { contains: search } },
        { skuProveedor: { contains: search } },
        { descripcion: { contains: search } },
        { seccion: { contains: search } },
        { fechaVigencia: { contains: search } },
      ],
    });
  }

  // En la papelera no se filtra por vigente: una fila eliminada pudo haber
  // sido superada por una carga posterior mientras estaba en la papelera y
  // igual tiene que poder verse/restaurarse.
  if (vistaPapelera(req)) {
    return {
      eliminado: true,
      ...(proveedorId ? { proveedorId } : {}),
      AND: filtros,
    };
  }

  return {
    vigente: true,
    eliminado: false,
    ...(proveedorId ? { proveedorId } : {}),
    AND: filtros,
  };
}

// Orden elegido por el usuario (?sort=&order=) con desempate por createdAt
// desc; sin sort (o con una clave fuera de la whitelist) queda el orden
// histórico por fecha de carga.
export function buildProductosOrderBy(req: {
  query: Record<string, unknown>;
}): Prisma.ProductoPrecioOrderByWithRelationInput[] {
  const sort = typeof req.query.sort === "string" ? req.query.sort : "";
  const order = req.query.order === "asc" ? "asc" : "desc";
  const sortable = PRODUCTOS_SORTABLE[sort];
  if (!sortable) return [{ createdAt: "desc" }];
  return [sortable(order), { createdAt: "desc" }];
}

// Exporta el resultado filtrado COMPLETO (mismos filtros y orden que GET /,
// sin paginar) como CSV o XLSX. Mismo rol que la lectura (EMPLEADO): es
// exactamente la misma data que ya ve en pantalla. El select explícito
// evita cargar rawData (JSON potencialmente grande) en memoria.
productosRouter.get("/export", async (req, res) => {
  const productos = await prisma.productoPrecio.findMany({
    where: buildProductosWhere(req),
    distinct: vistaPapelera(req) ? undefined : ["proveedorId", "marca", "skuProveedor"],
    orderBy: buildProductosOrderBy(req),
    select: {
      marca: true,
      skuInterno: true,
      skuProveedor: true,
      descripcion: true,
      seccion: true,
      precioNeto: true,
      precioConIva: true,
      alicuotaIva: true,
      moneda: true,
      unidad: true,
      fechaVigencia: true,
      proveedor: { select: { nombre: true } },
    },
  });

  const headers = [
    "Proveedor",
    "Marca",
    "SKU interno",
    "SKU proveedor",
    "Descripción",
    "Sección",
    "Precio neto",
    "Precio c/IVA",
    "IVA %",
    "Moneda",
    "Unidad",
    "Vigencia",
  ];
  const filas: FilaExport[] = productos.map((p) => ({
    Proveedor: p.proveedor?.nombre ?? null,
    Marca: p.marca,
    "SKU interno": p.skuInterno,
    "SKU proveedor": p.skuProveedor,
    Descripción: p.descripcion,
    Sección: p.seccion,
    "Precio neto": p.precioNeto,
    "Precio c/IVA": p.precioConIva,
    "IVA %": p.alicuotaIva,
    Moneda: p.moneda,
    Unidad: p.unidad,
    Vigencia: p.fechaVigencia,
  }));
  enviarExport(res, req.query.formato, "catalogo", headers, filas);
});

// Valores distintos de Sección para el combobox del filtro en el frontend.
// Registrado antes de las rutas /:id (GET no colisiona con PATCH /:id, pero
// se mantiene el criterio de orden del archivo).
productosRouter.get("/secciones", async (_req, res) => {
  const rows = await prisma.productoPrecio.findMany({
    where: { vigente: true, eliminado: false, seccion: { not: null } },
    distinct: ["seccion"],
    select: { seccion: true },
    orderBy: { seccion: "asc" },
  });
  res.json(rows.map((r) => r.seccion));
});

productosRouter.get("/", async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 100));
  const where = buildProductosWhere(req);
  const orderBy = buildProductosOrderBy(req);

  const [total, items] = await Promise.all([
    prisma.productoPrecio.count({ where }),
    prisma.productoPrecio.findMany({
      where,
      // En la papelera no aplica el distinct: cada fila eliminada tiene que
      // verse por separado (y una eliminada que comparte proveedor+marca+SKU
      // con otra quedaría oculta).
      distinct: vistaPapelera(req) ? undefined : ["proveedorId", "marca", "skuProveedor"],
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { proveedor: true },
    }),
  ]);

  res.json({ items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
});

const SINGLE_EDIT_FIELDS = [
  "marca",
  "skuProveedor",
  "skuInterno",
  "descripcion",
  "seccion",
  "precioNeto",
  "precioConIva",
  "alicuotaIva",
  "moneda",
  "unidad",
  "fechaVigencia",
] as const;
type SingleEditField = (typeof SINGLE_EDIT_FIELDS)[number];

const BULK_EDIT_FIELDS = [
  "seccion",
  "precioNeto",
  "precioConIva",
  "alicuotaIva",
  "moneda",
  "unidad",
  "fechaVigencia",
] as const;
type BulkEditField = (typeof BULK_EDIT_FIELDS)[number];

const CAMPOS_NUMERICOS = new Set<string>(["precioNeto", "precioConIva", "alicuotaIva"]);

// Valida y coerciona un valor según el tipo esperado del campo. Devuelve
// `{ok:false}` si el valor no es válido para ese campo (400 en el caller).
function coerceValor(campo: string, value: unknown): { ok: true; value: unknown } | { ok: false } {
  if (CAMPOS_NUMERICOS.has(campo)) {
    if (value === null) return { ok: true, value: null };
    const num = Number(value);
    if (!Number.isFinite(num)) return { ok: false };
    return { ok: true, value: num };
  }
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  return { ok: true, value };
}

function buildSingleEditData(body: unknown): Record<string, unknown> | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  for (const campo of SINGLE_EDIT_FIELDS) {
    if (!(campo in b)) continue;
    const coerced = coerceValor(campo, b[campo]);
    if (!coerced.ok) return null;
    data[campo] = coerced.value;
  }
  return data;
}

// A diferencia de buildSingleEditData (PATCH parcial: los campos ausentes no
// se tocan), acá es un INSERT: los campos ausentes van explícitamente a null
// — excepto `moneda`, que en el schema es NOT NULL con default "ARS"
// (todos los demás campos de SINGLE_EDIT_FIELDS son nullable): pisarlo con
// null rompería el INSERT, así que ahí el ausente cae al default en vez de a
// null.
function buildCreateData(body: unknown): Record<string, unknown> | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  for (const campo of SINGLE_EDIT_FIELDS) {
    const valorCrudo = campo === "moneda" ? (b[campo] ?? "ARS") : (b[campo] ?? null);
    const coerced = coerceValor(campo, valorCrudo);
    if (!coerced.ok) return null;
    data[campo] = coerced.value;
  }
  return data;
}

// Resuelve el proveedor de un alta manual: por id existente, o por nombre
// (upsert, mismo bloque que ya usa uploadsRouter.post("/") en uploads.ts al
// recibir un archivo nuevo). Devuelve null si no se pudo resolver ninguno.
async function resolverProveedor(body: {
  proveedorId?: unknown;
  proveedorNombre?: unknown;
}): Promise<number | null> {
  if (body.proveedorId != null) {
    const id = Number(body.proveedorId);
    if (!Number.isFinite(id)) return null;
    const proveedor = await prisma.proveedor.findUnique({ where: { id } });
    return proveedor ? proveedor.id : null;
  }
  const nombre = typeof body.proveedorNombre === "string" ? body.proveedorNombre.trim() : "";
  if (!nombre) return null;
  const proveedor = await prisma.proveedor.upsert({
    where: { nombre },
    update: {},
    create: { nombre },
  });
  return proveedor.id;
}

// Alta manual de un producto suelto, en paralelo al pipeline de carga masiva
// de archivos (/api/uploads). Body: {proveedorId|proveedorNombre, ...campos
// de SINGLE_EDIT_FIELDS}.
productosRouter.post("/", requireRole("ADMINISTRADOR"), async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const proveedorId = await resolverProveedor(body);
  if (!proveedorId) {
    res.status(400).json({ error: "Falta proveedorId (existente) o proveedorNombre." });
    return;
  }

  const data = buildCreateData(body);
  if (!data) {
    res.status(400).json({ error: `Body inválido. Campos permitidos: ${SINGLE_EDIT_FIELDS.join(", ")}` });
    return;
  }

  const skuProveedor = typeof data.skuProveedor === "string" ? data.skuProveedor : null;
  const marca = typeof data.marca === "string" ? data.marca : null;
  try {
    if (skuProveedor) {
      // La fila nueva pasa a ser "la vigente" de esa identidad proveedor+marca+
      // SKU (mismo criterio de una línea que publicarCanonicalRows en
      // processCarga.ts), para no convivir duplicada con una carga previa.
      await prisma.productoPrecio.updateMany({
        where: { proveedorId, marca, skuProveedor, vigente: true },
        data: { vigente: false },
      });
    }

    const producto = await prisma.productoPrecio.create({
      data: { proveedorId, ...data, cargaId: null } as Prisma.ProductoPrecioUncheckedCreateInput,
      include: { proveedor: true },
    });
    res.status(201).json(producto);
  } catch (err) {
    // Nunca dejar que un error de Prisma (ej. constraint) llegue como
    // rechazo no manejado: Express 4 no atrapa promesas de handlers async
    // por su cuenta, y un rejection sin catch tira abajo todo el proceso.
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Historial de precios de un SKU: todas las filas (vigentes o no,
// eliminadas incluidas — el historial son justamente las superadas) que
// comparten la identidad proveedor+marca+skuProveedor de la fila pedida,
// en orden cronológico de carga. Si la fila no tiene skuProveedor no hay
// identidad confiable para agrupar (mismo criterio que publicarCanonicalRows)
// y se devuelve solo esa fila.
productosRouter.get("/:id/historial", async (req, res) => {
  const id = Number(req.params.id);
  const base = await prisma.productoPrecio.findUnique({ where: { id } });
  if (!base) {
    res.status(404).json({ error: "Producto no encontrado" });
    return;
  }
  const items = await prisma.productoPrecio.findMany({
    where: base.skuProveedor
      ? { proveedorId: base.proveedorId, marca: base.marca, skuProveedor: base.skuProveedor }
      : { id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      precioNeto: true,
      precioConIva: true,
      alicuotaIva: true,
      fechaVigencia: true,
      vigente: true,
      eliminado: true,
      createdAt: true,
      carga: { select: { nombreArchivo: true } },
    },
  });
  res.json({ items });
});

// IMPORTANTE: /editar-lote y /eliminar van ANTES de /:id — si no, Express
// intentaría matchear "editar-lote"/"eliminar" como si fueran un :id (pero
// como son rutas con método/verbo distinto de PATCH /:id no colisionan en
// la práctica; se registran en este orden igual por claridad y consistencia
// con el resto del archivo).
productosRouter.post("/editar-lote", requireRole("ADMINISTRADOR"), async (req, res) => {
  const b = (req.body ?? {}) as { ids?: unknown; field?: unknown; value?: unknown };
  const ids = Array.isArray(b.ids) ? b.ids.filter((v) => Number.isFinite(Number(v))).map(Number) : [];
  const field = typeof b.field === "string" ? b.field : "";
  if (ids.length === 0 || !(BULK_EDIT_FIELDS as readonly string[]).includes(field)) {
    res.status(400).json({
      error: `Body inválido: se esperaba {ids: number[], field, value} con field uno de: ${BULK_EDIT_FIELDS.join(", ")}`,
    });
    return;
  }
  const coerced = coerceValor(field, b.value);
  if (!coerced.ok) {
    res.status(400).json({ error: `Valor inválido para el campo "${field}"` });
    return;
  }
  const { count } = await prisma.productoPrecio.updateMany({
    where: { id: { in: ids }, eliminado: false },
    data: { [field as BulkEditField]: coerced.value } as Prisma.ProductoPrecioUpdateManyMutationInput,
  });
  res.json({ actualizados: count });
});

productosRouter.post("/eliminar", requireRole("ADMINISTRADOR"), async (req, res) => {
  const b = (req.body ?? {}) as { ids?: unknown };
  const ids = Array.isArray(b.ids) ? b.ids.filter((v) => Number.isFinite(Number(v))).map(Number) : [];
  if (ids.length === 0) {
    res.status(400).json({ error: "Body inválido: se esperaba {ids: number[]}" });
    return;
  }
  const { count } = await prisma.productoPrecio.updateMany({
    where: { id: { in: ids } },
    data: { eliminado: true },
  });
  res.json({ eliminados: count });
});

// Espejo de /eliminar: saca filas de la papelera (ver vistaPapelera).
productosRouter.post("/restaurar", requireRole("ADMINISTRADOR"), async (req, res) => {
  const b = (req.body ?? {}) as { ids?: unknown };
  const ids = Array.isArray(b.ids) ? b.ids.filter((v) => Number.isFinite(Number(v))).map(Number) : [];
  if (ids.length === 0) {
    res.status(400).json({ error: "Body inválido: se esperaba {ids: number[]}" });
    return;
  }
  const { count } = await prisma.productoPrecio.updateMany({
    where: { id: { in: ids } },
    data: { eliminado: false },
  });
  res.json({ restaurados: count });
});

productosRouter.patch("/:id", requireRole("ADMINISTRADOR"), async (req, res) => {
  const id = Number(req.params.id);
  const objetivo = await prisma.productoPrecio.findUnique({ where: { id } });
  if (!objetivo || objetivo.eliminado) {
    res.status(404).json({ error: "Producto no encontrado" });
    return;
  }
  const data = buildSingleEditData(req.body);
  if (!data) {
    res.status(400).json({ error: `Body inválido. Campos permitidos: ${SINGLE_EDIT_FIELDS.join(", ")}` });
    return;
  }
  const producto = await prisma.productoPrecio.update({
    where: { id },
    data: data as Prisma.ProductoPrecioUpdateInput,
    include: { proveedor: true },
  });
  res.json(producto);
});

// Sube/reemplaza la foto de un producto. Endpoint aparte del PATCH genérico
// a propósito: imagenUrl es un nombre de archivo gestionado por el servidor
// (via multer), no un valor que el usuario tipea, y reemplazarla implica
// borrar el archivo físico viejo (ver eliminarArchivoImagen).
productosRouter.post(
  "/:id/imagen",
  requireRole("ADMINISTRADOR"),
  imagenUploadSingle,
  async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: "Falta el archivo (campo 'imagen')." });
      return;
    }
    try {
      const id = Number(req.params.id);
      const objetivo = await prisma.productoPrecio.findUnique({ where: { id } });
      if (!objetivo || objetivo.eliminado) {
        res.status(404).json({ error: "Producto no encontrado" });
        return;
      }
      await eliminarArchivoImagen(objetivo.imagenUrl);
      const producto = await prisma.productoPrecio.update({
        where: { id },
        data: { imagenUrl: imagenPublicUrl(req.file.filename) },
        include: { proveedor: true },
      });
      res.json(producto);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

productosRouter.delete("/:id/imagen", requireRole("ADMINISTRADOR"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const objetivo = await prisma.productoPrecio.findUnique({ where: { id } });
    if (!objetivo || objetivo.eliminado) {
      res.status(404).json({ error: "Producto no encontrado" });
      return;
    }
    await eliminarArchivoImagen(objetivo.imagenUrl);
    const producto = await prisma.productoPrecio.update({
      where: { id },
      data: { imagenUrl: null },
      include: { proveedor: true },
    });
    res.json(producto);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
