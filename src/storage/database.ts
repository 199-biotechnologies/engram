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
  timestamp: Date;
  importance: number;
  access_count: number;
  last_accessed: Date | null;
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
    // Memories table
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

      CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp);
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
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
  }

  // ============ Memory Operations ============

  createMemory(
    content: string,
    source: string = "conversation",
    importance: number = 0.5
  ): Memory {
    const id = randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO memories (id, content, source, importance)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(id, content, source, importance);
    return this.getMemory(id)!;
  }

  getMemory(id: string): Memory | null {
    const row = this.stmt("SELECT * FROM memories WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToMemory(row) : null;
  }

  updateMemory(id: string, updates: Partial<Pick<Memory, "content" | "importance">>): Memory | null {
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

  touchMemory(id: string): void {
    this.stmt(`UPDATE memories SET access_count = access_count + 1, last_accessed = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
  }

  getAllMemories(limit: number = 1000): Memory[] {
    const rows = this.stmt("SELECT * FROM memories ORDER BY timestamp DESC LIMIT ?").all(limit) as Record<string, unknown>[];
    return rows.map((row) => this.rowToMemory(row));
  }

  // ============ BM25 Search ============

  searchBM25(query: string, limit: number = 20): Array<Memory & { score: number }> {
    // Escape special FTS5 characters and format query
    const escapedQuery = this.escapeFTS5Query(query);
    const rows = this.stmt(`
      SELECT m.*, bm25(memories_fts) as score
      FROM memories_fts fts
      JOIN memories m ON fts.rowid = m.rowid
      WHERE memories_fts MATCH ?
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
   * Catches "Boris D" matching "Boris Djordjevic", "John" matching "John Smith"
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

    // One is prefix of the other (e.g., "Boris" vs "Boris Djordjevic")
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

    // Check for abbreviated names (e.g., "Boris D" vs "Boris Djordjevic")
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

  // ============ Statistics ============

  getStats(): {
    memories: number;
    entities: number;
    relations: number;
    observations: number;
  } {
    // Single query for all stats - much faster than 4 separate queries
    const row = this.stmt(`
      SELECT
        (SELECT COUNT(*) FROM memories) as memories,
        (SELECT COUNT(*) FROM entities) as entities,
        (SELECT COUNT(*) FROM relations) as relations,
        (SELECT COUNT(*) FROM observations) as observations
    `).get() as { memories: number; entities: number; relations: number; observations: number };

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
      importance: row.importance as number,
      access_count: row.access_count as number,
      last_accessed: row.last_accessed ? new Date(row.last_accessed as string) : null,
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
}
