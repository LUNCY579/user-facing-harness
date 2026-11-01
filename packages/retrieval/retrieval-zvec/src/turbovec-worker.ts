/**
 * Trusted worker program using turbovec's documented Python IdMapIndex API. Requests carry only
 * numeric vectors and opaque ids; the worker has no document text, credentials, file paths, or socket.
 * Its compressed index is an ephemeral derivative and is rebuilt from the authoritative store.
 * @module @deepseek-ai/dsh-retrieval-zvec/turbovec-worker
 */

/** Python source passed as one literal argv element to an isolated interpreter. */
export const TURBOVEC_WORKER = String.raw`
import hashlib
import json
import math
import sys

import numpy as np
from turbovec import IdMapIndex

index = None
external = {}
reverse = {}
dimension = 0
bit_width = 4
limit = 0
max_bytes = int(sys.argv[1])

def key(value):
    if not isinstance(value, str) or not value or len(value) > 1024:
        raise ValueError("invalid record id")
    return int.from_bytes(hashlib.sha256(value.encode("utf-8")).digest()[:8], "big")

def vectors(values):
    result = np.asarray(values, dtype=np.float32) if values else np.empty((0, dimension), dtype=np.float32)
    if result.ndim != 2 or result.shape[1] != dimension or not np.isfinite(result).all():
        raise ValueError("invalid vector matrix")
    return np.ascontiguousarray(result)

def add(payload, clear=False):
    global index, external, reverse
    ids = payload["ids"]
    matrix = vectors(payload["vectors"])
    if len(ids) != len(matrix) or len(set(ids)) != len(ids):
        raise ValueError("ids and vectors must be unique and positional")
    keys = [key(value) for value in ids]
    if len(set(keys)) != len(keys):
        raise ValueError("record id collision")
    if (len(ids) if clear else len(set(external).union(ids))) > limit:
        raise ValueError("accelerator vector limit exceeded")
    for name, code in zip(ids, keys):
        if code in reverse and reverse[code] != name:
            raise ValueError("record id collision")
    if clear:
        index = IdMapIndex(dim=dimension, bit_width=bit_width)
        external = {}
        reverse = {}
    for name in ids:
        if name in external:
            index.remove(external[name])
    index.add_with_ids(matrix, np.asarray(keys, dtype=np.uint64))
    for name, code in zip(ids, keys):
        external[name] = code
        reverse[code] = name
    return {"count": len(ids), "vectors": len(index)}

def handle(payload):
    global index, dimension, bit_width, limit
    op = payload["op"]
    if op == "init":
        dimension = int(payload["dimension"])
        bit_width = int(payload["bitWidth"])
        limit = int(payload["maxVectors"])
        index = IdMapIndex(dim=dimension, bit_width=bit_width)
        return {"vectors": 0}
    if index is None:
        raise ValueError("worker is not initialized")
    if op == "add" or op == "rebuild":
        return add(payload, clear=op == "rebuild")
    if op == "remove":
        removed = 0
        for name in payload["ids"]:
            code = external.pop(name, None)
            if code is not None:
                removed += int(index.remove(code))
                reverse.pop(code, None)
        return {"count": removed, "vectors": len(index)}
    if op == "search":
        allowed = payload["allowlist"]
        if any(name not in external for name in allowed):
            raise ValueError("accelerator is missing authoritative candidates; rebuild required")
        if not allowed:
            return {"hits": []}
        query = vectors([payload["vector"]])
        scores, found = index.search(query, k=int(payload["topK"]), allowlist=np.asarray([external[name] for name in allowed], dtype=np.uint64))
        return {"hits": [{"id": reverse[int(code)], "score": 1.0 - float(score)} for score, code in zip(scores[0], found[0])]}
    if op == "sync":
        index.prepare()
        return {"vectors": len(index)}
    if op == "stats" or op == "ping":
        return {"vectors": len(index)}
    raise ValueError("unknown operation")

while True:
    raw = sys.stdin.buffer.readline(max_bytes + 1)
    if not raw:
        break
    if len(raw) > max_bytes or not raw.endswith(b"\n"):
        sys.exit(2)
    request_id = None
    try:
        payload = json.loads(raw)
        request_id = payload["requestId"]
        data = handle(payload)
        response = {"requestId": request_id, "ok": True, "data": data}
    except Exception as error:
        response = {"requestId": request_id, "ok": False, "error": str(error)[:1024]}
    encoded = json.dumps(response, allow_nan=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) + 1 > max_bytes:
        sys.exit(3)
    sys.stdout.write(encoded + "\n")
    sys.stdout.flush()
`
