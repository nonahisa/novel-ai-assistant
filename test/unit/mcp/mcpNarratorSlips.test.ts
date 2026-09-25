import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { novelDetect } from "../../../src/mcp/tools/features";
import { scanNarratorSlips } from "../../../src/mcp/tools/proofread";

/**
 * 語り手の名前が地の文に出る所を、外から数える（設計書6.9.2、2026-09-25）。
 *
 * **製品と同じ関数を通す**（`core/narratorNameSlip.ts`）。ここで見るのは、
 * 作品フォルダーから人物と本文を読んで、ファイルの行番号で返すまでの配線。
 * 仕込みは一時フォルダーの写しにだけ入れる（台の原本は触らない）。
 */

const SEEDED = nodePath.join(__dirname, "../../fixtures/seeded/contradiction");
const THIRD_PERSON = nodePath.join(__dirname, "../../fixtures/seeded/proofread");
const FIRST = "本文/001_九月の終わりの坂.txt";

const made: string[] = [];
afterEach(() => {
  for (const folder of made.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

function seededCopy(): string {
  const folder = fs.mkdtempSync(nodePath.join(os.tmpdir(), "narrator-slip-"));
  made.push(folder);
  fs.cpSync(SEEDED, folder, { recursive: true });
  const file = nodePath.join(folder, FIRST);
  const text = fs.readFileSync(file, "utf8");
  const seeded = text.replace(
    "　最初にそれを聞いたとき、俺は損をしたのだと思った。",
    "　最初にそれを聞いたとき、相沢は損をしたのだと思った。"
  );
  expect(seeded).not.toBe(text);
  fs.writeFileSync(file, seeded);
  return folder;
}

describe("語り手の名前が地の文に出る所（MCP）", () => {
  it("仕込んだ1か所を、ファイルの行番号と「視点」の札で返す", () => {
    const result = scanNarratorSlips(seededCopy());
    expect(result.narrator).toEqual({ firstPerson: "俺", name: "相沢 春人" });
    expect(result.slips).toEqual([
      expect.objectContaining({
        filePath: FIRST,
        line: 18,
        original: "相沢は",
        suggestion: "俺は",
        reason: "視点",
      }),
    ]);
  });

  it("1話に絞っても、語り手は作品全体から決める（その話だけ返す）", () => {
    const folder = seededCopy();
    expect(scanNarratorSlips(folder, "本文/002_十月三日の坂.txt").slips).toEqual([]);
    expect(scanNarratorSlips(folder, FIRST).slips).toHaveLength(1);
  });

  it("仕込みの無い台では1件も出さない", () => {
    const result = scanNarratorSlips(SEEDED);
    expect(result.narrator).not.toBeNull();
    expect(result.slips).toEqual([]);
  });

  it("三人称の台では語り手が決まらず、理由を添えて何も出さない", () => {
    const result = scanNarratorSlips(THIRD_PERSON);
    expect(result.narrator).toBeNull();
    expect(result.slips).toEqual([]);
    expect(result.note).toContain("語り手");
  });

  /**
   * 実機確認 3巡目（2026-09-25 午後、コールドスリープの写し）で、合本 `N5078JI.txt` が
   * `skipped` に**同じ名前で3回**並んだ。合本の中の話ごとに1件ずつ積んでいたため。
   * 同じファイル・同じ理由は1件にまとめ、何話ぶんかを添える。
   */
  it("合本の中の話は、見なかった理由が同じなら1件にまとめて話の数を添える", () => {
    const folder = seededCopy();
    const episode = (order: number, title: string) =>
      [
        `------------------------- エピソード${order}開始 -------------------------`,
        "【エピソードタイトル】",
        `${order}話　${title}`,
        "",
        "【本文】",
        "　その日、少女は丘の上から町を見下ろしていた。",
        "　風が冷たく、少女は外套の襟を立てた。",
        "",
      ].join("\n");
    fs.writeFileSync(
      nodePath.join(folder, "本文/900_外伝合本.txt"),
      [episode(1, "丘"), episode(2, "町"), episode(3, "風")].join("\n")
    );

    const skipped = scanNarratorSlips(folder).skipped.filter((entry) =>
      entry.filePath.endsWith("900_外伝合本.txt")
    );
    expect(skipped).toEqual([
      { filePath: "本文/900_外伝合本.txt", reason: "not_narrator_episode", episodes: 3 },
    ]);
  });

  it("novel.detect の proofread で呼べる", () => {
    const result = novelDetect({ folder: seededCopy(), feature: "proofread" }) as {
      slips: unknown[];
    };
    expect(result.slips).toHaveLength(1);
  });
});
