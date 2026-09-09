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

/**
 * 逆向きの見張り（2026-09-06）。**手順の案内は、6秒で消してはいけない。**
 *
 * 0.35.3〜0.35.5 で完了をステータスバーへ移したとき、規則3（あとで読み
 * 返す価値のあるもの＝通知のまま）に当たるものが2件まぎれ込んでいた。
 * どちらも「このあとどうするか」を書いてあり、読み切る前に消える。
 *
 * ここでも**文言は変えない**（作者が覚えている言葉を壊さない）。
 */
const KEPT_AS_NOTIFICATION: ReadonlyArray<{
  label: string;
  file: string;
  /** その文言がまだ在ることの確認（消していないか） */
  fragment: string;
  /** 出している呼び出しを見分ける手がかり */
  marker: string;
}> = [
  {
    label: "機能別AI割当の注意文（課金・軽量モデル）",
    file: "features/assignFeatureAI.ts",
    fragment: "実行のたびに課金されます",
    marker: "notes.join",
  },
  {
    label: "モード切り替えの戻し方の案内",
    file: "features/switchMode.ts",
    fragment: "戻すときは、同じ操作をもう一度選んでください。",
    marker: "戻すときは、同じ操作をもう一度選んでください。",
  },
];

describe("次の操作の案内つきは通知のまま", () => {
  for (const { label, file, fragment, marker } of KEPT_AS_NOTIFICATION) {
    test(`${label} → 通知（${file}）`, () => {
      const source = read(file);
      expect(source).toContain(fragment);

      expect(infoCalls(source).some((call) => call.includes(marker))).toBe(
        true
      );
      expect(doneCalls(source).some((call) => call.includes(marker))).toBe(
        false
      );
    });
  }
});

/**
 * **確認は、トーストにボタンを載せて出さない**（設計書6.81。
 * 作者の指摘、2026-09-06）。
 *
 * 「前回の検知のあとに書いた話はありません。」＋「作品全体を見る」の通知が
 * 数秒で閉じ、**押したつもりが空クリックになった。** 実機確認でも一度、
 * 実行されていないのを不具合と読み違えかけている。
 *
 * 完了の知らせ（「結果が届きました」）はこれまでどおりでよい。
 * 直すのは**返事を待っているもの**だけである。
 */
describe("検知の入口の確認は、モーダルで訊く", () => {
  /** `confirmRun` を通しているか（＝モーダル。`views/notify.ts`） */
  function confirmCalls(source: string): string[] {
    return callArguments(source, "confirmRun");
  }

  test("誤字脱字の対象範囲：話が無いときの「作品全体を見る」", () => {
    const source = read("features/typoCheckScope.ts");
    const fragment = "前回の検知のあとに書いた話はありません。";

    // **文言は変えない**（作者が覚えている言葉を壊さない）
    expect(source).toContain(fragment);
    expect(
      confirmCalls(source).some((call) => call.includes(fragment))
    ).toBe(true);
    // トーストにボタンを載せる形へ戻っていないこと
    expect(infoCalls(source).some((call) => call.includes(fragment))).toBe(
      false
    );
  });

  test("単話プロットが無いときの案内は、もともとモーダル", () => {
    // 同じ形（トーストにボタン）が他に無いことの見張り。ここは
    // `{ modal: true }` を渡しているので、そのままでよい
    const source = read("features/checkEpisodePlot.ts");
    const call = infoCalls(source).find((entry) =>
      entry.includes("単話プロットがまだ1つもありません。")
    );

    expect(call).toBeDefined();
    expect(call).toContain("modal: true");
  });
});
