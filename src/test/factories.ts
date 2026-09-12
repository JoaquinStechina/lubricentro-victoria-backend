import { prisma } from "../db.js";

// Constructores de datos para tests. La gracia es que cada test declare solo
// lo que le importa a ese test ("un articulo con cantidad 3") y el resto
// tenga un default razonable: el dia que el schema sume una columna
// obligatoria se arregla acá y no en cada archivo de test.

let contador = 0;
// Sufijo único por proceso+llamada para no chocar contra los @unique del
// schema (Proveedor.nombre, ArticuloStock.marca+codigo) cuando un mismo test
// crea varios registros del mismo tipo.
function unico(prefijo: string): string {
  contador += 1;
  return `${prefijo}-${contador}`;
}

export function crearProveedor(datos: Partial<{ nombre: string; alicuotaIvaDefault: number | null }> = {}) {
  return prisma.proveedor.create({
    data: {
      nombre: datos.nombre ?? unico("Proveedor Test"),
      alicuotaIvaDefault: datos.alicuotaIvaDefault ?? null,
    },
  });
}

export function crearCarga(
  proveedorId: number,
  datos: Partial<{ nombreArchivo: string; tipoArchivo: string; tipoDatos: string; estado: string }> = {}
) {
  return prisma.carga.create({
    data: {
      proveedorId,
      nombreArchivo: datos.nombreArchivo ?? unico("lista-test") + ".xlsx",
      rutaArchivo: `uploads/${unico("ruta")}.xlsx`,
      tipoArchivo: datos.tipoArchivo ?? "xlsx",
      tipoDatos: datos.tipoDatos ?? "catalogo",
      estado: datos.estado ?? "confirmacion_pendiente",
    },
  });
}

export function crearProductoPrecio(
  proveedorId: number,
  datos: Partial<{
    marca: string | null;
    skuProveedor: string | null;
    descripcion: string;
    precioNeto: number | null;
    precioConIva: number | null;
    vigente: boolean;
    eliminado: boolean;
    cargaId: number | null;
  }> = {}
) {
  return prisma.productoPrecio.create({
    data: {
      proveedorId,
      cargaId: datos.cargaId ?? null,
      marca: datos.marca === undefined ? "Mann" : datos.marca,
      skuProveedor: datos.skuProveedor === undefined ? unico("SKU") : datos.skuProveedor,
      descripcion: datos.descripcion ?? "Filtro de aceite",
      precioNeto: datos.precioNeto === undefined ? 1000 : datos.precioNeto,
      precioConIva: datos.precioConIva === undefined ? 1210 : datos.precioConIva,
      vigente: datos.vigente ?? true,
      eliminado: datos.eliminado ?? false,
    },
  });
}

export function crearArticuloStock(
  datos: Partial<{
    marca: string;
    codigo: string;
    codigoNorm: string;
    descripcion: string;
    categoria: string | null;
    cantidad: number;
    minimo: number | null;
    eliminado: boolean;
  }> = {}
) {
  const codigo = datos.codigo ?? unico("COD");
  return prisma.articuloStock.create({
    data: {
      marca: datos.marca ?? "Mann",
      codigo,
      // Se replica normalizarCodigo() en vez de importarlo a propósito: si
      // alguien cambia la normalización, los tests que dependen del matcheo
      // con el catálogo tienen que fallar, no seguir el cambio en silencio.
      codigoNorm: datos.codigoNorm ?? codigo.toUpperCase().replace(/[\s\-./]/g, ""),
      descripcion: datos.descripcion ?? "Filtro de aceite",
      categoria: datos.categoria ?? null,
      cantidad: datos.cantidad ?? 0,
      minimo: datos.minimo ?? null,
      eliminado: datos.eliminado ?? false,
    },
  });
}

export function crearOferta(
  proveedorId: number,
  datos: Partial<{
    marca: string;
    numeroOferta: number;
    skuProveedor: string;
    descripcion: string;
    desdeCantidad: number;
    descuentoPct: number;
    precioUnitario: number;
    // null = "hasta agotar stock": la oferta no vence sola, así que el
    // listado por defecto siempre la incluye (ver buildOfertasWhere).
    fechaHasta: string | null;
    activa: boolean;
    eliminado: boolean;
  }> = {}
) {
  contador += 1;
  return prisma.oferta.create({
    data: {
      proveedorId,
      marca: datos.marca ?? "Bosch",
      numeroOferta: datos.numeroOferta ?? contador,
      skuProveedor: datos.skuProveedor ?? unico("SKU-OF"),
      descripcion: datos.descripcion ?? "Escobilla 20 pulgadas",
      desdeCantidad: datos.desdeCantidad ?? 1,
      descuentoPct: datos.descuentoPct ?? 15,
      precioUnitario: datos.precioUnitario ?? 8500,
      fechaOferta: "2026-09-01",
      horaOferta: "10:00",
      fechaHasta: datos.fechaHasta === undefined ? null : datos.fechaHasta,
      activa: datos.activa ?? true,
      eliminado: datos.eliminado ?? false,
      archivoOrigen: unico("oferta") + ".xls",
    },
  });
}
