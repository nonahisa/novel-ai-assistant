import * as fs from "fs";
import * as path from "path";
import { describe, expect, test } from "vitest";
import {
  SRC,
  relativeNames,
  walkStaticImports,
} from "./support/importGraph";

/**
 * ブラウザ版で起動した瞬間に落ちる形になっていないか（設計書5.8、CLAUDE.md 規則7）。
 *
 * **「ビルドが通った」は「動く」ではない。** `esbuild.js` はブラウザ束で
 * `node:child_process` などを `external` に指定しているので、**静的 import が
 * 残っていてもビルドは通る**。`external` は「実行時まで解決を遅らせる」
 * 指定であって、import を消すものではない。
 *
 * 実際に一度これで済ませかけた（引継ぎ書の「繰り返し起きた失敗」6）。
 * **静的 import は呼ばれなくても実行される**ので、Node専用のファイルへ
 * 静的に届いていると、ブラウザでは拡張機能が読み込まれた瞬間に落ちる。
 *
 * そこで CLAUDE.md が「確かめ方」として書いている手順——`extension.ts` から
 * **静的 import だけを**たどって Node専用へ届かないこと——をここで自動化する。
 * 動的 import（`await import("./x.js")`）は `canRunProcesses()` で守られた
 * 正しい道なので、たどらない。
 *
 * たどる部分は `support/importGraph.ts` にあり、`mcpReach.test.ts`
 * （`vscode` へ届かないか）と共有している。**歩き方を写さない。**
 */

const ENTRY = path.join(SRC, "extension.ts");

/** ブラウザに無いもの。`paths.ts` の `path` だけは差し替えられる（`esbuild.js`） */
const NODE_ONLY = /^node:|^(child_process|fs|os|crypto|worker_threads)$/;

/**
 * `path` を直に import してよい場所。
 *
 * **ここだけが差し替え先（`path-browserify`）を知っている。**
 * `pathText.ts` は `paths.ts` の中身のうち `vscode` が要らない部分で、
 * 元から同じ立場にある（設計書6.87.3で分けた）。
 */
const PATH_OWNERS = new Set(["core/paths.ts", "core/pathText.ts"]);

describe("ブラウザ版で起動した瞬間に落ちないか", () => {
  const reached = walkStaticImports([ENTRY]);
  const nodeImports = reached.bare
    .filter((entry) => NODE_ONLY.test(entry.spec))
    .map(
      (entry) =>
        `${path.relative(SRC, entry.file).replace(/\\/g, "/")} -> ${entry.spec}`
    );

  test("Node専用のものへ、静的 import で届いていない", () => {
    // 落ちたら：そのファイルの import を、`canRunProcesses()` で守った
    // 動的 import（`await import("./x.js")`。**`.js` が要る**）へ変える
    expect(nodeImports).toEqual([]);
  });

  test("`path` を直接使っていない（`core/paths` を通す）", () => {
    // ブラウザ上の作品は `vscode-vfs://github/...` にあり、
    // `path.join()` は `//` を潰して別の場所を指す
    const offenders = relativeNames(reached.files).filter((name) => {
      if (PATH_OWNERS.has(name)) return false;
      const source = fs.readFileSync(path.join(SRC, name), "utf8");
      return /^import\s+[\s\S]*?\s+from\s+["']path["']/m.test(source);
    });
    expect(offenders).toEqual([]);
  });

  test("`vscode.Uri.file()` を直接呼んでいない（`paths.toUri` を通す）", () => {
    const offenders = relativeNames(reached.files).filter((name) => {
      if (name === "core/paths.ts") return false;
      return /vscode\.Uri\.file\(/.test(fs.readFileSync(path.join(SRC, name), "utf8"));
    });
    expect(offenders).toEqual([]);
  });

  test("検査が空振りしていない（実際に多数たどれている）", () => {
    // たどり方が壊れて0件になっても、上の3つは通ってしまう
    expect(reached.files.size).toBeGreaterThan(200);
  });

  test("Node専用のファイルは、静的には到達しない側に居る", () => {
    // 動的 import でしか読まれないことの裏取り。ここに挙げたものが
    // 静的到達に入ってきたら、上の検査より先にこちらで気づける
    const nodeOnlyFiles = [
      "ai/lmstudioLauncher.ts",
      "ai/ollamaLauncher.ts",
      "core/git.ts",
      "core/gitSetup.ts",
      "core/packageInstall.ts",
      "features/selectOllamaExecutable.ts",
    ];
    const names = new Set(relativeNames(reached.files));
    for (const file of nodeOnlyFiles) {
      expect(names.has(file), `${file} が静的に到達している`).toBe(false);
    }
  });
});
