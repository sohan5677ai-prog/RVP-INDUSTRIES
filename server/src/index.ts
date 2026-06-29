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

  // Bootstrap missing accounts. (40040 Internal Weight Profit was decommissioned.)
  import("./lib/prisma.js").then(async ({ prisma }) => {
    try {
      await prisma.account.upsert({
        where: { code: '50080' },
        update: { name: 'Interest Expense', type: 'EXPENSE' },
        create: { code: '50080', name: 'Interest Expense', type: 'EXPENSE' },
      });
      await prisma.account.upsert({
        where: { code: '50090' },
        update: { name: 'Transport Expense (Internal)', type: 'EXPENSE' },
        create: { code: '50090', name: 'Transport Expense (Internal)', type: 'EXPENSE' },
      });
    } catch(e) {
      console.error(e);
    }
  });

  // Optionally start the Slack bot (Socket Mode) in the same process. A failure
  // here must never take down the API server, so it's isolated in try/catch.
  if (process.env.SLACK_ENABLED === "true") {
    import("./slack/app.js")
      .then(({ startSlackBot }) => startSlackBot())
      .catch((err) => console.error("[slack] failed to start:", err));
  }
});
