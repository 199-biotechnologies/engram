/**
 * Chat Handler for Engram Web Interface
 * Uses Claude Haiku 4.5 with tools for entity/memory management
 */

import Anthropic from "@anthropic-ai/sdk";
import { EngramDatabase, Entity, Memory } from "../storage/database.js";
import { KnowledgeGraph } from "../graph/knowledge-graph.js";
import { HybridSearch } from "../retrieval/hybrid.js";

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
    description: "Delete a memory by its ID.",
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

export class ChatHandler {
  private client: Anthropic | null = null;
  private db: EngramDatabase;
  private graph: KnowledgeGraph;
  private search: HybridSearch;
  private conversationHistory: Anthropic.MessageParam[] = [];

  constructor(options: {
    db: EngramDatabase;
    graph: KnowledgeGraph;
    search: HybridSearch;
  }) {
    this.db = options.db;
    this.graph = options.graph;
    this.search = options.search;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
    }
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  clearHistory(): void {
    this.conversationHistory = [];
  }

  async chat(userMessage: string): Promise<string> {
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

        const results = await this.search.search(query, { limit });
        return {
          results: results.map((r) => ({
            id: r.memory.id,
            content: r.memory.content.substring(0, 300) + (r.memory.content.length > 300 ? "..." : ""),
            timestamp: r.memory.timestamp.toISOString(),
            score: r.score.toFixed(3),
          })),
          count: results.length,
        };
      }

      case "delete_memory": {
        const id = input.id as string;
        const memory = this.db.getMemory(id);
        if (!memory) {
          return { error: `Memory not found: ${id}` };
        }

        await this.search.removeFromIndex(id);
        this.db.deleteMemory(id);
        return { success: true, deleted_id: id };
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
