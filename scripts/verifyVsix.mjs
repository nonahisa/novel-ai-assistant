import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const vsixPath = path.join(
  repositoryRoot,
  "release",
  "novel-ai-assistant-0.0.1.vsix"
);
const expectedFiles = [
  "[Content_Types].xml",
  "extension.vsixmanifest",
  "extension/LICENSE.txt",
  "extension/changelog.md",
  "extension/package.json",
  "extension/readme.md",
  "extension/dist/extension.js",
  "extension/media/icon.svg",
];

const archiveFiles = run("tar", ["-tf", vsixPath])
  .split(/\r?\n/)
  .map((entry) => entry.replace(/\\/g, "/"))
  .filter(Boolean)
  .sort();
if (JSON.stringify(archiveFiles) !== JSON.stringify([...expectedFiles].sort())) {
  throw new Error(
    `VSIX files differ from allowlist:\n${archiveFiles.join("\n")}`
  );
}

const manifestText = readArchiveFile("extension/package.json");
const manifest = JSON.parse(manifestText);
if (
  manifest.publisher !== "local" ||
  manifest.name !== "novel-ai-assistant" ||
  manifest.version !== "0.0.1" ||
  manifest.main !== "./dist/extension.js"
) {
  throw new Error("Packaged manifest identity or entry point is invalid");
}

const forbidden = [
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /C:\\Users\\/i,
  /Documents\\/i,
  /_test_extract/i,
];
for (const file of expectedFiles.filter((entry) => entry !== "[Content_Types].xml")) {
  const content = readArchiveFile(file);
  if (forbidden.some((pattern) => pattern.test(content))) {
    throw new Error(`Forbidden local or secret content found in ${file}`);
  }
}

const temporaryBase = path.resolve(tmpdir());
const auditDirectory = await mkdtemp(
  path.join(temporaryBase, "novel-ai-assistant-vsix-audit-")
);
try {
  const installedCodeDirectory =
    "C:\\Program Files\\Microsoft VS Code\\bin";
  const codeCommand = existsSync(
    path.join(installedCodeDirectory, "code.cmd")
  )
    ? "code.cmd"
    : "code";
  const codeOptions = {
    shell: process.platform === "win32",
    cwd: existsSync(installedCodeDirectory)
      ? installedCodeDirectory
      : repositoryRoot,
  };
  const commonArgs = [
    "--user-data-dir",
    path.join(auditDirectory, "user-data"),
    "--extensions-dir",
    path.join(auditDirectory, "extensions"),
  ];
  run(
    codeCommand,
    [...commonArgs, "--install-extension", vsixPath, "--force"],
    codeOptions
  );
  const installed = run(codeCommand, [
    ...commonArgs,
    "--list-extensions",
    "--show-versions",
  ], codeOptions);
  if (!installed.split(/\r?\n/).includes("local.novel-ai-assistant@0.0.1")) {
    throw new Error(`Installed extension was not listed:\n${installed}`);
  }
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
