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

/**
 * VS Codeの統合ターミナルから実行すると、親から `ELECTRON_RUN_AS_NODE=1` を
 * 引き継いでしまう。これが付いていると、テスト用に起動した `Code.exe` が
 * Electronではなく**Nodeとして立ち上がり**、`--disable-extensions` などを
 * Nodeのオプションとして解釈して `bad option:` で落ちる。
 *
 * 作者はVS Codeのターミナルから `npm run test:integration` を実行するので、
 * ここで外しておかないと統合テストが常に失敗する（実際に踏んだ）。
 * 他のVSCODE_* も、親のウィンドウへ繋ぎに行かせないために落とす。
 */
// 消す前に控える。VSCODE_TEST_VERSION も下の削除に巻き込まれるため
const requestedVersion = process.env.VSCODE_TEST_VERSION ?? "1.90.0";

// `extensionTestsEnv` は process.env へ**上書きマージ**されるだけで、
// 変数を消すことはできない。起動する側の環境から直接落とす。
for (const name of Object.keys(process.env)) {
  if (name === "ELECTRON_RUN_AS_NODE" || name.startsWith("VSCODE_")) {
    delete process.env[name];
  }
}

try {
  await runTests({
    extensionDevelopmentPath: repositoryRoot,
    extensionTestsPath: path.join(repositoryRoot, "out", "src", "test", "run.js"),
    version: requestedVersion,
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
