-- DropForeignKey
ALTER TABLE `mapeos_columna` DROP FOREIGN KEY `mapeos_columna_proveedorId_fkey`;

-- DropIndex
DROP INDEX `mapeos_columna_proveedorId_columnaOrigen_tipoDatos_key` ON `mapeos_columna`;

-- AlterTable
ALTER TABLE `proveedores` ADD COLUMN `alicuotaIvaDefault` DOUBLE NULL,
    ADD COLUMN `mecanismoAutoDescarga` VARCHAR(191) NULL,
    ADD COLUMN `urlDescargaAutomatica` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `cargas` ADD COLUMN `origen` VARCHAR(191) NOT NULL DEFAULT 'manual';

-- CreateIndex
CREATE UNIQUE INDEX `mapeos_columna_proveedorId_columnaOrigen_campoDestino_tipoDa_key` ON `mapeos_columna`(`proveedorId`, `columnaOrigen`, `campoDestino`, `tipoDatos`);

-- AddForeignKey
ALTER TABLE `mapeos_columna` ADD CONSTRAINT `mapeos_columna_proveedorId_fkey` FOREIGN KEY (`proveedorId`) REFERENCES `proveedores`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
