import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { enviarExport, type FilaExport } from "./exportar.js";
import { normalizarCodigo, calcularDelta, esTipoMovimiento, elegirMasBarato } from "../lib/stock.js";

export const stockRouter = Router();

const COLUMNAS_TEXTO: Record<string, keyof Prisma.ArticuloStockWhereInput> = {
  marca: "marca",
  codigo: "codigo",
  descripcion: "descripcion",
  categoria: "categoria",
  ubicacion: "ubicacion",
};

const STOCK_SORTABLE: Record<
  string,
  (o: "asc" | "desc") => Prisma.ArticuloStockOrderByWithRelationInput
> = {
  marca: (o) => ({ marca: o }),
  codigo: (o) => ({ codigo: o }),
  descripcion: (o) => ({ descripcion: o }),
  categoria: (o) => ({ categoria: o }),
  ubicacion: (o) => ({ ubicacion: o }),
  cantidad: (o) => ({ cantidad: o }),
  minimo: (o) => ({ minimo: o }),
};

// Papelera: mismo criterio que productos.ts/ofertas.ts — con el flag, la
// tabla pasa a mostrar SOLO las filas eliminadas.
export function vistaPapelera(req: { query: Record<string, unknown> }): boolean {
  return req.query.incluirEliminados === "true";
}

export function buildStockWhere(req: {
  query: Record<string, unknown>;
}): Prisma.ArticuloStockWhereInput {
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const filtros: Prisma.ArticuloStockWhereInput[] = [];

  for (const [param, campo] of Object.entries(COLUMNAS_TEXTO)) {
    const raw = req.query[`f_${param}`];
    if (typeof raw !== "string" || !raw.trim()) continue;
    filtros.push({ [campo]: { contains: raw.trim() } } as Prisma.ArticuloStockWhereInput);
  }

  if (search) {
    filtros.push({
      OR: [
        { marca: { contains: search } },
        { codigo: { contains: search } },
        { descripcion: { contains: search } },
        { categoria: { contains: search } },
        { ubicacion: { contains: search } },
      ],
    });
  }

  return {
    eliminado: vistaPapelera(req),
    AND: filtros,
  };
}

export function buildStockOrderBy(req: {
  query: Record<string, unknown>;
}): Prisma.ArticuloStockOrderByWithRelationInput[] {
  const sort = typeof req.query.sort === "string" ? req.query.sort : "";
  const order = req.query.order === "asc" ? "asc" : "desc";
  const sortable = STOCK_SORTABLE[sort];
  if (!sortable) return [{ createdAt: "desc" }];
  return [sortable(order), { createdAt: "desc" }];
}

// buildStockWhere + el filtro ?soloBajoMinimo=true. Va aparte y es async
// porque Prisma no sabe comparar dos columnas entre sí (cantidad <= minimo),
// así que hace falta un raw que traiga los ids y se intersecte con el resto
// del where. Lo comparten GET / y GET /export: si el export no lo aplicara,
// exportar con el switch activado bajaría filas que la tabla no muestra.
export async function buildStockWhereCompleto(req: {
  query: Record<string, unknown>;
}): Promise<Prisma.ArticuloStockWhereInput> {
  const where = buildStockWhere(req);
  if (req.query.soloBajoMinimo !== "true") return where;
  const filas = await prisma.$queryRaw<{ id: number }[]>`
    SELECT id FROM articulos_stock WHERE minimo IS NOT NULL AND cantidad <= minimo
  `;
  return { AND: [where, { id: { in: filas.map((f) => f.id) } }] };
}

stockRouter.get("/", async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 50));
  const whereFinal = await buildStockWhereCompleto(req);

  const [total, items] = await Promise.all([
    prisma.articuloStock.count({ where: whereFinal }),
    prisma.articuloStock.findMany({
      where: whereFinal,
      orderBy: buildStockOrderBy(req),
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  res.json({ items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
});

// Valores distintos de categoría, para el combobox del filtro (mismo patrón
// que GET /api/productos/secciones).
stockRouter.get("/categorias", async (_req, res) => {
  const filas = await prisma.articuloStock.findMany({
    where: { eliminado: false, categoria: { not: null } },
    distinct: ["categoria"],
    select: { categoria: true },
    orderBy: { categoria: "asc" },
  });
  res.json(filas.map((f) => f.categoria));
});

stockRouter.get("/export", async (req, res) => {
  const articulos = await prisma.articuloStock.findMany({
    where: await buildStockWhereCompleto(req),
    orderBy: buildStockOrderBy(req),
  });

  const headers = ["Marca", "Código", "Descripción", "Categoría", "Ubicación", "Cantidad", "Mínimo"];
  const filas: FilaExport[] = articulos.map((a) => ({
    Marca: a.marca,
    "Código": a.codigo,
    "Descripción": a.descripcion,
    "Categoría": a.categoria,
    "Ubicación": a.ubicacion,
    Cantidad: a.cantidad,
    "Mínimo": a.minimo,
  }));

  enviarExport(res, req.query.formato, "stock", headers, filas);
});

// Campos editables por PATCH. `cantidad` está deliberadamente afuera: solo
// cambia por movimientos, que es lo que hace confiable al historial.
const CAMPOS_EDITABLES = ["marca", "codigo", "descripcion", "categoria", "ubicacion", "minimo"] as const;

function textoONull(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const limpio = valor.trim();
  return limpio === "" ? null : limpio;
}

stockRouter.post("/", async (req, res) => {
  const { marca, codigo, descripcion, categoria, ubicacion, minimo, cantidadInicial } = req.body ?? {};

  if (typeof marca !== "string" || !marca.trim()) {
    res.status(400).json({ error: "La marca es requerida." });
    return;
  }
  if (typeof codigo !== "string" || !codigo.trim()) {
    res.status(400).json({ error: "El código es requerido." });
    return;
  }
  if (typeof descripcion !== "string" || !descripcion.trim()) {
    res.status(400).json({ error: "La descripción es requerida." });
    return;
  }
  if (minimo !== undefined && minimo !== null && (!Number.isInteger(minimo) || minimo < 0)) {
    res.status(400).json({ error: "El mínimo debe ser un entero no negativo." });
    return;
  }
  const inicial = cantidadInicial ?? 0;
  if (!Number.isInteger(inicial) || inicial < 0) {
    res.status(400).json({ error: "La cantidad inicial debe ser un entero no negativo." });
    return;
  }

  const existente = await prisma.articuloStock.findUnique({
    where: { marca_codigo: { marca: marca.trim(), codigo: codigo.trim() } },
  });
  if (existente) {
    res.status(409).json({ error: "Ya existe un artículo con esa marca y código." });
    return;
  }

  // Alta y movimiento inicial en una transacción: si el artículo nace con
  // cantidad, el historial arranca completo en vez de tener una cantidad de
  // origen desconocido.
  const articulo = await prisma.$transaction(async (tx) => {
    const creado = await tx.articuloStock.create({
      data: {
        marca: marca.trim(),
        codigo: codigo.trim(),
        codigoNorm: normalizarCodigo(codigo),
        descripcion: descripcion.trim(),
        categoria: textoONull(categoria),
        ubicacion: textoONull(ubicacion),
        minimo: minimo ?? null,
        cantidad: inicial,
      },
    });
    if (inicial > 0) {
      await tx.movimientoStock.create({
        data: {
          articuloId: creado.id,
          tipo: "entrada",
          delta: inicial,
          cantidadResultante: inicial,
          motivo: "Carga inicial",
        },
      });
    }
    return creado;
  });

  res.status(201).json(articulo);
});

stockRouter.patch("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Id inválido." });
    return;
  }
  if ("cantidad" in (req.body ?? {})) {
    res.status(400).json({
      error: "La cantidad no se edita directamente: registrá un movimiento.",
    });
    return;
  }

  const articulo = await prisma.articuloStock.findUnique({ where: { id } });
  if (!articulo) {
    res.status(404).json({ error: "Artículo no encontrado." });
    return;
  }

  const data: Prisma.ArticuloStockUpdateInput = {};
  for (const campo of CAMPOS_EDITABLES) {
    if (!(campo in (req.body ?? {}))) continue;
    const valor = req.body[campo];
    if (campo === "minimo") {
      if (valor !== null && (!Number.isInteger(valor) || valor < 0)) {
        res.status(400).json({ error: "El mínimo debe ser un entero no negativo." });
        return;
      }
      data.minimo = valor;
    } else if (campo === "marca" || campo === "codigo" || campo === "descripcion") {
      if (typeof valor !== "string" || !valor.trim()) {
        res.status(400).json({ error: `El campo ${campo} no puede quedar vacío.` });
        return;
      }
      data[campo] = valor.trim();
      if (campo === "codigo") data.codigoNorm = normalizarCodigo(valor);
    } else {
      data[campo] = textoONull(valor);
    }
  }

  const actualizado = await prisma.articuloStock.update({ where: { id }, data });
  res.json(actualizado);
});

stockRouter.post("/eliminar", async (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || ids.some((i) => !Number.isInteger(i))) {
    res.status(400).json({ error: "Body inválido: se espera {ids: number[]}." });
    return;
  }
  const { count } = await prisma.articuloStock.updateMany({
    where: { id: { in: ids } },
    data: { eliminado: true },
  });
  res.json({ eliminados: count });
});

stockRouter.post("/restaurar", async (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || ids.some((i) => !Number.isInteger(i))) {
    res.status(400).json({ error: "Body inválido: se espera {ids: number[]}." });
    return;
  }
  const { count } = await prisma.articuloStock.updateMany({
    where: { id: { in: ids } },
    data: { eliminado: false },
  });
  res.json({ restaurados: count });
});

// Feed global de movimientos, con filtros opcionales por artículo, tipo y rango de fechas.
stockRouter.get("/movimientos", async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 50));

  const where: Prisma.MovimientoStockWhereInput = {};
  if (req.query.articuloId) {
    const articuloId = Number(req.query.articuloId);
    if (Number.isInteger(articuloId)) where.articuloId = articuloId;
  }
  if (typeof req.query.tipo === "string" && esTipoMovimiento(req.query.tipo)) {
    where.tipo = req.query.tipo;
  }
  const desde = typeof req.query.desde === "string" ? new Date(req.query.desde) : null;
  const hasta = typeof req.query.hasta === "string" ? new Date(req.query.hasta) : null;
  if ((desde && !isNaN(desde.getTime())) || (hasta && !isNaN(hasta.getTime()))) {
    where.createdAt = {};
    if (desde && !isNaN(desde.getTime())) where.createdAt.gte = desde;
    // hasta inclusive: se suma un día porque el input manda una fecha sin hora.
    if (hasta && !isNaN(hasta.getTime())) {
      where.createdAt.lt = new Date(hasta.getTime() + 24 * 60 * 60 * 1000);
    }
  }

  const [total, items] = await Promise.all([
    prisma.movimientoStock.count({ where }),
    prisma.movimientoStock.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { articulo: { select: { id: true, marca: true, codigo: true, descripcion: true } } },
    }),
  ]);

  res.json({ items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
});

stockRouter.get("/:id/movimientos", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Id inválido." });
    return;
  }
  const items = await prisma.movimientoStock.findMany({
    where: { articuloId: id },
    orderBy: { createdAt: "desc" },
  });
  res.json({ items });
});

stockRouter.post("/:id/movimientos", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Id inválido." });
    return;
  }
  const { tipo, cantidad, motivo } = req.body ?? {};
  if (!esTipoMovimiento(tipo)) {
    res.status(400).json({ error: "Tipo inválido: se espera entrada, salida o ajuste." });
    return;
  }
  if (!Number.isInteger(cantidad) || cantidad < 0) {
    res.status(400).json({ error: "La cantidad debe ser un entero no negativo." });
    return;
  }

  const articulo = await prisma.articuloStock.findUnique({ where: { id } });
  if (!articulo) {
    res.status(404).json({ error: "Artículo no encontrado." });
    return;
  }

  const delta = calcularDelta(tipo, cantidad, articulo.cantidad);
  const cantidadResultante = articulo.cantidad + delta;

  // Transacción: el movimiento y la cantidad del artículo se escriben juntos
  // o no se escribe ninguno. Es lo que garantiza que `cantidad` (que está
  // denormalizada) nunca quede desfasada del historial.
  const movimiento = await prisma.$transaction(async (tx) => {
    const creado = await tx.movimientoStock.create({
      data: { articuloId: id, tipo, delta, cantidadResultante, motivo: textoONull(motivo) },
    });
    await tx.articuloStock.update({ where: { id }, data: { cantidad: cantidadResultante } });
    return creado;
  });

  res.status(201).json(movimiento);
});

// Artículos en o bajo el mínimo, cada uno con el proveedor más barato que
// venda hoy ese código.
//
// El match es por código normalizado contra las filas VIGENTES del catálogo.
// ProductoPrecio no tiene columna normalizada, así que la normalización se
// hace en SQL. A ~15.000 filas vigentes el scan es de milisegundos; si el
// catálogo crece mucho, la optimización es agregar skuNorm a ProductoPrecio
// y poblarlo en processCarga.
stockRouter.get("/reposicion", async (_req, res) => {
  const articulos = await prisma.$queryRaw<
    { id: number; marca: string; codigo: string; codigoNorm: string; descripcion: string; cantidad: number; minimo: number }[]
  >`
    SELECT id, marca, codigo, codigoNorm, descripcion, cantidad, minimo
    FROM articulos_stock
    WHERE eliminado = false AND minimo IS NOT NULL AND cantidad <= minimo
    ORDER BY (cantidad - minimo) ASC
  `;

  if (articulos.length === 0) {
    res.json({ items: [] });
    return;
  }

  const codigos = articulos.map((a) => a.codigoNorm);
  const candidatos = await prisma.$queryRaw<
    { codigoNorm: string; proveedor: string; precio: number | null }[]
  >`
    SELECT
      UPPER(REPLACE(REPLACE(REPLACE(REPLACE(pp.skuProveedor,' ',''),'-',''),'.',''),'/','')) AS codigoNorm,
      p.nombre AS proveedor,
      COALESCE(pp.precioConIva, pp.precioNeto) AS precio
    FROM productos_precios pp
    JOIN proveedores p ON p.id = pp.proveedorId
    WHERE pp.vigente = true
      AND pp.eliminado = false
      AND pp.skuProveedor IS NOT NULL
      AND UPPER(REPLACE(REPLACE(REPLACE(REPLACE(pp.skuProveedor,' ',''),'-',''),'.',''),'/','')) IN (${Prisma.join(codigos)})
  `;

  const porCodigo = new Map<string, { proveedor: string; precio: number | null }[]>();
  for (const c of candidatos) {
    const lista = porCodigo.get(c.codigoNorm) ?? [];
    lista.push({ proveedor: c.proveedor, precio: c.precio });
    porCodigo.set(c.codigoNorm, lista);
  }

  const items = articulos.map((a) => ({
    ...a,
    faltante: a.minimo - a.cantidad,
    mejorOpcion: elegirMasBarato(porCodigo.get(a.codigoNorm) ?? []),
  }));

  res.json({ items });
});
