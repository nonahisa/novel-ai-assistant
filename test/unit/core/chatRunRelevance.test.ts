import { describe, expect, test } from "vitest";
import { relatedChatRun } from "../../../src/core/chatIntent";
import { runnableFeatures } from "../../../src/core/chatEdit";

/**
 * 相談の答えに付く「実行ボタン」（`run`）が、質問と関係のある操作か
 * （2026-09-25 深夜の実接続の測定。引継ぎ書8章「2巡目」の不具合2）。
 *
 * ## 何が起きたか
 *
 * `run` は**AIが選んで返す**。コードは「許可した一覧にあるか」
 * （`parseChatRun`）しか見ていなかったので、一覧にありさえすれば、
 * 質問と無関係でもボタンになった。実測では——
 *
 * - 読者層の質問に、e4b が `checkTypos`・`checkTyposForFile`（誤字脱字）、
 *   26b が `suggestContests`（応募先）
 * - 読み上げの質問に、e4b が `checkProofread`（推敲）・`checkTyposForFile`
 *
 * **AIの出力は信用しない**（実装ルール3）。質問の言葉に、その操作の話題の
 * 語が1つも無ければ落とす。
 */
describe("実測で出た、質問と無関係な実行ボタン", () => {
  const cases: Array<[string, string]> = [
    ["読者層を決めたいんですが、どうすればいいですか？", "checkTyposForFile"],
    ["読者層を決めたいんですが、どうすればいいですか？", "checkTypos"],
    ["読者層を決めたいんですが、どうすればいいですか？", "suggestContests"],
    ["原稿を読み上げる機能はありますか？", "checkProofread"],
    ["原稿を読み上げる機能はありますか？", "checkTyposForFile"],
    [
      "この作品をどんな人に読んでほしいか、まだ決めていません。決めたほうがいいですか？",
      "generateWorkBlurb",
    ],
  ];

  for (const [question, run] of cases) {
    test(`「${question}」に ${run} を出さない`, () => {
      expect(relatedChatRun(run, [question])).toBeUndefined();
    });
  }
});

/**
 * **反対側も測る。** 落としすぎると、頼まれた作業のボタンまで消える
 * （「抽出して」と頼んだのにボタンが出ない、が 2026-08-15 に実機で続いた）。
 */
describe("質問と関係のある実行ボタンは残す", () => {
  const cases: Array<[string, string]> = [
    ["誤字脱字を見てほしい", "checkTypos"],
    ["この話の誤字をチェックして", "checkTyposForFile"],
    // 選択肢のボタンを押すと、その文がそのまま質問になる
    ["作品全体の誤字脱字をチェックしてほしい", "checkTypos"],
    ["表記の揺れを揃えたい", "checkNotation"],
    ["文章を推敲してほしい", "checkProofread"],
    ["設定と本文の矛盾を見つけて", "checkContradictions"],
    ["プロットから外れていないか見て", "checkDeviations"],
    ["設定資料をまとめて作って", "extractSettings"],
    ["登場人物を抽出して", "extractCharacters"],
    ["登場人物を抽出して", "extractSettings"],
    ["場所を洗い出して", "extractLocations"],
    ["魔法の一覧がほしい", "extractAbilities"],
    ["ギルドや組織を整理したい", "extractOrganizations"],
    ["世界観をまとめてほしい", "extractWorld"],
    ["設定資料集を出力して", "generateSettingsDocs"],
    ["設定資料を開いて", "openSettingsPanel"],
    ["重複している人物をまとめて", "unifyCharacters"],
    ["承認待ちの更新を反映して", "applyPendingUpdates"],
    ["各話のあらすじを作って", "generateSynopses"],
    ["作品紹介文を書いて", "generateWorkBlurb"],
    ["キャッチコピーを考えて", "generateCatchphrases"],
    ["紹介文を見せて", "openSynopsisDocs"],
    ["本文からプロットを逆算して", "generatePlot"],
    ["応募先を提案して", "suggestContests"],
    ["どのコンテストに出せばいい？", "suggestContests"],
  ];

  for (const [question, run] of cases) {
    test(`「${question}」に ${run} を残す`, () => {
      expect(relatedChatRun(run, [question])?.kind).toBe(run);
    });
  }

  test("直前の作者の発言に話題があれば残す（「それをお願い」）", () => {
    expect(
      relatedChatRun("checkTypos", ["はい、お願いします", "誤字脱字が気になります"])
        ?.kind
    ).toBe("checkTypos");
  });

  test("大文字小文字の違いは、許可した一覧の照合と同じく吸収する", () => {
    expect(relatedChatRun("CHECKTYPOS", ["誤字を探して"])?.kind).toBe("checkTypos");
  });
});

describe("落とす規則そのもの", () => {
  test("許可した一覧に無いものは、これまでどおり落とす", () => {
    expect(relatedChatRun("deleteWork", ["作品を消して"])).toBeUndefined();
    expect(relatedChatRun(undefined, ["誤字脱字"])).toBeUndefined();
    expect(relatedChatRun(null, ["誤字脱字"])).toBeUndefined();
  });

  test("起動できる操作は、どれも話題の語を持っている", () => {
    // 語を持たない操作は、どんな質問でも必ず落ちる（ボタンが二度と出ない）
    for (const run of runnableFeatures()) {
      expect(
        relatedChatRun(run.kind, [run.label])?.kind,
        `${run.kind}（${run.label}）`
      ).toBe(run.kind);
    }
  });
});
