# Engram Development - Living Plan

**Last Updated**: 2024-12-22 03:50 UTC

This file tracks development progress. If context is lost, read this file to continue.

---

## Current Status: Phase 5 - Production Ready

### Completed
- [x] Project structure created
- [x] package.json, tsconfig.json, .gitignore, LICENSE
- [x] SQLite storage layer (`src/storage/database.ts`)
  - Memories table with FTS5 for BM25
  - Entities, Observations, Relations tables
  - Graph traversal queries
  - All CRUD operations
- [x] Entity extractor (`src/graph/extractor.ts`)
  - Heuristic-based name extraction
  - Organization detection (Goldman Sachs, etc.)
  - Known organizations database
  - Relationship extraction
  - No external dependencies
- [x] Knowledge graph manager (`src/graph/knowledge-graph.ts`)
  - High-level graph operations
  - Auto-extraction from text
  - Graph traversal
- [x] ColBERT Python bridge (`src/retrieval/colbert-bridge.py`)
  - RAGatouille integration
  - JSON stdin/stdout protocol
- [x] TypeScript ColBERT wrapper (`src/retrieval/colbert.ts`)
  - Subprocess management
  - Fallback SimpleRetriever when Python unavailable
- [x] Hybrid search (`src/retrieval/hybrid.ts`)
  - BM25 + Semantic + Graph
  - Reciprocal Rank Fusion (RRF)
- [x] MCP server with all tools (`src/index.ts`)
  - remember, recall, forget
  - create_entity, observe, relate, query_entity, list_entities
  - stats
- [x] Install dependencies and build
- [x] Test end-to-end with fictive examples (11 tests pass)
- [x] Entity extraction improvements
  - Goldman Sachs correctly detected as organization
  - Known organizations database
  - Place filtering (California, etc.)
  - Nationality/religion filtering

### Verified Working
- All 11 MCP test cases pass
- BM25 search working (FTS5)
- Graph-based entity linking working
- ColBERT Python bridge working
- Entity extraction correctly identifies orgs vs persons

---

## File Structure

```
engram/
├── src/
│   ├── index.ts              # MCP server (DONE)
│   ├── storage/
│   │   ├── database.ts       # SQLite + FTS5 (DONE)
│   │   └── index.ts          # Exports (DONE)
│   ├── graph/
│   │   ├── extractor.ts      # Entity extraction (DONE)
│   │   ├── knowledge-graph.ts # Graph operations (DONE)
│   │   └── index.ts          # Exports (DONE)
│   ├── retrieval/
│   │   ├── colbert.ts        # TypeScript wrapper (DONE)
│   │   ├── colbert-bridge.py # Python RAGatouille (DONE)
│   │   ├── hybrid.ts         # RRF fusion (DONE)
│   │   └── index.ts          # Exports (DONE)
├── tests/
│   ├── test-interactive.js   # Full test suite (DONE)
│   └── test-mcp.sh           # Shell test script (DONE)
├── dist/                     # Compiled JS (auto-generated)
├── package.json              # Dependencies (DONE)
├── tsconfig.json             # TypeScript config (DONE)
├── README.md                 # Documentation (DONE)
└── LIVING_PLAN.md            # This file (DONE)
```

---

## MCP Tools Available

1. **remember** - Store a new memory, auto-extracts entities
2. **recall** - Hybrid search (BM25 + semantic + graph)
3. **forget** - Remove a memory by ID
4. **create_entity** - Manually create an entity
5. **observe** - Add an observation about an entity
6. **relate** - Create a relationship between entities
7. **query_entity** - Get entity details and relationships
8. **list_entities** - List all entities by type
9. **stats** - Get memory/entity/relation counts

---

## Key Decisions

1. **ColBERT via Python**: RAGatouille is proven, well-maintained. Use subprocess.
2. **BM25 via SQLite FTS5**: Already implemented, zero deps.
3. **Local-first**: No API keys required.
4. **Entity extraction**: Heuristics + known org database. Can add GLiNER later.
5. **Hybrid Search**: RRF fusion with k=60 constant.

---

## Testing Commands

```bash
# Build TypeScript
cd /Users/biobook/Code/stuff/engram
npm install
npm run build

# Run full test suite
node tests/test-interactive.js

# Test MCP server manually
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/index.js

# Install as MCP for Claude Desktop
# Add to ~/.claude/claude_desktop_config.json:
# {
#   "mcpServers": {
#     "engram": {
#       "command": "node",
#       "args": ["/Users/biobook/Code/stuff/engram/dist/index.js"]
#     }
#   }
# }
```

---

## Known Limitations

- Windows not supported (RAGatouille limitation)
- ColBERT models are ~500MB (downloaded on first use)
- BM25 scores for named entities are low (graph search compensates)
- Place extraction not implemented (California detected as person)

---

## Future Enhancements

- [ ] GLiNER for better NER
- [ ] Gemini embeddings (optional cloud enhancement)
- [ ] Cohere reranking (optional cloud enhancement)
- [ ] Temporal memory decay
- [ ] Memory consolidation (merge similar memories)
- [ ] Export/import functionality

---

## To Continue Development

If starting fresh, run these commands:

```bash
cd /Users/biobook/Code/stuff/engram
cat LIVING_PLAN.md  # Read this file
npm run build       # Rebuild if needed
node tests/test-interactive.js  # Run tests
```

---

## API Keys Needed

**NONE** - This is a local-first implementation.

Optional (for future cloud enhancement):
- GEMINI_API_KEY - embeddings
- COHERE_API_KEY - reranking
