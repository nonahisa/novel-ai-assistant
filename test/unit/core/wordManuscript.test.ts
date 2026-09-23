import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import {
  bodyFingerprint,
  inspectionFromWord,
  matchWordToWorks,
  readWordManuscript,
  wordBodyHead,
  type WordMatchWork,
} from "../../../src/core/wordManuscript";
import {
  isDroppableFileName,
  isWordFileName,
} from "../../../src/core/backupFileKinds";

/**
 * 相談パネルへ落とされた Word 原稿（.docx）を読み、既存作品の続きかを照らす
 * （作者の裁定、2026-09-23「相談パネルドロップにも対応してください。相談パネルが
 * 既存作の続きでも、わかれば対応できるようにしてください」）。
 *
 * **当たりと外れの両方を見る**——当てにいくほうだけ試すと、何にでも当たる
 * 実装が満点になる。
 */

const encoder = new TextEncoder();

function docx(paragraphs: Array<{ text: string; heading?: boolean }>): Uint8Array {
  const inner = paragraphs
    .map(
      (p) =>
        `<w:p>${p.heading ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' : ""}` +
        `<w:r><w:t>${p.text}</w:t></w:r></w:p>`
    )
    .join("");
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${inner}</w:body></w:document>`;
  return zipSync({ "word/document.xml": encoder.encode(xml) });
}

const EPISODE = docx([
  { text: "35話　再会", heading: true },
  { text: "　病室の窓から、見慣れない街が見えていた。" },
  { text: "　僕はゆっくりと体を起こした。" },
]);

function work(
  id: string,
  title: string,
  extra: Partial<WordMatchWork> = {}
): WordMatchWork {
  return {
    id,
    title,
    folderName: title,
    folderPath: `C:/小説/${title}`,
    episodes: [],
    ...extra,
  };
}

describe("受け取れる種類", () => {
  it(".docx を Word 原稿として受け、.doc は受けない", () => {
    expect(isWordFileName("原稿.docx")).toBe(true);
    expect(isWordFileName("原稿.DOCX")).toBe(true);
    expect(isWordFileName("原稿.doc")).toBe(false);
    expect(isDroppableFileName("原稿.docx")).toBe(true);
    expect(isDroppableFileName("N5078JI.zip")).toBe(true);
    expect(isDroppableFileName("画像.png")).toBe(false);
  });
});

describe("読む", () => {
  it("既存の Word 変換（docxToMarkdown）で読み、見出しと題の候補を取る", () => {
    const doc = readWordManuscript(EPISODE, "コールドスリープ 35話.docx");

    expect(doc.markdown).toBe(
      "# 35話　再会\n　病室の窓から、見慣れない街が見えていた。\n　僕はゆっくりと体を起こした。\n"
    );
    expect(doc.heading).toBe("35話　再会");
    expect(doc.baseName).toBe("コールドスリープ 35話");
  });

  it("書き出しは見出しを除いた本文から、ルビ・空白をそろえて取る", () => {
    const doc = readWordManuscript(EPISODE, "a.docx");
    expect(wordBodyHead(doc)).toBe("病室の窓から、見慣れない街が見えていた。僕はゆっくりと体を起こし");
    // ルビの記法（{漢字|かんじ}・|漢字《かんじ》）は親文字だけにそろえる
    expect(bodyFingerprint("{病室|びょうしつ}の｜窓《まど》から")).toBe("病室の窓から");
  });
});

describe("既存作品の続きかを照らす", () => {
  it("**作品フォルダーの中から落とされた**なら、その作品と見る", () => {
    const result = matchWordToWorks({
      titles: ["無関係な名前"],
      head: null,
      sourcePath: "C:/小説/コールドスリープ/下書き/35話.docx",
      works: [work("a", "教科書チート"), work("b", "コールドスリープ")],
    });

    expect(result).toEqual({ kind: "matched", workId: "b", by: "folder" });
  });

  it("ファイル名に作品の題が入っていれば候補にする（決めつけずに選ばせる）", () => {
    const result = matchWordToWorks({
      titles: ["35話　再会", "コールドスリープ 35話"],
      head: null,
      sourcePath: null,
      works: [work("a", "教科書チート"), work("b", "コールドスリープ")],
    });

    expect(result).toEqual({ kind: "ambiguous", workIds: ["b"], by: "partial" });
  });

  it("題がそのまま一致すれば当たり", () => {
    const result = matchWordToWorks({
      titles: ["コールドスリープ"],
      head: null,
      sourcePath: null,
      works: [work("a", "教科書チート"), work("b", "コールドスリープ")],
    });

    expect(result).toEqual({ kind: "matched", workId: "b", by: "title" });
  });

  it("**書き出しが既にある話と同じなら「既にある話」と見る**（新しい話として足さない）", () => {
    const doc = readWordManuscript(EPISODE, "原稿.docx");
    const result = matchWordToWorks({
      titles: ["原稿"],
      head: wordBodyHead(doc),
      sourcePath: null,
      works: [
        work("a", "教科書チート", {
          episodes: [{ relPath: "本文/001.txt", fingerprint: bodyFingerprint("　まったく別の話。") }],
        }),
        work("b", "コールドスリープ", {
          episodes: [
            {
              relPath: "本文/エピソード35.txt",
              fingerprint: bodyFingerprint(
                "35話\n\n　病室の窓から、見慣れない街が見えていた。\n　僕はゆっくりと体を起こした。\n"
              ),
            },
          ],
        }),
      ],
    });

    expect(result).toEqual({ kind: "already", workId: "b", relPath: "本文/エピソード35.txt" });
  });

  it("**手掛かりが無ければ、どの作品にも当てない**（題が短い・書き出しが短い）", () => {
    const result = matchWordToWorks({
      titles: ["原稿", "夏"],
      head: "短い",
      sourcePath: "C:/Users/me/Downloads/原稿.docx",
      works: [
        work("a", "夏", {
          episodes: [{ relPath: "本文/001.txt", fingerprint: bodyFingerprint("短い話") }],
        }),
      ],
    });

    // 「夏」は題の完全一致なので当たる——短い題の**部分一致**だけを外す
    expect(result).toEqual({ kind: "matched", workId: "a", by: "title" });

    const none = matchWordToWorks({
      titles: ["原稿"],
      head: "短い",
      sourcePath: "C:/Users/me/Downloads/原稿.docx",
      works: [
        work("a", "夏の終わりに", {
          episodes: [{ relPath: "本文/001.txt", fingerprint: bodyFingerprint("短い話") }],
        }),
      ],
    });
    expect(none).toEqual({ kind: "none" });
  });
});

describe("新しい作品として取り込むときの形", () => {
  it("6.99 の取り込みへ渡せる形にする（1ファイル・.md・題はファイル名から）", () => {
    const doc = readWordManuscript(EPISODE, "新しい物語(2).docx");

    const inspection = inspectionFromWord(doc);

    expect(inspection.title).toBe("新しい物語");
    expect(inspection.titleSource).toBe("fileName");
    expect(inspection.episodeCount).toBe(1);
    expect(inspection.files.map((file) => file.name)).toEqual(["新しい物語.md"]);
    expect(new TextDecoder().decode(inspection.files[0].bytes)).toBe(doc.markdown);
    expect(inspection.narou).toBeNull();
    expect(inspection.site).toBeNull();
  });
});
