-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ofertas" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "proveedorId" INTEGER NOT NULL,
    "marca" TEXT NOT NULL,
    "numeroOferta" INTEGER NOT NULL,
    "skuProveedor" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "desdeCantidad" INTEGER NOT NULL,
    "descuentoPct" REAL NOT NULL,
    "precioUnitario" REAL NOT NULL,
    "moneda" TEXT NOT NULL DEFAULT 'ARS',
    "fechaOferta" TEXT NOT NULL,
    "horaOferta" TEXT NOT NULL,
    "fechaHasta" TEXT,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "eliminado" BOOLEAN NOT NULL DEFAULT false,
    "archivoOrigen" TEXT NOT NULL,
    "rawData" JSONB,
    "cargaId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ofertas_proveedorId_fkey" FOREIGN KEY ("proveedorId") REFERENCES "proveedores" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ofertas_cargaId_fkey" FOREIGN KEY ("cargaId") REFERENCES "cargas" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ofertas" ("activa", "archivoOrigen", "cargaId", "createdAt", "descripcion", "descuentoPct", "desdeCantidad", "fechaHasta", "fechaOferta", "horaOferta", "id", "marca", "moneda", "numeroOferta", "precioUnitario", "proveedorId", "rawData", "skuProveedor") SELECT "activa", "archivoOrigen", "cargaId", "createdAt", "descripcion", "descuentoPct", "desdeCantidad", "fechaHasta", "fechaOferta", "horaOferta", "id", "marca", "moneda", "numeroOferta", "precioUnitario", "proveedorId", "rawData", "skuProveedor" FROM "ofertas";
DROP TABLE "ofertas";
ALTER TABLE "new_ofertas" RENAME TO "ofertas";
CREATE INDEX "ofertas_proveedorId_idx" ON "ofertas"("proveedorId");
CREATE TABLE "new_productos_precios" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "proveedorId" INTEGER NOT NULL,
    "marca" TEXT,
    "skuProveedor" TEXT,
    "skuInterno" TEXT,
    "descripcion" TEXT,
    "seccion" TEXT,
    "precioNeto" REAL,
    "precioConIva" REAL,
    "alicuotaIva" REAL,
    "moneda" TEXT NOT NULL DEFAULT 'ARS',
    "unidad" TEXT,
    "fechaVigencia" TEXT,
    "vigente" BOOLEAN NOT NULL DEFAULT true,
    "eliminado" BOOLEAN NOT NULL DEFAULT false,
    "rawData" JSONB,
    "cargaId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "productos_precios_proveedorId_fkey" FOREIGN KEY ("proveedorId") REFERENCES "proveedores" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "productos_precios_cargaId_fkey" FOREIGN KEY ("cargaId") REFERENCES "cargas" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_productos_precios" ("alicuotaIva", "cargaId", "createdAt", "descripcion", "fechaVigencia", "id", "marca", "moneda", "precioConIva", "precioNeto", "proveedorId", "rawData", "seccion", "skuInterno", "skuProveedor", "unidad", "vigente") SELECT "alicuotaIva", "cargaId", "createdAt", "descripcion", "fechaVigencia", "id", "marca", "moneda", "precioConIva", "precioNeto", "proveedorId", "rawData", "seccion", "skuInterno", "skuProveedor", "unidad", "vigente" FROM "productos_precios";
DROP TABLE "productos_precios";
ALTER TABLE "new_productos_precios" RENAME TO "productos_precios";
CREATE INDEX "productos_precios_proveedorId_idx" ON "productos_precios"("proveedorId");
CREATE INDEX "productos_precios_skuInterno_idx" ON "productos_precios"("skuInterno");
CREATE INDEX "productos_precios_skuProveedor_idx" ON "productos_precios"("skuProveedor");
CREATE INDEX "productos_precios_proveedorId_marca_skuProveedor_idx" ON "productos_precios"("proveedorId", "marca", "skuProveedor");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
