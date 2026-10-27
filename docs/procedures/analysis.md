# Analyze the dataset (Analysis tab)

The Analysis tab works like the SensDSv2 desktop Analysis tab: the same
features, the same PCA and silhouette scores, the same CSV text. It reads every
`sample_NNN_raw.npy` in the data folder (all students, all gestures). Chrome or
Edge on a computer. The radar does not need to be connected.

## Physical Features

1. Open the site and click the **Analysis** tab, then **Physical Features**.
2. If it says "No data folder chosen", click **Choose Data Folder** and pick the folder
   the Collect tab saves into (for example `SensDSv2_data`). If it asks, allow access.
3. Check the Dataset box: number of raw samples, gestures and students.
4. Click **Extract Features**. A progress bar runs while each sample is processed.
5. Pick the **X axis**, **Y axis** and **Color by** (gesture or student). The plot redraws.
6. Hover a point to see its sample; click it to see it on the right: its **micro-Doppler** and
   **range map**, drawn from the raw recording by the Visualize tab's own plots (the spectrogram at
   ±4.11 m/s with the same colour floor; the range map with the Visualize tab's MTI and distance
   settings), and its five measurements (the two on the plot are highlighted). Click a picture to see
   it large. These replace the training PNG saved at capture time, which could have been drawn with
   older settings.
7. Scroll to zoom, drag to pan, or use the −, + and Reset buttons.
8. **Summary CSV** saves one row per sample; **Frames CSV** saves one row per radar frame.
   The save dialog opens in `<data folder>/exports`. Open the files in CODAP.

### The measurements

| Measurement | What it is |
| --- | --- |
| Distance from radar | Mean distance of the strongest moving return |
| Distance traveled | Farthest minus nearest distance during the gesture |
| Peak speed (toward/away) | Fastest change of that distance between frames |
| Mean speed (toward/away) | Average of that change, ignoring direction |
| Velocity span | Highest velocity in the gesture's micro-Doppler signature minus the lowest |

**Velocity span** (requested by Dr. Hazel) is not mean speed. Mean speed comes from how the tracked
distance changes frame to frame. Velocity span is read off the micro-Doppler: in each frame, the
signature is the Doppler bins at least 15 dB above that frame's noise floor and within 10 dB of its
strongest bin; the span is the highest of those velocities over the whole sample minus the lowest.
Noise never clears the bar, so a still hand gives 0; a push-and-pull, which swings from toward to
away, gives a wide span. On synthetic swings it reads about 0.1 to 0.25 m/s above the true peak to peak
velocity, from the width of the signature in each frame.

The Frames CSV has the per-frame top and bottom of the signature (`vel_upper_ms`, `vel_lower_ms`),
left blank in frames with no signature, so the span can be checked in CODAP.

Doppler velocities depend on the chirp spacing a sample was recorded with. The radar now uses 0.3 ms
(it was 0.2 ms before the visualization change note). The Collect tab writes it into
`capture_info.json` as `chirp_repetition_time_s`, and the Analysis tab reads each folder's value; a
folder without one is read as 0.3 ms. Velocity spans of samples recorded before the chirp change come
out two thirds of their true value, so collect those gestures again. The distance and speed
measurements do not depend on the chirp spacing.

## PCA Comparison

1. Click **PCA Comparison**.
2. The Dataset Status needs at least 6 raw samples and 2 gestures.
3. Click **Run Analysis**.
4. Two plots appear, Doppler domain (spectrogram) and range domain (range FFT), with the share of
   variance on each axis, the silhouette score under each plot, and a summary saying which one
   separates the gestures better.

## Differences from the desktop

- The data folder is chosen once (shared with the Collect tab) instead of always being `~/SensDSv2_data`.
- "Show in Folder" is replaced by the folder path under the measurements (a web page cannot open Finder or Explorer).
- PCA axes can come out mirrored (PC1 or PC2 multiplied by -1) compared with the desktop plot. The sign of a
  principal component is arbitrary in both; the variances, distances and silhouette scores are the same.
