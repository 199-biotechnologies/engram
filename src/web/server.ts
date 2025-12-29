/**
 * Engram Web Interface
 * Local web server for browsing, searching, and editing memories
 */

import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { EngramDatabase } from "../storage/database.js";
import { KnowledgeGraph } from "../graph/knowledge-graph.js";
import { HybridSearch } from "../retrieval/hybrid.js";
import { ChatHandler } from "./chat-handler.js";
import { Consolidator } from "../consolidation/consolidator.js";
import { loadSettings, saveSettings, hasAnthropicApiKey } from "../settings.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STATIC_DIR = path.join(__dirname, "..", "..", "src", "web", "static");

// Port file for discovery - allows finding the running web server
const PORT_FILE = path.join(
  process.env.ENGRAM_DB_PATH?.replace("~", os.homedir()) || path.join(os.homedir(), ".engram"),
  "web-server.json"
);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

/**
 * Get the URL of a currently running Engram web server
 * Returns null if no server is running
 */
export function getRunningServerUrl(): string | null {
  try {
    if (fs.existsSync(PORT_FILE)) {
      const data = JSON.parse(fs.readFileSync(PORT_FILE, "utf-8"));
      const { port, pid } = data;

      // Check if process is still running
      try {
        process.kill(pid, 0); // Signal 0 = check if process exists
        return `http://localhost:${port}`;
      } catch {
        // Process not running, clean up stale file
        fs.unlinkSync(PORT_FILE);
      }
    }
  } catch {
    // File doesn't exist or can't be read
  }
  return null;
}

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
  private chat: ChatHandler;
  private consolidator: Consolidator;
  private port: number;

  constructor(options: WebServerOptions) {
    this.db = options.db;
    this.graph = options.graph;
    this.search = options.search;
    this.chat = new ChatHandler({
      db: options.db,
      graph: options.graph,
      search: options.search,
    });
    this.consolidator = new Consolidator(options.db);
    this.port = options.port || 3847;
  }

  async start(): Promise<string> {
    if (this.server) {
      return `http://localhost:${this.port}`;
    }

    // Check if another server is already running
    const existingUrl = getRunningServerUrl();
    if (existingUrl) {
      console.error(`[Engram] Web interface already running at ${existingUrl}`);
      return existingUrl;
    }

    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    // Try to start on preferred port, auto-increment if taken
    const maxAttempts = 10;
    let currentPort = this.port;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          this.server!.once("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "EADDRINUSE") {
              currentPort++;
              resolve(); // Try next port
            } else {
              reject(err);
            }
          });

          this.server!.listen(currentPort, () => {
            resolve();
          });
        });

        // If we get here without error, server is listening
        if (this.server!.listening) {
          this.port = currentPort;
          const url = `http://localhost:${this.port}`;

          // Write port file for discovery
          this.writePortFile();

          console.error(`[Engram] Web interface running at ${url}`);
          return url;
        }
      } catch (err) {
        if (attempt === maxAttempts - 1) {
          throw err;
        }
      }
    }

    throw new Error(`Could not find available port after ${maxAttempts} attempts`);
  }

  private writePortFile(): void {
    try {
      // Ensure directory exists
      const dir = path.dirname(PORT_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(PORT_FILE, JSON.stringify({
        port: this.port,
        pid: process.pid,
        started: new Date().toISOString(),
      }));
    } catch (err) {
      console.error("[Engram] Failed to write port file:", err);
    }
  }

  private removePortFile(): void {
    try {
      if (fs.existsSync(PORT_FILE)) {
        const data = JSON.parse(fs.readFileSync(PORT_FILE, "utf-8"));
        // Only remove if we wrote it
        if (data.pid === process.pid) {
          fs.unlinkSync(PORT_FILE);
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  stop(): void {
    if (this.server) {
      this.removePortFile();
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
      const offset = parseInt(url.searchParams.get("offset") || "0");

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
        const memories = this.db.getAllMemories(limit, false, offset);
        res.end(JSON.stringify({ memories }));
      }
      return;
    }

    // POST /api/memories
    if (pathname === "/api/memories" && method === "POST") {
      const { content, source, importance } = body as any;
      const memory = this.db.createMemory(content, source || "web", importance || 0.5);
      await this.search.indexMemory(memory);
      res.writeHead(201);
      res.end(JSON.stringify({ memory }));
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

    // ============ Settings Endpoints ============

    // GET /api/settings - get current settings (without exposing full API key)
    if (pathname === "/api/settings" && method === "GET") {
      const settings = loadSettings();
      res.end(JSON.stringify({
        has_api_key: hasAnthropicApiKey(),
        api_key_preview: settings.anthropic_api_key
          ? `${settings.anthropic_api_key.slice(0, 12)}...${settings.anthropic_api_key.slice(-4)}`
          : null,
        api_key_source: settings.anthropic_api_key
          ? "settings"
          : process.env.ANTHROPIC_API_KEY
            ? "environment"
            : null,
      }));
      return;
    }

    // POST /api/settings - update settings
    if (pathname === "/api/settings" && method === "POST") {
      const { anthropic_api_key } = body as { anthropic_api_key?: string };

      if (anthropic_api_key !== undefined) {
        const settings = loadSettings();
        if (anthropic_api_key === "") {
          // Clear the API key
          delete settings.anthropic_api_key;
        } else {
          settings.anthropic_api_key = anthropic_api_key;
        }
        saveSettings(settings);

        // Refresh the chat client
        this.chat.refreshClient();
        this.consolidator = new Consolidator(this.db); // Reinit consolidator
      }

      res.end(JSON.stringify({
        success: true,
        configured: this.chat.isConfigured(),
      }));
      return;
    }

    // GET /api/chat/status - check if chat is configured
    if (pathname === "/api/chat/status" && method === "GET") {
      res.end(JSON.stringify({
        configured: this.chat.isConfigured(),
        message: this.chat.isConfigured()
          ? "Chat is ready"
          : "Configure API key in Settings",
      }));
      return;
    }

    // POST /api/chat - send a message
    if (pathname === "/api/chat" && method === "POST") {
      const { message } = body as { message: string };
      if (!message) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Message is required" }));
        return;
      }

      const response = await this.chat.chat(message);
      res.end(JSON.stringify({ response }));
      return;
    }

    // POST /api/chat/clear - clear chat history
    if (pathname === "/api/chat/clear" && method === "POST") {
      this.chat.clearHistory();
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // POST /api/chat/stream - streaming chat with SSE
    if (pathname === "/api/chat/stream" && method === "POST") {
      const { message } = body as { message: string };
      if (!message) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Message is required" }));
        return;
      }

      // Check if chat is busy
      if (this.chat.isBusy()) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "Chat is busy",
          queue_length: this.chat.getQueueLength(),
        }));
        return;
      }

      // Set up SSE headers
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });

      // Stream events to client
      try {
        for await (const event of this.chat.chatStream(message)) {
          const data = JSON.stringify(event);
          res.write(`data: ${data}\n\n`);
        }
      } catch (error) {
        const errorEvent = {
          type: "error",
          content: error instanceof Error ? error.message : String(error),
        };
        res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
      }

      res.end();
      return;
    }

    // GET /api/chat/queue - check queue status
    if (pathname === "/api/chat/queue" && method === "GET") {
      res.end(JSON.stringify({
        busy: this.chat.isBusy(),
        queue_length: this.chat.getQueueLength(),
      }));
      return;
    }

    // ============ Consolidation Endpoints ============

    // GET /api/consolidation/status - get consolidation status
    if (pathname === "/api/consolidation/status" && method === "GET") {
      const status = this.consolidator.getStatus();
      res.end(JSON.stringify(status));
      return;
    }

    // POST /api/consolidation/run - run consolidation
    if (pathname === "/api/consolidation/run" && method === "POST") {
      if (!this.consolidator.isConfigured()) {
        res.writeHead(503);
        res.end(JSON.stringify({
          error: "Consolidation not available - set ANTHROPIC_API_KEY",
        }));
        return;
      }

      try {
        const result = await this.consolidator.consolidate();
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(500);
        res.end(JSON.stringify({
          error: error instanceof Error ? error.message : "Consolidation failed",
        }));
      }
      return;
    }

    // GET /api/digests - list all digests
    if (pathname === "/api/digests" && method === "GET") {
      const level = url.searchParams.get("level");
      const limit = parseInt(url.searchParams.get("limit") || "100");
      const digests = this.db.getDigests(
        level ? parseInt(level) : undefined,
        limit
      );
      res.end(JSON.stringify({ digests }));
      return;
    }

    // GET /api/digests/:id/sources - get source memories for a digest
    const digestSourcesMatch = pathname.match(/^\/api\/digests\/([a-f0-9-]+)\/sources$/);
    if (digestSourcesMatch && method === "GET") {
      const id = digestSourcesMatch[1];
      const sources = this.db.getDigestSources(id);
      res.end(JSON.stringify({ sources }));
      return;
    }

    // GET /api/contradictions - list contradictions
    if (pathname === "/api/contradictions" && method === "GET") {
      const resolved = url.searchParams.get("resolved");
      const limit = parseInt(url.searchParams.get("limit") || "100");
      const contradictions = this.db.getContradictions(
        resolved !== null ? resolved === "true" : undefined,
        limit
      );

      // Enrich with memory content
      const enriched = contradictions.map((c) => {
        const memA = this.db.getMemory(c.memory_id_a);
        const memB = this.db.getMemory(c.memory_id_b);
        const entity = c.entity_id ? this.db.getEntity(c.entity_id) : null;
        return {
          ...c,
          memory_a: memA,
          memory_b: memB,
          entity: entity,
        };
      });

      res.end(JSON.stringify({ contradictions: enriched }));
      return;
    }

    // POST /api/contradictions/:id/resolve - resolve a contradiction
    const resolveMatch = pathname.match(/^\/api\/contradictions\/([a-f0-9-]+)\/resolve$/);
    if (resolveMatch && method === "POST") {
      const id = resolveMatch[1];
      const { resolution } = body as { resolution: string };
      if (!resolution) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Resolution is required" }));
        return;
      }
      const success = this.db.resolveContradiction(id, resolution);
      res.end(JSON.stringify({ success }));
      return;
    }

    // DELETE /api/contradictions/:id - dismiss a contradiction
    const contradictionMatch = pathname.match(/^\/api\/contradictions\/([a-f0-9-]+)$/);
    if (contradictionMatch && method === "DELETE") {
      const id = contradictionMatch[1];
      const success = this.db.deleteContradiction(id);
      res.end(JSON.stringify({ success }));
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
