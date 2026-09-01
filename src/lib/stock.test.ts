import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizarCodigo, calcularDelta, aplicarMovimientos, elegirMasBarato } from "./stock.js";

test("normalizarCodigo: colapsa mayúsculas, espacios, guiones, puntos y barras", () => {
  assert.equal(normalizarCodigo("HU718/1k"), "HU7181K");
  assert.equal(normalizarCodigo("hu718-1K"), "HU7181K");
  assert.equal(normalizarCodigo("HU 718.1K"), "HU7181K");
});

test("normalizarCodigo: string vacío o solo separadores da cadena vacía", () => {
  assert.equal(normalizarCodigo(""), "");
  assert.equal(normalizarCodigo(" - . / "), "");
});

test("calcularDelta: entrada suma", () => {
  assert.equal(calcularDelta("entrada", 5, 10), 5);
});

test("calcularDelta: salida resta", () => {
  assert.equal(calcularDelta("salida", 3, 10), -3);
});

test("calcularDelta: ajuste devuelve la diferencia contra lo que había", () => {
  assert.equal(calcularDelta("ajuste", 8, 10), -2);
  assert.equal(calcularDelta("ajuste", 12, 10), 2);
  assert.equal(calcularDelta("ajuste", 10, 10), 0);
});

test("calcularDelta: tipo desconocido lanza", () => {
  assert.throws(() => calcularDelta("regalo", 1, 0), /Tipo de movimiento inválido/);
});

test("calcularDelta: cantidad negativa lanza", () => {
  assert.throws(() => calcularDelta("entrada", -1, 0), /no puede ser negativa/);
});

test("aplicarMovimientos: encadena cantidadResultante sobre una secuencia", () => {
  const pasos = aplicarMovimientos(0, [
    { tipo: "entrada", cantidad: 10 },
    { tipo: "salida", cantidad: 3 },
    { tipo: "ajuste", cantidad: 5 },
  ]);
  assert.deepEqual(
    pasos.map((p) => [p.delta, p.cantidadResultante]),
    [
      [10, 10],
      [-3, 7],
      [-2, 5],
    ]
  );
});

test("aplicarMovimientos: el stock puede quedar negativo (no se bloquea la salida)", () => {
  const pasos = aplicarMovimientos(2, [{ tipo: "salida", cantidad: 5 }]);
  assert.equal(pasos[0].cantidadResultante, -3);
});

test("elegirMasBarato: toma el menor precioConIva y devuelve su proveedor", () => {
  const elegido = elegirMasBarato([
    { proveedor: "ABC", precio: 1200 },
    { proveedor: "BOR&UR", precio: 900 },
    { proveedor: "OTRO", precio: 1500 },
  ]);
  assert.deepEqual(elegido, { proveedor: "BOR&UR", precio: 900 });
});

test("elegirMasBarato: ignora candidatos sin precio", () => {
  const elegido = elegirMasBarato([
    { proveedor: "ABC", precio: null },
    { proveedor: "BOR&UR", precio: 900 },
  ]);
  assert.deepEqual(elegido, { proveedor: "BOR&UR", precio: 900 });
});

test("elegirMasBarato: sin candidatos válidos devuelve null", () => {
  assert.equal(elegirMasBarato([]), null);
  assert.equal(elegirMasBarato([{ proveedor: "ABC", precio: null }]), null);
});
