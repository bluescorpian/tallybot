/**
 * The sidecar's runtime configuration: where its state and diagnostic log live.
 *
 * Every entry (production `main.ts`, the `cargo tauri dev` fake-ATEM entry and the REPL in
 * `tools/`) resolves these through {@link loadRuntimeConfig}, so the override rules and the
 * log's placement are decided once; an entry only supplies its own default state path. The
 * environment contract is documented in `app/sidecar/README.md` ("Runtime configuration").
 */

import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export interface RuntimeConfig {
  /** The persisted config (`ConfigStore`). */
  stateFile: string;
  /** The rotating diagnostic log, always beside the state file. */
  logFile: string;
}

/** The environment variable that overrides the state path (the Tauri shell sets it). */
export const STATE_FILE_ENV = "TALLYBOT_STATE_FILE";

/** The log's name in the state file's directory; the packaged app's lands in the OS app-config dir. */
export const LOG_FILE_NAME = "sidecar.log";

/**
 * Resolve the runtime config. A non-empty `TALLYBOT_STATE_FILE` wins; otherwise `defaultStateFile`
 * (the entry's own default). An empty value counts as unset, so `TALLYBOT_STATE_FILE=` can never
 * point the store at the working directory.
 */
export function loadRuntimeConfig(env: NodeJS.ProcessEnv, defaultStateFile: string): RuntimeConfig {
  const stateFile = env[STATE_FILE_ENV] || defaultStateFile;
  return { stateFile, logFile: join(dirname(stateFile), LOG_FILE_NAME) };
}

/**
 * The production default for a standalone run (no shell to set the override): the XDG state dir,
 * `$XDG_STATE_HOME/tallybot/state.json`, falling back to `~/.local/state` when the variable is
 * unset, empty or relative (the XDG spec says to ignore a relative path).
 */
export function xdgStateFile(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const xdg = env["XDG_STATE_HOME"];
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "state");
  return join(base, "tallybot", "state.json");
}
