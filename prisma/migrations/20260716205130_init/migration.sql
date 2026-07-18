-- CreateTable
CREATE TABLE "proveedores" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "nombre" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "productos_precios" (
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
    "rawData" JSONB,
    "cargaId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "productos_precios_proveedorId_fkey" FOREIGN KEY ("proveedorId") REFERENCES "proveedores" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "productos_precios_cargaId_fkey" FOREIGN KEY ("cargaId") REFERENCES "cargas" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ofertas" (
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
    "archivoOrigen" TEXT NOT NULL,
    "rawData" JSONB,
    "cargaId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ofertas_proveedorId_fkey" FOREIGN KEY ("proveedorId") REFERENCES "proveedores" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ofertas_cargaId_fkey" FOREIGN KEY ("cargaId") REFERENCES "cargas" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "mapeos_columna" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "proveedorId" INTEGER NOT NULL,
    "columnaOrigen" TEXT NOT NULL,
    "campoDestino" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mapeos_columna_proveedorId_fkey" FOREIGN KEY ("proveedorId") REFERENCES "proveedores" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "cargas" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "proveedorId" INTEGER,
    "nombreArchivo" TEXT NOT NULL,
    "rutaArchivo" TEXT NOT NULL,
    "tipoArchivo" TEXT NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'pendiente',
    "mensajeError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "cargas_proveedorId_fkey" FOREIGN KEY ("proveedorId") REFERENCES "proveedores" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "proveedores_nombre_key" ON "proveedores"("nombre");

-- CreateIndex
CREATE INDEX "productos_precios_proveedorId_idx" ON "productos_precios"("proveedorId");

-- CreateIndex
CREATE INDEX "productos_precios_skuInterno_idx" ON "productos_precios"("skuInterno");

-- CreateIndex
CREATE INDEX "productos_precios_skuProveedor_idx" ON "productos_precios"("skuProveedor");

-- CreateIndex
CREATE INDEX "ofertas_proveedorId_idx" ON "ofertas"("proveedorId");

-- CreateIndex
CREATE UNIQUE INDEX "mapeos_columna_proveedorId_columnaOrigen_key" ON "mapeos_columna"("proveedorId", "columnaOrigen");
