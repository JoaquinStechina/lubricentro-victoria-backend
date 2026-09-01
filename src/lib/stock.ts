// Helpers puros del módulo de stock: sin Prisma, sin Express. Toda la
// aritmética de movimientos y el matcheo con el catálogo vive acá para poder
// testearla sin base de datos (ver stock.test.ts).

export type TipoMovimiento = "entrada" | "salida" | "ajuste";

const TIPOS_VALIDOS: readonly string[] = ["entrada", "salida", "ajuste"];

export function esTipoMovimiento(valor: unknown): valor is TipoMovimiento {
  return typeof valor === "string" && TIPOS_VALIDOS.includes(valor);
}

// Clave de matcheo entre un artículo de stock y las filas del catálogo. Los
// proveedores escriben el mismo código de fábrica con formatos distintos
// (HU718/1k vs hu718-1K): normalizando, las coincidencias entre proveedores
// que revenden la misma marca pasan de 19 a 458 sobre los datos reales.
export function normalizarCodigo(codigo: string): string {
  return codigo.toUpperCase().replace(/[\s\-./]/g, "");
}

// entrada suma, salida resta, ajuste lleva el stock al valor contado. Devolver
// siempre un delta con signo hace que los tres tipos compartan la misma
// aritmética aguas abajo.
export function calcularDelta(
  tipo: string,
  cantidad: number,
  cantidadActual: number
): number {
  if (!Number.isInteger(cantidad) || cantidad < 0) {
    throw new Error("La cantidad no puede ser negativa ni fraccionaria");
  }
  if (tipo === "entrada") return cantidad;
  if (tipo === "salida") return -cantidad;
  if (tipo === "ajuste") return cantidad - cantidadActual;
  throw new Error(`Tipo de movimiento inválido: ${tipo}`);
}

// Encadena una secuencia de movimientos desde una cantidad inicial. Lo usa el
// endpoint para un solo movimiento, y los tests para verificar el encadenado.
// No bloquea stock negativo a propósito: un negativo significa que faltó
// registrar una entrada, y bloquear haría que la gente deje de registrar.
export function aplicarMovimientos(
  cantidadInicial: number,
  movimientos: { tipo: string; cantidad: number }[]
): { delta: number; cantidadResultante: number }[] {
  let actual = cantidadInicial;
  return movimientos.map((m) => {
    const delta = calcularDelta(m.tipo, m.cantidad, actual);
    actual += delta;
    return { delta, cantidadResultante: actual };
  });
}

// De los candidatos del catálogo que matchearon el código, el más barato.
// null cuando ninguno tiene precio: el artículo existe pero no hay referencia
// de reposición (no está en ninguna lista cargada).
export function elegirMasBarato(
  candidatos: { proveedor: string; precio: number | null }[]
): { proveedor: string; precio: number } | null {
  let mejor: { proveedor: string; precio: number } | null = null;
  for (const c of candidatos) {
    if (c.precio === null || !Number.isFinite(c.precio)) continue;
    if (mejor === null || c.precio < mejor.precio) {
      mejor = { proveedor: c.proveedor, precio: c.precio };
    }
  }
  return mejor;
}
