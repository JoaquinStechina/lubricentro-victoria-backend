// Crea/migra la base de test apuntada por TEST_DATABASE_URL. Existe como
// script de Node en vez de un `DATABASE_URL=... prisma migrate deploy` en
// package.json porque esa sintaxis de variable inline no funciona en Windows.
import "../src/test/entorno.js"; // apunta DATABASE_URL a la base de test
import { execFileSync } from "node:child_process";
import { esBaseDeTest, nombreDeBase } from "../src/test/entorno.js";

if (!process.env.TEST_DATABASE_URL) {
  console.error(
    "TEST_DATABASE_URL no esta configurada.\n" +
      "Agregala a backend/.env, por ejemplo:\n" +
      '  TEST_DATABASE_URL="mysql://root:PASS@localhost:3306/lubricentro_victoria_test"'
  );
  process.exit(1);
}

if (!esBaseDeTest(process.env.TEST_DATABASE_URL)) {
  console.error(
    `TEST_DATABASE_URL apunta a "${nombreDeBase(process.env.TEST_DATABASE_URL)}".\n` +
      'El nombre de la base tiene que contener "test": los tests la truncan entera.'
  );
  process.exit(1);
}

console.log(`Migrando ${nombreDeBase(process.env.TEST_DATABASE_URL)}...`);
execFileSync("npx", ["prisma", "migrate", "deploy"], { stdio: "inherit", shell: true });
