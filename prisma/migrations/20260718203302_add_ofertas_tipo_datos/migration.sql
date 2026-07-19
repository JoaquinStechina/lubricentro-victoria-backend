-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_cargas" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "proveedorId" INTEGER,
    "nombreArchivo" TEXT NOT NULL,
    "rutaArchivo" TEXT NOT NULL,
    "tipoArchivo" TEXT NOT NULL,
    "tipoDatos" TEXT NOT NULL DEFAULT 'catalogo',
    "estado" TEXT NOT NULL DEFAULT 'pendiente',
    "mensajeError" TEXT,
    "filasExtraidas" JSONB,
    "mapeoSugerido" JSONB,
    "metadataOferta" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "cargas_proveedorId_fkey" FOREIGN KEY ("proveedorId") REFERENCES "proveedores" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_cargas" ("createdAt", "estado", "filasExtraidas", "id", "mapeoSugerido", "mensajeError", "nombreArchivo", "proveedorId", "rutaArchivo", "tipoArchivo", "updatedAt") SELECT "createdAt", "estado", "filasExtraidas", "id", "mapeoSugerido", "mensajeError", "nombreArchivo", "proveedorId", "rutaArchivo", "tipoArchivo", "updatedAt" FROM "cargas";
DROP TABLE "cargas";
ALTER TABLE "new_cargas" RENAME TO "cargas";
CREATE TABLE "new_mapeos_columna" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "proveedorId" INTEGER NOT NULL,
    "columnaOrigen" TEXT NOT NULL,
    "campoDestino" TEXT NOT NULL,
    "tipoDatos" TEXT NOT NULL DEFAULT 'catalogo',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mapeos_columna_proveedorId_fkey" FOREIGN KEY ("proveedorId") REFERENCES "proveedores" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_mapeos_columna" ("campoDestino", "columnaOrigen", "createdAt", "id", "proveedorId") SELECT "campoDestino", "columnaOrigen", "createdAt", "id", "proveedorId" FROM "mapeos_columna";
DROP TABLE "mapeos_columna";
ALTER TABLE "new_mapeos_columna" RENAME TO "mapeos_columna";
CREATE UNIQUE INDEX "mapeos_columna_proveedorId_columnaOrigen_tipoDatos_key" ON "mapeos_columna"("proveedorId", "columnaOrigen", "tipoDatos");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
