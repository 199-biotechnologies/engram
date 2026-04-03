# Engram v0.14.0 Upgrade — Design Spec

## Goal
Modernize engram by removing Python dependency, consolidating storage, updating MCP patterns, and reducing cost — without bloating the codebase.

## 10 Changes (All Parallel via Worktrees)

### Agent 1: deps-agent (package.json)
- Bump `@modelcontextprotocol/sdk` from `^1.25.0` to `^1.27.1`
- Add `@huggingface/transformers` (v3 stable — v4 is preview)
- Add `sqlite-vec` package
- Remove any `jina-grep` or `colbert` references from package.json
- Run `npm install` to regenerate lock file
- Bump version to `0.14.0`

### Agent 2: consolidation-agent (src/consolidation/consolidator.ts)
- In `consolidateBatch()`: change model from `claude-opus-4-6-20250514` to `claude-sonnet-4-6-20250514`
- Remove `temperature: 1` and `thinking` block (Sonnet doesn't need extended thinking for summarization)
- Reduce `max_tokens` from 16000 to 8000
- Keep `consolidateEntity()` on Opus (entity profiles need deeper reasoning)
- Update comments to reflect the change

### Agent 3: database-agent (src/storage/database.ts)
- Load sqlite-vec extension at database initialization
- Create `vec_memories` virtual table: `CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(memory_id TEXT, embedding float[384])`
- Add methods: `insertVector(memoryId, embedding)`, `searchVectors(queryEmbedding, k)`, `deleteVector(memoryId)`, `hasVector(memoryId)`
- Add `exportAll()` method returning all memories, entities, relations, observations as JSON
- Add `importAll(data)` method that restores from JSON export
- Add `findSimilar(embedding, threshold)` for duplicate detection (cosine similarity > 0.92)
- Keep all existing methods intact

### Agent 4: readme-agent (README.md, CONTRIBUTING.md)
- Remove `COLBERT_MODEL` from configuration table
- Remove `EMBEDDING_MODEL` env var (now auto-detected)
- Remove "pip install jina-grep" from build instructions
- Update "Semantic search" description to mention Transformers.js instead of Jina
- Update performance table if needed
- Keep all other content intact

### Agent 5: retrieval-agent (src/retrieval/)
- Create `src/retrieval/embedder.ts`: new `TransformersEmbedder` class
  - Uses `@huggingface/transformers` pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
  - Lazy-loads model on first use
  - Methods: `embed(texts)`, `search(query, k)`, `index(documents)`, `add(documents)`, `delete(ids)`, `rerank(query, docs, k)`
  - All vector storage goes through database sqlite-vec methods (passed via constructor)
  - 384-dim output, L2-normalized
- Update `src/retrieval/hybrid.ts`:
  - Change import from `./jina.js` to `./embedder.js`
  - Update type references from `JinaRetriever`/`SimpleRetriever` to `TransformersEmbedder`
  - Adjust any dimension-specific logic
- Delete `src/retrieval/jina.ts` and `src/retrieval/jina-bridge.py`
- Update `src/retrieval/index.ts` exports

### Agent 6: tools-agent (src/index.ts, src/settings.ts)
- Fix version: read from package.json instead of hardcoded "0.8.0"
- Remove web server auto-start from `initialize()` (keep `engram_web` tool for on-demand start)
- Add `outputSchema` to recall tool defining the return structure
- Add `export_memories` tool: calls database exportAll(), returns JSON
- Add `import_memories` tool: accepts JSON, calls database importAll()
- Add duplicate detection to `remember` handler: before storing, compute embedding similarity against existing memories, warn if >0.92 match found
- Remove `COLBERT_MODEL` from settings.ts if referenced
- Wire new `TransformersEmbedder` in place of `createRetriever`

## Interface Contract (Shared Between Agents)

Database vector methods that retrieval-agent and tools-agent depend on:
```typescript
// In EngramDatabase (added by database-agent)
insertVector(memoryId: string, embedding: Float32Array): void
searchVectors(queryEmbedding: Float32Array, k: number): Array<{memoryId: string, distance: number}>
deleteVector(memoryId: string): void
findSimilar(embedding: Float32Array, threshold: number): Array<{memoryId: string, distance: number}>
exportAll(): { memories: Memory[], entities: Entity[], relations: Relation[], observations: Observation[], digests: Digest[] }
importAll(data: { memories: any[], entities: any[], relations: any[], observations: any[], digests: any[] }): { imported: number }
```

Embedder interface:
```typescript
// In TransformersEmbedder (created by retrieval-agent)
class TransformersEmbedder {
  constructor(db: EngramDatabase)
  embed(texts: string[]): Promise<Float32Array[]>
  search(query: string, k: number): Promise<SearchResult[]>
  index(documents: Document[]): Promise<{success: boolean, count: number}>
  add(documents: Document[]): Promise<{success: boolean, count: number}>
  delete(ids: string[]): Promise<{success: boolean, count: number}>
  rerank(query: string, documents: Document[], k: number): Promise<SearchResult[]>
}
```

## Verification Strategy
- Each agent's work is reviewed by Codex (GPT-5.4) after completion
- `npm run build` must pass after all merges
- `npm run test:run` must pass
- Manual smoke test of remember/recall cycle

## Non-Goals
- No new graph database (keep SQLite graph)
- No SaaS/cloud features
- No renaming the project
- No UI changes to web interface
