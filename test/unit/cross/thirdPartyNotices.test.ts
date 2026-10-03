import { beforeAll, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import {
  collectBundledPackages,
  packageDirOf,
} from "../../../scripts/bundledPackages.mjs";

/**
 * 同梱しているライブラリのライセンス表示（設計書8.2）。
 *
 * 配布する3つの束（`dist/extension.js`・`dist/browser-extension.js`・
 * `dist/mcp-server.mjs`）には、esbuild が部品を**束ねて**入れる。
 * MITもBSD-3-Clauseも「**著作権表示とライセンス本文をそのまま添えること**」を
 * 配布の条件にしているので、表示が抜けていると条件を満たさない。
 *
 * **直接の依存（`dependencies`）だけを見ていると、その連れが抜ける。**
 * 0.96.14 まで、`buffer` が使う `base64-js`・`ieee754`（BSD-3-Clause）、
 * `iconv-lite` が使う `safer-buffer`、MCP サーバーの束に入る SDK とその部品が
 * 載っていなかった。ここでは束を実際に組んで（書き出さずに）、入った部品を
 * 全部見る。
 */
const NOTICES = readFileSync("THIRD-PARTY-NOTICES.md", "utf-8");
const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  license?: string;
};

type BundledPackage = { name: string; version: string; bundles: string[] };
let bundled: BundledPackage[] = [];

beforeAll(async () => {
  bundled = (await collectBundledPackages()) as BundledPackage[];
}, 120_000);

describe("同梱ライブラリの表示", () => {
  test("束に入る部品が、版まで含めてすべて載っている", () => {
    // 版が上がったのに古い本文が残っていると、別の版の条件を示すことになる
    const missing = bundled
      .filter(({ name, version }) => !NOTICES.includes(`## ${name} ${version}\n`))
      .map(({ name, version, bundles }) => `${name} ${version}（${bundles.join("・")}）`);
    expect(missing, "node scripts/buildThirdPartyNotices.mjs で作り直す").toEqual([]);
  });

  test("束に入らないものは載せない（開発の道具を配布物の表示へ混ぜない）", () => {
    const listed = [...NOTICES.matchAll(/^## (\S+) (\S+)$/gm)].map(
      (match) => `${match[1]} ${match[2]}`
    );
    const expected = new Set(bundled.map(({ name, version }) => `${name} ${version}`));
    expect(listed.filter((entry) => !expected.has(entry))).toEqual([]);
  });

  test("検査が空振りしていない（直接の依存と、その連れを拾えている）", () => {
    // 集め方が壊れて0件になると、上の2つは素通りする
    const names = new Set(bundled.map(({ name }) => name));
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      expect(names.has(name), name).toBe(true);
    }
    // 0.96.14 で抜けていた連れ。ブラウザ束の `buffer` が使う
    expect(names.has("base64-js")).toBe(true);
    expect(names.has("ieee754")).toBe(true);
    // MCP サーバーの束（配布物に入る）は SDK ごと束ねる
    expect(names.has("@modelcontextprotocol/sdk")).toBe(true);
  });

  test("配布の道具は束に入らない", () => {
    expect(bundled.map(({ name }) => name)).not.toContain("@vscode/vsce");
    expect(bundled.map(({ name }) => name)).not.toContain("esbuild");
  });

  test("入れ子の部品は、入れ子の置き場で数える", () => {
    // 根の `node_modules/b` と、`a` の中の `node_modules/b` は別の版でありうる
    expect(packageDirOf("node_modules/a/node_modules/b/index.js")).toBe(
      "node_modules/a/node_modules/b"
    );
    expect(packageDirOf("node_modules/@scope/pkg/dist/x.js")).toBe(
      "node_modules/@scope/pkg"
    );
    expect(packageDirOf("src/extension.ts")).toBeUndefined();
  });

  test("ライセンス本文そのものが入っている（要約ではない）", () => {
    // 「MITです」とだけ書いても条件を満たさない
    expect(NOTICES).toContain("Permission is hereby granted");
    expect(NOTICES).toContain("Redistributions of source code");
  });

  test("拡張機能自身のライセンスと取り違えない", () => {
    expect(NOTICES).toContain("LICENSE");
    // 作者が小説家なので、原稿に掛かると誤解されないことが要る
    expect(NOTICES).toContain("小説・プロット・設定資料には、これらは一切関係しません");
  });
});

describe("拡張機能のライセンス", () => {
  const LICENSE = readFileSync("LICENSE", "utf-8");

  test("package.json と LICENSE が食い違わない", () => {
    expect(pkg.license).toBe("MIT");
    expect(LICENSE).toContain("MIT License");
  });

  test("著作権者が仮の名前のままになっていない", () => {
    // 「誰の著作物か」を示せないまま配ることになる
    expect(LICENSE).not.toContain("contributors");
    expect(LICENSE).toMatch(/Copyright \(c\) \d{4} \S+/);
  });

  test("連名の著作権者が両方載っている", () => {
    // **片方を落とすと、その人の権利表示が配布物から消える。**
    // 版を上げるときの一括置換などで、うっかり消えないよう固定する
    expect(LICENSE).toContain("Copyright (c) 2026 nonahisa, kmizu");
  });
});
