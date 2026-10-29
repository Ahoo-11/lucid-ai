import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const server = process.env.LUCID_SERVER ?? "http://127.0.0.1:4318";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: server, changeOrigin: true },
      "/v1": { target: server, changeOrigin: true },
      "/healthz": { target: server, changeOrigin: true },
    },
  },
});
