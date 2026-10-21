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
only the chosen antenna). The scripts assume 2 MHz sampling, the radar now
samples at 1 MHz; the sample rate cancels out of the range axis, so 0 to 3.48 m
holds for both.

The time window slider sets the live history (10 frames a second), and
**Reduce noise** sets the colour floor (jet_vmin), as in the Doppler view.

## Distance shown

**Distance shown (Y)** sets the part of the range axis that is drawn: **From**
and **To** in metres (0 to 3.48 m), **Reset** for all of it. Only the range bins
inside it are drawn and the colours are scaled to them, so a strong still
object outside the window (the table the radar sits on, a wall) no longer
washes out the target.

## MTI

**MTI filter (show only moving things)** turns MTI on and off. MTI keeps the
Doppler power without the zero-velocity bin, so only moving targets show.
Off, the map shows the mean range-FFT magnitude, and walls and other still
objects stay visible. Changing it restarts the picture.

MTI starts off. The starting value can still be changed:

- for everyone: set `mode: 'mti'` in `RANGE_MAP` in `src/config.js`;
- for one visit: add `?range_mode=mti` to the page address (`?range_mode=raw`
  turns it off again).

The browser remembers the checkbox (and the distance) for next time; a
remembered choice wins over `src/config.js`, and `?range_mode=` in the address
wins over both. Both settings are shared with the range map on the Curve Fit tab.
The readout under the panel shows the mode and the distance in use.

## Checked against the scripts

`reference/python/make_range_map_fixtures.py` runs both scripts on the 20 real
radar frames in `tests/fixtures/radar/python_frames.npy`. `tests/range_map.test.js`
compares the windows, range axis, every frame's profile (raw and MTI) and the
live processor's rolling history: all agree to 1e-12 dB. The figures were
compared by eye with the scripts' own matplotlib output (same data, colour
limits, axes, grid and colour bar).
