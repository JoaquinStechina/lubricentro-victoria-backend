import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { enviarExport, type FilaExport } from "./exportar.js";

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
