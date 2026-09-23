import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import {
  describeMissingEpisodes,
  missingEpisodeFiles,
} from "../../../src/core/backupMissingEpisodes";
import { planBackupMerge } from "../../../src/core/backupMerge";
import { parseCollectedFile } from "../../../src/core/collectedFile";
import { inspectWorkBackup } from "../../../src/core/workZip";
import { emptyPostingLedger } from "../../../src/models/posting";

/**
 * バックアップにあって手元に無い話を、新しい話のファイルとして足す材料
 * （作者の裁定、2026-09-23。設計書6.99.7）。
 *
 * 中身は**既にある道と同じ形**にする——なろうの合本は「合本を話ごとに
 * 分ける」と同じ切り方（区切り行ごと・後書きやリアクションも落とさない）、
 * カクヨムは中のファイルをそのまま。どちらも、次にバックアップを落としたときに
 * 同じ話として照らせることまで確かめる。
 */

const SEP = (n: number) =>
  `------------------------- エピソード${n}開始 -------------------------`;

function narouText(n: number): string {
  const blocks: string[] = [];
  for (let i = 1; i <= n; i++) {
    blocks.push(
      SEP(i),
      ...(i === 3 ? ["【第2章】", "学園", ""] : []),
      "【エピソードタイトル】",
      `${i}話　第${i}の題`,
      "",
      "【本文】",
      `　${i}話の本文。`,
      "",
      "【後書き】",
      `　${i}話の後書き。`,
      "",
      "【リアクション】",
      `いいね: ${i}件`,
      ""
    );
  }
  return ["【Nコード】", "N5078JI", "", "【タイトル】", "眠りから覚めたら", "", ...blocks].join(
    "\n"
  );
}

function narou(n: number) {
  return inspectWorkBackup(
    zipSync({ "N5078JI.txt": new TextEncoder().encode(narouText(n)) }),
    "N5078JI.zip"
  );
}

describe("なろうの合本から、手元に無い話を切り出す", () => {
  it("区切り行から次の区切り行の手前までを、後書き・リアクションごと使う", () => {
    const inspection = narou(3);
    const result = missingEpisodeFiles(inspection, [
      { order: 3, label: "3話　第3の題", part: "学園", fileName: null },
    ]);

    expect(result.skipped).toEqual([]);
    expect(result.files).toHaveLength(1);
    const [file] = result.files;
    expect(file).toMatchObject({
      order: 3,
      number: 3,
      part: "学園",
      renamable: true,
      // 手元の流儀が読めないときは「合本を話ごとに分ける」と同じ名前
      defaultFileName: "episode_0003_第3の題.txt",
    });
    if (file.content.kind !== "text") throw new Error("文字列のはず");
    expect(file.content.text.startsWith(SEP(3))).toBe(true);
    expect(file.content.text).toContain("　3話の後書き。");
    expect(file.content.text).toContain("いいね: 3件");
    expect(file.content.text).not.toContain("2話の本文");
  });

  it("**足した話は、次にバックアップを落としたとき同じ話として照らせる**（区切り行が残る）", () => {
    const inspection = narou(3);
    // 3話とも手元に無いとして切り出し、それを手元の原稿として置いてから、もう一度比べる
    const files = missingEpisodeFiles(
      inspection,
      [1, 2, 3].map((n) => ({ order: n, label: `${n}話`, part: null, fileName: null }))
    ).files;
    const local = files.map((file) => {
      if (file.content.kind !== "text") throw new Error("文字列のはず");
      expect(parseCollectedFile(file.content.text)?.map((episode) => episode.order)).toEqual([
        file.order,
      ]);
      return {
        relPath: `本文/${file.defaultFileName}`,
        manuscriptName: file.defaultFileName,
        text: file.content.text,
      };
    });
    const again = planBackupMerge({
      inspection,
      local,
      existingChapters: [],
      ledger: emptyPostingLedger(),
      readAt: "2026-09-23T00:00:00.000Z",
    });
    expect(again.missingEpisodes).toEqual([]);
    expect(again.bodyDiffs).toEqual([]);
  });
});

describe("カクヨムの話ごとのファイル", () => {
  it("中のファイルを同じ名前・同じバイト列で使う（名前は変えない）", () => {
    const bytes = new TextEncoder().encode("【タイトル】\n再会\n\n　本文。\n");
    const inspection = inspectWorkBackup(
      zipSync({
        "作品/about.txt": new TextEncoder().encode("【タイトル】\n作品\n"),
        "作品/episode_0001.txt": new TextEncoder().encode("【タイトル】\n出会い\n\n　本文。\n"),
        "作品/episode_0002.txt": bytes,
      }),
      "kakuyomu.zip"
    );
    const name = inspection.files.find((file) => file.name.endsWith("episode_0002.txt"))?.name;
    expect(name).toBeDefined();

    const result = missingEpisodeFiles(inspection, [
      { order: 2, label: "再会", part: null, fileName: name ?? "" },
    ]);

    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ defaultFileName: name, renamable: false });
    expect(result.files[0].content).toEqual({ kind: "bytes", bytes });
  });

  it("中に見当たらなければ、理由をつけて外す（黙って落とさない）", () => {
    const result = missingEpisodeFiles(narou(1), [
      { order: 9, label: "9話", part: null, fileName: "無い.txt" },
    ]);

    expect(result.files).toEqual([]);
    expect(result.skipped).toEqual([
      { label: "9話", reason: "バックアップの中にファイルが見当たりません" },
    ]);
  });
});

describe("確認画面の一覧", () => {
  it("題を並べ、多いときは残りを数で言う", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ label: `${i + 1}話` }));

    const lines = describeMissingEpisodes(many);

    expect(lines[0]).toBe(
      "・手元に無い話：12話。新しい話のファイルとして足します（既存の話には触りません）"
    );
    expect(lines).toContain("　・10話");
    expect(lines).not.toContain("　・11話");
    expect(lines[lines.length - 1]).toBe("　ほか2話");
  });

  it("無ければ何も言わない", () => {
    expect(describeMissingEpisodes([])).toEqual([]);
  });
});
