import assert from "node:assert/strict";
import type { ClienteApi } from "./servidor.js";

// Todos los endpoints de listado de la app responden la misma forma
// { items, total, page, pageSize, totalPages }. Este helper verifica esa
// forma y el comportamiento de la paginación de una sola vez, para que un
// endpoint de listado nuevo herede la cobertura con una línea:
//
//   await verificarContratoDeListado(api, "/api/lo-que-sea");
//
// Precondición: la base ya tiene al menos 3 filas visibles en ese endpoint.

type Pagina = { items: unknown[]; total: number; page: number; pageSize: number; totalPages: number };

const TOPE_PAGE_SIZE = 500;

function conQuery(ruta: string, query: string): string {
  return ruta.includes("?") ? `${ruta}&${query}` : `${ruta}?${query}`;
}

function idsDe(pagina: Pagina): unknown[] {
  return pagina.items.map((item) => (item as { id?: unknown }).id);
}

export async function verificarContratoDeListado(api: ClienteApi, ruta: string): Promise<void> {
  const primera = await api.get<Pagina>(conQuery(ruta, "page=1&pageSize=2"));

  assert.equal(primera.status, 200, `${ruta} deberia responder 200`);
  assert.ok(Array.isArray(primera.body.items), `${ruta} deberia devolver un array en 'items'`);
  for (const campo of ["total", "page", "pageSize", "totalPages"] as const) {
    assert.equal(
      typeof primera.body[campo],
      "number",
      `${ruta} deberia devolver '${campo}' numerico (forma { items, total, page, pageSize, totalPages })`
    );
  }

  assert.ok(
    primera.body.total >= 3,
    `${ruta}: el test necesita al menos 3 filas sembradas para verificar la paginacion, hay ${primera.body.total}`
  );
  assert.equal(primera.body.page, 1, `${ruta} deberia devolver la pagina pedida`);
  assert.equal(primera.body.pageSize, 2, `${ruta} deberia respetar el pageSize pedido`);
  assert.equal(primera.body.items.length, 2, `${ruta} deberia devolver exactamente pageSize filas`);
  assert.equal(
    primera.body.totalPages,
    Math.max(1, Math.ceil(primera.body.total / 2)),
    `${ruta}: totalPages deberia ser ceil(total / pageSize)`
  );

  // Lo que realmente importa de paginar: que la página 2 traiga filas
  // distintas. Un `skip` mal calculado devuelve la forma correcta igual.
  const segunda = await api.get<Pagina>(conQuery(ruta, "page=2&pageSize=2"));
  assert.equal(segunda.status, 200, `${ruta}?page=2 deberia responder 200`);
  assert.equal(segunda.body.page, 2, `${ruta}?page=2 deberia devolver page=2`);
  const repetidos = idsDe(segunda.body).filter((id) => idsDe(primera.body).includes(id));
  assert.deepEqual(repetidos, [], `${ruta}: la pagina 2 repite filas de la pagina 1`);
  assert.equal(
    segunda.body.total,
    primera.body.total,
    `${ruta}: el total no deberia cambiar entre paginas`
  );

  // Tope duro de filas por request: sin esto un pageSize enorme puede bajar
  // la tabla entera (productos_precios tiene ~50.000 filas en produccion).
  const excesiva = await api.get<Pagina>(conQuery(ruta, "pageSize=9999"));
  assert.equal(excesiva.status, 200, `${ruta}?pageSize=9999 deberia responder 200`);
  assert.equal(
    excesiva.body.pageSize,
    TOPE_PAGE_SIZE,
    `${ruta} deberia topear pageSize en ${TOPE_PAGE_SIZE}`
  );

  // Una pagina mas alla del final es un estado alcanzable (alguien borra
  // filas mientras otro esta en la ultima pagina): tiene que devolver vacio,
  // no romper.
  const fueraDeRango = await api.get<Pagina>(conQuery(ruta, "page=9999&pageSize=2"));
  assert.equal(fueraDeRango.status, 200, `${ruta}?page=9999 deberia responder 200, no romper`);
  assert.deepEqual(
    fueraDeRango.body.items,
    [],
    `${ruta}?page=9999 deberia devolver items vacio`
  );
}
