/**
 * HTTP Transport for Engram MCP Server
 * Uses StreamableHTTPServerTransport in stateless mode for Railway deployment
 */

import http from "http";
import { createRequire } from "module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json");

interface HttpServerOptions {
  port: number;
  server: Server;
}

/**
 * Start HTTP server with MCP transport
 * Returns a promise that resolves when server is listening
 */
export async function startHttpServer(options: HttpServerOptions): Promise<http.Server> {
  const { port, server } = options;

  // Create stateless transport (sessionIdGenerator: undefined)
  // Stateless mode is perfect for Railway - no session management needed
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  // Connect MCP server to transport
  await server.connect(transport);

  // Create HTTP server
  const httpServer = http.createServer(async (req, res) => {
    // CORS headers for remote clients (ElevenLabs, etc.)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://localhost:${port}`);

    // Health check endpoint (Railway uses this)
    if (url.pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        transport: "http",
        version: pkg.version
      }));
      return;
    }

    // Root endpoint - service info
    if (url.pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        name: "engram",
        description: "MCP memory server with hybrid search",
        version: pkg.version,
        transport: "streamable-http",
        endpoints: {
          mcp: "/mcp",
          health: "/health",
        },
      }));
      return;
    }

    // MCP endpoint - handles both POST (messages) and GET (SSE stream)
    if (url.pathname === "/mcp") {
      try {
        await transport.handleRequest(req, res);
      } catch (error) {
        console.error("[Engram HTTP] Error handling MCP request:", error);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      }
      return;
    }

    // SSE alias (for clients expecting /sse endpoint)
    if (url.pathname === "/sse") {
      // Redirect to /mcp which handles SSE via GET
      res.writeHead(307, { "Location": "/mcp" });
      res.end();
      return;
    }

    // 404 for unknown paths
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  // Start listening
  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    const host = process.env.ENGRAM_HOST || "127.0.0.1";
    httpServer.listen(port, host, () => {
      console.error(`[Engram] MCP HTTP server running on ${host}:${port}`);
      console.error(`[Engram] Endpoints:`);
      console.error(`[Engram]   POST http://${host}:${port}/mcp - MCP protocol`);
      console.error(`[Engram]   GET  http://${host}:${port}/health - Health check`);
      resolve(httpServer);
    });
  });
}
