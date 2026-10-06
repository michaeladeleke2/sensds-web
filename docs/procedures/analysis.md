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
6. Hover a point to see its sample; click it to see its spectrogram picture and its four measurements
   on the right (the two on the plot are highlighted).
7. Scroll to zoom, drag to pan, or use the −, + and Reset buttons.
8. **Summary CSV** saves one row per sample; **Frames CSV** saves one row per radar frame.
   The save dialog opens in `<data folder>/exports`. Open the files in CODAP.

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
