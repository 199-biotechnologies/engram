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
import { EngramWebServer } from "./web/server.js";

// ============ Configuration ============

const DB_PATH = process.env.ENGRAM_DB_PATH
  ? path.resolve(process.env.ENGRAM_DB_PATH.replace("~", os.homedir()))
  : path.join(os.homedir(), ".engram");

const DB_FILE = path.join(DB_PATH, "engram.db");

// ============ Initialize Components ============

let db: EngramDatabase;
let graph: KnowledgeGraph;
let search: HybridSearch;
let webServer: EngramWebServer | null = null;

async function initialize(): Promise<void> {
  console.error(`[Engram] Initializing with database at ${DB_FILE}`);

  db = new EngramDatabase(DB_FILE);
  graph = new KnowledgeGraph(db);

  const retriever = await createRetriever(DB_PATH);
  search = new HybridSearch(db, graph, retriever);

  // Rebuild index with existing memories
  const stats = db.getStats();
  if (stats.memories > 0) {
    console.error(`[Engram] Indexing ${stats.memories} existing memories...`);
    await search.rebuildIndex();
  }

  console.error(`[Engram] Ready. Stats: ${JSON.stringify(stats)}`);
}

// ============ MCP Server ============

const server = new Server(
  {
    name: "engram",
    version: "0.3.1",
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
      "PRIMARY STORAGE TOOL. Use this for ALL new information - conversations, facts, observations, notes. Automatically extracts people, organizations, and places as entities and creates relationships. Do NOT also call create_entity/observe/relate - remember handles entity extraction automatically. Only use remember once per piece of information.",
    inputSchema: {
      type: "object" as const,
      properties: {
        content: {
          type: "string",
          description: "The information to store - can be a conversation snippet, fact, observation, or note",
        },
        source: {
          type: "string",
          description: "Source of the memory (e.g., 'conversation', 'note', 'import')",
          default: "conversation",
        },
        importance: {
          type: "number",
          description: "Importance score from 0 to 1 (higher = more important). Use 0.7+ for key facts, 0.3- for casual mentions",
          minimum: 0,
          maximum: 1,
          default: 0.5,
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
      "PRIMARY SEARCH TOOL. Use this FIRST when answering any question about stored information. Searches across all memories using semantic understanding, keywords, and knowledge graph connections. Returns relevant memories with context.",
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
    description: "Delete a specific memory by its ID. Use only when explicitly asked to remove information.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "The memory ID to remove",
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
    name: "create_entity",
    description: "ADVANCED: Manually create an entity. Rarely needed - remember auto-extracts entities. Only use when: (1) creating an entity that won't appear in any memory content, or (2) correcting entity type after auto-extraction.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Entity name (e.g., 'John Smith', 'Paris', 'Machine Learning')",
        },
        type: {
          type: "string",
          enum: ["person", "place", "concept", "event", "organization"],
          description: "Type of entity",
        },
      },
      required: ["name", "type"],
    },
    annotations: {
      title: "Create Entity",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "observe",
    description: "ADVANCED: Add a fact to an EXISTING entity without creating a memory. Rarely needed - use remember instead, which stores the content AND links it to entities. Only use observe for adding metadata or corrections to entities.",
    inputSchema: {
      type: "object" as const,
      properties: {
        entity: {
          type: "string",
          description: "Entity name to add observation to (must already exist)",
        },
        observation: {
          type: "string",
          description: "The fact or observation to record",
        },
        confidence: {
          type: "number",
          description: "Confidence in this observation (0-1)",
          default: 1.0,
        },
      },
      required: ["entity", "observation"],
    },
    annotations: {
      title: "Add Observation",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "relate",
    description: "ADVANCED: Manually create a relationship between two entities. Rarely needed - remember auto-extracts relationships from text. Only use when: (1) the relationship wasn't captured by auto-extraction, or (2) you need to add a relationship not mentioned in any memory.",
    inputSchema: {
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
        relation: {
          type: "string",
          description: "Type of relationship (e.g., 'sibling', 'works_at', 'knows', 'located_in')",
        },
      },
      required: ["from", "to", "relation"],
    },
    annotations: {
      title: "Create Relationship",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "query_entity",
    description: "Get all stored information about a specific person, place, or organization. Use after recall to get deeper details about an entity mentioned in search results.",
    inputSchema: {
      type: "object" as const,
      properties: {
        entity: {
          type: "string",
          description: "Entity name to query",
        },
      },
      required: ["entity"],
    },
    annotations: {
      title: "Query Entity",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "list_entities",
    description: "List all known entities (people, places, organizations, etc.). Use to browse the knowledge graph or find entity names for query_entity.",
    inputSchema: {
      type: "object" as const,
      properties: {
        type: {
          type: "string",
          enum: ["person", "place", "concept", "event", "organization"],
          description: "Filter by entity type (optional)",
        },
        limit: {
          type: "number",
          description: "Maximum number of entities to return",
          default: 50,
        },
      },
    },
    annotations: {
      title: "List Entities",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "stats",
    description: "Get memory statistics (counts of memories, entities, relations, observations)",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
    annotations: {
      title: "Get Statistics",
      readOnlyHint: true,
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
        const { content, source = "conversation", importance = 0.5 } = args as {
          content: string;
          source?: string;
          importance?: number;
        };

        // Create memory
        const memory = db.createMemory(content, source, importance);

        // Index for semantic search
        await search.indexMemory(memory);

        // Extract and store entities/relationships
        const { entities, observations } = graph.extractAndStore(content, memory.id);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                memory_id: memory.id,
                entities_extracted: entities.map((e) => e.name),
                observations_created: observations.length,
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

        const results = await search.search(query, {
          limit,
          includeGraph: include_graph,
        });

        const formatted = results.map((r) => ({
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
                query,
                results: formatted,
                count: formatted.length,
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

        // Delete from database
        db.deleteMemory(id);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, deleted_id: id }),
            },
          ],
        };
      }

      case "create_entity": {
        const { name: entityName, type } = args as {
          name: string;
          type: "person" | "place" | "concept" | "event" | "organization";
        };

        const entity = graph.getOrCreateEntity(entityName, type);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                entity: {
                  id: entity.id,
                  name: entity.name,
                  type: entity.type,
                },
              }, null, 2),
            },
          ],
        };
      }

      case "observe": {
        const { entity: entityName, observation, confidence = 1.0 } = args as {
          entity: string;
          observation: string;
          confidence?: number;
        };

        // Ensure entity exists
        const entity = graph.getOrCreateEntity(entityName, "person");

        // Add observation
        const obs = graph.addObservation(entity.id, observation, undefined, confidence);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                entity: entity.name,
                observation_id: obs.id,
              }, null, 2),
            },
          ],
        };
      }

      case "relate": {
        const { from, to, relation } = args as {
          from: string;
          to: string;
          relation: string;
        };

        // Ensure both entities exist
        const fromEntity = graph.getOrCreateEntity(from, "person");
        const toEntity = graph.getOrCreateEntity(to, "person");

        // Create relation
        const rel = graph.relate(fromEntity.id, toEntity.id, relation);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                relation: {
                  id: rel.id,
                  from: fromEntity.name,
                  to: toEntity.name,
                  type: rel.type,
                },
              }, null, 2),
            },
          ],
        };
      }

      case "query_entity": {
        const { entity: entityName } = args as { entity: string };

        const details = graph.getEntityDetails(entityName);

        if (!details) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ success: false, error: "Entity not found" }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                entity: {
                  id: details.id,
                  name: details.name,
                  type: details.type,
                  created_at: details.created_at.toISOString(),
                },
                observations: details.observations.map((o) => ({
                  content: o.content.substring(0, 200) + (o.content.length > 200 ? "..." : ""),
                  confidence: o.confidence,
                  valid_from: o.valid_from.toISOString(),
                })),
                relations_from: details.relationsFrom.map((r) => ({
                  type: r.type,
                  to: r.targetEntity.name,
                })),
                relations_to: details.relationsTo.map((r) => ({
                  type: r.type,
                  from: r.sourceEntity.name,
                })),
              }, null, 2),
            },
          ],
        };
      }

      case "list_entities": {
        const { type, limit = 50 } = args as {
          type?: "person" | "place" | "concept" | "event" | "organization";
          limit?: number;
        };

        const entities = graph.listEntities(type, limit);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                entities: entities.map((e) => ({
                  id: e.id,
                  name: e.name,
                  type: e.type,
                })),
                count: entities.length,
              }, null, 2),
            },
          ],
        };
      }

      case "stats": {
        const stats = db.getStats();

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ...stats,
                database_path: DB_FILE,
              }, null, 2),
            },
          ],
        };
      }

      case "engram_web": {
        const { port = 3847 } = args as { port?: number };

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
