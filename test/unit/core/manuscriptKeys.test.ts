import { describe, expect, test } from "vitest";
import {
  MANUSCRIPT_KEY_BINDINGS,
  MANUSCRIPT_KEY_SOURCE,
  MANUSCRIPT_PROOF_CHECKS,
  isManuscriptKeyArgs,
  proofCheckCommand,
  workForFile,
} from "../../../src/core/manuscriptKeys";

/**
 * 原稿エディターのキーから呼ばれたことの見分けと、開いている原稿の作品の
 * 引き当て（設計書6.25.10）。
 */
describe("キーから呼ばれた印", () => {
  test("package.json の args と同じ形なら印とみなす", () => {
    expect(isManuscriptKeyArgs({ source: MANUSCRIPT_KEY_SOURCE })).toBe(true);
  });

  test("作品一覧の節点・何も無い・別の印は印ではない", () => {
    expect(isManuscriptKeyArgs(undefined)).toBe(false);
    expect(isManuscriptKeyArgs(null)).toBe(false);
    expect(isManuscriptKeyArgs({ type: "work", work: {} })).toBe(false);
    expect(isManuscriptKeyArgs({ source: "other" })).toBe(false);
    expect(isManuscriptKeyArgs("manuscriptEditor")).toBe(false);
  });
});

describe("開いている原稿がどの作品か", () => {
  const works = [
    { id: "a", folderPath: "C:/書庫" },
    { id: "b", folderPath: "C:/書庫/第二作" },
    { id: "c", folderPath: "C:/別の作品" },
  ];

  test("作品のフォルダーの中の原稿なら、その作品", () => {
    expect(workForFile(works, "C:/別の作品/原稿/001.txt")?.id).toBe("c");
  });

  test("入れ子の作品（書庫の中の作品）では、いちばん深い作品を選ぶ", () => {
    // 浅いほうを返すと、書庫の別の作品で検知が走る
    expect(workForFile(works, "C:/書庫/第二作/原稿/003.txt")?.id).toBe("b");
    expect(workForFile(works, "C:/書庫/原稿/003.txt")?.id).toBe("a");
  });

  test("どの作品にも入っていなければ undefined（推し量らない）", () => {
    expect(workForFile(works, "D:/無関係/メモ.txt")).toBeUndefined();
  });
});

/*
  上の列の［校正］の品書き（作者の判断 2026-11-02）。キーと同じ命令を呼ぶ
*/
describe("［校正］の品書きの命令", () => {
  test("4つとも、原稿エディターのキーに割り当てた命令と同じ", () => {
    const keyCommands = MANUSCRIPT_KEY_BINDINGS.map((binding) => binding.command);
    for (const command of Object.values(MANUSCRIPT_PROOF_CHECKS)) {
      expect(keyCommands).toContain(command);
    }
  });

  test("画面から届いた名前を命令へ。知らない名前は受け取らない", () => {
    expect(proofCheckCommand("typos")).toBe("novelai.checkTyposForFile");
    expect(proofCheckCommand("suite")).toBe("novelai.runProofreadingSuite");
    expect(proofCheckCommand("toString")).toBeUndefined();
    expect(proofCheckCommand("novelai.checkProofread")).toBeUndefined();
    expect(proofCheckCommand(undefined)).toBeUndefined();
  });
});
