import { z } from "zod";
import { getEnv } from "../env.js";

// Voyage AI embeddings. voyage-4 is the general-purpose model; 1024 is its
// default dimension and must match the vector(1024) column in schema.prisma.
export const EMBEDDING_MODEL = "voyage-4";
export const EMBEDDING_DIMENSIONS = 1024;

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const BATCH_SIZE = 128;
const MAX_ATTEMPTS = 4;

const ResponseSchema = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()), index: z.number().int() })),
  usage: z.object({ total_tokens: z.number() }),
});

// Voyage embeds queries and documents asymmetrically, so callers must say
// which one they're sending.
export type InputType = "document" | "query";

export interface EmbedResult {
  embeddings: number[][];
  totalTokens: number;
}

export async function embed(texts: string[], inputType: InputType): Promise<EmbedResult> {
  const embeddings: number[][] = [];
  let totalTokens = 0;
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const result = await embedBatch(batch, inputType);
    embeddings.push(...result.embeddings);
    totalTokens += result.totalTokens;
  }
  return { embeddings, totalTokens };
}

async function embedBatch(texts: string[], inputType: InputType): Promise<EmbedResult> {
  const { VOYAGE_API_KEY } = getEnv();
  const body = JSON.stringify({
    input: texts,
    model: EMBEDDING_MODEL,
    input_type: inputType,
    output_dimension: EMBEDDING_DIMENSIONS,
    // Error rather than silently embed a truncated chunk.
    truncation: false,
  });

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(VOYAGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${VOYAGE_API_KEY}` },
      body,
    });

    if (res.ok) {
      const parsed = ResponseSchema.parse(await res.json());
      const ordered = [...parsed.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
      if (ordered.length !== texts.length) {
        throw new Error(`Voyage returned ${ordered.length} embeddings for ${texts.length} inputs`);
      }
      for (const vector of ordered) {
        if (vector.length !== EMBEDDING_DIMENSIONS) {
          throw new Error(`Voyage returned a ${vector.length}-dim vector, expected ${EMBEDDING_DIMENSIONS}`);
        }
      }
      return { embeddings: ordered, totalTokens: parsed.usage.total_tokens };
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      throw new Error(`Voyage embeddings request failed (${res.status}): ${await res.text()}`);
    }
    await new Promise((r) => setTimeout(r, retryDelayMs(res, attempt)));
  }
}

// Voyage rate limits are per minute (3 RPM on an account without a payment
// method), so a 429 needs a backoff measured in seconds, not milliseconds.
// Honor Retry-After when the response sends one.
export function retryDelayMs(res: Pick<Response, "status" | "headers">, attempt: number): number {
  const retryAfter = Number(res.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  return res.status === 429 ? 5000 * 2 ** (attempt - 1) : 500 * 2 ** attempt;
}

// pgvector's text input format: "[0.1,0.2,...]"
export function toPgVector(vector: number[]): string {
  return `[${vector.join(",")}]`;
}
