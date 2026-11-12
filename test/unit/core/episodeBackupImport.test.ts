import { zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import {
  backupImportEntries,
  describeBackupImportChoices,
  numberRangeLabel,
  planBackupImport,
} from "../../../src/core/episodeBackupImport";
import { inspectWorkBackup } from "../../../src/core/workZip";

/**
 * 原稿エディターの［入力］→「バックアップから」の判断（0.150.0。設計書6.25.13）。
 * 読み・書きの道は `test/unit/features/manuscriptBackupImport.test.ts`。
 */

const utf8 = (text: string) => new TextEncoder().encode(text);

const KAKUYOMU_ZIP = zipSync({
  "about.txt": utf8(["【タイトル】", "星の街", "", "【紹介文】", "街の話。", ""].join("\n")),
  "episode_0001.txt": utf8(
    ["【タイトル】", "第1話　転生前夜", "", "【本文】", "　夜が更けていく。", ""].join("\r\n")
  ),
  "episode_0002.txt": utf8(
    ["【タイトル】", "第2話　｜朝《あさ》", "", "【本文】", "　朝が来た。", ""].join("\n")
  ),
  "episode_0003.txt": utf8(["【タイトル】", "第3話　空", "", "【本文】", "", ""].join("\n")),
});

const sep = (n: number) => `------------------------- エピソード${n}開始 -------------------------`;
const NAROU_TEXT = [
  "【Nコード】",
  "N4190FX",
  "",
  "【タイトル】",
  "肉片とラジオ",
  "",
  sep(1),
  "【エピソードタイトル】",
  "１話　自殺の後始末",
  "",
  "【本文】",
  "　あれは中学３年生の頃。",
  "",
  "【リアクション】",
  "0件",
  "",
  sep(2),
  "【エピソードタイトル】",
  "２話　ラジオ",
  "",
  "【本文】",
  "　その夜、ラジオが鳴った。",
  "",
].join("\n");

describe("backupImportEntries", () => {
  test("カクヨム（話ごとのファイル）：題から話数を除いてサブタイトルにし、本文だけを取る", () => {
    const { entries, empty } = backupImportEntries(inspectWorkBackup(KAKUYOMU_ZIP, "星の街.zip"));
    expect(entries.map((entry) => [entry.order, entry.title, entry.body])).toEqual([
      [1, "転生前夜", "　夜が更けていく。"],
      // 題のルビは落とす（ファイル名に記法を入れない）
      [2, "朝", "　朝が来た。"],
    ]);
    // 本文の無い話は並べず、見出しを返す（黙って落とさない）
    expect(empty).toEqual(["第3話　空"]);
    expect(entries[0].chars).toBe(8);
  });

  test("なろう（合本）：区切りごとに1話。リアクションは本文に入れない", () => {
    const { entries } = backupImportEntries(inspectWorkBackup(utf8(NAROU_TEXT), "N4190FX.txt"));
    expect(entries.map((entry) => [entry.title, entry.body])).toEqual([
      ["自殺の後始末", "　あれは中学３年生の頃。"],
      ["ラジオ", "　その夜、ラジオが鳴った。"],
    ]);
  });
});

describe("planBackupImport", () => {
  const base = { collected: false, numbered: true, isLatest: false, shiftCount: 2 };

  test("1話で空の話なら訊かずにその話へ（0.147.0 と同じ）", () => {
    expect(planBackupImport({ ...base, bodyEmpty: true, count: 1 })).toEqual({ kind: "fill" });
  });

  test("1話で本文が入っていれば、次の話・最後に加える・上書き", () => {
    expect(planBackupImport({ ...base, bodyEmpty: false, count: 1 })).toEqual({
      kind: "ask",
      choices: ["next", "last", "overwrite"],
    });
  });

  test("2話以上は、空の話でもその話へは入れず、上書きも出さない", () => {
    expect(planBackupImport({ ...base, bodyEmpty: true, count: 3 })).toEqual({
      kind: "ask",
      choices: ["next", "last"],
    });
    expect(planBackupImport({ ...base, bodyEmpty: false, count: 3 })).toEqual({
      kind: "ask",
      choices: ["next", "last"],
    });
  });

  test("最後の話・合本では、最後に加えるだけ", () => {
    expect(planBackupImport({ ...base, isLatest: true, bodyEmpty: false, count: 2 })).toEqual({
      kind: "ask",
      choices: ["last"],
    });
    expect(planBackupImport({ ...base, collected: true, bodyEmpty: false, count: 2 })).toEqual({
      kind: "ask",
      choices: ["last"],
    });
  });
});

describe("describeBackupImportChoices", () => {
  test("何話を・どこへ足すかと、足す話の見出しを並べる", () => {
    const lines = describeBackupImportChoices({
      choices: ["next", "last"],
      sourceName: "星の街.zip",
      entries: [
        { label: "第1話　転生前夜", chars: 8 },
        { label: "第2話　朝", chars: 5 },
      ],
      nextFrom: 4,
      shiftCount: 3,
      lastFrom: 8,
      erasedChars: 0,
    });
    expect(lines[0]).toBe("取り込む元：星の街.zipの2話（13字）");
    expect(lines[1]).toContain("［次の話として足す］第4〜5話として2話を足します");
    expect(lines[1]).toContain("3話");
    expect(lines[2]).toContain("［最後に加える］最後の話のあとに第8〜9話として2話を足します");
    expect(lines).toContain("　・第1話　転生前夜（8字）");
    expect(lines.join("\n")).not.toContain("上書き");
  });

  test("番号の範囲の言い方", () => {
    expect(numberRangeLabel(4, 1)).toBe("第4話");
    expect(numberRangeLabel(4, 3)).toBe("第4〜6話");
  });
});
