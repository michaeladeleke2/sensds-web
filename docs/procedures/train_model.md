# Train a gesture model (Train tab)

The Train tab fine-tunes the same Vision Transformer the SensDSv2 desktop
trains, with the same settings, and saves it in the same Hugging Face format,
so the desktop app can load a model trained here.

Needs Chrome or Edge on a computer. Training uses the graphics processor
(WebGPU) when the browser has it; without it, training falls back to the much
slower CPU. The first training (or "Download Model") needs internet to fetch the
base model from Hugging Face (88 MB for Small, 346 MB for Base); after that it is
kept in the browser.

## Steps

1. Open the site and click the **Train** tab.
2. If it says "Choose the folder your samples are saved in", click **Choose Data Folder** and pick the
   folder the Collect tab saves into (for example `SensDSv2_data`), then **Refresh** and allow access.
3. Under **Dataset**, keep **All students** or choose **Select students** and tick the ones to use.
4. Check **Dataset Status**: at least 3 gesture classes and 20 samples are needed.
5. Leave **Config** at the defaults (15 epochs, batch size 8, learning rate 0.00002, 1 validation student)
   unless you have a reason to change them.
6. Pick the **Model Size** (Small is recommended for laptops) and click **Download Model (once)**.
7. Click **Start Training**. The log shows the device, the students held out for validation, the
   classes and the sample counts, then one line per epoch. The charts update after every epoch, and
   the timer shows the time left.
8. When it finishes, the model is in `<data folder>/models/<students>_vN/` (folders `model/` with
   `config.json`, `model.safetensors`, `preprocessor_config.json`, and `labels.json`).
9. **Stop** ends training after the current batch; the best epoch so far is still evaluated and saved.

## What matches the desktop

- Base models: `WinKawaks/vit-small-patch16-224` (Small) and `google/vit-base-patch16-224` (Base).
- Validation students: chosen exactly as the desktop does (numpy `default_rng(42)`), so the same students are held out.
- Images: the saved training PNGs, resized with Pillow's bilinear filter (byte-identical); validation images
  exactly as the desktop prepares them.
- Training: AdamW (weight decay 0.01, not on biases or LayerNorm), gradient clipping 1.0, learning rate decaying
  linearly to 0, cross-entropy, the same augmentation (random resized crop, colour jitter, small rotation / shift / zoom).
- Each epoch: validation loss, accuracy and macro F1; the best epoch by F1 is kept, evaluated again and saved.

## What differs

- Two training runs never give identical numbers, here or on the desktop: the random augmentation, the new
  classifier layer's starting values and the GPU arithmetic all vary. Expect similar, not identical, accuracy.
- No per-epoch checkpoint folders are written (the desktop saves one per epoch); only the final best model.
- With only one student, the 80/20 split uses the samples in name order (the desktop uses the order the
  operating system lists them in).
- Stop takes effect after the current batch (the desktop checks every 20 steps).
