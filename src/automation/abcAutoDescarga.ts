// Worker de auto-descarga de listas de precios de ABC por marca. Dos
// disparadores lo llaman (ver docs/superpowers/specs/2026-07-23-abc-auto-descarga-marcas-design.md):
// - backend/scripts/run-auto-descargas-abc.ts (cron diario, todas las
//   marcas activas).
// - POST /api/auto-descargas/:id/probar (una sola marca, al toque).
//
// No se testea unitariamente: requiere loguearse contra el portal real de
// ABC (no hay forma de mockear eso en CI). Se verifica a mano contra el
// portal real (ver spec, sección Testing). Los helpers puros (decidir si
// hay que crear Carga, armar nombre de archivo, armar los datos de la
// Carga) sí están testeados en abcAutoDescargaHelpers.test.ts.
import { chromium, type Page } from "playwright";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AutoDescargaMarca, Proveedor } from "@prisma/client";
import { prisma } from "../db.js";
import { procesarCarga } from "../extraction/processCarga.js";
import { UPLOADS_DIR } from "../routes/uploads.js";
import { decidirAccion, nombreArchivoDescarga, datosNuevaCarga } from "./abcAutoDescargaHelpers.js";

const PORTAL_URL = "https://www.abc-sa.com.ar/prices-lists-dashboard";
const LOGIN_URL = "https://www.abc-sa.com.ar/account/login";

// ultimoResultado es VARCHAR(191); los errores de Playwright suelen traer
// un "Call log:" de varias líneas que lo excede largo, lo que haría fallar
// el propio update() y (en el loop por marca) tumbaría la corrida entera.
// 170 deja margen bajo VARCHAR(191) incluso para el prefijo más largo,
// "error: login falló - " (21 caracteres).
const MAX_LARGO_RESULTADO = 170;

function truncarMensaje(mensaje: string): string {
  return mensaje.length > MAX_LARGO_RESULTADO ? mensaje.slice(0, MAX_LARGO_RESULTADO) : mensaje;
}

type FilaConProveedor = AutoDescargaMarca & { proveedor: Proveedor };

// soloIds: si viene, ignora `activo` y corre solo esas filas (usado por
// "Probar ahora" — funciona con la fila activa o inactiva). Sin soloIds,
// corre todas las filas activas (uso del cron diario).
export async function correrAutoDescargasAbc(soloIds?: number[]): Promise<void> {
  const filas = await prisma.autoDescargaMarca.findMany({
    where: soloIds ? { id: { in: soloIds } } : { activo: true },
    include: { proveedor: true },
  });
  if (filas.length === 0) return;

  const browser = await chromium.launch({
    headless: true,
    // Necesario para correr Chromium como root dentro del contenedor Docker
    // del backend (no hay usuario no-root configurado en el Dockerfile).
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    try {
      await iniciarSesion(page);
    } catch (err) {
      const mensaje = err instanceof Error ? err.message : String(err);
      console.error("Auto-descarga ABC: falló el login:", mensaje);
      await prisma.autoDescargaMarca.updateMany({
        where: { id: { in: filas.map((f) => f.id) } },
        data: {
          ultimaCorridaEn: new Date(),
          ultimoResultado: `error: login falló - ${truncarMensaje(mensaje)}`,
        },
      });
      return;
    }

    for (const fila of filas) {
      try {
        await descargarYProcesarMarca(page, fila);
      } catch (err) {
        const mensaje = err instanceof Error ? err.message : String(err);
        console.error(`Auto-descarga ABC: error en marca "${fila.marca}":`, mensaje);
        await prisma.autoDescargaMarca.update({
          where: { id: fila.id },
          data: { ultimaCorridaEn: new Date(), ultimoResultado: `error: ${truncarMensaje(mensaje)}` },
        });
      }
    }
  } finally {
    await browser.close();
  }
}

async function iniciarSesion(page: Page): Promise<void> {
  const usuario = process.env.ABC_PORTAL_USUARIO;
  const clave = process.env.ABC_PORTAL_CLAVE;
  const colaborador = process.env.ABC_PORTAL_COLABORADOR;
  if (!usuario || !clave) {
    throw new Error("Faltan ABC_PORTAL_USUARIO / ABC_PORTAL_CLAVE en el entorno");
  }
  await page.goto(LOGIN_URL);
  await page.getByRole("textbox", { name: "Usuario / Código de Cliente" }).fill(usuario);
  await page.getByRole("textbox", { name: "Password" }).fill(clave);
  if (colaborador) {
    await page.getByRole("textbox", { name: "Usuario Colaborador (Opcional)" }).fill(colaborador);
  }
  await page.getByRole("button", { name: "Iniciar Sesión" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/account/login"), { timeout: 15000 });
}

async function descargarYProcesarMarca(page: Page, fila: FilaConProveedor): Promise<void> {
  await page.goto(PORTAL_URL);

  // El buscador de la tabla de "Listas de Precios" no reacciona a fill():
  // hace falta tipeo real (pressSequentially) + Enter para que dispare el
  // filtro — confirmado a mano contra el portal real.
  const buscador = page.getByRole("searchbox", { name: "Buscar..." });
  await buscador.fill("");
  await buscador.pressSequentially(fila.marca, { delay: 20 });
  await buscador.press("Enter");
  await page.waitForTimeout(500);

  // La fila "COMPLETA" (catálogo completo) queda siempre pinneada arriba,
  // sin importar el filtro — se excluye al buscar la marca exacta.
  const marcaEsperada = fila.marca.trim();
  const filasTabla = page.locator("table tbody tr");
  const total = await filasTabla.count();
  const indicesCandidatos: number[] = [];
  for (let i = 0; i < total; i++) {
    const texto = (await filasTabla.nth(i).locator("td").nth(1).innerText()).trim();
    if (texto === "COMPLETA") continue;
    if (texto === marcaEsperada) indicesCandidatos.push(i);
  }
  if (indicesCandidatos.length !== 1) {
    throw new Error(
      `marca no encontrada (${indicesCandidatos.length} coincidencias exactas para "${marcaEsperada}")`
    );
  }

  const filaEncontrada = filasTabla.nth(indicesCandidatos[0]);
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30000 }),
    filaEncontrada.locator("td").nth(2).locator("button").click(),
  ]);
  const rutaTemporal = await download.path();
  if (!rutaTemporal) throw new Error("la descarga no generó un archivo");
  const buffer = fs.readFileSync(rutaTemporal);
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");

  const accion = decidirAccion(hash, fila.ultimoHashArchivo);
  if (accion === "sin_cambios") {
    await prisma.autoDescargaMarca.update({
      where: { id: fila.id },
      data: { ultimaCorridaEn: new Date(), ultimoResultado: "sin_cambios" },
    });
    return;
  }

  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const nombreArchivo = nombreArchivoDescarga(fila.marca, Date.now());
  const rutaArchivo = path.join(UPLOADS_DIR, nombreArchivo);
  fs.writeFileSync(rutaArchivo, buffer);

  const carga = await prisma.carga.create({
    data: datosNuevaCarga(fila, nombreArchivo, rutaArchivo),
  });

  await procesarCarga(carga.id);

  await prisma.autoDescargaMarca.update({
    where: { id: fila.id },
    data: {
      ultimoHashArchivo: hash,
      ultimaCorridaEn: new Date(),
      ultimoResultado: "carga_creada",
      ultimaCargaId: carga.id,
    },
  });
}
