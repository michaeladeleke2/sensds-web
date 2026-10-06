"""
Dev-time oracle for the Train tab port. Not part of the web app.

1. A tiny ViTForImageClassification (random weights) run through two training
   steps exactly as SensDSv2's TrainWorker / Hugging Face Trainer would:
   cross-entropy, gradient clipping at 1.0, torch AdamW with the Trainer's
   weight-decay groups, linear learning-rate schedule.
2. The real vit-small-patch16-224 (read from the SensDSv2 models folder, read
   only) on a real training PNG, with the val transform, for a forward check.
3. numpy default_rng(seed).shuffle outputs, for the subject split.

    python3 reference/python/make_train_fixtures.py /Users/michaeladeleke/SensDSv2
"""
import sys
sys.dont_write_bytecode = True

import json
import pathlib

import numpy as np
import torch
import torchvision.transforms as T
from PIL import Image
from safetensors.torch import save_file
from transformers import Trainer, ViTConfig, ViTForImageClassification

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "tests" / "fixtures" / "train"


def decay_names(model):
    return Trainer.get_decay_parameter_names(None, model)


def main():
    sensds = pathlib.Path(sys.argv[1])
    OUT.mkdir(parents=True, exist_ok=True)
    meta = {"versions": {"torch": torch.__version__, "transformers": __import__("transformers").__version__, "numpy": np.__version__}}

    # ---------- 1. tiny model, two training steps ----------
    torch.manual_seed(0)
    cfg = ViTConfig(image_size=32, patch_size=8, num_channels=3, hidden_size=32, num_hidden_layers=2,
                    num_attention_heads=2, intermediate_size=64, hidden_act="gelu", layer_norm_eps=1e-12,
                    hidden_dropout_prob=0.0, attention_probs_dropout_prob=0.0, qkv_bias=True, num_labels=3)
    model = ViTForImageClassification(cfg)
    for p in model.parameters():                      # make biases and LN non-trivial
        with torch.no_grad():
            p.add_(0.05 * torch.randn_like(p))
    save_file({k: v.contiguous() for k, v in model.state_dict().items()}, OUT / "tiny_init.safetensors")
    rs = np.random.RandomState(1)
    x = torch.tensor(rs.uniform(-1, 1, (4, 3, 32, 32)).astype(np.float32))
    y = torch.tensor([0, 2, 1, 2])
    np.asarray(x, "<f4").tofile(OUT / "tiny_x_nchw.f32")
    meta["tiny"] = {"config": cfg.to_dict(), "labels": y.tolist()}

    decay = set(decay_names(model))
    meta["tiny"]["decay_names"] = sorted(decay)
    groups = [{"params": [p for n, p in model.named_parameters() if n in decay], "weight_decay": 0.01},
              {"params": [p for n, p in model.named_parameters() if n not in decay], "weight_decay": 0.0}]
    lr, total_steps = 2e-5 * 50, 10                  # a larger lr so the update is clearly visible
    opt = torch.optim.AdamW(groups, lr=lr, betas=(0.9, 0.999), eps=1e-8)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: max(0.0, (total_steps - s) / total_steps))
    model.train()
    steps = []
    for step in range(2):
        opt.zero_grad()
        out = model(pixel_values=x, labels=y)
        out.loss.backward()
        norm = torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step(); sched.step()
        steps.append({"loss": out.loss.item(), "grad_norm": norm.item(), "logits": out.logits.detach().tolist()})
    meta["tiny"]["lr"] = lr
    meta["tiny"]["total_steps"] = total_steps
    meta["tiny"]["steps"] = steps
    save_file({k: v.contiguous() for k, v in model.state_dict().items()}, OUT / "tiny_after2.safetensors")
    model.eval()
    with torch.no_grad():
        meta["tiny"]["eval_logits"] = model(pixel_values=x).logits.tolist()

    # ---------- 2. real vit-small forward on a real training image ----------
    src = sensds / "models" / "vit-small-patch16-224"
    real = ViTForImageClassification.from_pretrained(str(src), num_labels=3, ignore_mismatched_sizes=True)
    g = torch.Generator().manual_seed(3)
    with torch.no_grad():
        real.classifier.weight.copy_(torch.randn(3, 384, generator=g) * 0.02)
        real.classifier.bias.copy_(torch.tensor([0.01, -0.02, 0.03]))
    save_file({"classifier.weight": real.classifier.weight.detach().contiguous(),
               "classifier.bias": real.classifier.bias.detach().contiguous()}, OUT / "small_head.safetensors")
    img = Image.open(ROOT / "tests" / "fixtures" / "collect" / "training_20.png").convert("RGB")
    val_transform = T.Compose([T.Resize((224, 224)), T.ToTensor(), T.Normalize(mean=[0.5] * 3, std=[0.5] * 3)])
    px = val_transform(img).unsqueeze(0)
    np.asarray(px, "<f4").tofile(OUT / "small_px_nchw.f32")
    real.eval()
    with torch.no_grad():
        meta["small_logits"] = real(pixel_values=px).logits.tolist()
    # Train-transform first step, deterministic part: Resize((256, 256))
    np.asarray(img.resize((256, 256), Image.BILINEAR)).tofile(OUT / "resize256.u8")

    # ---------- 3. numpy default_rng shuffles ----------
    shuf = []
    for seed, n in [(42, 2), (42, 3), (42, 5), (42, 12), (42, 37), (7, 10), (42, 1000)]:
        a = np.arange(n); np.random.default_rng(seed).shuffle(a); shuf.append({"seed": seed, "n": n, "out": a.tolist()})
    meta["shuffles"] = shuf
    names = np.array(["Alex", "Bea", "Cy", "Dee"]); np.random.default_rng(42).shuffle(names)
    meta["subject_shuffle"] = names.tolist()
    (OUT / "meta.json").write_text(json.dumps(meta))
    print("tiny losses", [s["loss"] for s in steps], "grad norms", [s["grad_norm"] for s in steps])
    print("small logits", meta["small_logits"])
    print("shuffles", shuf[:4], "subjects", meta["subject_shuffle"])


if __name__ == "__main__":
    main()
