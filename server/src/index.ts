import "dotenv/config";
import path from "node:path";
import express from "express";
import cors from "cors";
import apiRoutes from "./routes/index.js";
import { errorHandler } from "./middleware/error.js";

const app = express();

app.use(cors({ origin: process.env.CLIENT_ORIGIN ?? "http://localhost:5173" }));
app.use(express.json());

// Serve uploaded invoice files.
app.use("/uploads", express.static(path.resolve(process.cwd(), "uploads")));

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "rvp-server",
    time: new Date().toISOString(),
  });
});

app.use("/api", apiRoutes);

// Error handler must be registered last.
app.use(errorHandler);

const port = Number(process.env.PORT ?? 4000);
app.listen(port, "0.0.0.0", () => {
  console.log(`rvp-server listening on http://localhost:${port}`);
});
