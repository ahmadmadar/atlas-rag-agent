import { z } from "zod";

// Fail closed: every variable is required and there are no fallback
// values. An empty string counts as missing.
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  VOYAGE_API_KEY: z.string().min(1),
});

// The agent additionally needs an Anthropic key. It's a separate guard so
// ingestion (seed, verify) doesn't demand a key it never uses.
const AgentEnvSchema = EnvSchema.extend({
  ANTHROPIC_API_KEY: z.string().min(1),
});

export type Env = z.infer<typeof EnvSchema>;
export type AgentEnv = z.infer<typeof AgentEnvSchema>;

let cached: Env | undefined;
let cachedAgent: AgentEnv | undefined;

export function getEnv(): Env {
  if (!cached) cached = parse(EnvSchema);
  return cached;
}

export function getAgentEnv(): AgentEnv {
  if (!cachedAgent) cachedAgent = parse(AgentEnvSchema);
  return cachedAgent;
}

function parse<T extends z.ZodTypeAny>(schema: T): z.infer<T> {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Missing or empty required environment variables: ${missing}. See .env.example.`);
  }
  return parsed.data;
}
