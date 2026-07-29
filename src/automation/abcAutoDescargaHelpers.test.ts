import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decidirAccion,
  nombreArchivoDescarga,
  datosNuevaCarga,
  truncarMensaje,
  MAX_LARGO_RESULTADO,
  hashContenidoExtraido,
} from "./abcAutoDescargaHelpers.js";

test("decidirAccion: hash igual al anterior -> sin_cambios", () => {
  assert.equal(decidirAccion("abc123", "abc123"), "sin_cambios");
});

test("decidirAccion: hash distinto al anterior -> crear_carga", () => {
  assert.equal(decidirAccion("abc123", "xyz789"), "crear_carga");
});

test("decidirAccion: sin hash anterior (primera corrida) -> crear_carga", () => {
  assert.equal(decidirAccion("abc123", null), "crear_carga");
});

test("nombreArchivoDescarga: marca simple", () => {
  assert.equal(nombreArchivoDescarga("MANN", 1784828962635), "1784828962635_ABC_MANN.xlsx");
});

test("nombreArchivoDescarga: marca con espacios y puntos se sanitiza", () => {
  assert.equal(nombreArchivoDescarga("BOSCH A.", 1784828962635), "1784828962635_ABC_BOSCH_A_.xlsx");
});

test("datosNuevaCarga: arma los datos para prisma.carga.create, incluyendo porcentajeGananciaDefault y origen", () => {
  const fila = { proveedorId: 7, marca: "MANN", porcentajeGanancia: 53 };
  const datos = datosNuevaCarga(fila, "1_ABC_MANN.xlsx", "/app/uploads/1_ABC_MANN.xlsx");
  assert.deepEqual(datos, {
    proveedorId: 7,
    nombreArchivo: "1_ABC_MANN.xlsx",
    rutaArchivo: "/app/uploads/1_ABC_MANN.xlsx",
    tipoArchivo: "xlsx",
    tipoDatos: "catalogo",
    estado: "pendiente",
    origen: "auto_descarga",
    porcentajeGananciaDefault: 53,
  });
});

test("datosNuevaCarga: porcentajeGanancia null viaja como null", () => {
  const fila = { proveedorId: 7, marca: "WIX", porcentajeGanancia: null };
  const datos = datosNuevaCarga(fila, "1_ABC_WIX.xlsx", "/app/uploads/1_ABC_WIX.xlsx");
  assert.equal(datos.porcentajeGananciaDefault, null);
});

test("truncarMensaje: mensaje corto no se toca", () => {
  assert.equal(truncarMensaje("timeout"), "timeout");
});

test("truncarMensaje: mensaje justo en el límite no se toca", () => {
  const mensaje = "a".repeat(MAX_LARGO_RESULTADO);
  assert.equal(truncarMensaje(mensaje), mensaje);
  assert.equal(truncarMensaje(mensaje).length, MAX_LARGO_RESULTADO);
});

test("truncarMensaje: mensaje largo (tipo 'Call log:' de Playwright) se corta a MAX_LARGO_RESULTADO", () => {
  const mensaje = "Timeout 30000ms exceeded.\nCall log:\n" + "-".repeat(300);
  const resultado = truncarMensaje(mensaje);
  assert.equal(resultado.length, MAX_LARGO_RESULTADO);
  assert.equal(resultado, mensaje.slice(0, MAX_LARGO_RESULTADO));
});

test("truncarMensaje: con el prefijo más largo ('error: login falló - '), el resultado final entra justo en VARCHAR(191)", () => {
  const prefijo = "error: login falló - ";
  const mensaje = "x".repeat(500);
  const resultadoFinal = `${prefijo}${truncarMensaje(mensaje)}`;
  assert.equal(resultadoFinal.length, 191);
});

test("hashContenidoExtraido: mismo contenido con __hoja distinto -> mismo hash", () => {
  const headers = ["CODIGO", "MARCA"];
  const rowsA = [{ __hoja: "ABC_AP_1111111111111.xlsx", __seccion: null, CODIGO: "X1", MARCA: "MANN" }];
  const rowsB = [{ __hoja: "ABC_AP_2222222222222.xlsx", __seccion: null, CODIGO: "X1", MARCA: "MANN" }];
  assert.equal(hashContenidoExtraido(headers, rowsA), hashContenidoExtraido(headers, rowsB));
});

test("hashContenidoExtraido: mismo __hoja pero __seccion distinto -> hash distinto", () => {
  const headers = ["CODIGO", "MARCA"];
  const rowsA = [{ __hoja: "ABC_AP_1111111111111.xlsx", __seccion: "MANN PESADO", CODIGO: "X1", MARCA: "MANN" }];
  const rowsB = [{ __hoja: "ABC_AP_1111111111111.xlsx", __seccion: "MANN LIVIANO", CODIGO: "X1", MARCA: "MANN" }];
  assert.notEqual(hashContenidoExtraido(headers, rowsA), hashContenidoExtraido(headers, rowsB));
});

test("hashContenidoExtraido: un precio distinto entre filas por lo demás iguales -> hash distinto", () => {
  const headers = ["CODIGO", "PRECIO"];
  const rowsA = [{ __hoja: "h.xlsx", __seccion: null, CODIGO: "X1", PRECIO: 100 }];
  const rowsB = [{ __hoja: "h.xlsx", __seccion: null, CODIGO: "X1", PRECIO: 101 }];
  assert.notEqual(hashContenidoExtraido(headers, rowsA), hashContenidoExtraido(headers, rowsB));
});

test("hashContenidoExtraido: sin filas devuelve un hash definido y estable", () => {
  const hash1 = hashContenidoExtraido(["CODIGO"], []);
  const hash2 = hashContenidoExtraido(["CODIGO"], []);
  assert.equal(typeof hash1, "string");
  assert.ok(hash1.length > 0);
  assert.equal(hash1, hash2);
});
