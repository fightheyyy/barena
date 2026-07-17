const fs = require("node:fs");
const path = require("node:path");

const artifacts = process.env.BARENA_ARTIFACTS;
if (!artifacts || !fs.existsSync(artifacts)) {
  console.error("missing BARENA_ARTIFACTS");
  process.exit(1);
}

const files = fs.readdirSync(artifacts).filter((entry) => fs.statSync(path.join(artifacts, entry)).isFile());
if (files.length === 0) {
  console.error("no artifacts");
  process.exit(1);
}

console.log(`verified ${files.length} artifact(s)`);

