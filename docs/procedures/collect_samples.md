# Collect gesture samples

The Collect tab works like the SensDSv2 desktop Collect tab (Infineon SDK
method): same countdown, same frame count, same spectrogram, same files.
Chrome or Edge on a computer (Mac, Windows, Chromebook).

## Steps

1. Plug in the radar. Close SensDSv2 if it is open.
2. Open the site (https://michaeladeleke2.github.io/sensds-web/ or `npm start` locally) and click **Connect Radar**.
3. Click the **Collect** tab.
4. Click **Choose Data Folder** (bottom right) and pick the folder to save into. To add to the
   desktop app's dataset, pick `SensDSv2_data` in your home folder. Chrome asks to allow
   saving changes; click **Allow**. The choice is remembered in this browser.
5. Type the **Student Name** and pick or type a **Gesture Label**.
6. Set **# Samples** (1 to 100), **Duration (s)** (1 to 10) and **Delay Between Samples (s)** (1 to 10).
7. Click **Start Batch Collection**. For each sample: "Get ready... 3, 2, 1", then
   "Perform your gesture NOW!", then "Sample N saved." with the picture on the right.
8. Click **Stop** to end early. Samples already saved are kept.

## What is saved

In `<data folder>/<student name>/<gesture label>/`, per sample, the same three files the desktop writes:

| File | Content |
|---|---|
| `sample_NNN.npy` | Spectrogram, float64, (frames, 512), from the reference script's `compute_recorded` |
| `sample_NNN_raw.npy` | Raw radar frames, float32, (frames, 3, 128, 256) |
| `sample_NNN.png` | Training image: the reference drawing, 400 x 300, RGB |

plus `capture_info.json` (method, colour floor, date). Numbering continues from the
highest sample already in the folder.

## Things that match the desktop on purpose

- Frames per sample = round(duration / 0.15), so "3 s" is 20 frames (2 s of radar at
  10 frames per second). This is SensDSv2's own rule; kept so web and desktop samples
  have the same size.
- A sample that does not get its frames within 3 x duration is skipped.
- Reduce noise is shared with the Visualize tab and changes the saved PNGs. Keep it
  the same for a whole dataset; the tab warns if a folder's samples were made differently.

## Differences from the desktop

- You choose the data folder once instead of it always being `~/SensDSv2_data`.
- **Choose Data Folder** replaces **Open Data Folder** (a web page cannot open Finder or Explorer).
- The progress bar counts this batch (the desktop's counts from the folder's highest sample number).
- Start asks you to connect the radar first instead of waiting with no data.
