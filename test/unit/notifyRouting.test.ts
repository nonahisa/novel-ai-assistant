import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * 「その場限りの完了」を、通知センターへ積まない（0.35.3〜0.35.4）。
 *
 * 行き先の決まりは `src/views/notify.ts` の冒頭に書いてある。
 * ここで見るのは**移し忘れ**のほうである。0.35.3 で大半を
 * `notifyDone` へ移したが、4か所が `showInformationMessage` のまま
 * 残っていた（伏線への登録・解消の確認・コピー・コンテキスト長）。
 *
 * **画面ごとの単体テストでは拾えない。** ルビの変換やLM Studioの
 * 設定は、画面を組み立てる部品が多くて単体では動かせないので、
 * **書いてあるコードの形**で見る。
 */
function read(relative: string): string {
  return readFileSync(
    path.join(__dirname, "..", "..", "src", relative),
    "utf8"
  );
}

/**
 * その呼び出しに渡している文字列の塊を取り出す。
 *
 * 文言は複数行に分けて書かれることがある（`"…（" + "…）"`）ので、
 * **開き括弧から最初の `);` まで**をひとまとまりとして見る。
 * 1行で書かれていても同じ形で拾える。
 */
function callArguments(source: string, callee: string): string[] {
  const pattern = new RegExp(`${callee}\\(([\\s\\S]*?)\\);`, "g");
  return [...source.matchAll(pattern)].map((m) => m[1]);
}

/** ステータスバーへ出している塊 */
function doneCalls(source: string): string[] {
  return callArguments(source, "notifyDone");
}

/** 通知センターへ出している塊（こちらに入っていたら移し忘れ） */
function infoCalls(source: string): string[] {
  return callArguments(source, "showInformationMessage");
}

const CASES: ReadonlyArray<{
  label: string;
  file: string;
  fragment: string;
}> = [
  {
    label: "矛盾を伏線として登録した",
    file: "features/proposalPanel.ts",
    fragment: "伏線として登録しました",
  },
  {
    label: "矛盾の解消を確かめた",
    file: "features/proposalPanel.ts",
    fragment: "解消を確認しました",
  },
  {
    label: "投稿サイト用に変換してコピーした",
    file: "features/ruby.ts",
    fragment: "クリップボードへ入れました",
  },
  {
    label: "LM Studioのコンテキスト長を決めた",
    file: "features/setupLmStudio.ts",
    fragment: "コンテキスト長を ",
  },
];

describe("その場限りの完了の行き先", () => {
  for (const { label, file, fragment } of CASES) {
    test(`${label} → ステータスバー（${file}）`, () => {
      const source = read(file);
      // まず、その文言がまだ在ることを確かめる（**文言は変えない**決まり）
      expect(source).toContain(fragment);

      expect(
        doneCalls(source).some((call) => call.includes(fragment))
      ).toBe(true);
      expect(
        infoCalls(source).some((call) => call.includes(fragment))
      ).toBe(false);
    });
  }
});
