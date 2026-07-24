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
import { chromium, type Locator, type Page } from "playwright";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AutoDescargaMarca, Proveedor } from "@prisma/client";
import { prisma } from "../db.js";
import { extractExcelWithFallback, combineTables } from "../extraction/excel.js";
import { procesarCarga } from "../extraction/processCarga.js";
import { UPLOADS_DIR } from "../routes/uploads.js";
import {
  decidirAccion,
  nombreArchivoDescarga,
  datosNuevaCarga,
  truncarMensaje,
} from "./abcAutoDescargaHelpers.js";

const PORTAL_URL = "https://www.abc-sa.com.ar/prices-lists-dashboard";
const LOGIN_URL = "https://www.abc-sa.com.ar/account/login";

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

// El filtro de la tabla de "Listas de Precios" tarda un tiempo variable en
// aplicarse tras el Enter (confirmado a mano: 500ms fijos no alcanzaban en
// una sesión recién logueada — el filtro tardó ~2.5s esa vez). Por eso se
// hace polling en vez de una espera fija: se reintenta leer la tabla hasta
// encontrar exactamente una fila (sin contar la fila "COMPLETA", que queda
// siempre pinneada arriba sin importar el filtro) o hasta agotar el timeout.
async function esperarFilaMarca(page: Page, marcaEsperada: string): Promise<Locator> {
  const filasTabla = page.locator("table tbody tr");
  const timeoutMs = 10000;
  const intervaloMs = 300;
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const total = await filasTabla.count();
    const indicesCandidatos: number[] = [];
    for (let i = 0; i < total; i++) {
      const texto = (await filasTabla.nth(i).locator("td").nth(1).innerText()).trim();
      if (texto === "COMPLETA") continue;
      if (texto === marcaEsperada) indicesCandidatos.push(i);
    }
    if (indicesCandidatos.length === 1) return filasTabla.nth(indicesCandidatos[0]);
    if (indicesCandidatos.length > 1) {
      throw new Error(
        `marca no encontrada (${indicesCandidatos.length} coincidencias exactas para "${marcaEsperada}")`
      );
    }
    await page.waitForTimeout(intervaloMs);
  }
  throw new Error(`marca no encontrada (0 coincidencias exactas para "${marcaEsperada}")`);
}

// Escribe la marca en el buscador y confirma con Enter. El buscador no
// reacciona a fill(): hace falta tipeo real (pressSequentially). Además, si
// el Enter se manda inmediatamente después de tipear, el propio frontend de
// ABC pierde una carrera interna entre el chip visual del filtro y el
// estado que arma el pedido a su API: manda "_filters={}" sin el término de
// búsqueda (confirmado inspeccionando el tráfico de red contra el portal
// real — devuelve la lista completa sin filtrar, o un 400 en el reintento).
// Esperar un momento entre tipear y Enter le da tiempo a ese estado a
// asentarse, pero sigue siendo un margen heurístico contra un sitio de
// terceros (confirmado a mano: a veces no alcanza) — por eso
// buscarFilaMarcaConReintento reintenta la secuencia completa una vez más
// si la primera pasada no encuentra la fila, en vez de agrandar el número
// a ciegas.
async function buscarMarca(page: Page, marca: string): Promise<void> {
  const buscador = page.getByRole("searchbox", { name: "Buscar..." });
  await buscador.fill("");
  await buscador.pressSequentially(marca, { delay: 20 });
  await page.waitForTimeout(800);
  await buscador.press("Enter");
}

async function buscarFilaMarcaConReintento(page: Page, marcaEsperada: string): Promise<Locator> {
  await buscarMarca(page, marcaEsperada);
  try {
    return await esperarFilaMarca(page, marcaEsperada);
  } catch (err) {
    console.error(
      `Auto-descarga ABC: no se encontró "${marcaEsperada}" en el primer intento, reintentando:`,
      err instanceof Error ? err.message : String(err)
    );
    await buscarMarca(page, marcaEsperada);
    return esperarFilaMarca(page, marcaEsperada);
  }
}

async function descargarYProcesarMarca(page: Page, fila: FilaConProveedor): Promise<void> {
  await page.goto(PORTAL_URL);

  const filaEncontrada = await buscarFilaMarcaConReintento(page, fila.marca.trim());
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30000 }),
    filaEncontrada.locator("td").nth(2).locator("button").click(),
  ]);
  const rutaTemporal = await download.path();
  if (!rutaTemporal) throw new Error("la descarga no generó un archivo");
  const buffer = fs.readFileSync(rutaTemporal);

  // El .xlsx que exporta el portal trae metadata interna (timestamp/GUID
  // de generación) que cambia en cada descarga aunque los datos sean
  // exactamente los mismos — confirmado descargando la misma marca dos
  // veces seguidas: el contenido parseado salió idéntico fila por fila,
  // pero el hash del archivo crudo fue distinto. Por eso se hashea el
  // contenido ya extraído (headers+filas), no los bytes del archivo.
  //
  // `__hoja` (agregado por combineTables, ver excel.ts) guarda el nombre
  // de la hoja de origen — y ABC nombra esa hoja con un timestamp propio
  // ("ABC_AP_<epoch>.xlsx") que también cambia en cada descarga aunque los
  // precios sean los mismos. Se excluye del hash junto con el archivo
  // crudo; `__seccion` sí se conserva porque refleja agrupación real de
  // datos, no un artefacto de exportación.
  const tablas = await extractExcelWithFallback(buffer);
  const { headers, rows } = combineTables(tablas);
  const rowsParaHash = rows.map(({ __hoja, ...resto }) => resto);
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ headers, rows: rowsParaHash }))
    .digest("hex");

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
