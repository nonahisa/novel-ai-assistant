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
  // ブラウザ版VSCode（vscode.dev / github.dev）向けの束（設計書5.8）
  "extension/dist/browser-extension.js",
  "extension/media/icon.svg",
];

/**
 * 配布物に入っていてはいけない文字列。
 *
 * **鍵の接頭辞は `src/core/logger.ts` の `SECRET_PREFIXES` と揃える。**
 * 片方に足してもう片方を忘れるのが一番ありがちな壊れ方なので、
 * `test/unit/secretScanParity.test.ts` が両者の揃いを見張っている
 * （こちらは素のNodeで動く `.mjs`、あちらはTypeScriptなので、
 * 定義そのものは共有できない）。
 *
 * **語の途中は見ない**（`(?<![A-Za-z0-9])`）。`sk-` は `task-` `risk-` の
 * 中にも現れるので、そこまで拾うと配布のたびに無関係な行で止まり、
 * 走査そのものが信用されなくなる。
 */
export const FORBIDDEN_CONTENT_PATTERNS = [
  // OpenAI・Anthropic（`sk-ant-` は `sk-` に含まれるが、由来が分かるよう残す）
  /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}/,
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/,
  // Google（Gemini）
  /(?<![A-Za-z0-9])AIza[A-Za-z0-9_-]{20,}/,
  /(?<![A-Za-z0-9])AQ\.[A-Za-z0-9_-]{20,}/,
  // GitHub。同期のトークンで、URLに埋め込まれた形でも紛れ込みうる
  /(?<![A-Za-z0-9])gh[pours]_[A-Za-z0-9_-]{20,}/,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_-]{20,}/,
  /C:\\Users\\/i,
  /Documents\\/i,
  /_test_extract/i,
  // **開発用の道具は配布物に入れない**（作者の指定、2026-08-26）。
  // 本番ビルドでは `__DEV_HELPERS__` が false に畳まれて枝ごと落ちるが、
  // **畳み忘れれば黙って入る**ので、出口でも見張る。
  // ASCIIの名前で見る——日本語は逃がされた形になるため（0.13.0で踏んだ）
  /novelai[.]runChecks/,
  /checkRunner/,
  // F5の操作ログ（作者の依頼、2026-08-27）。作者がどの機能をいつ触ったかという
  // 個人の作業記録に繋がるので、道具ごと配布物へ出さない
  /novelai[.]reflectOperationLog/,
  /operationLog/,
  // 確認リストの項目の文章。**作者の作品名が入る**ので配布物へ出さない
  /PENDING_CHECK_ITEMS/,
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
