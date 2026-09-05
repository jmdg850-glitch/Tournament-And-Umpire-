import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_ELECTRON === "1" ? "./" : "/",
  server: { port: 5174, strictPort: true },
  preview: { port: 4174, strictPort: true },
});
