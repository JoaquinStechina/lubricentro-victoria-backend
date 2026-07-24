// Funciones puras del worker de auto-descarga (ver abcAutoDescarga.ts para
// la orquestación con Playwright + Prisma, que no se testea unitariamente:
// no hay forma de mockear un sitio de terceros en CI, se verifica a mano
// contra el portal real — ver el spec, sección Testing).

export function decidirAccion(
  hashNuevo: string,
  hashAnterior: string | null
): "sin_cambios" | "crear_carga" {
  return hashNuevo === hashAnterior ? "sin_cambios" : "crear_carga";
}

// Nombre propio para el archivo guardado en uploads/: el nombre que da el
// portal de ABC (ej. "ABC_AP_1784828962635.xlsx") no identifica la marca.
export function nombreArchivoDescarga(marca: string, timestamp: number): string {
  const marcaSlug = marca.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${timestamp}_ABC_${marcaSlug}.xlsx`;
}

export type FilaParaCarga = {
  proveedorId: number;
  marca: string;
  porcentajeGanancia: number | null;
};

// Datos para prisma.carga.create al detectar un archivo nuevo/distinto.
// porcentajeGananciaDefault viaja tal cual desde la fila de AutoDescargaMarca
// (ver Carga.porcentajeGananciaDefault en schema.prisma y ReviewTable.tsx).
export function datosNuevaCarga(fila: FilaParaCarga, nombreArchivo: string, rutaArchivo: string) {
  return {
    proveedorId: fila.proveedorId,
    nombreArchivo,
    rutaArchivo,
    tipoArchivo: "xlsx",
    tipoDatos: "catalogo",
    estado: "pendiente",
    porcentajeGananciaDefault: fila.porcentajeGanancia,
  };
}
