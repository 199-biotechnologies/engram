/**
 * Hybrid Search with Reciprocal Rank Fusion (RRF)
 * Combines BM25 (keyword) and ColBERT (semantic) search
 */

import { EngramDatabase, Memory } from "../storage/database.js";
import { KnowledgeGraph } from "../graph/knowledge-graph.js";
import { ColBERTRetriever, SimpleRetriever, SearchResult, Document } from "./colbert.js";
import { entityExtractor } from "../graph/extractor.js";

export interface HybridSearchResult {
  memory: Memory;
  score: number;
  sources: {
    bm25?: number;
    semantic?: number;
    graph?: number;
  };
}

export class HybridSearch {
  constructor(
    private db: EngramDatabase,
    private graph: KnowledgeGraph,
    private retriever: ColBERTRetriever | SimpleRetriever
  ) {}

  /**
   * Search using all available methods and fuse results
   */
  async search(
    query: string,
    options: {
      limit?: number;
      includeGraph?: boolean;
      bm25Weight?: number;
      semanticWeight?: number;
      graphWeight?: number;
    } = {}
  ): Promise<HybridSearchResult[]> {
    const {
      limit = 10,
      includeGraph = true,
      bm25Weight = 1.0,
      semanticWeight = 1.0,
      graphWeight = 0.5,
    } = options;

    // Fetch more candidates than needed for fusion
    const candidateLimit = Math.max(limit * 3, 30);

    // Run searches in parallel
    const [bm25Results, semanticResults, graphMemoryIds] = await Promise.all([
      this.searchBM25(query, candidateLimit),
      this.searchSemantic(query, candidateLimit),
      includeGraph ? this.searchGraph(query) : Promise.resolve([]),
    ]);

    // Fetch graph memories
    const graphMemories = graphMemoryIds.length > 0
      ? graphMemoryIds.map(id => this.db.getMemory(id)).filter(Boolean) as Memory[]
      : [];

    // Combine all candidate IDs
    const allCandidateIds = new Set<string>();
    bm25Results.forEach(r => allCandidateIds.add(r.id));
    semanticResults.forEach(r => allCandidateIds.add(r.id));
    graphMemories.forEach(m => allCandidateIds.add(m.id));

    if (allCandidateIds.size === 0) {
      return [];
    }

    // Create rankings for RRF
    const rankings: Map<string, { bm25?: number; semantic?: number; graph?: number }> = new Map();

    // BM25 ranking
    bm25Results.forEach((result, rank) => {
      const existing = rankings.get(result.id) || {};
      existing.bm25 = rank + 1; // 1-indexed rank
      rankings.set(result.id, existing);
    });

    // Semantic ranking
    semanticResults.forEach((result, rank) => {
      const existing = rankings.get(result.id) || {};
      existing.semantic = rank + 1;
      rankings.set(result.id, existing);
    });

    // Graph ranking (all equal - just presence matters)
    graphMemories.forEach((memory, rank) => {
      const existing = rankings.get(memory.id) || {};
      existing.graph = rank + 1;
      rankings.set(memory.id, existing);
    });

    // Calculate RRF scores
    const k = 60; // RRF constant
    const rrfScores: Array<{ id: string; score: number; sources: typeof rankings extends Map<string, infer V> ? V : never }> = [];

    for (const [id, ranks] of rankings) {
      let score = 0;

      if (ranks.bm25 !== undefined) {
        score += bm25Weight * (1 / (k + ranks.bm25));
      }
      if (ranks.semantic !== undefined) {
        score += semanticWeight * (1 / (k + ranks.semantic));
      }
      if (ranks.graph !== undefined) {
        score += graphWeight * (1 / (k + ranks.graph));
      }

      rrfScores.push({ id, score, sources: ranks });
    }

    // Sort by RRF score
    rrfScores.sort((a, b) => b.score - a.score);

    // Get top results with full memory data
    const results: HybridSearchResult[] = [];

    for (const { id, score, sources } of rrfScores.slice(0, limit)) {
      const memory = this.db.getMemory(id);
      if (memory) {
        // Update access count
        this.db.touchMemory(id);

        results.push({
          memory,
          score,
          sources: {
            bm25: sources.bm25,
            semantic: sources.semantic,
            graph: sources.graph,
          },
        });
      }
    }

    return results;
  }

  /**
   * BM25 keyword search via SQLite FTS5
   */
  private async searchBM25(query: string, limit: number): Promise<Array<{ id: string; score: number }>> {
    try {
      const results = this.db.searchBM25(query, limit);
      return results.map(r => ({ id: r.id, score: Math.abs(r.score) }));
    } catch {
      return [];
    }
  }

  /**
   * Semantic search via ColBERT
   */
  private async searchSemantic(query: string, limit: number): Promise<Array<{ id: string; score: number }>> {
    try {
      const results = await this.retriever.search(query, limit);
      return results.map(r => ({ id: r.id, score: r.score }));
    } catch {
      return [];
    }
  }

  /**
   * Graph-based search: find entities in query, traverse graph
   */
  private async searchGraph(query: string): Promise<string[]> {
    // Extract entities from query
    const entities = entityExtractor.extractAll(query);

    const memoryIds = new Set<string>();

    for (const entity of entities) {
      // Find related memory IDs through graph traversal
      const relatedIds = this.graph.findRelatedMemoryIds(entity.name, 2);
      relatedIds.forEach(id => memoryIds.add(id));
    }

    return Array.from(memoryIds);
  }

  /**
   * Add a memory to the semantic index
   */
  async indexMemory(memory: Memory): Promise<void> {
    await this.retriever.add([{
      id: memory.id,
      content: memory.content,
    }]);
  }

  /**
   * Rebuild the entire semantic index
   */
  async rebuildIndex(): Promise<{ count: number }> {
    const memories = this.db.getAllMemories();

    const documents: Document[] = memories.map(m => ({
      id: m.id,
      content: m.content,
    }));

    const result = await this.retriever.index(documents);
    return { count: result.count };
  }

  /**
   * Remove a memory from the semantic index
   */
  async removeFromIndex(memoryId: string): Promise<void> {
    await this.retriever.delete([memoryId]);
  }
}
