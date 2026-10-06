# Drive a VEX AIM robot with gestures (VEX AIM tab)

The VEX AIM tab works like the SensDSv2 desktop VEX AIM tab: the same commands, timings, threshold,
prediction cache and log messages.

Before you start:
- Load the model first, while the computer still has internet. The robot's WiFi has no internet,
  and the model needs it once to start (the app downloads its maths library).
- Connect the radar.

1. **Load Model**: pick the trained model folder (models/<name>_vN), as in the Test tab.
2. Join the robot's WiFi (a network named VEX-AIM-…) in your computer's WiFi settings.
3. Type the robot's IP address (192.168.4.1 in its own WiFi mode) and press **Connect**.
   Chrome asks to let the site look for and connect to devices on your local network: choose
   **Allow**. The status turns green when the robot answers.
4. Pick a mode:
   - **Single Command**: press Start, do a gesture within the capture time; the robot acts once.
   - **RoboSoccer**: the robot rolls forward on its own. Swipe left or right to turn 30 degrees,
     push to kick, idle to keep going. After a command the gesture bar shows a 3 s wait.
5. **Confidence Threshold**: the robot only acts when the model is at least this sure.
6. **Stop** stops the robot. Leaving the tab also stops it. If the robot powers off, the tab
   notices after five failed drive commands and stops safely.

If Connect fails on the website with the robot on and the computer on its WiFi:
- Click the icon left of the address bar, open Site settings, set **Local network access** to
  **Allow**, reload, and Connect again.
- Or run the app on the computer (`npm start`, then http://localhost:8765).

Checked so far: the commands match the desktop byte for byte against a simulated robot
(tests/vex_badges.test.js), and Chrome 154 on the published https site opened a ws:// connection
to a device on the local network once local network access was allowed. Not yet run with a real
robot.
