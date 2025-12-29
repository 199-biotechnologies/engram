#!/usr/bin/env node
/**
 * Engram - High-quality personal memory for AI assistants
 *
 * Local-first MCP server with ColBERT + BM25 hybrid search
 * and a lightweight knowledge graph.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import path from "path";
import os from "os";

import { EngramDatabase } from "./storage/database.js";
import { KnowledgeGraph } from "./graph/knowledge-graph.js";
import { createRetriever } from "./retrieval/colbert.js";
import { HybridSearch } from "./retrieval/hybrid.js";
import { EngramWebServer, getRunningServerUrl } from "./web/server.js";
import { Consolidator } from "./consolidation/consolidator.js";

// ============ Configuration ============

const DB_PATH = process.env.ENGRAM_DB_PATH
  ? path.resolve(process.env.ENGRAM_DB_PATH.replace("~", os.homedir()))
  : path.join(os.homedir(), ".engram");

const DB_FILE = path.join(DB_PATH, "engram.db");

// ============ Initialize Components ============

let db: EngramDatabase;
let graph: KnowledgeGraph;
let search: HybridSearch;
let consolidator: Consolidator;
let webServer: EngramWebServer | null = null;

async function initialize(): Promise<void> {
  console.error(`[Engram] Initializing with database at ${DB_FILE}`);

  db = new EngramDatabase(DB_FILE);
  graph = new KnowledgeGraph(db);

  const retriever = await createRetriever(DB_PATH);
  search = new HybridSearch(db, graph, retriever);
  consolidator = new Consolidator(db, graph, search);

  // Rebuild index with existing memories
  const stats = db.getStats();
  if (stats.memories > 0) {
    console.error(`[Engram] Indexing ${stats.memories} existing memories...`);
    await search.rebuildIndex();
  }

  console.error(`[Engram] Ready. Stats: ${JSON.stringify(stats)}`);
  if (consolidator.isConfigured()) {
    console.error(`[Engram] Consolidation enabled (ANTHROPIC_API_KEY found)`);
  }

  // Start web server automatically (unless another instance is already running)
  const existingUrl = getRunningServerUrl();
  if (!existingUrl) {
    webServer = new EngramWebServer({ db, graph, search });
    const url = await webServer.start();
    console.error(`[Engram] Web interface: ${url}`);
  } else {
    console.error(`[Engram] Web interface already running: ${existingUrl}`);
  }
}

// ============ MCP Server ============

const server = new Server(
  {
    name: "engram",
    version: "0.8.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool definitions with MCP 2025-06-18 annotations
// Descriptions are carefully written to guide Claude on when to use each tool
const TOOLS = [
  {
    name: "remember",
    description:
      "Store NEW information the user shares. Extract entities (people, organizations, places) and relationships. Do NOT use for corrections - use edit_memory instead. Do NOT use before checking if info already exists - use recall first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        content: {
          type: "string",
          description: "The information to store",
        },
        importance: {
          type: "number",
          description: "0-1 score with anchors: 0.9=core identity (name, birthday, family), 0.8=major preferences/life events, 0.6=notable facts, 0.5=general info (default), 0.3=casual mentions, 0.1=trivial/ephemeral",
          minimum: 0,
          maximum: 1,
          default: 0.5,
        },
        emotional_weight: {
          type: "number",
          description: "0-1 emotional significance with anchors: 0.9=major life events (births, deaths, achievements), 0.7=celebrations/disappointments, 0.5=neutral (default), 0.3=mild sentiment, 0.1=purely factual",
          minimum: 0,
          maximum: 1,
          default: 0.5,
        },
        event_time: {
          type: "string",
          description: "When the event actually happened (ISO 8601), if different from now. E.g., 'Last week I went to Paris' → set event_time to that date.",
        },
        entities: {
          type: "array",
          description: "Key entities mentioned (people, organizations, places). Only include clear, specific named entities.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Entity name (e.g., 'John Smith', 'Google', 'Paris')" },
              type: { type: "string", enum: ["person", "organization", "place"], description: "Entity type" },
            },
            required: ["name", "type"],
          },
        },
        relationships: {
          type: "array",
          description: "Relationships between entities mentioned in the content",
          items: {
            type: "object",
            properties: {
              from: { type: "string", description: "Source entity name" },
              to: { type: "string", description: "Target entity name" },
              type: { type: "string", description: "Relationship type (e.g., 'works_at', 'lives_in', 'sibling_of', 'knows')" },
            },
            required: ["from", "to", "type"],
          },
        },
      },
      required: ["content"],
    },
    annotations: {
      title: "Store Memory",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "recall",
    description:
      "Search stored memories. Use FIRST before answering questions about the user, their preferences, history, or anything previously discussed. Also use before remember to check if information already exists.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "What to search for - can be a question, keywords, or natural language",
        },
        limit: {
          type: "number",
          description: "Maximum number of memories to return",
          default: 5,
        },
        include_graph: {
          type: "boolean",
          description: "Whether to expand search using knowledge graph connections",
          default: true,
        },
      },
      required: ["query"],
    },
    annotations: {
      title: "Search Memories",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "forget",
    description: "Delete a memory by its ID. Use when user explicitly asks to remove or forget specific stored information. Get the memory ID from recall results first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "The memory ID to delete (get this from recall results)",
        },
      },
      required: ["id"],
    },
    annotations: {
      title: "Delete Memory",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "edit_memory",
    description: "Correct or update an existing memory. Use instead of forget+remember when fixing mistakes, updating outdated info, or adjusting importance. Preserves the memory's history and relationships.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "The memory ID to edit (get this from recall results)",
        },
        content: {
          type: "string",
          description: "New content for the memory (replaces existing). Omit to keep current content.",
        },
        importance: {
          type: "number",
          description: "New importance (0-1): 0.9=core identity, 0.8=major, 0.5=normal, 0.3=minor. Omit to keep current.",
          minimum: 0,
          maximum: 1,
        },
      },
      required: ["id"],
    },
    annotations: {
      title: "Edit Memory",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "engram_web",
    description: "Launch the Engram web interface for browsing, searching, and editing memories visually. Returns a URL to open in your browser.",
    inputSchema: {
      type: "object" as const,
      properties: {
        port: {
          type: "number",
          description: "Port to run the web server on (default: 3847)",
          default: 3847,
        },
      },
    },
    annotations: {
      title: "Launch Web Interface",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "consolidate",
    description: "Run memory consolidation to compress episodes into memories and memories into digests. Like sleep for the memory system. Requires ANTHROPIC_API_KEY. Use periodically or when explicitly requested.",
    inputSchema: {
      type: "object" as const,
      properties: {
        mode: {
          type: "string",
          enum: ["full", "episodes_only", "memories_only"],
          description: "What to consolidate: 'full' (default) runs everything, 'episodes_only' just processes conversation history, 'memories_only' creates digests",
          default: "full",
        },
      },
    },
    annotations: {
      title: "Consolidate Memories",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,  // Calls Anthropic API for consolidation
    },
  },
  {
    name: "memory_feedback",
    description: "Signal which memories from a recall were actually useful. Call AFTER using memories to answer user's question. This enables the memory system to learn which memories help together (Hebbian learning). Optional but improves memory quality over time.",
    inputSchema: {
      type: "object" as const,
      properties: {
        recall_id: {
          type: "string",
          description: "The recall_id from the recall response",
        },
        useful_memory_ids: {
          type: "array",
          items: { type: "string" },
          description: "IDs of memories that actually helped answer the question. Empty array if none were useful.",
        },
        need_more: {
          type: "boolean",
          description: "Set true if the memories were insufficient and you need a deeper search with more results",
          default: false,
        },
      },
      required: ["recall_id", "useful_memory_ids"],
    },
    annotations: {
      title: "Memory Feedback",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "remember": {
        const {
          content,
          source = "conversation",
          importance = 0.5,
          emotional_weight = 0.5,
          event_time,
          entities: providedEntities = [],
          relationships: providedRelationships = [],
        } = args as {
          content: string;
          source?: string;
          importance?: number;
          emotional_weight?: number;
          event_time?: string;
          entities?: Array<{ name: string; type: "person" | "organization" | "place" }>;
          relationships?: Array<{ from: string; to: string; type: string }>;
        };

        // Create memory with new temporal and salience fields
        const memory = db.createMemory(content, source, importance, {
          eventTime: event_time ? new Date(event_time) : undefined,
          emotionalWeight: emotional_weight,
        });

        // Index for semantic search
        await search.indexMemory(memory);

        // Store Claude-provided entities and link to memory
        const storedEntities: string[] = [];
        for (const ent of providedEntities) {
          const entity = graph.getOrCreateEntity(ent.name, ent.type);
          storedEntities.push(entity.name);
          // Create observation linking entity to this memory
          db.addObservation(entity.id, content, memory.id, 1.0);
        }

        // Store Claude-provided relationships
        const storedRelations: string[] = [];
        for (const rel of providedRelationships) {
          try {
            // Ensure both entities exist (create if not provided explicitly)
            const fromEntity = graph.getOrCreateEntity(rel.from, "person");
            const toEntity = graph.getOrCreateEntity(rel.to, "person");
            graph.relate(fromEntity.name, toEntity.name, rel.type);
            storedRelations.push(`${rel.from} -[${rel.type}]-> ${rel.to}`);
          } catch {
            // Skip invalid relationships
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                memory_id: memory.id,
                entities_stored: storedEntities,
                relationships_stored: storedRelations,
              }, null, 2),
            },
          ],
        };
      }

      case "recall": {
        const { query, limit = 5, include_graph = true } = args as {
          query: string;
          limit?: number;
          include_graph?: boolean;
        };

        const response = await search.search(query, {
          limit,
          includeGraph: include_graph,
        });

        const formatted = response.results.map((r) => ({
          id: r.memory.id,
          content: r.memory.content,
          source: r.memory.source,
          timestamp: r.memory.timestamp.toISOString(),
          relevance_score: r.score.toFixed(4),
          retention: r.retention.toFixed(2),  // How well-retained (0-1)
          matched_via: Object.entries(r.sources)
            .filter(([, v]) => v !== undefined)
            .map(([k]) => k)
            .join(", "),
        }));

        // Format connected memories (Hebbian associations)
        const connectedFormatted = response.connected_memories.map((c) => ({
          id: c.memory.id,
          content: c.memory.content,
          connected_to: c.connected_to,
          connection_strength: c.strength.toFixed(2),
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                recall_id: response.recall_id,  // For memory_feedback
                query,
                results: formatted,
                count: formatted.length,
                connected_memories: connectedFormatted,
                hint: formatted.length > 0 ? "Call memory_feedback with useful_memory_ids after answering" : undefined,
              }, null, 2),
            },
          ],
        };
      }

      case "forget": {
        const { id } = args as { id: string };

        const memory = db.getMemory(id);
        if (!memory) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ success: false, error: "Memory not found" }),
              },
            ],
          };
        }

        // Remove from semantic index
        await search.removeFromIndex(id);

        // Soft-delete: mark as disabled instead of hard delete
        db.updateMemory(id, { disabled: true });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, disabled_id: id, message: "Memory disabled (soft-deleted)" }),
            },
          ],
        };
      }

      case "edit_memory": {
        const { id, content, importance } = args as {
          id: string;
          content?: string;
          importance?: number;
        };

        const memory = db.getMemory(id);
        if (!memory) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ success: false, error: "Memory not found" }),
              },
            ],
          };
        }

        // Build updates object
        const updates: { content?: string; importance?: number } = {};
        if (content !== undefined) updates.content = content;
        if (importance !== undefined) updates.importance = importance;

        if (Object.keys(updates).length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ success: false, error: "No updates provided" }),
              },
            ],
          };
        }

        // Update the memory
        const updated = db.updateMemory(id, updates);

        // Re-index if content changed
        if (content !== undefined && updated) {
          await search.removeFromIndex(id);
          await search.indexMemory(updated);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                memory_id: id,
                updated_fields: Object.keys(updates),
              }),
            },
          ],
        };
      }

      case "engram_web": {
        const { port = 3847 } = args as { port?: number };

        // Check if a server is already running (from any MCP instance)
        const existingUrl = getRunningServerUrl();
        if (existingUrl) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  url: existingUrl,
                  message: `Web interface already running at ${existingUrl}`,
                  reused: true,
                }, null, 2),
              },
            ],
          };
        }

        // Create or reuse web server
        if (!webServer) {
          webServer = new EngramWebServer({ db, graph, search, port });
        }

        const url = await webServer.start();

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                url,
                message: `Web interface running at ${url}`,
              }, null, 2),
            },
          ],
        };
      }

      case "consolidate": {
        const { mode = "full" } = args as { mode?: "full" | "episodes_only" | "memories_only" };

        if (!consolidator.isConfigured()) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  error: "Consolidation requires ANTHROPIC_API_KEY environment variable",
                }),
              },
            ],
            isError: true,
          };
        }

        let result;
        switch (mode) {
          case "episodes_only":
            result = await consolidator.consolidateEpisodes();
            break;
          case "memories_only":
            result = await consolidator.consolidate();
            break;
          case "full":
          default:
            result = await consolidator.runSleepCycle();
            break;
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                mode,
                ...result,
              }, null, 2),
            },
          ],
        };
      }

      case "memory_feedback": {
        const { recall_id, useful_memory_ids, need_more = false } = args as {
          recall_id: string;
          useful_memory_ids: string[];
          need_more?: boolean;
        };

        // First, get the original recall to validate useful_memory_ids
        const retrievalLog = db.getRetrievalLog(recall_id);
        if (!retrievalLog) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  error: `Recall ID not found: ${recall_id}`,
                }),
              },
            ],
          };
        }

        // Validate: only accept IDs that were in the original recall
        const originalIdSet = new Set(retrievalLog.memory_ids);
        const validUsefulIds = useful_memory_ids.filter(id => originalIdSet.has(id));
        const invalidIds = useful_memory_ids.filter(id => !originalIdSet.has(id));

        if (invalidIds.length > 0) {
          console.error(`[Engram] memory_feedback: ${invalidIds.length} IDs not in original recall, ignored: ${invalidIds.join(", ")}`);
        }

        // Update the retrieval log with validated feedback
        const updated = db.updateRetrievalFeedback(recall_id, validUsefulIds, need_more);

        if (!updated) {
          // Should not happen since we already checked above, but handle gracefully
          console.error(`[Engram] memory_feedback: failed to update retrieval log ${recall_id}`);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  error: `Failed to update feedback for: ${recall_id}`,
                }),
              },
            ],
          };
        }

        // If need_more is set, do an expanded search
        if (need_more) {
          const expandedResponse = await search.expandSearch(recall_id);

          const formatted = expandedResponse.results.map((r) => ({
            id: r.memory.id,
            content: r.memory.content,
            source: r.memory.source,
            timestamp: r.memory.timestamp.toISOString(),
            relevance_score: r.score.toFixed(4),
            matched_via: Object.entries(r.sources)
              .filter(([, v]) => v !== undefined)
              .map(([k]) => k)
              .join(", "),
          }));

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  feedback_recorded: true,
                  useful_count: validUsefulIds.length,
                  expanded_search: true,
                  additional_results: formatted,
                  additional_count: formatted.length,
                }, null, 2),
              },
            ],
          };
        }

        // Process deferred learning if we have enough feedback
        const unprocessed = db.getUnprocessedRetrievalLogs(50);
        let learningApplied = 0;

        for (const log of unprocessed) {
          if (log.useful_ids && log.useful_ids.length >= 2) {
            // Strengthen connections between useful memories
            db.recordCoUseful(log.useful_ids);
            learningApplied++;
          }
        }

        if (unprocessed.length > 0) {
          db.markRetrievalLogsProcessed(unprocessed.map(l => l.id));
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                feedback_recorded: true,
                useful_count: validUsefulIds.length,
                learning_applied: learningApplied > 0,
                connections_strengthened: learningApplied,
              }, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ success: false, error: message }),
        },
      ],
      isError: true,
    };
  }
});

// ============ Main ============

async function main() {
  await initialize();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[Engram] MCP server running on stdio");
}

main().catch((error) => {
  console.error("[Engram] Fatal error:", error);
  process.exit(1);
});
