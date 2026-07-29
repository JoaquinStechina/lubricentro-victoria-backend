import fs from "node:fs";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { extractExcelWithFallback, combineTables, extractBannerLines } from "./excel.js";
import { extractWithVision, extractOfertaWithVision } from "./vision.js";
import {
  getExistingMapping,
  suggestMapping,
  applyMapping,
  normalizeCanonicalRow,
  aplicarAlicuotaIvaDefault,
} from "./mapping.js";
import {
  getExistingMappingOferta,
  suggestMappingOfertas,
  applyMappingOfertas,
  normalizeOfertaRow,
} from "./mappingOfertas.js";
import { detectOfertaMetadata } from "./ofertaMetadata.js";
import type { CanonicalRow, CanonicalRowUpload, ColumnMapping, ExtractedRow } from "./types.js";
import type {
  OfertaField,
  OfertaColumnMapping,
  OfertaMetadata,
  OfertaRowNormalized,
} from "./typesOfertas.js";

const MIME_BY_TIPO: Record<string, "application/pdf" | "image/png" | "image/jpeg"> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

// mapping puede traer un solo destino por columna (ofertas, siempre) o
// varios (catálogo, desde que el mapeo admite uno-a-muchos — ver mapping.ts
// y el schema de MapeoColumna). Por cada columna, borra los destinos
// guardados que ya no están en la lista nueva (si un humano saca un destino
// que antes tenía) y crea/mantiene los que sí — así una edición posterior
// nunca deja un destino viejo huérfano en MapeoColumna.
async function upsertMapeoColumnas(
  proveedorId: number,
  mapping: Record<string, string | string[]>,
  tipoDatos: "catalogo" | "oferta" = "catalogo"
): Promise<void> {
  for (const [columnaOrigen, destino] of Object.entries(mapping)) {
    const destinos = Array.isArray(destino) ? destino : [destino];
    await prisma.mapeoColumna.deleteMany({
      where: { proveedorId, columnaOrigen, tipoDatos, campoDestino: { notIn: destinos } },
    });
    for (const campoDestino of destinos) {
      await prisma.mapeoColumna.upsert({
        where: {
          proveedorId_columnaOrigen_campoDestino_tipoDatos: {
            proveedorId,
            columnaOrigen,
            campoDestino,
            tipoDatos,
          },
        },
        update: {},
        create: { proveedorId, columnaOrigen, campoDestino, tipoDatos },
      });
    }
  }
}

// Inserta las filas ya en forma canónica y marca la carga como completada,
// limpiando lo que quedaba pendiente de revisión. Antes de insertar, marca
// como superada (vigente: false) la fila previa de cada proveedor+marca+SKU
// que aparezca en este batch — nunca se pisa ni se borra, solo se deja de
// considerar la última vigente (ver el campo `vigente` en schema.prisma).
// Filas sin sku_proveedor no tienen forma confiable de matchear "el mismo
// producto" y no se tocan. Todo en una transacción para que no quede un
// estado intermedio visible (superada pero la nueva todavía no insertada).
async function publicarCanonicalRows(
  cargaId: number,
  proveedorId: number,
  canonicalRows: CanonicalRow[]
): Promise<number> {
  await prisma.$transaction(
    async (tx) => {
      // Agrupado por marca (no una query por SKU: un archivo puede traer
      // miles de filas y no queremos una query por fila) — se resuelve con
      // un updateMany por marca, con el set de SKUs de esa marca en lotes de
      // 500 dentro del `in` como margen de seguridad frente a límites de
      // parámetros por statement del motor de base de datos.
      const skusPorMarca = new Map<string | null, Set<string>>();
      for (const r of canonicalRows) {
        if (!r.sku_proveedor) continue;
        const set = skusPorMarca.get(r.marca) ?? new Set<string>();
        set.add(r.sku_proveedor);
        skusPorMarca.set(r.marca, set);
      }
      for (const [marca, skus] of skusPorMarca) {
        for (const loteSkus of chunk(Array.from(skus), 500)) {
          await tx.productoPrecio.updateMany({
            where: { proveedorId, marca, skuProveedor: { in: loteSkus }, vigente: true },
            data: { vigente: false },
          });
        }
      }

      for (const batch of chunk(canonicalRows, 60)) {
        await tx.productoPrecio.createMany({
          data: batch.map((r) => ({
            proveedorId,
            cargaId,
            marca: r.marca,
            skuProveedor: r.sku_proveedor,
            skuInterno: r.sku_interno,
            descripcion: r.descripcion,
            seccion: r.seccion,
            precioNeto: r.precio_neto,
            precioConIva: r.precio_con_iva,
            precioLista: r.precio_lista,
            precioListaConIva: r.precio_lista_con_iva,
            precioSugerido: r.precio_sugerido,
            alicuotaIva: r.alicuota_iva,
            moneda: r.moneda ?? "ARS",
            unidad: r.unidad,
            fechaVigencia: r.fecha_vigencia,
            vigente: true,
            rawData: r.raw_data as unknown as Prisma.InputJsonValue,
          })),
        });
      }
    },
    // Default de Prisma (5s) puede quedarse corto en archivos grandes
    // (ej. el de 22.623 filas de contexto.md) entre el update de superadas y
    // los createMany en lotes de 60.
    { timeout: 30000 }
  );

  await prisma.carga.update({
    where: { id: cargaId },
    data: {
      estado: "completado",
      mensajeError: null,
      filasExtraidas: Prisma.JsonNull,
      mapeoSugerido: Prisma.JsonNull,
    },
  });

  return canonicalRows.length;
}

// Exportado para reusarlo en advertenciasOfertas.ts como advertencia
// temprana no bloqueante (misma lista, distinto propósito: acá abajo es un
// error duro al confirmar). desde_cantidad y descuento_pct no están acá:
// normalizeOfertaRow (mappingOfertas.ts) ya les aplica un default (1 y 0)
// cuando vienen vacíos, así que nunca llegan null a esta validación.
export const OFERTA_REQUIRED_FIELDS: (keyof OfertaRowNormalized)[] = [
  "marca",
  "numero_oferta",
  "sku_proveedor",
  "descripcion",
  "precio_unitario",
  "fecha_oferta",
  "hora_oferta",
];

// A diferencia de ProductoPrecio (todos los campos nullable), el schema de
// Oferta exige estos campos NOT NULL (ver prisma/schema.prisma) — se valida
// acá con un mensaje claro en vez de dejar que el INSERT reviente con un
// error críptico de Prisma.
function validarFilasOferta(rows: OfertaRowNormalized[]): void {
  rows.forEach((r, idx) => {
    const faltantes = OFERTA_REQUIRED_FIELDS.filter(
      (campo) => r[campo] === null || r[campo] === undefined
    );
    if (faltantes.length > 0) {
      throw new Error(
        `Fila ${idx + 1} (SKU ${r.sku_proveedor ?? "sin dato"}): faltan campos obligatorios: ${faltantes.join(", ")}.`
      );
    }
  });
}

// Paralela a publicarCanonicalRows: inserta en Oferta en vez de
// ProductoPrecio (ver docs/plan-ofertas.md, punto 5).
async function publicarOfertaRows(
  cargaId: number,
  proveedorId: number,
  archivoOrigen: string,
  rows: OfertaRowNormalized[]
): Promise<number> {
  validarFilasOferta(rows);

  for (const batch of chunk(rows, 60)) {
    await prisma.oferta.createMany({
      data: batch.map((r) => ({
        proveedorId,
        cargaId,
        marca: r.marca!,
        numeroOferta: r.numero_oferta!,
        skuProveedor: r.sku_proveedor!,
        descripcion: r.descripcion!,
        desdeCantidad: r.desde_cantidad!,
        descuentoPct: r.descuento_pct!,
        precioUnitario: r.precio_unitario!,
        moneda: r.moneda ?? "ARS",
        fechaOferta: r.fecha_oferta!,
        horaOferta: r.hora_oferta!,
        fechaHasta: r.fecha_hasta,
        cantidadDisponible: r.cantidad_disponible,
        activa: true,
        archivoOrigen,
        rawData: r.raw_data as unknown as Prisma.InputJsonValue,
      })),
    });
  }

  await prisma.carga.update({
    where: { id: cargaId },
    data: {
      estado: "completado",
      mensajeError: null,
      filasExtraidas: Prisma.JsonNull,
      mapeoSugerido: Prisma.JsonNull,
      metadataOferta: Prisma.JsonNull,
    },
  });

  return rows.length;
}

// Orquesta las etapas 2-4 del pipeline (ver contexto.md) para una carga ya
// recibida: extraer la tabla (determinístico para xlsx/xls, con fallback a
// IA para hojas con headers atípicos; con IA de visión para pdf/png/jpg) y
// resolver el mapeo de columnas (reusar el aprobado o pedir una sugerencia
// si el proveedor es nuevo / le cambiaron los headers). Si tipoDatos es
// "oferta" (ver docs/plan-ofertas.md), además intenta detectar marca/n° de
// oferta/fecha/hora "de todo el archivo" y usa el mapeo/schema de ofertas en
// vez del de catálogo. Nunca publica sola: toda carga queda esperando
// confirmación humana antes de escribirse en ProductoPrecio/Oferta (ver
// confirmarCargaYPublicar/confirmarCargaYPublicarOferta).
export async function procesarCarga(cargaId: number): Promise<void> {
  const carga = await prisma.carga.findUniqueOrThrow({ where: { id: cargaId } });

  await prisma.carga.update({
    where: { id: cargaId },
    data: { estado: "procesando", mensajeError: null },
  });

  try {
    if (!carga.proveedorId) {
      throw new Error(
        "La carga no tiene proveedor asociado; no se puede resolver ni guardar el mapeo de columnas."
      );
    }

    const esOferta = carga.tipoDatos === "oferta";

    // Si ya habíamos extraído las filas en un intento anterior (por ejemplo,
    // si esta misma carga falló en el paso de sugerir el mapeo por un error
    // transitorio de la API), las reusamos en vez de volver a parsear el
    // archivo entero (y, para ofertas, reusamos también la metadata ya
    // detectada en vez de volver a llamar al LLM).
    const cache = carga.filasExtraidas as unknown as
      | { headers: string[]; rows: ExtractedRow[] }
      | null;

    let headers: string[];
    let rows: ExtractedRow[];
    let metadata = carga.metadataOferta as unknown as OfertaMetadata | null;

    if (cache) {
      ({ headers, rows } = cache);
    } else {
      const buffer = fs.readFileSync(carga.rutaArchivo);

      if (carga.tipoArchivo === "xlsx" || carga.tipoArchivo === "xls") {
        const tables = await extractExcelWithFallback(buffer);
        if (tables.length === 0) {
          throw new Error("No se detectó ninguna tabla de productos en el archivo.");
        }
        ({ headers, rows } = combineTables(tables));
        if (esOferta) {
          metadata = await detectOfertaMetadata(
            carga.nombreArchivo,
            extractBannerLines(buffer),
            carga.sinFechaLimite
          );
        }
      } else {
        const mimeType = MIME_BY_TIPO[carga.tipoArchivo];
        if (!mimeType) {
          throw new Error(`Tipo de archivo no soportado para extracción: ${carga.tipoArchivo}`);
        }
        if (esOferta) {
          const extraido = await extractOfertaWithVision(
            buffer,
            mimeType,
            carga.nombreArchivo,
            carga.sinFechaLimite
          );
          ({ headers, rows } = combineTables(extraido.tables));
          metadata = extraido.metadata;
        } else {
          const tables = await extractWithVision(buffer, mimeType, carga.nombreArchivo);
          ({ headers, rows } = combineTables(tables));
        }
      }

      if (rows.length === 0) {
        throw new Error("No se encontraron filas en el archivo.");
      }

      await prisma.carga.update({
        where: { id: cargaId },
        data: {
          filasExtraidas: { headers, rows } as unknown as Prisma.InputJsonValue,
          metadataOferta: metadata ? (metadata as unknown as Prisma.InputJsonValue) : undefined,
        },
      });
    }

    const mapeoExistente = esOferta
      ? await getExistingMappingOferta(carga.proveedorId, headers)
      : await getExistingMapping(carga.proveedorId, headers);
    const mapeoParaRevision =
      mapeoExistente ??
      (esOferta ? await suggestMappingOfertas(headers, rows) : await suggestMapping(headers, rows));

    await prisma.carga.update({
      where: { id: cargaId },
      data: {
        // "confirmacion_pendiente": proveedor conocido, el mapeo ya está
        // aprobado, solo falta que un humano confirme los valores.
        // "revision_pendiente": proveedor nuevo (o le cambiaron los
        // headers), el mapeo es una sugerencia del LLM sin aprobar todavía.
        estado: mapeoExistente ? "confirmacion_pendiente" : "revision_pendiente",
        mapeoSugerido: mapeoParaRevision as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    await prisma.carga.update({
      where: { id: cargaId },
      data: { estado: "error", mensajeError: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}

// Un humano aprobó (o editó) el mapeo sugerido: lo guarda en MapeoColumna
// para reusarlo en próximas cargas del mismo proveedor, y publica las filas
// que ya estaban extraídas (no hace falta re-parsear el archivo) aplicando
// ese mapeo. Se mantiene por compatibilidad con pruebas existentes; el
// frontend nuevo usa confirmarCargaYPublicar/confirmarCargaYPublicarOferta,
// que además permite editar los valores de cada fila, no solo el mapeo.
export async function aprobarMapeoYPublicar(
  cargaId: number,
  mapping: ColumnMapping | OfertaColumnMapping
): Promise<number> {
  const carga = await prisma.carga.findUniqueOrThrow({ where: { id: cargaId } });
  if (!carga.proveedorId) throw new Error("La carga no tiene proveedor asociado.");
  if (!carga.filasExtraidas) {
    throw new Error("La carga no tiene filas extraídas pendientes de mapeo.");
  }

  const { headers, rows } = carga.filasExtraidas as unknown as {
    headers: string[];
    rows: ExtractedRow[];
  };

  if (carga.tipoDatos === "oferta") {
    const metadata = (carga.metadataOferta as unknown as OfertaMetadata | null) ?? {};
    await upsertMapeoColumnas(carga.proveedorId, mapping, "oferta");
    const ofertaRows = applyMappingOfertas(headers, rows, mapping as OfertaColumnMapping, metadata);
    return publicarOfertaRows(cargaId, carga.proveedorId, carga.nombreArchivo, ofertaRows);
  }

  await upsertMapeoColumnas(carga.proveedorId, mapping, "catalogo");
  const proveedorCatalogo = await prisma.proveedor.findUniqueOrThrow({ where: { id: carga.proveedorId } });
  const canonicalRows = applyMapping(
    headers,
    rows,
    mapping as ColumnMapping,
    proveedorCatalogo.alicuotaIvaDefault
  );
  return publicarCanonicalRows(cargaId, carga.proveedorId, canonicalRows);
}

// Un humano confirmó la carga desde la pantalla de revisión: publica
// exactamente las filas finales que mandó (ya editadas a mano si hizo
// falta), sin volver a derivarlas de `filasExtraidas` — es la pieza que
// permite corregir un valor puntual (ej. un SKU mal leído por la IA) antes
// de que entre a la base, no solo reasignar el mapeo de columnas.
export async function confirmarCargaYPublicar(
  cargaId: number,
  mapping: ColumnMapping,
  filasFinales: Array<CanonicalRowUpload>
): Promise<number> {
  const carga = await prisma.carga.findUniqueOrThrow({ where: { id: cargaId } });
  if (!carga.proveedorId) throw new Error("La carga no tiene proveedor asociado.");
  if (filasFinales.length === 0) throw new Error("No hay filas para publicar.");

  await upsertMapeoColumnas(carga.proveedorId, mapping, "catalogo");
  // La confirmación manual no pasa por applyMapping (recibe las filas ya
  // armadas por ReviewTable.tsx, que no conoce el default de IVA del
  // proveedor) — sin esto, Proveedor.alicuotaIvaDefault solo se aplicaría en
  // el camino de auto-publicación, nunca cuando un humano confirma a mano.
  const proveedor = await prisma.proveedor.findUniqueOrThrow({ where: { id: carga.proveedorId } });
  const canonicalRows = filasFinales.map((fila) =>
    aplicarAlicuotaIvaDefault(normalizeCanonicalRow(fila), proveedor.alicuotaIvaDefault)
  );
  return publicarCanonicalRows(cargaId, carga.proveedorId, canonicalRows);
}

// Paralela a confirmarCargaYPublicar, pero para ofertas: las filas finales
// ya vienen con marca/numero_oferta/fecha_oferta/hora_oferta resueltos por
// fila (el frontend aplica el fallback a la metadata de archivo antes de
// mandarlas, igual que aplica el mapeo — ver ReviewTableOfertas.tsx), así
// que acá solo hace falta normalizar y validar antes de publicar.
export async function confirmarCargaYPublicarOferta(
  cargaId: number,
  mapping: OfertaColumnMapping,
  filasFinales: Array<Partial<Record<OfertaField, unknown>> & { raw_data?: unknown }>
): Promise<number> {
  const carga = await prisma.carga.findUniqueOrThrow({ where: { id: cargaId } });
  if (!carga.proveedorId) throw new Error("La carga no tiene proveedor asociado.");
  if (filasFinales.length === 0) throw new Error("No hay filas para publicar.");

  await upsertMapeoColumnas(carga.proveedorId, mapping, "oferta");
  const rows = filasFinales.map(normalizeOfertaRow);
  return publicarOfertaRows(cargaId, carga.proveedorId, carga.nombreArchivo, rows);
}
