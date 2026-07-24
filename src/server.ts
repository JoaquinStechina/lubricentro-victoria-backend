import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { uploadsRouter } from "./routes/uploads.js";
import { statsRouter } from "./routes/stats.js";
import { proveedoresRouter } from "./routes/proveedores.js";
import { productosRouter } from "./routes/productos.js";
import { ofertasRouter } from "./routes/ofertas.js";
import { authRouter } from "./routes/auth.js";
import { usuariosRouter } from "./routes/usuarios.js";
import { autoDescargasRouter } from "./routes/autoDescargas.js";
import { requireAuth } from "./middleware/auth.js";
import { IMAGENES_DIR } from "./lib/imagenes.js";

const app = express();
// credentials: true + origin explícito (no "*") son necesarios para que el
// browser mande/reciba la cookie de sesión cross-origin (3000 -> 4000).
app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
app.use(cookieParser());
// Límite por default (100kb) no alcanza para confirmar una carga con miles
// de filas editadas (ej. una lista de precios de 20.000+ productos); mismo
// límite que ya usa multer para el archivo subido.
app.use(express.json({ limit: "50mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// Fotos de producto/oferta: assets no sensibles, servidos sin requireAuth (a
// diferencia de los archivos de carga originales en uploads/, que nunca se
// sirven estáticamente).
app.use("/uploads/imagenes", express.static(IMAGENES_DIR));

app.use("/api/auth", authRouter);

// A partir de acá, toda la API requiere sesión. El detalle de qué rol
// mínimo hace falta para cada recurso se resuelve dentro de cada router
// (ver requireRole en uploads/stats/proveedores/ofertas/usuarios).
app.use("/api/uploads", requireAuth, uploadsRouter);
app.use("/api/stats", requireAuth, statsRouter);
app.use("/api/proveedores", requireAuth, proveedoresRouter);
app.use("/api/productos", requireAuth, productosRouter);
app.use("/api/ofertas", requireAuth, ofertasRouter);
app.use("/api/usuarios", requireAuth, usuariosRouter);
app.use("/api/auto-descargas", requireAuth, autoDescargasRouter);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

// ping-pipeline-1784735891: commit de prueba para el deploy automatico
const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`Backend escuchando en http://localhost:${port}`);
});
