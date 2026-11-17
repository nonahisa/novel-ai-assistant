import { describe, expect, test } from "vitest";
import * as path from "node:path";
import {
  SYNC_DESTINATION_KEY,
  checkSwitchToDrive,
  checkSwitchToGithub,
  destinationOf,
  findDriveUnsent,
  findTooLargeForDrive,
  readPendingConflicts,
  writeDestination,
  writePendingConflicts,
} from "../../../src/core/driveDestination";
import { DRIVE_DELETED } from "../../../src/core/driveSyncPlan";
import { emptyDriveSyncRecord } from "../../../src/core/driveSyncRecord";
import { SRC, chainTo, relativeName, walkStaticImports } from "../support/importGraph";

/** 送り先の切り替え（設計書5.10.5「未送信・食い違い・未保存を残したまま移らない」） */

function memento() {
  const values = new Map<string, unknown>();
  return {
    get: (key: string) => values.get(key),
    update: async (key: string, value: unknown) => {
      values.set(key, value);
    },
    values,
  };
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("送り先の置き場（この機械の globalState）", () => {
  test("記録の無い作品は GitHub。ドライブにして戻すと表から外れる。形の違う値は無いもの", async () => {
    const storage = memento();
    expect(destinationOf(storage, "w1")).toBe("github");
    await writeDestination(storage, "w1", "googleDrive");
    await writeDestination(storage, "w2", "googleDrive");
    expect(destinationOf(storage, "w1")).toBe("googleDrive");
    await writeDestination(storage, "w1", "github");
    expect(storage.values.get(SYNC_DESTINATION_KEY)).toEqual({ w2: "googleDrive" });
    storage.values.set(SYNC_DESTINATION_KEY, { w3: "dropbox", w4: 1 });
    expect(destinationOf(storage, "w3")).toBe("github");
  });

  test("選んでいない食い違いの控え", async () => {
    const storage = memento();
    await writePendingConflicts(storage, "w1", ["b.txt", "a.txt"]);
    expect(readPendingConflicts(storage, "w1")).toEqual(["a.txt", "b.txt"]);
    await writePendingConflicts(storage, "w1", []);
    expect(readPendingConflicts(storage, "w1")).toEqual([]);
  });
});

describe("ドライブへ送っていない道", () => {
  test("頭と違う・頭に無い・手元で消した を数え、同じもの・送らないもの・向こうで消えたものは数えない", () => {
    const record = emptyDriveSyncRecord("desk-a1b2");
    record.lineage.set("本文/第1話.txt", { hash: HASH_A, ancestors: [], gen: 1 });
    record.lineage.set("本文/第2話.txt", { hash: HASH_A, ancestors: [], gen: 1 });
    record.lineage.set("本文/第3話.txt", { hash: HASH_A, ancestors: [], gen: 1 });
    record.lineage.set("本文/第9話.txt", { hash: DRIVE_DELETED, ancestors: [HASH_A], gen: 2 });
    const local = new Map([
      ["本文/第1話.txt", HASH_A],
      ["本文/第2話.txt", HASH_B],
      ["本文/第4話.txt", HASH_B],
      [".aiwriter/cache/x.json", HASH_B],
    ]);
    const unsent = findDriveUnsent({ record, local, isSendable: (entry) => !entry.startsWith(".aiwriter/cache/") });
    expect(unsent).toEqual(["本文/第2話.txt", "本文/第3話.txt", "本文/第4話.txt"]);
  });
});

describe("GitHub → Google ドライブ", () => {
  const clean = { kind: "repo" as const, unsent: false, behind: false, conflicted: false, sharedWith: [] };
  test("何も残っていなければ移れる。git を使っていない作品も移れる", () => {
    expect(checkSwitchToDrive({ unsavedFiles: 0, git: clean, workUid: "present", loggedIn: true })).toEqual({ ok: true });
    expect(checkSwitchToDrive({ unsavedFiles: 0, git: { kind: "none" }, workUid: "absent", loggedIn: true })).toEqual({ ok: true });
  });

  test("未保存・未送信・受け取っていない・食い違い・同じ置き場のほかの作品・ログインしていない・壊れた番号は、全部理由に出して断る", () => {
    const result = checkSwitchToDrive({
      unsavedFiles: 2,
      git: { kind: "repo", unsent: true, behind: true, conflicted: true, sharedWith: ["作品B"] },
      workUid: "invalid",
      loggedIn: false,
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.reasons).toHaveLength(7);
    expect(result.ok ? "" : result.reasons.join()).toContain("作品B");
  });
});

describe("Google ドライブ → GitHub", () => {
  test("送っていない・選んでいない・未保存・控えが読めない、なら断る", () => {
    expect(checkSwitchToGithub({ unsavedFiles: 0, unsent: [], pendingConflicts: [] })).toEqual({ ok: true });
    const result = checkSwitchToGithub({ unsavedFiles: 1, unsent: ["a.txt"], pendingConflicts: ["b.txt"] });
    expect(result.ok ? [] : result.reasons).toHaveLength(3);
    expect(checkSwitchToGithub({ unsavedFiles: 0, unsent: undefined, pendingConflicts: [] }).ok).toBe(false);
  });
});

describe("送る前の大きさの確かめ", () => {
  test("上限を超えた、送るものだけを挙げる", () => {
    const sizes = new Map([
      ["表紙.png", 6_000_000],
      ["本文/第1話.txt", 10],
      [".novelai-recovery/x.bak", 9_000_000],
    ]);
    expect(findTooLargeForDrive(sizes, 5_000_000, (entry) => !entry.startsWith(".novelai-recovery/"))).toEqual(["表紙.png"]);
  });
});

describe("モバイル版へそのまま持っていける", () => {
  for (const name of ["driveDestination.ts", "driveWorkSync.ts", "imeLearningSync.ts"]) {
    test(`${name} から静的にたどれる先に、vscode・node:・core/paths.ts が無い`, () => {
      const reach = walkStaticImports([path.join(SRC, "core", name)]);
      const bare = reach.bare.map((item) => `${relativeName(item.file)} → ${item.spec}`);
      expect(bare.filter((line) => /→ (vscode|node:)/.test(line))).toEqual([]);
      const paths = path.join(SRC, "core", "paths.ts");
      expect(reach.files.has(paths) ? chainTo(reach, paths) : "").toBe("");
    });
  }
});
