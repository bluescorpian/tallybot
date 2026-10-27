/**
 * The project's public addresses, named once for the UI.
 *
 * The repo must match the updater endpoint in `src-tauri/tauri.conf.json`, which the shell derives
 * its release-page links from (`updater.rs`); `scripts/check-release.mjs` checks the two agree.
 */

/** The GitHub repository. */
export const REPO_URL = "https://github.com/bluescorpian/tallybot";

/** The releases page; a release's own page is `${RELEASES_URL}/tag/v<version>`. */
export const RELEASES_URL = `${REPO_URL}/releases`;

/** The project licence, as rendered on GitHub. */
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE.md`;

/** The web flasher (`flasher/`, deployed to GitHub Pages by `.github/workflows/pages.yml`). */
export const FLASHER_URL = "https://tally.hrry.sh";
