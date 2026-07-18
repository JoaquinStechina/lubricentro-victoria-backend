import "dotenv/config";
import express from "express";
import cors from "cors";
import { uploadsRouter } from "./routes/uploads.js";
import { statsRouter } from "./routes/stats.js";
import { proveedoresRouter } from "./routes/proveedores.js";

const app = express();
app.use(cors());
// Límite por default (100kb) no alcanza para confirmar una carga con miles
// de filas editadas (ej. una lista de precios de 20.000+ productos); mismo
// límite que ya usa multer para el archivo subido.
app.use(express.json({ limit: "50mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/uploads", uploadsRouter);
app.use("/api/stats", statsRouter);
app.use("/api/proveedores", proveedoresRouter);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`Backend escuchando en http://localhost:${port}`);
});
