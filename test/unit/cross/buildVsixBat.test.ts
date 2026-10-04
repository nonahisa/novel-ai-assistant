import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 手元確認用の VSIX を作る `build-vsix.bat`（設計書8.4.2）の決まりを見張る。
 *
 * - **bat は ASCII だけ、改行は CRLF。** cmd.exe は bat をシステムの
 *   コードページ（日本語版では Shift_JIS）で読むので、UTF-8 の日本語は化ける。
 *   LF だけの bat は、ラベルや括弧のブロックを読み違えることがある
 * - **配布物に入れない。** リポジトリ直下に置くので、`.vscodeignore` に無いと VSIX に入る
 * - **出力は配布用と分ける。** 検査を通していない VSIX を Release へ取り違えないように
 */
const root = resolve(__dirname, "../../..");
const read = (file: string) => readFileSync(resolve(root, file));

describe("build-vsix.bat", () => {
  const bat = read("build-vsix.bat");

  test("ASCII だけで書かれている", () => {
    const nonAscii = [...bat].filter((byte) => byte > 0x7f);
    expect(nonAscii).toEqual([]);
  });

  test("改行がすべて CRLF", () => {
    const text = bat.toString("ascii");
    expect(text).toContain("\r\n");
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
  });

  test("本体の quickVsix.mjs を呼び、窓が閉じないよう pause する", () => {
    const text = bat.toString("ascii");
    expect(text).toContain("node scripts\\quickVsix.mjs");
    expect(text).toContain("pause");
    expect(text).toContain("set ELECTRON_RUN_AS_NODE=");
  });

  test(".gitattributes が bat を CRLF に固定している", () => {
    expect(read(".gitattributes").toString("utf8")).toMatch(/^\*\.bat text eol=crlf$/m);
  });

  test(".vscodeignore が bat を配布物から外している", () => {
    expect(read(".vscodeignore").toString("utf8")).toMatch(/^\*\.bat$/m);
  });
});

describe("quickVsix.mjs", () => {
  const source = read("scripts/quickVsix.mjs").toString("utf8");

  test("出力は release/local/ に -local を付けて置く（配布用と取り違えない）", () => {
    expect(source).toContain('path.join(repositoryRoot, "release", "local")');
    expect(source).toContain("-local.vsix");
  });

  test("依存は npm ci で入れる（package-lock.json を書き換えない）", () => {
    expect(source).toContain('spawnSync("npm ci"');
    // コメントでは「npm install にしない理由」を書いているので、呼び出しだけを見る
    expect(source).not.toMatch(/spawnSync\(\s*"npm install/);
  });
});
