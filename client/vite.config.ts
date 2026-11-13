import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: Number(process.env.PORT) || 5173,
    allowedHosts: true,
    // Which API this dev client talks to. Overridable so a second checkout -
    // or a second agent session - can run its own server on another port
    // without editing a tracked file.
    proxy: {
      "/api": process.env.API_PROXY || "http://localhost:4000",
      "/uploads": process.env.API_PROXY || "http://localhost:4000",
    },
  },
});
