import { test } from "node:test";
import assert from "node:assert/strict";
import { applyMapping, toNumberOrNull, aplicarAlicuotaIvaDefault } from "./mapping.js";
import type { ColumnMapping } from "./types.js";

// Casos reales relevados en ofertas/ofertas baterías autos bosch.xls y en
// productos_todos.json (ver docs/plan-ofertas.md). El valor con 3 decimales
// exactos y varios dígitos enteros es el caso que rompía la heurística
// anterior: la trataba como separador de miles y perdía el punto decimal.
test("toNumberOrNull: separador de miles sin coma ('1.985' -> 1985)", () => {
  assert.equal(toNumberOrNull("1.985"), 1985);
  assert.equal(toNumberOrNull("$ 1.985"), 1985);
});

test("toNumberOrNull: decimal de 3 cifras con varios dígitos enteros no se corrompe", () => {
  // Precio real de ofertas/ofertas baterías autos bosch.xls (raw_data de la
  // fila sku_proveedor "65/0001"), tal como llega stringificado desde el
  // frontend (toDisplayString) al confirmar la carga.
  assert.equal(toNumberOrNull("101243.285"), 101243.285);
  assert.equal(toNumberOrNull("34634.521"), 34634.521);
});

test("toNumberOrNull: miles + decimales con coma ('1.985,78' -> 1985.78)", () => {
  assert.equal(toNumberOrNull("$ 1.985,78"), 1985.78);
});

test("toNumberOrNull: varios grupos de miles + decimales ('1.234.567,89')", () => {
  assert.equal(toNumberOrNull("1.234.567,89"), 1234567.89);
});

test("toNumberOrNull: decimal simple sin separador de miles", () => {
  assert.equal(toNumberOrNull("34634.52"), 34634.52);
  assert.equal(toNumberOrNull("1985.78"), 1985.78);
});

test("toNumberOrNull: números ya numéricos pasan sin tocar", () => {
  assert.equal(toNumberOrNull(101243.285), 101243.285);
  assert.equal(toNumberOrNull(1985), 1985);
});

test("toNumberOrNull: null/undefined/vacío -> null", () => {
  assert.equal(toNumberOrNull(null), null);
  assert.equal(toNumberOrNull(undefined), null);
  assert.equal(toNumberOrNull(""), null);
});

test("applyMapping: dos columnas al mismo destino se concatenan en orden", () => {
  const headers = ["Producto", "Envase"];
  const rows = [{ Producto: "Filtro de aceite", Envase: "1L" }];
  const mapping: ColumnMapping = { Producto: ["descripcion"], Envase: ["descripcion"] };
  const [row] = applyMapping(headers, rows, mapping);
  assert.equal(row.descripcion, "Filtro de aceite 1L");
});

test("applyMapping: columnas vacías no dejan espacios sobrantes al concatenar", () => {
  const headers = ["Producto", "Envase"];
  const rows = [{ Producto: "Filtro de aceite", Envase: "" }];
  const mapping: ColumnMapping = { Producto: ["descripcion"], Envase: ["descripcion"] };
  const [row] = applyMapping(headers, rows, mapping);
  assert.equal(row.descripcion, "Filtro de aceite");
});

test("applyMapping: una sola columna mapeada no cambia de comportamiento", () => {
  const headers = ["Precio"];
  const rows = [{ Precio: 1985.78 }];
  const mapping: ColumnMapping = { Precio: ["precio_neto"] };
  const [row] = applyMapping(headers, rows, mapping);
  assert.equal(row.precio_neto, 1985.78);
});

test("applyMapping: combinar columnas de código (sku_interno/sku_proveedor) une sin separador", () => {
  const headers = ["CodigoA", "CodigoB"];
  const rows = [{ CodigoA: "AB", CodigoB: "1234" }];
  const mapping: ColumnMapping = { CodigoA: ["sku_interno"], CodigoB: ["sku_interno"] };
  const [row] = applyMapping(headers, rows, mapping);
  assert.equal(row.sku_interno, "AB1234");
});

test("applyMapping: combinar columnas de descripción sigue uniendo con espacio (no cambia por el cambio de separador de código)", () => {
  const headers = ["Denominacion", "Envase"];
  const rows = [{ Denominacion: "Aceite 10W40", Envase: "1L" }];
  const mapping: ColumnMapping = { Denominacion: ["descripcion"], Envase: ["descripcion"] };
  const [row] = applyMapping(headers, rows, mapping);
  assert.equal(row.descripcion, "Aceite 10W40 1L");
});

test("applyMapping: una columna puede mapear a dos campos destino a la vez", () => {
  const headers = ["Precio"];
  const rows = [{ Precio: 1000 }];
  const mapping: ColumnMapping = { Precio: ["precio_lista", "precio_neto"] };
  const [row] = applyMapping(headers, rows, mapping);
  assert.equal(row.precio_lista, 1000);
  assert.equal(row.precio_neto, 1000);
});

test("applyMapping: alicuotaIvaDefault se usa solo si la fila no tiene IVA mapeada", () => {
  const headers = ["Precio"];
  const rows = [{ Precio: 1000 }];
  const mapping: ColumnMapping = { Precio: ["precio_neto"] };
  const [row] = applyMapping(headers, rows, mapping, 21);
  assert.equal(row.alicuota_iva, 21);
});

test("applyMapping: alicuotaIvaDefault no pisa una columna de IVA ya mapeada", () => {
  const headers = ["Precio", "IVA"];
  const rows = [{ Precio: 1000, IVA: 10.5 }];
  const mapping: ColumnMapping = { Precio: ["precio_neto"], IVA: ["alicuota_iva"] };
  const [row] = applyMapping(headers, rows, mapping, 21);
  assert.equal(row.alicuota_iva, 10.5);
});

test("applyMapping: sin alicuotaIvaDefault, IVA sin mapear queda null (comportamiento de siempre)", () => {
  const headers = ["Precio"];
  const rows = [{ Precio: 1000 }];
  const mapping: ColumnMapping = { Precio: ["precio_neto"] };
  const [row] = applyMapping(headers, rows, mapping);
  assert.equal(row.alicuota_iva, null);
});

test("aplicarAlicuotaIvaDefault: completa alicuota_iva null con el default", () => {
  const row = { alicuota_iva: null, otroCampo: "x" };
  assert.deepEqual(aplicarAlicuotaIvaDefault(row, 21), { alicuota_iva: 21, otroCampo: "x" });
});

test("aplicarAlicuotaIvaDefault: no toca un alicuota_iva ya presente", () => {
  const row = { alicuota_iva: 10.5 };
  assert.deepEqual(aplicarAlicuotaIvaDefault(row, 21), { alicuota_iva: 10.5 });
});

test("aplicarAlicuotaIvaDefault: sin default (undefined/null), deja alicuota_iva en null", () => {
  const row = { alicuota_iva: null };
  assert.deepEqual(aplicarAlicuotaIvaDefault(row, undefined), { alicuota_iva: null });
  assert.deepEqual(aplicarAlicuotaIvaDefault(row, null), { alicuota_iva: null });
});

test("aplicarAlicuotaIvaDefault: redondea el default a 2 decimales", () => {
  const row = { alicuota_iva: null };
  assert.deepEqual(aplicarAlicuotaIvaDefault(row, 21.005), { alicuota_iva: 21.01 });
});
