/**
 * Node test loader: map relative `*.js` specifiers to `*.ts` so
 * `--experimental-strip-types` can run session tests that import the
 * production module graph (which uses ESM .js extensions).
 */
import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
	// Only rewrite relative / absolute file specifiers ending in .js
	if (
		(specifier.startsWith("./") ||
			specifier.startsWith("../") ||
			specifier.startsWith("file:")) &&
		specifier.endsWith(".js")
	) {
		const parent = context.parentURL
			? fileURLToPath(context.parentURL)
			: process.cwd();
		const baseDir = existsSync(parent) ? dirname(parent) : parent;
		const absJs = specifier.startsWith("file:")
			? fileURLToPath(specifier)
			: join(baseDir, specifier);
		const absTs = absJs.slice(0, -3) + ".ts";
		if (existsSync(absTs) && extname(absTs) === ".ts") {
			return nextResolve(pathToFileURL(absTs).href, context);
		}
	}
	return nextResolve(specifier, context);
}
