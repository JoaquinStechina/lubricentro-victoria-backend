import { test } from "node:test";
import assert from "node:assert/strict";
import { decidirAccion, nombreArchivoDescarga, datosNuevaCarga } from "./abcAutoDescargaHelpers.js";

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

test("datosNuevaCarga: arma los datos para prisma.carga.create, incluyendo porcentajeGananciaDefault", () => {
  const fila = { proveedorId: 7, marca: "MANN", porcentajeGanancia: 53 };
  const datos = datosNuevaCarga(fila, "1_ABC_MANN.xlsx", "/app/uploads/1_ABC_MANN.xlsx");
  assert.deepEqual(datos, {
    proveedorId: 7,
    nombreArchivo: "1_ABC_MANN.xlsx",
    rutaArchivo: "/app/uploads/1_ABC_MANN.xlsx",
    tipoArchivo: "xlsx",
    tipoDatos: "catalogo",
    estado: "pendiente",
    porcentajeGananciaDefault: 53,
  });
});

test("datosNuevaCarga: porcentajeGanancia null viaja como null", () => {
  const fila = { proveedorId: 7, marca: "WIX", porcentajeGanancia: null };
  const datos = datosNuevaCarga(fila, "1_ABC_WIX.xlsx", "/app/uploads/1_ABC_WIX.xlsx");
  assert.equal(datos.porcentajeGananciaDefault, null);
});
