# Engram Implementation Plan

## Overview

Build a local-first MCP memory server with SOTA retrieval quality using ColBERT + BM25 hybrid search and a lightweight knowledge graph.

## Core Insight

**The 80/20**: ColBERT (via RAGatouille) gives us embedding + reranking in one model, with better out-of-domain generalization than dense embeddings. Combined with BM25 for exact matches, this beats most API-based solutions while running entirely locally.

---

## Phase 1: Foundation

### 1.1 Project Setup
- TypeScript + Node.js (MCP standard)
- ESM modules
- Directory structure:
  ```
  engram/
  ├── src/
  │   ├── index.ts          # MCP server entry
  │   ├── mcp/              # Tool definitions
  │   ├── retrieval/        # ColBERT + BM25
  │   ├── graph/            # Knowledge graph
  │   ├── storage/          # SQLite operations
  │   └── utils/            # Helpers
  ├── models/               # Downloaded models
  ├── tests/
  └── scripts/
  ```

### 1.2 Storage Layer (SQLite)
Single SQLite database with tables:

```sql
-- Memories: raw content
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  source TEXT,                    -- 'conversation', 'import', etc.
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  importance REAL DEFAULT 0.5,    -- 0-1 score
  access_count INTEGER DEFAULT 0,
  last_accessed DATETIME
);

-- FTS5 for BM25 search
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content,
  content='memories',
  content_rowid='rowid'
);

-- Entities: nodes in knowledge graph
CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,             -- 'person', 'place', 'concept', 'event'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  metadata JSON
);

-- Observations: facts about entities
CREATE TABLE observations (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(id),
  content TEXT NOT NULL,
  source_memory_id TEXT REFERENCES memories(id),
  confidence REAL DEFAULT 1.0,
  valid_from DATETIME DEFAULT CURRENT_TIMESTAMP,
  valid_until DATETIME,           -- NULL = still valid
  UNIQUE(entity_id, content)
);

-- Relations: edges between entities
CREATE TABLE relations (
  id TEXT PRIMARY KEY,
  from_entity TEXT NOT NULL REFERENCES entities(id),
  to_entity TEXT NOT NULL REFERENCES entities(id),
  type TEXT NOT NULL,             -- 'sibling', 'knows', 'works_at', etc.
  properties JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 1.3 MCP Server Skeleton
- Implement MCP protocol handlers
- Tool registration
- Error handling
- Logging

---

## Phase 2: Retrieval Engine

### 2.1 ColBERT Integration

**Option A: RAGatouille (Python)**
- Proven, well-maintained
- Need Python subprocess or microservice
- ~500MB model size

**Option B: FastEmbed + ColBERT (Node.js)**
- Native Node.js via ONNX
- fastembed-js has ColBERT support
- May be less mature

**Decision**: Start with Python subprocess calling RAGatouille. If latency is issue, migrate to ONNX later.

```typescript
// src/retrieval/colbert.ts
class ColBERTRetriever {
  private pythonProcess: ChildProcess;

  async index(documents: Document[]): Promise<void>;
  async search(query: string, k: number): Promise<SearchResult[]>;
  async rerank(query: string, docs: Document[]): Promise<RankedResult[]>;
}
```

### 2.2 BM25 via SQLite FTS5

```typescript
// src/retrieval/bm25.ts
class BM25Retriever {
  async search(query: string, k: number): Promise<SearchResult[]> {
    return db.all(`
      SELECT m.*, bm25(memories_fts) as score
      FROM memories_fts
      JOIN memories m ON memories_fts.rowid = m.rowid
      WHERE memories_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `, [query, k]);
  }
}
```

### 2.3 Hybrid Search with RRF

Reciprocal Rank Fusion combines rankings:

```typescript
// src/retrieval/hybrid.ts
function reciprocalRankFusion(
  rankings: SearchResult[][],
  k: number = 60
): SearchResult[] {
  const scores = new Map<string, number>();

  for (const ranking of rankings) {
    for (let i = 0; i < ranking.length; i++) {
      const docId = ranking[i].id;
      const rrf = 1 / (k + i + 1);
      scores.set(docId, (scores.get(docId) || 0) + rrf);
    }
  }

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ id, score }));
}
```

---

## Phase 3: Knowledge Graph

### 3.1 Entity Extraction

**Option A: Local NER model**
- GLiNER or similar
- Runs locally
- Generic entities

**Option B: LLM-based (using calling model)**
- More accurate for personal context
- Already in conversation
- Prompt engineering needed

**Decision**: Start with regex/heuristics for names (capitalized words), dates, etc. Add GLiNER later if needed.

```typescript
// src/graph/extractor.ts
class EntityExtractor {
  extractPersons(text: string): string[] {
    // Heuristic: capitalized words not at sentence start
    // + common name patterns
  }

  extractDates(text: string): Date[] {
    // chrono-node for date parsing
  }

  extractAll(text: string): Entity[] {
    return [
      ...this.extractPersons(text).map(p => ({ name: p, type: 'person' })),
      ...this.extractDates(text).map(d => ({ name: d, type: 'date' })),
    ];
  }
}
```

### 3.2 Graph Operations

```typescript
// src/graph/knowledge-graph.ts
class KnowledgeGraph {
  async addEntity(name: string, type: EntityType): Promise<Entity>;
  async addObservation(entityId: string, content: string, sourceMemoryId?: string): Promise<Observation>;
  async addRelation(from: string, to: string, type: string): Promise<Relation>;

  async getEntity(id: string): Promise<EntityWithObservations>;
  async findEntities(query: string): Promise<Entity[]>;

  async traverse(
    startEntity: string,
    depth: number,
    relationTypes?: string[]
  ): Promise<GraphTraversal>;
}
```

### 3.3 Graph-Enhanced Retrieval

When recalling, expand search with graph context:

```typescript
async function recallWithGraph(query: string, k: number): Promise<Memory[]> {
  // 1. Hybrid search
  const hybridResults = await hybridSearch(query, k * 2);

  // 2. Extract entities from query
  const queryEntities = entityExtractor.extractAll(query);

  // 3. Get related observations
  const relatedObs = [];
  for (const entity of queryEntities) {
    const e = await graph.findEntities(entity.name);
    if (e.length > 0) {
      const traversal = await graph.traverse(e[0].id, depth: 2);
      relatedObs.push(...traversal.observations);
    }
  }

  // 4. Add source memories from observations to candidate pool
  const candidateIds = new Set([
    ...hybridResults.map(r => r.id),
    ...relatedObs.map(o => o.source_memory_id).filter(Boolean)
  ]);

  // 5. ColBERT rerank all candidates
  const candidates = await getMemoriesById([...candidateIds]);
  return await colbert.rerank(query, candidates, k);
}
```

---

## Phase 4: MCP Tools

### 4.1 Core Tools

```typescript
const tools = [
  {
    name: 'remember',
    description: 'Store a new memory',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The memory content' },
        source: { type: 'string', description: 'Source of the memory' },
        importance: { type: 'number', description: '0-1 importance score' }
      },
      required: ['content']
    }
  },
  {
    name: 'recall',
    description: 'Retrieve relevant memories',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for' },
        limit: { type: 'number', default: 5 },
        include_graph: { type: 'boolean', default: true }
      },
      required: ['query']
    }
  },
  // ... other tools
];
```

### 4.2 Tool Implementations

```typescript
// src/mcp/tools/remember.ts
async function remember(params: RememberParams): Promise<RememberResult> {
  // 1. Store memory
  const memory = await storage.createMemory({
    content: params.content,
    source: params.source || 'conversation',
    importance: params.importance || 0.5
  });

  // 2. Index for ColBERT
  await colbert.index([{ id: memory.id, text: memory.content }]);

  // 3. Index for BM25 (automatic via FTS5 trigger)

  // 4. Extract and store entities
  const entities = entityExtractor.extractAll(params.content);
  for (const entity of entities) {
    const e = await graph.addEntity(entity.name, entity.type);
    // Create observation linking entity to this memory
    await graph.addObservation(e.id, params.content, memory.id);
  }

  return { id: memory.id, entities: entities.map(e => e.name) };
}
```

---

## Phase 5: Optimizations

### 5.1 Temporal Decay

Recent memories weighted higher:

```typescript
function temporalScore(memory: Memory, now: Date): number {
  const ageInDays = (now.getTime() - memory.timestamp.getTime()) / (1000 * 60 * 60 * 24);
  // Exponential decay with half-life of 30 days
  return Math.exp(-0.693 * ageInDays / 30);
}

function combinedScore(memory: Memory, retrievalScore: number): number {
  const temporal = temporalScore(memory, new Date());
  const importance = memory.importance;
  const access = Math.log(1 + memory.access_count) / 10;

  return retrievalScore * (0.6 + 0.2 * temporal + 0.1 * importance + 0.1 * access);
}
```

### 5.2 Memory Consolidation

Merge similar memories over time:

```typescript
async function consolidate(): Promise<void> {
  // Find similar memories (high ColBERT similarity)
  const clusters = await findSimilarClusters(threshold: 0.9);

  for (const cluster of clusters) {
    if (cluster.length > 1) {
      // Merge into single consolidated memory
      const merged = mergeMemories(cluster);
      await storage.createMemory(merged);
      await storage.archiveMemories(cluster.map(m => m.id));
    }
  }
}
```

### 5.3 Lazy Loading

Don't load ColBERT until first use:

```typescript
class LazyColBERT {
  private instance: ColBERTRetriever | null = null;

  async get(): Promise<ColBERTRetriever> {
    if (!this.instance) {
      this.instance = await ColBERTRetriever.initialize();
    }
    return this.instance;
  }
}
```

---

## Phase 6: Optional Cloud Enhancement

### 6.1 Graceful Degradation

```typescript
class HybridEmbedder {
  async embed(texts: string[]): Promise<number[][]> {
    if (process.env.GEMINI_API_KEY) {
      try {
        return await geminiEmbed(texts);
      } catch (e) {
        console.warn('Gemini unavailable, falling back to local');
      }
    }
    return await qwen3Embed(texts);
  }
}
```

### 6.2 Smart API Usage

Only use APIs when it adds value:

```typescript
async function recall(query: string): Promise<Memory[]> {
  // Local ColBERT for retrieval (always)
  const candidates = await localRetrieval(query);

  // Use Cohere rerank only for ambiguous queries
  if (process.env.COHERE_API_KEY && candidates.length > 10) {
    const topScores = candidates.slice(0, 5).map(c => c.score);
    const variance = calculateVariance(topScores);

    if (variance < 0.1) {
      // Scores too close - worth API rerank
      return await cohereRerank(query, candidates);
    }
  }

  return candidates.slice(0, 5);
}
```

---

## Implementation Order

### Week 1: Core
1. Project setup (TypeScript, deps, structure)
2. SQLite schema + storage layer
3. MCP server skeleton with remember/recall stubs

### Week 2: Retrieval
4. BM25 via FTS5
5. RAGatouille Python bridge
6. Hybrid search with RRF
7. Basic remember/recall working

### Week 3: Knowledge Graph
8. Entity extraction (regex/heuristics)
9. Graph schema + operations
10. Graph-enhanced retrieval

### Week 4: Polish
11. Temporal decay
12. Export/import
13. Testing
14. Documentation

---

## Dependencies

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "latest",
    "better-sqlite3": "^9.0.0",
    "chrono-node": "^2.7.0",
    "uuid": "^9.0.0",
    "zod": "^3.22.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^20.0.0",
    "typescript": "^5.0.0",
    "vitest": "^1.0.0"
  }
}
```

Python dependencies (for ColBERT):
```
ragatouille>=0.0.8
torch>=2.0.0
```

---

## Success Metrics

1. **Retrieval Quality**: Manually test with 50 queries, measure if correct memory is in top-3
2. **Latency**: recall < 100ms, remember < 200ms
3. **Storage**: < 100MB for 10,000 memories (excluding model)
4. **Reliability**: Zero crashes in 1-week daily use

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| RAGatouille Python bridge adds latency | Start Python process once, keep alive |
| ColBERT model too large | Use quantized version, lazy load |
| Entity extraction inaccurate | Start simple, add GLiNER if needed |
| SQLite concurrent access | Use WAL mode, single writer |

---

## Future Extensions

- **Voice memos**: Whisper transcription → memory
- **Image memories**: CLIP embeddings
- **Calendar integration**: Auto-import events
- **Journaling mode**: Daily summary generation
- **Multi-user**: Shared knowledge graphs
