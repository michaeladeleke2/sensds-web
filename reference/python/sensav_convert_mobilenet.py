"""Converts the MobileNetV3 Small ImageNet weights SensAV uses into the file the
web app loads (assets/sensav/mobilenet_v3_small.safetensors).

SensAV's tools/fetch_assets.py downloads torchvision's mobilenet_v3_small-047dcff4.pth;
this script downloads the same file from download.pytorch.org (it does not read
anything from the SensAV folder), checks its SHA-256 prefix, and writes every
tensor the backbone uses as float32 safetensors. The last classifier layer
(Linear 1024 -> 1000) is left out: SensAV cuts the model after classifier[1],
so the 1024-value embedding is the output. BatchNorm counters
(num_batches_tracked) are left out too.

Development time only:
    <python with torch> reference/python/sensav_convert_mobilenet.py
"""
import hashlib
import io
import json
import struct
import sys
import urllib.request
from pathlib import Path

import torch

URL = "https://download.pytorch.org/models/mobilenet_v3_small-047dcff4.pth"
SHA256_PREFIX = "047dcff4"
OUT = Path(__file__).resolve().parents[2] / "assets" / "sensav" / "mobilenet_v3_small.safetensors"


def main() -> int:
    print(f"Downloading {URL}")
    with urllib.request.urlopen(URL, timeout=120) as response:
        data = response.read()
    digest = hashlib.sha256(data).hexdigest()
    if not digest.startswith(SHA256_PREFIX):
        raise SystemExit(f"Checksum mismatch: {digest}")
    state = torch.load(io.BytesIO(data), map_location="cpu", weights_only=True)
    tensors = {k: v.float().contiguous() for k, v in state.items() if not k.endswith("num_batches_tracked") and not k.startswith("classifier.3.")}
    header, blobs, offset = {"__metadata__": {"source": URL, "sha256": digest}}, [], 0
    for name in sorted(tensors):
        raw = tensors[name].numpy().astype("<f4").tobytes()
        header[name] = {"dtype": "F32", "shape": list(tensors[name].shape), "data_offsets": [offset, offset + len(raw)]}
        blobs.append(raw)
        offset += len(raw)
    text = json.dumps(header, separators=(",", ":"))
    text += " " * ((8 - len(text) % 8) % 8)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(struct.pack("<Q", len(text)) + text.encode() + b"".join(blobs))
    print(f"Wrote {len(tensors)} tensors ({offset / 1e6:.1f} MB) to {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
