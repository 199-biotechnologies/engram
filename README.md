# Engram

**Give your AI a perfect memory.**

Engram remembers everything you tell it—names, relationships, preferences, conversations—and recalls exactly what's relevant when you need it. No cloud. No API keys. Just memory that works.

Works with any LLM that supports MCP (Model Context Protocol)—Claude, GPT, Gemini, local models, and more.

> *An engram is a unit of cognitive information imprinted in a physical substance—the biological basis of memory.*

---

## What It Does

Tell your AI about your world:

> "My colleague Sarah is allergic to shellfish and prefers window seats. She's leading the Q1 product launch."

Later, ask:

> "I'm booking a team lunch and flights for the offsite—what should I know?"

Engram connects the dots—*avoid seafood restaurants, book Sarah a window seat, and she's probably busy with the launch*—and gives your AI the context to truly help.

**It's not just search. It's understanding.**

---

## Quick Start

### Install

```bash
npm install -g @199-bio/engram
```

### Add to Your MCP Client

**Claude Desktop** — add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": ["-y", "@199-bio/engram"]
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add engram -- npx -y @199-bio/engram
```

**Other MCP clients** — point to the `engram` command. It speaks standard MCP over stdio.

That's it. Your AI now has memory.

---

## How to Use

Just talk naturally. Your AI will remember what matters.

### Storing Memories

Say things like:
- "Remember that Sarah is allergic to shellfish"
- "My anniversary is March 15th"
- "I prefer morning meetings, never schedule anything before 9am"

### Recalling

Just ask:
- "What do you know about Sarah?"
- "When is my anniversary?"
- "What are my meeting preferences?"

Your AI automatically searches its memory and uses what's relevant.

### The Knowledge Graph

Engram doesn't just store text—it understands relationships:

- **People**: Sarah, John, Dr. Martinez
- **Places**: Office, Conference Room A, Seattle HQ
- **Organizations**: Acme Corp, Stanford, FDA
- **Connections**: Sarah → works at → Acme Corp
- **Observations**: Sarah is allergic to shellfish

This means when you ask about Sarah's work, Engram knows to also surface relevant information about Acme Corp.

---

## What Makes It Special

| Feature | Why It Matters |
|---------|----------------|
| **Hybrid Search** | Finds memories by keywords AND meaning |
| **Knowledge Graph** | Understands relationships between people, places, things |
| **100% Local** | Your memories never leave your computer |
| **No API Keys** | Works offline, no subscriptions |
| **Fast** | ~50ms to recall, feels instant |

---

## The Nine Tools

Your AI gets these capabilities:

| Tool | What It Does |
|------|--------------|
| `remember` | Store something new |
| `recall` | Find relevant memories |
| `forget` | Remove a memory |
| `create_entity` | Add a person, place, or concept |
| `observe` | Note something about an entity |
| `relate` | Connect two entities |
| `query_entity` | Get everything about someone/something |
| `list_entities` | See all people, places, etc. |
| `stats` | Check memory statistics |

---

## Examples

### Personal Assistant

```
You: "Remember that my anniversary is March 15th and my partner loves Italian food"
AI: ✓ Stored. I've noted this as an important date with preferences.

You: "I need to plan something special next month"
AI: Your anniversary is coming up on March 15th! Given your partner's love for
    Italian food, perhaps a nice Italian restaurant reservation?
```

### Relationship Context

```
You: "My friend David lives in Austin and always recommends great coffee shops."
AI: ✓ Stored. Created entity: David (person), with observation about Austin and coffee expertise.

You: "I'm visiting Austin next week"
AI: David is in Austin—he'd probably have great coffee shop recommendations!
    Want me to remind you to ask him?
```

### Professional Memory

```
You: "John Chen is our VP of Engineering. He prefers async communication and hates meetings before 11am."
Claude: ✓ Stored. Created entity: John Chen (person, VP of Engineering).

You: "I need to schedule a sync with John"
Claude: Given John's preferences, I'd suggest a late morning slot, maybe 11:30am,
        or an async Loom video if it doesn't require real-time discussion.
```

---

## Privacy

**Your memories stay on your machine.**

- All data stored locally in `~/.engram/`
- No cloud services, no external APIs
- No telemetry, no tracking
- You own your data completely

---

## Technical Details

<details>
<summary>How It Works</summary>

Engram uses a three-layer retrieval system:

1. **BM25 (Keyword Search)**: SQLite FTS5 finds exact matches—names, dates, specific phrases
2. **ColBERT (Semantic Search)**: Neural embeddings find conceptually related memories
3. **Knowledge Graph**: Entity relationships expand context

These are fused using Reciprocal Rank Fusion (RRF) to get the best of all approaches.

```
Query: "What should I know about Sarah?"
  │
  ├── BM25 → finds "Sarah" in memories
  ├── ColBERT → finds semantically related content
  └── Graph → Sarah → works at → Acme Corp → Q1 launch
  │
  └── RRF Fusion → Best combined results
```

</details>

<details>
<summary>Architecture</summary>

```
engram/
├── src/
│   ├── index.ts           # MCP server
│   ├── storage/
│   │   └── database.ts    # SQLite + FTS5
│   ├── graph/
│   │   ├── extractor.ts   # Entity extraction
│   │   └── knowledge-graph.ts
│   └── retrieval/
│       ├── colbert.ts     # ColBERT wrapper
│       ├── colbert-bridge.py  # Python RAGatouille
│       └── hybrid.ts      # RRF fusion
```

</details>

<details>
<summary>Building from Source</summary>

```bash
git clone https://github.com/199-biotechnologies/engram.git
cd engram
npm install
npm run build

# Install globally from local build
npm install -g .
```

**Python Dependencies** (for ColBERT):
```bash
pip install ragatouille torch
```

If Python/ColBERT isn't available, Engram falls back to a simpler retriever automatically.

</details>

<details>
<summary>Configuration</summary>

Environment variables:
- `ENGRAM_DB_PATH`: Database location (default: `~/.engram/engram.db`)

Claude Desktop full config:
```json
{
  "mcpServers": {
    "engram": {
      "command": "engram",
      "env": {
        "ENGRAM_DB_PATH": "/custom/path/engram.db"
      }
    }
  }
}
```

</details>

<details>
<summary>Performance</summary>

On M1 MacBook Air:
- **remember**: ~100ms
- **recall**: ~50ms
- **graph queries**: ~5ms

Database size: ~1KB per memory (text + embeddings + graph data)

</details>

---

## Roadmap

- [x] Core MCP server
- [x] Hybrid search (BM25 + ColBERT)
- [x] Knowledge graph
- [x] Entity extraction
- [ ] Temporal memory decay
- [ ] Memory consolidation
- [ ] Export/import
- [ ] Web dashboard

---

## Author

**Boris Djordjevic**
Founder, [199 Biotechnologies](https://199bio.com)

## License

MIT — use it however you want.

---

<p align="center">
  <i>Built with care by <a href="https://github.com/199-biotechnologies">199 Biotechnologies</a></i>
</p>
