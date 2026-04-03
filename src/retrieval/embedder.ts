/**
 * Pure TypeScript embedder using Transformers.js
 * Uses MongoDB LEAF mdbr-leaf-ir (23M params, 384-dim, #1 BEIR for <100M models)
 * No Python dependency required.
 */

// NOTE: @huggingface/transformers uses dynamic imports internally
// The pipeline is lazy-loaded on first use

export interface Document {
  id: string;
  content: string;
}

export interface SearchResult {
  id: string;
  score: number;
}

// Database vector interface — implemented by EngramDatabase
export interface VectorStore {
  insertVector(memoryId: string, embedding: Float32Array): void;
  searchVectors(queryEmbedding: Float32Array, k: number): Array<{memoryId: string, distance: number}>;
  deleteVector(memoryId: string): void;
  findSimilar(embedding: Float32Array, threshold: number): Array<{memoryId: string, distance: number}>;
}

const MODEL_NAME = 'onnx-community/mdbr-leaf-ir-ONNX';
const EMBEDDING_DIM = 384;

export class TransformersEmbedder {
  private pipeline: any = null;
  private pipelinePromise: Promise<void> | null = null;
  private db: VectorStore;

  constructor(db: VectorStore) {
    this.db = db;
  }

  /**
   * Lazy-load the embedding pipeline on first use
   */
  private async ensurePipeline(): Promise<void> {
    if (this.pipeline) return;
    if (this.pipelinePromise) return this.pipelinePromise;

    this.pipelinePromise = (async () => {
      console.error('[Engram] Loading embedding model (first use)...');
      const { pipeline } = await import('@huggingface/transformers');
      this.pipeline = await pipeline('feature-extraction', MODEL_NAME, {
        dtype: 'q8' as any,
      });
      console.error('[Engram] Embedding model loaded');
    })();

    return this.pipelinePromise;
  }

  /**
   * Embed texts and return normalized Float32Arrays
   */
  async embed(texts: string[]): Promise<Float32Array[]> {
    await this.ensurePipeline();

    const results: Float32Array[] = [];
    for (const text of texts) {
      const output = await this.pipeline(text, { pooling: 'mean', normalize: true });
      // output.data is a Float32Array of the embedding
      const embedding = new Float32Array(EMBEDDING_DIM);
      for (let i = 0; i < EMBEDDING_DIM; i++) {
        embedding[i] = output.data[i];
      }
      results.push(embedding);
    }
    return results;
  }

  /**
   * Build a fresh index from documents
   */
  async index(documents: Document[]): Promise<{ success: boolean; count: number }> {
    if (!documents.length) return { success: true, count: 0 };

    const embeddings = await this.embed(documents.map(d => d.content));

    for (let i = 0; i < documents.length; i++) {
      this.db.insertVector(documents[i].id, embeddings[i]);
    }

    return { success: true, count: documents.length };
  }

  /**
   * Add documents to existing index
   */
  async add(documents: Document[]): Promise<{ success: boolean; count: number }> {
    return this.index(documents);
  }

  /**
   * Search for similar documents
   */
  async search(query: string, k: number = 10): Promise<SearchResult[]> {
    const [queryEmbedding] = await this.embed([query]);
    const results = this.db.searchVectors(queryEmbedding, k);

    return results.map(r => ({
      id: r.memoryId,
      score: 1 - r.distance, // Convert distance to similarity
    }));
  }

  /**
   * Delete documents from index
   */
  async delete(ids: string[]): Promise<{ success: boolean; count: number }> {
    for (const id of ids) {
      this.db.deleteVector(id);
    }
    return { success: true, count: ids.length };
  }
}

/**
 * Create the embedder (always available — no Python needed)
 */
export async function createEmbedder(db: VectorStore): Promise<TransformersEmbedder> {
  const embedder = new TransformersEmbedder(db);
  console.error('[Engram] Using Transformers.js embedder (mdbr-leaf-ir)');
  return embedder;
}
