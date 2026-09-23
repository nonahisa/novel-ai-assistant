import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import * as ts from "typescript";

/**
 * 済んだ記録（`notifyDone`）を、**操作した作品のログ**へ書く（0.81.4）。
 *
 * ## 何が起きたか
 *
 * 「教科書チート_確認用 の投稿先を カクヨム にしました。」（2026-09-22 11:34:34）が、
 * 関係の無い `いじめられっ子_確認用` の操作ログに入っていた。ログの書き先は
 * `useLogFile` で切り替える**1つの共有の値**で、投稿先の設定は失敗の道でしか
 * 切り替えていなかった。`notifyDone` はステータスバーに出すだけでなく
 * **ログへも1行書く**ので、成功の記録は直前に触った作品のログへ流れる。
 *
 * 同じ型（作品を受け取っているのに、書き先を向ける前に済んだ記録を書く）が
 * 投稿先の設定のほかにも十数か所あった。
 *
 * ## 何を見張るか
 *
 * **作品（`WorkEntry`）を受け取る関数の中で `notifyDone(` を呼ぶなら、その前に
 * 同じ関数の中で `useLogFile(` を呼ぶ。** 呼ぶ側が向けてくれている、を当てに
 * しない——ツリーの右クリック（`node.work`）やパネルから直に呼ばれる入口が
 * あり、AIの応答を待つ間にほかの操作が書き先を変えることもある。
 *
 * `logFailure` などの失敗の記録は見ない（小さな下請けの関数が多く、入口が
 * 向けている。ファイル単位の網は `logFileRouting.test.ts`）。
 *
 * あわせて、コマンドの入口の `resolveWork`（extension.ts）が、決まった作品へ
 * 書き先を向けていることも見る——90余りのコマンドがここを通る。
 */

const SRC = resolve(__dirname, "../../../src");

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (name.endsWith(".ts")) found.push(full);
  }
  return found;
}

/** 作品を1つ受け取る引数があるか（配列は作品をまたぐので見ない） */
function takesWork(fn: ts.SignatureDeclaration, file: ts.SourceFile): boolean {
  return fn.parameters.some((parameter) => {
    const type = parameter.type?.getText(file) ?? "";
    return /\bWorkEntry\b/.test(type) && !/\[\]|readonly /.test(type);
  });
}

interface Call {
  name: string;
  at: number;
}

/** 関数の中の、名前で呼んでいる呼び出し（入れ子の関数の中も含む） */
function callsIn(body: ts.Node, file: ts.SourceFile): Call[] {
  const calls: Call[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      calls.push({ name: node.expression.text, at: node.getStart(file) });
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return calls;
}

describe("済んだ記録は、操作した作品のログへ", () => {
  test("作品を受け取る関数は、notifyDone の前に useLogFile で書き先を向ける", () => {
    const offenders: string[] = [];
    for (const full of sourceFiles(SRC)) {
      const text = readFileSync(full, "utf8");
      if (!text.includes("notifyDone(")) continue;
      const file = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (
          (ts.isFunctionDeclaration(node) ||
            ts.isArrowFunction(node) ||
            ts.isFunctionExpression(node) ||
            ts.isMethodDeclaration(node)) &&
          node.body &&
          takesWork(node, file)
        ) {
          const calls = callsIn(node.body, file);
          const firstRoute = calls.find((call) => call.name === "useLogFile");
          for (const call of calls) {
            if (call.name !== "notifyDone") continue;
            if (firstRoute && firstRoute.at < call.at) continue;
            const line = file.getLineAndCharacterOfPosition(call.at).line + 1;
            const name = node.name?.getText(file) ?? "(無名の関数)";
            offenders.push(`${relative(SRC, full)}:${line} ${name}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
    expect(offenders).toEqual([]);
  });

  test("コマンドの入口の resolveWork は、決まった作品へ書き先を向ける", () => {
    const text = readFileSync(resolve(SRC, "extension.ts"), "utf8");
    const start = text.indexOf("async function resolveWork(");
    expect(start).toBeGreaterThan(-1);
    const end = text.indexOf("\n}\n", start);
    expect(text.slice(start, end)).toContain("useLogFile(");
  });
});
