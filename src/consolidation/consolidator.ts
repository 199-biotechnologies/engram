/**
 * Memory Consolidator
 *
 * Uses Opus 4.5 with extended thinking to consolidate memories into digests
 * and detect contradictions. Inspired by how the brain consolidates
 * short-term memories into long-term storage during sleep.
 *
 * Levels:
 * - L1: Session digests (consolidate recent memories)
 * - L2: Topic clusters (group related digests)
 * - L3: Entity profiles (comprehensive view of each entity)
 */

import Anthropic from "@anthropic-ai/sdk";
import { EngramDatabase, Memory, Digest, Episode } from "../storage/database.js";
import { getAnthropicApiKey } from "../settings.js";
import { KnowledgeGraph } from "../graph/knowledge-graph.js";
import { HybridSearch } from "../retrieval/hybrid.js";
import { ConsolidationPlan, BacklogAssessment, ConsolidationProgress } from "./plan.js";

const CONSOLIDATION_SYSTEM = `You are a high-quality memory consolidation system for a personal AI assistant. Your goal is to create comprehensive, nuanced digests that preserve the richness of human experience and relationships.

## Your Tasks

1. **CONSOLIDATE**: Synthesize memories into a detailed digest that:
   - Preserves ALL specific facts: names, dates, numbers, locations, preferences
   - Captures relationships, emotions, context, and nuance
   - Maintains chronological awareness (what happened when)
   - Notes patterns, recurring themes, and changes over time
   - Includes direct quotes when they reveal personality or important details

2. **DETECT CONTRADICTIONS**: Flag genuinely conflicting information:
   - Different dates/times for the same event
   - Conflicting facts about the same person/thing
   - Changed preferences or circumstances (note if this might be natural evolution vs. error)

## Output Format (JSON)
{
  "digest": "Comprehensive summary preserving all important details, context, and nuance. Multiple paragraphs are fine for complex topics.",
  "topic": "Short topic label (2-5 words)",
  "contradictions": [
    {
      "description": "Precise description of the conflict",
      "memory_ids": ["id1", "id2"]
    }
  ]
}

## Quality Standards
- NEVER sacrifice important details for brevity
- Include temporal context (when things happened/changed)
- Preserve personality, preferences, and relationship dynamics
- If memories span different time periods, note the evolution
- Only flag true contradictions, not incomplete information or natural life changes`;

const EPISODE_EXTRACTION_SYSTEM = `You are extracting structured memories from a conversation. Your goal is to identify facts, preferences, events, and relationships worth remembering.

## What to Extract
- Key facts about people, places, organizations
- User preferences and opinions
- Important events and their dates
- Relationships between entities
- Decisions made or plans discussed

## What to Skip
- Small talk and pleasantries
- Repetitive information
- Context that's only relevant to the immediate task
- Technical details that don't reveal user preferences

## Output Format (JSON)
{
  "memories": [
    {
      "content": "The actual memory to store (clear, standalone statement)",
      "importance": 0.5,
      "emotional_weight": 0.5,
      "event_time": "2024-12-01 or null if not mentioned",
      "entities": [{"name": "John", "type": "person"}],
      "relationships": [{"from": "John", "to": "Acme Corp", "type": "works_at"}]
    }
  ]
}

Extract 0-5 memories. Quality over quantity. If nothing worth remembering, return empty memories array.`;

interface ConsolidationResult {
  digest: string;
  topic: string;
  contradictions: Array<{
    description: string;
    memory_ids: string[];
  }>;
}

interface ExtractedMemory {
  content: string;
  importance: number;
  emotional_weight: number;
  event_time: string | null;
  entities: Array<{ name: string; type: string }>;
  relationships: Array<{ from: string; to: string; type: string }>;
}

interface EpisodeExtractionResult {
  memories: ExtractedMemory[];
}

interface ConsolidateOptions {
  batchSize?: number;
  minMemoriesForConsolidation?: number;
}

export class Consolidator {
  private client: Anthropic | null = null;
  private cachedApiKey: string | null = null;
  private db: EngramDatabase;
  private graph: KnowledgeGraph | null = null;
  private search: HybridSearch | null = null;

  constructor(
    db: EngramDatabase,
    graph?: KnowledgeGraph,
    search?: HybridSearch
  ) {
    this.db = db;
    this.graph = graph || null;
    this.search = search || null;

    // Initial check
    this.ensureClient();
  }

  /**
   * Ensure client is configured with latest API key
   * Lazy initialization: checks for new/updated API key each call
   */
  private ensureClient(): Anthropic | null {
    const apiKey = getAnthropicApiKey();

    if (!apiKey) {
      this.client = null;
      this.cachedApiKey = null;
      return null;
    }

    // Only recreate client if API key changed
    if (apiKey !== this.cachedApiKey) {
      console.error(`[Engram] Consolidator: API key ${this.cachedApiKey ? "updated" : "configured"}`);
      this.client = new Anthropic({ apiKey });
      this.cachedApiKey = apiKey;
    }

    return this.client;
  }

  isConfigured(): boolean {
    // Re-check in case API key was added after startup
    return this.ensureClient() !== null;
  }

  /**
   * Run consolidation on unconsolidated memories
   * Returns number of digests created and contradictions found
   */
  async consolidate(options: ConsolidateOptions = {}): Promise<{
    digestsCreated: number;
    contradictionsFound: number;
    memoriesProcessed: number;
  }> {
    const client = this.ensureClient();
    if (!client) {
      throw new Error("Consolidator not configured - set ANTHROPIC_API_KEY");
    }

    const { batchSize = 15, minMemoriesForConsolidation = 5 } = options;

    // Get unconsolidated memories
    const memories = this.db.getUnconsolidatedMemories(undefined, 100);

    if (memories.length < minMemoriesForConsolidation) {
      return {
        digestsCreated: 0,
        contradictionsFound: 0,
        memoriesProcessed: 0,
      };
    }

    let digestsCreated = 0;
    let contradictionsFound = 0;
    let memoriesProcessed = 0;

    // Process in batches
    for (let i = 0; i < memories.length; i += batchSize) {
      const batch = memories.slice(i, i + batchSize);
      if (batch.length < 3) break; // Skip tiny batches

      try {
        const result = await this.consolidateBatch(batch);

        if (result) {
          // Create digest
          const memoryIds = batch.map((m) => m.id);
          const periodStart = new Date(
            Math.min(...batch.map((m) => m.timestamp.getTime()))
          );
          const periodEnd = new Date(
            Math.max(...batch.map((m) => m.timestamp.getTime()))
          );

          this.db.createDigest(result.digest, 1, memoryIds, {
            topic: result.topic,
            periodStart,
            periodEnd,
          });
          digestsCreated++;
          memoriesProcessed += batch.length;

          // Create contradictions
          for (const c of result.contradictions) {
            if (c.memory_ids.length >= 2) {
              // Find the actual memory IDs from our batch
              const [idA, idB] = c.memory_ids.slice(0, 2);
              const memA = batch.find((m) => m.id === idA);
              const memB = batch.find((m) => m.id === idB);

              if (memA && memB) {
                this.db.createContradiction(memA.id, memB.id, c.description);
                contradictionsFound++;
              }
            }
          }
        }
      } catch (error) {
        console.error("[Consolidator] Batch consolidation failed:", error);
        // Continue with next batch
      }
    }

    return { digestsCreated, contradictionsFound, memoriesProcessed };
  }

  /**
   * Consolidate a batch of memories using Opus 4.5 with extended thinking
   */
  private async consolidateBatch(
    memories: Memory[]
  ): Promise<ConsolidationResult | null> {
    const client = this.ensureClient();
    if (!client) return null;

    // Format memories for the prompt
    const memoriesText = memories
      .map(
        (m) =>
          `[${m.id}] (${m.timestamp.toISOString().split("T")[0]}) ${m.content}`
      )
      .join("\n\n");

    const userPrompt = `Synthesize these ${memories.length} memories into a comprehensive digest.

Think deeply about:
- What are the key facts, events, and details?
- Who are the people involved and how do they relate?
- What preferences, opinions, or patterns emerge?
- Is there a chronological narrative or timeline?
- Are there any contradictions between memories?

MEMORIES:
${memoriesText}

Create a detailed digest that preserves all important information. Respond with JSON only.`;

    try {
      const response = await client.messages.create({
        model: "claude-opus-4-5-20251101",
        max_tokens: 16000,
        temperature: 1, // Required for extended thinking
        thinking: {
          type: "enabled",
          budget_tokens: 10000, // High budget for thorough analysis
        },
        messages: [
          {
            role: "user",
            content: userPrompt,
          },
        ],
        system: CONSOLIDATION_SYSTEM,
      });

      // Extract text response (skip thinking blocks)
      let text = "";
      for (const block of response.content) {
        if (block.type === "text") {
          text = block.text;
          break;
        }
      }

      if (!text) return null;

      // Parse JSON response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const result = JSON.parse(jsonMatch[0]) as ConsolidationResult;
      return result;
    } catch (error) {
      console.error("[Consolidator] API call failed:", error);
      return null;
    }
  }

  /**
   * Create an entity profile by consolidating all observations about an entity
   */
  async consolidateEntity(entityId: string): Promise<Digest | null> {
    const client = this.ensureClient();
    if (!client) {
      throw new Error("Consolidator not configured - set ANTHROPIC_API_KEY");
    }

    const entity = this.db.getEntity(entityId);
    if (!entity) return null;

    const observations = this.db.getEntityObservations(entityId);
    if (observations.length < 2) return null;

    // Get source memories for each observation
    const memories: Memory[] = [];
    for (const obs of observations) {
      if (obs.source_memory_id) {
        const mem = this.db.getMemory(obs.source_memory_id);
        if (mem) memories.push(mem);
      }
    }

    if (memories.length < 2) return null;

    // Consolidate with entity context
    const memoriesText = memories
      .map(
        (m) =>
          `[${m.id}] (${m.timestamp.toISOString().split("T")[0]}) ${m.content}`
      )
      .join("\n\n");

    const userPrompt = `Create a comprehensive, detailed profile for "${entity.name}" (${entity.type}).

This profile will serve as the authoritative reference for everything known about this ${entity.type}. Include:
- All biographical/descriptive facts
- Relationships with other people/entities
- Preferences, opinions, personality traits
- Timeline of events and changes over time
- Notable quotes or characteristic expressions
- Any context that helps understand this ${entity.type}

MEMORIES ABOUT ${entity.name}:
${memoriesText}

Create a rich, detailed profile. Do not summarize away important nuances. Respond with JSON only.`;

    try {
      const response = await client.messages.create({
        model: "claude-opus-4-5-20251101",
        max_tokens: 16000,
        temperature: 1, // Required for extended thinking
        thinking: {
          type: "enabled",
          budget_tokens: 16000, // Maximum thinking for entity profiles
        },
        messages: [
          {
            role: "user",
            content: userPrompt,
          },
        ],
        system: CONSOLIDATION_SYSTEM,
      });

      let text = "";
      for (const block of response.content) {
        if (block.type === "text") {
          text = block.text;
          break;
        }
      }

      if (!text) return null;

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const result = JSON.parse(jsonMatch[0]) as ConsolidationResult;

      // Create level 3 entity profile digest
      const memoryIds = memories.map((m) => m.id);
      const periodStart = new Date(
        Math.min(...memories.map((m) => m.timestamp.getTime()))
      );
      const periodEnd = new Date(
        Math.max(...memories.map((m) => m.timestamp.getTime()))
      );

      const digest = this.db.createDigest(result.digest, 3, memoryIds, {
        topic: `Profile: ${entity.name}`,
        entityId: entity.id,
        periodStart,
        periodEnd,
      });

      // Record any contradictions
      for (const c of result.contradictions) {
        if (c.memory_ids.length >= 2) {
          const [idA, idB] = c.memory_ids.slice(0, 2);
          const memA = memories.find((m) => m.id === idA);
          const memB = memories.find((m) => m.id === idB);

          if (memA && memB) {
            this.db.createContradiction(
              memA.id,
              memB.id,
              c.description,
              entity.id
            );
          }
        }
      }

      return digest;
    } catch (error) {
      console.error("[Consolidator] Entity profile failed:", error);
      return null;
    }
  }

  /**
   * Get consolidation status
   */
  getStatus(): {
    configured: boolean;
    unconsolidatedMemories: number;
    unconsolidatedEpisodes: number;
    totalDigests: number;
    unresolvedContradictions: number;
  } {
    const unconsolidatedMem = this.db.getUnconsolidatedMemories(undefined, 1000);
    const unconsolidatedEp = this.db.getUnconsolidatedEpisodes(1000);
    const digests = this.db.getDigests(undefined, 1000);
    const contradictions = this.db.getContradictions(false, 1000);

    return {
      configured: this.isConfigured(),
      unconsolidatedMemories: unconsolidatedMem.length,
      unconsolidatedEpisodes: unconsolidatedEp.length,
      totalDigests: digests.length,
      unresolvedContradictions: contradictions.length,
    };
  }

  /**
   * Process unconsolidated episodes into memories
   * This is the "working memory → long-term memory" transfer
   */
  async consolidateEpisodes(options: {
    minEpisodes?: number;
    batchSize?: number;
  } = {}): Promise<{
    episodesProcessed: number;
    memoriesCreated: number;
    entitiesCreated: number;
  }> {
    const client = this.ensureClient();
    if (!client) {
      throw new Error("Consolidator not configured - set ANTHROPIC_API_KEY");
    }

    const { minEpisodes = 4, batchSize = 20 } = options;

    // Get unconsolidated episodes
    const episodes = this.db.getUnconsolidatedEpisodes(batchSize);

    if (episodes.length < minEpisodes) {
      return { episodesProcessed: 0, memoriesCreated: 0, entitiesCreated: 0 };
    }

    // Group by session for context
    const sessionGroups = new Map<string, Episode[]>();
    for (const ep of episodes) {
      const existing = sessionGroups.get(ep.session_id) || [];
      existing.push(ep);
      sessionGroups.set(ep.session_id, existing);
    }

    let episodesProcessed = 0;
    let memoriesCreated = 0;
    let entitiesCreated = 0;

    // Process each session
    for (const [sessionId, sessionEpisodes] of sessionGroups) {
      if (sessionEpisodes.length < 2) continue;

      try {
        const result = await this.extractMemoriesFromEpisodes(sessionEpisodes);

        if (result && result.memories.length > 0) {
          for (const mem of result.memories) {
            // Create the memory
            const memory = this.db.createMemory(
              mem.content,
              "episode_consolidation",
              mem.importance,
              {
                eventTime: mem.event_time ? new Date(mem.event_time) : undefined,
                emotionalWeight: mem.emotional_weight,
              }
            );
            memoriesCreated++;

            // Index for search
            if (this.search) {
              await this.search.indexMemory(memory);
            }

            // Create entities and relationships
            if (this.graph) {
              for (const ent of mem.entities || []) {
                const entity = this.graph.getOrCreateEntity(
                  ent.name,
                  ent.type as "person" | "place" | "concept" | "event" | "organization"
                );
                this.db.addObservation(entity.id, mem.content, memory.id, 1.0);
                entitiesCreated++;
              }

              for (const rel of mem.relationships || []) {
                try {
                  const fromEntity = this.graph.getOrCreateEntity(rel.from, "person");
                  const toEntity = this.graph.getOrCreateEntity(rel.to, "person");
                  this.graph.relate(fromEntity.name, toEntity.name, rel.type);
                } catch {
                  // Skip invalid relationships
                }
              }
            }
          }
        }

        // Mark episodes as consolidated
        this.db.markEpisodesConsolidated(sessionEpisodes.map(e => e.id));
        episodesProcessed += sessionEpisodes.length;

      } catch (error) {
        console.error("[Consolidator] Episode consolidation failed:", error);
      }
    }

    return { episodesProcessed, memoriesCreated, entitiesCreated };
  }

  /**
   * Extract memories from conversation episodes using Haiku (fast, cheap)
   */
  private async extractMemoriesFromEpisodes(
    episodes: Episode[]
  ): Promise<EpisodeExtractionResult | null> {
    const client = this.ensureClient();
    if (!client) return null;

    // Format conversation
    const conversationText = episodes
      .sort((a, b) => a.turn_index - b.turn_index)
      .map(ep => `${ep.role.toUpperCase()}: ${ep.content}`)
      .join("\n\n");

    const userPrompt = `Extract memorable facts from this conversation.

CONVERSATION:
${conversationText}

Remember: Only extract information worth remembering long-term. Skip transient task details.
Respond with JSON only.`;

    try {
      // Use Haiku for speed/cost (no extended thinking needed)
      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251201",
        max_tokens: 4000,
        messages: [
          {
            role: "user",
            content: userPrompt,
          },
        ],
        system: EPISODE_EXTRACTION_SYSTEM,
      });

      let text = "";
      for (const block of response.content) {
        if (block.type === "text") {
          text = block.text;
          break;
        }
      }

      if (!text) return null;

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      return JSON.parse(jsonMatch[0]) as EpisodeExtractionResult;
    } catch (error) {
      console.error("[Consolidator] Episode extraction failed:", error);
      return null;
    }
  }

  /**
   * Assess current backlog and return a plan
   */
  assessBacklog(): BacklogAssessment {
    const plan = new ConsolidationPlan(this.db);
    return plan.assessBacklog();
  }

  /**
   * Run full consolidation cycle with safety SOP
   * This is the "sleep cycle" that should run periodically
   *
   * SOP (Standard Operating Procedure):
   * 1. Assess backlog and check budget
   * 2. Check for incomplete runs to resume
   * 3. Create checkpoint for tracking
   * 4. Process with rate limiting and validation
   * 5. Check rollback triggers after each batch
   * 6. Mark complete or fail with error
   */
  async runSleepCycle(options: {
    force?: boolean;      // Ignore budget limits
    maxBatches?: number;  // Override max batches
  } = {}): Promise<{
    episodesProcessed: number;
    memoriesCreated: number;
    digestsCreated: number;
    contradictionsFound: number;
    connectionsDecayed: number;
    logsCleanedUp: number;
    tokensUsed: number;
    estimatedCost: number;
    aborted: boolean;
    abortReason?: string;
  }> {
    const plan = new ConsolidationPlan(this.db);

    // Check for incomplete run to resume
    const incomplete = plan.checkForResume();
    if (incomplete) {
      console.error(`[Consolidator] Resuming incomplete run ${incomplete.run_id} from phase ${incomplete.phase}`);
      plan.resumeFrom(incomplete);
    }

    // Assess backlog
    const assessment = plan.assessBacklog();
    console.error(`[Consolidator] Assessment: ${assessment.unconsolidatedEpisodes} episodes, ${assessment.unconsolidatedMemories} memories`);
    console.error(`[Consolidator] Budget: $${assessment.dailySpent.toFixed(2)} / $${assessment.dailyBudget.toFixed(2)} (remaining: $${assessment.budgetRemaining.toFixed(2)})`);

    if (assessment.isRecoveryMode) {
      console.error(`[Consolidator] RECOVERY MODE: Large backlog detected, processing conservatively`);
    }

    // Check if we can proceed
    if (!options.force && !assessment.canProceed) {
      console.error(`[Consolidator] Budget exceeded, skipping consolidation`);
      return {
        episodesProcessed: 0,
        memoriesCreated: 0,
        digestsCreated: 0,
        contradictionsFound: 0,
        connectionsDecayed: 0,
        logsCleanedUp: 0,
        tokensUsed: 0,
        estimatedCost: 0,
        aborted: true,
        abortReason: "Daily budget exceeded",
      };
    }

    const maxBatches = options.maxBatches ?? assessment.recommendedBatches;
    let totalTokens = 0;
    let totalCost = 0;
    let aborted = false;
    let abortReason: string | undefined;

    // Create checkpoint
    const totalBatches = assessment.phases
      .filter(p => p.phase === "episodes" || p.phase === "memories")
      .reduce((sum, p) => sum + Math.min(p.batchCount, maxBatches), 0);

    if (!incomplete) {
      plan.createCheckpoint("episodes", totalBatches);
    }

    console.error(`[Consolidator] Starting sleep cycle (max ${maxBatches} batches per phase)...`);

    // ============ Phase 1: Episodes → Memories ============
    let episodesProcessed = incomplete?.episodes_processed || 0;
    let memoriesCreated = 0;
    let entitiesCreated = 0;

    if (assessment.unconsolidatedEpisodes >= 4 && !aborted) {
      plan.updateProgress({ phase: "episodes" });
      console.error(`[Consolidator] Phase 1: Processing episodes...`);

      const episodeBatchSize = 20;
      const episodes = plan.getPrioritizedEpisodes(maxBatches * episodeBatchSize);

      // Group by session
      const sessionGroups = new Map<string, Episode[]>();
      for (const ep of episodes) {
        const existing = sessionGroups.get(ep.session_id) || [];
        existing.push(ep);
        sessionGroups.set(ep.session_id, existing);
      }

      let batchIndex = 0;
      for (const [sessionId, sessionEpisodes] of sessionGroups) {
        if (batchIndex >= maxBatches) break;
        if (sessionEpisodes.length < 2) continue;

        try {
          // Rate limiting delay
          if (batchIndex > 0) {
            await plan.delay();
          }

          const result = await this.extractMemoriesFromEpisodes(sessionEpisodes);
          plan.recordApiCall(result !== null);

          if (result && result.memories.length > 0) {
            for (const mem of result.memories) {
              const memory = this.db.createMemory(
                mem.content,
                "episode_consolidation",
                mem.importance,
                {
                  eventTime: mem.event_time ? new Date(mem.event_time) : undefined,
                  emotionalWeight: mem.emotional_weight,
                }
              );
              memoriesCreated++;

              if (this.search) {
                await this.search.indexMemory(memory);
              }

              if (this.graph) {
                for (const ent of mem.entities || []) {
                  const entity = this.graph.getOrCreateEntity(
                    ent.name,
                    ent.type as "person" | "place" | "concept" | "event" | "organization"
                  );
                  this.db.addObservation(entity.id, mem.content, memory.id, 1.0);
                  entitiesCreated++;
                }

                for (const rel of mem.relationships || []) {
                  try {
                    const fromEntity = this.graph.getOrCreateEntity(rel.from, "person");
                    const toEntity = this.graph.getOrCreateEntity(rel.to, "person");
                    this.graph.relate(fromEntity.name, toEntity.name, rel.type);
                  } catch {
                    // Skip invalid relationships
                  }
                }
              }
            }
          }

          this.db.markEpisodesConsolidated(sessionEpisodes.map(e => e.id));
          episodesProcessed += sessionEpisodes.length;
          batchIndex++;

          // Estimate tokens (Haiku)
          const batchTokens = 3000; // Conservative estimate
          totalTokens += batchTokens;
          totalCost += plan.calculateCost("haiku", 2000, 1000);

          plan.updateProgress({
            batchesCompleted: batchIndex,
            episodesProcessed,
            tokensUsed: totalTokens,
            estimatedCost: totalCost,
          });

          // Check rollback triggers
          const triggers = plan.checkRollbackTriggers();
          const fired = triggers.filter(t => t.triggered);
          if (fired.length > 0) {
            aborted = true;
            abortReason = fired.map(t => t.message).join("; ");
            console.error(`[Consolidator] ROLLBACK TRIGGERED: ${abortReason}`);
            break;
          }

        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          plan.recordError(errMsg);
          plan.recordApiCall(false);
          console.error(`[Consolidator] Episode batch failed: ${errMsg}`);
        }
      }

      console.error(`[Consolidator] Episodes: ${episodesProcessed} → ${memoriesCreated} memories`);
    }

    // ============ Phase 2: Memories → Digests ============
    let digestsCreated = incomplete?.digests_created || 0;
    let contradictionsFound = incomplete?.contradictions_found || 0;
    let memoriesConsolidated = incomplete?.memories_processed || 0;

    if (assessment.unconsolidatedMemories >= 5 && !aborted) {
      plan.updateProgress({ phase: "memories" });
      console.error(`[Consolidator] Phase 2: Consolidating memories...`);

      const batchSize = 15;
      const memories = plan.getPrioritizedMemories(maxBatches * batchSize);

      for (let i = 0; i < memories.length && !aborted; i += batchSize) {
        if (i / batchSize >= maxBatches) break;

        const batch = memories.slice(i, i + batchSize);
        if (batch.length < 3) break;

        try {
          // Rate limiting delay
          if (i > 0) {
            await plan.delay();
          }

          const result = await this.consolidateBatch(batch);
          plan.recordApiCall(result !== null);
          plan.recordDigest(result === null || !result.digest);

          if (result) {
            const memoryIds = batch.map(m => m.id);
            const periodStart = new Date(Math.min(...batch.map(m => m.timestamp.getTime())));
            const periodEnd = new Date(Math.max(...batch.map(m => m.timestamp.getTime())));

            this.db.createDigest(result.digest, 1, memoryIds, {
              topic: result.topic,
              periodStart,
              periodEnd,
            });
            digestsCreated++;
            memoriesConsolidated += batch.length;

            for (const c of result.contradictions) {
              if (c.memory_ids.length >= 2) {
                const [idA, idB] = c.memory_ids.slice(0, 2);
                const memA = batch.find(m => m.id === idA);
                const memB = batch.find(m => m.id === idB);

                if (memA && memB) {
                  this.db.createContradiction(memA.id, memB.id, c.description);
                  contradictionsFound++;
                }
              }
            }
          }

          // Estimate tokens (Opus with thinking)
          const batchTokens = 15000; // Conservative estimate
          totalTokens += batchTokens;
          totalCost += plan.calculateCost("opus", 3000, 2000, 10000);

          plan.updateProgress({
            batchesCompleted: (i / batchSize) + 1,
            memoriesProcessed: memoriesConsolidated,
            digestsCreated,
            contradictionsFound,
            tokensUsed: totalTokens,
            estimatedCost: totalCost,
          });

          // Check rollback triggers
          const triggers = plan.checkRollbackTriggers();
          const fired = triggers.filter(t => t.triggered);
          if (fired.length > 0) {
            aborted = true;
            abortReason = fired.map(t => t.message).join("; ");
            console.error(`[Consolidator] ROLLBACK TRIGGERED: ${abortReason}`);
            break;
          }

        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          plan.recordError(errMsg);
          plan.recordApiCall(false);
          console.error(`[Consolidator] Memory batch failed: ${errMsg}`);
        }
      }

      console.error(`[Consolidator] Memories: ${memoriesConsolidated} → ${digestsCreated} digests`);
    }

    // ============ Phase 3: Decay connections ============
    let connectionsDecayed = 0;
    if (!aborted) {
      plan.updateProgress({ phase: "decay" });
      connectionsDecayed = this.db.decayConnections(30, 0.9);
      console.error(`[Consolidator] Connections decayed: ${connectionsDecayed}`);
    }

    // ============ Phase 4: Cleanup ============
    let logsCleanedUp = 0;
    if (!aborted) {
      plan.updateProgress({ phase: "cleanup" });
      logsCleanedUp = this.db.cleanupRetrievalLogs(7);
      console.error(`[Consolidator] Retrieval logs cleaned: ${logsCleanedUp}`);
    }

    // Mark complete or failed
    if (aborted) {
      plan.fail(abortReason || "Unknown error");
    } else {
      plan.complete();
    }

    console.error(`[Consolidator] Sleep cycle complete. Tokens: ${totalTokens}, Cost: $${totalCost.toFixed(4)}`);

    return {
      episodesProcessed,
      memoriesCreated,
      digestsCreated,
      contradictionsFound,
      connectionsDecayed,
      logsCleanedUp,
      tokensUsed: totalTokens,
      estimatedCost: totalCost,
      aborted,
      abortReason,
    };
  }

  /**
   * Get consolidation progress for the current/latest run
   */
  getConsolidationProgress(): ConsolidationProgress | null {
    const plan = new ConsolidationPlan(this.db);
    const checkpoint = plan.checkForResume();
    if (checkpoint) {
      plan.resumeFrom(checkpoint);
      return plan.getProgress();
    }

    // Get most recent completed run
    const recent = this.db.getRecentCheckpoints(1);
    if (recent.length > 0) {
      return {
        runId: recent[0].run_id,
        phase: recent[0].phase,
        batchesCompleted: recent[0].batches_completed,
        batchesTotal: recent[0].batches_total,
        memoriesProcessed: recent[0].memories_processed,
        episodesProcessed: recent[0].episodes_processed,
        digestsCreated: recent[0].digests_created,
        contradictionsFound: recent[0].contradictions_found,
        tokensUsed: recent[0].tokens_used,
        estimatedCost: recent[0].estimated_cost_usd,
        errors: recent[0].error ? [recent[0].error] : [],
        startedAt: recent[0].started_at,
        elapsedMs: recent[0].completed_at
          ? recent[0].completed_at.getTime() - recent[0].started_at.getTime()
          : Date.now() - recent[0].started_at.getTime(),
      };
    }

    return null;
  }
}
