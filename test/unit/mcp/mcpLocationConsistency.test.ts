import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { z } from "zod";
import { NOVEL_DETECT_INPUT, novelDetect } from "../../../src/mcp/tools/features";
import { exposureOf } from "../../../src/mcp/tools/accessLog";

/**
 * 外部AIから場所の位置関係の機械照合を呼ぶ口（設計書6.93.7。
 * 設計書での名前は `contradiction.detectLocations`、実体は `novel.detect` の
 * feature: contradiction）。
 *
 * 製品と同じ判定（`core/locationConsistency.ts`）を通り、矛盾を仕込んだ
 * 台帳から本文の行つきで返すこと、矛盾の無い台帳からは何も返さないことを見る。
 */

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function location(
  id: string,
  name: string,
  relations: unknown[]
): Record<string, unknown> {
  return { id, name, relations };
}

function makeWork(locations: Array<Record<string, unknown>>): string {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-loc-"));
  made.push(root);
  fs.mkdirSync(nodePath.join(root, "本文"), { recursive: true });
  fs.mkdirSync(nodePath.join(root, "設定", "locations"), { recursive: true });
  fs.writeFileSync(
    nodePath.join(root, "本文", "003_坂.txt"),
    "　朝。\n　学校は港の北の高台にある。\n"
  );
  fs.writeFileSync(
    nodePath.join(root, "本文", "007_夕.txt"),
    "　夕方。\n\n　港は学校の北に見えた。\n"
  );
  for (const record of locations) {
    fs.writeFileSync(
      nodePath.join(root, "設定", "locations", `${record.id as string}.json`),
      JSON.stringify(record)
    );
  }
  return root;
}

describe("novel.detect（feature: contradiction）——場所の位置関係", () => {
  it("方角の非対称を、あとの話の行つきで返す", () => {
    const folder = makeWork([
      location("loc_001", "学校", [
        {
          kind: "direction",
          target: "港",
          value: "北",
          chapters: [3],
          evidence: "学校は港の北の高台にある",
        },
      ]),
      location("loc_002", "港", [
        {
          kind: "direction",
          target: "学校",
          value: "北",
          chapters: [7],
          evidence: "港は学校の北に見えた",
        },
      ]),
    ]);
    const result = novelDetect({ folder, feature: "contradiction" }) as {
      inconsistencies: Array<{ kind: string }>;
      issues: Array<{ filePath: string; line: number; category: string }>;
      unplaced: number;
      unreadable: string[];
    };
    expect(result.inconsistencies.map((entry) => entry.kind)).toEqual(["direction"]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].filePath.replace(/\\/g, "/")).toBe("本文/007_夕.txt");
    expect(result.issues[0].line).toBe(3);
    expect(result.issues[0].category).toBe("場所");
    expect(result.unplaced).toBe(0);
    expect(result.unreadable).toEqual([]);
  });

  it("整合している台帳からは何も返さない", () => {
    const folder = makeWork([
      location("loc_001", "学校", [
        { kind: "direction", target: "港", value: "北", chapters: [3], evidence: "学校は港の北の高台にある" },
      ]),
      location("loc_002", "港", [{ kind: "direction", target: "学校", value: "南" }]),
    ]);
    const result = novelDetect({ folder, feature: "contradiction" }) as {
      inconsistencies: unknown[];
      issues: unknown[];
    };
    expect(result.inconsistencies).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it("壊れた場所のファイルは直さず、照合の外に置いたことを返す", () => {
    const folder = makeWork([]);
    fs.writeFileSync(nodePath.join(folder, "設定", "locations", "loc_009.json"), "{壊れ");
    const result = novelDetect({ folder, feature: "contradiction" }) as {
      unreadable: string[];
    };
    expect(result.unreadable).toEqual(["loc_009.json"]);
    // 読むだけで書き戻さない
    expect(
      fs.readFileSync(nodePath.join(folder, "設定", "locations", "loc_009.json"), "utf8")
    ).toBe("{壊れ");
  });

  it("入口の形が contradiction を受け、外へ出るのは抜粋どまり", () => {
    expect(
      z.object(NOVEL_DETECT_INPUT).safeParse({ folder: "x", feature: "contradiction" }).success
    ).toBe(true);
    expect(exposureOf("novel.detect", { feature: "contradiction" })).toBe("excerpt");
  });
});
