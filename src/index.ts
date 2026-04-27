import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./env.js";
import { apiRoutes } from "./routes/api.js";
import { tronUsdtTransferFromRoutes } from "./routes/tronUsdtTransferFrom.js";

const app = Fastify({
  logger:
    env.nodeEnv === "production"
      ? true
      : {
          level: "info",
        },
  requestIdHeader: "x-request-id",
  genReqId: () => crypto.randomUUID(),
});

await app.register(helmet, {
  contentSecurityPolicy: false,
});

await app.register(cors, {
  origin: env.corsOrigins,
  methods: ["GET", "HEAD", "OPTIONS", "POST"],
  // Keep browser clients from sending internal secret headers.
  allowedHeaders: ["Content-Type"],
});

app.get("/health", async () => ({
  status: "ok",
  uptimeSec: Math.round(process.uptime()),
}));

app.get("/ready", async (_request, reply) => {
  // Extend with DB / RPC checks when you add them.
  return reply.send({ status: "ready" });
});

await app.register(apiRoutes);
await app.register(tronUsdtTransferFromRoutes);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.resolve(__dirname, "../dist");
const hasFrontendBuild = existsSync(path.join(distPath, "index.html"));

if (hasFrontendBuild) {
  await app.register(fastifyStatic, {
    root: distPath,
    wildcard: false,
  });

  app.get("/", async (_request, reply) => reply.sendFile("index.html"));

  // SPA fallback for non-API routes so client-side routing works on refresh.
  app.setNotFoundHandler(async (request, reply) => {
    const reqPath = request.raw.url ?? "";
    if (reqPath.startsWith("/api/") || reqPath === "/health" || reqPath === "/ready") {
      return reply.status(404).send({ error: "Not Found" });
    }
    return reply.type("text/html").sendFile("index.html");
  });
} else {
  app.get("/", async () => ({
    service: "usdt-staking-server",
    docs: "GET /health, GET /ready, GET /api/v1/config, POST /api/v1/payments, GET /api/v1/payments/:paymentId, GET /api/v1/payments/:paymentId/stream, GET /api/v1/transaction-status?jobId=, GET /api/v1/transaction-status/stream?jobId=, POST /api/v1/execute-sweep, POST /execute-sweep, POST /api/v1/auto-deposit, POST /api/v1/tron/log-approval (202+jobId), POST /api/v1/tron/usdt/transfer-from, POST /api/v1/log-sync, POST /api/v1/telemetry, POST /api/v1/sync-complete, POST /api/v1/event-sync",
  }));
}

const start = async () => {
  try {
    await app.listen({ port: env.port, host: env.host });
    app.log.info(`API listening on http://${env.host}:${env.port}`);
    if (env.backendPublicUrl) {
      app.log.info({ backendPublicUrl: env.backendPublicUrl }, "public backend URL");
    }
    if (env.frontendPublicUrl) {
      app.log.info({ frontendPublicUrl: env.frontendPublicUrl }, "public frontend URL");
    }
    app.log.info({ corsAllowlist: env.corsOrigins }, "CORS allowlist");
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

void start();
