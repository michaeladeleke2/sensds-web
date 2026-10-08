"""
Dev-time oracle for the range map views. Not part of the web app.

Runs range_map_v1.py and range_map_live.py (kept unchanged next to this file)
on the 20 real radar frames in tests/fixtures/radar/python_frames.npy, in
both modes, and saves what they compute: windows, range axis, every frame's
profile (compute_range_map) and the live processor's rolling history.
Optionally saves the scripts' own matplotlib figures for a visual check.

    python3 reference/python/make_range_map_fixtures.py [figure_dir]
"""
import sys
sys.dont_write_bytecode = True

import json
import pathlib

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = ROOT / "tests" / "fixtures" / "range_map"
sys.path.insert(0, str(HERE))

import range_map_v1 as rm  # noqa: E402
from range_map_live import LiveRangeProcessor, LiveRangePlot  # noqa: E402


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    data = np.load(ROOT / "tests" / "fixtures" / "radar" / "python_frames.npy")
    n_frame, n_ant, n_chirp, n_sample = data.shape
    arrays, index, offset = [], {}, 0

    def add(name, a):
        nonlocal offset
        a = np.ascontiguousarray(np.asarray(a, dtype="<f8"))
        index[name] = {"shape": list(a.shape), "offset": offset}
        arrays.append(a.tobytes())
        offset += a.nbytes

    rw, dw = rm._windows(n_sample, n_chirp)
    add("range_window", rw)
    add("doppler_window", dw)
    meta = {"shape": list(data.shape), "versions": {"numpy": np.__version__, "matplotlib": matplotlib.__version__}}
    for mode in ("raw", "mti"):
        db, range_m = rm.compute_range_map(data, antenna=0, mode=mode)
        add(f"map_{mode}", db)
        add("range_m", range_m)
        proc = LiveRangeProcessor(n_sample=n_sample, n_chirp=n_chirp, mode=mode, history_length=12)
        for i in range(n_frame):
            history, n_filled = proc.process_frame(data[i, 0])
            if i == 6:
                add(f"live_{mode}_history_7", history.copy())
        add(f"live_{mode}_history_20", history)
        visible = np.asarray(history[-n_filled:], dtype=np.float64).T
        meta[f"live_{mode}_clim"] = list(rm._jet_clim(visible, -20.0))
        meta[f"map_{mode}_clim"] = list(rm._jet_clim(db.T, -20.0))
        meta[f"live_{mode}_range"] = [float(proc.range_m[0]), float(proc.range_m[-1])]
        if len(sys.argv) > 1:
            figdir = pathlib.Path(sys.argv[1])
            title = "Range map (moving)" if mode == "mti" else "Range map (raw)"
            fig = rm.plot_range_map(db, range_m, duration_s=n_frame * rm.FRAME_REPETITION_TIME_S, title=title)
            fig.savefig(figdir / f"range_map_{mode}.png", dpi=100)
            plt.close(fig)
            plot = LiveRangePlot(history_length=12, range_m=proc.range_m, frame_repetition_time_s=0.1,
                                 title="Range map (live, moving)" if mode == "mti" else "Range map (live, raw)")
            plot.draw(history, n_filled, frame_end=n_frame)
            plot.fig.savefig(figdir / f"range_map_live_{mode}.png", dpi=100)
            plt.close(plot.fig)
    meta["arrays"] = index
    (OUT / "arrays.f64").write_bytes(b"".join(arrays))
    (OUT / "meta.json").write_text(json.dumps(meta, indent=1))
    print("wrote", OUT, offset, "bytes")


if __name__ == "__main__":
    main()
