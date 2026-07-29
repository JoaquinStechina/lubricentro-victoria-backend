import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dropboxDirectUrl,
  nombreArchivoCompartido,
  filtrarPorHoja,
  datosNuevaCargaDropbox,
} from "./dropboxAutoDescargaHelpers.js";

test("dropboxDirectUrl: convierte dl=0 a dl=1", () => {
  const url = "https://www.dropbox.com/scl/fo/abc/file.xls?rlkey=xyz&dl=0";
  assert.equal(dropboxDirectUrl(url), "https://www.dropbox.com/scl/fo/abc/file.xls?rlkey=xyz&dl=1");
});

test("dropboxDirectUrl: si no hay parámetro dl, lo agrega en 1", () => {
  const url = "https://www.dropbox.com/scl/fo/abc/file.xls?rlkey=xyz";
  assert.equal(dropboxDirectUrl(url), "https://www.dropbox.com/scl/fo/abc/file.xls?rlkey=xyz&dl=1");
});

test("dropboxDirectUrl: si ya es dl=1, lo deja igual", () => {
  const url = "https://www.dropbox.com/scl/fo/abc/file.xls?rlkey=xyz&dl=1";
  assert.equal(dropboxDirectUrl(url), url);
});

test("nombreArchivoCompartido: arma el nombre con proveedor, timestamp y extensión", () => {
  assert.equal(nombreArchivoCompartido("BORUR", 1784828962635, "xls"), "1784828962635_BORUR.xls");
});

test("nombreArchivoCompartido: sanitiza espacios y símbolos del nombre del proveedor", () => {
  assert.equal(nombreArchivoCompartido("BOR&UR S.R.L.", 123, "xls"), "123_BOR_UR_S_R_L_.xls");
});

test("filtrarPorHoja: se queda solo con las filas de la hoja pedida", () => {
  const headers = ["CODIGO", "PRECIO"];
  const rows = [
    { __hoja: "Tecfil", __seccion: null, CODIGO: "T1", PRECIO: 100 },
    { __hoja: "Mann", __seccion: null, CODIGO: "M1", PRECIO: 200 },
  ];
  const resultado = filtrarPorHoja(headers, rows, "Mann");
  assert.equal(resultado.rows.length, 1);
  assert.equal(resultado.rows[0].CODIGO, "M1");
});

test("filtrarPorHoja: recalcula los headers solo con las columnas que tienen datos en la hoja filtrada", () => {
  const headers = ["CODIGO", "PRECIO", "SOLO_DE_OTRA_HOJA"];
  const rows = [
    { __hoja: "Tecfil", __seccion: null, CODIGO: "T1", PRECIO: 100, SOLO_DE_OTRA_HOJA: null },
    { __hoja: "Mann", __seccion: null, CODIGO: "M1", PRECIO: 200, SOLO_DE_OTRA_HOJA: "algo" },
  ];
  const resultado = filtrarPorHoja(headers, rows, "Tecfil");
  assert.deepEqual(resultado.headers.sort(), ["CODIGO", "PRECIO"]);
});

test("filtrarPorHoja: hoja inexistente devuelve headers y rows vacíos", () => {
  const headers = ["CODIGO"];
  const rows = [{ __hoja: "Tecfil", __seccion: null, CODIGO: "T1" }];
  const resultado = filtrarPorHoja(headers, rows, "NoExiste");
  assert.equal(resultado.rows.length, 0);
  assert.deepEqual(resultado.headers, []);
});

test("datosNuevaCargaDropbox: arma los datos para prisma.carga.create con filasExtraidas y origen", () => {
  const fila = { proveedorId: 9, marca: "Mann", porcentajeGanancia: 40 };
  const filasExtraidas = { headers: ["CODIGO"], rows: [{ CODIGO: "M1" }] };
  const datos = datosNuevaCargaDropbox(
    fila,
    "1_BORUR.xls",
    "/app/uploads/1_BORUR.xls",
    "xls",
    filasExtraidas
  );
  assert.deepEqual(datos, {
    proveedorId: 9,
    nombreArchivo: "1_BORUR.xls",
    rutaArchivo: "/app/uploads/1_BORUR.xls",
    tipoArchivo: "xls",
    tipoDatos: "catalogo",
    estado: "pendiente",
    origen: "auto_descarga",
    porcentajeGananciaDefault: 40,
    filasExtraidas,
  });
});
