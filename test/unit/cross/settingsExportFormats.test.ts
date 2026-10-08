import { unzipSync, strFromU8 } from "fflate";
import { describe, expect, test } from "vitest";
import {
  buildExportDocument,
  EXPORT_AUDIENCES,
  renderExportMarkdown,
} from "../../../src/core/settingsExportProfiles";
import { buildExportHtml } from "../../../src/core/settingsExportHtml";
import { buildExportCsvFiles } from "../../../src/core/settingsExportCsv";
import { buildExportDocx } from "../../../src/core/settingsExportDocx";
import { snapshotOf } from "../../../src/core/settingsExportDiff";
import {
  AUTHOR_NOTE_TEXT,
  FIXTURE_OPTIONS,
  HIDDEN_NAME,
  fixtureData,
} from "../support/settingsExportFixture";

/**
 * 形式を増やしても、伏せるものは伏せたまま（F6、設計書6.75.1）。
 *
 * 0.32.6・0.32.8 では、Markdown の書き出しから**作者だけの印の人物の名前**と
 * **まだ出ていない人物**が、関係・呼称・使い手の欄を通って漏れていた。
 * 形式ごとに判断を書けば、同じ穴が形式の数だけ開く。ここでは**同じ材料を
 * 全形式に通し**、Markdown に出ないものがどこにも出ないことを見る。
 */

function allFormats(audience: (typeof EXPORT_AUDIENCES)[number], chapter: number | null) {
  const document = buildExportDocument(audience, fixtureData(), {
    ...FIXTURE_OPTIONS,
    chapter,
  });
  const docx = unzipSync(buildExportDocx(document));
  return {
    markdown: renderExportMarkdown(document),
    html: buildExportHtml(document),
    csv: buildExportCsvFiles(document)
      .map((file) => file.content)
      .join("\n"),
    word: strFromU8(docx["word/document.xml"]),
    snapshot: JSON.stringify(snapshotOf(document, FIXTURE_OPTIONS.at)),
  };
}

describe("伏せるものは、どの形式にも出ない", () => {
  for (const audience of EXPORT_AUDIENCES) {
    for (const chapter of [null, 3]) {
      const label = `${audience}・${chapter === null ? "全話" : `第${chapter}話まで`}`;

      test(`${label}：作者だけの印の人物と、作者のメモ`, () => {
        for (const [format, text] of Object.entries(allFormats(audience, chapter))) {
          expect(text, `${format} に作者だけの人物`).not.toContain(HIDDEN_NAME);
          expect(text, `${format} に作者のメモ`).not.toContain(AUTHOR_NOTE_TEXT);
        }
      });
    }
  }

  test("第3話までなら、第9話で初めて出る人物はどの形式にも出ない", () => {
    for (const [format, text] of Object.entries(allFormats("editorial", 3))) {
      expect(text, format).not.toContain("白鳥");
      // 時点で絞ったら、いつ書かれたか分からない補足も出さない
      expect(text, format).not.toContain("資料向けの補足");
    }
  });

  test("全話ぶんの編集部向けなら、その人物も補足も出る（材料が効いている証拠）", () => {
    for (const [format, text] of Object.entries(allFormats("editorial", null))) {
      expect(text, format).toContain("白鳥");
      expect(text, format).toContain("資料向けの補足");
    }
  });
});
