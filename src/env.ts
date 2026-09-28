import { z } from "zod";

// Fail closed: every variable is required and there are no fallback
// values. An empty string counts as missing.
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  VOYAGE_API_KEY: z.string().min(1),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Missing or empty required environment variables: ${missing}. See .env.example.`);
  }
  cached = parsed.data;
  return cached;
}
