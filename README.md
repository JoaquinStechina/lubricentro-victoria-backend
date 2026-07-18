# Backend — Lubricentro Victoria

Backend nuevo, separado del frontend Next.js. Implementa el pipeline completo
descripto en `../contexto.md`: recepción de archivos, extracción (determinística
para xlsx/xls, con un LLM vía OpenRouter para pdf/png), mapeo de columnas al
schema canónico (reusando el aprobado por proveedor o pidiéndole una
sugerencia a un LLM si es nuevo, con aprobación humana antes de publicar) y
persistencia con estado real.

## Stack

- **TypeScript** + [Express](https://expressjs.com)
- **Prisma** como ORM, con **SQLite** ahora (prototipo, sin infraestructura extra,
  igual que recomienda `contexto.md`) y **MySQL** como base de datos de producción
  a futuro.
- **[OpenRouter](https://openrouter.ai)** (vía el SDK oficial de
  [`openai`](https://www.npmjs.com/package/openai), que OpenRouter acepta tal
  cual por ser compatible con su API) para extracción con visión (pdf/png),
  para sugerir el mapeo de columnas de proveedores nuevos, y como último
  recurso para ubicar la fila de header en hojas de excel con formato
  atípico que la heurística determinística no reconoce (ver
  `excelLlmFallback.ts`). Los modelos usados son configurables por env
  (`OPENROUTER_VISION_MODEL` / `OPENROUTER_MAPPING_MODEL`, este último
  también usado para el fallback de excel), así que cambiar de
  proveedor/modelo no requiere tocar código — ver
  [openrouter.ai/models](https://openrouter.ai/models).
- **[xlsx](https://sheetjs.com)** (instalado desde el CDN oficial de SheetJS,
  no desde npm — la versión publicada en el registro de npm, `0.18.5`, tiene
  CVEs sin parchear; SheetJS solo distribuye las versiones arregladas por su
  cuenta) para parsear xlsx/xls.

### Migrar de SQLite a MySQL

El schema (`prisma/schema.prisma`) usa únicamente tipos compatibles con ambos
motores. Para pasar a producción:

1. Levantar una instancia MySQL y armar su `DATABASE_URL`
   (`mysql://user:pass@host:3306/db`).
2. En `schema.prisma`, cambiar `provider = "sqlite"` por `provider = "mysql"`.
3. Correr `npm run prisma:migrate` de nuevo para generar la migración
   equivalente en MySQL.

No hace falta tocar el resto del código (rutas, `db.ts`) — Prisma Client
abstrae el motor.

## Setup

```bash
cp .env.example .env   # completar OPENROUTER_API_KEY para pdf/png y proveedores nuevos
npm install
npm run prisma:migrate   # crea dev.db y las tablas
npm run seed              # importa productos_todos.json / ofertas.json existentes
npm run dev                # http://localhost:4000
```

Sin `OPENROUTER_API_KEY`, todo lo que no necesita IA funciona igual (subir
archivos, parsear xlsx/xls, aplicar un mapeo ya aprobado). Lo que sí la
necesita (extraer pdf/png, sugerir mapeo de un proveedor nuevo) falla con un
error claro (`Falta OPENROUTER_API_KEY...`) en vez de romper el proceso.

## Modelo de datos

- `Proveedor` — un proveedor puede vender varias marcas.
- `ProductoPrecio` / `Oferta` — el schema canónico de `contexto.md`. Nunca se
  hace `UPDATE` destructivo de precios: cada carga nueva inserta filas con su
  propia `fechaVigencia`.
- `MapeoColumna` — mapeo columna origen → campo canónico, por proveedor.
  Se guarda una vez que un humano aprueba el mapeo sugerido y se reusa en
  cargas siguientes del mismo proveedor.
- `Carga` — una fila por archivo subido. Estados: `pendiente` → `procesando`
  → `completado` | `error` | `revision_pendiente` (esperando que se apruebe
  el mapeo sugerido).

## Endpoints

- `GET /api/health`
- `POST /api/uploads` — multipart, campo `file` (xlsx/xls/pdf/png/jpg) y
  opcionalmente `proveedor` (nombre). Guarda el archivo en `uploads/` y crea
  una `Carga` en estado `pendiente`.
- `POST /api/uploads/:id/procesar` — extrae la tabla del archivo y:
  - si el proveedor ya tiene un mapeo de columnas aprobado que coincide con
    los headers detectados → publica los productos directo, `completado`.
  - si es un proveedor nuevo (o le cambiaron los headers) → le pide al LLM
    una sugerencia de mapeo y la deja en `revision_pendiente` (nunca se
    aplica un mapeo sin aprobación humana).
- `POST /api/uploads/:id/aprobar-mapeo` — body
  `{"mapeo": {"<columna origen>": "<campo_canonico>", ...}}`. Guarda el
  mapeo (aprobado o corregido a mano) en `MapeoColumna` para reusarlo en
  próximas cargas del mismo proveedor, y publica los productos de esta carga.
- `GET /api/uploads` / `GET /api/uploads/:id` — estado de las cargas,
  incluyendo `filasExtraidas`/`mapeoSugerido` cuando está en revisión.
- `GET /api/stats` — conteo de proveedores/productos/ofertas/cargas.

## Extracción (`src/extraction/`)

- `excel.ts` — heurística determinística (sin IA) como primer intento, más
  un fallback a IA para hojas que no matchean ninguna señal. La heurística
  porta la lógica descripta en `contexto.md`: detecta la fila de header por
  señal de precio/moneda ("precio", "importe", "tarifa", "valor", "monto",
  "costo", "$", "u$s", "usd"), excluye banners, entre candidatas prefiere la
  de menos celdas numéricas (contempla tanto celdas `number` como texto con
  formato de moneda, ej. `"$ 1.234,56"`); detecta filas de sección (poco
  contenido, sin precio) y las propaga como `seccion` a las filas
  siguientes. Probado contra los dos archivos reales de `contexto.md`: el
  limpio de ABC (22.623 filas, calzan exacto) y el desprolijo de BOR&UR con
  43 hojas (~9.000 filas; la heurística es imperfecta a propósito — algunas
  hojas atípicas, como una de índice/notas sin tabla real, pueden colarse
  como "hoja" con pocas filas de ruido; eso cae en `raw_data` o se descarta
  en la revisión del mapeo, no corrompe datos reales).
  `extractExcel()` expone solo esta heurística (100% determinística, sin
  llamar a ningún LLM — útil para tests o para no depender de IA). La
  heurística asume que el proveedor nombra la columna de precio de alguna
  forma reconocible; un proveedor nuevo con headers totalmente atípicos
  (sin ninguna de esas palabras ni símbolo de moneda) no matchea ninguna
  señal, y ahí es donde entra `excelLlmFallback.ts`.
- `excelLlmFallback.ts` — último recurso cuando la heurística de `excel.ts`
  no encuentra ninguna fila de header en una hoja: le pide al LLM (vía
  OpenRouter, mismo modelo que `mapping.ts` — `OPENROUTER_MAPPING_MODEL`)
  solo que ubique el **índice** de la fila de header a partir de las
  primeras ~40 filas de la hoja, no que transcriba los datos — eso lo sigue
  haciendo el parser determinístico de `excel.ts`
  (`buildTableFromHeaderIndex`), que ya está probado. `extractExcelWithFallback()`
  (usado por `processCarga.ts`) prueba primero la heurística por hoja y
  solo cae a este fallback en las hojas donde falló; si el LLM tampoco
  encuentra una tabla reconocible, esa hoja se descarta igual que antes.
- `vision.ts` — pdf/png vía OpenRouter (bloque `file` con data URI para pdf,
  usando el plugin `file-parser` de OpenRouter con engine `pdf-text`;
  `image_url` con data URI para png/jpg), le pide un JSON `{headers, rows}`.
  Para PDFs escaneados (imagen pura, sin texto real) conviene cambiar el
  engine del plugin a `mistral-ocr` en `vision.ts`. **No probado en vivo en
  este entorno** (no hay `OPENROUTER_API_KEY` configurada acá) — sí
  typechecked contra el SDK real.
- `mapping.ts` — reusa `MapeoColumna` si cubre alguna columna detectada;
  si no, le pide al LLM una sugerencia (columna origen → campo canónico o
  `null`), que **no se aplica sola**, queda para aprobación humana.
  `applyMapping` convierte filas crudas al schema canónico, con parseo
  tolerante de precios (`"$ 1.985,78"` → `1985.78`) y columnas no mapeadas
  van a `raw_data`.
- `processCarga.ts` — orquesta todo lo anterior. Si el paso de mapeo falla
  (ej. sin API key), las filas ya extraídas quedan guardadas en la `Carga`
  para no tener que re-parsear el archivo en el reintento.

## Pendiente

- UI en el frontend para: disparar el procesamiento de una carga, revisar y
  editar el mapeo sugerido, aprobar. Hoy todo esto es solo API.
- Cola/worker en vez de procesar sincrónicamente en el request — para
  archivos grandes o con muchas páginas de PDF, `POST /:id/procesar` puede
  tardar.
- Detectar si un archivo es de ofertas (descuentos por SKU) en vez de lista
  de precios y mapear contra `Oferta` en vez de `ProductoPrecio` — hoy el
  pipeline de extracción solo publica en `ProductoPrecio`.
