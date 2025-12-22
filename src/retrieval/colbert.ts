/**
 * ColBERT retriever - TypeScript wrapper for Python bridge
 */

import { spawn, ChildProcess } from "child_process";
import { createInterface, Interface } from "readline";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Python bridge is in src/, not dist/ - go up from dist/retrieval to project root, then into src/
const BRIDGE_PATH = path.join(__dirname, "..", "..", "src", "retrieval", "colbert-bridge.py");

export interface Document {
  id: string;
  content: string;
}

export interface SearchResult {
  id: string;
  score: number;
  content: string;
}

interface BridgeResponse {
  status?: string;
  success?: boolean;
  count?: number;
  results?: SearchResult[];
  error?: string;
}

export class ColBERTRetriever {
  private process: ChildProcess | null = null;
  private readline: Interface | null = null;
  private pendingRequests: Map<number, {
    resolve: (value: BridgeResponse) => void;
    reject: (error: Error) => void;
  }> = new Map();
  private requestId = 0;
  private ready = false;
  private readyPromise: Promise<void>;
  private readyResolve: (() => void) | null = null;
  private buffer = "";

  constructor(private indexPath: string) {
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });
  }

  /**
   * Start the Python bridge process
   */
  async start(): Promise<void> {
    if (this.process) return;

    this.process = spawn("python3", [BRIDGE_PATH], {
      env: {
        ...process.env,
        ENGRAM_INDEX_PATH: this.indexPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.readline = createInterface({
      input: this.process.stdout!,
      crlfDelay: Infinity,
    });

    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    this.process.stderr?.on("data", (data) => {
      // Log Python errors for debugging
      console.error(`[ColBERT] ${data.toString()}`);
    });

    this.process.on("exit", (code) => {
      console.error(`[ColBERT] Process exited with code ${code}`);
      this.ready = false;
      this.process = null;
      this.readline = null;
    });

    // Wait for ready signal
    await this.readyPromise;
  }

  private handleLine(line: string): void {
    try {
      const response = JSON.parse(line) as BridgeResponse;

      // Check for ready signal
      if (response.status === "ready") {
        this.ready = true;
        this.readyResolve?.();
        return;
      }

      // Handle response (simple protocol - responses come in order)
      const oldest = Array.from(this.pendingRequests.entries())[0];
      if (oldest) {
        const [id, { resolve }] = oldest;
        this.pendingRequests.delete(id);
        resolve(response);
      }
    } catch (error) {
      console.error(`[ColBERT] Failed to parse: ${line}`);
    }
  }

  private async send(command: Record<string, unknown>): Promise<BridgeResponse> {
    if (!this.process || !this.ready) {
      await this.start();
    }

    return new Promise((resolve, reject) => {
      const id = this.requestId++;
      this.pendingRequests.set(id, { resolve, reject });

      const json = JSON.stringify(command) + "\n";
      this.process!.stdin!.write(json);
    });
  }

  /**
   * Index documents for search
   */
  async index(documents: Document[]): Promise<{ success: boolean; count: number }> {
    const response = await this.send({
      action: "index",
      documents,
    });

    return {
      success: response.success ?? false,
      count: response.count ?? 0,
    };
  }

  /**
   * Add documents to existing index
   */
  async add(documents: Document[]): Promise<{ success: boolean; count: number }> {
    const response = await this.send({
      action: "add",
      documents,
    });

    return {
      success: response.success ?? false,
      count: response.count ?? 0,
    };
  }

  /**
   * Search for documents
   */
  async search(query: string, k: number = 10): Promise<SearchResult[]> {
    const response = await this.send({
      action: "search",
      query,
      k,
    });

    return response.results ?? [];
  }

  /**
   * Rerank documents using ColBERT
   */
  async rerank(query: string, documents: Document[], k: number = 10): Promise<SearchResult[]> {
    const response = await this.send({
      action: "rerank",
      query,
      documents,
      k,
    });

    return response.results ?? [];
  }

  /**
   * Delete documents from index
   */
  async delete(ids: string[]): Promise<{ success: boolean; count: number }> {
    const response = await this.send({
      action: "delete",
      ids,
    });

    return {
      success: response.success ?? false,
      count: response.count ?? 0,
    };
  }

  /**
   * Check if bridge is ready
   */
  async ping(): Promise<boolean> {
    try {
      const response = await this.send({ action: "ping" });
      return response.status === "ok";
    } catch {
      return false;
    }
  }

  /**
   * Stop the Python bridge
   */
  async stop(): Promise<void> {
    if (this.process) {
      try {
        await this.send({ action: "quit" });
      } catch {
        // Ignore errors during shutdown
      }
      this.process.kill();
      this.process = null;
      this.readline = null;
      this.ready = false;
    }
  }
}

/**
 * Fallback retriever when ColBERT is not available
 * Uses simple TF-IDF-like scoring
 */
export class SimpleRetriever {
  private documents: Map<string, Document> = new Map();

  async index(documents: Document[]): Promise<{ success: boolean; count: number }> {
    for (const doc of documents) {
      this.documents.set(doc.id, doc);
    }
    return { success: true, count: documents.length };
  }

  async add(documents: Document[]): Promise<{ success: boolean; count: number }> {
    return this.index(documents);
  }

  async search(query: string, k: number = 10): Promise<SearchResult[]> {
    const queryTerms = query.toLowerCase().split(/\s+/);
    const results: SearchResult[] = [];

    for (const [id, doc] of this.documents) {
      const contentLower = doc.content.toLowerCase();
      let score = 0;

      for (const term of queryTerms) {
        if (contentLower.includes(term)) {
          score += 1;
        }
      }

      if (score > 0) {
        results.push({ id, score: score / queryTerms.length, content: doc.content });
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  async rerank(query: string, documents: Document[], k: number = 10): Promise<SearchResult[]> {
    const temp = new Map(this.documents);
    this.documents.clear();

    for (const doc of documents) {
      this.documents.set(doc.id, doc);
    }

    const results = await this.search(query, k);
    this.documents = temp;

    return results;
  }

  async delete(ids: string[]): Promise<{ success: boolean; count: number }> {
    let count = 0;
    for (const id of ids) {
      if (this.documents.delete(id)) {
        count++;
      }
    }
    return { success: true, count };
  }
}

/**
 * Create the best available retriever
 */
export async function createRetriever(indexPath: string): Promise<ColBERTRetriever | SimpleRetriever> {
  const colbert = new ColBERTRetriever(indexPath);

  try {
    await colbert.start();
    if (await colbert.ping()) {
      console.error("[Engram] Using ColBERT retriever");
      return colbert;
    }
  } catch (error) {
    console.error("[Engram] ColBERT not available, using simple retriever:", error);
  }

  console.error("[Engram] Using simple fallback retriever");
  return new SimpleRetriever();
}
