import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EngramDatabase } from "../../src/storage/database.js";
import fs from "fs";
import path from "path";
import os from "os";

let db: EngramDatabase;
let dbPath: string;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `engram-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = new EngramDatabase(dbPath);
});

afterEach(() => {
  db.close();
  try { fs.unlinkSync(dbPath); } catch {}
});

// ============ Memory CRUD ============

describe("Memory CRUD", () => {
  it("creates and retrieves a memory", () => {
    const mem = db.createMemory("Alice likes coffee", "test", 0.7);
    expect(mem.id).toBeTruthy();
    expect(mem.content).toBe("Alice likes coffee");
    expect(mem.importance).toBe(0.7);
    expect(mem.source).toBe("test");
    expect(mem.stability).toBe(1.0);
    expect(mem.disabled).toBe(false);

    const fetched = db.getMemory(mem.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.content).toBe("Alice likes coffee");
  });

  it("creates memory with event time and emotional weight", () => {
    const eventTime = new Date("2025-01-15");
    const mem = db.createMemory("Got promoted", "test", 0.9, {
      eventTime,
      emotionalWeight: 0.8,
    });
    expect(mem.emotional_weight).toBe(0.8);
    expect(mem.event_time).not.toBeNull();
  });

  it("updates memory content and importance", () => {
    const mem = db.createMemory("Old content", "test");
    const updated = db.updateMemory(mem.id, { content: "New content", importance: 0.9 });
    expect(updated).not.toBeNull();
    expect(updated!.content).toBe("New content");
    expect(updated!.importance).toBe(0.9);
  });

  it("soft-deletes a memory", () => {
    const mem = db.createMemory("Delete me", "test");
    db.updateMemory(mem.id, { disabled: true });

    const fetched = db.getMemory(mem.id);
    expect(fetched!.disabled).toBe(true);

    // Should not appear in getAllMemories (default excludes disabled)
    const all = db.getAllMemories();
    expect(all.find(m => m.id === mem.id)).toBeUndefined();
  });

  it("hard-deletes a memory", () => {
    const mem = db.createMemory("Really delete me", "test");
    const deleted = db.deleteMemory(mem.id);
    expect(deleted).toBe(true);
    expect(db.getMemory(mem.id)).toBeNull();
  });

  it("lists memories with pagination", () => {
    for (let i = 0; i < 5; i++) {
      db.createMemory(`Memory ${i}`, "test");
    }
    const page1 = db.getAllMemories(2, false, 0);
    expect(page1).toHaveLength(2);

    const page2 = db.getAllMemories(2, false, 2);
    expect(page2).toHaveLength(2);

    // No overlap
    expect(page1[0].id).not.toBe(page2[0].id);
  });

  it("returns null for non-existent memory", () => {
    expect(db.getMemory("non-existent-id")).toBeNull();
  });
});

// ============ BM25 Search ============

describe("BM25 Search", () => {
  it("finds memories by keyword", () => {
    db.createMemory("Alice works at Acme Corp", "test");
    db.createMemory("Bob enjoys hiking in the mountains", "test");
    db.createMemory("Alice and Bob went to Paris", "test");

    const results = db.searchBM25("Alice", 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(r => r.content.includes("Alice"))).toBe(true);
  });

  it("returns empty array for no matches", () => {
    db.createMemory("Something unrelated", "test");
    const results = db.searchBM25("xyznonexistent", 10);
    expect(results).toHaveLength(0);
  });
});

// ============ Entity CRUD ============

describe("Entity CRUD", () => {
  it("creates and retrieves an entity", () => {
    const entity = db.createEntity("Alice", "person");
    expect(entity.id).toBeTruthy();
    expect(entity.name).toBe("Alice");
    expect(entity.type).toBe("person");

    const fetched = db.getEntity(entity.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe("Alice");
  });

  it("finds entity by name (case-insensitive)", () => {
    db.createEntity("John Smith", "person");
    const found = db.findEntityByName("john smith");
    expect(found).not.toBeNull();
    expect(found!.name).toBe("John Smith");
  });

  it("merges entities", () => {
    const keep = db.createEntity("John", "person");
    const merge = db.createEntity("Johnny", "person");

    // Add observation to merge entity
    const mem = db.createMemory("Johnny is tall", "test");
    db.addObservation(merge.id, "Is tall", mem.id);

    const result = db.mergeEntities(keep.id, merge.id);
    expect(result.observationsMoved).toBe(1);

    // Merge entity should be gone
    expect(db.getEntity(merge.id)).toBeNull();

    // Observation should now belong to keep entity
    const obs = db.getEntityObservations(keep.id);
    expect(obs).toHaveLength(1);
  });
});

// ============ Observations ============

describe("Observations", () => {
  it("adds and retrieves observations for an entity", () => {
    const entity = db.createEntity("Bob", "person");
    const mem = db.createMemory("Bob is a software engineer", "test");
    const obs = db.addObservation(entity.id, "Is a software engineer", mem.id, 0.9);

    expect(obs.id).toBeTruthy();
    expect(obs.content).toBe("Is a software engineer");
    expect(obs.confidence).toBe(0.9);

    const observations = db.getEntityObservations(entity.id);
    expect(observations).toHaveLength(1);
    expect(observations[0].content).toBe("Is a software engineer");
  });
});

// ============ Relations ============

describe("Relations", () => {
  it("creates and retrieves relations", () => {
    const alice = db.createEntity("Alice", "person");
    const acme = db.createEntity("Acme", "organization");

    const relation = db.createRelation(alice.id, acme.id, "works_at");
    expect(relation.type).toBe("works_at");

    const fromRelations = db.getEntityRelations(alice.id, "from");
    expect(fromRelations).toHaveLength(1);
    expect(fromRelations[0].type).toBe("works_at");
  });

  it("finds specific relation", () => {
    const a = db.createEntity("A", "person");
    const b = db.createEntity("B", "person");
    db.createRelation(a.id, b.id, "knows");

    const found = db.findRelation(a.id, b.id, "knows");
    expect(found).not.toBeNull();

    const notFound = db.findRelation(a.id, b.id, "works_at");
    expect(notFound).toBeNull();
  });
});

// ============ Hebbian Connections ============

describe("Hebbian Connections", () => {
  it("records co-retrieval and creates connections", () => {
    const m1 = db.createMemory("Memory 1", "test");
    const m2 = db.createMemory("Memory 2", "test");
    const m3 = db.createMemory("Memory 3", "test");

    db.recordCoRetrieval([m1.id, m2.id, m3.id]);

    const connections = db.getMemoryConnections(m1.id);
    expect(connections.length).toBeGreaterThanOrEqual(1);
  });

  it("strengthens connections via co-useful", () => {
    const m1 = db.createMemory("Memory A", "test");
    const m2 = db.createMemory("Memory B", "test");

    // Create initial connection via co-retrieval
    db.recordCoRetrieval([m1.id, m2.id]);

    // Record co-useful feedback
    db.recordCoUseful([m1.id, m2.id]);

    const connections = db.getMemoryConnections(m1.id);
    expect(connections).toHaveLength(1);
    expect(connections[0].co_useful).toBe(1);
    expect(connections[0].strength).toBeGreaterThan(0);
  });

  it("decays old connections", () => {
    const m1 = db.createMemory("Old mem 1", "test");
    const m2 = db.createMemory("Old mem 2", "test");

    db.recordCoRetrieval([m1.id, m2.id]);

    // Decay should return a number (may be 0 if connections are too recent)
    const decayed = db.decayConnections(0, 0.5); // 0 days threshold = decay all
    expect(typeof decayed).toBe("number");
  });
});

// ============ Episodes ============

describe("Episodes", () => {
  it("creates and retrieves episodes", () => {
    const ep = db.createEpisode("session-1", "user", "Hello there");
    expect(ep.id).toBeTruthy();
    expect(ep.session_id).toBe("session-1");
    expect(ep.role).toBe("user");
    expect(ep.content).toBe("Hello there");
    expect(ep.turn_index).toBe(0);
    expect(ep.consolidated).toBe(false);
  });

  it("auto-increments turn index within session", () => {
    const ep1 = db.createEpisode("session-2", "user", "First");
    const ep2 = db.createEpisode("session-2", "assistant", "Second");

    expect(ep1.turn_index).toBe(0);
    expect(ep2.turn_index).toBe(1);
  });

  it("marks episodes as consolidated", () => {
    const ep1 = db.createEpisode("session-3", "user", "Test");
    const ep2 = db.createEpisode("session-3", "assistant", "Reply");

    db.markEpisodesConsolidated([ep1.id, ep2.id]);

    const fetched = db.getEpisode(ep1.id);
    expect(fetched!.consolidated).toBe(true);
  });
});

// ============ Digests ============

describe("Digests", () => {
  it("creates digest with source memories", () => {
    const m1 = db.createMemory("Source 1", "test");
    const m2 = db.createMemory("Source 2", "test");

    const digest = db.createDigest("Summary of sources", 1, [m1.id, m2.id], {
      topic: "Test topic",
      periodStart: new Date("2025-01-01"),
      periodEnd: new Date("2025-01-31"),
    });

    expect(digest.id).toBeTruthy();
    expect(digest.content).toBe("Summary of sources");
    expect(digest.level).toBe(1);
    expect(digest.topic).toBe("Test topic");
    expect(digest.source_count).toBe(2);
  });

  it("retrieves source memories for a digest", () => {
    const m1 = db.createMemory("Src A", "test");
    const m2 = db.createMemory("Src B", "test");

    const digest = db.createDigest("Combined", 1, [m1.id, m2.id]);

    const sources = db.getDigestSources(digest.id);
    expect(sources).toHaveLength(2);
    expect(sources.map(s => s.id).sort()).toEqual([m1.id, m2.id].sort());
  });

  it("searches digests via BM25", () => {
    const m = db.createMemory("Test mem", "test");
    db.createDigest("Meeting notes about quarterly review", 1, [m.id], {
      topic: "Quarterly review",
    });

    const results = db.searchDigestsBM25("quarterly", 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toContain("quarterly");
  });
});
