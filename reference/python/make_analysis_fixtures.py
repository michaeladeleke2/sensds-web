"""
Dev-time oracle for the Analysis tab port. Not part of the web app.

Runs SensDSv2's core/physical_features.py and core/pca_analysis.py, read only,
on (a) the 20 real radar frames captured during the register export and
(b) small synthetic 3-antenna samples from two "gestures", and writes the
expected outputs to tests/fixtures/analysis/.

    python3 reference/python/make_analysis_fixtures.py /Users/michaeladeleke/SensDSv2
"""
import sys
sys.dont_write_bytecode = True          # never write __pycache__ into the reference repo

import io
import json
import pathlib

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "tests" / "fixtures" / "analysis"
sys.path.insert(0, str(ROOT / "reference" / "python"))
from make_viz_fixtures import COS_TAB, sdk_scale


def synthetic_raw_variant(f, ant, variant, n_chirp=128, n_sample=256):
    """Integer-only frame for antenna `ant` of sample `variant` (mirrored in tests/synthetic.js)."""
    raw = np.zeros((n_chirp, n_sample), dtype=np.int64)
    seed = (f * 2654435761 + 12345 + 7919 * ant + 104729 * variant) & 0xFFFFFFFF
    gesture = variant % 2
    dop = (40 + 25 * ((f + variant) % 6)) if gesture == 0 else (300 - 20 * ((f + variant) % 5))
    rng = 30 + 3 * f + variant if gesture == 0 else 60 + variant
    for c in range(n_chirp):
        for s in range(n_sample):
            seed = (seed * 1103515245 + 12345) & 0xFFFFFFFF
            noise = ((seed >> 16) % 33) - 16
            target = COS_TAB[(s * rng + c * dop + 97 * ant) & 4095] >> 2
            clutter = COS_TAB[(s * 11) & 4095] >> 3
            raw[c, s] = min(4095, max(0, 2048 + target + clutter + noise))
    return raw


def synthetic_cube(variant, n_frame=7):
    return np.stack([np.stack([sdk_scale(synthetic_raw_variant(f, a, variant)) for a in range(3)])
                     for f in range(n_frame)]).astype(np.float32)


def main():
    sys.path.insert(0, sys.argv[1])
    from core import physical_features as PF
    from core import pca_analysis as PA

    OUT.mkdir(parents=True, exist_ok=True)
    real = np.load(ROOT / "tests" / "fixtures" / "radar" / "python_frames.npy")
    cubes = [("real", real)] + [(f"syn{v}", synthetic_cube(v)) for v in range(8)]
    labels = ["idle"] + ["push" if v % 2 == 0 else "swipe" for v in range(8)]

    out = {"samples": []}
    spec_feats, rfft_feats = [], []
    records = []
    for (name, cube), label in zip(cubes, labels):
        summary, series = PF.extract(cube)
        sf = PA.spectrogram_features(cube)
        rf = PA.range_fft_features(cube)
        spec_feats.append(sf); rfft_feats.append(rf)
        out["samples"].append({
            "name": name, "label": label,
            "summary": summary,
            "series": {k: np.asarray(v).tolist() for k, v in series.items()},
        })
        np.asarray(sf, "<f8").tofile(OUT / f"spec_feat_{name}.f64")
        np.asarray(rf, "<f8").tofile(OUT / f"rfft_feat_{name}.f64")
        records.append({"student": "Alex, Jr." if name == "real" else "Sam", "gesture": label,
                        "name": f"{name}_raw.npy", "summary": summary, "series": series})

    for key, feats in (("spec", spec_feats), ("rfft", rfft_feats)):
        proj, evr = PA.pca(np.vstack(feats), k=2)
        out[f"{key}_proj"] = proj.tolist()
        out[f"{key}_evr"] = evr.tolist()
        out[f"{key}_sil"] = PA.silhouette(proj, np.array(labels))
    out["labels"] = labels

    # CSV text exactly as the desktop writes it
    import tempfile, os
    with tempfile.TemporaryDirectory() as d:
        PF.write_summary_csv(records, os.path.join(d, "s.csv"))
        PF.write_frames_csv(records, os.path.join(d, "f.csv"))
        out["summary_csv"] = open(os.path.join(d, "s.csv"), newline="").read()
        out["frames_csv"] = open(os.path.join(d, "f.csv"), newline="").read()

    # scipy.ndimage.zoom(order=1) probes through PA._resize
    probes = []
    rs = np.random.RandomState(7)
    for h, w in [(20, 512), (7, 512), (67, 512), (32, 32), (5, 3), (40, 33)]:
        a = rs.standard_normal((h, w))
        probes.append({"shape": [h, w], "input": a.ravel().tolist(), "output": PA._resize(a).ravel().tolist()})
    out["zoom_probes"] = probes
    # Python %.6g samples for the CSV formatter
    vals = [0.0, 1.0, -2.5, 123456.0, 1234567.0, 0.0001234567, 1.23456e-5, 3.49e-15, 0.30000000000000004, 1e16, -0.000999995, 2.7272727, 99999.95, 0.1]
    out["g6"] = [[v, f"{v:.6g}"] for v in vals]
    (OUT / "meta.json").write_text(json.dumps(out))
    print("spec evr", out["spec_evr"], "sil", out["spec_sil"])
    print("rfft evr", out["rfft_evr"], "sil", out["rfft_sil"])
    print("real summary", {k: round(v, 4) for k, v in out["samples"][0]["summary"].items() if k in PF.SUMMARY_KEYS})


if __name__ == "__main__":
    main()
