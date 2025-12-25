/**
 * Hybrid Search with Reciprocal Rank Fusion (RRF)
 * Combines BM25 (keyword) and ColBERT (semantic) search
 * Enhanced with temporal decay and salience scoring
 */

import { EngramDatabase, Memory } from "../storage/database.js";
import { KnowledgeGraph } from "../graph/knowledge-graph.js";
import { ColBERTRetriever, SimpleRetriever, SearchResult, Document } from "./colbert.js";

export interface HybridSearchResult {
  memory: Memory;
  score: number;
  retention: number;  // 0-1 how well-retained this memory is
  sources: {
    bm25?: number;
    semantic?: number;
    graph?: number;
  };
}

/**
 * Calculate Ebbinghaus forgetting curve retention
 * R = e^(-t/S) where t=time since last access, S=stability
 *
 * Higher stability = slower forgetting
 * Recent access = higher retention
 */
function calculateRetention(memory: Memory, now: Date): number {
  // Use last_accessed if available, otherwise timestamp
  const lastActive = memory.last_accessed || memory.timestamp;
  const daysSinceAccess = (now.getTime() - lastActive.getTime()) / (1000 * 60 * 60 * 24);

  // Stability is our memory strength (default 1.0, increases with recalls)
  const stability = memory.stability || 1.0;

  // Half-life in days = stability * 7 (so stability=1 means 7-day half-life)
  const halfLife = stability * 7;

  // Exponential decay: R = e^(-0.693 * t / halfLife)
  const retention = Math.exp(-0.693 * daysSinceAccess / halfLife);

  return Math.max(0, Math.min(1, retention));
}

/**
 * Calculate salience score - how important/memorable is this?
 * Combines emotional weight, importance, and access patterns
 */
function calculateSalience(memory: Memory): number {
  const importance = memory.importance || 0.5;
  const emotionalWeight = memory.emotional_weight || 0.5;
  const accessBonus = Math.min(1, Math.log(1 + (memory.access_count || 0)) / 5);

  // Weighted combination
  return (importance * 0.4) + (emotionalWeight * 0.4) + (accessBonus * 0.2);
}

/**
 * Apply temporal and salience adjustments to search results
 */
function adjustScore(memory: Memory, baseScore: number, now: Date): { adjusted: number; retention: number } {
  const retention = calculateRetention(memory, now);
  const salience = calculateSalience(memory);

  // Final score = base * (0.5 + 0.3*retention + 0.2*salience)
  // This means: 50% retrieval match, 30% recency/stability, 20% importance
  const multiplier = 0.5 + (0.3 * retention) + (0.2 * salience);

  return {
    adjusted: baseScore * multiplier,
    retention,
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
   *
   * Strategy: BM25 gets candidates fast, ColBERT reranks for quality
   * This is both FASTER (fewer ColBERT computations) and BETTER (combines keyword + semantic)
   */
  async search(
    query: string,
    options: {
      limit?: number;
      includeGraph?: boolean;
      bm25Weight?: number;
      semanticWeight?: number;
      graphWeight?: number;
      useReranking?: boolean;  // Use ColBERT to rerank BM25 results
    } = {}
  ): Promise<HybridSearchResult[]> {
    const {
      limit = 10,
      includeGraph = true,
      bm25Weight = 1.0,
      semanticWeight = 1.0,
      graphWeight = 0.5,
      useReranking = true,  // Default: reranking mode for better quality
    } = options;

    // Fetch more candidates than needed for fusion
    const candidateLimit = Math.max(limit * 3, 30);

    // Run BM25 and graph search in parallel (fast)
    const [bm25Results, graphMemoryIds] = await Promise.all([
      this.searchBM25(query, candidateLimit),
      includeGraph ? this.searchGraph(query) : Promise.resolve([]),
    ]);

    // For semantic: either rerank BM25 results (faster+better) or search full index
    let semanticResults: Array<{ id: string; score: number }>;
    if (useReranking && bm25Results.length > 0) {
      // Rerank BM25 candidates with ColBERT - faster AND better quality
      const docs = bm25Results.map(r => ({ id: r.id, content: this.db.getMemory(r.id)?.content || '' }));
      const reranked = await this.retriever.rerank(query, docs, candidateLimit);
      semanticResults = reranked.map(r => ({ id: r.id, score: r.score }));
    } else {
      // Full semantic search
      semanticResults = await this.searchSemantic(query, candidateLimit);
    }

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

    // Get results with full memory data and apply temporal adjustments
    const now = new Date();
    const adjustedResults: Array<HybridSearchResult & { originalScore: number }> = [];

    for (const { id, score, sources } of rrfScores) {
      const memory = this.db.getMemory(id);
      if (memory) {
        // Apply Ebbinghaus decay and salience scoring
        const { adjusted, retention } = adjustScore(memory, score, now);

        adjustedResults.push({
          memory,
          score: adjusted,
          retention,
          originalScore: score,
          sources: {
            bm25: sources.bm25,
            semantic: sources.semantic,
            graph: sources.graph,
          },
        });
      }
    }

    // Re-sort by adjusted score (accounts for recency/stability)
    adjustedResults.sort((a, b) => b.score - a.score);

    // Take top results and update access counts
    const results: HybridSearchResult[] = [];
    for (const result of adjustedResults.slice(0, limit)) {
      // Update access count (which also increases stability for future searches)
      this.db.touchMemory(result.memory.id);

      results.push({
        memory: result.memory,
        score: result.score,
        retention: result.retention,
        sources: result.sources,
      });
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
   * Graph-based search: find known entities in query, traverse graph
   */
  private async searchGraph(query: string): Promise<string[]> {
    // Find known entities whose names appear in the query
    const queryLower = query.toLowerCase();
    const allEntities = this.graph.listEntities(undefined, 500);
    const matchedEntities = allEntities.filter(e =>
      queryLower.includes(e.name.toLowerCase())
    );

    const memoryIds = new Set<string>();

    for (const entity of matchedEntities) {
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
