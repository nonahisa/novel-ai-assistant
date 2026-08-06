import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  deriveReleaseMetadata,
  validatePublicText,
} from "./releaseSupport.mjs";

const RELEASE_VERSION = "0.0.2";

export async function prepareReleaseNotes(repositoryRoot) {
  const { rootManifest, vsixPath } = await deriveReleaseMetadata(repositoryRoot);
  if (rootManifest.version !== RELEASE_VERSION) {
    throw new Error(
      `Release notes require package version ${RELEASE_VERSION}; found ${rootManifest.version}`
    );
  }

  try {
    await access(vsixPath);
  } catch {
    throw new Error(`Release asset is missing: ${vsixPath}`);
  }

  const baseNotesPath = path.join(
    repositoryRoot,
    "docs",
    "releases",
    `v${RELEASE_VERSION}.md`
  );
  const generatedNotesPath = path.join(
    repositoryRoot,
    "release",
    `v${RELEASE_VERSION}-notes.md`
  );
  const baseNotes = await readFile(baseNotesPath, "utf8");
  validatePublicText(baseNotes, "Release notes");
  const sha256 = createHash("sha256")
    .update(await readFile(vsixPath))
    .digest("hex");
  await writeFile(
    generatedNotesPath,
    `${baseNotes.trimEnd()}\n\nSHA-256: ${sha256}\n`,
    "utf8"
  );

  return { generatedNotesPath, sha256, vsixPath };
}

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await prepareReleaseNotes(repositoryRoot);
  console.log(`Release notes prepared: ${result.generatedNotesPath}`);
  console.log(`SHA-256: ${result.sha256}`);
}
