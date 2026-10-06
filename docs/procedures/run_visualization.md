# Run the Visualize page

## Live radar

1. Plug in the radar board. Close SensDSv2 and any other program using it.
2. Start the local server as in the Mac or Windows steps below and open `http://localhost:8000/` in Chrome or Edge.
3. Click **Connect Radar** and choose the Infineon port in the browser's list.
4. The status line shows "Radar found: BGT60TR13C, firmware 2.9.0", then "Radar streaming" with a frame count. The spectrogram scrolls at 10 frames per second.
5. Click **Disconnect Radar** to stop. The radar is stopped and reset as the SDK does it.

Live radar also works on the hosted site (see `publish_website.md`), but not on the claude.ai link, whose sandbox blocks Web Serial.

## Recordings

The page reproduces the SensDSv2 desktop Visualize tab (Infineon SDK method,
reference script view). Until the live radar path is finished, it plays raw
captures saved by SensDSv2's Collect tab (`sample_NNN_raw.npy`). Real data
only; there is no built-in demo signal.

Requires Chrome or Edge. The page is made of JavaScript modules, which browsers
will not load from a double-clicked file, so it is served from a local web server.

## Mac

1. Open Terminal.
2. `cd ~/sensds-web`
3. `npm start` (a small local server with caching turned off, so the browser always loads the current files)
4. In Chrome, open `http://localhost:8000/`
5. Click **Open recording…** and choose a `sample_NNN_raw.npy`.
6. Press Ctrl+C in Terminal to stop the server when done.

## Windows

1. Open PowerShell.
2. `cd $HOME\sensds-web` (or wherever the folder is)
3. `npm start` (needs Node.js: `winget install OpenJS.NodeJS.LTS`, then reopen PowerShell)
4. In Chrome or Edge, open `http://localhost:8000/`
5. Same as Mac steps 5 and 6.

## Chromebook

A Chromebook cannot easily run a local server. Use the hosted site instead
(see `publish_website.md`).

## Checking the port

`npm test` (needs Node) runs the automated checks, including the comparison of
the DSP and the plot image against the Python reference
(`reference/python/make_viz_fixtures.py`).

## If Connect Radar is grey

- On the claude.ai link or a hosted copy: expected. Live radar only runs from `http://localhost`.
- On localhost: the browser mixed old and new files. Reload with Cmd+Shift+R (Windows: Ctrl+Shift+R). `npm start` turns caching off so this does not recur; the page's status line also says when it did not load completely.
- In Safari or Firefox: Web Serial is not available. Use Chrome or Edge.

