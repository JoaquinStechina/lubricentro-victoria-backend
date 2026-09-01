// Dispara la auto-descarga diaria de todos los proveedores configurados,
// tanto ABC (portal, Playwright) como los "dropbox_directo" (descarga
// directa, ej. BORUR). Reemplaza a run-auto-descargas-abc.ts. Pensado para
// correr por cron en el VPS, no interactivo. Correr con:
// npm run auto-descargas (dev) o `node dist/scripts/run-auto-descargas.js`
// (producción: tsx es devDependency, no está en la imagen). Los dos
// mecanismos corren aislados entre sí: si uno falla, el otro igual corre.

import "dotenv/config";
import { correrAutoDescargasAbc } from "../src/automation/abcAutoDescarga.js";
import { correrAutoDescargasDirectas } from "../src/automation/dropboxAutoDescarga.js";
import { prisma } from "../src/db.js";

async function main() {
  let huboError = false;

  try {
    await correrAutoDescargasAbc();
  } catch (err) {
    console.error("Auto-descarga ABC: corrida abortada:", err);
    huboError = true;
  }

  try {
    await correrAutoDescargasDirectas();
  } catch (err) {
    console.error("Auto-descarga directa (Dropbox): corrida abortada:", err);
    huboError = true;
  }

  if (huboError) process.exitCode = 1;
}

main().finally(() => prisma.$disconnect());
