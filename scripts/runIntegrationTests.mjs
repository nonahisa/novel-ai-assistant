import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const temporaryRoot = await mkdtemp(
  path.join(tmpdir(), "novel-ai-assistant-vscode-test-")
);

try {
  await runTests({
    extensionDevelopmentPath: repositoryRoot,
    extensionTestsPath: path.join(repositoryRoot, "out", "src", "test", "run.js"),
    version: process.env.VSCODE_TEST_VERSION ?? "1.90.0",
    launchArgs: [
      "--disable-extensions",
      "--disable-workspace-trust",
      "--user-data-dir",
      path.join(temporaryRoot, "user-data"),
      "--extensions-dir",
      path.join(temporaryRoot, "extensions"),
    ],
  });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
