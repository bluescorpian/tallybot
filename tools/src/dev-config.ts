/**
 * The dev entries' default state path (`sidecar-fake-main.ts`, `sidecar-dev-cli.ts`): a tmpdir
 * directory kept separate from production state, so dev assignments never clobber a real config.
 * Its own directory, because `sidecar.log` is written beside it (`app/sidecar/src/config.ts`).
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEV_STATE_FILE = join(tmpdir(), "tallybot-dev", "state.json");

/**
 * How many mix effects the dev entries' fake ATEM models: `TALLYBOT_DEV_MES` (default 1, an ATEM
 * Mini). Set it to 2 or more to work on multi-ME behaviour, e.g. `TALLYBOT_DEV_MES=2 cargo tauri dev`.
 */
export function devMixEffectCount(env: NodeJS.ProcessEnv): number {
  const raw = env["TALLYBOT_DEV_MES"];
  if (raw === undefined || raw === "") return 1;
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1) throw new RangeError(`TALLYBOT_DEV_MES must be a positive integer, got "${raw}"`);
  return count;
}
