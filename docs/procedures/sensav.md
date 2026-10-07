# SensAV in the browser

The SensAV desktop app (camera and microphone classifier that drives a VEX AIM
robot) runs as a second page of this site: `sensav/`, next to SensDS. Click the
logo in the top left of either page to switch between them.

## Use it

1. Open https://michaeladeleke2.github.io/sensds-web/sensav/ in Chrome or Edge.
2. Skip or enter the session ID.
3. Choose where your work is kept:
   - **Choose a folder.** To share projects with the desktop app, pick
     `SensAV_data` in your home folder (`~/SensAV_data` on a Mac,
     `C:\Users\<you>\SensAV_data` on Windows). Chrome asks for permission to
     edit the folder; allow it. Next visit, one click allows it again.
   - **Keep it in this browser.** Projects stay in the browser's private
     storage. Use this on a browser without folder access.
4. Create or open a project. The tabs then work as on the desktop: Collect,
   Train, Test, Robot, Data.

The camera and microphone ask for permission the first time. If a prompt was
dismissed, click the camera icon in the address bar to allow it again.

For the Robot tab, join the robot's WiFi first. When Chrome asks to let the
site find devices on the local network, choose Allow. Type `simulated` as the
address to try driving without a robot.

## What matches the desktop, and how it was checked

`reference/python/make_sensav_fixtures.py` runs SensAV's own Python code (read
only, at development time) and saves its outputs. The tests in
`tests/sensav_*.test.js` compare the JavaScript ports against those outputs.

| Part | Result |
|---|---|
| Centre-square crop (`cv2.resize` INTER_AREA) at 640x480, 1280x720 and portrait frames | Byte for byte |
| Clip picture: 64-band log-mel spectrogram, `cv2.resize` INTER_LINEAR, 8-bit | Pixel for pixel. Mel values agree to 4e-6 dB |
| Resampler (48 kHz and 44.1 kHz to 16 kHz, in chunks) and WAV reading | Agree to 6e-8 |
| WAV files written | Byte for byte |
| MobileNetV3 Small backbone (TensorFlow.js) | Agrees with torchvision to 8e-6 on values up to 4.2 |
| `torch.Generator` normal draws and the head's starting weights | Bit for bit (at most 7e-9) |
| Per-class split and dataset order (numpy `default_rng(1234)`) | Identical |
| Training: 12 epochs of Adam, batches of 16 | Same accuracy every epoch, same confusion matrix. Losses agree to 1e-4; weights to 6e-6 |
| CSV features (brightness and colour; loudness, peak frequency, spectral centroid) | Identical after rounding |
| PCA columns | Agree to 7e-5. The sign of each component can be flipped (numpy's SVD picks one) |
| Robot safety gate and driver | SensAV's own robot tests, ported, pass |
| `model.pt`, `embeddings.npz`, `.sensavmodel`, `project.json`, research log | Desktop files are read by the web app. Web files load with `torch.load(weights_only=True)`, `np.load` and SensAV's `Project.load`, `load_head` and `read_events` |

End to end in headless Chrome, with Chrome's fake camera and microphone (2026-10-07):
- **Image flow.** 51 samples were collected. Training took 0.3 s, then the
  model tested live at about 10 predictions a second, 22 ms each.
- **Audio flow.** 20 Background Noise clips and 9 clips of a second class were
  collected. Training reached 100%, and the model tested live at 4
  predictions a second.
- **Robot.** Driving the simulated robot worked, and the space bar stopped it.
- **Web project in the desktop code.** A project made in the browser, copied
  out of browser storage, loaded with the desktop code. The browser's stored
  embeddings matched the desktop backbone's own embeddings of the same saved
  JPEG and WAV files to one float16 step (0.001).
- **Desktop project in the web app.** A project made with the desktop code,
  with samples, embeddings and a trained model, opened in the browser. Its
  model showed as up to date, and it retrained there.

Not yet tried: a real webcam and microphone (only Chrome's fake devices so
far), a real VEX AIM robot, and the Surface.

## Differences from the desktop

- **Settings.** The theme, last project, robot address, devices and timed
  capture settings are kept in the browser, not in `settings.json`.
- **Saved files.** Saving a CSV or a model opens the browser's save dialog;
  the desktop opens the exports folder.
- **Camera resolution.** The camera is asked for 640x480. OpenCV's default
  can differ per camera, but only the centre square is used.
- **JPEG files.** Samples are encoded at quality 90 by Chrome, not by
  OpenCV, so the files are not byte-identical. They decode the same way in
  both apps.
- **Starting weights on Intel and AMD PCs.** PyTorch draws its starting
  weights with a vectorised kernel on processors with AVX2, so the last bits
  of the desktop's starting weights can differ from the web app's (and from
  a Mac's). Training results agree to rounding either way.
