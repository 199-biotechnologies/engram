#!/usr/bin/env python3
"""
Jina v5 embedding bridge for Engram
Uses jina-embeddings-v5-small with MLX Metal acceleration (~9ms/query, 1.6GB RAM)

Drop-in replacement for colbert-bridge.py.
Run as subprocess from Node.js, communicates via JSON over stdin/stdout.

Vector store: numpy arrays in-memory, persisted to .npz + .json sidecar files.
Search: cosine similarity via normalized dot product (vectors normalized at embed time).
"""

import sys
import json
import os
from pathlib import Path

import numpy as np

EMBEDDING_DIM = 256  # Matryoshka truncation dimension
MODEL_NAME = "jina-embeddings-v5-small"


def lazy_load_embedder():
    """Lazy load jina_grep LocalEmbedder to speed up startup."""
    try:
        from jina_grep.embedder import LocalEmbedder
        return LocalEmbedder
    except ImportError:
        return None


class JinaBridge:
    def __init__(self, index_path: str):
        self.index_path = Path(index_path)
        self.index_path.mkdir(parents=True, exist_ok=True)

        self.vectors_file = self.index_path / "engram_vectors.npz"
        self.meta_file = self.index_path / "engram_meta.json"

        self.embedder = None
        self.vectors: np.ndarray | None = None  # shape (n, EMBEDDING_DIM), L2-normalized
        self.doc_ids: list[str] = []
        self.doc_contents: dict[str, str] = {}  # id -> content

        self._load_from_disk()

    # ------------------------------------------------------------------
    # Embedder lifecycle
    # ------------------------------------------------------------------

    def _ensure_embedder(self):
        """Load embedder model on first use."""
        if self.embedder is None:
            LocalEmbedder = lazy_load_embedder()
            if LocalEmbedder is None:
                raise RuntimeError(
                    "jina_grep not installed. Run: pip install jina-grep"
                )
            self.embedder = LocalEmbedder(MODEL_NAME)

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def _load_from_disk(self):
        """Load existing vectors and metadata from disk if present."""
        if self.vectors_file.exists() and self.meta_file.exists():
            try:
                data = np.load(self.vectors_file)
                self.vectors = data["vectors"]

                with open(self.meta_file, "r") as f:
                    meta = json.load(f)
                self.doc_ids = meta.get("doc_ids", [])
                self.doc_contents = meta.get("doc_contents", {})
            except Exception:
                # Corrupted files -- start fresh
                self.vectors = None
                self.doc_ids = []
                self.doc_contents = {}

    def _persist(self):
        """Write current vectors and metadata to disk."""
        if self.vectors is not None and len(self.doc_ids) > 0:
            np.savez(self.vectors_file, vectors=self.vectors)
            with open(self.meta_file, "w") as f:
                json.dump(
                    {"doc_ids": self.doc_ids, "doc_contents": self.doc_contents},
                    f,
                )
        else:
            # Empty index -- remove stale files
            if self.vectors_file.exists():
                self.vectors_file.unlink()
            if self.meta_file.exists():
                self.meta_file.unlink()

    # ------------------------------------------------------------------
    # Embedding helpers
    # ------------------------------------------------------------------

    def _embed(self, texts: list[str]) -> np.ndarray:
        """Embed a list of texts and return L2-normalized vectors (n, EMBEDDING_DIM)."""
        self._ensure_embedder()
        raw = self.embedder.embed(texts, task="retrieval")
        vecs = np.array(raw, dtype=np.float32)

        # Matryoshka truncation to target dimension
        if vecs.shape[1] > EMBEDDING_DIM:
            vecs = vecs[:, :EMBEDDING_DIM]

        # L2-normalize so dot product == cosine similarity
        norms = np.linalg.norm(vecs, axis=1, keepdims=True)
        norms = np.where(norms == 0, 1, norms)
        vecs = vecs / norms

        return vecs

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------

    def index_documents(self, documents: list[dict]) -> dict:
        """
        Build a fresh index from documents.
        documents: [{"id": "...", "content": "..."}]
        """
        if not documents:
            return {"success": True, "count": 0}

        ids = [d["id"] for d in documents]
        contents = [d["content"] for d in documents]

        vecs = self._embed(contents)

        self.vectors = vecs
        self.doc_ids = ids
        self.doc_contents = {d["id"]: d["content"] for d in documents}
        self._persist()

        return {"success": True, "count": len(documents)}

    def add_documents(self, documents: list[dict]) -> dict:
        """
        Append documents to the existing index.
        Falls back to full index if no index exists yet.
        """
        if not documents:
            return {"success": True, "count": 0}

        if self.vectors is None or len(self.doc_ids) == 0:
            return self.index_documents(documents)

        ids = [d["id"] for d in documents]
        contents = [d["content"] for d in documents]

        new_vecs = self._embed(contents)

        self.vectors = np.vstack([self.vectors, new_vecs])
        self.doc_ids.extend(ids)
        for d in documents:
            self.doc_contents[d["id"]] = d["content"]
        self._persist()

        return {"success": True, "count": len(documents)}

    def search(self, query: str, k: int = 10) -> dict:
        """
        Search for documents by cosine similarity.
        Returns: {"results": [{"id": "...", "score": 0.9, "content": "..."}]}
        """
        if self.vectors is None or len(self.doc_ids) == 0:
            return {"results": []}

        try:
            q_vec = self._embed([query])  # (1, EMBEDDING_DIM)
            scores = (self.vectors @ q_vec.T).squeeze()  # (n,)

            top_k = min(k, len(self.doc_ids))
            top_indices = np.argsort(scores)[::-1][:top_k]

            results = []
            for idx in top_indices:
                doc_id = self.doc_ids[idx]
                results.append({
                    "id": doc_id,
                    "score": float(scores[idx]),
                    "content": self.doc_contents.get(doc_id, ""),
                })

            return {"results": results}
        except Exception as e:
            return {"results": [], "error": str(e)}

    def rerank(self, query: str, documents: list[dict], k: int = 10) -> dict:
        """
        Rerank provided documents by embedding similarity (no persistent index used).
        documents: [{"id": "...", "content": "..."}]
        """
        if not documents:
            return {"results": []}

        try:
            contents = [d["content"] for d in documents]
            doc_vecs = self._embed(contents)
            q_vec = self._embed([query])

            scores = (doc_vecs @ q_vec.T).squeeze()
            if scores.ndim == 0:
                scores = scores.reshape(1)

            top_k = min(k, len(documents))
            top_indices = np.argsort(scores)[::-1][:top_k]

            results = []
            for idx in top_indices:
                results.append({
                    "id": documents[idx]["id"],
                    "score": float(scores[idx]),
                    "content": documents[idx]["content"],
                })

            return {"results": results}
        except Exception as e:
            return {"results": [], "error": str(e)}

    def delete_documents(self, doc_ids: list[str]) -> dict:
        """Remove documents by ID and persist."""
        if self.vectors is None or len(self.doc_ids) == 0:
            return {"success": True, "count": 0}

        ids_to_remove = set(doc_ids)
        keep_mask = [i for i, did in enumerate(self.doc_ids) if did not in ids_to_remove]

        if len(keep_mask) == 0:
            self.vectors = None
            self.doc_ids = []
            self.doc_contents = {}
        else:
            self.vectors = self.vectors[keep_mask]
            self.doc_ids = [self.doc_ids[i] for i in keep_mask]
            for did in doc_ids:
                self.doc_contents.pop(did, None)

        self._persist()
        return {"success": True, "count": len(doc_ids)}


def main():
    """Main loop -- read JSON commands from stdin, write responses to stdout."""
    index_path = os.environ.get("ENGRAM_INDEX_PATH", os.path.expanduser("~/.engram"))
    bridge = JinaBridge(index_path)

    # Signal ready
    print(json.dumps({"status": "ready"}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            cmd = json.loads(line)
            action = cmd.get("action")

            if action == "index":
                result = bridge.index_documents(cmd.get("documents", []))
            elif action == "add":
                result = bridge.add_documents(cmd.get("documents", []))
            elif action == "search":
                result = bridge.search(cmd.get("query", ""), cmd.get("k", 10))
            elif action == "rerank":
                result = bridge.rerank(
                    cmd.get("query", ""),
                    cmd.get("documents", []),
                    cmd.get("k", 10),
                )
            elif action == "delete":
                result = bridge.delete_documents(cmd.get("ids", []))
            elif action == "ping":
                result = {"status": "ok"}
            elif action == "quit":
                break
            else:
                result = {"error": f"Unknown action: {action}"}

            print(json.dumps(result), flush=True)

        except json.JSONDecodeError as e:
            print(json.dumps({"error": f"Invalid JSON: {e}"}), flush=True)
        except Exception as e:
            print(json.dumps({"error": str(e)}), flush=True)


if __name__ == "__main__":
    main()
