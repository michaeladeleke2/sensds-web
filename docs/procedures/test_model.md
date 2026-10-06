# Test a trained model (Test tab)

The Test tab works like the SensDSv2 desktop Test tab: the same three modes, the
same timings, thresholds and messages, and the same input to the model (the
training image of the last 3 seconds of radar, as the Collect tab saves it).
Chrome or Edge on a computer, with the radar connected.

## Steps

1. Open the site, click **Connect Radar**, then the **Test** tab.
2. Click **Load Model** and choose a trained model folder: `models/<students>_vN` in your data folder
   (its `model` folder also works). Models trained by the desktop app load too, if saved as
   `model.safetensors` (the default since transformers 4.35).
3. The classes appear under the model name.
4. Pick a mode:
   - **Try a Gesture**: set the capture duration (3 s is what the model was trained on), click
     **Capture & Predict**, do the gesture. The prediction, its confidence and every class's bar
     appear; the robot moves; answer "What gesture did you actually perform?".
   - **RoboSoccer**: set the confidence threshold (0.6), click **Start RoboSoccer**. The robot drives
     on its own; swipe left / right to turn 30°, push for a speed burst. The bar above the bottom
     panels says when to gesture (green), when the model is reading (blue) and when to wait (orange).
   - **Maze Game**: pick a difficulty, set the minimum confidence (0.55), click **Start Maze**.
     Swipe to turn, push to move forward, reach the star.
5. Leaving the Test tab stops a running game.

## What matches the desktop

- Model input: last 30 frames (at least 10), reference spectrogram, 400 x 300 training image, the
  model's own image processor settings, softmax.
- RoboSoccer: a prediction every 20 ticks (33 ms); 4 s cooldown after a gesture, 3 s after idle or
  low confidence; the frame buffer is cleared after each; a confident result (80%+) is reused for
  2 ticks. Maze: every 45 ticks on the last 50 frames.
- Minimum gap between predictions: 0.3 s with a GPU, 1.5 s on CPU.
- The difficulty buttons read 4×5 / 5×7 / 7×9 but build 3×4 / 4×5 / 5×7 mazes; this is the desktop's
  own behaviour and is kept as it is.

## What differs

- The image is resized with Pillow's bilinear filter, as the training images were. transformers 5
  resizes with torchvision, which can differ by 1/255 on some pixels (and between computers);
  confidences agree to within about 0.002.
- Models saved in the older PyTorch `.bin` format cannot be read in the browser; retrain them.
- The gamification badges of the desktop are not ported yet.
