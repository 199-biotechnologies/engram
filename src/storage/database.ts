/**
 * SQLite database layer for Engram
 * Handles all persistent storage: memories, entities, relations, observations
 */

import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import path from "path";
import fs from "fs";

export interface Memory {
  id: string;
  content: string;
  source: string;
  timestamp: Date;           // ingestion_time: when we learned this
  event_time: Date | null;   // when the event actually happened (bi-temporal)
  importance: number;
  access_count: number;
  last_accessed: Date | null;
  stability: number;         // Ebbinghaus stability score (increases with recalls)
  emotional_weight: number;  // Salience: emotional significance 0-1
  disabled: boolean;         // Soft-deleted: excluded from search results
}

/**
 * Episode: Raw conversation turns (hippocampal buffer)
 * These are the sensory/working memory before consolidation into semantic memory
 */
export interface Episode {
  id: string;
  session_id: string;        // Groups conversation turns
  turn_index: number;        // Order within session
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  consolidated: boolean;     // Has this been processed into memories?
}

export interface Entity {
  id: string;
  name: string;
  type: "person" | "place" | "concept" | "event" | "organization";
  created_at: Date;
  metadata: Record<string, unknown> | null;
}

export interface Observation {
  id: string;
  entity_id: string;
  content: string;
  source_memory_id: string | null;
  confidence: number;
  valid_from: Date;
  valid_until: Date | null;
}

export interface Relation {
  id: string;
  from_entity: string;
  to_entity: string;
  type: string;
  properties: Record<string, unknown> | null;
  created_at: Date;
}

export interface Digest {
  id: string;
  content: string;
  level: number; // 1 = session, 2 = topic, 3 = entity profile
  topic: string | null;
  entity_id: string | null;
  source_count: number;
  created_at: Date;
  period_start: Date;
  period_end: Date;
}

export interface Contradiction {
  id: string;
  entity_id: string | null;
  memory_id_a: string;
  memory_id_b: string;
  description: string;
  resolved: boolean;
  resolution: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

/**
 * Hebbian connection between two memories
 * "Neurons that fire together, wire together"
 * Strength increases when memories are useful TOGETHER, not just co-retrieved
 */
export interface MemoryConnection {
  id: string;
  memory_a: string;
  memory_b: string;
  strength: number;        // 0-1, how strongly connected
  co_retrievals: number;   // Times retrieved together
  co_useful: number;       // Times BOTH were useful together (from LLM feedback)
  last_fired: Date | null; // Last time this connection was activated
  created_at: Date;
}

/**
 * Log of retrieval sessions for deferred learning
 * We don't update connections immediately - we batch process after N turns
 */
export interface RetrievalLog {
  id: string;
  session_id: string;
  recall_id: string;       // Unique ID for this recall operation
  query: string;
  memory_ids: string[];    // All memories retrieved
  useful_ids: string[] | null; // From LLM feedback (null = no feedback yet)
  need_more: boolean;      // LLM requested more memories
  timestamp: Date;
  processed: boolean;      // Has this been used for learning?
}

/**
 * Consolidation checkpoint for safe backlog processing
 * Enables resume capability and progress tracking
 */
export interface ConsolidationCheckpoint {
  id: string;
  run_id: string;              // Unique ID for this consolidation run
  phase: "episodes" | "memories" | "decay" | "cleanup" | "complete";
  batches_completed: number;
  batches_total: number;
  memories_processed: number;
  episodes_processed: number;
  digests_created: number;
  contradictions_found: number;
  tokens_used: number;
  estimated_cost_usd: number;
  started_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  error: string | null;
}

/**
 * Consolidation configuration for budget and rate limits
 */
export interface ConsolidationConfig {
  key: string;
  value: string;
  updated_at: Date;
}

export class EngramDatabase {
  private db: Database.Database;
  private stmtCache: Map<string, Database.Statement> = new Map();

  constructor(dbPath: string) {
    // Ensure directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);

    // Performance optimizations - all improve speed with no quality trade-off
    this.db.pragma("journal_mode = WAL");         // Better concurrent access
    this.db.pragma("synchronous = NORMAL");       // Faster writes, WAL provides safety
    this.db.pragma("cache_size = -64000");        // 64MB cache (negative = KB)
    this.db.pragma("mmap_size = 268435456");      // 256MB memory-mapped I/O
    this.db.pragma("temp_store = MEMORY");        // Keep temp tables in RAM
    this.db.pragma("foreign_keys = ON");

    this.initialize();
  }

  private initialize(): void {
    // Memories table (Semantic Memory - neocortex analog)
    // Create table with base columns first (for new databases)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        source TEXT DEFAULT 'conversation',
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        importance REAL DEFAULT 0.5,
        access_count INTEGER DEFAULT 0,
        last_accessed DATETIME
      );
    `);

    // Episodes table (Episodic Memory - hippocampal buffer)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS episodes (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_index INTEGER DEFAULT 0,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        consolidated INTEGER DEFAULT 0
      );
    `);

    // IMPORTANT: Migrate schema BEFORE creating indexes on new columns
    // This adds event_time, stability, emotional_weight to existing databases
    this.migrateSchema();

    // Now create all indexes (after migration ensures columns exist)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp);
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
      CREATE INDEX IF NOT EXISTS idx_memories_event_time ON memories(event_time);
      CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id);
      CREATE INDEX IF NOT EXISTS idx_episodes_consolidated ON episodes(consolidated);
      CREATE INDEX IF NOT EXISTS idx_episodes_timestamp ON episodes(timestamp);
    `);

    // FTS5 for BM25 search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        content='memories',
        content_rowid='rowid'
      );

      -- Triggers to keep FTS in sync
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', OLD.rowid, OLD.content);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', OLD.rowid, OLD.content);
        INSERT INTO memories_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
      END;
    `);

    // Entities table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('person', 'place', 'concept', 'event', 'organization')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        metadata JSON
      );

      CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
    `);

    // Observations table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        source_memory_id TEXT REFERENCES memories(id) ON DELETE SET NULL,
        confidence REAL DEFAULT 1.0,
        valid_from DATETIME DEFAULT CURRENT_TIMESTAMP,
        valid_until DATETIME
      );

      CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations(entity_id);
      CREATE INDEX IF NOT EXISTS idx_observations_memory ON observations(source_memory_id);
    `);

    // Relations table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS relations (
        id TEXT PRIMARY KEY,
        from_entity TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        to_entity TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        properties JSON,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity);
      CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_entity);
      CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(type);
    `);

    // Digests table (consolidated memories)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS digests (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        level INTEGER DEFAULT 1,
        topic TEXT,
        entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
        source_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        period_start DATETIME,
        period_end DATETIME
      );

      CREATE INDEX IF NOT EXISTS idx_digests_level ON digests(level);
      CREATE INDEX IF NOT EXISTS idx_digests_entity ON digests(entity_id);
      CREATE INDEX IF NOT EXISTS idx_digests_period ON digests(period_start, period_end);
    `);

    // Digest sources (links digests to their source memories)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS digest_sources (
        digest_id TEXT NOT NULL REFERENCES digests(id) ON DELETE CASCADE,
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        PRIMARY KEY (digest_id, memory_id)
      );

      CREATE INDEX IF NOT EXISTS idx_digest_sources_memory ON digest_sources(memory_id);
    `);

    // Contradictions table (detected conflicts)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contradictions (
        id TEXT PRIMARY KEY,
        entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
        memory_id_a TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        memory_id_b TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        description TEXT NOT NULL,
        resolved INTEGER DEFAULT 0,
        resolution TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME
      );

      CREATE INDEX IF NOT EXISTS idx_contradictions_entity ON contradictions(entity_id);
      CREATE INDEX IF NOT EXISTS idx_contradictions_resolved ON contradictions(resolved);
    `);

    // Memory connections table (Hebbian learning)
    // "Neurons that fire together, wire together"
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_connections (
        id TEXT PRIMARY KEY,
        memory_a TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        memory_b TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        strength REAL DEFAULT 0.1,
        co_retrievals INTEGER DEFAULT 0,
        co_useful INTEGER DEFAULT 0,
        last_fired DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(memory_a, memory_b)
      );

      CREATE INDEX IF NOT EXISTS idx_connections_memory_a ON memory_connections(memory_a);
      CREATE INDEX IF NOT EXISTS idx_connections_memory_b ON memory_connections(memory_b);
      CREATE INDEX IF NOT EXISTS idx_connections_strength ON memory_connections(strength);
    `);

    // Retrieval logs for deferred learning
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS retrieval_logs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        recall_id TEXT NOT NULL UNIQUE,
        query TEXT NOT NULL,
        memory_ids TEXT NOT NULL,
        useful_ids TEXT,
        need_more INTEGER DEFAULT 0,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        processed INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_retrieval_logs_session ON retrieval_logs(session_id);
      CREATE INDEX IF NOT EXISTS idx_retrieval_logs_recall ON retrieval_logs(recall_id);
      CREATE INDEX IF NOT EXISTS idx_retrieval_logs_processed ON retrieval_logs(processed);
    `);

    // Consolidation checkpoints for safe backlog processing
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS consolidation_checkpoints (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE,
        phase TEXT NOT NULL CHECK(phase IN ('episodes', 'memories', 'decay', 'cleanup', 'complete')),
        batches_completed INTEGER DEFAULT 0,
        batches_total INTEGER DEFAULT 0,
        memories_processed INTEGER DEFAULT 0,
        episodes_processed INTEGER DEFAULT 0,
        digests_created INTEGER DEFAULT 0,
        contradictions_found INTEGER DEFAULT 0,
        tokens_used INTEGER DEFAULT 0,
        estimated_cost_usd REAL DEFAULT 0,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_checkpoints_run ON consolidation_checkpoints(run_id);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_phase ON consolidation_checkpoints(phase);
    `);

    // Consolidation configuration for budget and rate limits
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS consolidation_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Default configuration values
      INSERT OR IGNORE INTO consolidation_config (key, value) VALUES
        ('daily_budget_usd', '5.0'),
        ('max_batches_per_run', '5'),
        ('delay_between_calls_ms', '2000'),
        ('recovery_mode_threshold', '100'),
        ('error_rate_threshold', '0.3'),
        ('empty_digest_threshold', '0.2');
    `);
  }

  /**
   * Add new columns to existing tables for seamless upgrades
   */
  private migrateSchema(): void {
    // Check and add new memory columns
    const memoryInfo = this.db.pragma("table_info(memories)") as Array<{ name: string }>;
    const memoryColumns = new Set(memoryInfo.map(c => c.name));

    if (!memoryColumns.has("event_time")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN event_time DATETIME");
    }
    if (!memoryColumns.has("stability")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN stability REAL DEFAULT 1.0");
    }
    if (!memoryColumns.has("emotional_weight")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN emotional_weight REAL DEFAULT 0.5");
    }
    if (!memoryColumns.has("disabled")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN disabled INTEGER DEFAULT 0");
    }
  }

  // ============ Memory Operations ============

  createMemory(
    content: string,
    source: string = "conversation",
    importance: number = 0.5,
    options: {
      eventTime?: Date;
      emotionalWeight?: number;
    } = {}
  ): Memory {
    const id = randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO memories (id, content, source, importance, event_time, emotional_weight, stability)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      content,
      source,
      importance,
      options.eventTime?.toISOString() || null,
      options.emotionalWeight ?? 0.5,
      1.0  // Initial stability
    );
    return this.getMemory(id)!;
  }

  getMemory(id: string): Memory | null {
    const row = this.stmt("SELECT * FROM memories WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToMemory(row) : null;
  }

  updateMemory(id: string, updates: Partial<Pick<Memory, "content" | "importance" | "disabled">>): Memory | null {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (updates.content !== undefined) {
      sets.push("content = ?");
      values.push(updates.content);
    }
    if (updates.importance !== undefined) {
      sets.push("importance = ?");
      values.push(updates.importance);
    }
    if (updates.disabled !== undefined) {
      sets.push("disabled = ?");
      values.push(updates.disabled ? 1 : 0);
    }

    if (sets.length === 0) return this.getMemory(id);

    values.push(id);
    const stmt = this.db.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`);
    stmt.run(...values);
    return this.getMemory(id);
  }

  deleteMemory(id: string): boolean {
    const stmt = this.db.prepare("DELETE FROM memories WHERE id = ?");
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Record a memory access - increases access_count and stability
   * Each recall strengthens the memory (Ebbinghaus spacing effect)
   */
  touchMemory(id: string): void {
    // Stability increases with each access: S_new = S_old * 1.2 (capped at 10)
    this.stmt(`
      UPDATE memories
      SET access_count = access_count + 1,
          last_accessed = CURRENT_TIMESTAMP,
          stability = MIN(stability * 1.2, 10.0)
      WHERE id = ?
    `).run(id);
  }

  getAllMemories(limit: number = 1000, includeDisabled: boolean = false, offset: number = 0): Memory[] {
    const sql = includeDisabled
      ? "SELECT * FROM memories ORDER BY timestamp DESC LIMIT ? OFFSET ?"
      : "SELECT * FROM memories WHERE disabled = 0 ORDER BY timestamp DESC LIMIT ? OFFSET ?";
    const rows = this.stmt(sql).all(limit, offset) as Record<string, unknown>[];
    return rows.map((row) => this.rowToMemory(row));
  }

  // ============ Episode Operations (Raw Conversations) ============

  /**
   * Store a conversation turn for later consolidation
   */
  createEpisode(
    sessionId: string,
    role: "user" | "assistant",
    content: string,
    turnIndex?: number
  ): Episode {
    const id = randomUUID();

    // Auto-calculate turn index if not provided
    const actualTurnIndex = turnIndex ?? this.getNextTurnIndex(sessionId);

    const stmt = this.db.prepare(`
      INSERT INTO episodes (id, session_id, turn_index, role, content)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(id, sessionId, actualTurnIndex, role, content);
    return this.getEpisode(id)!;
  }

  getEpisode(id: string): Episode | null {
    const row = this.stmt("SELECT * FROM episodes WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToEpisode(row) : null;
  }

  private getNextTurnIndex(sessionId: string): number {
    const row = this.stmt(
      "SELECT MAX(turn_index) as max_turn FROM episodes WHERE session_id = ?"
    ).get(sessionId) as { max_turn: number | null } | undefined;
    return (row?.max_turn ?? -1) + 1;
  }

  /**
   * Get all episodes in a session
   */
  getSessionEpisodes(sessionId: string): Episode[] {
    const rows = this.stmt(
      "SELECT * FROM episodes WHERE session_id = ? ORDER BY turn_index"
    ).all(sessionId) as Record<string, unknown>[];
    return rows.map((row) => this.rowToEpisode(row));
  }

  /**
   * Get unconsolidated episodes for processing
   */
  getUnconsolidatedEpisodes(limit: number = 100): Episode[] {
    const rows = this.stmt(
      "SELECT * FROM episodes WHERE consolidated = 0 ORDER BY timestamp ASC LIMIT ?"
    ).all(limit) as Record<string, unknown>[];
    return rows.map((row) => this.rowToEpisode(row));
  }

  /**
   * Mark episodes as consolidated
   */
  markEpisodesConsolidated(episodeIds: string[]): void {
    const stmt = this.db.prepare("UPDATE episodes SET consolidated = 1 WHERE id = ?");
    for (const id of episodeIds) {
      stmt.run(id);
    }
  }

  /**
   * Get recent sessions for context
   */
  getRecentSessions(limit: number = 10): Array<{ session_id: string; episode_count: number; last_activity: Date }> {
    const rows = this.stmt(`
      SELECT session_id, COUNT(*) as episode_count, MAX(timestamp) as last_activity
      FROM episodes
      GROUP BY session_id
      ORDER BY last_activity DESC
      LIMIT ?
    `).all(limit) as Array<{ session_id: string; episode_count: number; last_activity: string }>;

    return rows.map(r => ({
      session_id: r.session_id,
      episode_count: r.episode_count,
      last_activity: new Date(r.last_activity),
    }));
  }

  private rowToEpisode(row: Record<string, unknown>): Episode {
    return {
      id: row.id as string,
      session_id: row.session_id as string,
      turn_index: row.turn_index as number,
      role: row.role as "user" | "assistant",
      content: row.content as string,
      timestamp: new Date(row.timestamp as string),
      consolidated: Boolean(row.consolidated),
    };
  }

  // ============ BM25 Search ============

  searchBM25(query: string, limit: number = 20): Array<Memory & { score: number }> {
    // Escape special FTS5 characters and format query
    const escapedQuery = this.escapeFTS5Query(query);
    const rows = this.stmt(`
      SELECT m.*, bm25(memories_fts) as score
      FROM memories_fts fts
      JOIN memories m ON fts.rowid = m.rowid
      WHERE memories_fts MATCH ? AND m.disabled = 0
      ORDER BY score
      LIMIT ?
    `).all(escapedQuery, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      ...this.rowToMemory(row),
      score: row.score as number,
    }));
  }

  private escapeFTS5Query(query: string): string {
    // Simple tokenization - split on whitespace, escape special chars
    const tokens = query
      .replace(/['"()^*:]/g, " ") // Remove FTS5 special chars
      .split(/\s+/)
      .filter((t) => t.length > 0);

    // Use OR for flexibility
    return tokens.join(" OR ");
  }

  // ============ Entity Operations ============

  createEntity(
    name: string,
    type: Entity["type"],
    metadata: Record<string, unknown> | null = null
  ): Entity {
    const id = randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO entities (id, name, type, metadata)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(id, name, type, metadata ? JSON.stringify(metadata) : null);
    return this.getEntity(id)!;
  }

  getEntity(id: string): Entity | null {
    const row = this.stmt("SELECT * FROM entities WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToEntity(row) : null;
  }

  findEntityByName(name: string): Entity | null {
    // First try exact match (case-insensitive)
    const row = this.stmt("SELECT * FROM entities WHERE LOWER(name) = LOWER(?)").get(name) as Record<string, unknown> | undefined;
    if (row) return this.rowToEntity(row);

    // If no exact match, try fuzzy match for potential duplicates
    const fuzzyMatch = this.findSimilarEntity(name);
    return fuzzyMatch;
  }

  /**
   * Find a similar entity using fuzzy matching
   * Catches "John D" matching "John Doe", "Jane" matching "Jane Smith"
   */
  findSimilarEntity(name: string, threshold: number = 0.8): Entity | null {
    const normalizedName = name.toLowerCase().trim();
    const nameWords = normalizedName.split(/\s+/);

    // Get candidates: entities that share at least one word with the query
    const candidates = this.stmt(`
      SELECT * FROM entities
      WHERE LOWER(name) LIKE ?
      LIMIT 100
    `).all(`%${nameWords[0]}%`) as Record<string, unknown>[];

    let bestMatch: Entity | null = null;
    let bestScore = 0;

    for (const row of candidates) {
      const entity = this.rowToEntity(row);
      const entityName = entity.name.toLowerCase();
      const entityWords = entityName.split(/\s+/);

      // Calculate similarity score
      const score = this.calculateNameSimilarity(nameWords, entityWords, normalizedName, entityName);

      if (score >= threshold && score > bestScore) {
        bestScore = score;
        bestMatch = entity;
      }
    }

    return bestMatch;
  }

  /**
   * Calculate similarity between two names
   * Returns 0-1 score (1 = identical)
   */
  private calculateNameSimilarity(
    words1: string[],
    words2: string[],
    full1: string,
    full2: string
  ): number {
    // Exact match
    if (full1 === full2) return 1.0;

    // One is prefix of the other (e.g., "John" vs "John Doe")
    if (full1.startsWith(full2 + " ") || full2.startsWith(full1 + " ")) {
      return 0.9;
    }

    // First word matches (e.g., "John" vs "John Smith")
    if (words1[0] === words2[0]) {
      // Same first word, different lengths
      const longer = Math.max(words1.length, words2.length);
      const shorter = Math.min(words1.length, words2.length);
      return 0.7 + (0.2 * shorter / longer);
    }

    // Check for abbreviated names (e.g., "John D" vs "John Doe")
    if (words1.length >= 2 && words2.length >= 2) {
      const last1 = words1[words1.length - 1];
      const last2 = words2[words2.length - 1];

      // Check if one is abbreviation of the other
      if (last1.length === 1 && last2.startsWith(last1)) {
        return 0.85;
      }
      if (last2.length === 1 && last1.startsWith(last2)) {
        return 0.85;
      }
    }

    // Count shared words
    const set1 = new Set(words1);
    const shared = words2.filter(w => set1.has(w)).length;
    const total = Math.max(words1.length, words2.length);

    return shared / total * 0.7;
  }

  /**
   * Merge two entities: transfers all observations and relations from source to target, then deletes source
   */
  mergeEntities(targetId: string, sourceId: string): { observationsMoved: number; relationsMoved: number } {
    // Move observations from source to target
    const obsResult = this.db.prepare(
      "UPDATE observations SET entity_id = ? WHERE entity_id = ?"
    ).run(targetId, sourceId);

    // Move relations where source is from_entity
    const relFromResult = this.db.prepare(
      "UPDATE relations SET from_entity = ? WHERE from_entity = ?"
    ).run(targetId, sourceId);

    // Move relations where source is to_entity
    const relToResult = this.db.prepare(
      "UPDATE relations SET to_entity = ? WHERE to_entity = ?"
    ).run(targetId, sourceId);

    // Delete duplicate relations (same from, to, type)
    this.db.prepare(`
      DELETE FROM relations WHERE id NOT IN (
        SELECT MIN(id) FROM relations GROUP BY from_entity, to_entity, type
      )
    `).run();

    // Delete the source entity
    this.deleteEntity(sourceId);

    return {
      observationsMoved: obsResult.changes,
      relationsMoved: relFromResult.changes + relToResult.changes,
    };
  }

  /**
   * Find all potential duplicate entities
   */
  findDuplicateEntities(): Array<{ entity: Entity; potentialDuplicates: Entity[] }> {
    const entities = this.listEntities(undefined, 1000);
    const duplicates: Array<{ entity: Entity; potentialDuplicates: Entity[] }> = [];
    const processed = new Set<string>();

    for (const entity of entities) {
      if (processed.has(entity.id)) continue;

      const potentialDupes: Entity[] = [];
      const words = entity.name.toLowerCase().split(/\s+/);

      for (const other of entities) {
        if (other.id === entity.id || processed.has(other.id)) continue;

        const otherWords = other.name.toLowerCase().split(/\s+/);
        const score = this.calculateNameSimilarity(
          words, otherWords,
          entity.name.toLowerCase(),
          other.name.toLowerCase()
        );

        if (score >= 0.8) {
          potentialDupes.push(other);
          processed.add(other.id);
        }
      }

      if (potentialDupes.length > 0) {
        duplicates.push({ entity, potentialDuplicates: potentialDupes });
        processed.add(entity.id);
      }
    }

    return duplicates;
  }

  searchEntities(query: string, type?: Entity["type"]): Entity[] {
    // Case-insensitive search
    let sql = "SELECT * FROM entities WHERE LOWER(name) LIKE LOWER(?)";
    const params: unknown[] = [`%${query}%`];

    if (type) {
      sql += " AND type = ?";
      params.push(type);
    }

    sql += " LIMIT 50";
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.rowToEntity(row));
  }

  listEntities(type?: Entity["type"], limit: number = 100): Entity[] {
    let sql = "SELECT * FROM entities";
    const params: unknown[] = [];

    if (type) {
      sql += " WHERE type = ?";
      params.push(type);
    }

    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.rowToEntity(row));
  }

  deleteEntity(id: string): boolean {
    const stmt = this.db.prepare("DELETE FROM entities WHERE id = ?");
    const result = stmt.run(id);
    return result.changes > 0;
  }

  updateEntity(id: string, updates: { name?: string; type?: Entity["type"] }): Entity | null {
    const entity = this.getEntity(id);
    if (!entity) return null;

    const newName = updates.name ?? entity.name;
    const newType = updates.type ?? entity.type;

    const stmt = this.db.prepare("UPDATE entities SET name = ?, type = ? WHERE id = ?");
    stmt.run(newName, newType, id);
    return this.getEntity(id);
  }

  // ============ Observation Operations ============

  addObservation(
    entityId: string,
    content: string,
    sourceMemoryId: string | null = null,
    confidence: number = 1.0
  ): Observation {
    const id = randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO observations (id, entity_id, content, source_memory_id, confidence)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(id, entityId, content, sourceMemoryId, confidence);
    return this.getObservation(id)!;
  }

  getObservation(id: string): Observation | null {
    const row = this.stmt("SELECT * FROM observations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToObservation(row) : null;
  }

  getEntityObservations(entityId: string, includeExpired: boolean = false): Observation[] {
    let sql = "SELECT * FROM observations WHERE entity_id = ?";
    if (!includeExpired) {
      sql += " AND (valid_until IS NULL OR valid_until > CURRENT_TIMESTAMP)";
    }
    sql += " ORDER BY valid_from DESC";

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(entityId) as Record<string, unknown>[];
    return rows.map((row) => this.rowToObservation(row));
  }

  expireObservation(id: string): void {
    const stmt = this.db.prepare("UPDATE observations SET valid_until = CURRENT_TIMESTAMP WHERE id = ?");
    stmt.run(id);
  }

  // ============ Relation Operations ============

  createRelation(
    fromEntityId: string,
    toEntityId: string,
    type: string,
    properties: Record<string, unknown> | null = null
  ): Relation {
    const id = randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO relations (id, from_entity, to_entity, type, properties)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(id, fromEntityId, toEntityId, type, properties ? JSON.stringify(properties) : null);
    return this.getRelation(id)!;
  }

  getRelation(id: string): Relation | null {
    const row = this.stmt("SELECT * FROM relations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToRelation(row) : null;
  }

  getEntityRelations(entityId: string, direction: "from" | "to" | "both" = "both"): Relation[] {
    let sql: string;
    if (direction === "from") {
      sql = "SELECT * FROM relations WHERE from_entity = ?";
    } else if (direction === "to") {
      sql = "SELECT * FROM relations WHERE to_entity = ?";
    } else {
      sql = "SELECT * FROM relations WHERE from_entity = ? OR to_entity = ?";
    }

    const stmt = this.db.prepare(sql);
    const rows = (direction === "both"
      ? stmt.all(entityId, entityId)
      : stmt.all(entityId)) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRelation(row));
  }

  findRelation(fromEntityId: string, toEntityId: string, type?: string): Relation | null {
    let sql = "SELECT * FROM relations WHERE from_entity = ? AND to_entity = ?";
    const params: unknown[] = [fromEntityId, toEntityId];

    if (type) {
      sql += " AND type = ?";
      params.push(type);
    }

    const stmt = this.db.prepare(sql);
    const row = stmt.get(...params) as Record<string, unknown> | undefined;
    return row ? this.rowToRelation(row) : null;
  }

  deleteRelation(id: string): boolean {
    const stmt = this.db.prepare("DELETE FROM relations WHERE id = ?");
    const result = stmt.run(id);
    return result.changes > 0;
  }

  // ============ Graph Traversal ============

  traverse(
    startEntityId: string,
    depth: number = 2,
    relationTypes?: string[]
  ): { entities: Entity[]; relations: Relation[]; observations: Observation[] } {
    const visitedEntities = new Set<string>();
    const allRelations: Relation[] = [];
    const queue: Array<{ entityId: string; currentDepth: number }> = [
      { entityId: startEntityId, currentDepth: 0 },
    ];

    while (queue.length > 0) {
      const { entityId, currentDepth } = queue.shift()!;

      if (visitedEntities.has(entityId) || currentDepth > depth) continue;
      visitedEntities.add(entityId);

      const relations = this.getEntityRelations(entityId);
      for (const rel of relations) {
        if (relationTypes && !relationTypes.includes(rel.type)) continue;

        allRelations.push(rel);
        const nextEntityId = rel.from_entity === entityId ? rel.to_entity : rel.from_entity;

        if (!visitedEntities.has(nextEntityId) && currentDepth < depth) {
          queue.push({ entityId: nextEntityId, currentDepth: currentDepth + 1 });
        }
      }
    }

    // Get all entities and their observations
    const entities: Entity[] = [];
    const observations: Observation[] = [];

    for (const entityId of visitedEntities) {
      const entity = this.getEntity(entityId);
      if (entity) {
        entities.push(entity);
        observations.push(...this.getEntityObservations(entityId));
      }
    }

    return { entities, relations: allRelations, observations };
  }

  // ============ Digest Operations ============

  createDigest(
    content: string,
    level: number,
    sourceMemoryIds: string[],
    options: {
      topic?: string;
      entityId?: string;
      periodStart?: Date;
      periodEnd?: Date;
    } = {}
  ): Digest {
    const id = randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO digests (id, content, level, topic, entity_id, source_count, period_start, period_end)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      content,
      level,
      options.topic || null,
      options.entityId || null,
      sourceMemoryIds.length,
      options.periodStart?.toISOString() || null,
      options.periodEnd?.toISOString() || null
    );

    // Link source memories
    const linkStmt = this.db.prepare(
      "INSERT OR IGNORE INTO digest_sources (digest_id, memory_id) VALUES (?, ?)"
    );
    for (const memoryId of sourceMemoryIds) {
      linkStmt.run(id, memoryId);
    }

    return this.getDigest(id)!;
  }

  getDigest(id: string): Digest | null {
    const row = this.stmt("SELECT * FROM digests WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToDigest(row) : null;
  }

  getDigests(level?: number, limit: number = 100): Digest[] {
    let sql = "SELECT * FROM digests";
    const params: unknown[] = [];

    if (level !== undefined) {
      sql += " WHERE level = ?";
      params.push(level);
    }

    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.rowToDigest(row));
  }

  getDigestSources(digestId: string): Memory[] {
    const rows = this.stmt(`
      SELECT m.* FROM memories m
      JOIN digest_sources ds ON ds.memory_id = m.id
      WHERE ds.digest_id = ?
      ORDER BY m.timestamp DESC
    `).all(digestId) as Record<string, unknown>[];
    return rows.map((row) => this.rowToMemory(row));
  }

  getUnconsolidatedMemories(since?: Date, limit: number = 100): Memory[] {
    let sql = `
      SELECT m.* FROM memories m
      LEFT JOIN digest_sources ds ON ds.memory_id = m.id
      WHERE ds.digest_id IS NULL
    `;
    const params: unknown[] = [];

    if (since) {
      sql += " AND m.timestamp >= ?";
      params.push(since.toISOString());
    }

    sql += " ORDER BY m.timestamp DESC LIMIT ?";
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.rowToMemory(row));
  }

  deleteDigest(id: string): boolean {
    const stmt = this.db.prepare("DELETE FROM digests WHERE id = ?");
    const result = stmt.run(id);
    return result.changes > 0;
  }

  // ============ Contradiction Operations ============

  createContradiction(
    memoryIdA: string,
    memoryIdB: string,
    description: string,
    entityId?: string
  ): Contradiction {
    const id = randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO contradictions (id, entity_id, memory_id_a, memory_id_b, description)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(id, entityId || null, memoryIdA, memoryIdB, description);
    return this.getContradiction(id)!;
  }

  getContradiction(id: string): Contradiction | null {
    const row = this.stmt("SELECT * FROM contradictions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToContradiction(row) : null;
  }

  getContradictions(resolved?: boolean, limit: number = 100): Contradiction[] {
    let sql = "SELECT * FROM contradictions";
    const params: unknown[] = [];

    if (resolved !== undefined) {
      sql += " WHERE resolved = ?";
      params.push(resolved ? 1 : 0);
    }

    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.rowToContradiction(row));
  }

  resolveContradiction(id: string, resolution: string): boolean {
    const stmt = this.db.prepare(`
      UPDATE contradictions
      SET resolved = 1, resolution = ?, resolved_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    const result = stmt.run(resolution, id);
    return result.changes > 0;
  }

  deleteContradiction(id: string): boolean {
    const stmt = this.db.prepare("DELETE FROM contradictions WHERE id = ?");
    const result = stmt.run(id);
    return result.changes > 0;
  }

  // ============ Memory Connections (Hebbian Learning) ============

  /**
   * Get or create a connection between two memories
   * Always stores with smaller ID first for consistency
   */
  getOrCreateConnection(memoryA: string, memoryB: string): MemoryConnection {
    // Normalize order: smaller ID always first
    const [a, b] = memoryA < memoryB ? [memoryA, memoryB] : [memoryB, memoryA];

    const existing = this.stmt(
      "SELECT * FROM memory_connections WHERE memory_a = ? AND memory_b = ?"
    ).get(a, b) as Record<string, unknown> | undefined;

    if (existing) {
      return this.rowToConnection(existing);
    }

    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO memory_connections (id, memory_a, memory_b)
      VALUES (?, ?, ?)
    `).run(id, a, b);

    return this.getConnection(id)!;
  }

  getConnection(id: string): MemoryConnection | null {
    const row = this.stmt("SELECT * FROM memory_connections WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToConnection(row) : null;
  }

  /**
   * Get all connections for a memory
   */
  getMemoryConnections(memoryId: string, minStrength: number = 0): MemoryConnection[] {
    const rows = this.stmt(`
      SELECT * FROM memory_connections
      WHERE (memory_a = ? OR memory_b = ?) AND strength >= ?
      ORDER BY strength DESC
    `).all(memoryId, memoryId, minStrength) as Record<string, unknown>[];
    return rows.map(r => this.rowToConnection(r));
  }

  /**
   * Get connected memory IDs for a set of memories
   */
  getConnectedMemoryIds(memoryIds: string[], minStrength: number = 0.3, limit: number = 10): string[] {
    if (memoryIds.length === 0) return [];

    const placeholders = memoryIds.map(() => "?").join(",");
    const rows = this.db.prepare(`
      SELECT DISTINCT
        CASE WHEN memory_a IN (${placeholders}) THEN memory_b ELSE memory_a END as connected_id,
        strength
      FROM memory_connections
      WHERE (memory_a IN (${placeholders}) OR memory_b IN (${placeholders}))
        AND strength >= ?
      ORDER BY strength DESC
      LIMIT ?
    `).all(...memoryIds, ...memoryIds, ...memoryIds, minStrength, limit) as Array<{ connected_id: string; strength: number }>;

    // Filter out memories that are already in the input set
    const inputSet = new Set(memoryIds);
    return rows.map(r => r.connected_id).filter(id => !inputSet.has(id));
  }

  /**
   * Record that memories were retrieved together (co-retrieval)
   * Uses cached statement and transaction for O(n²) efficiency
   */
  recordCoRetrieval(memoryIds: string[]): void {
    if (memoryIds.length < 2) return;

    // Cache statement once (not per iteration)
    const upsertStmt = this.stmt(`
      INSERT INTO memory_connections (id, memory_a, memory_b, co_retrievals, last_fired)
      VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(memory_a, memory_b) DO UPDATE SET
        co_retrievals = co_retrievals + 1,
        last_fired = CURRENT_TIMESTAMP
    `);

    // Wrap in transaction for batch efficiency
    this.db.transaction(() => {
      for (let i = 0; i < memoryIds.length; i++) {
        for (let j = i + 1; j < memoryIds.length; j++) {
          const [a, b] = memoryIds[i] < memoryIds[j]
            ? [memoryIds[i], memoryIds[j]]
            : [memoryIds[j], memoryIds[i]];

          upsertStmt.run(randomUUID(), a, b);
        }
      }
    })();
  }

  /**
   * Record that memories were useful together (from LLM feedback)
   * This is what actually strengthens connections
   * Uses cached statement and transaction for O(n²) efficiency
   */
  recordCoUseful(memoryIds: string[]): void {
    if (memoryIds.length < 2) return;

    // Cache statement once (not per iteration)
    const updateStmt = this.stmt(`
      UPDATE memory_connections
      SET co_useful = ?, strength = ?, last_fired = CURRENT_TIMESTAMP
      WHERE memory_a = ? AND memory_b = ?
    `);

    // Wrap in transaction for batch efficiency
    this.db.transaction(() => {
      for (let i = 0; i < memoryIds.length; i++) {
        for (let j = i + 1; j < memoryIds.length; j++) {
          const [a, b] = memoryIds[i] < memoryIds[j]
            ? [memoryIds[i], memoryIds[j]]
            : [memoryIds[j], memoryIds[i]];

          // Get current stats to calculate new strength
          const conn = this.getOrCreateConnection(a, b);
          const newCoUseful = conn.co_useful + 1;
          const newCoRetrievals = Math.max(conn.co_retrievals, newCoUseful);

          // Calculate strength with diminishing returns
          const usefulRatio = newCoUseful / Math.max(1, newCoRetrievals);
          const diminished = Math.sqrt(usefulRatio);
          const confidence = Math.min(1, newCoUseful / 3); // Require 3+ co-useful for strong connection
          const newStrength = diminished * confidence;

          updateStmt.run(newCoUseful, newStrength, a, b);
        }
      }
    })();
  }

  /**
   * Decay unused connections (called during consolidation)
   */
  decayConnections(daysThreshold: number = 30, decayFactor: number = 0.9): number {
    const result = this.db.prepare(`
      UPDATE memory_connections
      SET strength = strength * ?
      WHERE last_fired < datetime('now', '-' || ? || ' days')
        AND strength > 0.05
    `).run(decayFactor, daysThreshold);

    // Clean up very weak connections
    this.db.prepare(`
      DELETE FROM memory_connections WHERE strength < 0.05
    `).run();

    return result.changes;
  }

  // ============ Retrieval Logs (Deferred Learning) ============

  /**
   * Log a retrieval for later learning
   */
  createRetrievalLog(
    sessionId: string,
    recallId: string,
    query: string,
    memoryIds: string[]
  ): RetrievalLog {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO retrieval_logs (id, session_id, recall_id, query, memory_ids)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, sessionId, recallId, query, JSON.stringify(memoryIds));
    return this.getRetrievalLog(recallId)!;
  }

  getRetrievalLog(recallId: string): RetrievalLog | null {
    const row = this.stmt("SELECT * FROM retrieval_logs WHERE recall_id = ?").get(recallId) as Record<string, unknown> | undefined;
    return row ? this.rowToRetrievalLog(row) : null;
  }

  /**
   * Update retrieval log with LLM feedback
   */
  updateRetrievalFeedback(recallId: string, usefulIds: string[], needMore: boolean): boolean {
    const result = this.db.prepare(`
      UPDATE retrieval_logs
      SET useful_ids = ?, need_more = ?
      WHERE recall_id = ?
    `).run(JSON.stringify(usefulIds), needMore ? 1 : 0, recallId);
    return result.changes > 0;
  }

  /**
   * Get unprocessed retrieval logs for learning
   */
  getUnprocessedRetrievalLogs(limit: number = 100): RetrievalLog[] {
    const rows = this.stmt(`
      SELECT * FROM retrieval_logs
      WHERE processed = 0 AND useful_ids IS NOT NULL
      ORDER BY timestamp ASC
      LIMIT ?
    `).all(limit) as Record<string, unknown>[];
    return rows.map(r => this.rowToRetrievalLog(r));
  }

  /**
   * Mark retrieval logs as processed
   */
  markRetrievalLogsProcessed(ids: string[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    this.db.prepare(`
      UPDATE retrieval_logs SET processed = 1 WHERE id IN (${placeholders})
    `).run(...ids);
  }

  /**
   * Clean up old retrieval logs
   */
  cleanupRetrievalLogs(daysOld: number = 7): number {
    const result = this.db.prepare(`
      DELETE FROM retrieval_logs
      WHERE processed = 1 AND timestamp < datetime('now', '-' || ? || ' days')
    `).run(daysOld);
    return result.changes;
  }

  // ============ Consolidation Checkpoints ============

  /**
   * Create a new consolidation checkpoint
   */
  createCheckpoint(runId: string, phase: ConsolidationCheckpoint["phase"], batchesTotal: number): ConsolidationCheckpoint {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO consolidation_checkpoints (id, run_id, phase, batches_total)
      VALUES (?, ?, ?, ?)
    `).run(id, runId, phase, batchesTotal);
    return this.getCheckpoint(runId)!;
  }

  /**
   * Get checkpoint by run_id
   */
  getCheckpoint(runId: string): ConsolidationCheckpoint | null {
    const row = this.stmt("SELECT * FROM consolidation_checkpoints WHERE run_id = ?").get(runId) as Record<string, unknown> | undefined;
    return row ? this.rowToCheckpoint(row) : null;
  }

  /**
   * Get the latest incomplete checkpoint (for resume)
   */
  getIncompleteCheckpoint(): ConsolidationCheckpoint | null {
    const row = this.stmt(`
      SELECT * FROM consolidation_checkpoints
      WHERE completed_at IS NULL AND error IS NULL
      ORDER BY started_at DESC LIMIT 1
    `).get() as Record<string, unknown> | undefined;
    return row ? this.rowToCheckpoint(row) : null;
  }

  /**
   * Update checkpoint progress
   */
  updateCheckpoint(
    runId: string,
    updates: Partial<Pick<ConsolidationCheckpoint,
      "phase" | "batches_completed" | "batches_total" | "memories_processed" |
      "episodes_processed" | "digests_created" | "contradictions_found" |
      "tokens_used" | "estimated_cost_usd" | "error"
    >>
  ): ConsolidationCheckpoint | null {
    const sets: string[] = ["updated_at = CURRENT_TIMESTAMP"];
    const values: unknown[] = [];

    if (updates.phase !== undefined) {
      sets.push("phase = ?");
      values.push(updates.phase);
    }
    if (updates.batches_completed !== undefined) {
      sets.push("batches_completed = ?");
      values.push(updates.batches_completed);
    }
    if (updates.batches_total !== undefined) {
      sets.push("batches_total = ?");
      values.push(updates.batches_total);
    }
    if (updates.memories_processed !== undefined) {
      sets.push("memories_processed = ?");
      values.push(updates.memories_processed);
    }
    if (updates.episodes_processed !== undefined) {
      sets.push("episodes_processed = ?");
      values.push(updates.episodes_processed);
    }
    if (updates.digests_created !== undefined) {
      sets.push("digests_created = ?");
      values.push(updates.digests_created);
    }
    if (updates.contradictions_found !== undefined) {
      sets.push("contradictions_found = ?");
      values.push(updates.contradictions_found);
    }
    if (updates.tokens_used !== undefined) {
      sets.push("tokens_used = ?");
      values.push(updates.tokens_used);
    }
    if (updates.estimated_cost_usd !== undefined) {
      sets.push("estimated_cost_usd = ?");
      values.push(updates.estimated_cost_usd);
    }
    if (updates.error !== undefined) {
      sets.push("error = ?");
      values.push(updates.error);
    }

    values.push(runId);
    this.db.prepare(`UPDATE consolidation_checkpoints SET ${sets.join(", ")} WHERE run_id = ?`).run(...values);
    return this.getCheckpoint(runId);
  }

  /**
   * Mark checkpoint as complete
   */
  completeCheckpoint(runId: string): void {
    this.db.prepare(`
      UPDATE consolidation_checkpoints
      SET phase = 'complete', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE run_id = ?
    `).run(runId);
  }

  /**
   * Get recent checkpoints for reporting
   */
  getRecentCheckpoints(limit: number = 10): ConsolidationCheckpoint[] {
    const rows = this.stmt(`
      SELECT * FROM consolidation_checkpoints
      ORDER BY started_at DESC LIMIT ?
    `).all(limit) as Record<string, unknown>[];
    return rows.map(r => this.rowToCheckpoint(r));
  }

  /**
   * Get total spending in the last 24 hours
   */
  getDailySpending(): number {
    const row = this.stmt(`
      SELECT COALESCE(SUM(estimated_cost_usd), 0) as total
      FROM consolidation_checkpoints
      WHERE started_at >= datetime('now', '-1 day')
    `).get() as { total: number };
    return row.total;
  }

  // ============ Consolidation Config ============

  /**
   * Get a config value
   */
  getConfig(key: string): string | null {
    const row = this.stmt("SELECT value FROM consolidation_config WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /**
   * Get a config value as number
   */
  getConfigNumber(key: string, defaultValue: number): number {
    const value = this.getConfig(key);
    return value ? parseFloat(value) : defaultValue;
  }

  /**
   * Set a config value
   */
  setConfig(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO consolidation_config (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP
    `).run(key, value, value);
  }

  /**
   * Get all config values
   */
  getAllConfig(): Record<string, string> {
    const rows = this.stmt("SELECT key, value FROM consolidation_config").all() as Array<{ key: string; value: string }>;
    const config: Record<string, string> = {};
    for (const row of rows) {
      config[row.key] = row.value;
    }
    return config;
  }

  private rowToCheckpoint(row: Record<string, unknown>): ConsolidationCheckpoint {
    return {
      id: row.id as string,
      run_id: row.run_id as string,
      phase: row.phase as ConsolidationCheckpoint["phase"],
      batches_completed: row.batches_completed as number,
      batches_total: row.batches_total as number,
      memories_processed: row.memories_processed as number,
      episodes_processed: row.episodes_processed as number,
      digests_created: row.digests_created as number,
      contradictions_found: row.contradictions_found as number,
      tokens_used: row.tokens_used as number,
      estimated_cost_usd: row.estimated_cost_usd as number,
      started_at: new Date(row.started_at as string),
      updated_at: new Date(row.updated_at as string),
      completed_at: row.completed_at ? new Date(row.completed_at as string) : null,
      error: row.error as string | null,
    };
  }

  // ============ Statistics ============

  getStats(): {
    memories: number;
    entities: number;
    relations: number;
    observations: number;
    digests: number;
    contradictions: number;
    episodes: number;
    unconsolidated_episodes: number;
  } {
    // Single query for all stats - much faster than separate queries
    const row = this.stmt(`
      SELECT
        (SELECT COUNT(*) FROM memories) as memories,
        (SELECT COUNT(*) FROM entities) as entities,
        (SELECT COUNT(*) FROM relations) as relations,
        (SELECT COUNT(*) FROM observations) as observations,
        (SELECT COUNT(*) FROM digests) as digests,
        (SELECT COUNT(*) FROM contradictions WHERE resolved = 0) as contradictions,
        (SELECT COUNT(*) FROM episodes) as episodes,
        (SELECT COUNT(*) FROM episodes WHERE consolidated = 0) as unconsolidated_episodes
    `).get() as {
      memories: number;
      entities: number;
      relations: number;
      observations: number;
      digests: number;
      contradictions: number;
      episodes: number;
      unconsolidated_episodes: number;
    };

    return row;
  }

  // ============ Utilities ============

  close(): void {
    this.db.close();
  }

  /**
   * Get a cached prepared statement - avoids re-parsing SQL
   */
  private stmt(sql: string): Database.Statement {
    let cached = this.stmtCache.get(sql);
    if (!cached) {
      cached = this.db.prepare(sql);
      this.stmtCache.set(sql, cached);
    }
    return cached;
  }

  private rowToMemory(row: Record<string, unknown>): Memory {
    return {
      id: row.id as string,
      content: row.content as string,
      source: row.source as string,
      timestamp: new Date(row.timestamp as string),
      event_time: row.event_time ? new Date(row.event_time as string) : null,
      importance: row.importance as number,
      access_count: row.access_count as number,
      last_accessed: row.last_accessed ? new Date(row.last_accessed as string) : null,
      stability: (row.stability as number) ?? 1.0,
      emotional_weight: (row.emotional_weight as number) ?? 0.5,
      disabled: Boolean(row.disabled),
    };
  }

  private rowToEntity(row: Record<string, unknown>): Entity {
    return {
      id: row.id as string,
      name: row.name as string,
      type: row.type as Entity["type"],
      created_at: new Date(row.created_at as string),
      metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
    };
  }

  private rowToObservation(row: Record<string, unknown>): Observation {
    return {
      id: row.id as string,
      entity_id: row.entity_id as string,
      content: row.content as string,
      source_memory_id: row.source_memory_id as string | null,
      confidence: row.confidence as number,
      valid_from: new Date(row.valid_from as string),
      valid_until: row.valid_until ? new Date(row.valid_until as string) : null,
    };
  }

  private rowToRelation(row: Record<string, unknown>): Relation {
    return {
      id: row.id as string,
      from_entity: row.from_entity as string,
      to_entity: row.to_entity as string,
      type: row.type as string,
      properties: row.properties ? JSON.parse(row.properties as string) : null,
      created_at: new Date(row.created_at as string),
    };
  }

  private rowToDigest(row: Record<string, unknown>): Digest {
    return {
      id: row.id as string,
      content: row.content as string,
      level: row.level as number,
      topic: row.topic as string | null,
      entity_id: row.entity_id as string | null,
      source_count: row.source_count as number,
      created_at: new Date(row.created_at as string),
      period_start: row.period_start ? new Date(row.period_start as string) : new Date(),
      period_end: row.period_end ? new Date(row.period_end as string) : new Date(),
    };
  }

  private rowToContradiction(row: Record<string, unknown>): Contradiction {
    return {
      id: row.id as string,
      entity_id: row.entity_id as string | null,
      memory_id_a: row.memory_id_a as string,
      memory_id_b: row.memory_id_b as string,
      description: row.description as string,
      resolved: Boolean(row.resolved),
      resolution: row.resolution as string | null,
      created_at: new Date(row.created_at as string),
      resolved_at: row.resolved_at ? new Date(row.resolved_at as string) : null,
    };
  }

  private rowToConnection(row: Record<string, unknown>): MemoryConnection {
    return {
      id: row.id as string,
      memory_a: row.memory_a as string,
      memory_b: row.memory_b as string,
      strength: row.strength as number,
      co_retrievals: row.co_retrievals as number,
      co_useful: row.co_useful as number,
      last_fired: row.last_fired ? new Date(row.last_fired as string) : null,
      created_at: new Date(row.created_at as string),
    };
  }

  private rowToRetrievalLog(row: Record<string, unknown>): RetrievalLog {
    return {
      id: row.id as string,
      session_id: row.session_id as string,
      recall_id: row.recall_id as string,
      query: row.query as string,
      memory_ids: JSON.parse(row.memory_ids as string),
      useful_ids: row.useful_ids ? JSON.parse(row.useful_ids as string) : null,
      need_more: Boolean(row.need_more),
      timestamp: new Date(row.timestamp as string),
      processed: Boolean(row.processed),
    };
  }
}
