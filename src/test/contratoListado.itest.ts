import "./entorno.js";

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { motivoSkipBase } from "./entorno.js";
import { cerrarBase, limpiarBase } from "./baseDeDatos.js";
import { crearArticuloStock, crearCarga, crearOferta, crearProductoPrecio, crearProveedor } from "./factories.js";
import { levantarApi, type ClienteApi } from "./servidor.js";
import { verificarContratoDeListado } from "./contratoListado.js";

// Los cinco endpoints de listado comparten forma de respuesta y semántica de
// paginación. En vez de repetir los mismos asserts cinco veces, cada uno
// siembra sus datos y delega en el helper compartido.
//
// Al agregar un endpoint de listado nuevo, agregar acá su it() con el seed
// que necesite: hereda toda la verificación de paginación sin escribir un
// solo assert.

describe("contrato compartido de los endpoints de listado", { skip: motivoSkipBase }, () => {
  let api: ClienteApi;

  before(async () => {
    api = await levantarApi();
    await limpiarBase();

    const proveedor = await crearProveedor();

    for (let i = 0; i < 4; i++) await crearCarga(proveedor.id);
    for (let i = 0; i < 4; i++) await crearProductoPrecio(proveedor.id);
    for (let i = 0; i < 4; i++) await crearOferta(proveedor.id);

    const articulos = [];
    for (let i = 0; i < 4; i++) articulos.push(await crearArticuloStock());
    for (const articulo of articulos) {
      const res = await api.post(`/api/stock/${articulo.id}/movimientos`, {
        tipo: "entrada",
        cantidad: 5,
        motivo: "seed de test",
      });
      assert.equal(res.status, 201, `no se pudo sembrar el movimiento: ${JSON.stringify(res.body)}`);
    }
  });

  after(async () => {
    await limpiarBase();
    await api.cerrar();
    await cerrarBase();
  });

  it("GET /api/uploads", async () => {
    await verificarContratoDeListado(api, "/api/uploads");
  });

  it("GET /api/productos", async () => {
    await verificarContratoDeListado(api, "/api/productos");
  });

  it("GET /api/ofertas", async () => {
    await verificarContratoDeListado(api, "/api/ofertas");
  });

  it("GET /api/stock", async () => {
    await verificarContratoDeListado(api, "/api/stock");
  });

  it("GET /api/stock/movimientos", async () => {
    await verificarContratoDeListado(api, "/api/stock/movimientos");
  });
});
