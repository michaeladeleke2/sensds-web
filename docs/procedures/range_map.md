# Range map (Visualize tab)

The Visualize tab's **View** choice switches between the Doppler spectrogram and
the **Range map**: how far away things are (0 to 3.48 m, 512 range bins) over
time. It is a port of two scripts, kept unchanged in `reference/python/`:

- `range_map_live.py`: the live view. The radar, or a recording played at 10
  frames a second, scrolls by with the newest frame on the right.
- `range_map_v1.py`: a whole recording as one image. Open a recording, then set
  **Recordings** to **Whole recording at once**.

Both use antenna 0. Live, the web app reads antenna 0 from the radar's
three-antenna stream, so the sensor setup stays as it is (the script streams
only the chosen antenna). The chirp is the same: 58 to 63.5 GHz, 2 MHz, 256
samples, 128 chirps, 0.1 s frames.

The time window slider sets the live history (10 frames a second), and
**Reduce noise** sets the colour floor (jet_vmin) to -50 dB instead of -20 dB,
as in the Doppler view.

## MTI

MTI (moving targets only: Doppler power without the zero-velocity bin) is off
by default; the map then shows the mean range-FFT magnitude, so walls and other
still objects stay visible. It is not in the page's controls. To change it:

- for everyone: set `mode: 'mti'` in `RANGE_MAP` in `src/config.js`;
- for one visit: add `?range_mode=mti` to the page address (`?range_mode=raw`
  turns it off again).

The readout under the panel shows which mode is in use.

## Checked against the scripts

`reference/python/make_range_map_fixtures.py` runs both scripts on the 20 real
radar frames in `tests/fixtures/radar/python_frames.npy`. `tests/range_map.test.js`
compares the windows, range axis, every frame's profile (raw and MTI) and the
live processor's rolling history: all agree to 1e-12 dB. The figures were
compared by eye with the scripts' own matplotlib output (same data, colour
limits, axes, grid and colour bar).
