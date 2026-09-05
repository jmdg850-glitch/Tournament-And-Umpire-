import { createClient } from "@supabase/supabase-js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { handleCommand, resolveActor } from "./handleCommand.js";
import { handlePairStation } from "./stationAuth.js";

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}

export function createApp(options = {}) {
  const url = options.supabaseUrl || env("SUPABASE_URL");
  const serviceKey = options.serviceRoleKey || env("SUPABASE_SERVICE_ROLE_KEY");
  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const app = new Hono();
  app.use("*", cors());

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/pair-station", async (c) => {
    try {
      const body = await c.req.json();
      const result = await handlePairStation({ admin, body });
      return c.json(result);
    } catch (err) {
      const status = Number(err.status) || 500;
      return c.json({ ok: false, error: { code: err.code || "INTERNAL", message: err.message } }, status);
    }
  });

  app.post("/command", async (c) => {
    const header = c.req.header("authorization") || "";
    const jwt = header.replace(/^Bearer\s+/i, "");
    if (!jwt) return c.json({ ok: false, error: { code: "UNAUTHENTICATED", message: "Missing JWT" } }, 401);
    try {
      const actor = await resolveActor(admin, jwt);
      const body = await c.req.json();
      const result = await handleCommand({
        admin,
        actor,
        body,
      });
      return c.json(result);
    } catch (err) {
      const status = Number(err.status) || 500;
      return c.json({ ok: false, error: { code: err.code || "INTERNAL", message: err.message } }, status);
    }
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}` || process.argv[1]?.endsWith("server.js")) {
  const { serve } = await import("@hono/node-server").catch(() => ({ serve: null }));
  const app = createApp();
  const port = Number(process.env.PORT || 8787);
  if (serve) {
    serve({ fetch: app.fetch, port });
    console.log(`Tournament API listening on ${port}`);
  } else {
    const { createServer } = await import("node:http");
    const server = createServer(async (req, res) => {
      const url = `http://${req.headers.host}${req.url}`;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
      });
      const response = await app.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    server.listen(port, () => console.log(`Tournament API listening on ${port}`));
  }
}
