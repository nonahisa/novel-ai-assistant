import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { novelPropose } from "../../../src/mcp/tools/propose";
import { typoPrompt } from "../../../src/mcp/tools/typo";
import { McpToolError } from "../../../src/mcp/tools/shared";
import { setExternalClientName } from "../../../src/mcp/tools/accessLog";
import {
  mergePendingSettingsRecord,
  parsePendingSettingsPayload,
} from "../../../src/core/pendingSettingsMerge";
import {
  emptyLocation,
  locationFileName,
  type Location,
  type LocationRelation,
} from "../../../src/models/location";

/**
 * 外部AIの提案で、場所の位置関係を受ける（F1 の1段目。設計書6.93、
 * 2026-10-09 作者の裁定）。
 *
 * 見張ること：①製品の抽出と同じ検算を通ったものだけが承認待ちに入る
 * ②通らない関係は落ちて理由が返り、場所の別の提案は残る
 * ③本文を照らせない（chunkId が無い）関係は置かない
 * ④マージは作者の関係・固定した関係に触らない
 */

const TEST_CLIENT = "試験";
const EPISODE = "本文/005_みなと.txt";
const BODY = "　港町の北に灯台が建っている。\n　灯台は古く、潮風で白く色褪せていた。\n";
const temporary: string[] = [];

function workCopy(): string {
  const folder = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-propose-rel-"));
  temporary.push(folder);
  fs.mkdirSync(nodePath.join(folder, ".aiwriter"), { recursive: true });
  fs.writeFileSync(
    nodePath.join(folder, ".aiwriter", "external-access.json"),
    JSON.stringify({
      clients: [
        {
          name: TEST_CLIENT,
          tools: ["*"],
          sampling: false,
          decidedAt: "2026-10-09T00:00:00.000Z",
          decidedOn: "テスト",
          note: "",
        },
      ],
    }),
    "utf8"
  );
  fs.mkdirSync(nodePath.join(folder, "本文"), { recursive: true });
  fs.writeFileSync(nodePath.join(folder, EPISODE), BODY, "utf8");
  return folder;
}

function seedLighthouse(folder: string): Location {
  const record: Location = {
    ...emptyLocation("loc_002", "灯台"),
    description: "古い灯台",
    appearedChapters: [5],
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
  const dir = nodePath.join(folder, "設定", "locations");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    nodePath.join(dir, locationFileName(record)),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8"
  );
  return record;
}

function chunkIdOf(folder: string): string {
  return typoPrompt({ folder, filePath: EPISODE, numCtx: 32768 }).chunks[0].chunkId;
}

function pendingRecord(folder: string): Location {
  const file = nodePath.join(folder, ".aiwriter", "pending-settings", "loc_002.json");
  return parsePendingSettingsPayload(
    JSON.parse(fs.readFileSync(file, "utf8")) as unknown
  ).record as Location;
}

function refusal(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    expect(error).toBeInstanceOf(McpToolError);
    return (error as Error).message;
  }
  throw new Error("断られなかった");
}

beforeEach(() => setExternalClientName(TEST_CLIENT));
afterEach(() => {
  setExternalClientName("");
  for (const folder of temporary.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

describe("novel.propose（場所の位置関係）", () => {
  it("検算を通った関係が承認待ちに入る。場所の台帳は変わらない", () => {
    const folder = workCopy();
    seedLighthouse(folder);
    const result = novelPropose({
      folder,
      recordKind: "location",
      name: "灯台",
      chunkId: chunkIdOf(folder),
      changes: {
        relations: [
          {
            target: "港町",
            kind: "direction",
            value: "北",
            evidence: "港町の北に灯台が建っている",
          },
        ],
      },
      reason: "第5話の冒頭に、港町から見た灯台の方角がある。",
    });
    expect(result.changedFields).toEqual(["relations"]);
    const relations = pendingRecord(folder).relations ?? [];
    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({
      kind: "direction",
      target: "港町",
      value: "北",
      authorLocked: false,
    });
  });

  it("本文に無い関係・離れた2文をつないだ引用は落ち、場所の別の提案は残る", () => {
    const folder = workCopy();
    seedLighthouse(folder);
    const result = novelPropose({
      folder,
      recordKind: "location",
      name: "灯台",
      chunkId: chunkIdOf(folder),
      changes: {
        description: "潮風で白く色褪せた古い灯台",
        relations: [
          // 本文に無い
          { target: "港町", kind: "distance", value: "徒歩10分", evidence: "港町から徒歩10分" },
          // 指示語がそのまま返ってきた形
          { target: "港町", kind: "direction", value: "方角の語", evidence: "港町の北に灯台が建っている" },
          // 離れた2文をつないだ引用
          { target: "港町", kind: "within", evidence: "港町の北に灯台が建っている。潮風で白く色褪せていた" },
          // 自分自身
          { target: "灯台", kind: "adjacent", evidence: "灯台は古く" },
          // 4種以外
          { target: "港町", kind: "north|south", evidence: "港町の北に灯台が建っている" },
        ],
      },
      reason: "灯台の説明を足す。",
    });
    expect(result.changedFields).toEqual(["description"]);
    expect(result.skipped.length).toBeGreaterThanOrEqual(5);
    expect(pendingRecord(folder).relations ?? []).toEqual([]);
    expect(pendingRecord(folder).description).toBe("潮風で白く色褪せた古い灯台");
  });

  it("関係が全部落ち、ほかに変える欄も無ければ置かずに断る", () => {
    const folder = workCopy();
    seedLighthouse(folder);
    const message = refusal(() =>
      novelPropose({
        folder,
        recordKind: "location",
        name: "灯台",
        chunkId: chunkIdOf(folder),
        changes: {
          relations: [{ target: "港町", kind: "direction", value: "南", evidence: "港町の南" }],
        },
        reason: "試し。",
      })
    );
    expect(message).toContain("置くものがありません");
    expect(fs.existsSync(nodePath.join(folder, ".aiwriter", "pending-settings"))).toBe(
      false
    );
  });

  it("chunkId が無ければ断る（引用を本文で照らせない）", () => {
    const folder = workCopy();
    seedLighthouse(folder);
    const message = refusal(() =>
      novelPropose({
        folder,
        recordKind: "location",
        name: "灯台",
        changes: {
          relations: [
            { target: "港町", kind: "direction", value: "北", evidence: "港町の北に灯台が建っている" },
          ],
        },
        reason: "試し。",
      })
    );
    expect(message).toContain("chunkId");
  });
});

describe("承認待ちの取り込み（場所の位置関係）", () => {
  function relation(overrides: Partial<LocationRelation>): LocationRelation {
    return {
      kind: "direction",
      target: "港町",
      targetId: null,
      value: "北",
      chapters: [5],
      evidence: "港町の北に灯台が建っている",
      authorLocked: false,
      ...overrides,
    };
  }

  it("作者が固定した関係は変わらない。同じ鍵の違う値は食い違いとして残る", () => {
    const current: Location = {
      ...emptyLocation("loc_002", "灯台"),
      autoGenerated: true,
      relations: [relation({ value: "西", authorLocked: true, evidence: null })],
    };
    const proposal: Location = { ...current, relations: [relation({})] };
    const merged = mergePendingSettingsRecord("location", current, proposal, {
      source: "external",
    }) as Location;
    expect(merged.relations).toHaveLength(1);
    expect(merged.relations![0]).toMatchObject({ value: "西", authorLocked: true });
  });

  it("作者が確定させた記録には、同じ（種類, 相手）が無い関係だけを足し、食い違いは書かない", () => {
    const current: Location = {
      ...emptyLocation("loc_002", "灯台"),
      autoGenerated: false,
      relations: [relation({ value: "西", evidence: null })],
    };
    const proposal: Location = {
      ...current,
      relations: [
        relation({ value: "北" }),
        relation({ kind: "within", target: "岬", value: null, evidence: "岬の中" }),
      ],
    };
    const merged = mergePendingSettingsRecord("location", current, proposal, {
      source: "external",
    }) as Location;
    expect(merged.relations!.map((r) => `${r.kind}:${r.target}:${r.value ?? ""}`)).toEqual([
      "direction:港町:西",
      "within:岬:",
    ]);
    expect(merged.conflicts).toEqual(current.conflicts);
  });

  it("外部AIの出どころでなければ、確定した記録に関係を足さない", () => {
    const current: Location = { ...emptyLocation("loc_002", "灯台"), autoGenerated: false };
    const proposal: Location = { ...current, relations: [relation({})] };
    const merged = mergePendingSettingsRecord("location", current, proposal) as Location;
    expect(merged.relations).toBeUndefined();
  });
});
