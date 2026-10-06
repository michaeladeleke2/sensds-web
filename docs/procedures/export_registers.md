# Export the radar register list (one time)

Run once by a developer. The website never runs Python; it uses the saved
register list. Only needs redoing if the radar configuration changes.

This configures the radar with the Infineon SDK exactly as SensDSv2 does when
you press Connect Radar, captures 20 frames, then closes the radar.

## Before you start

- Radar board plugged in by USB.
- SensDSv2, the Step 1 page and any other program using the radar closed
  (only one program can open the port at a time).
- Point the radar at a still scene (nobody moving in front of it) for the
  reference frames.

## Mac

1. Open Terminal.
2. Create a separate Python environment for the SDK, outside the project:
   `python3 -m venv ~/.venvs/sensds-sdk`
3. Install Infineon Radar SDK 3.6.4 into it (the same wheel SensDSv2 uses):
   `~/.venvs/sensds-sdk/bin/pip install "/Users/michaeladeleke/SensDSv2/inf_wheel/ifxradarsdk-3.6.4+4b4a6245-py3-none-macosx_10_14_universal2.whl"`
4. `cd ~/sensds-web`
5. `~/.venvs/sensds-sdk/bin/python reference/python/export_registers.py`
6. It should print the SDK version (3.6.4), sensor BGT60TR13C, the board ID,
   "Capturing 20 frames", and finish with "Done. The radar has been closed."

## Windows

1. Open PowerShell.
2. `python -m venv $HOME\.venvs\sensds-sdk`
3. `& $HOME\.venvs\sensds-sdk\Scripts\pip install <path to SensDSv2>\vendor\ifxradarsdk-3.6.4+4b4a6245-py3-none-win_amd64.whl`
4. `cd <path to sensds-web>`
5. `& $HOME\.venvs\sensds-sdk\Scripts\python reference\python\export_registers.py`

## What it writes

| File | Purpose |
|---|---|
| `src/avian/registers_tr13c.js` | Register list as data, used by the website |
| `tests/fixtures/radar/registers_sdk364.txt` | The SDK's own export, unchanged |
| `tests/fixtures/radar/python_frames.npy` | 20 reference frames, shape (20, 3, 128, 256) |
| `tests/fixtures/radar/export_info.json` | SDK version, sensor, board, firmware, date |

Options: `--frames 0` skips the frame capture.

## If it fails

- "ifxradarsdk is not installed": step 3 did not succeed, or step 5 used a
  different Python than the one in `~/.venvs/sensds-sdk`.
- A connection or "device not found" error: another program has the port open,
  or the board is unplugged. Close it and run step 5 again.
- "Expected a BGT60TR13C": a different radar is connected. Nothing is exported.
