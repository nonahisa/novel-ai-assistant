import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const temporaryDirectories: string[] = [];
const expectedArchiveFiles = [
  "[Content_Types].xml",
  "extension.vsixmanifest",
  "extension/LICENSE.txt",
  "extension/changelog.md",
  "extension/package.json",
  "extension/readme.md",
  "extension/dist/extension.js",
  "extension/media/icon.svg",
];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("release metadata", () => {
  test("root package metadataからasset名と導入済みextension identityを導出する", async () => {
    const repositoryRoot = await createRepository({
      name: "story-tools",
      version: "2.3.4",
      publisher: "writer",
    });
    const { deriveReleaseMetadata } = await import(
      "../../scripts/releaseSupport.mjs"
    );

    const metadata = await deriveReleaseMetadata(repositoryRoot);

    expect(metadata.assetName).toBe("story-tools-2.3.4.vsix");
    expect(metadata.expectedExtension).toBe("writer.story-tools@2.3.4");
    expect(metadata.vsixPath).toBe(
      path.join(repositoryRoot, "release", "story-tools-2.3.4.vsix")
    );
  });

  test("導入済み一覧から期待するextension identityを返す", async () => {
    const { validateInstalledExtension } = await import(
      "../../scripts/releaseSupport.mjs"
    );

    expect(
      validateInstalledExtension(
        "publisher.other@1.0.0\nlocal.novel-ai-assistant@0.0.2\n",
        "local.novel-ai-assistant@0.0.2"
      )
    ).toBe("local.novel-ai-assistant@0.0.2");
  });
});

describe("VSIX validation", () => {
  test("exact allowlistだけを受理し追加ファイルを拒否する", async () => {
    const { validateArchiveFiles } = await import(
      "../../scripts/releaseSupport.mjs"
    );

    expect(() => validateArchiveFiles(expectedArchiveFiles)).not.toThrow();
    expect(() =>
      validateArchiveFiles([...expectedArchiveFiles, "extension/scripts/private.mjs"])
    ).toThrow("VSIX files differ from allowlist");
  });

  test.each([
    "sk-ant-abcdefghijklmnopqrstuvwxyz123456",
    "C:\\Users\\writer\\manuscript.txt",
    "Documents\\private-novel.txt",
    "_test_extract-result.json",
  ])("secretまたはlocal pathを含む配布内容を拒否する: %s", async (forbidden) => {
    const { validateArchiveContents } = await import(
      "../../scripts/releaseSupport.mjs"
    );
    const contents = new Map(
      expectedArchiveFiles.map((file) => [file, file === "extension/readme.md" ? forbidden : "safe"])
    );

    expect(() =>
      validateArchiveContents(expectedArchiveFiles, (file: string) => contents.get(file) ?? "")
    ).toThrow("Forbidden local or secret content found");
  });

  test("root package metadataと異なるpackaged manifestを拒否する", async () => {
    const { validatePackagedManifest } = await import(
      "../../scripts/releaseSupport.mjs"
    );
    const rootManifest = {
      name: "novel-ai-assistant",
      version: "0.0.2",
      publisher: "local",
      main: "./dist/extension.js",
    };

    expect(() =>
      validatePackagedManifest(
        JSON.stringify({ ...rootManifest, version: "0.0.1" }),
        rootManifest
      )
    ).toThrow("Packaged manifest identity or entry point is invalid");
  });
});

describe("prepare release notes", () => {
  test("stable本文へexact VSIX bytesのlowercase SHA-256を1行だけ追加する", async () => {
    const repositoryRoot = await createReleaseRepository("0.0.2");
    const { prepareReleaseNotes } = await import(
      "../../scripts/prepareReleaseNotes.mjs"
    );

    const result = await prepareReleaseNotes(repositoryRoot);
    const generated = await readFile(result.generatedNotesPath, "utf8");

    expect(generated).toBe(
      "# v0.0.2\n\n安全なリリース本文\n\n" +
        "SHA-256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n"
    );
    expect(generated.match(/^SHA-256: [0-9a-f]{64}$/gm)).toHaveLength(1);
  });

  test("package versionが0.0.2以外なら拒否する", async () => {
    const repositoryRoot = await createReleaseRepository("0.0.3");
    const { prepareReleaseNotes } = await import(
      "../../scripts/prepareReleaseNotes.mjs"
    );

    await expect(prepareReleaseNotes(repositoryRoot)).rejects.toThrow(
      "Release notes require package version 0.0.2"
    );
  });

  test("release assetが存在しなければ拒否する", async () => {
    const repositoryRoot = await createReleaseRepository("0.0.2", false);
    const { prepareReleaseNotes } = await import(
      "../../scripts/prepareReleaseNotes.mjs"
    );

    await expect(prepareReleaseNotes(repositoryRoot)).rejects.toThrow(
      "Release asset is missing"
    );
  });

  test("stable本文にsecretまたはlocal pathがあれば生成しない", async () => {
    const repositoryRoot = await createReleaseRepository("0.0.2");
    await writeFile(
      path.join(repositoryRoot, "docs", "releases", "v0.0.2.md"),
      "C:\\Users\\writer\\private.txt\n",
      "utf8"
    );
    const { prepareReleaseNotes } = await import(
      "../../scripts/prepareReleaseNotes.mjs"
    );

    await expect(prepareReleaseNotes(repositoryRoot)).rejects.toThrow(
      "Release notes contain forbidden local or secret content"
    );
  });
});

async function createRepository(manifest: Record<string, string>): Promise<string> {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "novel-ai-release-script-test-")
  );
  temporaryDirectories.push(repositoryRoot);
  await writeFile(
    path.join(repositoryRoot, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
  return repositoryRoot;
}

async function createReleaseRepository(
  version: string,
  includeAsset = true
): Promise<string> {
  const repositoryRoot = await createRepository({
    name: "novel-ai-assistant",
    version,
    publisher: "local",
    main: "./dist/extension.js",
  });
  await mkdir(path.join(repositoryRoot, "docs", "releases"), {
    recursive: true,
  });
  await mkdir(path.join(repositoryRoot, "release"), { recursive: true });
  await writeFile(
    path.join(repositoryRoot, "docs", "releases", `v${version}.md`),
    `# v${version}\n\n安全なリリース本文\n`,
    "utf8"
  );
  if (includeAsset) {
    await writeFile(
      path.join(repositoryRoot, "release", `novel-ai-assistant-${version}.vsix`),
      Buffer.alloc(0)
    );
  }
  return repositoryRoot;
}
