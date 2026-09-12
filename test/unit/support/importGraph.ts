import * as fs from "fs";
import * as path from "path";

/**
 * 静的 import だけをたどる走査。**2つの検査が同じ歩き方を使う。**
 *
 * - `browserReach.test.ts` … `extension.ts` から Node 専用へ届かないか（設計書5.8）
 * - `mcpReach.test.ts` … `prompts` と `core` の入口から `vscode` へ届かないか（6.87.3）
 *
 * **写さずに共有する。** 片方だけ直して、もう片方が古い歩き方のまま
 * 通り続けるのが一番まずい（たどり方が壊れると、検査は「0件」で
 * 全部通ってしまう）。
 */

/** `src` の場所。この支援ファイルは `test/unit/support/` に居る */
export const SRC = path.join(__dirname, "..", "..", "..", "src");

/**
 * 静的な `import` 文だけを拾う。
 *
 * - 行頭の `import` に限る（`await import(...)` は行の途中なので当たらない）
 * - `import type` は実行時に消えるので除く
 *
 * 再輸出（`export * from "./x"`、`export { a } from "./x"`）も
 * **実行時にはその場で読み込まれる**ので、静的 import と同じに扱う。
 */
const STATIC_IMPORT =
  /^import\s+(?!type\s)([\s\S]*?)\s+from\s+["']([^"']+)["']|^import\s+["']([^"']+)["']|^export\s+(?!type\s)(?:\*|\{[\s\S]*?\})\s+from\s+["']([^"']+)["']/gm;

/** 相対の指定を、実在するファイルへ解く */
export function resolveImport(
  fromFile: string,
  spec: string
): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  // 動的 import は `.js` を付ける決まりなので、落としてから探す
  const base = path.resolve(path.dirname(fromFile), spec.replace(/\.js$/, ""));
  for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** 相対でない import（`vscode`・`node:fs` など）が、どのファイルから出ているか */
export interface BareImport {
  /** その import を書いているファイル（絶対パス） */
  file: string;
  /** import の相手（`vscode` など） */
  spec: string;
}

export interface StaticReach {
  /** たどり着いたファイル（起点を含む。絶対パス） */
  files: Set<string>;
  /** 相対でない import の一覧 */
  bare: BareImport[];
  /** どのファイルから来たか。経路を復元するために持つ */
  cameFrom: Map<string, string>;
  /** 走査の起点 */
  entries: string[];
}

/**
 * 起点から、静的 import だけをたどる。
 *
 * 動的 import（`await import("./x.js")`）は `canRunProcesses()` などで
 * 守られた正しい道なので、たどらない。
 *
 * 幅優先で歩く。**経路をメッセージに出すときに、遠回りの道が出ると
 * 直す場所を取り違える**ため。
 */
export function walkStaticImports(entries: string[]): StaticReach {
  const files = new Set<string>(entries);
  const bare: BareImport[] = [];
  const cameFrom = new Map<string, string>();
  const queue = [...entries];

  while (queue.length > 0) {
    const file = queue.shift()!;
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(STATIC_IMPORT)) {
      const spec = match[2] ?? match[3] ?? match[4];
      if (!spec) continue;
      if (!spec.startsWith(".")) {
        bare.push({ file, spec });
        continue;
      }
      const next = resolveImport(file, spec);
      if (!next || files.has(next)) continue;
      files.add(next);
      cameFrom.set(next, file);
      queue.push(next);
    }
  }
  return { files, bare, cameFrom, entries };
}

/** `src` からの相対名（区切りは `/` に揃える） */
export function relativeName(file: string): string {
  return path.relative(SRC, file).replace(/\\/g, "/");
}

export function relativeNames(files: Iterable<string>): string[] {
  return [...files].map(relativeName);
}

/**
 * 「起点 → 経由 → そのファイル」を1行にする。
 *
 * **どこを切れば届かなくなるかは、経路を見ないと決められない。**
 * 落ちたときに直す場所が分かるよう、必ずこれを出す。
 */
export function chainTo(reach: StaticReach, file: string): string {
  const chain = [file];
  let current = file;
  while (reach.cameFrom.has(current)) {
    current = reach.cameFrom.get(current)!;
    chain.unshift(current);
  }
  return chain.map(relativeName).join(" -> ");
}
