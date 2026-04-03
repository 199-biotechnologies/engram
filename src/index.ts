#!/usr/bin/env node
/**
 * Engram - High-quality personal memory for AI assistants
 *
 * Local-first MCP server with hybrid search (BM25 + semantic embeddings)
 * and a lightweight knowledge graph.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "module";
import path from "path";
import os from "os";
import fs from "fs";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

import { getTransportMode, getHttpPort } from "./transport/index.js";
import { startHttpServer } from "./transport/http.js";

import { EngramDatabase } from "./storage/database.js";
import { KnowledgeGraph } from "./graph/knowledge-graph.js";
import { createEmbedder, TransformersEmbedder } from "./retrieval/embedder.js";
import { HybridSearch } from "./retrieval/hybrid.js";
import { EngramWebServer, getRunningServerUrl } from "./web/server.js";
import { Consolidator } from "./consolidation/consolidator.js";

// ============ Configuration ============

const DB_PATH = process.env.ENGRAM_DB_PATH
  ? path.resolve(process.env.ENGRAM_DB_PATH.replace("~", os.homedir()))
  : path.join(os.homedir(), ".engram");

const DB_FILE = path.join(DB_PATH, "engram.db");
const PID_FILE = path.join(DB_PATH, "engram.pid");

// ============ Zombie Prevention ============

/**
 * Kill any existing engram process and clean up stale PID file
 */
function cleanupZombies(): void {
  try {
    if (fs.existsSync(PID_FILE)) {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        try {
          // Check if process exists
          process.kill(oldPid, 0);
          // It exists, kill it
          console.error(`[Engram] Killing old instance (PID ${oldPid})`);
          process.kill(oldPid, "SIGTERM");
        } catch {
          // Process doesn't exist, that's fine
        }
      }
      fs.unlinkSync(PID_FILE);
    }
  } catch (error) {
    console.error("[Engram] Error cleaning up zombies:", error);
  }
}

/**
 * Write our PID file
 */
function writePidFile(): void {
  try {
    // Ensure directory exists
    if (!fs.existsSync(DB_PATH)) {
      fs.mkdirSync(DB_PATH, { recursive: true });
    }
    fs.writeFileSync(PID_FILE, String(process.pid));
  } catch (error) {
    console.error("[Engram] Error writing PID file:", error);
  }
}

/**
 * Clean up on exit (guarded against double-run)
 */
let cleanedUp = false;
function cleanup(): void {
  if (cleanedUp) return;
  cleanedUp = true;

  try {
    if (fs.existsSync(PID_FILE)) {
      const storedPid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
      if (storedPid === process.pid) {
        fs.unlinkSync(PID_FILE);
      }
    }
    if (webServer) {
      webServer.stop();
    }
    if (db) {
      db.close();
    }
  } catch {
    // Ignore cleanup errors
  }
}

function gracefulExit(reason: string): void {
  console.error(`[Engram] ${reason}`);
  cleanup();
  // Force immediate exit to avoid ONNX/native module destructor crashes
  // The mutex error in libc++ happens during normal Node.js teardown;
  // _exit bypasses destructors entirely
  process.kill(process.pid, "SIGKILL");
}

// Register signal handlers early
process.on("SIGTERM", () => gracefulExit("Received SIGTERM, shutting down..."));
process.on("SIGINT", () => gracefulExit("Received SIGINT, shutting down..."));
process.on("exit", cleanup);

// Detect when parent process (Claude) dies by monitoring stdin
// Only needed in stdio mode
if (getTransportMode() === "stdio") {
  process.stdin.on("end", () => gracefulExit("stdin closed, parent process likely died. Shutting down..."));
  process.stdin.on("close", () => gracefulExit("stdin closed, shutting down..."));
}

// ============ Initialize Components ============

let db: EngramDatabase;
let graph: KnowledgeGraph;
let search: HybridSearch;
let retriever: TransformersEmbedder;
let consolidator: Consolidator;
let webServer: EngramWebServer | null = null;

async function initialize(): Promise<void> {
  console.error(`[Engram] Initializing with database at ${DB_FILE}`);

  db = new EngramDatabase(DB_FILE);
  graph = new KnowledgeGraph(db);

  retriever = await createEmbedder(db);
  search = new HybridSearch(db, graph, retriever);
  consolidator = new Consolidator(db, graph, search);

  const stats = db.getStats();
  console.error(`[Engram] Ready. Stats: ${JSON.stringify(stats)}`);
  if (consolidator.isConfigured()) {
    console.error(`[Engram] Consolidation enabled (ANTHROPIC_API_KEY found)`);
  }

  // Check if embedding model changed — if so, re-index everything
  const CURRENT_MODEL = 'mdbr-leaf-ir';
  const storedModel = db.getMetadata('embedding_model');
  const modelChanged = storedModel !== null && storedModel !== CURRENT_MODEL;

  if (modelChanged) {
    console.error(`[Engram] Embedding model changed (${storedModel} → ${CURRENT_MODEL}), clearing vector index...`);
    db.clearAllVectors();
  }
  db.setMetadata('embedding_model', CURRENT_MODEL);

  // Index unindexed memories in the background (don't block MCP startup)
  if (stats.memories > 0) {
    const vectorCount = db.getVectorCount();
    const unindexed = stats.memories - vectorCount;
    if (unindexed > 0) {
      console.error(`[Engram] ${vectorCount}/${stats.memories} memories indexed, ${unindexed} need indexing...`);
      // Run indexing in background — server is already responding to MCP calls
      (async () => {
        try {
          const indexedIds = db.getIndexedMemoryIds();
          const memories = db.getAllMemories();
          const toIndex = memories.filter(m => !indexedIds.has(m.id));
          if (toIndex.length > 0) {
            await search.indexBatch(toIndex);
            console.error(`[Engram] Background indexing complete: ${toIndex.length} memories indexed`);
          }
        } catch (error) {
          console.error(`[Engram] Background indexing error:`, error);
        }
      })();
    } else {
      console.error(`[Engram] All ${vectorCount} memories indexed (model: ${CURRENT_MODEL})`);
    }
  }
}

// ============ MCP Server ============

const server = new Server(
  {
    name: "engram",
    version: pkg.version,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool definitions with MCP 2025-11-25 annotations
// Descriptions written for AI agents: positive instructions, clear workflow
const TOOLS = [
  {
    name: "remember",
    description:
      "Store new information the user shares. Always call recall first to check for duplicates — if similar info exists, use edit_memory to update it instead. Extract entities (people, organizations, places) and relationships from the content. Workflow: recall → remember (if new) or edit_memory (if updating).",
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
      "Search stored memories. Call this at the START of every conversation and before answering any question about the user, their preferences, history, people they know, or anything previously discussed. Also call before remember to avoid storing duplicates. After using recalled memories to answer, call memory_feedback with which memories helped.",
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
    outputSchema: {
      type: "object" as const,
      properties: {
        context: {
          type: "array",
          items: { type: "string" },
          description: "Ranked list of relevant memories and digests",
        },
        _ids: {
          type: "array",
          items: { type: "string" },
          description: "Memory IDs for feedback",
        },
        _recall: {
          type: "string",
          description: "Recall ID for memory_feedback",
        },
      },
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
    description: "Soft-delete a memory by its ID. Use only when the user explicitly asks to remove or forget something. Get the memory ID from recall results first.",
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
    description: "Update an existing memory's content or importance. Use this when information has changed or was stored incorrectly — it preserves the memory's history, access count, and entity relationships. Preferred over forget+remember for corrections.",
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
    description: "Compress old memories into concise digests and detect contradictions — like sleep for the memory system. Requires ANTHROPIC_API_KEY. Run when the system hints consolidation is needed (shown in recall results) or when the user requests it.",
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
    description: "Report which recalled memories were useful for answering the user's question. Call this EVERY TIME after using recall results — it teaches the memory system which memories work well together (Hebbian learning), making future recalls more accurate. Pass the recall_id and the IDs of memories you actually used.",
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
  {
    name: "export_memories",
    description: "Export all memories, entities, and relationships as JSON for backup or migration.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
    annotations: {
      title: "Export Memories",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "import_memories",
    description: "Import memories from a JSON export. Use for restoring backups or migrating data.",
    inputSchema: {
      type: "object" as const,
      properties: {
        data: {
          type: "object",
          description: "JSON object with memories, entities, relations, observations arrays",
        },
      },
      required: ["data"],
    },
    annotations: {
      title: "Import Memories",
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

        // Duplicate detection: check if very similar memory already exists
        try {
          const [embedding] = await retriever.embed([content]);
          const similar = db.findSimilar(embedding, 0.92);
          if (similar.length > 0) {
            const existingMemory = db.getMemory(similar[0].memoryId);
            if (existingMemory) {
              return {
                content: [{
                  type: "text" as const,
                  text: JSON.stringify({
                    success: false,
                    duplicate: true,
                    existing_id: existingMemory.id,
                    existing_content: existingMemory.content,
                    similarity: (1 - similar[0].distance).toFixed(3),
                    message: "Very similar memory already exists. Use edit_memory to update it instead.",
                  }, null, 2),
                }],
              };
            }
          }
        } catch {
          // If embedding fails, proceed without duplicate check
        }

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

        // First, check for entity profiles matching query terms
        const queryWords = query.toLowerCase().split(/\s+/);
        const allEntities = graph.listEntities(undefined, 100);
        const matchedProfiles: string[] = [];
        const matchedEntityIds: string[] = [];

        for (const entity of allEntities) {
          const entityWords = entity.name.toLowerCase().split(/\s+/);
          if (entityWords.some(w => queryWords.includes(w))) {
            const profile = db.getEntityProfile(entity.id);
            if (profile) {
              matchedProfiles.push(`[Profile: ${entity.name}] ${profile.content}`);
              matchedEntityIds.push(entity.id);
            }
          }
        }

        // Run hybrid search
        const response = await search.search(query, {
          limit,
          includeGraph: include_graph,
        });

        // Build lean context array - profiles first, then digests, then memories
        const context: string[] = [...matchedProfiles];

        // Add digests (L3 profiles already added, skip duplicates)
        for (const d of response.digests) {
          // Skip if this is an entity profile we already included
          if (d.digest.entity_id && matchedEntityIds.includes(d.digest.entity_id)) {
            continue;
          }
          const label = d.digest.level === 3 ? "Profile" :
                        d.digest.level === 2 ? "Topic" : "Summary";
          const topic = d.digest.topic ? `: ${d.digest.topic}` : "";
          context.push(`[${label}${topic}] ${d.digest.content}`);
        }

        // Format date: "Jan 5" for current year, "Jan 5 '24" for older
        const currentYear = new Date().getFullYear();
        const formatDate = (ts: Date) => {
          const month = ts.toLocaleDateString("en-US", { month: "short" });
          const day = ts.getDate();
          const year = ts.getFullYear();
          return year === currentYear ? `${month} ${day}` : `${month} ${day} '${String(year).slice(-2)}`;
        };

        // Add memories as simple dated entries, track IDs for feedback
        const memoryIds: string[] = [];
        for (const r of response.results) {
          context.push(`${formatDate(r.memory.timestamp)}: ${r.memory.content}`);
          memoryIds.push(r.memory.id);
        }

        // Add connected memories
        for (const c of response.connected_memories) {
          context.push(`${formatDate(c.memory.timestamp)}: ${c.memory.content}`);
          memoryIds.push(c.memory.id);
        }

        // Check if consolidation is needed
        const unconsolidated = db.countUnconsolidatedMemories();

        // Lean response with feedback support
        const result: Record<string, unknown> = {
          context,
          _ids: memoryIds,
          _recall: response.recall_id,
        };

        // Only add consolidation hint if needed (≥20 unconsolidated)
        if (unconsolidated >= 20) {
          result._consolidate = unconsolidated;
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
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

      case "export_memories": {
        const data = db.exportAll();
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(data, null, 2),
          }],
        };
      }

      case "import_memories": {
        const { data } = args as { data: any };
        const result = db.importAll(data);
        // Rebuild search index after import
        await search.rebuildIndex();
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, ...result }),
          }],
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
  const transportMode = getTransportMode();

  // Zombie cleanup only needed in stdio mode (local usage)
  if (transportMode === "stdio") {
    cleanupZombies();
    writePidFile();
  }

  await initialize();

  if (transportMode === "http") {
    // HTTP mode - for Railway/remote deployment
    const port = getHttpPort();
    await startHttpServer({ port, server });
    console.error(`[Engram] MCP server running in HTTP mode (PID ${process.pid})`);
  } else {
    // Stdio mode (default) - for local Claude Desktop/Cursor
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[Engram] MCP server running on stdio (PID ${process.pid})`);
  }
}

main().catch((error) => {
  console.error("[Engram] Fatal error:", error);
  process.exit(1);
});
