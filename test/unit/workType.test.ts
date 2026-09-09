import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE,
  MANUSCRIPT_EDITOR_VIEW_TYPE,
  manuscriptViewTypeFor,
} from "../../src/core/manuscriptViewTypes";
import {
  episodeListLabel,
  episodeUnit,
  formatChapterLabel,
} from "../../src/core/episodeLabel";
import {
  firstEpisodeFileName,
  newEpisodeExtension,
  newEpisodeTemplate,
} from "../../src/core/episodeTemplate";
import { skipsStartModeQuestion } from "../../src/features/startWork";
import { updatePlotMarkdown } from "../../src/core/plotDoc";
import { nextUntitledName } from "../../src/core/episodeParser";
import { WORK_FORMATS, type WorkFormatKey } from "../../src/core/workFormat";
import { matchWorkFormat } from "../../src/core/workFormatStore";
import { workTypeColumn } from "../../src/core/workTypeVisibility";
import type { EpisodeFile } from "../../src/models/types";

/**
 * 作品タイプ「創作メモ集」「脚本」（設計書6.70）。
 *
 * **タイプは新しい入れ物ではない。** いままでの「形式」（プロットの
 * `## 形式`）に2つ足したものである。判定の写しを作らないよう、
 * ここで確かめるのも既存の仕組み（`matchWorkFormat` ／ `episodeUnit`）に
 * 足した振る舞いだけにする。
 */

function episode(
  overrides: Partial<Pick<EpisodeFile, "kind" | "chapterStart" | "chapterEnd">>
): Pick<EpisodeFile, "kind" | "chapterStart" | "chapterEnd"> {
  return { kind: "本編", chapterStart: 3, chapterEnd: null, ...overrides };
}

describe("タイプの保存と読み出し", () => {
  test("選択肢に「創作メモ集」と「脚本」がある", () => {
    // 保存先はプロットの `## 形式` ひとつ。選択肢に無いものは
    // `setPlotBasics`（形式とジャンルを決める）からは選べない
    const labels = WORK_FORMATS.map((format) => format.label);

    expect(labels).toContain("創作メモ集");
    expect(labels).toContain("脚本");
  });

  test("プロットに書かれたタイプを読める", () => {
    expect(matchWorkFormat("創作メモ集")).toBe("memo");
    expect(matchWorkFormat("脚本")).toBe("script");
  });

  test("但し書きが添えてあっても読める", () => {
    // 作者が手で書き換える文書なので、完全一致しか拾えないのでは困る。
    // **これが「後から変更できる」道でもある**——プロットの1行を書き換えれば
    // 次に読んだときのタイプが変わる（入口は「形式とジャンルを決める」）
    expect(matchWorkFormat("脚本（30分ドラマ）")).toBe("script");
    expect(matchWorkFormat("いまのところ創作メモ集")).toBe("memo");
  });

  test("これまでのタイプの読み取りは変わらない", () => {
    expect(matchWorkFormat("短編集")).toBe("shortCollection");
    expect(matchWorkFormat("SNS記事")).toBe("sns");
    expect(matchWorkFormat("大長編")).toBe("epic");
    expect(matchWorkFormat("まだ決めていません")).toBeUndefined();
  });
});

describe("数えるものの呼び方", () => {
  test("創作メモ集の単位は「メモ」", () => {
    // 続きものではないので「第3話」とは言わない（SNS記事と同じ側）
    expect(episodeUnit("memo").noun).toBe("メモ");
    expect(formatChapterLabel(episode({}), "memo")).toBe("メモ3");
  });

  test("脚本の単位は「話」のまま", () => {
    // 第◯話＝1回ぶんの台本。数え方は小説と同じ
    expect(episodeUnit("script").noun).toBe("話");
    expect(formatChapterLabel(episode({}), "script")).toBe("第3話");
  });
});

describe("創作メモ集は、題名だけのファイルが自然に並ぶ", () => {
  const memo = { fileName: "海辺の会話.md" };

  test("番号の無いファイルは、題名を見出しにする", () => {
    // メモに番号は要らない。拡張子まで出すと、一覧が書類の並びに見える
    expect(episodeListLabel(memo, "", "memo")).toBe("海辺の会話");
  });

  test("番号のあるファイルは、これまでどおり番号を見出しにする", () => {
    expect(episodeListLabel(memo, "メモ3", "memo")).toBe("メモ3");
  });

  test("他のタイプでは、これまでどおりファイル名を出す", () => {
    // 小説で番号の読めないファイルは**不備**なので、拡張子ごと出して
    // 「そのままの名前」を見せる（直す手掛かりになる）
    expect(episodeListLabel(memo, "", "long")).toBe("海辺の会話.md");
    expect(episodeListLabel(memo, "", undefined)).toBe("海辺の会話.md");
  });
});

describe("新しいメモの名前", () => {
  test("題名だけの名前がぶつからないように連番を足す", () => {
    expect(nextUntitledName([], "無題", ".md")).toBe("無題.md");
    expect(nextUntitledName(["無題.md"], "無題", ".md")).toBe("無題2.md");
    expect(nextUntitledName(["無題.md", "無題2.md"], "無題", ".md")).toBe(
      "無題3.md"
    );
  });

  test("拡張子が違えば別の名前として扱わない", () => {
    // 「無題.txt」があるのに「無題.md」を勧めると、同じ題のメモが2つ並ぶ
    expect(nextUntitledName(["無題.txt"], "無題", ".md")).toBe("無題2.md");
  });
});

describe("脚本の雛形", () => {
  test("柱・ト書き・セリフの形が入っている", () => {
    const body = newEpisodeTemplate("script");

    // 柱（場面の見出し）は「○」で始める
    expect(body).toContain("○");
    expect(body).toContain("ト書き");
    // 「役名「セリフ」」の形
    expect(body).toMatch(/^.+「.+」$/m);
  });

  test("他のタイプでは、これまでどおり空のファイルを作る", () => {
    for (const format of [
      "short",
      "long",
      "epic",
      "shortCollection",
      "sns",
      "memo",
      undefined,
    ] as Array<WorkFormatKey | undefined>) {
      expect(newEpisodeTemplate(format), String(format)).toBe("");
    }
  });
});

describe("創作メモ集は、最初のメモから始める", () => {
  test("始め方（プロット／本文）を訊かない", () => {
    // プロットの無いタイプなので選びようがない。訊かずにメモを開く
    expect(skipsStartModeQuestion("memo")).toBe(true);
  });

  test("他のタイプでは、これまでどおり訊く", () => {
    for (const format of ["long", "script", "sns", undefined] as Array<
      WorkFormatKey | undefined
    >) {
      expect(skipsStartModeQuestion(format), String(format)).toBe(false);
    }
  });

  test("最初の1件は「無題.md」", () => {
    expect(
      firstEpisodeFileName("memo", { digits: 3, extension: ".txt" })
    ).toBe("無題.md");
  });

  test("他のタイプは、これまでどおり番号から始める", () => {
    expect(firstEpisodeFileName(undefined, { digits: 3, extension: ".txt" })).toBe(
      "001.txt"
    );
    expect(firstEpisodeFileName("script", { digits: 4, extension: ".md" })).toBe(
      "0001.md"
    );
  });

  test("メモの拡張子は .md（設定は原稿の話であって、メモの話ではない）", () => {
    expect(newEpisodeExtension("memo", ".txt")).toBe(".md");
    // 2件目以降（新規メモを追加）も同じ決まりを通すので、並びが揃う
    expect(newEpisodeExtension("long", ".txt")).toBe(".txt");
    expect(newEpisodeExtension(undefined, ".md")).toBe(".md");
  });

  test("形式のためのプロットは、「形式」の節だけになる", () => {
    // **メモ集にプロットの見出し一式は並べない。** タイプを書き留める
    // 器としてだけ作る（`updatePlotMarkdown` は頼まれた節しか書かない）
    const plot = updatePlotMarkdown(
      "",
      { format: "創作メモ集" },
      { workTitle: "夜の断片" }
    );

    expect(plot).toContain("## 形式");
    expect(plot).toContain("創作メモ集");
    expect(plot).not.toContain("## ログライン");
    expect(plot).not.toContain("## あらすじ");
  });
});

describe("脚本は縦書きで開く", () => {
  test("脚本の本文は縦書きの入口で開く", () => {
    expect(manuscriptViewTypeFor("script")).toBe(MANUSCRIPT_EDITOR_VIEW_TYPE);
  });

  test("他のタイプは、これまでどおり横書き", () => {
    for (const format of ["long", "sns", "memo", undefined] as Array<
      WorkFormatKey | undefined
    >) {
      expect(manuscriptViewTypeFor(format), String(format)).toBe(
        MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE
      );
    }
  });
});

/**
 * 配線（タイプを決める・変える入口）。
 *
 * **純関数の話は「読めれば正しく振る舞う」までしか言っていない。**
 * 決めたタイプを覚え直させているかは、呼ぶ側のコードにしか無い。
 */
describe("タイプを決める・変える配線", () => {
  const source = (): string => readFileSync("src/extension.ts", "utf8");

  test("新規作品では、タイプを訊いてプロットへ書く", () => {
    const create = source().slice(source().indexOf("async function createNewWork"));

    expect(create.slice(0, 3000)).toContain("chooseWorkType(");
    // 在り処はプロットの `## 形式` ひとつ。別の台帳を作らない
    expect(create.slice(0, 3000)).toContain("writePlotSections(entry");
  });

  test("創作メモ集では、始め方を訊かずに本文（メモ）から始める", () => {
    const create = source().slice(source().indexOf("async function createNewWork"));

    expect(create.slice(0, 3000)).toContain("skipsStartModeQuestion(format)");
  });

  test("読み上げ・行へ飛ぶときも、入口はタイプで決める", () => {
    // **向きの決め方を増やさない**（作品一覧・新規作成と同じ関数を通す）
    const editor = readFileSync("src/features/manuscriptEditor.ts", "utf8");
    const reading = editor.slice(
      editor.indexOf("export async function openManuscriptForReading")
    );
    const reveal = editor.slice(editor.indexOf("async revealLine("));

    expect(reading.slice(0, 1500)).toContain("manuscriptViewTypeFor(");
    expect(reveal.slice(0, 1200)).toContain("manuscriptViewTypeFor(");
  });

  test("形式を決め直したら、覚えている形式を捨てる", () => {
    // 捨てないと、一覧も右クリックもステップも前のタイプのままで、
    // **変えたのに何も起きていないように見える**
    const command = source().slice(
      source().indexOf('"novelai.setPlotBasics"')
    );

    expect(command.slice(0, 1200)).toContain("invalidateWorkFormat(work.id)");
    expect(command.slice(0, 1200)).toContain("stepProvider.invalidateFormats(");
  });
});

describe("タイプの束ね方（表と右クリックが使う列）", () => {
  test("小説の4つの形式は、1つの列にまとめる", () => {
    for (const format of [
      "short",
      "shortCollection",
      "long",
      "epic",
    ] as WorkFormatKey[]) {
      expect(workTypeColumn(format), format).toBe("novel");
    }
  });

  test("SNS記事・創作メモ集・脚本は、それぞれ別の列", () => {
    expect(workTypeColumn("sns")).toBe("sns");
    expect(workTypeColumn("memo")).toBe("memo");
    expect(workTypeColumn("script")).toBe("script");
  });

  test("決めていない作品は、どの列でもない", () => {
    // **「決めていない」を「小説と決めた」と読み替えない。**
    // 絞り込みをしない（全部見せる）ための印である
    expect(workTypeColumn(undefined)).toBeUndefined();
  });
});
