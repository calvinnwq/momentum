/**
 * Registers the local TypeScript source loader for Node `--import` entrypoints.
 */
import { register } from "node:module";

register(new URL("./typescript-source-loader.mjs", import.meta.url));
