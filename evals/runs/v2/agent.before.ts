import Anthropic from "@anthropic-ai/sdk";
import { getAgentEnv } from "../env.js";
import { TOOL_DEFINITIONS, executeTool, type ToolExecutor } from "../tools/index.js";
import type { RetrievedSection } from "../tools/types.js";
import { checkCitations, type Citation } from "./citations.js";
import { MAX_ROUNDS, NOT_FOUND_PREFIX, SYSTEM_PROMPT, roundNotice } from "./prompt.js";

export const AGENT_MODEL = "claude-sonnet-5";
const MAX_TOKENS = 16000;

export type CreateMessage = (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;

export interface ToolCallTrace {
  name: string;
  input: unknown;
  retrieved: RetrievedSection[];
  error?: string;
}

export interface RoundTrace {
  round: number;
  toolCalls: ToolCallTrace[];
}

export interface AgentResult {
  question: string;
  answer: string;
  status: "answered" | "not_found";
  citations: Citation[];
  ungroundedCitations: Citation[];
  // Answered, cites at least one source, and every citation points at a
  // section a tool actually returned. A not_found answer is grounded by
  // definition: it makes no claims from the corpus.
  grounded: boolean;
  roundsUsed: number;
  capReached: boolean;
  trace: RoundTrace[];
  // Full conversation including the final answer turn, and the model id
  // each response reported serving it, so evals can save transcripts and
  // assert the model under test is the one that answered.
  messages: Anthropic.MessageParam[];
  servedModels: string[];
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
}

export interface AgentDeps {
  createMessage?: CreateMessage;
  executeTool?: ToolExecutor;
}

export class AgentError extends Error {}

export function defaultCreateMessage(): CreateMessage {
  // Pass the key explicitly: the SDK would otherwise fall back to other
  // credential sources, and this project fails closed on a missing key.
  const client = new Anthropic({ apiKey: getAgentEnv().ANTHROPIC_API_KEY });
  return (params) => client.messages.create(params);
}

// The retrieve/assess/refine loop. Each model turn that makes tool calls is
// one round, however many calls it makes in parallel. After MAX_ROUNDS the
// final request sets tool_choice "none", so the cap holds in code rather
// than relying on the model to respect the prompt.
export async function runAgent(question: string, deps: AgentDeps = {}): Promise<AgentResult> {
  const createMessage = deps.createMessage ?? defaultCreateMessage();
  const runTool = deps.executeTool ?? executeTool;

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: question }];
  const trace: RoundTrace[] = [];
  const retrieved: RetrievedSection[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const servedModels = new Set<string>();

  for (;;) {
    const capReached = trace.length >= MAX_ROUNDS;
    const response = await createMessage({
      model: AGENT_MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: TOOL_DEFINITIONS,
      tool_choice: capReached ? { type: "none" } : { type: "auto" },
      // Caches the growing conversation, so later rounds re-read earlier
      // rounds' tool results from cache instead of paying for them again.
      cache_control: { type: "ephemeral" },
      messages,
    });

    servedModels.add(response.model);
    usage.inputTokens += response.usage.input_tokens;
    usage.outputTokens += response.usage.output_tokens;
    usage.cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
    usage.cacheWriteTokens += response.usage.cache_creation_input_tokens ?? 0;

    if (response.stop_reason === "refusal") {
      throw new AgentError("The model declined to answer this question.");
    }
    if (response.stop_reason === "max_tokens") {
      throw new AgentError(`Response hit max_tokens (${MAX_TOKENS}) before finishing.`);
    }

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      const answer = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      messages.push({ role: "assistant", content: response.content });
      return { ...finish(question, answer, trace, retrieved, capReached, usage), messages, servedModels: [...servedModels] };
    }
    if (capReached) {
      throw new AgentError("Model requested tools after the round cap despite tool_choice none.");
    }

    const round: RoundTrace = { round: trace.length + 1, toolCalls: [] };
    trace.push(round);
    messages.push({ role: "assistant", content: response.content });

    // Run the round's calls concurrently and return every result in one
    // user message, including failures as is_error results.
    const results = await Promise.all(
      toolUses.map(async (call): Promise<[ToolCallTrace, Anthropic.ToolResultBlockParam]> => {
        try {
          const out = await runTool(call.name, call.input);
          return [
            { name: call.name, input: call.input, retrieved: out.retrieved },
            { type: "tool_result", tool_use_id: call.id, content: JSON.stringify(out.result) },
          ];
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return [
            { name: call.name, input: call.input, retrieved: [], error: message },
            { type: "tool_result", tool_use_id: call.id, content: message, is_error: true },
          ];
        }
      }),
    );
    for (const [callTrace] of results) {
      round.toolCalls.push(callTrace);
      retrieved.push(...callTrace.retrieved);
    }
    messages.push({
      role: "user",
      content: [...results.map(([, block]) => block), { type: "text", text: roundNotice(trace.length) }],
    });
  }
}

export function answerStatus(answer: string): AgentResult["status"] {
  return answer.startsWith(NOT_FOUND_PREFIX) ? "not_found" : "answered";
}

function finish(
  question: string,
  answer: string,
  trace: RoundTrace[],
  retrieved: RetrievedSection[],
  capReached: boolean,
  usage: AgentResult["usage"],
): Omit<AgentResult, "messages" | "servedModels"> {
  const status = answerStatus(answer);
  const { citations, ungrounded } = checkCitations(answer, retrieved);
  const grounded = status === "not_found" ? ungrounded.length === 0 : citations.length > 0 && ungrounded.length === 0;
  return {
    question,
    answer,
    status,
    citations,
    ungroundedCitations: ungrounded,
    grounded,
    roundsUsed: trace.length,
    capReached,
    trace,
    usage,
  };
}
