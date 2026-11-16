import { serve } from "@hono/node-server";
import { readFile } from "node:fs/promises";
import {
  connectSource,
  type ConnectorSource,
  type SourceConfig,
} from "./adapters";
import { connectorApp } from "./server";
const raw = process.env.MAILHUB_SOURCES_FILE
  ? await readFile(process.env.MAILHUB_SOURCES_FILE, "utf8")
  : process.env.MAILHUB_SOURCES || "[]";
let configs: SourceConfig[];
try {
  configs = JSON.parse(raw) as SourceConfig[];
} catch {
  console.error("Sources configuration is not valid JSON");
  process.exit(1);
}
if (!Array.isArray(configs) || !configs.length || configs.length > 20)
  throw new Error("Provide 1–20 sources in MAILHUB_SOURCES_FILE");
if (
  new Set(configs.map((s) => s.id)).size !== configs.length ||
  configs.some((s) => !/^[a-z0-9_-]{1,64}$/.test(s.id))
)
  throw new Error("Source IDs must be unique lowercase identifiers");
const token =
  process.env.CONNECTOR_TOKEN ||
  (process.env.CONNECTOR_TOKEN_FILE
    ? (await readFile(process.env.CONNECTOR_TOKEN_FILE, "utf8")).trim()
    : "");
if (token.length < 32)
  throw new Error("Set a random CONNECTOR_TOKEN with at least 32 characters");
const sources: ConnectorSource[] = [];
try {
  for (const config of configs) sources.push(await connectSource(config));
} catch (error) {
  console.error("Database initialization failed", {
    type: error instanceof Error ? error.name : "Error",
  });
  for (const source of sources) await source.close();
  process.exit(1);
}
const app = connectorApp(sources, token);
const server = serve({
  fetch: app.fetch,
  port: Number(process.env.PORT || 8080),
  hostname: process.env.LISTEN_HOST || "0.0.0.0",
});
console.info("MailHub connector listening", {
  sources: sources.map((s) => ({ id: s.config.id, kind: s.config.kind })),
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    server.close(() => {
      void Promise.all(sources.map((s) => s.close())).then(() =>
        process.exit(0),
      );
    });
  });
