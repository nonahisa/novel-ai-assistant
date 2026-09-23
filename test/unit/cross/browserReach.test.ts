import * as fs from "fs";
import * as path from "path";
import { describe, expect, test } from "vitest";
import {
  SRC,
  relativeNames,
  walkAllImports,
  walkStaticImports,
} from "../support/importGraph";

/**
 * コメントと文字列を落とす（2026-09-21）。
 *
 * **禁じ手の名前は、コメントに書けなければならない。** 「`vscode.Uri.file()` を
 * 直に呼ばない」と理由を添えたファイルが、その注意書きごと咎められた
 * （`features/pickFolder.ts`。実際の呼び出しは `toUri()` で正しかった）。
 *
 * **ここで落とすのは行コメント・ブロックコメント・文字列の3つだけ**である。
 * 構文解析まではしない——**この検査は「素朴に探して当たったら疑う」ためのもの**で、
 * 取りこぼしよりも空振りのほうが害が大きい。
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

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
      const source = fs.readFileSync(path.join(SRC, name), "utf8");
      // **コメントは数えない**（2026-09-21）。「`vscode.Uri.file()` を直に呼ばない」と
      // 注意書きを添えたファイルが、そのまま咎められた（`features/pickFolder.ts`）。
      // **禁じ手の名前をコメントへ書けないと、なぜそう書くのかを残せない。**
      return /vscode\.Uri\.file\(/.test(withoutComments(source));
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

/**
 * 素の `process` を、分けずに使っていないか（2026-09-23）。
 *
 * **ブラウザ版には `process` が無い。** 触った瞬間に
 * `process is not defined` で落ちる。静的 import の検査（上）は
 * 「読み込んだ瞬間に落ちる」を止めるが、こちらは**押したときに落ちる**を止める。
 *
 * 実機で2つ踏んだ（本体がブラウザ版で確かめた）。
 *
 * - 「動作を診断」の生成文書が保管庫へ置けず、無題文書へ落ちた。
 *   書き込み口（`atomicWriteFile`）が必ず呼ぶ見張り（`SelfWriteTracker`）の
 *   正規化が `process.platform` を素で読んでいた——**ブラウザ版では
 *   `atomicWriteFile` を通る書き込みがすべて落ちていた**ことになる
 * - 「バージョンを確認」が `process is not defined` の窓を出して落ちた
 *
 * 根は同じで、**安全な部品（`paths.normalizeForComparison`）が既にあるのに、
 * 同じ正規化を自前で書き写し、分け方を落とした所が8つあった。**
 *
 * **決まり：`process` を読むのは `core/runtime.ts` だけ。** ほかは
 * `hostPlatform()`・`isWindowsHost()`・`environmentVariable()` を通す。
 * 手元専用と確かめたファイルだけを下の一覧で許す（理由を添える）。
 *
 * 数えないもの（機械で決まる）
 * - **Node専用のものを静的に読むファイル**（そこから先も含む）。
 *   ブラウザでは読み込めないので、`canRunProcesses()` で分けてから
 *   動的 import するしかない（上の検査が静的な到達を止めている）
 * - **拡張機能から、静的にも動的にも届かないファイル**（MCPサーバーの束だけが使う）
 */
const PROCESS_READER = "core/runtime.ts";

/** 手元専用と確かめて、素の `process` を許すファイル。**理由のないものを足さない** */
const PROCESS_ALLOWED: ReadonlyMap<string, string> = new Map([
  [
    "ai/childProcessEnv.ts",
    "子プロセスへ渡す環境を作る。呼ぶのは起動係（Node専用）と、openExternalFile の手元の道だけ",
  ],
  [
    "core/openExternalFile.ts",
    "OSのコマンドで開く道（openWithShell）だけが読む。入口で canRunProcesses() を見てから呼ぶ",
  ],
  [
    "features/connectClaudeCode.ts",
    "Claude Code とつなぐ。拡張機能からは動的 import だけで届き、入口で canRunProcesses() を見て、ブラウザでは理由を出して戻る",
  ],
  [
    "features/windowCard.ts",
    "窓の札。入口で canRunProcesses() を見て、ブラウザでは何もせずに戻る",
  ],
]);

/**
 * 素の `process` を読んでいる所。
 *
 * **読む形（`process.`・`process?.`・`process[`）と `typeof process` だけを拾う。**
 * 単語だけで拾うと、正規表現の中の英語（`ai/ollamaProvider.ts` の
 * 「llama-server process has terminated」）まで当たる。`child_process`・
 * `x.process`・`NodeJS.ProcessEnv` は当たらない。分割代入
 * （`const { env } = process`）は拾えないが、この作品には無い
 */
const BARE_PROCESS =
  /(?<![\w$.])process\s*(?:\.|\?\.|\[)|(?<![\w$.])typeof\s+process\b/;

describe("素の `process` を、ブラウザで届く道で使っていない", () => {
  const extensionReach = walkAllImports([ENTRY]);
  const candidates = relativeNames(extensionReach.files).filter(
    (name) => name !== PROCESS_READER && !PROCESS_ALLOWED.has(name)
  );

  function usesBareProcess(name: string): boolean {
    const source = fs.readFileSync(path.join(SRC, name), "utf8");
    return BARE_PROCESS.test(withoutComments(source));
  }

  /** そのファイル（から静的にたどれる先）が、Node専用のものを読むか */
  function isNodeOnly(name: string): boolean {
    return walkStaticImports([path.join(SRC, name)]).bare.some((entry) =>
      NODE_ONLY.test(entry.spec)
    );
  }

  test("`core/runtime.ts` と、手元専用と確かめたファイルのほかで、`process` を読んでいない", () => {
    // 落ちたら：`core/runtime.ts` の読み口へ置き換える。場所の比べ方なら
    // `paths.normalizeForComparison` を呼ぶ（**正規化を書き写さない**）。
    // 手元専用なら、確かめた根拠を添えて PROCESS_ALLOWED へ足す
    const offenders = candidates
      .filter(usesBareProcess)
      .filter((name) => !isNodeOnly(name))
      .sort();
    expect(offenders).toEqual([]);
  });

  test("許す一覧が古くなっていない（まだ `process` を読んでいて、Node専用でもない）", () => {
    // 直して読まなくなったファイルを残すと、次に誰かが素で書いても素通りする
    for (const name of PROCESS_ALLOWED.keys()) {
      expect(fs.existsSync(path.join(SRC, name)), `${name} が無い`).toBe(true);
      expect(usesBareProcess(name), `${name} はもう process を読んでいない`).toBe(true);
      expect(isNodeOnly(name), `${name} は Node専用なので一覧に要らない`).toBe(false);
    }
  });

  test("検査が空振りしていない", () => {
    // 動的 import までたどれているか（押したときに読まれるファイルが入っているか）
    const names = new Set(relativeNames(extensionReach.files));
    expect(names.has("features/handoffSync.ts")).toBe(true);
    expect(names.has(PROCESS_READER)).toBe(true);
    expect(extensionReach.files.size).toBeGreaterThan(300);
    // 見つける側が働くか（当たるもの）
    expect(BARE_PROCESS.test("const a = process.platform;")).toBe(true);
    expect(BARE_PROCESS.test("process.env?.X")).toBe(true);
    expect(BARE_PROCESS.test("process?.env")).toBe(true);
    expect(BARE_PROCESS.test("process[key]")).toBe(true);
    expect(BARE_PROCESS.test("typeof process")).toBe(true);
    // 当たらないもの
    expect(BARE_PROCESS.test('import { spawn } from "node:child_process";')).toBe(false);
    expect(BARE_PROCESS.test("env: NodeJS.ProcessEnv")).toBe(false);
    expect(BARE_PROCESS.test("child.process.kill()")).toBe(false);
    expect(BARE_PROCESS.test("/llama-server process has terminated/i")).toBe(false);
  });
});
