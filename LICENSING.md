# Licensing

SensDS Web contains code ported from the Infineon Radar SDK 3.6.5 source.
The parts come under different licences:

| Origin | Licence | Files in this project |
|---|---|---|
| Strata (`external/strata/library`) | Infineon Evaluation Software License (restricted) | `src/transport/link.js`, `src/transport/strata.js`, `src/avian/protocol.js`, `src/avian/device.js` |
| lib_avian (`external/lib_avian`) | BSD 3-Clause (per file headers) | `src/avian/registers.js` |
| Radar SDK device layer (`sdk/c/ifxFmcw`) | BSD 3-Clause (per file headers) | `src/frame/unpack.js`, `src/config.js` (slice size) |
| SensDSv2 reference script (`core/doppler_spectrogram_live.py`) | The project owner's own code | `src/dsp/doppler_live.js`, `src/viz/live_plot.js` |
| scipy (window functions) | BSD 3-Clause | `src/dsp/windows.js` |
| matplotlib (jet colormap, tick placement, image resampling) | Matplotlib License (BSD-style) | `src/viz/jet.js`, `src/viz/ticks.js`, `src/viz/image.js` |
| SensDSv2 Curve Fit, VEX AIM tab, gamification (`core/curve_fit.py`, `ui/vex_aim_tab.py`, `ui/gamification.py`) | The project owner's own code | `src/curvefit/fit.js`, `src/app/curvefit.js`, `src/app/vex.js`, `src/gamification/manager.js`, `src/app/gamification.js` |
| VEX AIM WebSocket client (`vex/aim.py`, `vex/vex_messages.py`, Copyright (c) Innovation First 2025) | MIT | `src/vex/aim_client.js` (the wire format of the commands the tab sends; the copyright notice is kept in its header) |
| SensAV desktop app (`~/SensAV`) | The project owner's own code | Everything under `src/sensav/` and `sensav/index.html` (ported, not copied; SensAV's robot commands use the same VEX AIM `ws_cmd` / `ws_status` endpoints as the MIT client above) |
| torchvision MobileNetV3 Small architecture and ImageNet weights (`mobilenet_v3_small-047dcff4.pth`) | BSD 3-Clause (torchvision). The weights were trained on ImageNet; check the ImageNet terms before any commercial use | `src/sensav/ml/backbone.js` (layer table), `assets/sensav/mobilenet_v3_small.safetensors` (the same numbers as torchvision's file, converted by `reference/python/sensav_convert_mobilenet.py`) |
| PyTorch (`torch.Generator`, `normal_`, Adam, `torch.save` format) | BSD 3-Clause | `src/sensav/ml/torch_random.js`, `src/sensav/ml/trainer.js`, `src/sensav/io/torch_file.js` |
| OpenCV (`INTER_AREA`, `INTER_LINEAR` resize) | Apache 2.0 | `src/sensav/ml/image_ops.js` |
| matplotlib "inferno" colormap | CC0 | `src/sensav/ui/inferno.js` |
| Inter typeface (loaded from Google Fonts by the SensAV page) | SIL Open Font License 1.1 | not stored in this repository |

Every Strata-derived file starts with a `STRATA DERIVED` comment.

## Publishing

Permission to publish the Strata-derived code was granted (confirmed by the
project owner on 2026-10-05). `npm run build` therefore includes the radar
code, and the hosted site can connect to the radar.

The `STRATA DERIVED` comments stay at the top of those files to keep the
attribution and to make them easy to find:

    grep -rl "STRATA DERIVED" src tools

No Infineon source file is copied into this repository. The SDK source is
used only as a read-only reference.
