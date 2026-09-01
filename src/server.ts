import "dotenv/config";
import express from "express";
import cors from "cors";
import { uploadsRouter } from "./routes/uploads.js";
import { statsRouter } from "./routes/stats.js";
import { proveedoresRouter } from "./routes/proveedores.js";
import { productosRouter } from "./routes/productos.js";
import { ofertasRouter } from "./routes/ofertas.js";
import { autoDescargasRouter } from "./routes/autoDescargas.js";
import { stockRouter } from "./routes/stock.js";
import { IMAGENES_DIR } from "./lib/imagenes.js";

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL }));
// Límite por default (100kb) no alcanza para confirmar una carga con miles
// de filas editadas (ej. una lista de precios de 20.000+ productos); mismo
// límite que ya usa multer para el archivo subido.
app.use(express.json({ limit: "50mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// Fotos de producto/oferta servidas estáticamente (a diferencia de los
// archivos de carga originales en uploads/, que nunca se sirven así).
app.use("/uploads/imagenes", express.static(IMAGENES_DIR));

app.use("/api/uploads", uploadsRouter);
app.use("/api/stats", statsRouter);
app.use("/api/proveedores", proveedoresRouter);
app.use("/api/productos", productosRouter);
app.use("/api/ofertas", ofertasRouter);
app.use("/api/auto-descargas", autoDescargasRouter);
app.use("/api/stock", stockRouter);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

// ping-pipeline-1784735891: commit de prueba para el deploy automatico
const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`Backend escuchando en http://localhost:${port}`);
});
