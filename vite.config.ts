import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? "0.1.0") },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // public/classes est ignoré : copier des images pendant que l'appli tourne faisait planter Vite (EBUSY)
    watch: { ignored: ["**/src-tauri/**", "**/public/classes/**"] },
  },
});
