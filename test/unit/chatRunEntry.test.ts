import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

/**
 * 相談パネルから走らせる検知の入口（設計書6.8.16、2026-09-06）。
 *
 * **同じ機能に入口を2つ持たない。** ツリー／詳細メニューから走らせる道と、
 * 相談パネルの「走らせますか」から走らせる道があり、後者は結果をパネルへ
 * 出すところまで自前で書いていた。そのため 0.35.1 で入れた
 * 「指摘 N件＝パネルに残る件数」の数え方（`describeCheckRunCounts`）が
 * 相談側だけに届かず、**推敲とプロット逸脱は完了の知らせが出ず、矛盾は
 * マージ・除外の前の件数を「指摘 N件」と言っていた。**
 *
 * 直し方は、件数の計算を写すことではなく**入口を1つにする**こと
 * （`CHAT_RUN_COMMANDS` の流儀。既に登録してあるコマンドへ委ねる）。
 *
 * ここは**書いてあるコードの形**で見る。`extension.ts` の `activate` は
 * 単体では動かせないので、`proofreadingSuite.test.ts` などと同じやり方。
 */
const source = readFileSync("src/extension.ts", "utf8");

/** 相談パネルの `run` コールバックの中身（`reload` の手前まで） */
function runCallback(): string {
  const start = source.indexOf("run: async (work, kind, filePath) => {");
  expect(start, "相談パネルの run が見つからない").toBeGreaterThan(-1);
  const end = source.indexOf("reload: async (", start);
  expect(end, "reload が見つからない").toBeGreaterThan(start);
  return source.slice(start, end);
}

/** `CHAT_RUN_COMMANDS` の中身（種別 → コマンドID） */
function chatRunCommands(): Map<string, string> {
  const start = source.indexOf("const CHAT_RUN_COMMANDS");
  expect(start, "CHAT_RUN_COMMANDS が見つからない").toBeGreaterThan(-1);
  const end = source.indexOf("};", start);
  const body = source.slice(start, end);
  const pairs = new Map<string, string>();
  for (const match of body.matchAll(/(\w+):\s*"([\w.]+)"/g)) {
    pairs.set(match[1], match[2]);
  }
  return pairs;
}

interface PackageManifest {
  contributes: { commands: Array<{ command: string }> };
}

const declared = new Set(
  (
    JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8")
    ) as PackageManifest
  ).contributes.commands.map((entry) => entry.command)
);

describe("相談パネルからの検知は、メニューと同じ入口を通る", () => {
  const DELEGATED = [
    "checkTypos",
    "checkProofread",
    "checkDeviations",
    "checkContradictions",
  ] as const;

  for (const kind of DELEGATED) {
    test(`${kind} は登録済みのコマンドへ委ねる`, () => {
      const command = chatRunCommands().get(kind);
      expect(command, `${kind} が CHAT_RUN_COMMANDS に無い`).toBeTruthy();
      // 宣言していないコマンドへ委ねると、押した瞬間に何も起きない
      expect(declared.has(command ?? "")).toBe(true);
    });
  }

  test("run の中で検知を呼び直さない（結果の出し方が二重にならない）", () => {
    const body = runCallback();
    for (const kind of ["checkProofread", "checkDeviations", "checkContradictions"]) {
      expect(body, kind).not.toContain(`${kind}(work, aiRegistry`);
    }
    // 件数の言い方も、写しを持たない
    expect(body).not.toContain("notifyRunCompletion");
  });

  test("残る自前の道は「この話だけ」の誤字脱字で、通知は共通の関数を通す", () => {
    const body = runCallback();
    // 話を1つに絞る道だけはコマンドが受け取れない（ツリーの節点が要る）
    expect(body).toContain("checkTyposForFile");
    expect(body).toContain("reportTypoCheckResult");
    // その通知は「パネルに残る件数」を数える共通の関数を通っている
    expect(source).toContain("function reportTypoCheckResult");
  });
});
