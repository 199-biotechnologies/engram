/**
 * Engram Web Interface
 * Local web server for browsing, searching, and editing memories
 */

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { EngramDatabase } from "../storage/database.js";
import { KnowledgeGraph } from "../graph/knowledge-graph.js";
import { HybridSearch } from "../retrieval/hybrid.js";
import { ColBERTRetriever, SimpleRetriever } from "../retrieval/colbert.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STATIC_DIR = path.join(__dirname, "..", "..", "src", "web", "static");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

interface WebServerOptions {
  db: EngramDatabase;
  graph: KnowledgeGraph;
  search: HybridSearch;
  port?: number;
}

export class EngramWebServer {
  private server: http.Server | null = null;
  private db: EngramDatabase;
  private graph: KnowledgeGraph;
  private search: HybridSearch;
  private port: number;

  constructor(options: WebServerOptions) {
    this.db = options.db;
    this.graph = options.graph;
    this.search = options.search;
    this.port = options.port || 3847;
  }

  async start(): Promise<string> {
    if (this.server) {
      return `http://localhost:${this.port}`;
    }

    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    return new Promise((resolve, reject) => {
      this.server!.listen(this.port, () => {
        const url = `http://localhost:${this.port}`;
        console.error(`[Engram] Web interface running at ${url}`);
        resolve(url);
      });

      this.server!.on("error", reject);
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://localhost:${this.port}`);
    const pathname = url.pathname;

    // CORS headers for local development
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // API routes
      if (pathname.startsWith("/api/")) {
        await this.handleAPI(req, res, pathname, url);
        return;
      }

      // Static files
      await this.serveStatic(req, res, pathname);
    } catch (error) {
      console.error("[Engram Web] Error:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }

  private async handleAPI(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    url: URL
  ): Promise<void> {
    const method = req.method || "GET";
    const body = method !== "GET" ? await this.parseBody(req) : null;

    res.setHeader("Content-Type", "application/json");

    // GET /api/stats
    if (pathname === "/api/stats" && method === "GET") {
      const stats = this.db.getStats();
      res.end(JSON.stringify(stats));
      return;
    }

    // GET /api/memories
    if (pathname === "/api/memories" && method === "GET") {
      const query = url.searchParams.get("q");
      const limit = parseInt(url.searchParams.get("limit") || "50");

      if (query) {
        const results = await this.search.search(query, { limit });
        res.end(JSON.stringify({
          memories: results.map(r => ({
            ...r.memory,
            score: r.score,
            sources: r.sources,
          })),
        }));
      } else {
        const memories = this.db.getAllMemories(limit);
        res.end(JSON.stringify({ memories }));
      }
      return;
    }

    // POST /api/memories
    if (pathname === "/api/memories" && method === "POST") {
      const { content, source, importance } = body as any;
      const memory = this.db.createMemory(content, source || "web", importance || 0.5);
      await this.search.indexMemory(memory);
      const { entities, observations } = this.graph.extractAndStore(content, memory.id);
      res.writeHead(201);
      res.end(JSON.stringify({ memory, entities_extracted: entities.length, observations_created: observations.length }));
      return;
    }

    // PUT /api/memories/:id
    const memoryMatch = pathname.match(/^\/api\/memories\/([a-f0-9-]+)$/);
    if (memoryMatch && method === "PUT") {
      const id = memoryMatch[1];
      const { content, importance } = body as any;
      const updated = this.db.updateMemory(id, { content, importance });
      if (updated) {
        res.end(JSON.stringify({ memory: updated }));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Memory not found" }));
      }
      return;
    }

    // DELETE /api/memories/:id
    if (memoryMatch && method === "DELETE") {
      const id = memoryMatch[1];
      await this.search.removeFromIndex(id);
      const deleted = this.db.deleteMemory(id);
      res.end(JSON.stringify({ success: deleted }));
      return;
    }

    // GET /api/entities
    if (pathname === "/api/entities" && method === "GET") {
      const type = url.searchParams.get("type") as any;
      const limit = parseInt(url.searchParams.get("limit") || "100");
      const entities = this.graph.listEntities(type || undefined, limit);
      res.end(JSON.stringify({ entities }));
      return;
    }

    // GET /api/entities/:name
    const entityMatch = pathname.match(/^\/api\/entities\/(.+)$/);
    if (entityMatch && method === "GET") {
      const name = decodeURIComponent(entityMatch[1]);
      const details = this.graph.getEntityDetails(name);
      if (details) {
        res.end(JSON.stringify(details));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Entity not found" }));
      }
      return;
    }

    // GET /api/graph
    if (pathname === "/api/graph" && method === "GET") {
      const entities = this.graph.listEntities(undefined, 500);
      const nodes = entities.map(e => ({
        id: e.id,
        label: e.name,
        type: e.type,
      }));

      // Get all relations
      const edges: Array<{ from: string; to: string; label: string }> = [];
      for (const entity of entities) {
        const relations = this.db.getEntityRelations(entity.id, "from");
        for (const rel of relations) {
          edges.push({
            from: rel.from_entity,
            to: rel.to_entity,
            label: rel.type,
          });
        }
      }

      res.end(JSON.stringify({ nodes, edges }));
      return;
    }

    // GET /api/tidy - analyze duplicates
    if (pathname === "/api/tidy" && method === "GET") {
      const duplicates = this.db.findDuplicateEntities();
      res.end(JSON.stringify({
        duplicate_groups: duplicates.map((d) => ({
          keep: { id: d.entity.id, name: d.entity.name, type: d.entity.type },
          merge: d.potentialDuplicates.map((p) => ({
            id: p.id,
            name: p.name,
            type: p.type,
          })),
        })),
        total_duplicates: duplicates.reduce((sum, d) => sum + d.potentialDuplicates.length, 0),
      }));
      return;
    }

    // POST /api/tidy - merge duplicates
    if (pathname === "/api/tidy" && method === "POST") {
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

      res.end(JSON.stringify({
        entities_merged: totalMerged,
        observations_moved: observationsMoved,
        relations_moved: relationsMoved,
      }));
      return;
    }

    // 404 for unknown API routes
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  }

  private async serveStatic(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string
  ): Promise<void> {
    // Default to index.html
    if (pathname === "/" || pathname === "") {
      pathname = "/index.html";
    }

    const filePath = path.join(STATIC_DIR, pathname);

    // Security: prevent directory traversal
    if (!filePath.startsWith(STATIC_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    try {
      const content = fs.readFileSync(filePath);
      const ext = path.extname(filePath);
      const contentType = MIME_TYPES[ext] || "application/octet-stream";

      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  }

  private parseBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (e) {
          reject(e);
        }
      });
      req.on("error", reject);
    });
  }
}
