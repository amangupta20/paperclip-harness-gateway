import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Served by the gateway at /admin. `npm run dev` proxies the API to a running gateway
// (GATEWAY=http://host:8787 npm run dev).
export default defineConfig({
  base: "/admin/",
  plugins: [react(), tailwindcss()],
  server: { proxy: { "/admin/api": process.env.GATEWAY || "http://127.0.0.1:8787" } },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
