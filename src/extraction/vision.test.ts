import { test } from "node:test";
import assert from "node:assert/strict";
import { conContextoDePagina, mergeOfertaMetadata, ultimaSeccion } from "./vision.js";

// conContextoDePagina: para una sola página (el caso más común hoy, fotos
// sueltas de WhatsApp) el prompt no debe cambiar respecto al comportamiento
// anterior a partir de esta página vs. imagen — nada de contexto de
// paginación agregado.
test("conContextoDePagina: con una sola página, el prompt queda idéntico", () => {
  const base = "PROMPT BASE";
  assert.equal(conContextoDePagina(base, 1, 1, null), base);
});

test("conContextoDePagina: con varias páginas y sin sección previa, avisa que no hay sección detectada todavía", () => {
  const resultado = conContextoDePagina("PROMPT BASE", 1, 3, null);
  assert.match(resultado, /página 1 de 3/);
  assert.match(resultado, /Todavía no se detectó ninguna sección/);
});

test("conContextoDePagina: con sección previa, se la pasa al modelo para que la arrastre", () => {
  const resultado = conContextoDePagina("PROMPT BASE", 4, 8, "LUBRICANTES INDUSTRIALES");
  assert.match(resultado, /página 4 de 8/);
  assert.match(resultado, /"LUBRICANTES INDUSTRIALES"/);
});

// headersPrevios: probado en vivo contra un PDF real de 8 páginas donde el
// encabezado de la tabla solo aparece impreso en la página 1 — sin este
// contexto, el modelo tomaba la primera fila de datos de cada página
// siguiente como si fuera el encabezado.
test("conContextoDePagina: sin headers previos, avisa que hay que identificarlos en esta página", () => {
  const resultado = conContextoDePagina("PROMPT BASE", 1, 3, null, null);
  assert.match(resultado, /Todavía no se detectaron las columnas/);
});

test("conContextoDePagina: con headers previos, los pasa tal cual y avisa que no repita el encabezado", () => {
  const resultado = conContextoDePagina("PROMPT BASE", 2, 8, null, ["Codigo", "Descripción", "Neto"]);
  assert.match(resultado, /\["Codigo","Descripción","Neto"\]/);
  assert.match(resultado, /NO inventes otro encabezado/);
});

// ultimaSeccion: recorre de atrás para adelante buscando la última fila con
// _seccion no vacío (así una página que termina en filas sin sección
// explícita no "borra" la sección que venía arrastrando).
test("ultimaSeccion: toma la _seccion de la última fila que la tenga", () => {
  const rows = [
    { _seccion: "TURBINAS", codigo: "A" },
    { _seccion: "TURBINAS", codigo: "B" },
    { _seccion: "ENGRANAJES", codigo: "C" },
  ];
  assert.equal(ultimaSeccion(rows), "ENGRANAJES");
});

test("ultimaSeccion: si las últimas filas no traen _seccion, busca hacia atrás", () => {
  const rows = [
    { _seccion: "TURBINAS", codigo: "A" },
    { codigo: "B" },
    { codigo: "C" },
  ];
  assert.equal(ultimaSeccion(rows), "TURBINAS");
});

test("ultimaSeccion: sin ninguna fila con _seccion, devuelve null", () => {
  assert.equal(ultimaSeccion([{ codigo: "A" }, { codigo: "B" }]), null);
});

test("ultimaSeccion: lista vacía devuelve null", () => {
  assert.equal(ultimaSeccion([]), null);
});

// mergeOfertaMetadata: el banner con marca/n° de oferta/fecha/hora suele
// estar solo en la primera página; con el documento partido en una llamada
// por página, cada página propone su propia metadata (probablemente null)
// y hay que quedarse con el primer valor no nulo por campo.
test("mergeOfertaMetadata: la primera página con dato gana, sin pisar con nulls de páginas siguientes", () => {
  const resultado = mergeOfertaMetadata([
    { marca: "Bosch", numero_oferta: "123", fecha_oferta: "2026-07-01", hora_oferta: "10:00", fecha_hasta: null },
    { marca: null, numero_oferta: null, fecha_oferta: null, hora_oferta: null, fecha_hasta: null },
  ]);
  assert.deepEqual(resultado, {
    marca: "Bosch",
    numero_oferta: "123",
    fecha_oferta: "2026-07-01",
    hora_oferta: "10:00",
    fecha_hasta: null,
  });
});

test("mergeOfertaMetadata: si la primera página no trae un campo, lo toma de una página posterior", () => {
  const resultado = mergeOfertaMetadata([
    { marca: null, numero_oferta: null, fecha_oferta: null, hora_oferta: null, fecha_hasta: null },
    { marca: "Bosch", numero_oferta: "123", fecha_oferta: "2026-07-01", hora_oferta: "10:00", fecha_hasta: "2026-07-31" },
  ]);
  assert.deepEqual(resultado, {
    marca: "Bosch",
    numero_oferta: "123",
    fecha_oferta: "2026-07-01",
    hora_oferta: "10:00",
    fecha_hasta: "2026-07-31",
  });
});

test("mergeOfertaMetadata: sin páginas, devuelve todo null", () => {
  assert.deepEqual(mergeOfertaMetadata([]), {
    marca: null,
    numero_oferta: null,
    fecha_oferta: null,
    hora_oferta: null,
    fecha_hasta: null,
  });
});
