// IMPORTANTE: este módulo tiene que importarse ANTES que cualquier otro que
// toque Prisma. En ESM los imports se evalúan en orden, así que un
// `import "./entorno.js"` en la primera línea del test garantiza que
// DATABASE_URL ya apunte a la base de test cuando db.ts construya el
// PrismaClient. Si se importa después, los tests escriben en la base de
// desarrollo.
import "dotenv/config";

if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

// Nombre de la base al que apunta una URL de conexión MySQL, o null si no se
// puede determinar.
export function nombreDeBase(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const pathname = new URL(url).pathname.replace(/^\//, "");
    return pathname ? decodeURIComponent(pathname) : null;
  } catch {
    return null;
  }
}

// Única condición bajo la cual se permite borrar datos: el nombre de la base
// dice "test". No alcanza con que TEST_DATABASE_URL esté seteada — si alguien
// la apunta por error a la base real, esto lo frena.
export function esBaseDeTest(url: string | undefined): boolean {
  const nombre = nombreDeBase(url);
  return nombre !== null && /test/i.test(nombre);
}

// Motivo de skip para las suites de integración, o undefined si se pueden
// correr. Se expone como string para que node:test lo muestre en la salida en
// vez de saltear en silencio.
export const motivoSkipBase: string | undefined = process.env.TEST_DATABASE_URL
  ? esBaseDeTest(process.env.TEST_DATABASE_URL)
    ? undefined
    : `TEST_DATABASE_URL apunta a "${nombreDeBase(process.env.TEST_DATABASE_URL)}", que no parece una base de test (el nombre tiene que contener "test")`
  : "TEST_DATABASE_URL no configurada — ver backend/README.md, seccion Tests";
