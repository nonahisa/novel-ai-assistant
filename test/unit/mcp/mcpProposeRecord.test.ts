import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { createHash } from "node:crypto";
import { novelPropose } from "../../../src/mcp/tools/propose";
import { McpToolError } from "../../../src/mcp/tools/shared";
import {
  recordExternalAccess,
  setExternalClientName,
} from "../../../src/mcp/tools/accessLog";
import { assertExternalAccessAllowed } from "../../../src/mcp/tools/permission";
import { parseExternalAccessLog } from "../../../src/core/externalAccessLog";
import { parsePendingSettingsPayload } from "../../../src/core/pendingSettingsMerge";
import { applyPendingCharacterUpdates } from "../../../src/features/applyPendingUpdates";
import {
  emptyLocation,
  locationFileName,
  type Location,
} from "../../../src/models/location";
import { abilityFileName, emptyAbility, type Ability } from "../../../src/models/ability";
import { emptyWorldItem, worldItemFileName } from "../../../src/models/world";
import {
  emptyOrganization,
  organizationFileName,
} from "../../../src/models/organization";
import type { WorkEntry } from "../../../src/models/types";
import {
  FileSystemError,
  FileType,
  window,
  workspace,
} from "../support/vscodeStub";

/**
 * 外部AIの提案を、人物以外（能力・組織・場所・世界観）へ広げる
 * （設計書6.87.16。0.83.10、残課題の「作ること」7）。
 *
 * **見張ることは人物の道と同じ3つ。** ①台帳が1バイトも変わらない
 * ②断りどころで黙って通さない ③置いた案を、製品の出口
 * （「更新分を反映」）がそのまま確かめて反映できる。
 *
 * ③は**本物の出口を通す**。MCP は Node の `fs` で書き、出口は
 * `vscode.workspace.fs` で読むので、代役の `workspace.fs` を本物の
 * ファイルへ繋いで、同じ一時フォルダーを両方から見る。置いた形を
 * 出口が読めない、というずれはここでしか見つからない。
 */

const FIXTURE = nodePath.join(__dirname, "..", "..", "fixtures", "mcp-work");
const TEST_CLIENT = "試験";

const temporary: string[] = [];

function writePermission(folder: string): void {
  fs.mkdirSync(nodePath.join(folder, ".aiwriter"), { recursive: true });
  fs.writeFileSync(
    nodePath.join(folder, ".aiwriter", "external-access.json"),
    JSON.stringify({
      clients: [
        {
          name: TEST_CLIENT,
          tools: ["*"],
          sampling: false,
          decidedAt: "2026-09-24T00:00:00.000Z",
          decidedOn: "テスト",
          note: "",
        },
      ],
    }),
    "utf8"
  );
}

/** 作り物の作品を一時フォルダーへ写す。**fixture そのものへは書かない** */
function workCopy(options: { permission?: boolean } = {}): string {
  const folder = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-propose-rec-"));
  fs.cpSync(FIXTURE, folder, { recursive: true });
  if (options.permission !== false) writePermission(folder);
  temporary.push(folder);
  return folder;
}

function writeRecord(folder: string, subdir: string, fileName: string, record: unknown): string {
  const dir = nodePath.join(folder, "設定", subdir);
  fs.mkdirSync(dir, { recursive: true });
  const file = nodePath.join(dir, fileName);
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return file;
}

/** 場所を1つ置く。**作者メモは作者のもの**——提案で変わらないことを見る */
function seedLocation(folder: string, overrides: Partial<Location> = {}): {
  record: Location;
  file: string;
} {
  const record: Location = {
    ...emptyLocation("loc_001", "港町"),
    aliases: ["灯の港"],
    description: "灯台のある小さな港",
    authorNotes: "作者の覚え",
    exportNote: "資料用の補足",
    appearedChapters: [1, 2],
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
  const file = writeRecord(folder, "locations", locationFileName(record), record);
  return { record, file };
}

/** `設定/` の下（人物以外の台帳）の指紋。1バイトでも変われば変わる */
function ledgerFingerprint(folder: string): string {
  const hash = createHash("sha256");
  const root = nodePath.join(folder, "設定");
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = nodePath.join(dir, name);
      if (fs.statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      hash.update(nodePath.relative(root, full));
      hash.update(fs.readFileSync(full));
    }
  };
  walk(root);
  return hash.digest("hex");
}

function pendingSettingsDir(folder: string): string {
  return nodePath.join(folder, ".aiwriter", "pending-settings");
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

/** 失敗の文を取り出す（`toThrow` だけでは、断りの中身を見られない） */
function refusal(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    expect(error).toBeInstanceOf(McpToolError);
    return (error as Error).message;
  }
  throw new Error("断られなかった");
}

beforeEach(() => {
  setExternalClientName(TEST_CLIENT);
});

afterEach(() => {
  setExternalClientName("");
  for (const folder of temporary.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

describe("novel.propose（場所）——承認待ちへ置く", () => {
  it("場所の説明を変える提案は、包みつきで1件だけ積まれる。台帳は変わらない", () => {
    const folder = workCopy();
    const { record } = seedLocation(folder);
    const before = ledgerFingerprint(folder);

    const result = novelPropose({
      folder,
      recordKind: "location",
      name: "港町",
      changes: { description: "灯台と魚市場のある港" },
      reason: "第3話で魚市場の場面があるため。",
    });

    // **ここが本丸。** 台帳へ触れていない
    expect(ledgerFingerprint(folder)).toBe(before);

    expect(result).toMatchObject({
      kind: "update",
      source: "external",
      recordKind: "location",
      recordId: "loc_001",
      name: "港町",
      changedFields: ["description"],
      skipped: [],
      file: ".aiwriter/pending-settings/loc_001.json",
    });

    const files = fs.readdirSync(pendingSettingsDir(folder));
    expect(files).toEqual(["loc_001.json"]);
    // 人物の置き場には何も置かない
    expect(fs.existsSync(nodePath.join(folder, ".aiwriter", "pending-characters"))).toBe(
      false
    );

    const raw = readJson(nodePath.join(pendingSettingsDir(folder), "loc_001.json"));
    expect(raw.recordKind).toBe("location");
    expect(raw.source).toBe("external");
    expect(raw.reason).toBe("第3話で魚市場の場面があるため。");
    // 出口の読み取りが、そのまま読める
    const payload = parsePendingSettingsPayload(raw);
    const proposed = payload.record as Location;
    expect(proposed.description).toBe("灯台と魚市場のある港");
    // **ほかの欄は元のまま**（写しを作って1欄だけ差し替えている）
    expect(proposed.name).toBe(record.name);
    expect(proposed.aliases).toEqual(["灯の港"]);
    expect(proposed.authorNotes).toBe("作者の覚え");
    expect(proposed.appearedChapters).toEqual([1, 2]);
  });

  it("別名は足すだけ。名前そのものと重複は足さない", () => {
    const folder = workCopy();
    seedLocation(folder);
    const result = novelPropose({
      folder,
      recordKind: "location",
      name: "港町",
      changes: { aliases: ["灯の港", "港町", "北の港"] },
      reason: "第2話で「北の港」と呼ばれているため。",
    });
    expect(result.changedFields).toEqual(["aliases"]);
    const proposed = parsePendingSettingsPayload(
      readJson(nodePath.join(pendingSettingsDir(folder), "loc_001.json"))
    ).record;
    expect(proposed.aliases).toEqual(["灯の港", "北の港"]);
  });

  it("能力の使い手は足すだけで、いまの使い手は残る", () => {
    const folder = workCopy();
    const ability: Ability = {
      ...emptyAbility("abil_001", "灯読み"),
      userNames: ["少年"],
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    writeRecord(folder, "abilities", abilityFileName(ability), ability);
    novelPropose({
      folder,
      recordKind: "ability",
      name: "灯読み",
      changes: { userNames: ["灯台守"], cost: "使うと眠くなる" },
      reason: "第4話で灯台守も使っているため。",
    });
    const proposed = parsePendingSettingsPayload(
      readJson(nodePath.join(pendingSettingsDir(folder), "abil_001.json"))
    ).record as Ability;
    expect(proposed.userNames).toEqual(["少年", "灯台守"]);
    expect(proposed.cost).toBe("使うと眠くなる");
  });

  it("世界観の分類は、画面の言葉でも受ける。決まった7つの外は断る", () => {
    const folder = workCopy();
    const item = {
      ...emptyWorldItem("world_001", "灯の掟"),
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    writeRecord(folder, "world", worldItemFileName(item), item);

    const message = refusal(() =>
      novelPropose({
        folder,
        recordKind: "world",
        name: "灯の掟",
        changes: { category: "魔法" },
        reason: "第1話から。",
      })
    );
    expect(message).toContain("rule");
    expect(fs.existsSync(pendingSettingsDir(folder))).toBe(false);

    novelPropose({
      folder,
      recordKind: "world",
      name: "灯の掟",
      changes: { category: "世界の法則", description: "灯を絶やしてはならない" },
      reason: "第1話の冒頭で語られるため。",
    });
    const proposed = parsePendingSettingsPayload(
      readJson(nodePath.join(pendingSettingsDir(folder), "world_001.json"))
    ).record;
    expect((proposed as { category: string }).category).toBe("rule");
  });
});

describe("novel.propose（人物以外）——白名簿", () => {
  it("作者メモ・名前・ID などは積まれず、理由つきで skipped に返る", () => {
    const folder = workCopy();
    seedLocation(folder);

    const result = novelPropose({
      folder,
      recordKind: "location",
      name: "港町",
      changes: {
        description: "灯台と魚市場のある港",
        authorNotes: "勝手なメモ",
        exportNote: "勝手な補足",
        aiNotes: [],
        name: "新しい港町",
        id: "loc_999",
        autoGenerated: false,
        reading: "みなとまち",
        gender: "男",
      },
      reason: "第3話から。",
    });

    expect(result.changedFields).toEqual(["description"]);
    const skippedFields = result.skipped.map((item) => item.field).sort();
    expect(skippedFields).toEqual(
      [
        "aiNotes",
        "authorNotes",
        "autoGenerated",
        "exportNote",
        "gender",
        "id",
        "name",
        "reading",
      ].sort()
    );
    // **黙って落とさない**——どれにも理由が付いている
    expect(result.skipped.every((item) => item.reason.length > 0)).toBe(true);
    expect(result.note).toContain("skipped");

    const proposed = parsePendingSettingsPayload(
      readJson(nodePath.join(pendingSettingsDir(folder), "loc_001.json"))
    ).record;
    expect(proposed.id).toBe("loc_001");
    expect(proposed.name).toBe("港町");
    expect(proposed.authorNotes).toBe("作者の覚え");
    expect(proposed.exportNote).toBe("資料用の補足");
    expect(proposed.autoGenerated).toBe(true);
    expect(proposed.reading).toBeNull();
  });

  it("受け付ける欄が1つも無ければ、置かずに断る", () => {
    const folder = workCopy();
    seedLocation(folder);
    const message = refusal(() =>
      novelPropose({
        folder,
        recordKind: "location",
        name: "港町",
        changes: { authorNotes: "勝手なメモ", name: "別名前" },
        reason: "理由はある",
      })
    );
    expect(message).toContain("authorNotes");
    expect(message).toContain("name");
    expect(fs.existsSync(pendingSettingsDir(folder))).toBe(false);
  });

  it("欄を空文字で消させない", () => {
    const folder = workCopy();
    seedLocation(folder);
    expect(() =>
      novelPropose({
        folder,
        recordKind: "location",
        name: "港町",
        changes: { description: "  " },
        reason: "理由はある",
      })
    ).toThrow(/description/);
    expect(fs.existsSync(pendingSettingsDir(folder))).toBe(false);
  });

  it("reason が空なら断る", () => {
    const folder = workCopy();
    seedLocation(folder);
    expect(() =>
      novelPropose({
        folder,
        recordKind: "location",
        name: "港町",
        changes: { description: "何か" },
        reason: " ",
      })
    ).toThrow(/reason/);
  });
});

describe("novel.propose（人物以外）——断りどころ", () => {
  it("台帳に居ない記録への提案（新しく作る案）は断る。ほかの種類にあれば言う", () => {
    const folder = workCopy();
    seedLocation(folder);
    const org = {
      ...emptyOrganization("org_001", "灯台守の会"),
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    writeRecord(folder, "organizations", organizationFileName(org), org);
    const before = ledgerFingerprint(folder);

    const message = refusal(() =>
      novelPropose({
        folder,
        recordKind: "location",
        name: "灯台守の会",
        changes: { description: "港の北の建物" },
        reason: "第4話から。",
      })
    );
    expect(message).toContain("台帳にありません");
    expect(message).toContain("新しく作る案は、まだ置けません");
    // 取り違え（場所ではなく組織にある）を、呼んだ側が直せるように
    expect(message).toContain('recordKind: "organization"');
    expect(fs.existsSync(pendingSettingsDir(folder))).toBe(false);
    expect(ledgerFingerprint(folder)).toBe(before);
  });

  it("別名では引き当てない（同じ呼び方の別の記録へ入れない）", () => {
    const folder = workCopy();
    seedLocation(folder);
    expect(() =>
      novelPropose({
        folder,
        recordKind: "location",
        name: "灯の港",
        changes: { description: "何か" },
        reason: "理由はある",
      })
    ).toThrow(/台帳にありません/);
  });

  it("作者が確定させた記録（autoGenerated: false）には置かない。出口が取り込まないため", () => {
    const folder = workCopy();
    seedLocation(folder, { autoGenerated: false });
    const message = refusal(() =>
      novelPropose({
        folder,
        recordKind: "location",
        name: "港町",
        changes: { description: "灯台と魚市場のある港" },
        reason: "第3話から。",
      })
    );
    expect(message).toContain("確定");
    expect(fs.existsSync(pendingSettingsDir(folder))).toBe(false);
  });

  it("いまと同じ値の提案は置かない", () => {
    const folder = workCopy();
    seedLocation(folder);
    expect(() =>
      novelPropose({
        folder,
        recordKind: "location",
        name: "港町",
        changes: { description: "灯台のある小さな港" },
        reason: "第1話から。",
      })
    ).toThrow(/同じ/);
    expect(fs.existsSync(pendingSettingsDir(folder))).toBe(false);
  });

  it("同じ記録に未判断の案があれば、2回目は断る（先の案を上書きしない）", () => {
    const folder = workCopy();
    seedLocation(folder);
    novelPropose({
      folder,
      recordKind: "location",
      name: "港町",
      changes: { description: "最初の案" },
      reason: "最初の理由",
    });
    expect(() =>
      novelPropose({
        folder,
        recordKind: "location",
        name: "港町",
        changes: { description: "あとの案" },
        reason: "あとの理由",
      })
    ).toThrow(/まだ判断していない/);
    const proposed = parsePendingSettingsPayload(
      readJson(nodePath.join(pendingSettingsDir(folder), "loc_001.json"))
    ).record;
    expect(proposed.description).toBe("最初の案");
  });

  it("知らない recordKind は断る", () => {
    const folder = workCopy();
    expect(() =>
      novelPropose({
        folder,
        recordKind: "item" as never,
        name: "港町",
        changes: { description: "何か" },
        reason: "理由はある",
      })
    ).toThrow(/recordKind/);
  });

  it("recordKind を省くと、これまでどおり人物の道を通る", () => {
    const folder = workCopy();
    const result = novelPropose({
      folder,
      name: "少年",
      changes: { role: "灯台の当番" },
      reason: "第4話の描写から。",
    });
    expect(result.file).toBe(".aiwriter/pending-characters/char_0001.json");
    expect(fs.existsSync(pendingSettingsDir(folder))).toBe(false);
  });
});

describe("novel.propose（人物以外）——門番と記録", () => {
  function readLog(folder: string) {
    const target = nodePath.join(folder, ".aiwriter", "history", "external.jsonl");
    if (!fs.existsSync(target)) return [];
    return parseExternalAccessLog(fs.readFileSync(target, "utf8"));
  }

  it("許可の無い作品では断り、ノックが残る（転送層と同じ順で通す）", () => {
    const folder = workCopy({ permission: false });
    seedLocation(folder);
    const args = {
      folder,
      recordKind: "location",
      name: "港町",
      changes: { description: "何か" },
      reason: "理由はある",
    };
    // 転送層（server.ts の tool()）は、断ったら道具を呼ばずにノックを残す
    expect(() => assertExternalAccessAllowed(args, "novel.propose")).toThrow();
    recordExternalAccess({ tool: "novel.propose", args, ok: false, denied: true });

    const entries = readLog(folder);
    expect(entries).toHaveLength(1);
    expect(entries[0].tool).toBe("novel.propose");
    expect(entries[0].key).toBe("novel.propose");
    expect(entries[0].ok).toBe(false);
    expect(entries[0].exposure).toBe("none");
    expect(fs.existsSync(pendingSettingsDir(folder))).toBe(false);
  });

  it("置いた回の記録には、種類を先に書く", () => {
    const folder = workCopy();
    seedLocation(folder);
    const args = {
      folder,
      recordKind: "location",
      name: "港町",
      changes: { description: "灯台と魚市場のある港" },
      reason: "第3話から。",
    };
    assertExternalAccessAllowed(args, "novel.propose");
    recordExternalAccess({ tool: "novel.propose", args, ok: true });
    expect(readLog(folder)[0].detail).toBe("承認待ちへ置いた（場所：港町）");
  });
});

/**
 * 置いた案を、**製品の出口（「更新分を反映」）がそのまま確かめて反映できる**こと。
 *
 * 代役の `workspace.fs` を本物のファイルへ繋ぐ——MCP が Node の `fs` で
 * 書いたものを、出口が `vscode.workspace.fs` で読む。
 */
describe("novel.propose（場所）→ 更新分を反映", () => {
  const announced: string[] = [];

  beforeEach(() => {
    announced.length = 0;
    workspace.textDocuments = [];
    const missing = (error: unknown): never => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new FileSystemError("missing", "FileNotFound");
      }
      throw error;
    };
    workspace.fs = {
      createDirectory: async (uri: { fsPath: string }) => {
        fs.mkdirSync(uri.fsPath, { recursive: true });
      },
      readFile: async (uri: { fsPath: string }) => {
        try {
          return new Uint8Array(fs.readFileSync(uri.fsPath));
        } catch (error) {
          return missing(error);
        }
      },
      readDirectory: async (uri: { fsPath: string }) => {
        try {
          return fs
            .readdirSync(uri.fsPath, { withFileTypes: true })
            .map(
              (entry) =>
                [
                  entry.name,
                  entry.isDirectory() ? FileType.Directory : FileType.File,
                ] as [string, FileType]
            );
        } catch (error) {
          return missing(error);
        }
      },
      stat: async (uri: { fsPath: string }) => {
        try {
          const stat = fs.statSync(uri.fsPath);
          return {
            type: stat.isDirectory() ? FileType.Directory : FileType.File,
            size: stat.size,
            mtime: stat.mtimeMs,
            ctime: stat.ctimeMs,
          };
        } catch (error) {
          return missing(error);
        }
      },
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
        fs.writeFileSync(uri.fsPath, bytes);
      },
      rename: async (
        from: { fsPath: string },
        to: { fsPath: string },
        options?: { overwrite?: boolean }
      ) => {
        if (!options?.overwrite && fs.existsSync(to.fsPath)) {
          throw new FileSystemError("exists", "FileExists");
        }
        try {
          fs.renameSync(from.fsPath, to.fsPath);
        } catch (error) {
          missing(error);
        }
      },
      delete: async (uri: { fsPath: string }) => {
        try {
          fs.rmSync(uri.fsPath);
        } catch (error) {
          missing(error);
        }
      },
    } as never;
    for (const name of [
      "showInformationMessage",
      "showWarningMessage",
      "showErrorMessage",
    ] as const) {
      window[name] = (async (message: string) => {
        announced.push(message);
        return undefined;
      }) as never;
    }
  });

  it("出口で差分が出て、承認すると台帳へ入る。作者メモは残り、承認待ちは片付く", async () => {
    const folder = workCopy();
    const { file } = seedLocation(folder);
    novelPropose({
      folder,
      recordKind: "location",
      name: "港町",
      changes: {
        description: "灯台と魚市場のある港",
        authorNotes: "勝手なメモ",
      },
      reason: "第3話で魚市場の場面があるため。",
    });

    const work: WorkEntry = {
      id: "work_test",
      title: "作品",
      folderPath: folder,
      registeredAt: "2026-09-24T00:00:00.000Z",
    };
    const captured = {
      items: [] as Array<{
        id: string;
        name: string;
        source: string;
        origin?: string;
        changes: string[];
      }>,
      apply: undefined as
        | ((id: string) => Promise<{ ok: boolean; reason?: string }>)
        | undefined,
    };
    const panel = {
      showRecordUpdates(
        _work: WorkEntry,
        items: typeof captured.items,
        apply: NonNullable<typeof captured.apply>
      ) {
        captured.items = items;
        captured.apply = apply;
      },
    };

    await applyPendingCharacterUpdates(work, panel as never);

    expect(captured.items).toHaveLength(1);
    const item = captured.items[0];
    expect(item.name).toBe("港町");
    expect(item.source).toContain("場所");
    expect(item.source).toContain("外部AI");
    expect(item.source).toContain("第3話で魚市場の場面があるため。");
    // 「外部AIの提案をまとめて確かめる」は、この印で見分ける
    expect(item.origin).toBe("external");
    const lines = item.changes.join("\n");
    expect(lines).toContain("灯台と魚市場のある港");
    expect(lines).not.toContain("作者メモ");

    const outcome = await captured.apply!(item.id);
    expect(outcome.ok).toBe(true);

    const saved = readJson(file);
    expect(saved.description).toBe("灯台と魚市場のある港");
    expect(saved.authorNotes).toBe("作者の覚え");
    expect(saved.name).toBe("港町");
    expect(fs.readdirSync(pendingSettingsDir(folder))).toEqual([]);
  });
});
