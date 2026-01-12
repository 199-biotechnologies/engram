/**
 * Transport layer for Engram MCP Server
 * Supports both stdio (local) and HTTP (remote/Railway) transports
 */

export type TransportMode = "stdio" | "http";

/**
 * Detect transport mode from environment variables
 * Default: stdio (preserves existing behavior)
 */
export function getTransportMode(): TransportMode {
  const mode = process.env.ENGRAM_TRANSPORT?.toLowerCase();
  if (mode === "http" || mode === "sse") return "http";
  return "stdio";
}

/**
 * Get HTTP port from environment
 * Railway provides PORT, we also support ENGRAM_MCP_PORT
 */
export function getHttpPort(): number {
  return parseInt(process.env.PORT || process.env.ENGRAM_MCP_PORT || "3000", 10);
}
