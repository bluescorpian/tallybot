// Lets `node --test` load the app's plain TS modules as written: they import each other without
// a file extension (Vite resolves those), which Node's ESM loader won't. This hook retries an
// unresolved relative import with `.ts`. Loaded with `--import`; the hook itself runs off-thread.
import { register } from "node:module";
import { isMainThread } from "node:worker_threads";

if (isMainThread) register(import.meta.url);

export async function resolve(specifier, context, next) {
	try {
		return await next(specifier, context);
	} catch (err) {
		if (err?.code !== "ERR_MODULE_NOT_FOUND" || !/^\.{1,2}\//.test(specifier)) throw err;
		return next(`${specifier}.ts`, context);
	}
}
