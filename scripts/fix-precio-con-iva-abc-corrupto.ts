// Repara las filas de ProductoPrecio de ABC cuyo precioConIva quedó
// corrompido por el mapeo duplicado "PRECIO LISTA C/IVA" + "PRECIO NETO CON
// IVA" -> precio_con_iva (combinarValores las concatena con un espacio,
// toNumberOrNull limpia el espacio y con 2+ puntos decimales termina
// tratando todo como separadores de miles — ver mapping.ts). Correr
// fix-mapeo-abc-precio-lista.ts ANTES que este script: aborta si todavía
// encuentra un mapeo de "PRECIO LISTA C/IVA" guardado.
//
// El bug no tiene una magnitud fija (depende de cuántos dígitos tenía cada
// valor concatenado) — se vieron desde miles de millones hasta filas de
// "solo" 40-90 millones, indistinguibles de un precio real por un simple
// umbral. Por eso este script no filtra por precioConIva: re-chequea TODAS
// las filas vigentes de las cargas conocidas como afectadas (CARGAS_AFECTADAS
// abajo — las que se publicaron mientras existió el mapeo duplicado,
// 2026-07-23 en adelante), re-derivando cada una desde el archivo original
// en disco con el mapeo YA CORREGIDO, y solo escribe donde el valor
// recalculado difiere del guardado. Si es igual, no toca nada (así una fila
// genuinamente cara, tipo un repuesto grande, nunca se pisa por las dudas).
//
// Idempotente: correrlo dos veces no cambia nada la segunda vez.
//
// Correr primero en modo dry-run para revisar el diff antes de aplicar:
//   npx tsx scripts/fix-precio-con-iva-abc-corrupto.ts --dry-run
//   npx tsx scripts/fix-precio-con-iva-abc-corrupto.ts

import "dotenv/config";
import fs from "node:fs";
import { prisma } from "../src/db.js";
import { extractExcelWithFallback, combineTables } from "../src/extraction/excel.js";
import { applyMapping } from "../src/extraction/mapping.js";
import type { CanonicalField, CanonicalRow, ColumnMapping } from "../src/extraction/types.js";

// Las 4 cargas de ABC publicadas mientras existió el mapeo duplicado
// (confirmado a mano contra la base de producción: son las únicas con
// filas cuyo precioConIva superaba cualquier precio real del catálogo).
const CARGAS_AFECTADAS = [12, 13, 14, 17];

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const proveedor = await prisma.proveedor.findFirst({ where: { nombre: { contains: "ABC" } } });
  if (!proveedor) {
    console.log("No existe proveedor ABC — nada que hacer.");
    return;
  }

  const mapeoGuardado = await prisma.mapeoColumna.findMany({
    where: { proveedorId: proveedor.id, tipoDatos: "catalogo" },
  });
  if (mapeoGuardado.some((m) => m.columnaOrigen === "PRECIO LISTA C/IVA")) {
    console.log(
      'ABORTADO: todavía existe un mapeo de "PRECIO LISTA C/IVA" en MapeoColumna. ' +
        "Correr primero scripts/fix-mapeo-abc-precio-lista.ts."
    );
    process.exitCode = 1;
    return;
  }

  const mapping: ColumnMapping = {};
  for (const m of mapeoGuardado) {
    const lista = mapping[m.columnaOrigen] ?? [];
    lista.push(m.campoDestino as CanonicalField);
    mapping[m.columnaOrigen] = lista;
  }
  console.log("Mapeo actual (usado para re-derivar los valores correctos):");
  console.log(JSON.stringify(mapping, null, 2));

  let totalRevisadas = 0;
  let totalActualizadas = 0;
  let totalSinMatch = 0;

  for (const cargaId of CARGAS_AFECTADAS) {
    console.log(`\n--- Carga ${cargaId} ---`);
    const carga = await prisma.carga.findUnique({ where: { id: cargaId } });
    if (!carga) {
      console.log(`Carga ${cargaId} no existe más, salteando.`);
      continue;
    }
    if (!fs.existsSync(carga.rutaArchivo)) {
      console.log(`ARCHIVO NO ENCONTRADO (${carga.rutaArchivo}), salteando.`);
      continue;
    }

    const filasPublicadas = await prisma.productoPrecio.findMany({
      where: { proveedorId: proveedor.id, cargaId, vigente: true },
      select: { id: true, marca: true, skuProveedor: true, precioConIva: true },
    });
    console.log(`Filas vigentes publicadas por esta carga: ${filasPublicadas.length}`);

    const buffer = fs.readFileSync(carga.rutaArchivo);
    const tablas = await extractExcelWithFallback(buffer);
    const { headers, rows } = combineTables(tablas);
    const canonicalRows = applyMapping(headers, rows, mapping, proveedor.alicuotaIvaDefault);

    const porIdentidad = new Map<string, CanonicalRow>();
    for (const r of canonicalRows) {
      if (!r.sku_proveedor) continue;
      porIdentidad.set(`${r.marca ?? ""}::${r.sku_proveedor}`, r);
    }

    for (const fila of filasPublicadas) {
      totalRevisadas++;
      const clave = `${fila.marca ?? ""}::${fila.skuProveedor ?? ""}`;
      const correcta = porIdentidad.get(clave);
      if (!correcta) {
        console.log(`  SIN MATCH id=${fila.id} marca=${fila.marca} sku=${fila.skuProveedor} — no se toca.`);
        totalSinMatch++;
        continue;
      }
      if (correcta.precio_con_iva === fila.precioConIva) continue; // ya está bien, no hace falta tocar

      console.log(`  id=${fila.id} sku=${fila.skuProveedor}: ${fila.precioConIva} -> ${correcta.precio_con_iva}`);
      if (!dryRun) {
        await prisma.productoPrecio.update({
          where: { id: fila.id },
          data: { precioConIva: correcta.precio_con_iva },
        });
      }
      totalActualizadas++;
    }
  }

  console.log(
    `\nTotal: ${totalRevisadas} revisadas, ${totalActualizadas} actualizadas, ${totalSinMatch} sin match (no tocadas).`
  );
  if (dryRun) console.log("(--dry-run: no se escribió nada en la base)");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
