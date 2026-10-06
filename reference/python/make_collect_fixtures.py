"""
Dev-time oracle for the Collect tab port. Not part of the web app.

Runs SensDSv2's own capture pipeline, read only: core/reference_image.py
(reference_spectrogram -> compute_recorded, reference_rgb, training_image) on
the same integer-only synthetic frames as make_viz_fixtures.py, and writes the
expected outputs to tests/fixtures/collect/.

    python3 reference/python/make_collect_fixtures.py /Users/michaeladeleke/SensDSv2
"""
import sys
sys.dont_write_bytecode = True          # never write __pycache__ into the reference repo

import json
import pathlib

import matplotlib
matplotlib.use("Agg")
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "tests" / "fixtures" / "collect"
sys.path.insert(0, str(ROOT / "reference" / "python"))
from make_viz_fixtures import synthetic_raw, sdk_scale      # same synthetic input


def main():
    sensds = pathlib.Path(sys.argv[1])
    sys.path.insert(0, str(sensds))
    from core import reference_image as ri                   # read only

    OUT.mkdir(parents=True, exist_ok=True)

    # Duration -> frame count, exactly as CollectTab._start_collection
    durations = [round(1.0 + 0.5 * i, 1) for i in range(19)] + [2.3, 2.25, 0.2]
    num_frames = {str(d): max(1, round(d / 0.15)) for d in durations}

    # A 20-frame capture (the 3 s default) of antenna 0
    n = num_frames["3.0"]
    frames = np.stack([sdk_scale(synthetic_raw(f)) for f in range(n)])[:, None]   # (n, 1, 128, 256)
    spect = ri.reference_spectrogram(frames)                 # (n, 512) float64
    spect.astype("<f8").tofile(OUT / "spectrogram_20x512.f64")

    out = {"num_frames": num_frames, "n": n, "versions": {
        "numpy": np.__version__, "matplotlib": matplotlib.__version__, "pillow": __import__("PIL").__version__}}
    for floor in (-20.0, -50.0):
        rgb = ri.reference_rgb(spect, floor)                 # (512, n, 3) uint8
        rgb.tofile(OUT / f"reference_rgb_{int(-floor)}.u8")
        img = ri.training_image(spect, floor)                # PIL RGB 400x300
        assert img.mode == "RGB" and img.size == (400, 300)
        np.asarray(img).tofile(OUT / f"training_{int(-floor)}.u8")
        img.save(OUT / f"training_{int(-floor)}.png")
    # Pillow BILINEAR on a small known image, for a focused resize test
    from PIL import Image
    small = (np.arange(7 * 5 * 3, dtype=np.uint16) * 37 % 256).astype(np.uint8).reshape(7, 5, 3)
    Image.fromarray(small, "RGB").resize((11, 4), Image.BILINEAR).save(OUT / "resize_probe.png")
    out["resize_probe_in"] = small.tolist()
    out["resize_probe_out"] = np.asarray(Image.open(OUT / "resize_probe.png")).tolist()
    (OUT / "meta.json").write_text(json.dumps(out))
    print("num_frames:", num_frames)
    print("spectrogram", spect.shape, "training images written")


if __name__ == "__main__":
    main()
