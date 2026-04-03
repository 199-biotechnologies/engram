/**
 * Consolidation Plan
 *
 * Safety guardrails for memory consolidation runs:
 * - Checkpointing for resume capability
 * - Rate limiting with delays between API calls
 * - Rollback triggers (error rate, empty digests)
 * - Cost tracking using Sonnet 4.6 pricing
 */

import { randomUUID } from "crypto";
import { EngramDatabase, Memory, ConsolidationCheckpoint } from "../storage/database.js";

// Sonnet 4.6 pricing (the only model used for consolidation)
const SONNET_PRICING = {
  input: 3.00 / 1_000_000,    // $3.00 per 1M input tokens
  output: 15.00 / 1_000_000,  // $15.00 per 1M output tokens
};

// Estimated tokens per memory batch (conservative)
const BATCH_TOKEN_ESTIMATE = {
  input: 3000,
  output: 2000,
};

export interface BacklogAssessment {
  unconsolidatedMemories: number;
  isRecoveryMode: boolean;
  estimatedBatches: number;
  estimatedCost: number;
  recommendedBatches: number;
  phases: PhasePlan[];
}

export interface PhasePlan {
  phase: "memories" | "decay" | "cleanup";
  itemCount: number;
  batchCount: number;
  estimatedCost: number;
  estimatedTimeMs: number;
}

export interface ConsolidationProgress {
  runId: string;
  phase: ConsolidationCheckpoint["phase"];
  batchesCompleted: number;
  batchesTotal: number;
  memoriesProcessed: number;
  digestsCreated: number;
  contradictionsFound: number;
  tokensUsed: number;
  estimatedCost: number;
  errors: string[];
  startedAt: Date;
  elapsedMs: number;
}

export interface RollbackTrigger {
  type: "error_rate" | "empty_digests" | "contradiction_rate";
  threshold: number;
  current: number;
  triggered: boolean;
  message: string;
}

export class ConsolidationPlan {
  private db: EngramDatabase;
  private runId: string;
  private errors: string[] = [];
  private emptyDigests: number = 0;
  private totalDigests: number = 0;
  private apiCalls: number = 0;
  private apiErrors: number = 0;

  constructor(db: EngramDatabase) {
    this.db = db;
    this.runId = randomUUID();
  }

  /**
   * Assess the current backlog and create a consolidation plan
   */
  assessBacklog(): BacklogAssessment {
    const unconsolidatedMem = this.db.getUnconsolidatedMemories(undefined, 10000);

    const recoveryThreshold = this.db.getConfigNumber("recovery_mode_threshold", 100);
    const isRecoveryMode = unconsolidatedMem.length > recoveryThreshold;

    const maxBatchesPerRun = this.db.getConfigNumber("max_batches_per_run", 5);
    const memoryBatches = Math.ceil(unconsolidatedMem.length / 15);

    const phases: PhasePlan[] = [];
    const delayMs = this.db.getConfigNumber("delay_between_calls_ms", 2000);

    // Memory consolidation phase (Sonnet 4.6)
    if (unconsolidatedMem.length >= 5) {
      const batchCount = Math.min(memoryBatches, maxBatchesPerRun);
      const cost = batchCount * this.estimateBatchCost();
      phases.push({
        phase: "memories",
        itemCount: Math.min(unconsolidatedMem.length, batchCount * 15),
        batchCount,
        estimatedCost: cost,
        estimatedTimeMs: batchCount * (2000 + delayMs),
      });
    }

    // Decay and cleanup phases (no API calls)
    phases.push({ phase: "decay", itemCount: 0, batchCount: 0, estimatedCost: 0, estimatedTimeMs: 100 });
    phases.push({ phase: "cleanup", itemCount: 0, batchCount: 0, estimatedCost: 0, estimatedTimeMs: 100 });

    const estimatedCost = phases.reduce((sum, p) => sum + p.estimatedCost, 0);

    // In recovery mode, be more conservative
    const recommendedBatches = isRecoveryMode
      ? Math.min(3, maxBatchesPerRun)
      : maxBatchesPerRun;

    return {
      unconsolidatedMemories: unconsolidatedMem.length,
      isRecoveryMode,
      estimatedBatches: memoryBatches,
      estimatedCost,
      recommendedBatches,
      phases,
    };
  }

  /**
   * Get prioritized memories for consolidation
   * Priority: recent + high importance first, then older chronologically
   */
  getPrioritizedMemories(limit: number): Memory[] {
    const allMemories = this.db.getUnconsolidatedMemories(undefined, 10000);

    // Score each memory
    const now = Date.now();

    const scored = allMemories.map(m => {
      const ageDays = (now - m.timestamp.getTime()) / (24 * 60 * 60 * 1000);

      // Recency score: 1.0 for today, decays over 7 days
      const recencyScore = Math.max(0, 1 - (ageDays / 7));

      // Importance score: 0-1
      const importanceScore = m.importance;

      // Emotional weight: 0-1
      const emotionalScore = m.emotional_weight;

      // Access frequency bonus
      const accessBonus = Math.min(0.2, m.access_count * 0.05);

      // Combined priority (weights: recency 40%, importance 30%, emotional 20%, access 10%)
      const priority = (recencyScore * 0.4) +
                      (importanceScore * 0.3) +
                      (emotionalScore * 0.2) +
                      (accessBonus * 0.1);

      return { memory: m, priority };
    });

    // Sort by priority (highest first)
    scored.sort((a, b) => b.priority - a.priority);

    return scored.slice(0, limit).map(s => s.memory);
  }

  /**
   * Create checkpoint for this run
   */
  createCheckpoint(phase: ConsolidationCheckpoint["phase"], batchesTotal: number): ConsolidationCheckpoint {
    return this.db.createCheckpoint(this.runId, phase, batchesTotal);
  }

  /**
   * Update checkpoint progress
   */
  updateProgress(updates: Partial<{
    phase: ConsolidationCheckpoint["phase"];
    batchesCompleted: number;
    batchesTotal: number;
    memoriesProcessed: number;
    digestsCreated: number;
    contradictionsFound: number;
    tokensUsed: number;
    estimatedCost: number;
  }>): void {
    this.db.updateCheckpoint(this.runId, {
      phase: updates.phase,
      batches_completed: updates.batchesCompleted,
      batches_total: updates.batchesTotal,
      memories_processed: updates.memoriesProcessed,
      digests_created: updates.digestsCreated,
      contradictions_found: updates.contradictionsFound,
      tokens_used: updates.tokensUsed,
      estimated_cost_usd: updates.estimatedCost,
    });
  }

  /**
   * Mark run as complete
   */
  complete(): void {
    this.db.completeCheckpoint(this.runId);
  }

  /**
   * Mark run as failed
   */
  fail(error: string): void {
    this.db.updateCheckpoint(this.runId, { error });
  }

  /**
   * Get current progress
   */
  getProgress(): ConsolidationProgress {
    const checkpoint = this.db.getCheckpoint(this.runId);

    return {
      runId: this.runId,
      phase: checkpoint?.phase || "memories",
      batchesCompleted: checkpoint?.batches_completed || 0,
      batchesTotal: checkpoint?.batches_total || 0,
      memoriesProcessed: checkpoint?.memories_processed || 0,
      digestsCreated: checkpoint?.digests_created || 0,
      contradictionsFound: checkpoint?.contradictions_found || 0,
      tokensUsed: checkpoint?.tokens_used || 0,
      estimatedCost: checkpoint?.estimated_cost_usd || 0,
      errors: this.errors,
      startedAt: checkpoint?.started_at || new Date(),
      elapsedMs: checkpoint ? Date.now() - checkpoint.started_at.getTime() : 0,
    };
  }

  /**
   * Check if we should resume a previous incomplete run
   */
  checkForResume(): ConsolidationCheckpoint | null {
    return this.db.getIncompleteCheckpoint();
  }

  /**
   * Resume from a previous checkpoint
   */
  resumeFrom(checkpoint: ConsolidationCheckpoint): void {
    this.runId = checkpoint.run_id;
  }

  /**
   * Record an API call result for tracking
   */
  recordApiCall(success: boolean): void {
    this.apiCalls++;
    if (!success) {
      this.apiErrors++;
    }
  }

  /**
   * Record a digest creation result
   */
  recordDigest(isEmpty: boolean): void {
    this.totalDigests++;
    if (isEmpty) {
      this.emptyDigests++;
    }
  }

  /**
   * Record an error
   */
  recordError(error: string): void {
    this.errors.push(error);
  }

  /**
   * Check rollback triggers and return any that fired
   */
  checkRollbackTriggers(): RollbackTrigger[] {
    const triggers: RollbackTrigger[] = [];

    // Error rate threshold
    const errorRateThreshold = this.db.getConfigNumber("error_rate_threshold", 0.3);
    if (this.apiCalls >= 3) {
      const errorRate = this.apiErrors / this.apiCalls;
      triggers.push({
        type: "error_rate",
        threshold: errorRateThreshold,
        current: errorRate,
        triggered: errorRate > errorRateThreshold,
        message: `API error rate ${(errorRate * 100).toFixed(1)}% exceeds ${(errorRateThreshold * 100).toFixed(0)}%`,
      });
    }

    // Empty digest threshold
    const emptyDigestThreshold = this.db.getConfigNumber("empty_digest_threshold", 0.2);
    if (this.totalDigests >= 3) {
      const emptyRate = this.emptyDigests / this.totalDigests;
      triggers.push({
        type: "empty_digests",
        threshold: emptyDigestThreshold,
        current: emptyRate,
        triggered: emptyRate > emptyDigestThreshold,
        message: `Empty digest rate ${(emptyRate * 100).toFixed(1)}% exceeds ${(emptyDigestThreshold * 100).toFixed(0)}%`,
      });
    }

    return triggers;
  }

  /**
   * Delay between API calls (rate limiting)
   */
  async delay(): Promise<void> {
    const delayMs = this.db.getConfigNumber("delay_between_calls_ms", 2000);
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  /**
   * Estimate cost for a single memory batch (Sonnet 4.6)
   */
  private estimateBatchCost(): number {
    const { input, output } = BATCH_TOKEN_ESTIMATE;
    return (input * SONNET_PRICING.input) + (output * SONNET_PRICING.output);
  }

  /**
   * Calculate actual cost from token usage (Sonnet 4.6)
   */
  calculateCost(inputTokens: number, outputTokens: number): number {
    return (inputTokens * SONNET_PRICING.input) + (outputTokens * SONNET_PRICING.output);
  }

  /**
   * Get the run ID
   */
  getRunId(): string {
    return this.runId;
  }
}
