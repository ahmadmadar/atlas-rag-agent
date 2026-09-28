import type Anthropic from "@anthropic-ai/sdk";
import { GetSectionInput, getDocumentSection, getDocumentSectionTool } from "./get_document_section.js";
import { ListDocumentsInput, listDocuments, listDocumentsTool } from "./list_documents.js";
import { SearchInput, searchKnowledgeBase, searchKnowledgeBaseTool } from "./search_knowledge_base.js";
import type { ToolOutput } from "./types.js";

// Fixed order: tool definitions are part of the cached prompt prefix.
export const TOOL_DEFINITIONS: Anthropic.Tool[] = [searchKnowledgeBaseTool, getDocumentSectionTool, listDocumentsTool];

export type ToolExecutor = (name: string, input: unknown) => Promise<ToolOutput>;

// Validates model-supplied input before touching the database. A bad input
// throws, and the agent loop returns it to the model as an is_error result.
export const executeTool: ToolExecutor = async (name, input) => {
  switch (name) {
    case searchKnowledgeBaseTool.name:
      return searchKnowledgeBase(SearchInput.parse(input));
    case getDocumentSectionTool.name:
      return getDocumentSection(GetSectionInput.parse(input));
    case listDocumentsTool.name:
      ListDocumentsInput.parse(input ?? {});
      return listDocuments();
    default:
      throw new Error(`Unknown tool "${name}"`);
  }
};
