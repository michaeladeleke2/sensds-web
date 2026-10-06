# Check browser frames against the Python reference (Step 2 validation)

The reference is `tests/fixtures/radar/python_frames.npy`, 20 frames the
Python SDK captured during the register export. Use the same still scene.

1. Put the radar in the same place, facing the same still scene, as during the export. Nobody moving in front of it.
2. Start the local server and open the page (see `run_visualization.md`).
3. Click **Connect Radar** and wait until the status shows "Radar streaming".
4. Open the browser console: View, Developer, JavaScript Console (Mac: Cmd+Option+J; Windows: Ctrl+Shift+J).
5. Type `sensds.saveFrames(20)` and press Enter. After 2 seconds Chrome saves `browser_frames_20.npy` to Downloads.
6. In Terminal: `cd ~/sensds-web && node scripts/compare_frames.mjs ~/Downloads/browser_frames_20.npy tests/fixtures/radar/python_frames.npy`
7. Pass: means within a few thousandths per antenna, similar std, average chirp correlation near 1, all values within [-1, 1].
8. Record the result for the device in the table in `docs/SENSDS_WEB_HANDOFF.md`.
