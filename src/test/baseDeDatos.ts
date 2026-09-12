import { prisma } from "../db.js";
import { esBaseDeTest, nombreDeBase } from "./entorno.js";

// Todas las tablas de la app, en cualquier orden: el truncate corre con las
// FK desactivadas. Si se agrega un modelo al schema hay que agregarlo acá o
// los tests van a arrastrar datos entre archivos.
const TABLAS = [
  "movimientos_stock",
  "articulos_stock",
  "productos_precios",
  "ofertas",
  "cargas",
  "mapeos_columna",
  "auto_descargas_marca",
  "proveedores",
] as const;

// Deja la base vacía. Se llama en el beforeEach de cada suite de integración:
// es más barato y mucho más predecible que envolver cada test en una
// transacción con rollback (que no sobreviviría a las transacciones propias
// del código bajo test, ej. publicarCanonicalRows).
export async function limpiarBase(): Promise<void> {
  // Segundo cerrojo, además del de entorno.ts: se chequea la URL efectiva en
  // el momento de borrar, no al importar el módulo.
  const url = process.env.DATABASE_URL;
  if (!esBaseDeTest(url)) {
    throw new Error(
      `limpiarBase() abortado: DATABASE_URL apunta a "${nombreDeBase(url) ?? "(desconocida)"}". ` +
        `Solo se permite truncar bases cuyo nombre contenga "test".`
    );
  }

  await prisma.$executeRawUnsafe("SET FOREIGN_KEY_CHECKS = 0");
  try {
    for (const tabla of TABLAS) {
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE \`${tabla}\``);
    }
  } finally {
    await prisma.$executeRawUnsafe("SET FOREIGN_KEY_CHECKS = 1");
  }
}

export async function cerrarBase(): Promise<void> {
  await prisma.$disconnect();
}
