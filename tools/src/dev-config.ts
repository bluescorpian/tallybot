/**
 * The dev entries' default state path (`sidecar-fake-main.ts`, `sidecar-dev-cli.ts`): a tmpdir
 * directory kept separate from production state, so dev assignments never clobber a real config.
 * Its own directory, because `sidecar.log` is written beside it (`app/sidecar/src/config.ts`).
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEV_STATE_FILE = join(tmpdir(), "tallybot-dev", "state.json");
