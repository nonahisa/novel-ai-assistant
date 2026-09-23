import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { contradictionPrompt } from "../../../src/mcp/tools/contradiction";

/**
 * **矛盾検知へ送る材料が、1文字も変わっていないこと**（設計書6.10.6）。
 *
 * キャッシュの鍵は「プロンプトの版＋設定の指紋＋チャンクのハッシュ」で、
 * **プロンプトの中身そのものは鍵に入っていない。** だから材料の組み立てを
 * こっそり変えると、`CONTRADICTION_CHECK_VERSION` が同じまま**別の材料で
 * 得た答え**が同じ鍵に入る——作者の作品では実測が何十回ぶんも無駄になる。
 *
 * 「落としたことを言う」（0.70.10）は**数えるだけで材料を変えない**改修
 * だったので、その写しをここで固定した。**版（1.6）を据え置いたまま材料を
 * 触ったら、ここが落ちる。**
 *
 * 写しは `test/fixtures/golden/contradictionPrompts.json`。作り方は
 * 「答え付きの台の5話を、`carryOver` 0話／2話で組ませて丸ごと書き出す」。
 * **中身を変えるときは、版を上げるのと一緒でなければならない。**
 *
 * **話数は必ず明示して組ませる**（0.73.3）。既定が0から2へ変わったので、
 * 「指定しない」を写しの鍵にしていると、既定を変えた日に**写しの意味まで
 * 黙って変わる**。既定そのものは下の「既定は2話ぶん引き継ぐ」で見張る。
 */

interface GoldenChunk {
  chapterLabel: string;
  chars: number;
  carriedOverChapters: number[];
  userPrompt: string;
}

interface GoldenEntry {
  promptVersion: string;
  systemPrompt: string;
  skipped: Array<{ chunkId: string; reason: string }>;
  chunks: GoldenChunk[];
}

const GOLDEN: Record<string, GoldenEntry> = JSON.parse(
  readFileSync("test/fixtures/golden/contradictionPrompts.json", "utf8")
);

describe("送る材料の写し（設計書6.10.6）", () => {
  const folder = "test/fixtures/seeded/contradiction";

  test("写しが空でない（読めていないことに気づけるように）", () => {
    expect(Object.keys(GOLDEN).length).toBe(10);
  });

  for (const [key, expected] of Object.entries(GOLDEN)) {
    const [fileName, carryOverPart] = key.split("|");
    const carryOver = Number(carryOverPart.replace("carryOver=", ""));

    test(`${fileName}（carryOver=${carryOver}）は1文字も変わらない`, () => {
      const built = contradictionPrompt({
        folder,
        filePath: `本文/${fileName}`,
        numCtx: 16384,
        carryOver,
      });

      expect(built.promptVersion).toBe(expected.promptVersion);
      expect(built.systemPrompt).toBe(expected.systemPrompt);
      expect(built.skipped).toEqual(expected.skipped);
      expect(
        built.chunks.map((chunk) => ({
          chapterLabel: chunk.chapterLabel,
          chars: chunk.chars,
          carriedOverChapters: chunk.carriedOverChapters,
          userPrompt: chunk.userPrompt,
        }))
      ).toEqual(expected.chunks);
    });
  }

  /*
    **既定で送る材料は、`carryOver=2` の写しと1文字も変わらない**（0.73.3）。

    既定を0から2へ変えたので、**何も指定せずに呼んだときに何が送られるか**
    を写しへ結びつけておかないと、既定だけが黙って戻っても誰も気づかない。
  */
  test("指定しないときは、carryOver=2 の写しと同じものを送る", () => {
    for (const fileName of Object.keys(GOLDEN)
      .filter((key) => key.endsWith("|carryOver=2"))
      .map((key) => key.split("|")[0])) {
      const built = contradictionPrompt({
        folder,
        filePath: `本文/${fileName}`,
        numCtx: 16384,
      });
      const expected = GOLDEN[`${fileName}|carryOver=2`];

      expect(built.promptVersion).toBe(expected.promptVersion);
      expect(
        built.chunks.map((chunk) => ({
          chapterLabel: chunk.chapterLabel,
          chars: chunk.chars,
          carriedOverChapters: chunk.carriedOverChapters,
          userPrompt: chunk.userPrompt,
        }))
      ).toEqual(expected.chunks);
    }
  });
});
