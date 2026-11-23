import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
from seal import canonical, seal_hash  # noqa: E402


def test_seal_vector():
    v = json.load(open(os.path.join(ROOT, 'rules', 'seal-vector.json'), encoding='utf-8'))
    assert canonical(v['plain']) == v['canonical']
    assert seal_hash(v['plain'], v['nonce']) == v['sha256']
