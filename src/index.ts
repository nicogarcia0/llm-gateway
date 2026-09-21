import { loadConfig } from "./config.ts";
import { createGateway } from "./server.ts";

const configPath = process.env.CONFIG_PATH ?? "config.json";
const config = loadConfig(configPath);
const { server } = createGateway(config);

if (config.clientKeys.length === 0) {
  console.warn("WARNING: no clientKeys configured, the gateway accepts unauthenticated requests");
}

server.listen(config.port, () => {
  console.log(`llm-gateway listening on :${config.port} with ${config.providers.length} provider(s)`);
});

const shutdown = () => {
  console.log("shutting down");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
