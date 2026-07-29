import { test } from "node:test";
import assert from "node:assert/strict";
import { debePublicarAutomaticamente, filasSonPublicables } from "./autoPublicacionHelpers.js";

function filaBase(overrides: Partial<Parameters<typeof filasSonPublicables>[0][number]> = {}) {
  return {
    sku_proveedor: "SKU-1",
    sku_interno: null,
    descripcion: "Filtro de aceite",
    precio_neto: 1000,
    precio_con_iva: null,
    precio_lista: null,
    ...overrides,
  };
}

test("debePublicarAutomaticamente: confirmacion_pendiente sin advertencias -> true", () => {
  assert.equal(debePublicarAutomaticamente("confirmacion_pendiente", 0), true);
});

test("debePublicarAutomaticamente: confirmacion_pendiente con advertencias -> false", () => {
  assert.equal(debePublicarAutomaticamente("confirmacion_pendiente", 2), false);
});

test("debePublicarAutomaticamente: revision_pendiente nunca se auto-publica, incluso sin advertencias", () => {
  assert.equal(debePublicarAutomaticamente("revision_pendiente", 0), false);
});

test("debePublicarAutomaticamente: cualquier otro estado -> false", () => {
  assert.equal(debePublicarAutomaticamente("error", 0), false);
  assert.equal(debePublicarAutomaticamente("completado", 0), false);
  assert.equal(debePublicarAutomaticamente("pendiente", 0), false);
  assert.equal(debePublicarAutomaticamente("procesando", 0), false);
});

test("filasSonPublicables: filas completas (sku, descripcion, algun precio) -> true", () => {
  assert.equal(filasSonPublicables([filaBase(), filaBase({ sku_proveedor: "SKU-2" })]), true);
});

test("filasSonPublicables: una fila sin sku_proveedor NI sku_interno -> false", () => {
  // Este es el caso real que motivó el chequeo: un mapeo parcial que
  // matcheo por casualidad con columnas de otra hoja/marca del mismo
  // proveedor puede dejar el codigo de producto entero sin mapear.
  assert.equal(
    filasSonPublicables([filaBase({ sku_proveedor: null, sku_interno: null })]),
    false
  );
});

test("filasSonPublicables: sku_proveedor null pero sku_interno presente -> true (caso legitimo, ej. Silisur/Tribuno)", () => {
  assert.equal(
    filasSonPublicables([filaBase({ sku_proveedor: null, sku_interno: "INT-1" })]),
    true
  );
});

test("filasSonPublicables: una fila sin descripcion -> false", () => {
  assert.equal(filasSonPublicables([filaBase({ descripcion: null })]), false);
});

test("filasSonPublicables: una fila sin ningun precio -> false", () => {
  assert.equal(
    filasSonPublicables([filaBase({ precio_neto: null, precio_con_iva: null, precio_lista: null })]),
    false
  );
});

test("filasSonPublicables: alcanza con un solo campo de precio positivo", () => {
  assert.equal(
    filasSonPublicables([filaBase({ precio_neto: null, precio_con_iva: null, precio_lista: 500 })]),
    true
  );
});

test("filasSonPublicables: precio en cero en todos los campos de precio -> false (no alcanza con 'no nulo')", () => {
  // detectarAdvertencias nunca mira precio_lista, así que un mapeo que solo
  // llena ese campo (en cero) no dispara ninguna advertencia existente -
  // este chequeo es la única red que lo atrapa.
  assert.equal(
    filasSonPublicables([filaBase({ precio_neto: 0, precio_con_iva: null, precio_lista: 0 })]),
    false
  );
});

test("filasSonPublicables: precio negativo tampoco cuenta como precio valido", () => {
  assert.equal(
    filasSonPublicables([filaBase({ precio_neto: -100, precio_con_iva: null, precio_lista: null })]),
    false
  );
});

test("filasSonPublicables: una sola fila mala entre muchas buenas alcanza para devolver false", () => {
  const filas = [filaBase(), filaBase(), filaBase({ sku_proveedor: null, sku_interno: null })];
  assert.equal(filasSonPublicables(filas), false);
});

test("filasSonPublicables: lista vacia -> true (no hay ninguna fila mala que objetar)", () => {
  assert.equal(filasSonPublicables([]), true);
});
