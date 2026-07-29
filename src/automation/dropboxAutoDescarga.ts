// Worker de auto-descarga para proveedores con mecanismoAutoDescarga =
// "dropbox_directo" (ej. BORUR): a diferencia de abcAutoDescarga.ts, no hay
// portal ni login — se descarga un único archivo compartido por todas las
// marcas del proveedor (link fijo) y se reparte por hoja. Dos disparadores
// lo llaman, igual que el de ABC (ver
// backend/scripts/run-auto-descargas.ts y
// POST /api/auto-descargas/:id/probar). No se testea unitariamente: requiere
// HTTP real contra Dropbox (no hay forma de mockear eso en CI). Se verifica
// a mano contra el link real de BORUR (ver
// docs/superpowers/specs/2026-07-28-borur-auto-descarga-design.md, sección
// Testing). Los helpers puros están testeados en
// dropboxAutoDescargaHelpers.test.ts.
import fs from "node:fs";
import path from "node:path";
import { Prisma } from "@prisma/client";
import type { AutoDescargaMarca, Proveedor } from "@prisma/client";
import { prisma } from "../db.js";
import { extractExcelWithFallback, combineTables } from "../extraction/excel.js";
import { procesarCarga } from "../extraction/processCarga.js";
import type { ExtractedRow } from "../extraction/types.js";
import { UPLOADS_DIR } from "../routes/uploads.js";
import { hashContenidoExtraido, decidirAccion, truncarMensaje } from "./abcAutoDescargaHelpers.js";
import { intentarAutoPublicar } from "./autoPublicacion.js";
import {
  dropboxDirectUrl,
  nombreArchivoCompartido,
  filtrarPorHoja,
  datosNuevaCargaDropbox,
} from "./dropboxAutoDescargaHelpers.js";

type FilaConProveedor = AutoDescargaMarca & { proveedor: Proveedor };

// soloIds: igual que correrAutoDescargasAbc — si viene, ignora `activo` y
// corre solo esas filas (usado por "Probar ahora"). Sin soloIds, corre todas
// las filas activas de proveedores dropbox_directo (uso del cron diario).
export async function correrAutoDescargasDirectas(soloIds?: number[]): Promise<void> {
  const filas = await prisma.autoDescargaMarca.findMany({
    where: {
      ...(soloIds ? { id: { in: soloIds } } : { activo: true }),
      proveedor: { mecanismoAutoDescarga: "dropbox_directo" },
    },
    include: { proveedor: true },
  });
  if (filas.length === 0) return;

  // Todas las marcas de un mismo proveedor comparten un solo archivo — se
  // agrupa para descargarlo y extraerlo una sola vez por proveedor, no una
  // vez por marca.
  const filasPorProveedor = new Map<number, FilaConProveedor[]>();
  for (const fila of filas) {
    const lista = filasPorProveedor.get(fila.proveedorId) ?? [];
    lista.push(fila);
    filasPorProveedor.set(fila.proveedorId, lista);
  }

  for (const filasProveedor of filasPorProveedor.values()) {
    try {
      await procesarProveedor(filasProveedor);
    } catch (err) {
      console.error(
        `Auto-descarga directa: fallo inesperado procesando proveedor "${filasProveedor[0].proveedor.nombre}":`,
        err
      );
    }
  }
}

async function marcarErrorTodas(filas: FilaConProveedor[], mensaje: string): Promise<void> {
  await prisma.autoDescargaMarca.updateMany({
    where: { id: { in: filas.map((f) => f.id) } },
    data: { ultimaCorridaEn: new Date(), ultimoResultado: `error: ${truncarMensaje(mensaje)}` },
  });
}

async function procesarProveedor(filas: FilaConProveedor[]): Promise<void> {
  const proveedor = filas[0].proveedor;
  if (!proveedor.urlDescargaAutomatica) {
    await marcarErrorTodas(filas, "el proveedor no tiene urlDescargaAutomatica configurada");
    return;
  }

  let buffer: Buffer;
  let headers: string[];
  let rows: ExtractedRow[];
  try {
    const respuesta = await fetch(dropboxDirectUrl(proveedor.urlDescargaAutomatica));
    if (!respuesta.ok) {
      throw new Error(`descarga falló con status ${respuesta.status}`);
    }
    buffer = Buffer.from(await respuesta.arrayBuffer());

    const tablas = await extractExcelWithFallback(buffer);
    ({ headers, rows } = combineTables(tablas));
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    console.error(`Auto-descarga directa: falló la descarga/extracción de "${proveedor.nombre}":`, mensaje);
    await marcarErrorTodas(filas, `descarga/extracción falló - ${mensaje}`);
    return;
  }

  // Se filtra y decide por marca ANTES de escribir nada a disco: si ninguna
  // marca tiene cambios (el caso más común día a día), no vale la pena
  // persistir una copia del archivo que ninguna Carga va a referenciar —
  // quedaría huérfana en UPLOADS_DIR para siempre.
  type ResultadoMarca =
    | { fila: FilaConProveedor; error: string }
    | {
        fila: FilaConProveedor;
        headers: string[];
        rows: ExtractedRow[];
        hash: string;
        accion: "sin_cambios" | "crear_carga";
      };

  const resultados: ResultadoMarca[] = filas.map((fila) => {
    try {
      const filtrado = filtrarPorHoja(headers, rows, fila.marca);
      if (filtrado.rows.length === 0) {
        throw new Error(`no se encontraron filas para la hoja "${fila.marca}"`);
      }
      const hash = hashContenidoExtraido(filtrado.headers, filtrado.rows);
      const accion = decidirAccion(hash, fila.ultimoHashArchivo);
      return { fila, headers: filtrado.headers, rows: filtrado.rows, hash, accion };
    } catch (err) {
      return { fila, error: err instanceof Error ? err.message : String(err) };
    }
  });

  const haceFaltaArchivo = resultados.some((r) => "accion" in r && r.accion === "crear_carga");
  let rutaArchivo: string | null = null;
  if (haceFaltaArchivo) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const extension =
      path.extname(new URL(proveedor.urlDescargaAutomatica).pathname).replace(".", "") || "xlsx";
    const nombreArchivo = nombreArchivoCompartido(proveedor.nombre, Date.now(), extension);
    rutaArchivo = path.join(UPLOADS_DIR, nombreArchivo);
    fs.writeFileSync(rutaArchivo, buffer);
  }

  for (const resultado of resultados) {
    if ("error" in resultado) {
      console.error(`Auto-descarga directa: error en marca "${resultado.fila.marca}":`, resultado.error);
      await prisma.autoDescargaMarca.update({
        where: { id: resultado.fila.id },
        data: { ultimaCorridaEn: new Date(), ultimoResultado: `error: ${truncarMensaje(resultado.error)}` },
      });
      continue;
    }

    const { fila, headers: headersFila, rows: rowsFila, hash, accion } = resultado;
    if (accion === "sin_cambios") {
      await prisma.autoDescargaMarca.update({
        where: { id: fila.id },
        data: { ultimaCorridaEn: new Date(), ultimoResultado: "sin_cambios" },
      });
      continue;
    }

    try {
      // rutaArchivo no puede ser null acá: haceFaltaArchivo ya dio true si
      // algún resultado llegó con accion "crear_carga".
      await crearYProcesarCarga(fila, headersFila, rowsFila, hash, rutaArchivo!);
    } catch (err) {
      const mensaje = err instanceof Error ? err.message : String(err);
      console.error(`Auto-descarga directa: error en marca "${fila.marca}":`, mensaje);
      await prisma.autoDescargaMarca.update({
        where: { id: fila.id },
        data: { ultimaCorridaEn: new Date(), ultimoResultado: `error: ${truncarMensaje(mensaje)}` },
      });
    }
  }
}

async function crearYProcesarCarga(
  fila: FilaConProveedor,
  headers: string[],
  rows: ExtractedRow[],
  hash: string,
  rutaArchivo: string
): Promise<void> {
  const nombreArchivo = path.basename(rutaArchivo);
  const tipoArchivo = path.extname(rutaArchivo).replace(".", "") || "xlsx";
  const datos = datosNuevaCargaDropbox(fila, nombreArchivo, rutaArchivo, tipoArchivo, { headers, rows });

  const carga = await prisma.carga.create({
    data: { ...datos, filasExtraidas: datos.filasExtraidas as unknown as Prisma.InputJsonValue },
  });

  await procesarCarga(carga.id);
  const publicada = await intentarAutoPublicar(carga.id);

  await prisma.autoDescargaMarca.update({
    where: { id: fila.id },
    data: {
      ultimoHashArchivo: hash,
      ultimaCorridaEn: new Date(),
      ultimoResultado: publicada ? "publicado_automaticamente" : "carga_creada",
      ultimaCargaId: carga.id,
    },
  });
}
