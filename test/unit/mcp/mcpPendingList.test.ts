import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { createHash } from "node:crypto";
import { pendingList } from "../../../src/mcp/tools/pendingList";
import { McpToolError } from "../../../src/mcp/tools/shared";
import {
  exposureOf,
  recordExternalAccess,
  setExternalClientName,
} from "../../../src/mcp/tools/accessLog";
import {
  EXTERNAL_ACCESS_DIRECTORY,
  EXTERNAL_ACCESS_FILE,
  parseExternalAccessLog,
} from "../../../src/core/externalAccessLog";
import {
  recordUpdateViewItems,
  reviewPendingCharacterUpdates,
  reviewPendingSettingsUpdates,
  settingsUpdateViewItems,
} from "../../../src/features/applyPendingUpdates";
import { emptyCharacter, type Character } from "../../../src/models/character";
import { emptyLocation, type Location } from "../../../src/models/location";
import type { WorkEntry } from "../../../src/models/types";
import { FileSystemError, FileType, workspace } from "../support/vscodeStub";

/**
 * 承認待ちを読む道具（`pending.list`。0.85.1、作者の承認 2026-09-24）。
 *
 * **見張ることは3つ。**
 *
 * 1. **提案パネルと同じものが並ぶ**——組み立ては `core/pendingReview.ts` を
 *    製品と共有している。ここでは本物の出口（`reviewPending*`）と
 *    同じ一時フォルダーを読み比べる
 * 2. **読むだけ**——承認待ちも台帳も1バイトも変えない
 * 3. **古い案・読めない案を黙って落とさない**——画面に並ばない理由を返す
 */

const TEST_CLIENT = "試験";
const temporary: string[] = [];

function newWork(): string {
  const folder = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-pending-list-"));
  temporary.push(folder);
  fs.mkdirSync(nodePath.join(folder, "本文"), { recursive: true });
  return folder;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(nodePath.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function character(id: string, name: string, overrides: Partial<Character> = {}): Character {
  return {
    ...emptyCharacter(id, name),
    summary: "もとの紹介",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function seedCharacter(folder: string, record: Character): void {
  writeJson(nodePath.join(folder, "設定", "characters", `${record.id}.json`), record);
}

function stageCharacter(
  folder: string,
  fileName: string,
  payload: unknown
): void {
  writeJson(nodePath.join(folder, ".aiwriter", "pending-characters", fileName), payload);
}

function location(overrides: Partial<Location> = {}): Location {
  return {
    ...emptyLocation("loc_001", "港町"),
    description: "灯台のある小さな港",
    appearedChapters: [1],
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

/** 作品フォルダー全体の指紋。1バイトでも変われば変わる */
function fingerprint(folder: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = nodePath.join(dir, name);
      if (fs.statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      hash.update(nodePath.relative(folder, full));
      hash.update(fs.readFileSync(full));
    }
  };
  walk(folder);
  return hash.digest("hex");
}

/** 人物3件（更新・古い案・新規の重複）と、場所1件を積んだ作品 */
function mixedWork(): string {
  const folder = newWork();
  seedCharacter(folder, character("char_001", "少年"));
  seedCharacter(folder, character("char_002", "少女"));
  // 外部AIの更新案。紹介が変わる
  stageCharacter(folder, "char_001.json", {
    source: "external",
    reason: "第3話で旅に出るため、紹介を足しました。",
    character: character("char_001", "少年", { summary: "旅に出た少年" }),
  });
  // 台帳に居ない人物の更新案（まとめた・消した）→ 古い案
  stageCharacter(folder, "char_009.json", character("char_009", "消えた人"));
  // 同じ名前の人物がもう居る新規案 → 古い案
  stageCharacter(folder, "new_少女.json", {
    kind: "creation",
    source: "plot",
    character: character("char_000", "少女"),
  });
  // 場所（人物以外）の外部AIの案
  writeJson(nodePath.join(folder, "設定", "locations", "loc_001.json"), location());
  writeJson(nodePath.join(folder, ".aiwriter", "pending-settings", "loc_001.json"), {
    recordKind: "location",
    source: "external",
    reason: "第2話で魚市場の場面があるため。",
    record: location({ description: "灯台と魚市場のある港" }),
  });
  return folder;
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

describe("pending.list——承認待ちを読む", () => {
  it("承認待ちが無ければ0件で、失敗にしない", () => {
    const folder = newWork();
    const result = pendingList({ folder });
    expect(result.total).toBe(0);
    expect(result.items).toEqual([]);
    expect(result.unreadable).toEqual([]);
  });

  it("無い作品フォルダーは断る", () => {
    expect(() =>
      pendingList({ folder: nodePath.join(os.tmpdir(), "存在しない作品-pending") })
    ).toThrow(McpToolError);
  });

  it("1件ずつ、種類・名前・出どころ・理由・変わる欄（前→後）を返す", () => {
    const folder = mixedWork();
    const result = pendingList({ folder });

    const boy = result.items.find((item) => item.id === "char_001");
    expect(boy).toMatchObject({
      file: ".aiwriter/pending-characters/char_001.json",
      recordKind: "character",
      kindLabel: "人物",
      name: "少年",
      creation: false,
      source: "external",
      sourceLabel: "外部AIから",
      reason: "第3話で旅に出るため、紹介を足しました。",
      status: "pending",
    });
    expect(boy?.changes).toContainEqual({
      label: "紹介",
      before: "もとの紹介",
      after: "旅に出た少年",
    });

    const port = result.items.find((item) => item.id === "loc_001");
    expect(port).toMatchObject({
      recordKind: "location",
      kindLabel: "場所",
      name: "港町",
      status: "pending",
      source: "external",
    });
    expect(port?.changes).toContainEqual({
      label: "説明",
      before: "灯台のある小さな港",
      after: "灯台と魚市場のある港",
    });
  });

  it("古い案は、画面に並ばない理由を添えて返す（黙って落とさない）", () => {
    const folder = mixedWork();
    const result = pendingList({ folder });

    const gone = result.items.find((item) => item.id === "char_009");
    expect(gone?.status).toBe("stale");
    expect(gone?.staleReason).toContain("台帳にありません");
    // 出どころの無い案は抽出が積んだもの
    expect(gone?.source).toBe("extraction");
    expect(gone?.sourceLabel).toBe("抽出");

    const duplicate = result.items.find((item) => item.file.endsWith("new_少女.json"));
    expect(duplicate?.status).toBe("stale");
    expect(duplicate?.creation).toBe(true);
    expect(duplicate?.staleReason).toContain("同じ名前の人物");

    expect(result.counts).toEqual({ pending: 2, stale: 2, blocked: 0, unreadable: 0 });
    // 画面に並ぶものが先、古い案は後ろ
    expect(result.items.map((item) => item.status)).toEqual([
      "pending",
      "pending",
      "stale",
      "stale",
    ]);
  });

  it("読めない案は unreadable に積み、残りは読む（製品と同じく直さない）", () => {
    const folder = mixedWork();
    const broken = nodePath.join(folder, ".aiwriter", "pending-characters", "char_003.json");
    fs.writeFileSync(broken, "{ 壊れた", "utf8");

    const result = pendingList({ folder });
    expect(result.unreadable).toHaveLength(1);
    expect(result.unreadable[0].file).toBe(".aiwriter/pending-characters/char_003.json");
    expect(result.counts.unreadable).toBe(1);
    expect(result.total).toBe(5);
    // 直していない
    expect(fs.readFileSync(broken, "utf8")).toBe("{ 壊れた");
  });

  it("読めない人物ファイルがあれば、人物の案は組み立てず blocked で返す（製品と同じ）", () => {
    const folder = mixedWork();
    fs.writeFileSync(
      nodePath.join(folder, "設定", "characters", "char_005.json"),
      "{ 壊れた",
      "utf8"
    );

    const result = pendingList({ folder });
    expect(result.blocked).toEqual([
      { recordKind: "character", ledgerFiles: ["設定/characters/char_005.json"] },
    ]);
    const people = result.items.filter((item) => item.recordKind === "character");
    expect(people.every((item) => item.status === "blocked")).toBe(true);
    // 場所の案は巻き込まれない
    expect(result.items.find((item) => item.id === "loc_001")?.status).toBe("pending");
  });

  it("kind・source で絞り、limit で切る。数える件数は絞る前のまま", () => {
    const folder = mixedWork();

    const places = pendingList({ folder, kind: "location" });
    expect(places.items.map((item) => item.id)).toEqual(["loc_001"]);
    expect(places.matched).toBe(1);
    expect(places.counts.pending).toBe(2);

    const external = pendingList({ folder, source: "external" });
    expect(external.items.map((item) => item.id).sort()).toEqual(["char_001", "loc_001"]);

    const limited = pendingList({ folder, limit: 1 });
    expect(limited.items).toHaveLength(1);
    expect(limited.truncated).toBe(true);
    expect(limited.matched).toBe(4);
  });

  it("読むだけ——作品フォルダーを1バイトも変えない", () => {
    const folder = mixedWork();
    const before = fingerprint(folder);
    pendingList({ folder });
    pendingList({ folder, kind: "character", source: "plot", limit: 1 });
    expect(fingerprint(folder)).toBe(before);
  });
});

/**
 * **提案パネルに並ぶものと一致する**こと。本物の出口
 * （`reviewPendingCharacterUpdates`・`reviewPendingSettingsUpdates` と
 * パネルへ渡す形）を、代役の `workspace.fs` を本物のファイルへ繋いで読み比べる。
 */
describe("pending.list と提案パネルが同じものを並べる", () => {
  beforeEach(() => {
    const missing = (error: unknown): never => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new FileSystemError("missing", "FileNotFound");
      }
      throw error;
    };
    workspace.fs = {
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
    } as never;
  });

  it("名前・一行の説明・差分が、パネルへ渡す形と一致する", async () => {
    const folder = mixedWork();
    const work: WorkEntry = {
      id: "work_pending",
      title: "作品",
      folderPath: folder,
      registeredAt: "2026-09-24T00:00:00.000Z",
    };

    const panel = [
      ...recordUpdateViewItems(await reviewPendingCharacterUpdates(work)),
      ...settingsUpdateViewItems(await reviewPendingSettingsUpdates(work)),
    ];
    const listed = pendingList({ folder }).items.filter(
      (item) => item.status === "pending"
    );

    expect(listed.map((item) => item.name)).toEqual(panel.map((item) => item.name));
    expect(listed.map((item) => item.panelLine)).toEqual(
      panel.map((item) => item.source)
    );
    expect(listed.map((item) => item.changes.map((change) => change.label))).toEqual(
      panel.map((item) => (item.changeParts ?? []).map((part) => part.label))
    );
  });

  it("組み立ては core の同じ関数を通している（写しを作らない）", () => {
    const root = nodePath.join(__dirname, "..", "..", "..");
    const tool = fs.readFileSync(
      nodePath.join(root, "src", "mcp", "tools", "pendingList.ts"),
      "utf8"
    );
    const product = fs.readFileSync(
      nodePath.join(root, "src", "features", "applyPendingUpdates.ts"),
      "utf8"
    );
    for (const name of ["assembleCharacterReview", "assembleSettingsReview"]) {
      expect(tool).toContain(name);
      expect(product).toContain(name);
    }
    // 製品側に古い組み立て（台帳の突き合わせを自前で回すもの）が残っていない
    expect(product).not.toContain("findCharactersByAppellation");
    expect(product).not.toContain("mergePendingSettingsRecord(");
  });
});

describe("pending.list の記録と許可", () => {
  it("設定資料の記述が渡るので、抜粋どまりとして数える", () => {
    expect(exposureOf("pending.list", { folder: "x" })).toBe("excerpt");
  });

  it("記録には絞り方だけを残す", () => {
    const folder = newWork();
    expect(
      recordExternalAccess({
        tool: "pending.list",
        args: { folder, kind: "location" },
        ok: true,
      })
    ).toBe(true);
    const log = parseExternalAccessLog(
      fs.readFileSync(
        nodePath.join(
          folder,
          ".aiwriter",
          EXTERNAL_ACCESS_DIRECTORY,
          EXTERNAL_ACCESS_FILE
        ),
        "utf8"
      )
    );
    expect(log[0]).toMatchObject({
      tool: "pending.list",
      key: "pending.list",
      exposure: "excerpt",
      detail: "承認待ちを読んだ（場所）",
    });
  });
});
