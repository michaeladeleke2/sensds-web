# Review predictions (Results tab)

The Results tab works like the SensDSv2 desktop Results tab. It collects every
prediction made in the Test tab while the page is open.

1. In the **Test** tab, load a model and make predictions (Try a Gesture, RoboSoccer or the Maze).
   In Try a Gesture, answer "What gesture did you actually perform?" so the prediction can be scored.
2. Open the **Results** tab:
   - The header shows the model, its gestures, and how many predictions were confident (at or above the threshold).
   - **Confusion Matrix**: rows are what you actually did, columns what the model guessed; a dark diagonal is good.
   - **Accuracy per Gesture**: correct / total for each gesture (navy at 70% and above, orange from 40%, red below).
   - **Prediction History**: time, mode, prediction, confidence, actual gesture, and whether it was confident.
3. **Export CSV** saves `results/results_YYYYMMDD_HHMMSS.csv` in your data folder (or your downloads if no
   data folder is chosen). **Clear** empties the history, matrix and bars.
4. Loading another model in the Test tab starts a fresh history, as on the desktop.

Kept as the desktop has it: gestures that RoboSoccer and the Maze acted on count as confirmed in the matrix
and bars (even though the matrix caption says Single Prediction only), and the accuracy legend says green
where the bar is navy. The history lasts until the page is closed, as the desktop's lasts until the app closes.
