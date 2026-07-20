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
cp .env.example .env   # completar OPENROUTER_API_KEY, JWT_SECRET y SYSADMIN_* (ver Autenticación y roles)
npm install
npm run prisma:migrate   # crea dev.db y las tablas
npm run seed              # importa productos_todos.json / ofertas.json existentes
npm run seed:sysadmin     # crea la primera cuenta SYSADMIN (lee SYSADMIN_EMAIL/PASSWORD/NOMBRE)
npm run dev                # http://localhost:4000
```

Sin `OPENROUTER_API_KEY`, todo lo que no necesita IA funciona igual (subir
archivos, parsear xlsx/xls, aplicar un mapeo ya aprobado). Lo que sí la
necesita (extraer pdf/png, sugerir mapeo de un proveedor nuevo) falla con un
error claro (`Falta OPENROUTER_API_KEY...`) en vez de romper el proceso.

```bash
npm test   # corre src/**/*.test.ts (node:test, sin dependencias extra)
```

## Modelo de datos

- `Usuario` — cuentas internas del sistema (`email` único, `passwordHash` con
  bcrypt, `rol`: `SYSADMIN` | `ADMINISTRADOR` | `EMPLEADO`, `activo`). No
  tiene relación con `Proveedor`/`ProductoPrecio`/etc — es el modelo de auth,
  aparte del pipeline de datos. `creadoPorId` referencia al `Usuario` que dio
  de alta la cuenta (autoreferencia, nullable — el primer `SYSADMIN` lo crea
  `scripts/seed-sysadmin.ts`, no tiene creador). Ver "Autenticación y roles".
- `Proveedor` — un proveedor puede vender varias marcas.
- `ProductoPrecio` / `Oferta` — el schema canónico de `contexto.md`. Nunca se
  hace `UPDATE` destructivo de precios: cada carga nueva inserta filas con su
  propia `fechaVigencia` (`ProductoPrecio`) o `fechaOferta`/`horaOferta`
  (`Oferta`). A diferencia de `ProductoPrecio` (todos los campos nullable),
  `Oferta` exige `marca`/`numeroOferta`/`skuProveedor`/`descripcion`/
  `desdeCantidad`/`descuentoPct`/`precioUnitario`/`fechaOferta`/`horaOferta`
  no nulos — se valida antes de publicar (ver `processCarga.ts`).
  - `ProductoPrecio.vigente` (`Boolean`, default `true`): marca cuál es la
    fila más reciente por proveedor+marca+SKU. Al confirmar una carga nueva,
    la fila anterior de ese mismo proveedor+marca+SKU se marca `false` (ver
    `publicarCanonicalRows` en `processCarga.ts`) — nunca se borra ni se
    pisa. Filas sin `skuProveedor` no tienen forma confiable de matchear "el
    mismo producto" y quedan siempre en `true`. Consumido por
    `GET /api/productos` (ver Endpoints).
  - `Oferta.fechaHasta` (`String?`, formato `YYYY-MM-DD`) y `Oferta.activa`
    (`Boolean`, default `true`): la mayoría de las ofertas son "hasta agotar
    stock" (sin fecha de fin conocida) y se cierran a mano
    (`POST /api/ofertas/cerrar`); algunas tienen fecha fija, en cuyo caso
    `fechaHasta` alcanza para que dejen de listarse solas sin necesitar un
    cron/worker (comparación de texto en formato ISO, no hay parseo de
    fechas real en este schema). `activa` nunca lo toca el pipeline de
    extracción/mapeo, solo el endpoint de cierre/reactivación.
- `MapeoColumna` — mapeo columna origen → campo canónico, por proveedor y
  por `tipoDatos` (`"catalogo"` | `"oferta"`, ver `Carga` abajo): un mismo
  proveedor puede tener una columna "SKU" mapeada distinto en su catálogo y
  en sus ofertas. Se guarda una vez que un humano aprueba el mapeo sugerido
  y se reusa en cargas siguientes del mismo proveedor y tipo.
- `Carga` — una fila por archivo subido. `tipoDatos` (`"catalogo"` default |
  `"oferta"`) decide si publica en `ProductoPrecio` o en `Oferta` — no
  confundir con `tipoArchivo` (xlsx/pdf/png, el *formato*). Para ofertas,
  `metadataOferta` guarda marca/n° de oferta/fecha/hora detectados por IA
  del banner o nombre de archivo (ver `ofertaMetadata.ts`), editables en la
  pantalla de revisión antes de confirmar. Estados: `pendiente` →
  `procesando` → `revision_pendiente` (proveedor nuevo o headers distintos,
  mapeo sugerido por IA sin aprobar) | `confirmacion_pendiente` (proveedor
  ya conocido, mapeo aprobado de antes, solo falta confirmar los valores) →
  `completado` | `error`. **Ninguna carga se publica sola** — `procesarCarga`
  nunca llega a `completado` por sí misma, siempre hace falta la
  confirmación humana de `POST /:id/confirmar` (ver Endpoints).

## Autenticación y roles

Toda la API (salvo `/api/health` y `/api/auth/login`) requiere sesión. La
sesión es un JWT firmado (`JWT_SECRET`, mismo valor que en
`lubricentro-victoria-front/.env.local`) guardado en una cookie httpOnly
(`session`) que emite `POST /api/auth/login`. El frontend la manda
automáticamente porque `apiFetch` usa `credentials: "include"` — no hay
tokens en `localStorage` ni headers manuales.

`src/middleware/auth.ts` expone dos middlewares:

- `requireAuth` — verifica la cookie y adjunta `req.user` (`{sub, email,
  nombre, rol}`). Montado globalmente en `server.ts` sobre todos los routers
  salvo `authRouter`.
- `requireRole(minRol)` — exige un rol mínimo con jerarquía acumulativa
  `EMPLEADO < ADMINISTRADOR < SYSADMIN` (un `SYSADMIN` pasa cualquier chequeo
  de rol). Se monta por router o por ruta puntual.

Matriz de permisos actual:

| Recurso | Rol mínimo |
|---|---|
| `GET /api/productos`, `GET /api/ofertas` | `EMPLEADO` (cualquier cuenta activa) |
| `POST /api/ofertas/cerrar`, `POST /api/ofertas/reactivar` | `ADMINISTRADOR` |
| `PATCH /api/productos/:id`, `POST /api/productos/editar-lote`, `POST /api/productos/eliminar` | `ADMINISTRADOR` |
| `PATCH /api/ofertas/:id`, `POST /api/ofertas/editar-lote`, `POST /api/ofertas/eliminar` | `ADMINISTRADOR` |
| `/api/uploads/*`, `/api/stats`, `/api/proveedores` (todo) | `ADMINISTRADOR` |
| `/api/usuarios/*` (todo) | `SYSADMIN` |

El primer `SYSADMIN` no se crea desde la API — no hay forma de que exista
un usuario que autorice esa primera creación. Se crea con
`npm run seed:sysadmin` (lee `SYSADMIN_EMAIL`/`SYSADMIN_PASSWORD`/
`SYSADMIN_NOMBRE` del entorno). Desde ahí, un `SYSADMIN` da de alta cuentas
`ADMINISTRADOR`/`EMPLEADO` vía `POST /api/usuarios` (no se puede crear otro
`SYSADMIN` por ese endpoint).

## Endpoints

- `GET /api/health`
- `POST /api/auth/login` — body `{email, password}`. Devuelve el usuario y
  setea la cookie `session` (httpOnly, 7 días).
- `POST /api/auth/logout` — limpia la cookie.
- `GET /api/auth/me` — usuario de la sesión actual (requiere estar logueado).
- `GET /api/usuarios` / `POST /api/usuarios` / `PATCH /api/usuarios/:id` —
  listar, crear (`{email, nombre, password, rol}`, `rol` restringido a
  `ADMINISTRADOR`/`EMPLEADO`) y editar (activar/desactivar, cambiar rol o
  nombre, resetear password) cuentas. Todo `SYSADMIN`-only, ver
  "Autenticación y roles".
- `POST /api/uploads` — multipart, campo `file` (xlsx/xls/pdf/png/jpg),
  opcionalmente `proveedor` (nombre) y `tipoDatos` (`"catalogo"` default |
  `"oferta"`). Guarda el archivo en `uploads/` y crea una `Carga` en estado
  `pendiente`.
- `POST /api/uploads/:id/procesar` — extrae la tabla del archivo y resuelve
  el mapeo (reusado o sugerido por IA) contra el schema que corresponda
  según `carga.tipoDatos`, pero **nunca publica sola**:
  - si el proveedor ya tiene un mapeo de columnas aprobado (para ese mismo
    `tipoDatos`) que coincide con los headers detectados → queda en
    `confirmacion_pendiente` con ese mapeo precargado, esperando que un
    humano confirme los valores.
  - si es un proveedor nuevo (o le cambiaron los headers) → le pide al LLM
    una sugerencia de mapeo y la deja en `revision_pendiente`.
  - si `tipoDatos` es `"oferta"`, además intenta detectar marca/n° de
    oferta/fecha/hora de archivo (`metadataOferta`) — ver `ofertaMetadata.ts`.
- `POST /api/uploads/:id/aprobar-mapeo` — body
  `{"mapeo": {"<columna origen>": "<campo_canonico>", ...}}` (campos
  válidos según `carga.tipoDatos`). Guarda el mapeo en `MapeoColumna` y
  publica los productos/ofertas **re-derivándolos de `filasExtraidas`** (no
  acepta valores editados a mano, solo reasignación de mapeo). Se mantiene
  por compatibilidad; el frontend usa `/confirmar`.
- `POST /api/uploads/:id/confirmar` — body `{"mapeo": {...}, "filas": [{<campo
  canónico>: <valor>, ...}, ...]}`. Guarda el mapeo igual que
  `/aprobar-mapeo`, pero publica **exactamente las filas que manda el
  cliente** (ediciones a mano incluidas), sin volver a derivarlas del
  servidor — es lo que usa la pantalla de revisión del frontend
  (`/cargas/:id`) para permitir corregir un valor puntual antes de guardar.
  Bifurca entre `ProductoPrecio` y `Oferta` según `carga.tipoDatos`.
- `GET /api/uploads` / `GET /api/uploads/:id` — estado de las cargas,
  incluyendo `filasExtraidas`/`mapeoSugerido` cuando está en revisión o
  esperando confirmación.
- `GET /api/uploads/:id/advertencias` — etapa 5 (ver `contexto.md` y
  "Extracción" más abajo): corre los chequeos determinísticos
  (`advertencias.ts` / `advertenciasOfertas.ts` según `carga.tipoDatos`)
  sobre las filas ya extraídas y el mapeo sugerido/aprobado, y devuelve
  `{"advertencias": [{"fila": <índice>, "campo": <string>, "mensaje":
  <string>}, ...]}`. Se calcula on-demand cuando el frontend abre la
  pantalla de revisión, no durante `/procesar` — no bloquea ni modifica
  nada, es puramente informativo.
- `GET /api/proveedores` — lista `{id, nombre}` de proveedores existentes,
  para el autocomplete del formulario de carga (evita crear un proveedor
  duplicado por un typo en el nombre).
- `GET /api/stats` — conteo de proveedores/productos/ofertas/cargas.
- `GET /api/productos` — catálogo "vigente" (`vigente: true`) y no eliminado
  (`eliminado: false`), opcionalmente filtrado por `?proveedorId=`, paginado
  (`?page=&pageSize=`, default 100). Aplica `distinct` + `orderBy: createdAt
  desc` como red de seguridad para los datos cargados antes de que existiera
  el campo `vigente` (quedaron todos en `true`, no se puede reescribir
  retroactivamente cuál era "la última" — se autocorrige con la próxima
  carga de ese proveedor+SKU). El `total` de la respuesta no aplica ese
  mismo `distinct` (Prisma no lo soporta en `count`), así que puede
  sobrestimar temporalmente en esos casos. Admite `?search=` (texto libre,
  `contains` OR sobre proveedor/marca/sku/descripción/sección/vigencia) y
  `?f_<columna>=` por columna (`f_proveedor`, `f_marca`, `f_sku` — matchea
  interno o de proveedor —, `f_descripcion`, `f_seccion`, `f_unidad`,
  `f_fechaVigencia` con `contains`; `f_precioNeto`, `f_precioConIva`,
  `f_alicuotaIva` con igualdad exacta). La consume `/cargas/gestion` y la
  página principal en el frontend.
- `PATCH /api/productos/:id` — edita una fila del catálogo (`ADMINISTRADOR`).
  Body: subconjunto de `{marca, skuProveedor, skuInterno, descripcion,
  seccion, precioNeto, precioConIva, alicuotaIva, moneda, unidad,
  fechaVigencia}`. 404 si no existe o ya está eliminada.
- `POST /api/productos/editar-lote` — aplica un mismo valor a varias filas
  (`ADMINISTRADOR`). Body `{"ids": number[], "field": string, "value":
  any}`, `field` restringido a `{seccion, precioNeto, precioConIva,
  alicuotaIva, moneda, unidad, fechaVigencia}` (no incluye campos
  identificadores como marca/sku/descripción, para no corromper datos al
  aplicar en lote). Responde `{"actualizados": <count>}`.
- `POST /api/productos/eliminar` — borrado lógico (`ADMINISTRADOR`). Body
  `{"ids": number[]}`. Marca `eliminado: true` (la fila sigue en la base,
  solo deja de aparecer en `GET`). Responde `{"eliminados": <count>}`.
- `GET /api/ofertas` — ofertas activas: `activa: true`, `eliminado: false` y
  (`fechaHasta` nula o `>= hoy`, comparación de texto ISO). `?proveedorId=`
  opcional, `?incluirCerradas=true` para ver también las cerradas/vencidas.
  Admite los mismos `?search=` y `?f_<columna>=` que `/api/productos`
  (`f_proveedor`, `f_marca`, `f_sku`, `f_descripcion`, `f_fechaOferta`,
  `f_horaOferta` con `contains`; `f_numeroOferta`, `f_desdeCantidad`,
  `f_descuentoPct`, `f_precioUnitario` con igualdad exacta).
- `POST /api/ofertas/cerrar` / `POST /api/ofertas/reactivar` — body
  `{"proveedorId": <number>, "numeroOferta": <number>, "skuProveedor":
  <string>}`. Cambia `activa` para **todas** las filas que compartan esa
  combinación (todos los tramos de `desde_cantidad` de ese SKU dentro de esa
  oferta) — "se acabó el stock" es un hecho del producto, no de un tramo de
  cantidad puntual.
- `PATCH /api/ofertas/:id` — edita una fila de oferta (`ADMINISTRADOR`).
  Body: subconjunto de `{marca, numeroOferta, skuProveedor, descripcion,
  desdeCantidad, descuentoPct, precioUnitario, moneda, fechaOferta,
  horaOferta, fechaHasta}`. No toca `activa` (eso es solo `/cerrar` y
  `/reactivar`). 404 si no existe o ya está eliminada.
- `POST /api/ofertas/editar-lote` — igual que el de productos, `field`
  restringido a `{desdeCantidad, descuentoPct, precioUnitario, moneda,
  fechaOferta, horaOferta, fechaHasta}`.
- `POST /api/ofertas/eliminar` — borrado lógico, igual shape que el de
  productos. Independiente de `activa`/`cerrar`/`reactivar`.

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
  engine del plugin a `mistral-ocr` en `vision.ts`. Probado en vivo con
  imágenes reales de proveedores contra siete modelos distintos de
  OpenRouter — hay diferencias reales de calidad entre modelos, algunos
  insertan dígitos de más en códigos de producto o confunden dos productos
  entre sí, de ahí que la revisión humana antes de publicar sea
  obligatoria para toda carga.
- `mapping.ts` — reusa `MapeoColumna` (filtrado por `tipoDatos: "catalogo"`)
  si cubre alguna columna detectada; si no, le pide al LLM una sugerencia
  (columna origen → campo canónico o `null`), que **no se aplica sola**,
  queda para aprobación humana. La muestra de filas que se le manda al LLM
  para esa sugerencia se arma con `buildRepresentativeSample` (agrupa las
  filas por `__hoja` y garantiza al menos una fila de ejemplo por hoja, con
  más profundidad si hay pocas) en vez de tomar las primeras N filas del
  archivo ya combinado — antes, en archivos con muchas hojas de layout
  distinto (ej. BOR&UR, 43 hojas), esas primeras filas eran casi siempre de
  la primera hoja, y las columnas exclusivas de las demás le llegaban al LLM
  sin ningún dato de ejemplo (todo `null`). Reusada tal cual por
  `mappingOfertas.ts`, que tenía el mismo problema. `applyMapping` convierte
  filas crudas al schema canónico, con parseo tolerante de precios
  (`"$ 1.985,78"` → `1985.78`) y columnas no mapeadas van a `raw_data`.
  `toNumberOrNull` (usado también por `mappingOfertas.ts`) distingue "."
  como separador de miles de un decimal real de 3 cifras (ej.
  `"101243.285"`, un precio con varios dígitos enteros, no debe leerse como
  `101243285`) — ver `mapping.test.ts` para los casos límite cubiertos.
- `advertencias.ts` / `advertenciasOfertas.ts` — etapa 5 del plan original
  (ver `contexto.md`), calculada como paso aparte cuando se abre la pantalla
  de revisión (`GET /api/uploads/:id/advertencias`, ver Endpoints), no
  durante `procesarCarga`. Son chequeos determinísticos (sin LLM) que **no
  bloquean ni corrigen nada solos** — el humano ve la advertencia en la
  pantalla de revisión y decide si la ignora, corrige a mano, o excluye la
  fila. Catálogo (`advertencias.ts`): precio ≤ 0, SKU duplicado dentro de la
  misma carga, salto de precio (±30%) vs. el último valor conocido de ese
  proveedor+SKU en `ProductoPrecio`. Ofertas (`advertenciasOfertas.ts`,
  paralelo, no una fusión genérica — mismo criterio que
  `mapping.ts`/`mappingOfertas.ts`): precio_unitario ≤ 0, tramo duplicado
  (mismo `sku_proveedor` + `desde_cantidad`, a diferencia de catálogo donde
  el SKU repetido ya es en sí la señal — acá un SKU repetido con distinto
  `desde_cantidad` es un tramo válido), salto de precio comparado por tramo
  exacto contra la última `Oferta` conocida, y campos obligatorios
  faltantes (`OFERTA_REQUIRED_FIELDS`, exportado desde `processCarga.ts` y
  reusado acá — misma lista que se valida como error duro recién al
  confirmar, pero mostrada antes como advertencia temprana).
- `typesOfertas.ts` / `mappingOfertas.ts` / `ofertaMetadata.ts` — paralelos a
  `types.ts`/`mapping.ts` para el schema de `Oferta` (ver docs/plan-ofertas.md
  y contexto.md, sección "Schema canónico (ofertas)"): mismo mecanismo de
  mapeo de columnas reusado/sugerido por LLM (filtrado por
  `tipoDatos: "oferta"` en `MapeoColumna`), pero además `ofertaMetadata.ts`
  le pide al LLM que infiera marca/n° de oferta/fecha/hora "de todo el
  archivo" a partir del nombre de archivo y las filas banner que
  `excel.ts#extractBannerLines` deja antes del header (para xlsx/xls) o, en
  la misma llamada de extracción de `vision.ts#extractOfertaWithVision`
  (para pdf/png/jpg). `applyMappingOfertas` completa marca/numero_oferta/
  fecha_oferta/hora_oferta con esa metadata solo en las filas donde el
  campo no vino de una columna mapeada — así funciona tanto un proveedor
  donde ese dato es una columna real (pasa con `numero_oferta` en BOR&UR)
  como uno donde solo está en el banner. `fecha_hasta` (vencimiento de la
  oferta) sigue el mismo mecanismo: dato de archivo/banner con fallback a
  metadata, `null` si el archivo dice algo como "hasta agotar stock" o no
  da fecha concreta (eso no significa "no vence", significa que se cierra
  a mano después, ver `Oferta.activa` en "Modelo de datos").
- `processCarga.ts` — orquesta todo lo anterior, bifurcando por
  `carga.tipoDatos` entre el flujo de catálogo y el de ofertas. Si el paso
  de mapeo falla (ej. sin API key), las filas ya extraídas (y, para
  ofertas, la metadata ya detectada) quedan guardadas en la `Carga` para no
  tener que re-parsear el archivo en el reintento. `Oferta` tiene varios
  campos `NOT NULL` en el schema (a diferencia de `ProductoPrecio`); antes
  de publicar se valida que estén completos con un mensaje de error legible
  (fila + campos faltantes) en vez de dejar que el `INSERT` de Prisma
  rompa con un error críptico. `publicarCanonicalRows` marca `vigente:
  false` en la fila anterior de cada proveedor+marca+SKU presente en la
  carga antes de insertar las nuevas (agrupado por marca y en lotes de 500
  SKUs por `updateMany`, no una query por fila) — todo en una transacción
  (`$transaction`, timeout de 30s para archivos grandes) para que no quede
  un estado intermedio visible.

## Pendiente

- Cola/worker en vez de procesar sincrónicamente en el request — para
  archivos grandes o con muchas páginas de PDF, `POST /:id/procesar` puede
  tardar 1-2 minutos con el usuario esperando.
- Las advertencias (`GET /:id/advertencias`, ver "Extracción") se calculan
  una sola vez, cuando el frontend abre la pantalla de revisión — si el
  usuario cambia el mapeo de columnas después, no se recalculan
  automáticamente (habría que hacer un refetch manual o mover el chequeo al
  cliente). Siguen siendo, de todas formas, solo advertencias: la única
  validación que bloquea la publicación sigue siendo la revisión humana.
- `GET /api/productos` no puede aplicar `distinct` al `count` (Prisma no lo
  soporta ahí), así que el `total` puede sobrestimar para proveedores con
  historial cargado antes de que existiera el campo `vigente` — se
  autocorrige con la próxima carga de ese proveedor+SKU, no antes.
