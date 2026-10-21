# Fit a curve to a motion (Curve Fit tab)

The Curve Fit tab works like the SensDSv2 desktop Curve Fit tab, with the team's feedback applied:
the spectrogram shows -3 to 3 m/s, the time axis can be set and adjusted, Polynomial and Linear are
gone, up to four sinusoids can be fitted at once, there is an Exponential model, the curve can come
from the range map as well as the spectrogram, **Auto Fit** finds the curve by itself, and the result
is laid out for students.

A Newton's cradle or pendulum swinging toward and away from the radar draws a sinusoid. Its fitted
frequency predicts the pendulum's length, which students can check with a ruler.

1. Connect the radar and open **Curve Fit**. Under **Picture** choose **Doppler spectrogram
   (speed)** or **Range map (distance)**. The live picture scrolls, newest on the right. For the
   range map, **MTI filter** and **Distance shown** work as on the Visualize tab (and are shared
   with it); narrowing the distance to where the pendulum swings helps Auto Fit.
2. **Time window** (2 to 30 s) sets how much history the plot holds. Changing it clears the picture.
3. Start the motion, then press **Freeze**. A frozen spectrogram is redrawn the reference script's
   way (the same picture the Collect tab saves), and the heading says "(reference script)". The
   range map needs no redraw: the live picture is already range_map_live.py's.
4. Adjust the time axis if you like: type **From** and **To**, scroll on the plot to zoom, drag to
   pan, **Reset** to show everything.
5. **Start Trace** and drag along the bright ridge. **Clear Trace** starts again. With **Snap to
   strongest signal** on, each point moves onto the brightest bin within 20 bins before fitting.
   Or press **Auto Fit** instead: it freezes if needed, finds the strongest signal in every moment of
   the time range shown (on the spectrogram it compares the strongest signal moving toward the radar
   with the strongest moving away, and ignores the still band within 0.1 m/s of zero), marks the
   curve's high ▲ and low ▼ peaks, and fits the chosen model. Moments without a clear signal are
   skipped. Drawing by hand afterwards replaces what Auto Fit found.
6. Choose **Sinusoid**, **Damped sinusoid** or **Exponential** (y = A·e^(k·t) + c: k below zero
   decays toward c, above zero grows). For the sinusoids choose the **Number of sinusoids** (1 to
   4); each curve has an optional **starting frequency** in Hz; leave it blank to let the fit find it.
7. **Fit Curve** (needs 10 traced points). The lower plot shows the points, the fitted curve and the
   peaks. The panel beside it shows:
   - how good the fit is (Excellent, Good, Fair or Poor, with R²),
   - the model's general equation and the same equation with the fitted numbers,
   - a card for every letter (A, f, φ, τ, k, c) with its name, value, unit and what it means,
   - what the fit tells you: period and simple-pendulum length for each sinusoid, or time constant
     and half-life (doubling time) for an exponential,
   - what the peaks show: how many, the time from a high peak to the next low one (half a swing),
     and the height between them.
8. **Resume** goes back to live.

How the fit matches the desktop: with one sinusoid the model, starting guess, bounds and text are the
desktop's, and the fitted curve matches scipy's (tests/curvefit.test.js). The web version also tries
a second start from the trace's strongest frequency and keeps the better fit, because hand jitter can
push the desktop's zero-crossing guess onto a poor fit. With several sinusoids the frequencies are
found one at a time and then fitted together; lowest frequency is listed first. With one sinusoid
the fit also starts from the peaks (frequency from the time between a high and the next low peak,
amplitude and middle from their heights, phase from the first peak, decay time from how the peaks
shrink) and keeps whichever start ends with the smaller error. The exponential starts from the best
rate on a grid (A and c follow from a straight-line fit for each rate) and is then refined.
