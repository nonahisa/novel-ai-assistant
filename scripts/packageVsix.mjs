import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const outputDirectory = path.join(repositoryRoot, "release");
const outputPath = path.join(
  outputDirectory,
  "novel-ai-assistant-0.0.1.vsix"
);

await mkdir(outputDirectory, { recursive: true });

const require = createRequire(import.meta.url);
const { createVSIX } = require("@vscode/vsce/out/api");
await createVSIX({
  cwd: repositoryRoot,
  packagePath: outputPath,
  allowMissingRepository: true,
});
