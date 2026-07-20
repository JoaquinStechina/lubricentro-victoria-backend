-- CreateTable
CREATE TABLE `usuarios` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `email` VARCHAR(191) NOT NULL,
    `passwordHash` VARCHAR(191) NOT NULL,
    `nombre` VARCHAR(191) NOT NULL,
    `rol` ENUM('SYSADMIN', 'ADMINISTRADOR', 'EMPLEADO') NOT NULL,
    `activo` BOOLEAN NOT NULL DEFAULT true,
    `creadoPorId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `usuarios_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `proveedores` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `nombre` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `proveedores_nombre_key`(`nombre`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `productos_precios` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `proveedorId` INTEGER NOT NULL,
    `marca` VARCHAR(191) NULL,
    `skuProveedor` VARCHAR(191) NULL,
    `skuInterno` VARCHAR(191) NULL,
    `descripcion` TEXT NULL,
    `seccion` VARCHAR(191) NULL,
    `precioNeto` DOUBLE NULL,
    `precioConIva` DOUBLE NULL,
    `alicuotaIva` DOUBLE NULL,
    `moneda` VARCHAR(191) NOT NULL DEFAULT 'ARS',
    `unidad` VARCHAR(191) NULL,
    `fechaVigencia` VARCHAR(191) NULL,
    `vigente` BOOLEAN NOT NULL DEFAULT true,
    `eliminado` BOOLEAN NOT NULL DEFAULT false,
    `rawData` JSON NULL,
    `cargaId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `productos_precios_proveedorId_idx`(`proveedorId`),
    INDEX `productos_precios_skuInterno_idx`(`skuInterno`),
    INDEX `productos_precios_skuProveedor_idx`(`skuProveedor`),
    INDEX `productos_precios_proveedorId_marca_skuProveedor_idx`(`proveedorId`, `marca`, `skuProveedor`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ofertas` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `proveedorId` INTEGER NOT NULL,
    `marca` VARCHAR(191) NOT NULL,
    `numeroOferta` INTEGER NOT NULL,
    `skuProveedor` VARCHAR(191) NOT NULL,
    `descripcion` TEXT NOT NULL,
    `desdeCantidad` INTEGER NOT NULL,
    `descuentoPct` DOUBLE NOT NULL,
    `precioUnitario` DOUBLE NOT NULL,
    `moneda` VARCHAR(191) NOT NULL DEFAULT 'ARS',
    `fechaOferta` VARCHAR(191) NOT NULL,
    `horaOferta` VARCHAR(191) NOT NULL,
    `fechaHasta` VARCHAR(191) NULL,
    `activa` BOOLEAN NOT NULL DEFAULT true,
    `eliminado` BOOLEAN NOT NULL DEFAULT false,
    `archivoOrigen` VARCHAR(191) NOT NULL,
    `rawData` JSON NULL,
    `cargaId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ofertas_proveedorId_idx`(`proveedorId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `mapeos_columna` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `proveedorId` INTEGER NOT NULL,
    `columnaOrigen` VARCHAR(191) NOT NULL,
    `campoDestino` VARCHAR(191) NOT NULL,
    `tipoDatos` VARCHAR(191) NOT NULL DEFAULT 'catalogo',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `mapeos_columna_proveedorId_columnaOrigen_tipoDatos_key`(`proveedorId`, `columnaOrigen`, `tipoDatos`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cargas` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `proveedorId` INTEGER NULL,
    `nombreArchivo` VARCHAR(191) NOT NULL,
    `rutaArchivo` VARCHAR(191) NOT NULL,
    `tipoArchivo` VARCHAR(191) NOT NULL,
    `tipoDatos` VARCHAR(191) NOT NULL DEFAULT 'catalogo',
    `estado` VARCHAR(191) NOT NULL DEFAULT 'pendiente',
    `mensajeError` TEXT NULL,
    `filasExtraidas` JSON NULL,
    `mapeoSugerido` JSON NULL,
    `metadataOferta` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `usuarios` ADD CONSTRAINT `usuarios_creadoPorId_fkey` FOREIGN KEY (`creadoPorId`) REFERENCES `usuarios`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `productos_precios` ADD CONSTRAINT `productos_precios_proveedorId_fkey` FOREIGN KEY (`proveedorId`) REFERENCES `proveedores`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `productos_precios` ADD CONSTRAINT `productos_precios_cargaId_fkey` FOREIGN KEY (`cargaId`) REFERENCES `cargas`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ofertas` ADD CONSTRAINT `ofertas_proveedorId_fkey` FOREIGN KEY (`proveedorId`) REFERENCES `proveedores`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ofertas` ADD CONSTRAINT `ofertas_cargaId_fkey` FOREIGN KEY (`cargaId`) REFERENCES `cargas`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `mapeos_columna` ADD CONSTRAINT `mapeos_columna_proveedorId_fkey` FOREIGN KEY (`proveedorId`) REFERENCES `proveedores`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cargas` ADD CONSTRAINT `cargas_proveedorId_fkey` FOREIGN KEY (`proveedorId`) REFERENCES `proveedores`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
