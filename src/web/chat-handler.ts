/**
 * Chat Handler for Engram Web Interface
 * Uses Claude Haiku 4.5 with tools for entity/memory management
 */

import Anthropic from "@anthropic-ai/sdk";
import { EngramDatabase, Entity, Memory } from "../storage/database.js";
import { KnowledgeGraph } from "../graph/knowledge-graph.js";
import { HybridSearch } from "../retrieval/hybrid.js";
import { getAnthropicApiKey } from "../settings.js";

// Tool definitions for Claude
const TOOLS: Anthropic.Tool[] = [
  {
    name: "list_entities",
    description: "List all entities in the knowledge graph. Use this to see what people, organizations, and places are stored.",
    input_schema: {
      type: "object" as const,
      properties: {
        type: {
          type: "string",
          enum: ["person", "organization", "place"],
          description: "Filter by entity type (optional)",
        },
        limit: {
          type: "number",
          description: "Maximum number of entities to return (default: 50)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_entity",
    description: "Get detailed information about an entity including its observations and relationships.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "The entity name to look up",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "delete_entity",
    description: "Delete an entity and all its observations and relationships. Use this to remove incorrect or duplicate entities.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "The entity name to delete",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "merge_entities",
    description: "Merge one entity into another. All observations and relationships from the source will be moved to the target, then the source is deleted. Use this to fix duplicates.",
    input_schema: {
      type: "object" as const,
      properties: {
        keep: {
          type: "string",
          description: "The entity name to keep (target)",
        },
        merge: {
          type: "string",
          description: "The entity name to merge and delete (source)",
        },
      },
      required: ["keep", "merge"],
    },
  },
  {
    name: "rename_entity",
    description: "Rename an entity to a new name.",
    input_schema: {
      type: "object" as const,
      properties: {
        old_name: {
          type: "string",
          description: "Current entity name",
        },
        new_name: {
          type: "string",
          description: "New entity name",
        },
      },
      required: ["old_name", "new_name"],
    },
  },
  {
    name: "delete_relationship",
    description: "Delete a relationship between two entities.",
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
          description: "Relationship type (e.g., 'works_at', 'knows')",
        },
      },
      required: ["from", "to", "type"],
    },
  },
  {
    name: "search_memories",
    description: "Search through stored memories.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query",
        },
        limit: {
          type: "number",
          description: "Maximum results (default: 10)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "delete_memory",
    description: "Delete a memory by its ID (soft-delete, can be recovered).",
    input_schema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "The memory ID to delete",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "edit_memory",
    description: "Edit an existing memory's content or importance.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "The memory ID to edit",
        },
        content: {
          type: "string",
          description: "New content (replaces existing)",
        },
        importance: {
          type: "number",
          description: "New importance (0-1): 0.9=core identity, 0.8=major, 0.5=normal, 0.3=minor",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "create_memory",
    description: "Create a new memory. Use for storing user information, preferences, or facts.",
    input_schema: {
      type: "object" as const,
      properties: {
        content: {
          type: "string",
          description: "The information to store",
        },
        importance: {
          type: "number",
          description: "0-1 score: 0.9=core identity, 0.8=major, 0.5=normal (default), 0.3=minor",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "create_entity",
    description: "Create a new entity (person, organization, or place).",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "The entity name",
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
    description: "Create a relationship between two entities.",
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
          description: "Relationship type (e.g., 'works_at', 'lives_in', 'knows', 'sibling_of')",
        },
      },
      required: ["from", "to", "type"],
    },
  },
  {
    name: "find_duplicates",
    description: "Find potential duplicate entities that could be merged.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "auto_tidy",
    description: "Automatically merge all detected duplicate entities.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

const SYSTEM_PROMPT = `You are a helpful assistant for managing Engram, a personal memory system. You help users:
- View and search their memories
- Manage entities (people, organizations, places)
- Fix incorrect relationships
- Merge duplicate entities
- Delete incorrect data

Be concise and helpful. When making changes, confirm what you did. If asked to do something destructive, confirm first unless the user is explicit.

When listing entities or memories, format them clearly. Use the tools available to you.`;

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// Stream event types for SSE
export interface StreamEvent {
  type: "text" | "tool_start" | "tool_end" | "error" | "done";
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
      this.client = new Anthropic({ apiKey });
    } else {
      this.client = null;
    }
  }

  isConfigured(): boolean {
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
      let fullResponse = "";

      while (continueLoop) {
        const stream = this.client.messages.stream({
          model: "claude-haiku-4-5-20241022",
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          tools: TOOLS,
          messages: this.conversationHistory,
        });

        let currentToolUse: { id: string; name: string; input: string } | null = null;

        for await (const event of stream) {
          if (event.type === "content_block_start") {
            if (event.content_block.type === "tool_use") {
              currentToolUse = {
                id: event.content_block.id,
                name: event.content_block.name,
                input: "",
              };
              yield { type: "tool_start", tool: event.content_block.name };
            }
          } else if (event.type === "content_block_delta") {
            if (event.delta.type === "text_delta") {
              fullResponse += event.delta.text;
              yield { type: "text", content: event.delta.text };
            } else if (event.delta.type === "input_json_delta" && currentToolUse) {
              currentToolUse.input += event.delta.partial_json;
            }
          } else if (event.type === "content_block_stop") {
            if (currentToolUse) {
              // Execute the tool
              let toolInput: Record<string, unknown> = {};
              try {
                toolInput = JSON.parse(currentToolUse.input || "{}");
              } catch {
                toolInput = {};
              }

              const result = await this.executeTool(currentToolUse.name, toolInput);
              yield { type: "tool_end", tool: currentToolUse.name, result };
              currentToolUse = null;
            }
          }
        }

        // Get final message to check stop reason
        const finalMessage = await stream.finalMessage();

        if (finalMessage.stop_reason === "tool_use") {
          // Process tool results and continue
          const toolUseBlocks = finalMessage.content.filter(
            (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
          );

          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const toolUse of toolUseBlocks) {
            const result = await this.executeTool(toolUse.name, toolUse.input as Record<string, unknown>);
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: JSON.stringify(result),
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
        model: "claude-haiku-4-5-20241022",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: this.conversationHistory,
      });

      // Handle tool use loop
      while (response.stop_reason === "tool_use") {
        const toolUseBlocks = response.content.filter(
          (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
        );

        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const toolUse of toolUseBlocks) {
          const result = await this.executeTool(toolUse.name, toolUse.input as Record<string, unknown>);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify(result),
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
          model: "claude-haiku-4-5-20241022",
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          tools: TOOLS,
          messages: this.conversationHistory,
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
