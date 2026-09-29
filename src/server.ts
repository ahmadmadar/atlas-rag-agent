// HTTP entry point: npm run dev (tsx) or npm start (compiled).
// Serves the agent over POST /api/ask, streaming each round as NDJSON.
import "dotenv/config";
import { createServer } from "node:http";
import { getPrisma } from "./db/client.js";
import { getAgentEnv } from "./env.js";
import { createApp } from "./http/app.js";

// Fail closed at boot, not on the first request: a deploy with a missing
// key should crash visibly instead of serving errors.
try {
  getAgentEnv();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

// Render sets PORT. 3000 is only the local fallback; it's not a secret.
const port = Number(process.env.PORT ?? 3000);
const server = createServer(createApp());
server.listen(port, () => console.log(`Atlas agent listening on http://localhost:${port}`));

// Render sends SIGTERM on redeploy. Stop accepting connections, let
// in-flight runs finish, then close the database pool.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    console.log(`${signal} received, shutting down.`);
    server.close(async () => {
      await getPrisma().$disconnect();
      process.exit(0);
    });
  });
}
