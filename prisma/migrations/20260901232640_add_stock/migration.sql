-- CreateTable
CREATE TABLE `articulos_stock` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `marca` VARCHAR(191) NOT NULL,
    `codigo` VARCHAR(191) NOT NULL,
    `codigoNorm` VARCHAR(191) NOT NULL,
    `descripcion` TEXT NOT NULL,
    `categoria` VARCHAR(191) NULL,
    `ubicacion` VARCHAR(191) NULL,
    `cantidad` INTEGER NOT NULL DEFAULT 0,
    `minimo` INTEGER NULL,
    `eliminado` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `articulos_stock_codigoNorm_idx`(`codigoNorm`),
    INDEX `articulos_stock_categoria_idx`(`categoria`),
    UNIQUE INDEX `articulos_stock_marca_codigo_key`(`marca`, `codigo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `movimientos_stock` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `articuloId` INTEGER NOT NULL,
    `tipo` VARCHAR(191) NOT NULL,
    `delta` INTEGER NOT NULL,
    `cantidadResultante` INTEGER NOT NULL,
    `motivo` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `movimientos_stock_articuloId_idx`(`articuloId`),
    INDEX `movimientos_stock_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `movimientos_stock` ADD CONSTRAINT `movimientos_stock_articuloId_fkey` FOREIGN KEY (`articuloId`) REFERENCES `articulos_stock`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
