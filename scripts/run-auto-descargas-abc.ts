// Dispara la auto-descarga diaria de todas las marcas activas (ver
// backend/src/automation/abcAutoDescarga.ts). Pensado para correr por cron
// en el VPS, no interactivo. Correr con: npm run auto-descargas:abc
// (dev) o `node dist/scripts/run-auto-descargas-abc.js` (producción, mismo
// criterio que scripts/seed-sysadmin.ts: tsx es devDependency, no está en
// la imagen de producción).

import "dotenv/config";
import { correrAutoDescargasAbc } from "../src/automation/abcAutoDescarga.js";
import { prisma } from "../src/db.js";

correrAutoDescargasAbc()
  .catch((err) => {
    console.error("Auto-descarga ABC: corrida abortada:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
