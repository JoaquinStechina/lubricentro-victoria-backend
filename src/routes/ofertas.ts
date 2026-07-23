import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { requireRole } from "../middleware/auth.js";
import { enviarExport, type FilaExport } from "./exportar.js";
import { imagenUploadSingle, imagenPublicUrl, eliminarArchivoImagen } from "../lib/imagenes.js";
import { roundTo2 } from "../lib/numeros.js";

export const ofertasRouter = Router();

const COLUMNAS_TEXTO_CONTAINS: Record<string, keyof Prisma.OfertaWhereInput> = {
  marca: "marca",
  sku: "skuProveedor",
  descripcion: "descripcion",
  fechaOferta: "fechaOferta",
  horaOferta: "horaOferta",
};
// numeroOferta y desdeCantidad son identificadores, quedan con igualdad
// exacta; descuentoPct y precioUnitario se filtran por rango (Min/Max).
const COLUMNAS_NUMERO_EXACTO = ["numeroOferta", "desdeCantidad"] as const;
const COLUMNAS_NUMERO_RANGO = ["descuentoPct", "precioUnitario", "cantidadDisponible"] as const;

// Fecha local del servidor en YYYY-MM-DD (en-CA da ese formato). No usar
// toISOString(): es UTC, y en Argentina (UTC-3) después de las 21:00 haría
// aparecer como vencida una oferta que todavía vence "hoy".
export function hoyLocalISO(): string {
  return new Intl.DateTimeFormat("en-CA").format(new Date());
}

// Orden por columna: whitelist explícita (mismo criterio que productos.ts).
// fechaHasta es nullable: nulls al final para que "hasta agotar stock"
// quede después de las fechas concretas en ambas direcciones.
const OFERTAS_SORTABLE: Record<
  string,
  (o: "asc" | "desc") => Prisma.OfertaOrderByWithRelationInput
> = {
  proveedor: (o) => ({ proveedor: { nombre: o } }),
  marca: (o) => ({ marca: o }),
  numeroOferta: (o) => ({ numeroOferta: o }),
  sku: (o) => ({ skuProveedor: o }),
  descripcion: (o) => ({ descripcion: o }),
  desdeCantidad: (o) => ({ desdeCantidad: o }),
  descuentoPct: (o) => ({ descuentoPct: o }),
  precioUnitario: (o) => ({ precioUnitario: o }),
  fechaOferta: (o) => ({ fechaOferta: o }),
  fechaHasta: (o) => ({ fechaHasta: { sort: o, nulls: "last" } }),
  cantidadDisponible: (o) => ({ cantidadDisponible: { sort: o, nulls: "last" } }),
};

// Papelera: con ?incluirEliminados=true la tabla pasa a mostrar SOLO las
// filas eliminadas, únicamente para ADMINISTRADOR+ (paralelo a
// productos.ts#vistaPapelera).
export function vistaPapelera(req: {
  query: Record<string, unknown>;
  user?: { rol: string };
}): boolean {
  return req.query.incluirEliminados === "true" && !!req.user && req.user.rol !== "EMPLEADO";
}

// Construye el where de GET / a partir de los query params — extraído para
// reusarlo en /export sin duplicar la lógica de filtros.
export function buildOfertasWhere(req: {
  query: Record<string, unknown>;
  user?: { rol: string };
}): Prisma.OfertaWhereInput {
  const proveedorId = req.query.proveedorId ? Number(req.query.proveedorId) : undefined;
  const incluirCerradas = req.query.incluirCerradas === "true";
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

  const filtros: Prisma.OfertaWhereInput[] = [];
  for (const [param, campo] of Object.entries(COLUMNAS_TEXTO_CONTAINS)) {
    const raw = req.query[`f_${param}`];
    if (typeof raw !== "string" || !raw.trim()) continue;
    filtros.push({ [campo]: { contains: raw.trim() } } as Prisma.OfertaWhereInput);
  }
  const rawProveedorFiltro = req.query.f_proveedor;
  if (typeof rawProveedorFiltro === "string" && rawProveedorFiltro.trim()) {
    filtros.push({ proveedor: { nombre: { contains: rawProveedorFiltro.trim() } } });
  }
  for (const campo of COLUMNAS_NUMERO_EXACTO) {
    const raw = req.query[`f_${campo}`];
    if (typeof raw !== "string" || !raw.trim()) continue;
    const num = Number(raw);
    if (Number.isFinite(num)) filtros.push({ [campo]: num } as Prisma.OfertaWhereInput);
  }
  for (const campo of COLUMNAS_NUMERO_RANGO) {
    const rawMin = req.query[`f_${campo}Min`];
    const rawMax = req.query[`f_${campo}Max`];
    const min = typeof rawMin === "string" && rawMin.trim() ? Number(rawMin) : NaN;
    const max = typeof rawMax === "string" && rawMax.trim() ? Number(rawMax) : NaN;
    if (Number.isFinite(min)) filtros.push({ [campo]: { gte: min } } as Prisma.OfertaWhereInput);
    if (Number.isFinite(max)) filtros.push({ [campo]: { lte: max } } as Prisma.OfertaWhereInput);
  }
  // "sin_fecha"/"con_fecha": fechaHasta null (hasta agotar stock) no se puede
  // filtrar con un "contains" de texto como las demás columnas.
  const rawVigencia = req.query.f_vigencia;
  if (rawVigencia === "sin_fecha") {
    filtros.push({ fechaHasta: null });
  } else if (rawVigencia === "con_fecha") {
    filtros.push({ fechaHasta: { not: null } });
  }
  // Fecha de vencimiento puntual: igualdad exacta (viene de un date picker
  // en formato YYYY-MM-DD, el mismo en que se guarda fechaHasta).
  const rawFechaHasta = req.query.f_fechaHasta;
  if (typeof rawFechaHasta === "string" && rawFechaHasta.trim()) {
    filtros.push({ fechaHasta: rawFechaHasta.trim() });
  }
  if (search) {
    filtros.push({
      OR: [
        { proveedor: { nombre: { contains: search } } },
        { marca: { contains: search } },
        { skuProveedor: { contains: search } },
        { descripcion: { contains: search } },
        { fechaOferta: { contains: search } },
        { horaOferta: { contains: search } },
      ],
    });
  }

  // Papelera: solo eliminadas, sin la condición de "activa" (una oferta
  // eliminada se ve en la papelera esté cerrada, vencida o no).
  if (vistaPapelera(req)) {
    return {
      eliminado: true,
      ...(proveedorId ? { proveedorId } : {}),
      AND: filtros,
    };
  }

  return {
    eliminado: false,
    ...(proveedorId ? { proveedorId } : {}),
    ...(incluirCerradas
      ? {}
      : {
          activa: true,
          OR: [{ fechaHasta: null }, { fechaHasta: { gte: hoyLocalISO() } }],
        }),
    AND: filtros,
  };
}

// Orden elegido por el usuario (?sort=&order=) con desempate por createdAt
// desc; sin sort válido queda el orden histórico por fecha de carga.
export function buildOfertasOrderBy(req: {
  query: Record<string, unknown>;
}): Prisma.OfertaOrderByWithRelationInput[] {
  const sort = typeof req.query.sort === "string" ? req.query.sort : "";
  const order = req.query.order === "asc" ? "asc" : "desc";
  const sortable = OFERTAS_SORTABLE[sort];
  if (!sortable) return [{ createdAt: "desc" }];
  return [sortable(order), { createdAt: "desc" }];
}

// "Activa" es una condición calculada, no un solo campo: combina el cierre
// manual (activa:false, ver /cerrar más abajo) con el vencimiento por fecha
// (fechaHasta en formato YYYY-MM-DD, comparación lexicográfica sin parsear)
// — evita necesitar un cron/worker que cierre solas las que ya vencieron.
// null en fechaHasta = "hasta agotar stock", solo se cierra a mano.
ofertasRouter.get("/", async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 100));
  const where = buildOfertasWhere(req);
  const orderBy = buildOfertasOrderBy(req);

  // A diferencia de Productos, Oferta no tiene concepto de "vigente"/
  // distinct por identidad — cada tramo/oferta convive naturalmente, así que
  // el count es exacto sin las salvedades que aplican en productos.ts.
  const [total, items] = await Promise.all([
    prisma.oferta.count({ where }),
    prisma.oferta.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { proveedor: true },
    }),
  ]);

  res.json({ items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
});

// Exporta el resultado filtrado completo (mismos filtros y orden que GET /)
// como CSV o XLSX. Mismo rol que la lectura (EMPLEADO).
ofertasRouter.get("/export", async (req, res) => {
  const ofertas = await prisma.oferta.findMany({
    where: buildOfertasWhere(req),
    orderBy: buildOfertasOrderBy(req),
    select: {
      marca: true,
      numeroOferta: true,
      skuProveedor: true,
      descripcion: true,
      desdeCantidad: true,
      descuentoPct: true,
      precioUnitario: true,
      moneda: true,
      fechaOferta: true,
      horaOferta: true,
      fechaHasta: true,
      cantidadDisponible: true,
      activa: true,
      proveedor: { select: { nombre: true } },
    },
  });

  const hoy = hoyLocalISO();
  const headers = [
    "Proveedor",
    "Marca",
    "N° oferta",
    "SKU proveedor",
    "Descripción",
    "Desde cantidad",
    "Descuento %",
    "Precio unitario",
    "Moneda",
    "Fecha oferta",
    "Hora oferta",
    "Válida hasta",
    "Cantidad disponible",
    "Estado",
  ];
  const filas: FilaExport[] = ofertas.map((o) => ({
    Proveedor: o.proveedor?.nombre ?? null,
    Marca: o.marca,
    "N° oferta": o.numeroOferta,
    "SKU proveedor": o.skuProveedor,
    Descripción: o.descripcion,
    "Desde cantidad": o.desdeCantidad,
    "Descuento %": o.descuentoPct,
    "Precio unitario": o.precioUnitario,
    Moneda: o.moneda,
    "Fecha oferta": o.fechaOferta,
    "Hora oferta": o.horaOferta,
    "Válida hasta": o.fechaHasta ?? "Hasta agotar stock",
    "Cantidad disponible": o.cantidadDisponible,
    Estado: !o.activa ? "Cerrada" : o.fechaHasta && o.fechaHasta < hoy ? "Vencida" : "Activa",
  }));
  enviarExport(res, req.query.formato, "ofertas", headers, filas);
});

// Historial de un tramo de oferta: todas las filas (activas, cerradas,
// vencidas o eliminadas) del mismo proveedor+SKU+desde_cantidad a través
// de las cargas — comparar tramos distintos daría saltos falsos, el precio
// baja a propósito con más cantidad (mismo criterio que las advertencias).
ofertasRouter.get("/:id/historial", async (req, res) => {
  const id = Number(req.params.id);
  const base = await prisma.oferta.findUnique({ where: { id } });
  if (!base) {
    res.status(404).json({ error: "Oferta no encontrada" });
    return;
  }
  const items = await prisma.oferta.findMany({
    where: {
      proveedorId: base.proveedorId,
      skuProveedor: base.skuProveedor,
      desdeCantidad: base.desdeCantidad,
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      numeroOferta: true,
      descuentoPct: true,
      precioUnitario: true,
      moneda: true,
      fechaOferta: true,
      fechaHasta: true,
      activa: true,
      eliminado: true,
      archivoOrigen: true,
      createdAt: true,
    },
  });
  res.json({ items });
});

type CerrarBody = { proveedorId?: unknown; numeroOferta?: unknown; skuProveedor?: unknown };

function parseCerrarBody(body: unknown): { proveedorId: number; numeroOferta: number; skuProveedor: string } | null {
  const b = (body ?? {}) as CerrarBody;
  const proveedorId = Number(b.proveedorId);
  const numeroOferta = Number(b.numeroOferta);
  const skuProveedor = typeof b.skuProveedor === "string" ? b.skuProveedor : "";
  if (!Number.isFinite(proveedorId) || !Number.isFinite(numeroOferta) || !skuProveedor) return null;
  return { proveedorId, numeroOferta, skuProveedor };
}

// Cierran (o reabren) TODOS los tramos (desde_cantidad distintos) de un
// mismo sku_proveedor dentro de una misma oferta — "se acabó el stock" es
// un hecho del producto, no de un tramo puntual de cantidad/descuento.
ofertasRouter.post("/cerrar", requireRole("ADMINISTRADOR"), async (req, res) => {
  const parsed = parseCerrarBody(req.body);
  if (!parsed) {
    res.status(400).json({ error: "Body inválido: se esperaba {proveedorId, numeroOferta, skuProveedor}." });
    return;
  }
  const { count } = await prisma.oferta.updateMany({
    where: {
      proveedorId: parsed.proveedorId,
      numeroOferta: parsed.numeroOferta,
      skuProveedor: parsed.skuProveedor,
    },
    data: { activa: false },
  });
  res.json({ actualizadas: count });
});

ofertasRouter.post("/reactivar", requireRole("ADMINISTRADOR"), async (req, res) => {
  const parsed = parseCerrarBody(req.body);
  if (!parsed) {
    res.status(400).json({ error: "Body inválido: se esperaba {proveedorId, numeroOferta, skuProveedor}." });
    return;
  }
  const { count } = await prisma.oferta.updateMany({
    where: {
      proveedorId: parsed.proveedorId,
      numeroOferta: parsed.numeroOferta,
      skuProveedor: parsed.skuProveedor,
    },
    data: { activa: true },
  });
  res.json({ actualizadas: count });
});

const SINGLE_EDIT_FIELDS = [
  "marca",
  "numeroOferta",
  "skuProveedor",
  "descripcion",
  "desdeCantidad",
  "descuentoPct",
  "precioUnitario",
  "moneda",
  "fechaOferta",
  "horaOferta",
  "fechaHasta",
  "cantidadDisponible",
] as const;

const BULK_EDIT_FIELDS = [
  "desdeCantidad",
  "descuentoPct",
  "precioUnitario",
  "moneda",
  "fechaOferta",
  "horaOferta",
  "fechaHasta",
  "cantidadDisponible",
] as const;
type BulkEditField = (typeof BULK_EDIT_FIELDS)[number];

const CAMPOS_NUMERICOS = new Set<string>([
  "numeroOferta",
  "desdeCantidad",
  "descuentoPct",
  "precioUnitario",
  "cantidadDisponible",
]);
const CAMPOS_NULEABLES = new Set<string>(["fechaHasta", "cantidadDisponible"]);

function coerceValor(campo: string, value: unknown): { ok: true; value: unknown } | { ok: false } {
  if (value === null) {
    if (CAMPOS_NULEABLES.has(campo)) return { ok: true, value: null };
    return { ok: false };
  }
  if (CAMPOS_NUMERICOS.has(campo)) {
    const num = Number(value);
    if (!Number.isFinite(num)) return { ok: false };
    return { ok: true, value: roundTo2(num) };
  }
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

// Mismos 7 campos que OFERTA_REQUIRED_FIELDS en extraction/processCarga.ts,
// pero con los nombres camelCase que usa este router (esa lista está en
// snake_case, son los nombres canónicos del pipeline de extracción) — si se
// agrega/saca un campo obligatorio de Oferta en el schema, actualizar ambas.
const CAMPOS_OBLIGATORIOS_ALTA = [
  "marca",
  "numeroOferta",
  "skuProveedor",
  "descripcion",
  "precioUnitario",
  "fechaOferta",
  "horaOferta",
] as const;

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

// Alta manual de una oferta suelta, en paralelo al pipeline de carga masiva
// de archivos. desdeCantidad/descuentoPct usan el mismo default (1 y 0) que
// normalizeOfertaRow aplica a filas de archivo con esos campos vacíos, para
// que una oferta cargada a mano y una extraída de un Excel tengan la misma
// semántica.
ofertasRouter.post("/", requireRole("ADMINISTRADOR"), async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const proveedorId = await resolverProveedor(body);
  if (!proveedorId) {
    res.status(400).json({ error: "Falta proveedorId (existente) o proveedorNombre." });
    return;
  }

  const faltantes = CAMPOS_OBLIGATORIOS_ALTA.filter((campo) => {
    const v = body[campo];
    return v === undefined || v === null || v === "";
  });
  if (faltantes.length > 0) {
    res.status(400).json({ error: `Faltan campos obligatorios: ${faltantes.join(", ")}.` });
    return;
  }

  const desdeCantidad = body.desdeCantidad === undefined || body.desdeCantidad === ""
    ? 1
    : Number(body.desdeCantidad);
  const descuentoPctRaw = body.descuentoPct === undefined || body.descuentoPct === ""
    ? 0
    : Number(body.descuentoPct);
  const precioUnitarioRaw = Number(body.precioUnitario);
  const numeroOferta = Number(body.numeroOferta);
  if (![desdeCantidad, descuentoPctRaw, precioUnitarioRaw, numeroOferta].every(Number.isFinite)) {
    res.status(400).json({ error: "desdeCantidad, descuentoPct, precioUnitario y numeroOferta deben ser numéricos." });
    return;
  }
  const descuentoPct = roundTo2(descuentoPctRaw) ?? 0;
  const precioUnitario = roundTo2(precioUnitarioRaw) ?? 0;
  // A diferencia de desdeCantidad/descuentoPct, no tiene default: vacío
  // queda null (proveedor no informó stock), no "cero".
  let cantidadDisponible: number | null = null;
  if (body.cantidadDisponible !== undefined && body.cantidadDisponible !== null && body.cantidadDisponible !== "") {
    cantidadDisponible = Number(body.cantidadDisponible);
    if (!Number.isFinite(cantidadDisponible)) {
      res.status(400).json({ error: "cantidadDisponible debe ser numérico." });
      return;
    }
  }

  try {
    const oferta = await prisma.oferta.create({
      data: {
        proveedorId,
        marca: String(body.marca),
        numeroOferta,
        skuProveedor: String(body.skuProveedor),
        descripcion: String(body.descripcion),
        desdeCantidad,
        descuentoPct,
        precioUnitario,
        moneda: typeof body.moneda === "string" && body.moneda ? body.moneda : "ARS",
        fechaOferta: String(body.fechaOferta),
        horaOferta: String(body.horaOferta),
        fechaHasta: typeof body.fechaHasta === "string" && body.fechaHasta ? body.fechaHasta : null,
        cantidadDisponible,
        archivoOrigen: "Alta manual",
        cargaId: null,
        rawData: undefined,
      } as Prisma.OfertaUncheckedCreateInput,
      include: { proveedor: true },
    });
    res.status(201).json(oferta);
  } catch (err) {
    // Nunca dejar que un error de Prisma llegue como rechazo no manejado:
    // Express 4 no atrapa promesas de handlers async por su cuenta, y un
    // rejection sin catch tira abajo todo el proceso.
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

ofertasRouter.post("/editar-lote", requireRole("ADMINISTRADOR"), async (req, res) => {
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
  const { count } = await prisma.oferta.updateMany({
    where: { id: { in: ids }, eliminado: false },
    data: { [field as BulkEditField]: coerced.value } as Prisma.OfertaUpdateManyMutationInput,
  });
  res.json({ actualizados: count });
});

ofertasRouter.post("/eliminar", requireRole("ADMINISTRADOR"), async (req, res) => {
  const b = (req.body ?? {}) as { ids?: unknown };
  const ids = Array.isArray(b.ids) ? b.ids.filter((v) => Number.isFinite(Number(v))).map(Number) : [];
  if (ids.length === 0) {
    res.status(400).json({ error: "Body inválido: se esperaba {ids: number[]}" });
    return;
  }
  const { count } = await prisma.oferta.updateMany({
    where: { id: { in: ids } },
    data: { eliminado: true },
  });
  res.json({ eliminados: count });
});

// Espejo de /eliminar: saca filas de la papelera (ver vistaPapelera).
ofertasRouter.post("/restaurar", requireRole("ADMINISTRADOR"), async (req, res) => {
  const b = (req.body ?? {}) as { ids?: unknown };
  const ids = Array.isArray(b.ids) ? b.ids.filter((v) => Number.isFinite(Number(v))).map(Number) : [];
  if (ids.length === 0) {
    res.status(400).json({ error: "Body inválido: se esperaba {ids: number[]}" });
    return;
  }
  const { count } = await prisma.oferta.updateMany({
    where: { id: { in: ids } },
    data: { eliminado: false },
  });
  res.json({ restaurados: count });
});

ofertasRouter.patch("/:id", requireRole("ADMINISTRADOR"), async (req, res) => {
  const id = Number(req.params.id);
  const objetivo = await prisma.oferta.findUnique({ where: { id } });
  if (!objetivo || objetivo.eliminado) {
    res.status(404).json({ error: "Oferta no encontrada" });
    return;
  }
  const data = buildSingleEditData(req.body);
  if (!data) {
    res.status(400).json({ error: `Body inválido. Campos permitidos: ${SINGLE_EDIT_FIELDS.join(", ")}` });
    return;
  }
  const oferta = await prisma.oferta.update({
    where: { id },
    data: data as Prisma.OfertaUpdateInput,
    include: { proveedor: true },
  });
  res.json(oferta);
});

// Sube/reemplaza la foto de una oferta — mismo criterio que el endpoint
// espejo en productos.ts (endpoint aparte del PATCH genérico porque
// imagenUrl es gestionado por el servidor, no tipeado por el usuario).
ofertasRouter.post(
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
      const objetivo = await prisma.oferta.findUnique({ where: { id } });
      if (!objetivo || objetivo.eliminado) {
        res.status(404).json({ error: "Oferta no encontrada" });
        return;
      }
      await eliminarArchivoImagen(objetivo.imagenUrl);
      const oferta = await prisma.oferta.update({
        where: { id },
        data: { imagenUrl: imagenPublicUrl(req.file.filename) },
        include: { proveedor: true },
      });
      res.json(oferta);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

ofertasRouter.delete("/:id/imagen", requireRole("ADMINISTRADOR"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const objetivo = await prisma.oferta.findUnique({ where: { id } });
    if (!objetivo || objetivo.eliminado) {
      res.status(404).json({ error: "Oferta no encontrada" });
      return;
    }
    await eliminarArchivoImagen(objetivo.imagenUrl);
    const oferta = await prisma.oferta.update({
      where: { id },
      data: { imagenUrl: null },
      include: { proveedor: true },
    });
    res.json(oferta);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
