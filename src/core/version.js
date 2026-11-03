import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageMetadata = require("../../package.json");

export const ENGINE_VERSION = packageMetadata.version;
