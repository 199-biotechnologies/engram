/**
 * Hybrid Search with Reciprocal Rank Fusion (RRF)
 * Combines BM25 (keyword) and semantic embedding search
 * Enhanced with temporal decay and salience scoring
 */

import { EngramDatabase, Memory, Digest } from "../storage/database.js";
import { KnowledgeGraph } from "../graph/knowledge-graph.js";
import { TransformersEmbedder, SearchResult, Document } from "./embedder.js";

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

export interface DigestSearchResult {
  digest: Digest;
  score: number;
  key_memories: Memory[];  // 2-3 source memories that best support this digest
}

export interface HybridSearchResponse {
  results: HybridSearchResult[];
  digests: DigestSearchResult[];  // Relevant synthesized context
  recall_id: string;  // For LLM feedback
  connected_memories: Array<{
    memory: Memory;
    connected_to: string;  // ID of the memory it's connected to
    strength: number;
  }>;
}

/**
 * Calculate Ebbinghaus forgetting curve retention
 * R = e^(-t/S) where t=time since last access, S=stability
 *
 * Higher stability = slower forgetting
 * Recent access = higher retention
 */
export function calculateRetention(memory: Memory, now: Date): number {
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
export function calculateSalience(memory: Memory): number {
  const importance = memory.importance || 0.5;
  const emotionalWeight = memory.emotional_weight || 0.5;
  const accessBonus = Math.min(1, Math.log(1 + (memory.access_count || 0)) / 5);

  // Weighted combination
  return (importance * 0.4) + (emotionalWeight * 0.4) + (accessBonus * 0.2);
}

/**
 * Apply temporal and salience adjustments to search results
 */
export function adjustScore(memory: Memory, baseScore: number, now: Date): { adjusted: number; retention: number } {
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
  private sessionId: string;

  constructor(
    private db: EngramDatabase,
    private graph: KnowledgeGraph,
    private retriever: TransformersEmbedder
  ) {
    // Generate a session ID for this search instance
    this.sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Generate a unique recall ID for tracking
   */
  private generateRecallId(): string {
    return `recall_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Search using all available methods and fuse results
   *
   * Strategy: BM25 + vector KNN + graph run in parallel, fused via RRF
   * Vectors are pre-computed in sqlite-vec so no reranking needed
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
  ): Promise<HybridSearchResponse> {
    const {
      limit = 10,
      includeGraph = true,
      bm25Weight = 1.0,
      semanticWeight = 1.0,
      graphWeight = 0.3,
    } = options;

    // Generate recall_id for tracking
    const recallId = this.generateRecallId();

    // Fetch more candidates than needed for fusion
    const candidateLimit = Math.max(limit * 3, 30);

    // Run BM25, vector search, and graph search in parallel (all fast)
    const [bm25Results, semanticResults, graphMemoryIds] = await Promise.all([
      this.searchBM25(query, candidateLimit),
      this.searchSemantic(query, candidateLimit),
      includeGraph ? this.searchGraph(query) : Promise.resolve([]),
    ]);

    // Fetch graph memories (filter out disabled)
    const graphMemories = graphMemoryIds.length > 0
      ? graphMemoryIds.map(id => this.db.getMemory(id)).filter((m): m is Memory => m !== null && !m.disabled)
      : [];

    // Combine all candidate IDs
    const allCandidateIds = new Set<string>();
    bm25Results.forEach(r => allCandidateIds.add(r.id));
    semanticResults.forEach(r => allCandidateIds.add(r.id));
    graphMemories.forEach(m => allCandidateIds.add(m.id));

    if (allCandidateIds.size === 0) {
      return {
        results: [],
        digests: [],
        recall_id: recallId,
        connected_memories: [],
      };
    }

    // Search digests via BM25 (top 3 relevant digests)
    const digestResults = this.searchDigests(query, 3);

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
    const rrfScores: Array<{ id: string; score: number; sources: { bm25?: number; semantic?: number; graph?: number } }> = [];

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
      if (memory && !memory.disabled) {
        // Apply Ebbinghaus decay and salience scoring
        const { adjusted, retention } = adjustScore(memory, score, now);

        adjustedResults.push({
          memory,
          score: adjusted,
          retention,
          originalScore: score,
          sources,
        });
      }
    }

    // Re-sort by adjusted score (accounts for recency/stability)
    adjustedResults.sort((a, b) => b.score - a.score);

    // Take top results
    const topResults = adjustedResults.slice(0, limit);

    // Build final results
    const results: HybridSearchResult[] = [];
    for (const result of topResults) {
      // Update access count (which also increases stability for future searches)
      this.db.touchMemory(result.memory.id);

      results.push({
        memory: result.memory,
        score: result.score,
        retention: result.retention,
        sources: result.sources,
      });
    }

    // Log this retrieval for deferred learning
    const allResultIds = results.map(r => r.memory.id);
    try {
      this.db.createRetrievalLog(this.sessionId, recallId, query, allResultIds);
    } catch (error) {
      // Only ignore duplicate recall_id errors (UNIQUE constraint), log all others
      const msg = error instanceof Error ? error.message : String(error);
      if (!msg.includes("UNIQUE constraint")) {
        console.error(`[Engram] Failed to create retrieval log: ${msg}`);
      }
    }

    // TOKEN EFFICIENCY: If digests are returned, reduce memory count
    // Digest provides context (synthesis), memories provide evidence (specifics)
    // Return fewer memories when we have good digest coverage
    let finalResults = results;
    if (digestResults.length > 0) {
      // Get IDs of memories already covered by digests as key_memories
      const coveredByDigests = new Set<string>();
      digestResults.forEach(d => d.key_memories.forEach(m => coveredByDigests.add(m.id)));

      // Keep memories not already shown as key_memories in digests
      // Also limit to fewer since digests provide the context
      const maxMemoriesWithDigests = Math.max(2, Math.floor(limit / 2));
      finalResults = results
        .filter(r => !coveredByDigests.has(r.memory.id))
        .slice(0, maxMemoriesWithDigests);
    }

    return {
      results: finalResults,
      digests: digestResults,
      recall_id: recallId,
      connected_memories: [],
    };
  }

  /**
   * Search digests via BM25 and return with key source memories
   * Returns top N digests with 2-3 representative source memories each
   */
  private searchDigests(query: string, limit: number): DigestSearchResult[] {
    try {
      const digestHits = this.db.searchDigestsBM25(query, limit);

      return digestHits.map(hit => {
        // Get source memories for this digest, take top 3 most relevant
        const sources = this.db.getDigestSources(hit.id);
        // Sort by importance and recency, take best 3
        const keyMemories = sources
          .sort((a, b) => {
            const scoreA = (a.importance || 0.5) + (a.access_count || 0) * 0.1;
            const scoreB = (b.importance || 0.5) + (b.access_count || 0) * 0.1;
            return scoreB - scoreA;
          })
          .slice(0, 3);

        return {
          digest: hit,
          score: Math.abs(hit.score),  // BM25 returns negative scores
          key_memories: keyMemories,
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * Expanded search when LLM needs more memories
   * Relaxes constraints and follows weaker connections
   */
  async expandSearch(
    recallId: string,
    options: { additionalLimit?: number } = {}
  ): Promise<HybridSearchResponse> {
    const { additionalLimit = 10 } = options;

    // Get the original retrieval log
    const log = this.db.getRetrievalLog(recallId);
    if (!log) {
      return { results: [], digests: [], recall_id: recallId, connected_memories: [] };
    }

    // Search again with expanded limit
    const response = await this.search(log.query, {
      limit: additionalLimit + log.memory_ids.length,
    });

    // Filter out memories already returned
    const existingIds = new Set(log.memory_ids);
    response.results = response.results.filter(r => !existingIds.has(r.memory.id));

    return response;
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
   * Semantic search via Transformers.js
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
   * Normalize a word for matching: lowercase, strip punctuation, handle possessives
   * "John's" → "john", "Paris!" → "paris", "U.S.A." → "usa"
   */
  private normalizeWord(word: string): string {
    return word
      .toLowerCase()
      .replace(/'s$/, '')           // Remove possessives: john's → john
      .replace(/[^\p{L}\p{N}]/gu, '') // Keep only letters/numbers (Unicode-safe)
      .trim();
  }

  /**
   * Graph-based search: find known entities in query, traverse graph
   * Uses normalized word matching to handle punctuation and possessives
   */
  private async searchGraph(query: string): Promise<string[]> {
    // Tokenize and normalize query words
    const queryWords = query.split(/\s+/)
      .map(w => this.normalizeWord(w))
      .filter(w => w.length > 0);
    const queryWordSet = new Set(queryWords);

    // Find entities whose normalized names match query words
    const allEntities = this.graph.listEntities(undefined, 500);
    const matchedEntities = allEntities.filter(e => {
      const entityWords = e.name.split(/\s+/)
        .map(w => this.normalizeWord(w))
        .filter(w => w.length > 0);
      // Entity matches if ALL its words appear in the query
      // e.g., "john" matches entity "John" but not "John Smith"
      // e.g., "john's friend" matches entity "John" (possessive handled)
      return entityWords.every(w => queryWordSet.has(w));
    });

    const memoryIds = new Set<string>();

    for (const entity of matchedEntities) {
      // Depth 1: only directly related memories, not transitive connections
      const relatedIds = this.graph.findRelatedMemoryIds(entity.name, 1);
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
    this.db.clearAllVectors();
    const batchSize = 500;
    let offset = 0;
    let total = 0;

    for (;;) {
      const batch = this.db.getAllMemories(batchSize, false, offset);
      if (batch.length === 0) break;
      const documents: Document[] = batch.map(m => ({
        id: m.id,
        content: m.content,
      }));
      await this.retriever.add(documents);
      total += batch.length;
      offset += batch.length;
      console.error(`[Engram] Rebuilt index: ${total} memories...`);
    }

    return { count: total };
  }

  /**
   * Index a batch of memories (for background indexing of unindexed memories)
   */
  async indexBatch(memories: Memory[]): Promise<{ count: number }> {
    const BATCH_SIZE = 50;
    let indexed = 0;

    for (let i = 0; i < memories.length; i += BATCH_SIZE) {
      const batch = memories.slice(i, i + BATCH_SIZE);
      const documents: Document[] = batch.map(m => ({
        id: m.id,
        content: m.content,
      }));
      await this.retriever.add(documents);
      indexed += batch.length;
      console.error(`[Engram] Indexed ${indexed}/${memories.length} memories...`);
    }

    return { count: indexed };
  }

  /**
   * Remove a memory from the semantic index
   */
  async removeFromIndex(memoryId: string): Promise<void> {
    await this.retriever.delete([memoryId]);
  }
}
