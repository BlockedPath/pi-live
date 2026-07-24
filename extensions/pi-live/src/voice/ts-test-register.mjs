/**
 * Registers the .js → .ts resolve hook for `npm test`.
 * Usage: node --import ./src/voice/ts-test-register.mjs --experimental-strip-types --test …
 */
import { register } from "node:module";

register("./ts-test-loader.mjs", import.meta.url);
