import { readFile } from "node:fs/promises";
import path from "node:path";

export const EXPECTED_ARCHIVE_FILES = [
  "[Content_Types].xml",
  "extension.vsixmanifest",
  "extension/LICENSE.txt",
  // 同梱ライブラリのライセンス表示。MITもBSD-3-Clauseも「著作権表示と
  // ライセンス本文を配布物へ添えること」を条件にしているので、
  // **これが抜けた配布物は条件を満たさない**
  "extension/THIRD-PARTY-NOTICES.md",
  "extension/changelog.md",
  // Marketplace の顔になるアイコン。**PNGしか受け付けない**（8.4）
  "extension/media/icon.png",
  "extension/package.json",
  "extension/readme.md",
  "extension/dist/extension.js",
  "extension/media/icon.svg",
];

const FORBIDDEN_CONTENT_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /C:\\Users\\/i,
  /Documents\\/i,
  /_test_extract/i,
];

export async function deriveReleaseMetadata(repositoryRoot) {
  const rootManifest = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8")
  );
  const assetName = `${rootManifest.name}-${rootManifest.version}.vsix`;

  return {
    assetName,
    expectedExtension: `${rootManifest.publisher}.${rootManifest.name}@${rootManifest.version}`,
    rootManifest,
    vsixPath: path.join(repositoryRoot, "release", assetName),
  };
}

export function validateArchiveFiles(archiveFiles) {
  const actual = [...archiveFiles].sort();
  const expected = [...EXPECTED_ARCHIVE_FILES].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`VSIX files differ from allowlist:\n${actual.join("\n")}`);
  }
}

export function validateArchiveContents(archiveFiles, readArchiveFile) {
  for (const file of archiveFiles.filter(
    (entry) => entry !== "[Content_Types].xml"
  )) {
    const content = readArchiveFile(file);
    if (FORBIDDEN_CONTENT_PATTERNS.some((pattern) => pattern.test(content))) {
      throw new Error(`Forbidden local or secret content found in ${file}`);
    }
  }
}

export function validatePackagedManifest(manifestText, rootManifest) {
  const manifest = JSON.parse(manifestText);
  if (
    manifest.publisher !== rootManifest.publisher ||
    manifest.name !== rootManifest.name ||
    manifest.version !== rootManifest.version ||
    manifest.main !== rootManifest.main
  ) {
    throw new Error("Packaged manifest identity or entry point is invalid");
  }
}

export function validateInstalledExtension(installed, expectedExtension) {
  if (!installed.split(/\r?\n/).includes(expectedExtension)) {
    throw new Error(`Installed extension was not listed:\n${installed}`);
  }
  return expectedExtension;
}

export function validatePublicText(content, description) {
  if (FORBIDDEN_CONTENT_PATTERNS.some((pattern) => pattern.test(content))) {
    throw new Error(`${description} contain forbidden local or secret content`);
  }
}
