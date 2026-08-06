import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
} from "@vscode/test-electron";
import {
  deriveReleaseMetadata,
  EXPECTED_ARCHIVE_FILES,
  validateArchiveContents,
  validateArchiveFiles,
  validateInstalledExtension,
  validatePackagedManifest,
} from "./releaseSupport.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const { expectedExtension, rootManifest, vsixPath } =
  await deriveReleaseMetadata(repositoryRoot);

const archiveFiles = run("tar", ["-tf", vsixPath])
  .split(/\r?\n/)
  .map((entry) => entry.replace(/\\/g, "/"))
  .filter(Boolean)
  .sort();
validateArchiveFiles(archiveFiles);

const manifestText = readArchiveFile("extension/package.json");
validatePackagedManifest(manifestText, rootManifest);
validateArchiveContents(EXPECTED_ARCHIVE_FILES, readArchiveFile);

const temporaryBase = path.resolve(tmpdir());
const auditDirectory = await mkdtemp(
  path.join(temporaryBase, "novel-ai-assistant-vsix-audit-")
);
try {
  const vscodeExecutablePath = await downloadAndUnzipVSCode("1.90.0");
  const [codeCommand, ...cliArgs] =
    resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath, {
      reuseMachineInstall: true,
    });
  const codeOptions = {
    shell: process.platform === "win32",
    cwd: repositoryRoot,
  };
  const commonArgs = [
    "--user-data-dir",
    path.join(auditDirectory, "user-data"),
    "--extensions-dir",
    path.join(auditDirectory, "extensions"),
  ];
  run(
    codeCommand,
    [...cliArgs, ...commonArgs, "--install-extension", vsixPath, "--force"],
    codeOptions
  );
  const installed = run(codeCommand, [
    ...cliArgs,
    ...commonArgs,
    "--list-extensions",
    "--show-versions",
  ], codeOptions);
  console.log(
    `Installed extension: ${validateInstalledExtension(installed, expectedExtension)}`
  );
} finally {
  const resolvedAudit = path.resolve(auditDirectory);
  const safePrefix = `${temporaryBase}${path.sep}`;
  if (
    !resolvedAudit.startsWith(safePrefix) ||
    !path.basename(resolvedAudit).startsWith("novel-ai-assistant-vsix-audit-")
  ) {
    throw new Error(`Refusing to clean unsafe path: ${resolvedAudit}`);
  }
  await rm(resolvedAudit, { recursive: true, force: true });
}

const bytes = await readFile(vsixPath);
const sha256 = createHash("sha256").update(bytes).digest("hex");
console.log(`VSIX verified: ${vsixPath}`);
console.log(`Files: ${archiveFiles.length}`);
console.log(`Bytes: ${bytes.length}`);
console.log(`SHA-256: ${sha256}`);

function readArchiveFile(file) {
  return run("tar", ["-xOf", vsixPath, file]);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (${result.status}): ${result.stderr || result.stdout}`
    );
  }
  return result.stdout.trim();
}
