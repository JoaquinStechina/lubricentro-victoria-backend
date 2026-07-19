// Crea (o actualiza) la primera cuenta SYSADMIN. Es la única forma de dar de
// alta el primer usuario: el resto de las cuentas (administrador/empleado)
// se crean desde /usuarios una vez logueado como sysadmin. Correr con:
// npm run seed:sysadmin

import "dotenv/config";
import bcrypt from "bcryptjs";
import { prisma } from "../src/db.js";

async function main() {
  const email = process.env.SYSADMIN_EMAIL;
  const password = process.env.SYSADMIN_PASSWORD;
  const nombre = process.env.SYSADMIN_NOMBRE ?? "Sysadmin";

  if (!email || !password) {
    console.error(
      "Faltan SYSADMIN_EMAIL y/o SYSADMIN_PASSWORD en el entorno (ver backend/.env.example)."
    );
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("SYSADMIN_PASSWORD debe tener al menos 8 caracteres.");
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const usuario = await prisma.usuario.upsert({
    where: { email },
    update: { passwordHash, nombre, rol: "SYSADMIN", activo: true },
    create: { email, passwordHash, nombre, rol: "SYSADMIN" },
  });

  console.log(`Sysadmin listo: ${usuario.email} (id ${usuario.id})`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
