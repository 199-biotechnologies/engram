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
import { EngramDatabase, Memory, Digest } from "../storage/database.js";

const CONSOLIDATION_SYSTEM = `You are a memory consolidation system. Your job is to:

1. CONSOLIDATE: Take a batch of related memories and produce a concise summary that preserves all important facts, dates, names, and relationships. Be factual and precise.

2. DETECT CONTRADICTIONS: If any memories contain conflicting information (e.g., different ages, dates, locations, or facts about the same topic), identify them clearly.

Output JSON with this structure:
{
  "digest": "Your consolidated summary here. Include all key facts, dates, names. Be concise but complete.",
  "topic": "A short topic label (2-5 words)",
  "contradictions": [
    {
      "description": "Clear description of the contradiction",
      "memory_ids": ["id1", "id2"]
    }
  ]
}

Rules:
- Preserve specific details: names, numbers, dates, locations
- Use present tense for current facts, past tense for past events
- If memories are about a person, structure the digest around that person
- Only flag true contradictions (not just incomplete information)
- Be concise - consolidate 10 memories into 2-3 sentences typically`;

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
  private db: EngramDatabase;

  constructor(db: EngramDatabase) {
    this.db = db;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
    }
  }

  isConfigured(): boolean {
    return this.client !== null;
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
    if (!this.client) {
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
    if (!this.client) return null;

    // Format memories for the prompt
    const memoriesText = memories
      .map(
        (m) =>
          `[${m.id}] (${m.timestamp.toISOString().split("T")[0]}) ${m.content}`
      )
      .join("\n\n");

    const userPrompt = `Consolidate these ${memories.length} memories into a single digest. Identify any contradictions.

MEMORIES:
${memoriesText}

Respond with JSON only.`;

    try {
      const response = await this.client.messages.create({
        model: "claude-opus-4-5-20251101",
        max_tokens: 16000,
        thinking: {
          type: "enabled",
          budget_tokens: 4000,
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
    if (!this.client) {
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

    const userPrompt = `Create a comprehensive profile for the entity "${entity.name}" (${entity.type}) based on these memories. Include all known facts, relationships, preferences, and history.

MEMORIES ABOUT ${entity.name}:
${memoriesText}

Respond with JSON only.`;

    try {
      const response = await this.client.messages.create({
        model: "claude-opus-4-5-20251101",
        max_tokens: 16000,
        thinking: {
          type: "enabled",
          budget_tokens: 6000,
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
    totalDigests: number;
    unresolvedContradictions: number;
  } {
    const unconsolidated = this.db.getUnconsolidatedMemories(undefined, 1000);
    const digests = this.db.getDigests(undefined, 1000);
    const contradictions = this.db.getContradictions(false, 1000);

    return {
      configured: this.isConfigured(),
      unconsolidatedMemories: unconsolidated.length,
      totalDigests: digests.length,
      unresolvedContradictions: contradictions.length,
    };
  }
}
