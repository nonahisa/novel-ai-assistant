import * as fs from "fs";
import * as path from "path";
import { describe, expect, test } from "vitest";

/**
 * AIを呼ぶ機能は、すべて同じ入口（`confirmProviderReachable`）を通るか
 * （設計書6.51）。
 *
 * **止まっているAIを、その場から起こせる導線を全機能に揃える。**
 * 起動を促すのは `features/aiConnectivity.ts` の
 * `confirmProviderReachable()` だが、これを呼んでいる機能と呼んでいない
 * 機能があった。作者がAIチューニングを実行して
 * 「Ollamaに接続できません」とだけ言われ、**通知に「Ollamaを起動」が
 * 無かった**（作者の報告、2026-08-30）。呼んでいたのは8機能、
 * 呼んでいなかったのが7機能である。
 *
 * どの機能が通っているかは型では守れないので、**ソースの形で固定する**
 * （`generateCancellation` や `sourceHygiene` と同じ方式）。新しくAIを
 * 呼ぶ処理を足した人が忘れたら、ここが落ちる。
 */

const FEATURES_DIR = path.join(__dirname, "..", "..", "src", "features");

/**
 * `confirmProviderReachable` を呼ばなくてよいファイル。**増やすときは理由を書く。**
 *
 * 減らすほうへ動かすこと。ここに載っている限り、そのファイルからは
 * 「AIを起動」の導線が出ない。
 */
const ALLOWED_WITHOUT_REACHABILITY = new Map<string, string>([
  [
    "recheckProposal.ts",
    "解決済みのプロバイダを引数で受け取る部品。AIを選ぶ入口は呼び出し側（提案パネル）が持つ",
  ],
]);

/**
 * AIを呼ぶ機能かどうかの見分け方。
 *
 * - `.generate({` … 実際にAIを呼んでいる（いちばん直接の証拠）
 * - `ensureConfigured(` … 自分でAIを選ぶ入口である
 *
 * **両方を見る。** `.generate({` だけだと、呼び出しをヘルパーへ切り出した
 * 機能が漏れる。`ensureConfigured(` だけだと、`registry.resolve()` で
 * 直に取っている相談パネルが漏れる。
 */
function isAIFeature(source: string): boolean {
  return source.includes(".generate({") || source.includes("ensureConfigured(");
}

interface FeatureFile {
  name: string;
  source: string;
}

function aiFeatureFiles(): FeatureFile[] {
  return fs
    .readdirSync(FEATURES_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({
      name,
      source: fs.readFileSync(path.join(FEATURES_DIR, name), "utf8"),
    }))
    .filter((file) => isAIFeature(file.source));
}

describe("止まっているAIを起こす導線を全機能に揃える", () => {
  test("許可した場所のほかは、すべて confirmProviderReachable を呼んでいる", () => {
    const missing = aiFeatureFiles()
      .filter((file) => !file.source.includes("confirmProviderReachable("))
      .filter((file) => !ALLOWED_WITHOUT_REACHABILITY.has(file.name))
      .map((file) => file.name);

    // 落ちたら：`ensureConfigured` のあと、AIを呼ぶ前に1回だけ
    //   await confirmProviderReachable(resolved.provider, "操作の名前", resolved.model)
    // を挟み、false なら中止する。**費用の確認（confirmPaidUsage など）
    // より前**に置くこと——繋がらないと分かっているのに料金の話をしても
    // 意味がない。**AIを1回も呼ばない回（すべてキャッシュ済みなど）には
    // 出さない**（`checkTypos.ts` が `pending.length > 0` のときだけ
    // 呼んでいるのと同じ）
    expect(missing).toEqual([]);
  });

  test("呼んでいるファイルが実際に多数ある（検査が空振りしていない）", () => {
    // 読み取りが壊れて0件になっても、上のテストは通ってしまう
    const wired = aiFeatureFiles().filter((file) =>
      file.source.includes("confirmProviderReachable(")
    );
    expect(wired.length).toBeGreaterThanOrEqual(10);
  });

  test("モデル名を渡している（LM Studioを起こした直後の読み込みに要る）", () => {
    /*
      **引数は3つ。** モデル名を省くと、LM Studioをこの場から起こした
      あと誰も読み込まず、LM Studioが自分の既定（短い文脈）で載せる。
      設定には前回の長い値（131072など）が残っているので、その長さで
      チャンクを切ったまま送り、**入力が黙って切り捨てられる**
      （`aiConnectivity.ts` の `model` 引数の説明）。
    */
    const twoArgOnly: string[] = [];
    // 定義元（`aiConnectivity.ts`）はこの一覧に入らない。AIを呼ばず、
    // 自分でAIを選びもしないので `isAIFeature` に当たらない
    for (const file of aiFeatureFiles()) {
      for (const call of callArguments(file.source, "confirmProviderReachable(")) {
        // 引数の区切りはトップレベルのカンマの数で数える
        if (topLevelCommas(call) < 2) {
          twoArgOnly.push(`${file.name}: ${call.replace(/\s+/g, " ").trim()}`);
        }
      }
    }
    expect(twoArgOnly).toEqual([]);
  });

  test("許可リストは、実際に呼んでいないファイルだけを挙げる", () => {
    // 直したのに許可リストへ残り続けると、次の抜けを隠してしまう
    const without = new Set(
      aiFeatureFiles()
        .filter((file) => !file.source.includes("confirmProviderReachable("))
        .map((file) => file.name)
    );
    for (const allowed of ALLOWED_WITHOUT_REACHABILITY.keys()) {
      expect(without).toContain(allowed);
    }
  });
});

/** `needle` で始まる呼び出しの、括弧の中身を切り出す */
function callArguments(source: string, needle: string): string[] {
  const found: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at === -1) break;

    const open = at + needle.length - 1;
    let depth = 0;
    let end = open;
    for (let i = open; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    found.push(source.slice(open + 1, end));
    from = end + 1;
  }
  return found;
}

/** 入れ子の括弧・波括弧・角括弧の中を数えずに、区切りのカンマだけ数える */
function topLevelCommas(args: string): number {
  let depth = 0;
  let count = 0;
  for (const ch of args) {
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) count++;
  }
  return count;
}
