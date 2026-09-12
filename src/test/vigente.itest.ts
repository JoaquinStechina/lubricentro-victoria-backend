// Primero que nada: apunta DATABASE_URL a la base de test antes de que
// cualquier import construya el PrismaClient.
import "./entorno.js";

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { motivoSkipBase } from "./entorno.js";
import { cerrarBase, limpiarBase } from "./baseDeDatos.js";
import { crearCarga, crearProveedor } from "./factories.js";
import { levantarApi, type ClienteApi } from "./servidor.js";
import { prisma } from "../db.js";

// El versionado del catálogo: al confirmar una carga, la fila previa de cada
// proveedor+marca+SKU se marca vigente=false y se inserta una nueva en true
// (ver publicarCanonicalRows en extraction/processCarga.ts). Es la pieza que
// decide qué precio ve alguien que está vendiendo, y si se rompe no hay
// ningún error visible: simplemente quedan dos precios vigentes del mismo
// producto, o se pierde el histórico. De ahí que sea el primer test de
// integración de la app.

type RespuestaConfirmar = { publicados?: number; error?: string };

describe("vigente: versionado del catalogo al confirmar una carga", { skip: motivoSkipBase }, () => {
  let api: ClienteApi;

  before(async () => {
    api = await levantarApi();
  });
  after(async () => {
    await api.cerrar();
    await cerrarBase();
  });
  beforeEach(limpiarBase);
  afterEach(limpiarBase);

  // Confirma una carga con las filas dadas, como lo hace la pantalla de
  // revisión: mapeo de columnas + filas finales ya editadas.
  async function confirmar(
    proveedorId: number,
    filas: Array<Record<string, unknown>>
  ): Promise<number> {
    const carga = await crearCarga(proveedorId);
    const res = await api.post<RespuestaConfirmar>(`/api/uploads/${carga.id}/confirmar`, {
      mapeo: { Codigo: "sku_proveedor", Marca: "marca", Precio: "precio_neto" },
      filas,
    });
    assert.equal(res.status, 200, `confirmar fallo: ${JSON.stringify(res.body)}`);
    return res.body.publicados ?? 0;
  }

  const fila = (sku: string, precio: number, marca: string | null = "Mann") => ({
    marca,
    sku_proveedor: sku,
    descripcion: "Filtro de aceite",
    precio_neto: precio,
  });

  it("la fila previa del mismo proveedor+marca+SKU deja de ser vigente, pero no se borra", async () => {
    const proveedor = await crearProveedor();

    await confirmar(proveedor.id, [fila("W712", 1000)]);
    await confirmar(proveedor.id, [fila("W712", 1500)]);

    const filas = await prisma.productoPrecio.findMany({
      where: { proveedorId: proveedor.id, skuProveedor: "W712" },
      orderBy: { id: "asc" },
    });

    assert.equal(filas.length, 2, "la fila vieja tiene que seguir existiendo, no pisarse");
    assert.equal(filas[0].precioNeto, 1000);
    assert.equal(filas[0].vigente, false, "la fila vieja deberia quedar vigente=false");
    assert.equal(filas[1].precioNeto, 1500);
    assert.equal(filas[1].vigente, true, "la fila nueva deberia quedar vigente=true");
  });

  it("nunca queda mas de una fila vigente por proveedor+marca+SKU", async () => {
    const proveedor = await crearProveedor();

    for (const precio of [1000, 1500, 1800, 2200]) {
      await confirmar(proveedor.id, [fila("W712", precio)]);
    }

    const vigentes = await prisma.productoPrecio.findMany({
      where: { proveedorId: proveedor.id, skuProveedor: "W712", vigente: true },
    });
    assert.equal(vigentes.length, 1, "quedo mas de un precio vigente para el mismo producto");
    assert.equal(vigentes[0].precioNeto, 2200, "el vigente deberia ser el ultimo confirmado");

    const total = await prisma.productoPrecio.count({
      where: { proveedorId: proveedor.id, skuProveedor: "W712" },
    });
    assert.equal(total, 4, "el historico completo deberia conservarse");
  });

  it("no toca filas de otra marca, otro SKU ni otro proveedor", async () => {
    const proveedor = await crearProveedor();
    const otro = await crearProveedor();

    await confirmar(proveedor.id, [fila("W712", 1000), fila("W920", 900), fila("W712", 800, "WIX")]);
    await confirmar(otro.id, [fila("W712", 1100)]);

    // Segunda carga del primer proveedor: solo Mann/W712 aparece en el batch.
    await confirmar(proveedor.id, [fila("W712", 1200)]);

    const sigueVigente = async (proveedorId: number, marca: string, sku: string, precio: number) => {
      const f = await prisma.productoPrecio.findFirst({
        where: { proveedorId, marca, skuProveedor: sku, precioNeto: precio },
      });
      assert.ok(f, `no se encontro la fila ${marca}/${sku}/${precio}`);
      return f.vigente;
    };

    assert.equal(await sigueVigente(proveedor.id, "Mann", "W920", 900), true, "otro SKU del mismo proveedor no deberia tocarse");
    assert.equal(await sigueVigente(proveedor.id, "WIX", "W712", 800), true, "mismo SKU de otra marca no deberia tocarse");
    assert.equal(await sigueVigente(otro.id, "Mann", "W712", 1100), true, "el mismo producto de otro proveedor no deberia tocarse");
    assert.equal(await sigueVigente(proveedor.id, "Mann", "W712", 1000), false, "la fila superada si deberia quedar en false");
  });

  it("las filas sin SKU quedan siempre vigentes (no hay con que matchearlas)", async () => {
    const proveedor = await crearProveedor();

    await confirmar(proveedor.id, [{ marca: "Mann", descripcion: "Bidon suelto", precio_neto: 500 }]);
    await confirmar(proveedor.id, [{ marca: "Mann", descripcion: "Bidon suelto", precio_neto: 700 }]);

    const sinSku = await prisma.productoPrecio.findMany({
      where: { proveedorId: proveedor.id, skuProveedor: null },
    });
    assert.equal(sinSku.length, 2);
    assert.deepEqual(
      sinSku.map((f) => f.vigente),
      [true, true],
      "documentado en schema.prisma: sin skuProveedor no hay forma confiable de matchear el mismo producto"
    );
  });

  it("supera correctamente lotes de mas de 500 SKUs", async () => {
    // publicarCanonicalRows parte los SKUs en lotes de 500 para el updateMany
    // y las inserciones en lotes de 60. Un off-by-one en ese chunk dejaria
    // filas viejas vigentes sin que nada falle.
    const proveedor = await crearProveedor();
    const skus = Array.from({ length: 600 }, (_, i) => `SKU${i}`);

    await confirmar(proveedor.id, skus.map((sku) => fila(sku, 100)));
    await confirmar(proveedor.id, skus.map((sku) => fila(sku, 200)));

    const vigentes = await prisma.productoPrecio.count({
      where: { proveedorId: proveedor.id, vigente: true },
    });
    const vigentesViejos = await prisma.productoPrecio.count({
      where: { proveedorId: proveedor.id, vigente: true, precioNeto: 100 },
    });

    assert.equal(vigentes, 600, "deberia haber exactamente un vigente por SKU");
    assert.equal(vigentesViejos, 0, "ninguna fila del lote viejo deberia seguir vigente");
  });
});
