"""봉인 지문 — worker/src/util.js 의 canonical·sealHash 와 같은 값(rules/seal-vector.json)."""
import hashlib
import json


def canonical(v):
    return json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def seal_hash(plain, nonce_hex):
    return hashlib.sha256((canonical(plain) + '\n' + nonce_hex).encode('utf-8')).hexdigest()
