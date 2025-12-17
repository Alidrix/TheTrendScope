// @ts-nocheck
import http from "http";
import { loadEnvFile, getRequiredEnv } from "./config";
import { ingestYouTubeTrending } from "./services/youtubeIngest";

loadEnvFile();
const PORT = process.env.PORT || "3000";
const HOST = process.env.HOST || "0.0.0.0";

const sendJson = (res: http.ServerResponse, status: number, payload: any) => {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  });
  res.end(JSON.stringify(payload));
};

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400);
    return res.end();
  }

  if (req.method === "OPTIONS" && req.url.startsWith("/api/refresh")) {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && req.url === "/api/refresh") {
    try {
      const summary = await ingestYouTubeTrending();
      return sendJson(res, 200, { ok: true, summary });
    } catch (error: any) {
      console.error("Failed to refresh YouTube data", error);
      return sendJson(res, 500, {
        ok: false,
        message: error?.message || "Unexpected error",
      });
    }
  }

  if (req.method === "GET" && req.url === "/") {
    return sendJson(res, 200, { ok: true, message: "TheTrendScope API" });
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, message: "Not found" }));
});

const verifyEnv = () => {
  ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "YOUTUBE_API_KEY"].forEach(
    (name) => getRequiredEnv(name),
  );
};

verifyEnv();
server.listen(Number(PORT), HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
import http from "node:http";
import { createSchema } from "./bootstrap/createSchema";
import { loadEnvFromFile } from "./config/env";

loadEnvFromFile();

async function start() {
  console.info("Bootstrapping database schema before starting the server…");

  try {
    const result = await createSchema();
    console.info(result.message);
  } catch (error) {
    console.error("Schema bootstrap failed. Aborting server startup.", error);
    process.exit(1);
  }

  const port = Number.parseInt(process.env.PORT || "3000", 10);
  const server = http.createServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        status: "ok",
        message: "TheTrendScope backend is running",
      })
    );
  });

  server.listen(port, () => {
    console.info(`Server is ready on http://localhost:${port}`);
  });
}

start().catch((error) => {
  console.error("Unexpected startup failure", error);
  process.exit(1);
});
