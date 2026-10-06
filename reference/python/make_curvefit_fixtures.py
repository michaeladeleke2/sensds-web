"""
Dev-time oracle for the Curve Fit port. Not part of the web app.

Runs SensDSv2's core/curve_fit.py, read only, on synthetic traces shaped like
hand tracing (backtracking, jitter, uneven spacing), and scipy's curve_fit on
sums of sinusoids from fixed starting points, and saves inputs and outputs.

    python3 reference/python/make_curvefit_fixtures.py /Users/michaeladeleke/SensDSv2
"""
import sys
sys.dont_write_bytecode = True

import json
import pathlib

import numpy as np
from scipy.optimize import curve_fit

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "tests" / "fixtures" / "curvefit"


def hand_trace(rng, fn, t0, t1, n, jitter, backtrack=True):
    """A traced path: uneven times, some backtracking, velocity jitter."""
    t = np.sort(rng.uniform(t0, t1, n))
    if backtrack:
        k = n // 6
        idx = rng.choice(n, k, replace=False)
        t = np.concatenate([t, t[idx]])           # the same instants traced twice
    v = fn(t) + rng.normal(0, jitter, t.size)
    order = rng.permutation(t.size) if backtrack else np.arange(t.size)
    return np.stack([t[order], v[order]], axis=1)


def multi(t, *p, damped=False):
    m = 4 if damped else 3
    k = (len(p) - 1) // m
    out = np.full_like(t, p[-1], dtype=float)
    for j in range(k):
        q = p[j * m:(j + 1) * m]
        if damped:
            A, tau, f, phi = q
            out += A * np.exp(-t / tau) * np.sin(2 * np.pi * f * t + phi)
        else:
            A, f, phi = q
            out += A * np.sin(2 * np.pi * f * t + phi)
    return out


def main():
    sys.path.insert(0, sys.argv[1])
    from core import curve_fit as cf

    OUT.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(11)

    # ── desktop fit_curve, one sinusoid and damped ──
    desktop = []
    cases = [
        ("sinusoid", lambda t: 1.2 * np.sin(2 * np.pi * 0.8 * t + 0.4) + 0.1, 0.3, 4.7, 90, 0.05),
        ("sinusoid", lambda t: 0.6 * np.sin(2 * np.pi * 1.6 * t - 1.0) - 0.2, 0.0, 5.0, 140, 0.08),
        ("damped_sinusoid", lambda t: 1.5 * np.exp(-t / 3.0) * np.sin(2 * np.pi * 0.9 * t + 0.2) + 0.05, 0.2, 4.8, 120, 0.04),
        ("sinusoid", lambda t: 2.0 * np.sin(2 * np.pi * 0.35 * t + 2.0), 0.5, 9.5, 160, 0.1),
    ]
    for model, fn, t0, t1, n, jit in cases:
        pts = hand_trace(rng, fn, t0, t1, n, jit)
        t, v = cf.clean_trace(pts)
        r = cf.fit_curve(pts.tolist(), model)
        desktop.append({
            "model": model, "points": pts.tolist(), "clean_t": t.tolist(), "clean_v": v.tolist(),
            "ok": r.ok, "params": list(r.params), "equation": r.equation, "param_text": r.param_text,
            "r_squared": r.r_squared, "physics": r.physics, "message": r.message,
            "guess": list(cf._sinusoid_guess(t, v)),
        })
    # Too few points: the message
    few = cf.fit_curve([(0.1, 0.2), (0.2, 0.3)], "damped_sinusoid")
    desktop.append({"model": "damped_sinusoid", "points": [[0.1, 0.2], [0.2, 0.3]], "ok": few.ok, "message": few.message})

    # ── snap_to_peak ──
    spec = rng.normal(-60, 3, (64, 40))
    for c in range(40):
        spec[32 + int(10 * np.sin(c / 6)), c] = -5        # a ridge
    spec[10:20, 5] = -1                                    # a flat-topped tie
    pts = [(c * 0.125 + rng.uniform(-0.05, 0.05), (int(10 * np.sin(c / 6)) + rng.integers(-6, 7)) * 0.2) for c in range(40)]
    pts.append((5 * 0.125, (14 - 32) * 0.2))
    snapped = cf.snap_to_peak(pts, spec, 0.125, 0.2)

    # ── _g formatting ──
    values = [0.0, 1.0, -1.0, 0.123456, 12.3456, 123.456, 1234.5, 0.0001234, 0.00001234, 1e-5, 99950, 0.9996, -0.000456, 6.19405905, 1e7, 2.5e-7]
    g = [cf._g(x) for x in values]

    # ── scipy on sums of sinusoids from fixed starting points ──
    sums = []
    for damped, true, p0, t1 in [
        (False, [1.0, 0.7, 0.3, 0.4, 2.1, -0.5, 0.05], [0.9, 0.65, 0.0, 0.3, 2.0, 0.0, 0.0], 6.0),
        (False, [0.8, 0.5, 1.0, 0.5, 1.3, 0.2, 0.3, 2.9, -1.0, -0.1], [0.7, 0.48, 0.8, 0.4, 1.25, 0.0, 0.2, 2.95, -0.8, 0.0], 8.0),
        (True, [1.2, 4.0, 0.8, 0.1, 0.5, 2.0, 1.9, 0.6, 0.0], [1.0, 3.0, 0.78, 0.0, 0.4, 3.0, 1.85, 0.4, 0.0], 6.0),
    ]:
        t = np.sort(rng.uniform(0, t1, 220))
        v = multi(t, *true, damped=damped) + rng.normal(0, 0.04, t.size)
        m = 4 if damped else 3
        k = (len(true) - 1) // m
        lower = [-np.inf] * len(true)
        for j in range(k):
            if damped:
                lower[j * m + 1] = 1e-6
                lower[j * m + 2] = 0.0
            else:
                lower[j * m + 1] = 0.0
        p, _ = curve_fit(lambda x, *q: multi(x, *q, damped=damped), t, v, p0=p0, bounds=(lower, [np.inf] * len(true)))
        sums.append({"damped": damped, "k": k, "true": true, "p0": p0, "t": t.tolist(), "v": v.tolist(), "params": p.tolist()})

    (OUT / "curvefit.json").write_text(json.dumps({
        "desktop": desktop,
        "snap": {"spec": spec.tolist(), "points": [list(p) for p in pts], "snapped": [list(p) for p in snapped]},
        "g": {"values": values, "out": g},
        "sums": sums,
    }))
    print("wrote", OUT / "curvefit.json")


if __name__ == "__main__":
    main()
