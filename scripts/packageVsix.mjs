import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { deriveReleaseMetadata } from "./releaseSupport.mjs";
import { holdPull } from "./holdPull.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const outputDirectory = path.join(repositoryRoot, "release");
const { vsixPath: outputPath } = await deriveReleaseMetadata(repositoryRoot);

await mkdir(outputDirectory, { recursive: true });

const require = createRequire(import.meta.url);
const { createVSIX } = require("@vscode/vsce/out/api");
// 検査（vscode:prepublish）を流している間は、会話のフックの自動の git pull を止める（scripts/holdPull.mjs）
const releasePull = holdPull(repositoryRoot);
try {
  await createVSIX({
    cwd: repositoryRoot,
    packagePath: outputPath,
    allowMissingRepository: true,
  });
} finally {
  releasePull();
}
