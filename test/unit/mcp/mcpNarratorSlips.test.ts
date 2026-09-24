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

  it("novel.detect の proofread で呼べる", () => {
    const result = novelDetect({ folder: seededCopy(), feature: "proofread" }) as {
      slips: unknown[];
    };
    expect(result.slips).toHaveLength(1);
  });
});
