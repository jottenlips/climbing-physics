import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

export default defineConfig({
  plugins: [react()],
  server: {
    open: true,
    port: 3001,
  },
  build: {
    chunkSizeWarningLimit: 1000,
    outDir: "static",
  },
});
