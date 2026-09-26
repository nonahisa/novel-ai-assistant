import { describe, expect, test } from "vitest";
import {
  detectNotationVariants,
  dialogueOnlySurfaces,
  type NotationSource,
} from "../../../src/core/notationVariants";
import { describeNotationForms } from "../../../src/features/checkNotation";

/**
 * 表記ゆれの一覧で、片方の書き方が**台詞の中にしか出ない**ことを添える
 * （作者の裁定、2026-09-26 夕。残課題 J11）。
 *
 * 6歳の子の台詞だけ「だいじょうぶ」と平仮名にしている、のようなわざとの
 * 書き分けは、一覧の数だけでは見分けられない。**並べ方と件数は変えない**
 * ——拾った組は作者が見て決める。
 */
function source(body: string, filePath = "C:\\work\\001.txt"): NotationSource {
  return { filePath, body, startLine: 1 };
}

const BODY = [
  "ミナは大丈夫だと思った。",
  "「だいじょうぶ？」とミナが聞いた。",
  "兄は大丈夫そうに見えた。",
  "「だいじょうぶだよ、ぜったい」",
].join("\n");

function daijoubu() {
  const groups = detectNotationVariants([source(BODY)], { properNouns: [] });
  const found = groups.find((group) =>
    group.forms.some((form) => form.surface === "だいじょうぶ")
  );
  if (!found) throw new Error("大丈夫の組が見つからない");
  return found;
}

describe("台詞の中だけの書き方（J11）", () => {
  test("平仮名が台詞にだけ、漢字が地の文にあれば、平仮名のほうを挙げる", () => {
    expect(dialogueOnlySurfaces(daijoubu())).toEqual(["だいじょうぶ"]);
  });

  test("一覧の行に「台詞の中だけ（わざとかもしれません）」と添える", () => {
    const line = describeNotationForms(daijoubu());
    expect(line).toContain("だいじょうぶ 2回（台詞の中だけ。わざとかもしれません）");
    // 地の文にも出る書き方には添えない
    expect(line).toContain("大丈夫 2回");
    expect(line).not.toContain("大丈夫 2回（");
  });

  test("並べ方と件数は変えない", () => {
    const group = daijoubu();
    expect(group.forms.map((form) => [form.surface, form.occurrences.length])).toEqual([
      ["大丈夫", 2],
      ["だいじょうぶ", 2],
    ]);
  });

  test("地の文にも1度出ていれば、台詞の中だけとは言わない", () => {
    const groups = detectNotationVariants(
      [source(`${BODY}\nだいじょうぶ、と彼は思った。`)],
      { properNouns: [] }
    );
    const found = groups.find((group) =>
      group.forms.some((form) => form.surface === "だいじょうぶ")
    );
    expect(found && dialogueOnlySurfaces(found)).toEqual([]);
  });

  test("どちらも台詞の中だけなら、書き分けの手がかりにならないので添えない", () => {
    const groups = detectNotationVariants(
      [source("「大丈夫？」\n「だいじょうぶ」")],
      { properNouns: [] }
    );
    const found = groups.find((group) =>
      group.forms.some((form) => form.surface === "だいじょうぶ")
    );
    expect(found && dialogueOnlySurfaces(found)).toEqual([]);
  });

  test("『』の台詞も台詞として数える", () => {
    const groups = detectNotationVariants(
      [source("大丈夫だった。\n『だいじょうぶ』と書いた紙。")],
      { properNouns: [] }
    );
    const found = groups.find((group) =>
      group.forms.some((form) => form.surface === "だいじょうぶ")
    );
    expect(found && dialogueOnlySurfaces(found)).toEqual(["だいじょうぶ"]);
  });
});
