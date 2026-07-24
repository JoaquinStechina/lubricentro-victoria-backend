-- AlterTable
ALTER TABLE `cargas` ADD COLUMN `porcentajeGananciaDefault` DOUBLE NULL;

-- CreateTable
CREATE TABLE `auto_descargas_marca` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `proveedorId` INTEGER NOT NULL,
    `marca` VARCHAR(191) NOT NULL,
    `activo` BOOLEAN NOT NULL DEFAULT true,
    `porcentajeGanancia` DOUBLE NULL,
    `ultimoHashArchivo` VARCHAR(191) NULL,
    `ultimaCorridaEn` DATETIME(3) NULL,
    `ultimoResultado` VARCHAR(191) NULL,
    `ultimaCargaId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `auto_descargas_marca_proveedorId_marca_key`(`proveedorId`, `marca`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `auto_descargas_marca` ADD CONSTRAINT `auto_descargas_marca_proveedorId_fkey` FOREIGN KEY (`proveedorId`) REFERENCES `proveedores`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
