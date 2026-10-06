# Fit a curve to a motion (Curve Fit tab)

The Curve Fit tab works like the SensDSv2 desktop Curve Fit tab, with the team's feedback applied:
the spectrogram shows -3 to 3 m/s, the time axis can be set and adjusted, Polynomial and Linear are
gone, and up to four sinusoids can be fitted at once.

A Newton's cradle or pendulum swinging toward and away from the radar draws a sinusoid. Its fitted
frequency predicts the pendulum's length, which students can check with a ruler.

1. Connect the radar and open **Curve Fit**. The live spectrogram scrolls, newest on the right.
2. **Time window** (2 to 30 s) sets how much history the plot holds. Changing it clears the picture.
3. Start the motion, then press **Freeze**. The frozen window is redrawn the reference script's way
   (the same picture the Collect tab saves), and the heading says "(reference script)".
4. Adjust the time axis if you like: type **From** and **To**, scroll on the plot to zoom, drag to
   pan, **Reset** to show everything.
5. **Start Trace** and drag along the bright ridge. **Clear Trace** starts again. With **Snap to
   strongest signal** on, each point moves onto the brightest bin within 20 bins before fitting.
6. Choose **Sinusoid** or **Damped sinusoid** and the **Number of sinusoids** (1 to 4). Each curve
   has an optional **starting frequency** in Hz; leave it blank to let the fit find it.
7. **Fit Curve** (needs 10 traced points). The lower plot shows the traced points and the fitted
   curve; the readout gives the equation, every parameter, R², and for each curve its frequency,
   period and the length of a simple pendulum that would swing at that frequency.
8. **Resume** goes back to live.

How the fit matches the desktop: with one sinusoid the model, starting guess, bounds and text are the
desktop's, and the fitted curve matches scipy's (tests/curvefit.test.js). The web version also tries
a second start from the trace's strongest frequency and keeps the better fit, because hand jitter can
push the desktop's zero-crossing guess onto a poor fit. With several sinusoids the frequencies are
found one at a time and then fitted together; lowest frequency is listed first.
