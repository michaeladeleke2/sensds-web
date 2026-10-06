"""
Dev-time oracle for the Test tab port. Not part of the web app.

Saves a small ViTForImageClassification with save_pretrained (the folder layout
SensDSv2 loads), then runs SensDSv2's inference path on real training images:
AutoImageProcessor(images=img) -> model -> softmax, as InferenceWorker does.

    python3 reference/python/make_test_fixtures.py
"""
import sys
sys.dont_write_bytecode = True

import json
import pathlib

import numpy as np
import torch
from PIL import Image
from transformers import AutoImageProcessor, AutoModelForImageClassification, ViTConfig, ViTForImageClassification, ViTImageProcessor

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "tests" / "fixtures" / "test_tab"


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    torch.manual_seed(5)
    labels = ["idle", "push", "swipe_left"]
    cfg = ViTConfig(image_size=32, patch_size=8, hidden_size=32, num_hidden_layers=2, num_attention_heads=2,
                    intermediate_size=64, num_labels=3, id2label=dict(enumerate(labels)),
                    label2id={l: i for i, l in enumerate(labels)})
    model = ViTForImageClassification(cfg)
    with torch.no_grad():
        for p in model.parameters():
            p.add_(0.05 * torch.randn_like(p))
    folder = OUT / "tiny_model"
    model.save_pretrained(folder)
    ViTImageProcessor(size={"height": 32, "width": 32}, image_mean=[0.5] * 3, image_std=[0.5] * 3).save_pretrained(folder)

    proc = AutoImageProcessor.from_pretrained(folder)
    m = AutoModelForImageClassification.from_pretrained(folder, ignore_mismatched_sizes=True).eval()
    id2label = {int(k): v for k, v in m.config.id2label.items()}
    out = {"processor_class": type(proc).__name__, "classes": [id2label[i] for i in sorted(id2label)], "cases": []}
    for name in ["training_20.png", "training_50.png"]:
        img = Image.open(ROOT / "tests" / "fixtures" / "collect" / name).convert("RGB")
        inputs = proc(images=img, return_tensors="pt")
        with torch.inference_mode():
            logits = m(**inputs).logits
        probs = torch.softmax(logits[0], dim=0).numpy()
        # What the PIL bilinear path gives, to compare with the processor's own resize
        pil = np.asarray(img.resize((32, 32), Image.BILINEAR)).astype(np.float64) * (1 / 255)
        pil = ((pil.astype(np.float32) - 0.5) / 0.5).transpose(2, 0, 1)
        px = inputs["pixel_values"][0].numpy()
        out["cases"].append({"image": name, "probs": {id2label[i]: float(p) for i, p in enumerate(probs)},
                             "pixel_values": px.ravel().tolist(),
                             "max_diff_vs_pil_path": float(np.abs(px - pil).max())})
    (OUT / "meta.json").write_text(json.dumps(out))
    print(out["processor_class"], [c["probs"] for c in out["cases"]], [c["max_diff_vs_pil_path"] for c in out["cases"]])


if __name__ == "__main__":
    main()
