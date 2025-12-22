#!/usr/bin/env python3
"""
ColBERT bridge for Engram
Uses RAGatouille for state-of-the-art retrieval

Run as subprocess from Node.js, communicates via JSON over stdin/stdout.
"""

import sys
import json
import os
from pathlib import Path

# Suppress warnings
os.environ["TOKENIZERS_PARALLELISM"] = "false"

def lazy_load_ragatouille():
    """Lazy load RAGatouille to speed up startup"""
    try:
        from ragatouille import RAGPretrainedModel
        return RAGPretrainedModel
    except ImportError:
        return None

class ColBERTBridge:
    def __init__(self, index_path: str):
        self.index_path = Path(index_path)
        self.index_path.mkdir(parents=True, exist_ok=True)
        self.model = None
        self.index = None
        self.index_name = "engram_index"

    def _ensure_model(self):
        """Load model if not already loaded"""
        if self.model is None:
            RAGPretrainedModel = lazy_load_ragatouille()
            if RAGPretrainedModel is None:
                raise RuntimeError("RAGatouille not installed. Run: pip install ragatouille")
            self.model = RAGPretrainedModel.from_pretrained("colbert-ir/colbertv2.0")

    def _ensure_index(self):
        """Load existing index if available"""
        if self.index is None:
            index_dir = self.index_path / ".ragatouille" / "colbert" / "indexes" / self.index_name
            if index_dir.exists():
                RAGPretrainedModel = lazy_load_ragatouille()
                if RAGPretrainedModel:
                    try:
                        self.index = RAGPretrainedModel.from_index(str(index_dir))
                    except Exception:
                        pass  # Will recreate index

    def index_documents(self, documents: list[dict]) -> dict:
        """
        Index documents for search
        documents: [{"id": "...", "content": "..."}]
        """
        self._ensure_model()

        if not documents:
            return {"success": True, "count": 0}

        doc_ids = [d["id"] for d in documents]
        doc_contents = [d["content"] for d in documents]

        # Index with RAGatouille
        self.index = self.model.index(
            collection=doc_contents,
            document_ids=doc_ids,
            index_name=self.index_name,
            max_document_length=512,
            split_documents=True,
        )

        return {"success": True, "count": len(documents)}

    def add_documents(self, documents: list[dict]) -> dict:
        """
        Add documents to existing index
        """
        self._ensure_index()

        if self.index is None:
            # No existing index, create new
            return self.index_documents(documents)

        doc_ids = [d["id"] for d in documents]
        doc_contents = [d["content"] for d in documents]

        try:
            self.index.add_to_index(
                new_collection=doc_contents,
                new_document_ids=doc_ids,
            )
            return {"success": True, "count": len(documents)}
        except Exception as e:
            # Fallback: reindex everything
            return {"success": False, "error": str(e)}

    def search(self, query: str, k: int = 10) -> dict:
        """
        Search for documents
        Returns: {"results": [{"id": "...", "score": 0.9, "content": "..."}]}
        """
        self._ensure_index()

        if self.index is None:
            return {"results": []}

        try:
            results = self.index.search(query=query, k=k)

            formatted = []
            for r in results:
                formatted.append({
                    "id": r.get("document_id", r.get("doc_id", "")),
                    "score": float(r.get("score", 0)),
                    "content": r.get("content", ""),
                })

            return {"results": formatted}
        except Exception as e:
            return {"results": [], "error": str(e)}

    def rerank(self, query: str, documents: list[dict], k: int = 10) -> dict:
        """
        Rerank documents using ColBERT
        documents: [{"id": "...", "content": "..."}]
        """
        self._ensure_model()

        if not documents:
            return {"results": []}

        doc_contents = [d["content"] for d in documents]

        try:
            # Use ColBERT as reranker
            results = self.model.rerank(
                query=query,
                documents=doc_contents,
                k=min(k, len(documents)),
            )

            formatted = []
            for r in results:
                idx = r.get("result_index", 0)
                if idx < len(documents):
                    formatted.append({
                        "id": documents[idx]["id"],
                        "score": float(r.get("score", 0)),
                        "content": documents[idx]["content"],
                    })

            return {"results": formatted}
        except Exception as e:
            return {"results": [], "error": str(e)}

    def delete_documents(self, doc_ids: list[str]) -> dict:
        """
        Delete documents from index
        """
        self._ensure_index()

        if self.index is None:
            return {"success": True, "count": 0}

        try:
            self.index.delete_from_index(document_ids=doc_ids)
            return {"success": True, "count": len(doc_ids)}
        except Exception as e:
            return {"success": False, "error": str(e)}


def main():
    """Main loop - read JSON commands from stdin, write responses to stdout"""
    index_path = os.environ.get("ENGRAM_INDEX_PATH", os.path.expanduser("~/.engram"))
    bridge = ColBERTBridge(index_path)

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
                    cmd.get("k", 10)
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
