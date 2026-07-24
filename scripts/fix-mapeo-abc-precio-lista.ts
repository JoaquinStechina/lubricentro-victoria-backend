// Corrige un posible mapeo incorrecto de "PRECIO LISTA C/IVA" en el mapeo ya
// aprobado del proveedor ABC. Esa columna nunca debe mapear a ningún campo
// canónico (precio_lista_con_iva no es un CanonicalField seleccionable, se
// calcula siempre a partir de precio_lista + IVA — ver
// backend/src/extraction/types.ts). El riesgo es que en algún momento un
// humano la haya mapeado por error, por parecido de nombre con "PRECIO NETO
// CON IVA" (que sí debe mapear a precio_con_iva). Si eso pasó, el mapeo
// guardado lo arrastraría a todas las cargas futuras de ABC. Idempotente:
// no hace nada si no encuentra nada que corregir. Correr con:
// npx tsx scripts/fix-mapeo-abc-precio-lista.ts

import "dotenv/config";
import { prisma } from "../src/db.js";

async function main() {
  const proveedor = await prisma.proveedor.findUnique({ where: { nombre: "ABC" } });
  if (!proveedor) {
    console.log("No existe proveedor 'ABC' todavía — nada que corregir.");
    return;
  }

  const encontrados = await prisma.mapeoColumna.findMany({
    where: { proveedorId: proveedor.id, columnaOrigen: "PRECIO LISTA C/IVA" },
  });

  if (encontrados.length === 0) {
    console.log('No hay ningún mapeo guardado para "PRECIO LISTA C/IVA" en ABC — nada que corregir.');
    return;
  }

  for (const m of encontrados) {
    console.log(`Borrando mapeo: "PRECIO LISTA C/IVA" -> "${m.campoDestino}" (tipoDatos=${m.tipoDatos})`);
  }
  const { count } = await prisma.mapeoColumna.deleteMany({
    where: { proveedorId: proveedor.id, columnaOrigen: "PRECIO LISTA C/IVA" },
  });
  console.log(`Listo: ${count} mapeo(s) corregido(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
