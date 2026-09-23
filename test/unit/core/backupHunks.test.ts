import { describe, expect, it } from "vitest";
import {
  applyLineBlock,
  countProposableHunks,
  hunkProposalsOf,
  invertLineBlock,
  locateBodyInFile,
  shiftedStartLine,
} from "../../../src/core/backupHunks";

/**
 * バックアップとの違いを、1か所ずつの提案にする部品（設計書6.99.7。
 * 作者の裁定、2026-09-23）。
 *
 * 見るのは「どこへ当てるか」と「当てられないときに当てないこと」の両方——
 * 当てるほうだけを試すと、どこへでも書き込む実装が満点になる。
 */

const FILE = [
  "------------------------- エピソード2開始 -------------------------",
  "【エピソードタイトル】",
  "2話　検査",
  "",
  "【本文】",
  "　検査が続く。",
  "　白い部屋だった。",
  "",
  "【リアクション】",
  "いいね: 16件",
].join("\n");

describe("本文がファイルの何行目から始まるか", () => {
  it("見出しの下から始まる本文の位置を返す（0始まり）", () => {
    expect(locateBodyInFile(FILE, "\n　検査が続く。\n　白い部屋だった。\n")).toBe(5);
  });

  it("行末の空白と CRLF は比べ方に入れない（字下げは入れる）", () => {
    const crlf = FILE.replace("　検査が続く。", "　検査が続く。　 ").split("\n").join("\r\n");
    expect(locateBodyInFile(crlf, "　検査が続く。\n　白い部屋だった。")).toBe(5);
    expect(locateBodyInFile(FILE, "検査が続く。\n　白い部屋だった。")).toBeNull();
  });

  it("**同じ並びが2か所にあれば決めない**（どちらを書き換えるか分からない）", () => {
    const twice = `${FILE}\n${FILE}`;
    expect(locateBodyInFile(twice, "　検査が続く。\n　白い部屋だった。")).toBeNull();
  });

  it("見つからない・本文が空なら決めない", () => {
    expect(locateBodyInFile(FILE, "　別の文。")).toBeNull();
    expect(locateBodyInFile(FILE, "\n\n")).toBeNull();
  });
});

describe("1話の違いを、1か所ずつの提案にする", () => {
  const diff = {
    label: "2話　検査",
    relPath: "本文/0002.txt",
    hunks: [
      { localLine: 1, local: ["　検査が続く。"], backup: ["検査が続く。"] },
      { localLine: 3, local: [], backup: ["　足された段落。", "　もう1行。"] },
    ],
    bodyLineOffset: 5,
    fileHash: "h1",
  };

  it("本文の行番号を、ファイルの行番号に直して並べる", () => {
    expect(hunkProposalsOf(diff)).toEqual([
      {
        relPath: "本文/0002.txt",
        episodeLabel: "2話　検査",
        startLine: 6,
        local: ["　検査が続く。"],
        backup: ["検査が続く。"],
        fileHash: "h1",
      },
      {
        relPath: "本文/0002.txt",
        episodeLabel: "2話　検査",
        startLine: 8,
        local: [],
        backup: ["　足された段落。", "　もう1行。"],
        fileHash: "h1",
      },
    ]);
    expect(countProposableHunks([diff])).toBe(2);
  });

  it("**位置かハッシュが分からなければ提案にしない**（記録にだけ残す）", () => {
    expect(hunkProposalsOf({ ...diff, bodyLineOffset: null })).toEqual([]);
    expect(hunkProposalsOf({ ...diff, fileHash: null })).toEqual([]);
    expect(countProposableHunks([{ ...diff, bodyLineOffset: null }])).toBe(0);
  });
});

describe("1か所を当てる", () => {
  const lines = ["一", "　二", "三", "四"].join("\n");

  it("複数行を別の行数の行へ置き換える（段落の増減）", () => {
    expect(
      applyLineBlock(lines, { startLine: 2, local: ["　二", "三"], replacement: ["新"] })
    ).toBe(["一", "新", "四"].join("\n"));
  });

  it("行を足すだけ（手元に無い段落）は、その行の前へ入れる", () => {
    expect(applyLineBlock(lines, { startLine: 3, local: [], replacement: ["足す"] })).toBe(
      ["一", "　二", "足す", "三", "四"].join("\n")
    );
    // 最後の行のあと
    expect(applyLineBlock(lines, { startLine: 5, local: [], replacement: ["末尾"] })).toBe(
      ["一", "　二", "三", "四", "末尾"].join("\n")
    );
  });

  it("行を消すだけ（バックアップに無い段落）", () => {
    expect(applyLineBlock(lines, { startLine: 4, local: ["四"], replacement: [] })).toBe(
      ["一", "　二", "三"].join("\n")
    );
  });

  it("**その行がいまの原稿と合わなければ当てない**（字下げの違いも合わないと見る）", () => {
    expect(applyLineBlock(lines, { startLine: 2, local: ["二"], replacement: ["x"] })).toBeNull();
    expect(applyLineBlock(lines, { startLine: 9, local: [], replacement: ["x"] })).toBeNull();
    expect(applyLineBlock(lines, { startLine: 4, local: ["四", "五"], replacement: [] })).toBeNull();
  });

  it("行末の空白の違いだけなら、同じ行と見る", () => {
    expect(
      applyLineBlock("一\n　二　 \n三", { startLine: 2, local: ["　二"], replacement: ["二"] })
    ).toBe("一\n二\n三");
  });

  it("逆向きに当てると元に戻る（「戻す」）", () => {
    const block = { startLine: 2, local: ["　二", "三"], replacement: ["新", "新2", "新3"] };
    const applied = applyLineBlock(lines, block) as string;
    expect(applyLineBlock(applied, invertLineBlock(block))).toBe(lines);
  });
});

describe("同じファイルの別の1か所を当てたあとのずれ", () => {
  it("後ろの箇所だけが、増減した行の数だけずれる", () => {
    const applied = { startLine: 5, local: ["a"], replacement: ["b", "c", "d"] };
    expect(shiftedStartLine(3, applied)).toBe(3);
    expect(shiftedStartLine(10, applied)).toBe(12);
    const removed = { startLine: 5, local: ["a", "b"], replacement: [] };
    expect(shiftedStartLine(10, removed)).toBe(8);
  });
});
