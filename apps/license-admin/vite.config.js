import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Strict CSP for production builds only (the dev server needs inline HMR
// scripts). The app only talks to Supabase.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.supabase.co",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

const productionCsp = {
  name: "license-admin-csp",
  apply: "build",
  transformIndexHtml: (html) => html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
};

export default defineConfig({
  plugins: [react(), productionCsp],
  server: { port: 5176, strictPort: true },
  preview: { port: 4176, strictPort: true },
});
