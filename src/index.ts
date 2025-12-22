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
    version: "0.4.1",
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
      "Store information with entities and relationships. Extract key people, organizations, and places from the content and pass them as entities. Include relationships between entities when mentioned (e.g., 'works_at', 'lives_in', 'knows').",
    inputSchema: {
      type: "object" as const,
      properties: {
        content: {
          type: "string",
          description: "The information to store",
        },
        importance: {
          type: "number",
          description: "0-1 score. Use 0.8+ for key facts (names, preferences, important events), 0.5 for general info, 0.3- for trivial mentions",
          minimum: 0,
          maximum: 1,
          default: 0.5,
        },
        entities: {
          type: "array",
          description: "Key entities mentioned (people, organizations, places). Only include clear, specific named entities.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Entity name (e.g., 'Boris Djordjevic', 'Google', 'Paris')" },
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
        const {
          content,
          source = "conversation",
          importance = 0.5,
          entities: providedEntities = [],
          relationships: providedRelationships = [],
        } = args as {
          content: string;
          source?: string;
          importance?: number;
          entities?: Array<{ name: string; type: "person" | "organization" | "place" }>;
          relationships?: Array<{ from: string; to: string; type: string }>;
        };

        // Create memory
        const memory = db.createMemory(content, source, importance);

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
