"""
Dev-time oracle for the visualization port. Not part of the web app.

Runs SensDSv2's reference script (core/doppler_spectrogram_live.py), read only,
on deterministic synthetic frames, and writes the expected outputs to
tests/fixtures/viz/ for the Node tests.

    python3 reference/python/make_viz_fixtures.py /Users/michaeladeleke/SensDSv2

The synthetic frames are built from integers only (a quantised cosine table and
an LCG), so JavaScript regenerates exactly the same input; see
tests/synthetic.js.
"""
import sys
sys.dont_write_bytecode = True          # never write __pycache__ into the reference repo

import importlib.util
import json
import pathlib

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import colormaps
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "tests" / "fixtures" / "viz"


def load_reference(sensds_root):
    path = pathlib.Path(sensds_root) / "core" / "doppler_spectrogram_live.py"
    spec = importlib.util.spec_from_file_location("ref_doppler_live", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod      # dataclasses looks the module up here
    spec.loader.exec_module(mod)
    return mod


# ---------- synthetic input, integer-only (mirrored in tests/synthetic.js) ----------
N_FRAMES, N_CHIRP, N_SAMPLE = 16, 128, 256
COS_TAB = [int(round(1000 * np.cos(2 * np.pi * k / 4096))) for k in range(4096)]


def synthetic_raw(f):
    """Raw 12-bit samples for antenna 0 of frame f, shape (128, 256), int."""
    raw = np.zeros((N_CHIRP, N_SAMPLE), dtype=np.int64)
    seed = (f * 2654435761 + 12345) & 0xFFFFFFFF
    tri = f % 8
    dop = 60 + 40 * (tri if tri < 4 else 8 - tri)        # Doppler step per chirp
    rng = 37 + (f % 5)                                    # range bin of the target
    for c in range(N_CHIRP):
        for s in range(N_SAMPLE):
            seed = (seed * 1103515245 + 12345) & 0xFFFFFFFF
            noise = ((seed >> 16) % 33) - 16
            target = COS_TAB[(s * rng + c * dop) & 4095] >> 2
            clutter = COS_TAB[(s * 11) & 4095] >> 3
            v = 2048 + target + clutter + noise
            raw[c, s] = min(4095, max(0, v))
    return raw


def sdk_scale(raw):
    """DeviceFmcwBase::get_next_frame in float32."""
    r = raw.astype(np.float32)
    return (r * np.float32(2)) / np.float32(4095) - np.float32(1)


def main():
    ref = load_reference(sys.argv[1])
    OUT.mkdir(parents=True, exist_ok=True)

    frames = [sdk_scale(synthetic_raw(f)) for f in range(N_FRAMES)]

    # ---------- LiveDopplerProcessor ----------
    history_length = 10
    proc = ref.LiveDopplerProcessor(n_sample=N_SAMPLE, n_chirp=N_CHIRP, history_length=history_length)
    bins = []
    for fr in frames:
        history, rb = proc.process_frame(fr)
        bins.append(int(rb))
    history.astype("<f8").tofile(OUT / "history_10x512.f64")

    rdm0 = ref.compute_rdm_db(frames[0], range_window=proc.range_window, doppler_window=proc.doppler_window,
                              range_fft_size=proc.range_fft_size, doppler_fft_size=proc.doppler_fft_size)
    rdm0.astype("<f8").tofile(OUT / "rdm_frame0_512x512.f64")

    # ---------- colormap ----------
    jet = colormaps["jet"]
    lut_float = jet(np.arange(256))[:, :3].tolist()
    lut_bytes = jet(np.arange(256), bytes=True)[:, :3].tolist()
    probe = np.linspace(0, 1, 1001)
    probe_bytes = jet(probe, bytes=True)[:, :3].tolist()

    # ---------- the live plot, drawn by the reference code ----------
    def render(figsize, hist, frame_end, grid=True):
        plot = ref.LiveSpectrogramPlot(history_length=history_length, max_speed_m_s=6.19405905,
                                       jet_vmin=-20.0, orientation=ref.ORIENT_FRAME_X)
        plot.fig.set_size_inches(*figsize)
        plot.fig.set_dpi(100)
        plot.draw(hist, frame_end=frame_end)
        if not grid:
            plot.ax.yaxis.grid(False)
        plot.fig.canvas.draw()
        ax = plot.ax
        info = {
            "figsize": figsize,
            "yticks": [float(t) for t in ax.get_yticks() if -6.19405905 <= t <= 6.19405905],
            "yticklabels": [t.get_text() for t in ax.get_yticklabels() if -6.19405905 <= t.get_position()[1] <= 6.19405905],
            "xticks": [float(t) for t in ax.get_xticks() if ax.get_xlim()[0] <= t <= ax.get_xlim()[1]],
            "xticklabels": [t.get_text() for t in ax.get_xticklabels() if ax.get_xlim()[0] <= t.get_position()[0] <= ax.get_xlim()[1]],
            "xlim": list(ax.get_xlim()),
            "title": ax.get_title(),
            "axes_bbox_px": [float(v) for v in ax.get_window_extent().bounds],
        }
        rgba = np.asarray(plot.fig.canvas.buffer_rgba()).copy()
        return plot, info, rgba

    ticks = []
    for figsize, fe in [((6.4, 4.8), 16), ((6.4, 6.4), 16), ((9.0, 9.0), 16), ((6.4, 4.8), 1), ((6.4, 4.8), 60), ((6.4, 4.8), 237)]:
        plot, info, _ = render(figsize, history, fe)
        info["frame_end"] = fe
        ticks.append(info)
        plot.close()

    plot, info, rgba = render((6.4, 4.8), history, 16, grid=False)
    rgba.tofile(OUT / "render_640x480_nogrid.rgba")
    plot.close()
    plot, _, _ = render((6.4, 4.8), history, 16, grid=True)
    plot.fig.savefig(ROOT / "docs" / "reference_render_640x480.png", dpi=100)
    plot.close()

    meta = {
        "generator": "reference/python/make_viz_fixtures.py",
        "versions": {"numpy": np.__version__, "scipy": __import__("scipy").__version__, "matplotlib": matplotlib.__version__},
        "n_frames": N_FRAMES, "n_chirp": N_CHIRP, "n_sample": N_SAMPLE,
        "cos_tab": COS_TAB,
        "history_length": history_length,
        "range_bins": bins,
        "range_window": proc.range_window.tolist(),
        "doppler_window": proc.doppler_window.tolist(),
        "frame0_scaled_first8": [float(v) for v in frames[0].ravel()[:8]],
        "jet_lut_float": lut_float,
        "jet_lut_bytes": lut_bytes,
        "jet_probe_bytes": probe_bytes,
        "ticks": ticks,
        "render_nogrid": {"width": 640, "height": 480, "frame_end": 16, "axes_bbox_px": info["axes_bbox_px"]},
    }
    (OUT / "meta.json").write_text(json.dumps(meta))
    print("range bins:", bins)
    for t in ticks:
        print(t["figsize"], t["frame_end"], t["yticklabels"], t["xticklabels"], t["title"])


if __name__ == "__main__":
    main()
