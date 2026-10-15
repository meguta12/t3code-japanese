process.env.T3CODE_DISABLE_AUTO_UPDATE = "true";
process.env.T3CODE_HOME = require("node:path").join(
  require("node:os").homedir(),
  "Library/Application Support/T3 Code 日本語版/runtime",
);
// Packaged app entry. Enables the compile cache before the main bundle loads,
// so the cache also covers main.cjs itself.
require("./compileCache.cjs");
require("./main.cjs");
