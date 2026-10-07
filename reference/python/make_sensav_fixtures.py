"""
Dev-time oracle for the SensAV port. Not part of the web app.

Runs SensAV's own Python code (read only, imported from the SensAV folder given
on the command line, no bytecode written there) on deterministic inputs and
saves what it produces, so the JavaScript ports can be checked against it:

1. audio: mel filterbank, log_mel, to_unit, clip_image (cv2 INTER_LINEAR),
   StreamingMel, Resampler 48 kHz -> 16 kHz, write_wav bytes, read_wav of a
   44.1 kHz stereo file, the CSV audio features.
2. images: square_sample (cv2 INTER_AREA) of a 640x480 frame, the CSV image
   features of a JPEG.
3. the frozen MobileNetV3 Small backbone (weights from assets/sensav, which
   reference/python/sensav_convert_mobilenet.py made from torchvision's file)
   on three images.
4. torch.Generator normal_ draws and ClassifierHead.initialize.
5. the per-class split (numpy default_rng permutation), and train_classifier on
   float16-rounded synthetic embeddings: per-epoch history, final weights,
   confusion matrix.
6. a model.pt written by save_trained_model, an embeddings.npz written by
   EmbeddingStore.save, and a .sensavmodel written by export_model, for the
   readers.

    <SensAV venv python> reference/python/make_sensav_fixtures.py ~/SensAV
"""
import sys
sys.dont_write_bytecode = True

import io
import json
import os
import pathlib
import shutil
import tempfile
import wave

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "tests" / "fixtures" / "sensav"


def read_safetensors(path):
    raw = pathlib.Path(path).read_bytes()
    n = int.from_bytes(raw[:8], "little")
    header = json.loads(raw[8:8 + n])
    base = 8 + n
    out = {}
    for name, t in header.items():
        if name == "__metadata__":
            continue
        a, b = t["data_offsets"]
        out[name] = np.frombuffer(raw[base + a:base + b], dtype="<f4").reshape(t["shape"]).copy()
    return out


class Arrays:
    """Named arrays in one binary file, indexed in meta.json."""

    def __init__(self):
        self.index, self.chunks, self.offset = {}, [], 0

    def add(self, name, array, dtype):
        a = np.ascontiguousarray(np.asarray(array).astype(dtype))
        raw = a.tobytes()
        self.index[name] = {"dtype": np.dtype(dtype).str, "shape": list(a.shape), "offset": self.offset}
        self.chunks.append(raw)
        pad = (-len(raw)) % 8
        self.chunks.append(b"\0" * pad)
        self.offset += len(raw) + pad

    def write(self, path):
        path.write_bytes(b"".join(self.chunks))


def main():
    sensav = pathlib.Path(sys.argv[1]).expanduser().resolve()
    sys.path.insert(0, str(sensav))
    tmp = pathlib.Path(tempfile.mkdtemp())
    os.environ["SENSAV_DATA_DIR"] = str(tmp / "data")

    import cv2
    import torch
    import torchvision
    from app.ml import audio_features as af
    from app.capture.camera import square_sample, write_jpeg
    from app.storage.export import audio_features, image_features, pca_two
    from app.ml.head import ClassifierHead, variance_scaling_
    from app.ml.trainer import SHUFFLE_SEED, build_dataset, split_per_class, train_classifier
    from app.ml.model_store import save_trained_model
    from app.ml.embeddings import EmbeddingStore
    from app.ml.model_transfer import export_model
    from app.storage.project import Project

    OUT.mkdir(parents=True, exist_ok=True)
    arr = Arrays()
    meta = {"versions": {"torch": torch.__version__, "torchvision": torchvision.__version__, "numpy": np.__version__, "cv2": cv2.__version__}}
    rng = np.random.default_rng(2024)

    # ---------- 1. audio ----------
    t = np.arange(int(1.3 * af.SAMPLE_RATE)) / af.SAMPLE_RATE
    signal = (0.3 * np.sin(2 * np.pi * (300 + 900 * t) * t) + 0.05 * rng.standard_normal(len(t))).astype(np.float32)
    signal[5000:6500] *= 4.0
    arr.add("audio_signal", signal, "<f4")
    arr.add("mel_filterbank", af.mel_filterbank(), "<f4")
    arr.add("log_mel", af.log_mel(signal), "<f4")
    arr.add("to_unit", af.to_unit(af.log_mel(signal)), "<f4")
    arr.add("clip_image", af.clip_image(signal)[:, :, 0], "<u1")
    short = signal[:9000]
    arr.add("clip_image_short", af.clip_image(short)[:, :, 0], "<u1")

    streaming = af.StreamingMel()
    cols = [streaming.push(signal[i:i + 800]) for i in range(0, len(signal), 800)]
    arr.add("streaming_mel", np.concatenate(cols, axis=1), "<f4")
    meta["streaming_counts"] = [int(c.shape[1]) for c in cols]

    t48 = np.arange(24000) / 48000
    s48 = (0.4 * np.sin(2 * np.pi * 440 * t48) + 0.2 * np.sin(2 * np.pi * 7000 * t48) + 0.02 * rng.standard_normal(len(t48))).astype(np.float32)
    arr.add("resample_in", s48, "<f4")
    res = af.Resampler(48000, 16000)
    outs = [res.process(s48[i:i + 2400]) for i in range(0, len(s48), 2400)]
    arr.add("resample_out", np.concatenate(outs), "<f4")
    meta["resample_counts"] = [len(o) for o in outs]
    res441 = af.Resampler(44100, 16000)
    outs441 = [res441.process(s48[i:i + 2205]) for i in range(0, 22050, 2205)]
    arr.add("resample441_out", np.concatenate(outs441), "<f4")
    meta["resample441_counts"] = [len(o) for o in outs441]

    wav_path = tmp / "clip.wav"
    clip = af.fit_clip(signal)
    af.write_wav(wav_path, clip)
    arr.add("wav_bytes", np.frombuffer(wav_path.read_bytes(), dtype=np.uint8), "<u1")

    stereo_path = tmp / "stereo.wav"
    st = (np.stack([s48[:22050], s48[1000:23050]], axis=1) * 20000).astype("<i2")
    with wave.open(str(stereo_path), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(44100); w.writeframes(st.tobytes())
    arr.add("stereo_wav_bytes", np.frombuffer(stereo_path.read_bytes(), dtype=np.uint8), "<u1")
    arr.add("stereo_read", af.read_wav(stereo_path), "<f4")
    meta["audio_features_clip"] = audio_features(wav_path)
    meta["audio_features_stereo"] = audio_features(stereo_path)

    # ---------- 2. images ----------
    def pattern(h, w):
        # Integer-only, so the JavaScript test builds the same frame
        yy, xx = np.mgrid[0:h, 0:w].astype(np.int64)
        return np.stack([(xx * 7 + yy * 13 + c * 50 + (xx * yy) % 97) % 256 for c in range(3)], axis=2).astype(np.uint8)
    frame = pattern(480, 640)   # BGR, as OpenCV captures
    sq = square_sample(frame)
    arr.add("square_sample_bgr", sq, "<u1")
    arr.add("square_sample720_bgr", square_sample(pattern(720, 1280)), "<u1")
    arr.add("square_sample_tall_bgr", square_sample(pattern(500, 300)), "<u1")
    jpg = tmp / "sample.jpg"
    write_jpeg(jpg, sq)
    arr.add("jpeg_bytes", np.frombuffer(jpg.read_bytes(), dtype=np.uint8), "<u1")
    arr.add("jpeg_decoded_bgr", cv2.imdecode(np.fromfile(str(jpg), dtype=np.uint8), cv2.IMREAD_COLOR), "<u1")
    meta["image_features"] = image_features(jpg)

    # ---------- 3. backbone ----------
    import app.ml.backbone as bb
    weights = sensav / "assets" / "weights" / bb.WEIGHTS_FILE
    model = torchvision.models.mobilenet_v3_small()
    state = read_safetensors(ROOT / "assets" / "sensav" / "mobilenet_v3_small.safetensors")
    full = model.state_dict()
    for k in list(full):
        if k in state:
            full[k] = torch.from_numpy(state[k])
    model.load_state_dict(full)
    model.classifier = model.classifier[:2]
    model.eval()
    if weights.is_file():
        # Same numbers as SensAV's own weights file
        ref = torch.load(weights, map_location="cpu", weights_only=True)
        meta["weights_match_sensav"] = all(torch.equal(ref[k].float(), torch.from_numpy(v)) for k, v in state.items())
    rgb_sq = cv2.cvtColor(sq, cv2.COLOR_BGR2RGB)
    grad = np.stack(list(np.meshgrid(np.linspace(0, 255, 224), np.linspace(255, 0, 224))) + [np.full((224, 224), 128.0)], axis=2)
    noise = rng.integers(0, 256, size=(224, 224, 3))
    images = np.stack([rgb_sq, grad, noise]).astype(np.uint8)
    arr.add("backbone_images", images, "<u1")
    x = (images.astype(np.float32) / 255.0 - bb._MEAN) / bb._STD
    with torch.inference_mode():
        emb = model(torch.from_numpy(np.ascontiguousarray(x.transpose(0, 3, 1, 2)))).numpy()
    arr.add("backbone_embeddings", emb, "<f4")

    # ---------- 4. torch generator and head init ----------
    g = torch.Generator().manual_seed(1234)
    draws = []
    for n in (7, 16, 37, 3, 100, 1, 2, 33):
        draws.append(torch.empty(n).normal_(0.0, 0.5, generator=g))
    arr.add("normal_draws", torch.cat(draws).numpy(), "<f4")
    meta["normal_sizes"] = [7, 16, 37, 3, 100, 1, 2, 33]
    for classes in (3, 5):
        head = ClassifierHead(1024, classes)
        head.initialize(SHUFFLE_SEED)
        arr.add(f"head{classes}_hidden_w", head.hidden.weight.detach().numpy(), "<f4")
        arr.add(f"head{classes}_output_w", head.output.weight.detach().numpy(), "<f4")

    # ---------- 5. split and training ----------
    counts = [25, 21, 30]
    sample_ids = [[f"2026100{c}_1200{i:02d}_000000_{c}{i:03x}" for i in range(n)] for c, n in enumerate(counts)]
    split_rng = np.random.default_rng(SHUFFLE_SEED)
    splits = split_per_class(sample_ids, split_rng)
    centers = rng.normal(0, 1.0, size=(3, 1024))
    lookup_table = {}
    for c, ids in enumerate(sample_ids):
        for sid in ids:
            v = np.maximum(0, centers[c] + rng.normal(0, 7.0, 1024)) - 0.2      # hardswish-like, mostly >= 0
            lookup_table[sid] = v.astype(np.float16)
    lookup = lambda ids: np.stack([lookup_table[i] for i in ids]).astype(np.float32)
    train_x, train_y, val_x, val_y = build_dataset(splits, lookup, split_rng)
    meta["split"] = [[tr, va] for tr, va in splits]
    meta["sample_ids"] = sample_ids
    all_ids = [sid for ids in sample_ids for sid in ids]
    arr.add("train_embeddings", np.stack([lookup_table[i] for i in all_ids]), "<f2")
    meta["train_order_y"] = train_y.tolist()
    meta["val_order_y"] = val_y.tolist()
    arr.add("train_x", train_x, "<f4")
    arr.add("val_x", val_x, "<f4")
    result = train_classifier(train_x, train_y, val_x, val_y, 3, epochs=12, batch_size=16, learning_rate=0.001)
    meta["train_history"] = [m.to_dict() for m in result.history]
    meta["train_confusion"] = result.confusion.tolist()
    meta["train_class_accuracy"] = result.class_accuracy
    meta["train_counts"] = result.train_counts
    meta["val_counts"] = result.val_counts
    arr.add("trained_hidden_w", result.head.hidden.weight.detach().numpy(), "<f4")
    arr.add("trained_hidden_b", result.head.hidden.bias.detach().numpy(), "<f4")
    arr.add("trained_output_w", result.head.output.weight.detach().numpy(), "<f4")
    arr.add("trained_val_proba", result.head.predict_proba(val_x), "<f4")

    # ---------- 6. files the readers must open ----------
    project = Project.create(tmp / "projects", "Fixture Project")
    labels = [{"id": f"id{c}", "name": f"Class {c}"} for c in range(3)]
    report = {"mode": "image", "project": project.name, "classes": [{"id": l["id"], "name": l["name"], "color": "#2F6FED"} for l in labels], "val_accuracy": result.val_accuracy}
    save_trained_model(project.root, "image", result.head, labels, report)
    shutil.copy(project.root / "models" / "image" / "model.pt", OUT / "model.pt")
    export_model(project, "image", OUT / "fixture.sensavmodel")
    store = EmbeddingStore()
    for sid in all_ids[:6]:
        store.add("image", sid, lookup_table[sid][None])
    store.save(OUT / "embeddings.npz")
    meta["npz_ids"] = sorted(all_ids[:6])
    arr.add("pca_input", lookup(all_ids[:40]), "<f4")
    arr.add("pca_two", pca_two(lookup(all_ids[:40])), "<f4")

    meta["arrays"] = arr.index
    arr.write(OUT / "arrays.bin")
    (OUT / "meta.json").write_text(json.dumps(meta, indent=1))
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"Wrote fixtures to {OUT}")


if __name__ == "__main__":
    main()
