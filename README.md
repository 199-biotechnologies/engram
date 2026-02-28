# Engram

<p align="center">
  <img src="logo.png" alt="Engram" width="480" />
</p>

**Give your AI a perfect memory.**

Every conversation you have with your AI disappears the moment it ends. Names you've mentioned, preferences you've shared, the context of your life — gone. You repeat yourself. You re-explain who people are. You remind it of things you've already said.

Engram fixes that.

It lets your AI remember. Not just store text — actually remember, the way you do. Important things stick. Trivial things fade. And everything connects.

> *An engram is a unit of cognitive information imprinted in a physical substance—the biological basis of memory.*

---

## How It Works

Tell your AI something once. Just once:

> "My colleague Sarah is allergic to shellfish and prefers window seats. She's leading the Q1 product launch."

Weeks later, ask:

> "I'm booking a team lunch and flights for the offsite—what should I know?"

Engram connects the dots. It remembers Sarah — the allergy, the seating preference, the workload. Your AI can now actually help. It'll suggest restaurants without shellfish and book her a window seat. It'll flag that she's probably swamped with the launch.

This isn't keyword matching. It's understanding.

---

## Memory That Feels Real

Engram models memory the way your brain does.

**Things fade.** A memory from six months ago that you've never revisited becomes harder to find. But something important — a name, a birthday, a preference — stays accessible even as time passes.

**Recall strengthens.** Every time a memory surfaces, it becomes more permanent. The things you think about often are the things you won't forget.

**Everything connects.** People link to places, places to events. Ask about Sarah, and her company, her projects, her preferences all surface together.

---

## Quick Start

Install globally:

```bash
npm install -g @199-bio/engram
```

Add to **MCP desktop client** (`~/Library/Application Support/AI/AI_desktop_config.json`):

```json
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": ["-y", "@199-bio/engram"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

Or with **AI coding assistant**:

```bash
AI mcp add engram -- npx -y @199-bio/engram
```

That's it. Your AI now remembers.

---

## What You Can Do

Just talk naturally. Your AI handles the rest.

**Store memories** by mentioning things:
- "Remember that my anniversary is March 15th"
- "Sarah prefers async communication"
- "I'm allergic to penicillin"

**Recall memories** by asking:
- "What do you know about Sarah?"
- "What are my allergies?"
- "When is my anniversary?"

**Build a knowledge graph** of your world:
- People, places, organizations — how they connect
- Observations about each entity
- Relationships that span your whole life

---

## Privacy

Your memories stay on your machine. Everything lives in `~/.engram/`. The only external call is optional — if you provide an API key, Engram can compress old memories into summaries. But core functionality works offline.

---

## The Details

<details>
<summary><strong>Available Tools</strong></summary>

Your AI gets these capabilities:

| Tool | Purpose |
|------|---------|
| `remember` | Store new information with importance and emotional weight |
| `recall` | Find relevant memories ranked by relevance and recency |
| `forget` | Remove a specific memory |
| `create_entity` | Add a person, place, or concept to the graph |
| `observe` | Record a fact about an entity |
| `relate` | Connect two entities (e.g., "works at", "married to") |
| `query_entity` | Get everything known about someone or something |
| `list_entities` | See all tracked people and places |
| `stats` | View memory statistics |
| `consolidate` | Compress old memories and detect contradictions |
| `engram_web` | Launch a visual memory browser |

</details>

<details>
<summary><strong>How Search Works</strong></summary>

Engram runs three search methods at once:

1. **Keywords** — SQLite FTS5 finds exact matches for names and phrases
2. **Meaning** — Jina v5 embeddings find conceptually related content
3. **Connections** — The knowledge graph expands to related entities

Results are merged, then ranked by recency and importance. Fresh memories surface first. Important memories resist fading.

</details>

<details>
<summary><strong>How Forgetting Works</strong></summary>

Memories follow an exponential decay curve:

```
Retention = e^(-time / stability)
```

- **Time** is days since the memory was last accessed
- **Stability** is memory strength, which grows each time you recall something

High-importance and emotionally weighted memories decay slower. Frequently accessed memories become permanent.

</details>

<details>
<summary><strong>How Consolidation Works</strong></summary>

With an API key, Engram compresses old memories — like sleep turning experiences into long-term storage.

1. Groups related low-importance memories
2. Creates AI-generated summaries (digests)
3. Flags contradictory information
4. Archives the originals

Storage stays lean, but nothing important gets lost.

</details>

<details>
<summary><strong>Architecture</strong></summary>

```
engram/
├── src/
│   ├── index.ts              # MCP server
│   ├── storage/database.ts   # SQLite with temporal fields
│   ├── graph/knowledge-graph.ts
│   ├── retrieval/
│   │   ├── jina.ts           # Jina v5 semantic search
│   │   └── hybrid.ts         # Fusion + decay + salience
│   ├── consolidation/consolidator.ts
│   └── web/server.ts         # Visual browser
```

</details>

<details>
<summary><strong>Configuration</strong></summary>

Environment variables:

| Variable | Purpose | Default |
|----------|---------|---------|
| `ENGRAM_DB_PATH` | Where to store data | `~/.engram/` |
| `ANTHROPIC_API_KEY` | Enable consolidation | None (optional) |

</details>

<details>
<summary><strong>Building from Source</strong></summary>

```bash
git clone https://github.com/199-biotechnologies/engram.git
cd engram
npm install
npm run build
npm install -g .
```

For semantic search, install the Jina embeddings package:

```bash
pip install jina-grep
```

This uses Jina v5 embeddings with MLX Metal acceleration (~9ms/query). If unavailable, Engram falls back to keyword-only search.

</details>

<details>
<summary><strong>Performance</strong></summary>

On M1 MacBook Air:

| Operation | Time |
|-----------|------|
| Remember | ~100ms |
| Recall | ~50ms |
| Graph queries | ~5ms |
| Consolidate | ~2-5s per batch |

Storage: ~1KB per memory.

</details>

---

## Roadmap

- [x] Hybrid search (keywords + semantics)
- [x] Knowledge graph with relationships
- [x] Memory decay and strengthening
- [x] Consolidation with contradiction detection
- [x] Web interface
- [ ] Export and import
- [ ] Scheduled consolidation

---

## Author

**Boris Djordjevic**
Founder, [199 Biotechnologies](https://199bio.com)

## License

MIT

---

<p align="center">
  <i>Built by <a href="https://github.com/199-biotechnologies">199 Biotechnologies</a></i>
</p>
