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
    connected?: number;  // Rank from Hebbian connections
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
   * Strategy: BM25 gets candidates fast, semantic embedder reranks for quality
   * This is both FASTER (fewer semantic embedder computations) and BETTER (combines keyword + semantic)
   */
  async search(
    query: string,
    options: {
      limit?: number;
      includeGraph?: boolean;
      includeConnections?: boolean;  // Include Hebbian-connected memories
      connectionBudget?: number;     // How many results to allocate to connections (default: 30%)
      minConnectionStrength?: number; // Minimum strength to include connections
      bm25Weight?: number;
      semanticWeight?: number;
      graphWeight?: number;
      connectionWeight?: number;     // Weight for connected memories in RRF
      useReranking?: boolean;        // Use semantic embedder to rerank BM25 results
    } = {}
  ): Promise<HybridSearchResponse> {
    const {
      limit = 10,
      includeGraph = true,
      includeConnections = true,
      connectionBudget = 0.3,        // 30% of results can be connected memories
      minConnectionStrength = 0.3,
      bm25Weight = 1.0,
      semanticWeight = 1.0,
      graphWeight = 0.3,
      connectionWeight = 0.5,
      useReranking = true,
    } = options;

    // Generate recall_id for tracking
    const recallId = this.generateRecallId();

    // Calculate budgets: 70% direct results, 30% connected
    const directBudget = Math.ceil(limit * (1 - connectionBudget));
    const connectedBudget = limit - directBudget;

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
      // Rerank BM25 candidates with semantic embedder - faster AND better quality
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
    const rankings: Map<string, { bm25?: number; semantic?: number; graph?: number; connected?: number }> = new Map();

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
    const rrfScores: Array<{ id: string; score: number; sources: { bm25?: number; semantic?: number; graph?: number; connected?: number } }> = [];

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
          sources,
        });
      }
    }

    // Re-sort by adjusted score (accounts for recency/stability)
    adjustedResults.sort((a, b) => b.score - a.score);

    // Take top direct results
    const directResults = adjustedResults.slice(0, directBudget);
    const directIds = directResults.map(r => r.memory.id);

    // Find Hebbian-connected memories (not already in direct results)
    let connectedMemories: Array<{ memory: Memory; connected_to: string; strength: number }> = [];
    if (includeConnections && directIds.length > 0) {
      const connectedIds = this.db.getConnectedMemoryIds(directIds, minConnectionStrength, connectedBudget * 2);

      for (const connId of connectedIds) {
        if (directIds.includes(connId)) continue;

        const memory = this.db.getMemory(connId);
        if (!memory) continue;

        // Find which direct result this is connected to
        const connections = this.db.getMemoryConnections(connId, minConnectionStrength);
        const connectedTo = connections.find(c =>
          directIds.includes(c.memory_a === connId ? c.memory_b : c.memory_a)
        );

        if (connectedTo) {
          connectedMemories.push({
            memory,
            connected_to: connectedTo.memory_a === connId ? connectedTo.memory_b : connectedTo.memory_a,
            strength: connectedTo.strength,
          });
        }
      }

      // Sort by strength and limit
      connectedMemories.sort((a, b) => b.strength - a.strength);
      connectedMemories = connectedMemories.slice(0, connectedBudget);
    }

    // Build final results (direct + space for connected)
    const results: HybridSearchResult[] = [];
    for (const result of directResults) {
      // Update access count (which also increases stability for future searches)
      this.db.touchMemory(result.memory.id);

      results.push({
        memory: result.memory,
        score: result.score,
        retention: result.retention,
        sources: result.sources,
      });
    }

    // Add connected memories to results with their own scores
    for (const { memory, strength } of connectedMemories) {
      const baseScore = strength * connectionWeight;
      const { adjusted, retention } = adjustScore(memory, baseScore, now);

      this.db.touchMemory(memory.id);

      results.push({
        memory,
        score: adjusted,
        retention,
        sources: { connected: 1 },
      });
    }

    // Track co-retrieval for Hebbian learning (all result IDs)
    const allResultIds = results.map(r => r.memory.id);
    if (allResultIds.length >= 2) {
      this.db.recordCoRetrieval(allResultIds);
    }

    // Log this retrieval for deferred learning
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
      connected_memories: connectedMemories,
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

    // Search again with relaxed parameters
    const response = await this.search(log.query, {
      limit: additionalLimit + log.memory_ids.length,
      includeConnections: true,
      minConnectionStrength: 0.1,  // Lower threshold
      connectionBudget: 0.5,       // More connected memories
    });

    // Filter out memories already returned
    const existingIds = new Set(log.memory_ids);
    response.results = response.results.filter(r => !existingIds.has(r.memory.id));
    response.connected_memories = response.connected_memories.filter(c => !existingIds.has(c.memory.id));

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
    const memories = this.db.getAllMemories();

    const documents: Document[] = memories.map(m => ({
      id: m.id,
      content: m.content,
    }));

    const result = await this.retriever.index(documents);
    return { count: result.count };
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
