// Tauri doesn't have a Node.js server to do proper SSR
// so we use adapter-static with a fallback to index.html to put the site in SPA mode
// See: https://svelte.dev/docs/kit/single-page-apps
// See: https://v2.tauri.app/start/frontend/sveltekit/ for more info
import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      fallback: "index.html",
    }),
    alias: {
      // The sidecar's shared contracts, imported straight from its source so the two
      // ends can't drift: the UI↔sidecar IPC schema and codec, and the device
      // protocol (for the version Settings → About reports). Both are plain TS with
      // no Node imports, so they bundle for the browser.
      $ipc: "sidecar/src/ipc.ts",
      $protocol: "sidecar/src/protocol.ts",
    },
  },
};

export default config;
