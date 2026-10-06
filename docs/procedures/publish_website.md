# The hosted site

The site is hosted free on GitHub Pages, over HTTPS (which Web Serial needs):

**https://michaeladeleke2.github.io/sensds-web/**

Repository: https://github.com/michaeladeleke2/sensds-web (public)

## How it updates

Every push to `main` runs `.github/workflows/pages.yml`: it runs `npm test`,
then `npm run build`, and deploys `dist/`. If a test fails, nothing is deployed.
Progress: the repository's **Actions** tab. A deploy takes about a minute.

1. Make the change and commit it.
2. `git push`
3. Wait for the green check on the Actions tab, then reload the site.

## Use it on a laptop (Mac, Windows, Chromebook)

1. Plug in the radar board by USB. Close SensDSv2 if it is open.
2. Open https://michaeladeleke2.github.io/sensds-web/ in Chrome or Edge.
3. Click **Connect Radar** and choose the Infineon port.
4. The status shows "Radar streaming" and the spectrogram scrolls.
5. Click **Disconnect Radar** when done.

Safari, Firefox, iPhone and iPad have no Web Serial, so they can only play recordings.

## What gets published

`npm run build` copies only the files the page loads (19 files) into `dist/`.
Publishing the Strata-derived files is permitted (see `LICENSING.md`).
