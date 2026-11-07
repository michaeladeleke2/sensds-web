# Test a trained model (Test tab)

The Test tab works like the SensDSv2 desktop Test tab: the same three modes, the
same timings, thresholds and messages, and the same input to the model (the
training image of the last 3 seconds of radar, as the Collect tab saves it).
Chrome or Edge on a computer, with the radar connected.

## Steps

1. Open the site, click **Connect Radar**, then the **Test** tab.
2. The **starter model** loads by itself: a six-gesture model (idle, push, swipe down, swipe left,
   swipe right, swipe up) that comes with SensDS, so students can play before training their own.
   The first time it downloads (about 165 MB, progress under the buttons); after that it loads from
   the browser, without internet. **Use Starter Model** loads it again after another model.
   To use your own, click **Load Model** and choose a trained model folder: `models/<students>_vN`
   in your data folder (its `model` folder also works). Models trained by the desktop app load too,
   if saved as `model.safetensors` (the default since transformers 4.35).
3. The classes appear under the model name.
4. Pick a mode:
   - **Try a Gesture**: set the capture duration (the same as the Collect samples, 3 s by default), click
     **Capture & Predict**, do the gesture. The prediction, its confidence and every class's bar
     appear; the robot moves; answer "What gesture did you actually perform?".
   - **RoboSoccer**: set the confidence threshold (0.6), click **Start RoboSoccer**. The robot drives
     on its own; swipe left / right to turn 30°, push for a speed burst. The bar above the bottom
     panels says when to gesture (green), when the model is reading (blue) and when to wait (orange).
   - **Maze Game**: under **Gesture Controls**, choose what each gesture of the model does: Move
     forward, Turn left, Turn right, Turn around or Do nothing. They start as swipe left / right
     turn, push and swipe up move forward, swipe down turns around, idle does nothing; the browser
     remembers changes for that model's set of gestures. Pick a difficulty, set the minimum
     confidence (0.55), click **Start Maze**, and reach the star. Each move starts with a countdown
     (3, 2, 1, shown big over the maze and in the bar); at **GO!** do one gesture: the next 20 frames
     (2 s) are captured, the model reads them, the robot moves, and the next countdown starts.
5. Leaving the Test tab stops a running game.

## What matches the desktop

- Model input: reference spectrogram, 400 x 300 training image, the model's own image processor
  settings, softmax. Changed with the desktop (team feedback): the model sees as many frames as the
  Collect tab records for a sample (round(duration / 0.15): 20 for "3 s", about 2 s of radar, which
  is also what the starter model was trained on), where both used to take the last 30.
- RoboSoccer: a prediction every 20 ticks (33 ms); 4 s cooldown after a gesture, 3 s after idle or
  low confidence; the frame buffer is cleared after each; a confident result (80%+) is reused for
  2 ticks. Maze (changed with the desktop, team feedback): a 3 s countdown, then the next 20 frames
  from GO!, instead of a check every 45 ticks on whatever the last 3 s held.
- Minimum gap between predictions: 0.3 s with a GPU, 1.5 s on CPU.
- The difficulty buttons read 4×5 / 5×7 / 7×9 but build 3×4 / 4×5 / 5×7 mazes; this is the desktop's
  own behaviour and is kept as it is.

## What differs

- The image is resized with Pillow's bilinear filter, as the training images were. transformers 5
  resizes with torchvision, which can differ by 1/255 on some pixels (and between computers);
  confidences agree to within about 0.002.
- Models saved in the older PyTorch `.bin` format cannot be read in the browser; retrain them.
- The gamification badges of the desktop are not ported yet.

## The starter model

- `assets/models/six_class/`: `model_hf_phGAN_doppler_spectrogram_six_class` (ViT-Base, trained
  2026-08-19), its weights stored as float16 in four parts under GitHub's file size limit, listed with
  sizes and checksums in `manifest.json`. On 136 recorded samples the float16 copy gives the same
  prediction as the float32 original every time (largest probability change 0.00006), and the web
  inference matches PyTorch to 0.00001.
- It is a ViT-Base (86 million parameters), four times the size of the Small models the Train tab
  makes by default, so it needs a browser that can use the graphics card (WebGPU or WebGL); on CPU
  alone a prediction takes close to a minute.
- It keeps its own browser cache (`sensds-starter-model-<id>`), outside the site's offline cache, so a
  new deploy does not download it again.
- How well it recognises gestures has not been confirmed with the current radar settings. On 136
  samples recorded here with the earlier 0.2 ms chirp (idle, push, swipe left) it got idle right and
  called most pushes and swipe lefts swipe up (32% correct); drawn the way the app draws them today,
  4%. The capture length made no difference (1 to 5 s). Its training folder name (phGAN) suggests it
  was trained on spectrograms drawn by a different program, partly generated by a GAN, so they may
  not look like the pictures this app makes. Retraining it on samples collected with the app would
  fix that.
- **Previous spectrogram (starter model)**, under the classes: the starter model was trained on
  spectrograms drawn before the October change note, so with it on the model is shown that drawing:
  the previous range bin rule, the previous colour scale (floor -20 dB, or 40 dB below the loudest
  cell), and each column stretched by 1.5 back onto the speed range of the previous 0.2 ms chirp
  (speeds the 0.3 ms chirp cannot see are filled with the column's background level). The radar
  settings and the other tabs do not change. It turns on when the starter model loads and off when
  a student's model loads, and can be switched by hand (`src/test/previous_picture.js`; the desktop's
  `core/previous_picture.py` draws the same picture byte for byte). With the previous chirp the
  drawing is byte for byte what SensDS made before the change. The stretch could not yet be checked
  on recordings made with the new chirp.
- What the model sees: as many frames as a Collect sample of the same duration (20 for "3 s", about
  2 s of radar; the starter model's training pictures were 20 frames too). **Try a Gesture** captures
  that many after the click; the **Maze** counts down and captures 20 from GO!, so the whole gesture
  is in the picture; RoboSoccer reads the last 20.
