import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { enviarExport, type FilaExport } from "./exportar.js";
import { normalizarCodigo } from "../lib/stock.js";

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

stockRouter.get("/", async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 50));
  const where = buildStockWhere(req);

  // ?soloBajoMinimo=true: artículos con mínimo definido que están en o por
  // debajo de él. Prisma no compara dos columnas entre sí, así que se resuelve
  // con un raw que devuelve los ids y se intersecta con el resto del where.
  const soloBajoMinimo = req.query.soloBajoMinimo === "true";
  let whereFinal = where;
  if (soloBajoMinimo) {
    const filas = await prisma.$queryRaw<{ id: number }[]>`
      SELECT id FROM articulos_stock WHERE minimo IS NOT NULL AND cantidad <= minimo
    `;
    whereFinal = { AND: [where, { id: { in: filas.map((f) => f.id) } }] };
  }

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
    where: buildStockWhere(req),
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
