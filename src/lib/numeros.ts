// Redondeo a 2 decimales para precios/porcentajes: el archivo de origen (o
// una edición manual) puede traer más precisión de la que tiene sentido
// guardar (ej. "$ 1.234,567891", o el resultado de precio + precio*iva/100
// arrastrando el error de coma flotante de JS). Se aplica al valor ya
// parseado, no al parseo en sí — mantiene la interpretación de miles/
// decimales tal cual está en toNumberOrNull/toIntOrNull.
export function roundTo2(n: number | null): number | null {
  return n === null ? null : Math.round(n * 100) / 100;
}
