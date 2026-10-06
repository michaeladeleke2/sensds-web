# Put the Visualize page on a website

Always publish the **`dist/` folder**, never the whole project. The project
contains Strata-derived files that may not be published until Infineon's
permission is confirmed (`LICENSING.md`). `npm run build` copies only the files
the page loads into `dist/`, and refuses to build if any of them is Strata
derived.

## 1. Build

1. `cd ~/sensds-web`
2. `npm run build`
3. Check the last line says `no Strata-derived code`.

## 2a. Quick test link: claude.ai artifact (already done)

Published privately at https://claude.ai/artifact/8wbLhvoBgBWfRvqDjM3u2q .
Share it from the page's Share menu. Testers open a `sample_NNN_raw.npy` with
**Open recording…**; the file stays in their browser and is not uploaded.
Limit: the page runs inside claude.ai's sandboxed frame, which most likely
blocks Web Serial, so it is for recordings only.

## 2b. Your own address: Netlify Drop (free, no account needed to try)

1. Run step 1.
2. Open https://app.netlify.com/drop in Chrome.
3. Drag the `dist` folder onto the page.
4. Netlify gives an `https://….netlify.app` address. Open it in Chrome or Edge.
5. To keep the site past one hour, sign up (free) when Netlify asks. To update
   it later, drag the new `dist` folder onto the site's Deploys page.

HTTPS is required for Web Serial, so a site hosted this way is also where live
radar will work, on Mac, Windows and Chromebook, once the radar path is added
and Infineon's permission covers publishing it.

Cloudflare Pages (https://pages.cloudflare.com, "Upload assets") works the same
way with the `dist` folder.

## Avoid

- GitHub Pages from this repository: free GitHub Pages needs a public repo,
  which would publish the Strata-derived source.
- Uploading the project folder instead of `dist/`.
