import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

/**
 * 同梱しているライブラリのライセンス表示（設計書8.2）。
 *
 * `dependencies` は esbuild が `dist/extension.js` へ**束ねて**配布する。
 * MITもBSD-3-Clauseも「**著作権表示とライセンス本文をそのまま添えること**」を
 * 配布の条件にしているので、表示が抜けていると条件を満たさない。
 *
 * **依存を足して表示を忘れる**のが、いちばん起きやすい抜け方である。
 */
const NOTICES = readFileSync("THIRD-PARTY-NOTICES.md", "utf-8");
const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
  dependencies?: Record<string, string>;
  license?: string;
};

describe("同梱ライブラリの表示", () => {
  test("配布に入る依存が、すべて載っている", () => {
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      expect(NOTICES, name).toContain(`## ${name} `);
    }
  });

  test("版まで一致している", () => {
    // 版が上がったのに古い本文が残っていると、別の版の条件を示すことになる
    for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
      const installed = JSON.parse(
        readFileSync(`node_modules/${name}/package.json`, "utf-8")
      ) as { version: string };
      expect(NOTICES, `${name}@${range}`).toContain(
        `## ${name} ${installed.version}`
      );
    }
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
