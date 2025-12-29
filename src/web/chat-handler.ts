/**
 * Chat Handler for Engram Web Interface
 * Uses Claude Opus 4.5 with tools for entity/memory management
 */

import Anthropic from "@anthropic-ai/sdk";
import { EngramDatabase, Entity, Memory } from "../storage/database.js";
import { KnowledgeGraph } from "../graph/knowledge-graph.js";
import { HybridSearch } from "../retrieval/hybrid.js";
import { getAnthropicApiKey } from "../settings.js";

// Tool definitions for Claude - optimized for LLM consumption
const TOOLS: Anthropic.Tool[] = [
  {
    name: "list_entities",
    description: "Returns array of {name, type, id}. Filters: type (person|organization|place), limit. Default limit=50.",
    input_schema: {
      type: "object" as const,
      properties: {
        type: {
          type: "string",
          enum: ["person", "organization", "place"],
          description: "Filter: person, organization, or place",
        },
        limit: {
          type: "integer",
          description: "Max results (default: 50)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_entity",
    description: "Returns {name, type, observations[], relationships_from[], relationships_to[]} or {error}.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Exact entity name (case-sensitive)",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "delete_entity",
    description: "Permanently removes entity + all observations + all relationships. Returns {success, deleted} or {error}.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Exact entity name to delete",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "merge_entities",
    description: "Moves all data from 'merge' into 'keep', then deletes 'merge'. Use for deduplication. Returns {success, kept, merged, observations_moved, relations_moved} or {error}.",
    input_schema: {
      type: "object" as const,
      properties: {
        keep: {
          type: "string",
          description: "Entity name to preserve (target)",
        },
        merge: {
          type: "string",
          description: "Entity name to merge then delete (source)",
        },
      },
      required: ["keep", "merge"],
    },
  },
  {
    name: "rename_entity",
    description: "Changes entity name. Returns {success, old_name, new_name} or {error}.",
    input_schema: {
      type: "object" as const,
      properties: {
        old_name: {
          type: "string",
          description: "Current exact name",
        },
        new_name: {
          type: "string",
          description: "New name",
        },
      },
      required: ["old_name", "new_name"],
    },
  },
  {
    name: "delete_relationship",
    description: "Removes specific relationship. All 3 params must match exactly. Returns {success, deleted} or {error}.",
    input_schema: {
      type: "object" as const,
      properties: {
        from: {
          type: "string",
          description: "Source entity name",
        },
        to: {
          type: "string",
          description: "Target entity name",
        },
        type: {
          type: "string",
          description: "Relationship type (e.g., works_at, knows, lives_in)",
        },
      },
      required: ["from", "to", "type"],
    },
  },
  {
    name: "search_memories",
    description: "Hybrid BM25+semantic search. Returns {results[{id, content, timestamp, score}], count}.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (keywords or natural language)",
        },
        limit: {
          type: "integer",
          description: "Max results (default: 10)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "delete_memory",
    description: "Soft-delete (recoverable). Returns {success, disabled_id} or {error}.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "Memory UUID",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "edit_memory",
    description: "Updates content and/or importance. Returns {success, memory_id, updated_fields[]} or {error}.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "Memory UUID",
        },
        content: {
          type: "string",
          description: "New content (replaces existing)",
        },
        importance: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "0-1: 0.9=identity, 0.8=major, 0.5=normal, 0.3=minor",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "create_memory",
    description: "Stores new memory. Returns {success, memory_id, content}.",
    input_schema: {
      type: "object" as const,
      properties: {
        content: {
          type: "string",
          description: "Information to store",
        },
        importance: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "0-1: 0.9=identity, 0.8=major, 0.5=normal (default), 0.3=minor",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "create_entity",
    description: "Creates new entity. Returns {success, entity_id, name, type} or {error} if exists.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Entity name",
        },
        type: {
          type: "string",
          enum: ["person", "organization", "place"],
          description: "Entity type",
        },
      },
      required: ["name", "type"],
    },
  },
  {
    name: "create_relationship",
    description: "Links two entities. Auto-creates entities as 'person' if missing. Returns {success, relationship}.",
    input_schema: {
      type: "object" as const,
      properties: {
        from: {
          type: "string",
          description: "Source entity name",
        },
        to: {
          type: "string",
          description: "Target entity name",
        },
        type: {
          type: "string",
          description: "Relationship type (e.g., works_at, lives_in, knows, sibling_of, parent_of)",
        },
      },
      required: ["from", "to", "type"],
    },
  },
  {
    name: "find_duplicates",
    description: "Detects similar entity names. Returns {groups[{keep, duplicates[]}], total_duplicates}.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "auto_tidy",
    description: "Auto-merges all detected duplicates. Returns {entities_merged, observations_moved, relations_moved}.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

const SYSTEM_PROMPT = `You are a helpful assistant for managing Engram, a personal memory system. You have extended thinking capabilities - use them to reason carefully about complex requests.

## Your Capabilities
- Search and retrieve memories using semantic + keyword hybrid search
- Manage entities (people, organizations, places) - create, rename, merge, delete
- Manage relationships between entities
- Create, edit, and delete memories
- Find and auto-merge duplicate entities

## Critical Behaviors
1. **Always search first**: When asked about anything that might be in memory, use search_memories FIRST before answering. Don't assume you know the answer.
2. **Multi-step reasoning**: For complex requests, break them into steps. Search, analyze results, then act.
3. **Confirm destructive actions**: Unless the user is explicit, ask before deleting or merging data.
4. **Be precise**: Use exact entity names when making changes. Check spelling.
5. **Context awareness**: Remember what the user discussed earlier in this conversation.

## Response Style
- Be concise but thorough
- Format lists and results clearly using markdown
- When you find relevant memories, quote the key parts
- If you're uncertain, say so and explain your reasoning

## Tool Usage
- search_memories: Use liberally - hybrid search is fast and effective
- list_entities: Good for getting an overview before specific operations
- get_entity: Get full details including observations and relationships
- find_duplicates: Run this when asked about data quality or cleanup
- auto_tidy: Only use when user explicitly wants automatic cleanup`;

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// Stream event types for SSE
export interface StreamEvent {
  type: "text" | "thinking" | "tool_start" | "tool_end" | "error" | "done";
  content?: string;
  tool?: string;
  result?: unknown;
}

export class ChatHandler {
  private client: Anthropic | null = null;
  private db: EngramDatabase;
  private graph: KnowledgeGraph;
  private search: HybridSearch;
  private conversationHistory: Anthropic.MessageParam[] = [];
  private isProcessing: boolean = false;
  private messageQueue: Array<{ message: string; resolve: (value: string) => void; reject: (error: Error) => void }> = [];

  constructor(options: {
    db: EngramDatabase;
    graph: KnowledgeGraph;
    search: HybridSearch;
  }) {
    this.db = options.db;
    this.graph = options.graph;
    this.search = options.search;

    // Initialize client from settings or env var
    this.refreshClient();
  }

  /**
   * Refresh the Anthropic client (call after settings change)
   */
  refreshClient(): void {
    const apiKey = getAnthropicApiKey();
    if (apiKey) {
      if (!this.client) {
        console.error("[Engram] ChatHandler: API key configured");
      }
      this.client = new Anthropic({
        apiKey,
        defaultHeaders: {
          "anthropic-beta": "interleaved-thinking-2025-05-14",
        },
      });
    } else {
      this.client = null;
    }
  }

  isConfigured(): boolean {
    // Re-check API key in case it was added after startup
    this.refreshClient();
    return this.client !== null;
  }

  isBusy(): boolean {
    return this.isProcessing;
  }

  getQueueLength(): number {
    return this.messageQueue.length;
  }

  clearHistory(): void {
    this.conversationHistory = [];
  }

  // Process message queue
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.messageQueue.length === 0) return;

    const { message, resolve, reject } = this.messageQueue.shift()!;
    try {
      const result = await this.processMessage(message);
      resolve(result);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }

    // Process next in queue
    this.processQueue();
  }

  // Queue-aware chat method
  async chat(userMessage: string): Promise<string> {
    this.refreshClient();
    if (!this.client) {
      return "Chat is not configured. Set ANTHROPIC_API_KEY environment variable.";
    }

    // If busy, queue the message
    if (this.isProcessing) {
      return new Promise((resolve, reject) => {
        this.messageQueue.push({ message: userMessage, resolve, reject });
      });
    }

    return this.processMessage(userMessage);
  }

  // Streaming chat with callbacks for real-time updates
  async *chatStream(userMessage: string): AsyncGenerator<StreamEvent> {
    this.refreshClient();
    if (!this.client) {
      yield { type: "error", content: "Chat is not configured. Set ANTHROPIC_API_KEY environment variable." };
      return;
    }

    this.isProcessing = true;

    // Add user message to history
    this.conversationHistory.push({
      role: "user",
      content: userMessage,
    });

    try {
      // Keep conversation history manageable
      if (this.conversationHistory.length > 20) {
        this.conversationHistory = this.conversationHistory.slice(-20);
      }

      let continueLoop = true;

      while (continueLoop) {
        const stream = this.client.messages.stream({
          model: "claude-opus-4-5-20251101",
          max_tokens: 16000,
          system: SYSTEM_PROMPT,
          tools: TOOLS,
          messages: this.conversationHistory,
          thinking: {
            type: "enabled",
            budget_tokens: 8000,
          },
        });

        let currentToolUse: { id: string; name: string; input: string } | null = null;
        let isThinking = false;

        for await (const event of stream) {
          if (event.type === "content_block_start") {
            if (event.content_block.type === "tool_use") {
              currentToolUse = {
                id: event.content_block.id,
                name: event.content_block.name,
                input: "",
              };
              yield { type: "tool_start", tool: event.content_block.name };
            } else if (event.content_block.type === "thinking") {
              isThinking = true;
              yield { type: "thinking", content: "" };
            }
          } else if (event.type === "content_block_delta") {
            if (event.delta.type === "text_delta") {
              yield { type: "text", content: event.delta.text };
            } else if (event.delta.type === "thinking_delta") {
              // Stream thinking content for transparency
              yield { type: "thinking", content: event.delta.thinking };
            } else if (event.delta.type === "input_json_delta" && currentToolUse) {
              currentToolUse.input += event.delta.partial_json;
            }
          } else if (event.type === "content_block_stop") {
            // Don't execute tools here - wait for finalMessage to avoid double execution
            currentToolUse = null;
            isThinking = false;
          }
        }

        // Get final message to check stop reason
        const finalMessage = await stream.finalMessage();

        if (finalMessage.stop_reason === "tool_use") {
          // Process tool results (execute only once, here)
          const toolUseBlocks = finalMessage.content.filter(
            (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
          );

          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const toolUse of toolUseBlocks) {
            const result = await this.executeTool(toolUse.name, toolUse.input as Record<string, unknown>);
            const isError = typeof result === "object" && result !== null && "error" in result;
            yield { type: "tool_end", tool: toolUse.name, result };
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: JSON.stringify(result),
              is_error: isError,
            });
          }

          // Add to history
          this.conversationHistory.push({
            role: "assistant",
            content: finalMessage.content,
          });
          this.conversationHistory.push({
            role: "user",
            content: toolResults,
          });
        } else {
          // Done - add final response to history
          this.conversationHistory.push({
            role: "assistant",
            content: finalMessage.content,
          });
          continueLoop = false;
        }
      }

      yield { type: "done" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      yield { type: "error", content: message };
    } finally {
      this.isProcessing = false;
      // Process any queued messages
      this.processQueue();
    }
  }

  // Original non-streaming method for backwards compatibility
  private async processMessage(userMessage: string): Promise<string> {
    if (!this.client) {
      return "Chat is not configured. Set ANTHROPIC_API_KEY environment variable.";
    }

    // Add user message to history
    this.conversationHistory.push({
      role: "user",
      content: userMessage,
    });

    try {
      // Keep conversation history manageable (last 20 messages)
      if (this.conversationHistory.length > 20) {
        this.conversationHistory = this.conversationHistory.slice(-20);
      }

      let response = await this.client.messages.create({
        model: "claude-opus-4-5-20251101",
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: this.conversationHistory,
        thinking: {
          type: "enabled",
          budget_tokens: 8000,
        },
      });

      // Handle tool use loop
      while (response.stop_reason === "tool_use") {
        const toolUseBlocks = response.content.filter(
          (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
        );

        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const toolUse of toolUseBlocks) {
          const result = await this.executeTool(toolUse.name, toolUse.input as Record<string, unknown>);
          const isError = typeof result === "object" && result !== null && "error" in result;
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify(result),
            is_error: isError,
          });
        }

        // Add assistant response and tool results to history
        this.conversationHistory.push({
          role: "assistant",
          content: response.content,
        });
        this.conversationHistory.push({
          role: "user",
          content: toolResults,
        });

        // Continue the conversation
        response = await this.client.messages.create({
          model: "claude-opus-4-5-20251101",
          max_tokens: 16000,
          system: SYSTEM_PROMPT,
          tools: TOOLS,
          messages: this.conversationHistory,
          thinking: {
            type: "enabled",
            budget_tokens: 8000,
          },
        });
      }

      // Extract text response
      const textBlocks = response.content.filter(
        (block): block is Anthropic.TextBlock => block.type === "text"
      );
      const assistantMessage = textBlocks.map((b) => b.text).join("\n");

      // Add final response to history
      this.conversationHistory.push({
        role: "assistant",
        content: response.content,
      });

      return assistantMessage;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Error: ${message}`;
    }
  }

  private async executeTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "list_entities": {
        const type = input.type as Entity["type"] | undefined;
        const limit = (input.limit as number) || 50;
        const entities = this.graph.listEntities(type, limit);
        return {
          entities: entities.map((e) => ({
            name: e.name,
            type: e.type,
            id: e.id,
          })),
          count: entities.length,
        };
      }

      case "get_entity": {
        const name = input.name as string;
        const details = this.graph.getEntityDetails(name);
        if (!details) {
          return { error: `Entity not found: ${name}` };
        }
        return {
          name: details.name,
          type: details.type,
          observations: details.observations.map((o) => ({
            content: o.content.substring(0, 200) + (o.content.length > 200 ? "..." : ""),
            confidence: o.confidence,
          })),
          relationships_from: details.relationsFrom.map((r) => ({
            type: r.type,
            to: r.targetEntity.name,
          })),
          relationships_to: details.relationsTo.map((r) => ({
            type: r.type,
            from: r.sourceEntity.name,
          })),
        };
      }

      case "delete_entity": {
        const name = input.name as string;
        const entity = this.db.findEntityByName(name);
        if (!entity) {
          return { error: `Entity not found: ${name}` };
        }
        this.db.deleteEntity(entity.id);
        return { success: true, deleted: name };
      }

      case "merge_entities": {
        const keepName = input.keep as string;
        const mergeName = input.merge as string;

        const keepEntity = this.db.findEntityByName(keepName);
        const mergeEntity = this.db.findEntityByName(mergeName);

        if (!keepEntity) {
          return { error: `Entity not found: ${keepName}` };
        }
        if (!mergeEntity) {
          return { error: `Entity not found: ${mergeName}` };
        }

        const result = this.db.mergeEntities(keepEntity.id, mergeEntity.id);
        return {
          success: true,
          kept: keepName,
          merged: mergeName,
          observations_moved: result.observationsMoved,
          relations_moved: result.relationsMoved,
        };
      }

      case "rename_entity": {
        const oldName = input.old_name as string;
        const newName = input.new_name as string;

        const entity = this.db.findEntityByName(oldName);
        if (!entity) {
          return { error: `Entity not found: ${oldName}` };
        }

        this.db.updateEntity(entity.id, { name: newName });
        return { success: true, old_name: oldName, new_name: newName };
      }

      case "delete_relationship": {
        const fromName = input.from as string;
        const toName = input.to as string;
        const type = input.type as string;

        const fromEntity = this.db.findEntityByName(fromName);
        const toEntity = this.db.findEntityByName(toName);

        if (!fromEntity) {
          return { error: `Entity not found: ${fromName}` };
        }
        if (!toEntity) {
          return { error: `Entity not found: ${toName}` };
        }

        const relation = this.db.findRelation(fromEntity.id, toEntity.id, type);
        if (!relation) {
          return { error: `Relationship not found: ${fromName} -[${type}]-> ${toName}` };
        }

        this.db.deleteRelation(relation.id);
        return { success: true, deleted: `${fromName} -[${type}]-> ${toName}` };
      }

      case "search_memories": {
        const query = input.query as string;
        const limit = (input.limit as number) || 10;

        const response = await this.search.search(query, { limit });
        return {
          results: response.results.map((r) => ({
            id: r.memory.id,
            content: r.memory.content.substring(0, 300) + (r.memory.content.length > 300 ? "..." : ""),
            timestamp: r.memory.timestamp.toISOString(),
            score: r.score.toFixed(3),
          })),
          count: response.results.length,
        };
      }

      case "delete_memory": {
        const id = input.id as string;
        const memory = this.db.getMemory(id);
        if (!memory) {
          return { error: `Memory not found: ${id}` };
        }

        // Soft-delete: remove from index and disable
        await this.search.removeFromIndex(id);
        this.db.updateMemory(id, { disabled: true });
        return { success: true, disabled_id: id, message: "Memory disabled (soft-deleted)" };
      }

      case "edit_memory": {
        const id = input.id as string;
        const content = input.content as string | undefined;
        const importance = input.importance as number | undefined;

        const memory = this.db.getMemory(id);
        if (!memory) {
          return { error: `Memory not found: ${id}` };
        }

        const updates: { content?: string; importance?: number } = {};
        if (content !== undefined) updates.content = content;
        if (importance !== undefined) updates.importance = importance;

        if (Object.keys(updates).length === 0) {
          return { error: "No updates provided" };
        }

        const updated = this.db.updateMemory(id, updates);

        // Re-index if content changed
        if (content !== undefined && updated) {
          await this.search.removeFromIndex(id);
          await this.search.indexMemory(updated);
        }

        return {
          success: true,
          memory_id: id,
          updated_fields: Object.keys(updates),
        };
      }

      case "create_memory": {
        const content = input.content as string;
        const importance = (input.importance as number) || 0.5;

        const memory = this.db.createMemory(content, "chat", importance);
        await this.search.indexMemory(memory);

        return {
          success: true,
          memory_id: memory.id,
          content: memory.content.substring(0, 100) + (memory.content.length > 100 ? "..." : ""),
        };
      }

      case "create_entity": {
        const name = input.name as string;
        const type = input.type as "person" | "organization" | "place";

        // Check if entity already exists
        const existing = this.db.findEntityByName(name);
        if (existing) {
          return { error: `Entity already exists: ${name}`, existing_id: existing.id };
        }

        const entity = this.graph.getOrCreateEntity(name, type);
        return {
          success: true,
          entity_id: entity.id,
          name: entity.name,
          type: entity.type,
        };
      }

      case "create_relationship": {
        const fromName = input.from as string;
        const toName = input.to as string;
        const type = input.type as string;

        // Get or create both entities (default to person type if not existing)
        const fromEntity = this.graph.getOrCreateEntity(fromName, "person");
        const toEntity = this.graph.getOrCreateEntity(toName, "person");

        this.graph.relate(fromEntity.name, toEntity.name, type);

        return {
          success: true,
          relationship: `${fromName} -[${type}]-> ${toName}`,
        };
      }

      case "find_duplicates": {
        const duplicates = this.db.findDuplicateEntities();
        return {
          groups: duplicates.map((d) => ({
            keep: d.entity.name,
            duplicates: d.potentialDuplicates.map((p) => p.name),
          })),
          total_duplicates: duplicates.reduce((sum, d) => sum + d.potentialDuplicates.length, 0),
        };
      }

      case "auto_tidy": {
        const duplicates = this.db.findDuplicateEntities();
        let totalMerged = 0;
        let observationsMoved = 0;
        let relationsMoved = 0;

        for (const group of duplicates) {
          for (const dupe of group.potentialDuplicates) {
            const result = this.db.mergeEntities(group.entity.id, dupe.id);
            totalMerged++;
            observationsMoved += result.observationsMoved;
            relationsMoved += result.relationsMoved;
          }
        }

        return {
          entities_merged: totalMerged,
          observations_moved: observationsMoved,
          relations_moved: relationsMoved,
        };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  }
}
