/**
 * Memory Consolidator
 *
 * Uses Sonnet 4.6 for batch memory consolidation (cost-efficient summarization).
 * Inspired by how the brain consolidates short-term memories into long-term
 * storage during sleep.
 *
 * Sleep cycle phases:
 * 1. Memories → Digests (consolidate recent memories into session digests)
 * 2. Decay connections (reduce stale graph edges)
 * 3. Cleanup (purge old retrieval logs)
 */

import Anthropic from "@anthropic-ai/sdk";
import { EngramDatabase, Memory, Digest } from "../storage/database.js";
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

interface ConsolidationResult {
  digest: string;
  topic: string;
  contradictions: Array<{
    description: string;
    memory_ids: string[];
  }>;
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
   * Consolidate a batch of memories using Sonnet 4.6 (cost-efficient summarization)
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
        model: "claude-sonnet-4-6-20250514",
        max_tokens: 8000,
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
   * Get consolidation status
   */
  getStatus(): {
    configured: boolean;
    unconsolidatedMemories: number;
    totalDigests: number;
    unresolvedContradictions: number;
  } {
    const unconsolidatedMem = this.db.getUnconsolidatedMemories(undefined, 1000);
    const digests = this.db.getDigests(undefined, 1000);
    const contradictions = this.db.getContradictions(false, 1000);

    return {
      configured: this.isConfigured(),
      unconsolidatedMemories: unconsolidatedMem.length,
      totalDigests: digests.length,
      unresolvedContradictions: contradictions.length,
    };
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
   * 1. Assess backlog and check for incomplete runs
   * 2. Create checkpoint for tracking
   * 3. Process with rate limiting and validation
   * 4. Check rollback triggers after each batch
   * 5. Mark complete or fail with error
   */
  async runSleepCycle(options: {
    force?: boolean;      // Ignore budget limits
    maxBatches?: number;  // Override max batches
  } = {}): Promise<{
    digestsCreated: number;
    contradictionsFound: number;
    memoriesProcessed: number;
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
    console.error(`[Consolidator] Assessment: ${assessment.unconsolidatedMemories} memories`);

    if (assessment.isRecoveryMode) {
      console.error(`[Consolidator] RECOVERY MODE: Large backlog detected, processing conservatively`);
    }

    const maxBatches = options.maxBatches ?? assessment.recommendedBatches;
    let totalTokens = 0;
    let totalCost = 0;
    let aborted = false;
    let abortReason: string | undefined;

    // Create checkpoint
    const memoryPhase = assessment.phases.find(p => p.phase === "memories");
    const totalBatches = memoryPhase ? Math.min(memoryPhase.batchCount, maxBatches) : 0;

    if (!incomplete) {
      plan.createCheckpoint("memories", totalBatches);
    }

    console.error(`[Consolidator] Starting sleep cycle (max ${maxBatches} batches)...`);

    // ============ Phase 1: Memories → Digests ============
    let digestsCreated = incomplete?.digests_created || 0;
    let contradictionsFound = incomplete?.contradictions_found || 0;
    let memoriesProcessed = incomplete?.memories_processed || 0;

    if (assessment.unconsolidatedMemories >= 5 && !aborted) {
      plan.updateProgress({ phase: "memories" });
      console.error(`[Consolidator] Phase 1: Consolidating memories...`);

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
            memoriesProcessed += batch.length;

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

          // Estimate tokens (Sonnet without thinking)
          const batchTokens = 5000; // Conservative estimate
          totalTokens += batchTokens;
          totalCost += plan.calculateCost(3000, 2000);

          plan.updateProgress({
            batchesCompleted: (i / batchSize) + 1,
            memoriesProcessed,
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

      console.error(`[Consolidator] Memories: ${memoriesProcessed} → ${digestsCreated} digests`);
    }

    // ============ Phase 2: Decay connections ============
    let connectionsDecayed = 0;
    if (!aborted) {
      plan.updateProgress({ phase: "decay" });
      connectionsDecayed = this.db.decayConnections(30, 0.9);
      console.error(`[Consolidator] Connections decayed: ${connectionsDecayed}`);
    }

    // ============ Phase 3: Cleanup ============
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
      digestsCreated,
      contradictionsFound,
      memoriesProcessed,
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
