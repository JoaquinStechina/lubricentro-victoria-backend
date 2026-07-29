// Configura BORUR como proveedor de auto-descarga directa (Dropbox, sin
// portal) y da de alta las 25 marcas relevadas para automatizar (ver
// docs/superpowers/specs/2026-07-28-borur-auto-descarga-design.md, anexo).
// El resto de las hojas del archivo (Índice, en dólares, descartadas a
// pedido) no se dan de alta acá — se pueden agregar más adelante desde
// /cargas/auto-descargas si hace falta. Idempotente: correr más de una vez
// no duplica nada ni pisa ediciones manuales posteriores (% de ganancia,
// activo) hechas desde la UI. Requiere BORUR_DROPBOX_URL en el entorno (ver
// .env.example). Correr con: npx tsx scripts/seed-borur-auto-descargas.ts

import "dotenv/config";
import { prisma } from "../src/db.js";

const MARCAS = [
  "Tecfil",
  "Mann",
  "Darmet",
  "Bardahl",
  "Poxipol",
  "Lupaños",
  "Eveready",
  "LIQUI MOLY",
  "Deutz",
  "Chevrolet",
  "VW",
  "Motorcraft",
  "Peugeot",
  "Fiat",
  "Picborg",
  "Jit",
  "Silisur",
  "Wega",
  "Tribuno",
  "Toyota",
  "GM-Chevrolet",
  "O´Cuatro",
  "BOSCH Liq.Frenos",
  "BOSCH Baterías",
  "BOSCH Filtros",
];

async function main() {
  const url = process.env.BORUR_DROPBOX_URL;
  if (!url) {
    throw new Error("Falta BORUR_DROPBOX_URL en el entorno (ver .env.example).");
  }

  const proveedor = await prisma.proveedor.upsert({
    where: { nombre: "BOR&UR S.R.L." },
    update: { mecanismoAutoDescarga: "dropbox_directo", urlDescargaAutomatica: url, alicuotaIvaDefault: 21 },
    create: {
      nombre: "BOR&UR S.R.L.",
      mecanismoAutoDescarga: "dropbox_directo",
      urlDescargaAutomatica: url,
      alicuotaIvaDefault: 21,
    },
  });
  console.log(`Proveedor BORUR listo (id=${proveedor.id}).`);

  for (const marca of MARCAS) {
    const fila = await prisma.autoDescargaMarca.upsert({
      where: { proveedorId_marca: { proveedorId: proveedor.id, marca } },
      update: {},
      create: { proveedorId: proveedor.id, marca, porcentajeGanancia: 40, activo: true },
    });
    console.log(`Marca "${marca}" lista (id=${fila.id}).`);
  }

  const abc = await prisma.proveedor.findUnique({ where: { nombre: "ABC" } });
  if (abc && abc.mecanismoAutoDescarga !== "abc_portal") {
    await prisma.proveedor.update({ where: { id: abc.id }, data: { mecanismoAutoDescarga: "abc_portal" } });
    console.log("Proveedor ABC marcado con mecanismoAutoDescarga=abc_portal.");
  }

  console.log("Listo.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
