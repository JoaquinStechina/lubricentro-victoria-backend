import { test } from "node:test";
import assert from "node:assert/strict";
import { toNumberOrNull } from "./mapping.js";

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
