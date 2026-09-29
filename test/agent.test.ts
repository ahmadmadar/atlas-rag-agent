import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { runAgent, type CreateMessage } from "../src/agent/agent.js";
import { MAX_ROUNDS } from "../src/agent/prompt.js";
import type { ToolExecutor } from "../src/tools/index.js";

const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function toolTurn(...calls: { name: string; input: unknown }[]): Anthropic.Message {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage,
    content: calls.map((c, i) => ({ type: "tool_use", id: `tu_${i}_${Math.random()}`, name: c.name, input: c.input })),
  } as unknown as Anthropic.Message;
}

// The final answer is structured JSON; `raw` sends the text as-is to test
// what happens when it isn't.
function textTurn(answer: string, status: "answered" | "not_found" = "answered", raw = false): Anthropic.Message {
  const text = raw ? answer : JSON.stringify({ status, answer });
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage,
    content: [{ type: "text", text, citations: null }],
  } as unknown as Anthropic.Message;
}

// Replays scripted responses and records every request it was sent.
function scripted(responses: Anthropic.Message[]) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const createMessage: CreateMessage = async (params) => {
    requests.push(structuredClone(params));
    const next = responses.shift();
    if (!next) throw new Error("script exhausted");
    return next;
  };
  return { createMessage, requests };
}

const search = { name: "search_knowledge_base", input: { query: "coastal TIV" } };
const v3Section: ToolExecutor = async () => ({
  result: { hits: [] },
  retrieved: [{ documentId: "uw-guidelines-cp-v3", section: "2.2" }],
});

describe("runAgent", () => {
  it("answers directly when the first round is sufficient", async () => {
    const { createMessage, requests } = scripted([
      toolTurn(search),
      textTurn("Field underwriters can bind up to $5M TIV in Tier 1 counties [uw-guidelines-cp-v3 §2.2]."),
    ]);
    const result = await runAgent("q", { createMessage, executeTool: v3Section });

    expect(result.status).toBe("answered");
    expect(result.roundsUsed).toBe(1);
    expect(result.capReached).toBe(false);
    expect(result.grounded).toBe(true);
    expect(result.citations).toEqual([{ documentId: "uw-guidelines-cp-v3", section: "2.2" }]);
    expect(requests.map((r) => r.tool_choice)).toEqual([{ type: "auto" }, { type: "auto" }]);
  });

  it("enforces the round cap in code with tool_choice none", async () => {
    const { createMessage, requests } = scripted([
      toolTurn(search),
      toolTurn(search),
      toolTurn(search),
      textTurn("Searched cyber and property; nothing responsive.", "not_found"),
    ]);
    const result = await runAgent("q", { createMessage, executeTool: v3Section });

    expect(requests).toHaveLength(MAX_ROUNDS + 1);
    expect(requests.at(-1)!.tool_choice).toEqual({ type: "none" });
    expect(requests.slice(0, MAX_ROUNDS).every((r) => r.tool_choice?.type === "auto")).toBe(true);
    expect(result.roundsUsed).toBe(MAX_ROUNDS);
    expect(result.capReached).toBe(true);
    expect(result.status).toBe("not_found");
  });

  it("tells the model how many rounds are left after each round", async () => {
    const { createMessage, requests } = scripted([toolTurn(search), toolTurn(search), toolTurn(search), textTurn("x")]);
    await runAgent("q", { createMessage, executeTool: v3Section });

    const lastUserText = (r: Anthropic.MessageCreateParamsNonStreaming) => {
      const content = r.messages.at(-1)!.content as Anthropic.ContentBlockParam[];
      return (content.at(-1) as Anthropic.TextBlockParam).text;
    };
    expect(lastUserText(requests[1]!)).toMatch(/Round 1 of 3 used\. 2 rounds/);
    expect(lastUserText(requests[3]!)).toMatch(/No tool calls left/);
  });

  it("reports each completed round to onRound, with its retrieved sections", async () => {
    const { createMessage } = scripted([toolTurn(search), toolTurn(search, search), textTurn("x [uw-guidelines-cp-v3 §2.2].")]);
    const rounds: { round: number; calls: number }[] = [];
    await runAgent("q", { createMessage, executeTool: v3Section, onRound: (r) => rounds.push({ round: r.round, calls: r.toolCalls.length }) });
    expect(rounds).toEqual([{ round: 1, calls: 1 }, { round: 2, calls: 2 }]);
  });

  it("counts parallel tool calls as one round and returns all results in one message", async () => {
    const { createMessage, requests } = scripted([
      toolTurn(search, { name: "list_documents", input: {} }, { name: "get_document_section", input: { document_id: "uw-guidelines-cp-v2", section: "2.2" } }),
      textTurn("answer [uw-guidelines-cp-v3 §2.2]"),
    ]);
    const result = await runAgent("q", { createMessage, executeTool: v3Section });

    expect(result.roundsUsed).toBe(1);
    expect(result.trace[0]!.toolCalls).toHaveLength(3);
    const toolResults = (requests[1]!.messages.at(-1)!.content as Anthropic.ContentBlockParam[]).filter((b) => b.type === "tool_result");
    expect(toolResults).toHaveLength(3);
  });

  it("returns a failing tool to the model as an is_error result instead of throwing", async () => {
    const { createMessage, requests } = scripted([toolTurn(search), textTurn("Search failed; nothing to cite.", "not_found")]);
    const failing: ToolExecutor = async () => {
      throw new Error("Unknown document_id");
    };
    const result = await runAgent("q", { createMessage, executeTool: failing });

    const block = (requests[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0]!;
    expect(block.is_error).toBe(true);
    expect(result.trace[0]!.toolCalls[0]!.error).toMatch(/Unknown document_id/);
  });

  it("flags citations to sections no tool returned", async () => {
    const { createMessage } = scripted([
      toolTurn(search),
      textTurn("Limit is $5M [uw-guidelines-cp-v3 §2.2], deductible 5% [risk-appetite-statement §4]."),
    ]);
    const result = await runAgent("q", { createMessage, executeTool: v3Section });

    expect(result.grounded).toBe(false);
    expect(result.ungroundedCitations).toEqual([{ documentId: "risk-appetite-statement", section: "4" }]);
  });

  it("flags an answer with no citations as ungrounded", async () => {
    const { createMessage } = scripted([toolTurn(search), textTurn("The limit is $5M.")]);
    const result = await runAgent("q", { createMessage, executeTool: v3Section });
    expect(result.status).toBe("answered");
    expect(result.grounded).toBe(false);
  });

  it("takes status from the structured field, wherever the text says not found", async () => {
    // The baseline defect: an explanation first, then the not-found line.
    // Status no longer depends on where that line sits in the prose.
    const { createMessage, requests } = scripted([
      toolTurn(search),
      textTurn("No E&O product appears in the corpus.\n\nNot found in the Atlas corpus: no E&O limit.", "not_found"),
    ]);
    const result = await runAgent("q", { createMessage, executeTool: v3Section });
    expect(result.status).toBe("not_found");
    expect(requests.every((r) => r.output_config?.format?.type === "json_schema")).toBe(true);
  });

  it("keeps a partial answer as answered even when it ends with a not-found paragraph", async () => {
    const { createMessage } = scripted([
      toolTurn(search),
      textTurn("GL is $2M [uw-guidelines-cp-v3 §2.2].\n\nNot found in the Atlas corpus: the GL supplemental forms."),
    ]);
    expect((await runAgent("q", { createMessage, executeTool: v3Section })).status).toBe("answered");
  });

  it("fails loudly if the final answer isn't the structured JSON", async () => {
    const { createMessage } = scripted([toolTurn(search), textTurn("plain prose answer", "answered", true)]);
    await expect(runAgent("q", { createMessage, executeTool: v3Section })).rejects.toThrow(/not JSON/);
  });

  it("stops on a refusal instead of returning partial text", async () => {
    const refusal = { ...textTurn(""), stop_reason: "refusal" } as Anthropic.Message;
    const { createMessage } = scripted([refusal]);
    await expect(runAgent("q", { createMessage, executeTool: v3Section })).rejects.toThrow(/declined/);
  });
});
