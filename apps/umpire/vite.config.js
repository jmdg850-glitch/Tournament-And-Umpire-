import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: process.env.CAPACITOR === "1" ? "./" : "/",
  server: { port: 5175, strictPort: true },
  preview: { port: 4175, strictPort: true },
});
