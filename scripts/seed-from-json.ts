// Importa los productos_todos.json / ofertas.json ya generados (ver
// contexto.md) a la base SQLite nueva, para no perder el trabajo de
// parseo/normalización ya hecho mientras se migra de JSON estático a
// una base con estado real. Correr con: npm run seed

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { prisma } from "../src/db.js";

const FRONT_DATA_DIR = path.join(process.cwd(), "..", "lubricentro-victoria-front", "data");

type ProductoJson = {
  proveedor: string;
  marca: string | null;
  sku_proveedor: string | null;
  sku_interno: string | null;
  descripcion: string | null;
  seccion: string | null;
  precio_neto: number | null;
  precio_con_iva: number | null;
  alicuota_iva: number | null;
  moneda: string | null;
  unidad: string | null;
  fecha_vigencia: string | null;
  raw_data: Record<string, unknown>;
};

type OfertaJson = {
  proveedor: string;
  marca: string;
  numero_oferta: number;
  sku_proveedor: string;
  descripcion: string;
  desde_cantidad: number;
  descuento_pct: number;
  precio_unitario: number;
  moneda: string;
  fecha_oferta: string;
  hora_oferta: string;
  archivo_origen: string;
  raw_data: Record<string, unknown>;
};

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

// El JSON de origen viene de un mapeo de columnas heurístico por hoja/proveedor
// (ver contexto.md) que a veces mapea mal: algunos campos declarados como
// string en el JSON traen en la práctica un número (o viceversa). Prisma es
// estricto con los tipos de columna, así que coercionamos antes de insertar
// en vez de confiar ciegamente en el tipo declarado del JSON.
function toStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function toStringSafe(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toNumberSafe(value: unknown, fallback = 0): number {
  return toNumberOrNull(value) ?? fallback;
}

async function ensureProveedores(nombres: Iterable<string>): Promise<Map<string, number>> {
  const unicos = Array.from(new Set(nombres)).filter(Boolean);
  const map = new Map<string, number>();
  for (const nombre of unicos) {
    const proveedor = await prisma.proveedor.upsert({
      where: { nombre },
      update: {},
      create: { nombre },
    });
    map.set(nombre, proveedor.id);
  }
  return map;
}

async function seedProductos() {
  const filePath = path.join(FRONT_DATA_DIR, "productos_todos.json");
  const productos: ProductoJson[] = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  console.log(`Productos a importar: ${productos.length}`);

  const proveedorIds = await ensureProveedores(productos.map((p) => p.proveedor));

  const batches = chunk(productos, 70);
  let importados = 0;
  for (const batch of batches) {
    await prisma.productoPrecio.createMany({
      data: batch.map((p) => ({
        proveedorId: proveedorIds.get(p.proveedor)!,
        marca: toStringOrNull(p.marca),
        skuProveedor: toStringOrNull(p.sku_proveedor),
        skuInterno: toStringOrNull(p.sku_interno),
        descripcion: toStringOrNull(p.descripcion),
        seccion: toStringOrNull(p.seccion),
        precioNeto: toNumberOrNull(p.precio_neto),
        precioConIva: toNumberOrNull(p.precio_con_iva),
        alicuotaIva: toNumberOrNull(p.alicuota_iva),
        moneda: toStringSafe(p.moneda, "ARS"),
        unidad: toStringOrNull(p.unidad),
        fechaVigencia: toStringOrNull(p.fecha_vigencia),
        rawData: (p.raw_data ?? {}) as Prisma.InputJsonValue,
      })),
    });
    importados += batch.length;
    process.stdout.write(`\r  ${importados}/${productos.length}`);
  }
  console.log();
}

async function seedOfertas() {
  const filePath = path.join(FRONT_DATA_DIR, "ofertas.json");
  const ofertas: OfertaJson[] = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  console.log(`Ofertas a importar: ${ofertas.length}`);

  const proveedorIds = await ensureProveedores(ofertas.map((o) => o.proveedor));

  const batches = chunk(ofertas, 70);
  let importadas = 0;
  for (const batch of batches) {
    await prisma.oferta.createMany({
      data: batch.map((o) => ({
        proveedorId: proveedorIds.get(o.proveedor)!,
        marca: toStringSafe(o.marca),
        numeroOferta: toNumberSafe(o.numero_oferta),
        skuProveedor: toStringSafe(o.sku_proveedor),
        descripcion: toStringSafe(o.descripcion),
        desdeCantidad: toNumberSafe(o.desde_cantidad),
        descuentoPct: toNumberSafe(o.descuento_pct),
        precioUnitario: toNumberSafe(o.precio_unitario),
        moneda: toStringSafe(o.moneda, "ARS"),
        fechaOferta: toStringSafe(o.fecha_oferta),
        horaOferta: toStringSafe(o.hora_oferta),
        archivoOrigen: toStringSafe(o.archivo_origen),
        rawData: (o.raw_data ?? {}) as Prisma.InputJsonValue,
      })),
    });
    importadas += batch.length;
    process.stdout.write(`\r  ${importadas}/${ofertas.length}`);
  }
  console.log();
}

async function main() {
  const [productosExistentes, ofertasExistentes] = await Promise.all([
    prisma.productoPrecio.count(),
    prisma.oferta.count(),
  ]);
  if (productosExistentes > 0 || ofertasExistentes > 0) {
    console.log(
      `La base ya tiene ${productosExistentes} productos y ${ofertasExistentes} ofertas. ` +
        `Abortando para no duplicar (borrá dev.db si querés re-sembrar desde cero).`
    );
    return;
  }

  await seedProductos();
  await seedOfertas();
  console.log("Listo.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
