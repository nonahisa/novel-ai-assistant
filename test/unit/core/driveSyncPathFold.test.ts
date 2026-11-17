import { describe, expect, test } from "vitest";
import {
  buildDriveManifest,
  deviceScopedPath,
  isIgnoredSyncPath,
  isSafeSyncPath,
  isSendableSyncPath,
  planDriveReceive,
} from "../../../src/core/driveSyncPlan";
import { IGNORED_PATHS, ON_USE_IGNORED_PATHS } from "../../../src/core/workRegistry";

/**
 * 送らない道の照合は、Windows が同じ所と読む名前でも当てる（設計書5.10.9）。
 * Windows は大文字小文字を区別せず、名前の末尾の「.」と空白を落とす。区別して照らすと、
 * 目録に「.GIT/hooks/…」「.git./…」と書かれただけで .git・回復先・この端末の控えへ書ける。
 */

const IGNORED = [...IGNORED_PATHS, ...ON_USE_IGNORED_PATHS];
const HASH = "a".repeat(64);

const sneaky = [
  ".GIT/hooks/pre-commit",
  ".git./hooks/pre-commit",
  ".git /config",
  ".Git../HEAD",
  ".NOVELAI-RECOVERY/x.bak",
  ".novelai-recovery./x.bak",
  ".AIWRITER/Drive-Sync/desk-a1b2.json",
  ".aiwriter./drive-sync /desk-a1b2.json",
  ".aiwriter/CACHE/c.json",
];

describe("送らない道は、大文字小文字と末尾の「.」・空白を落として照らす", () => {
  for (const entry of sneaky) {
    test(`${entry} は送らない・受け取らない`, () => {
      expect(isIgnoredSyncPath(entry, IGNORED)).toBe(true);
      expect(isSendableSyncPath(entry, { ownDeviceId: "desk-a1b2", ignoredPaths: IGNORED })).toBe(false);
    });
  }

  test("目録に書かれていても、受け取りの計画に出てこない", () => {
    const files = new Map(sneaky.map((entry) => [entry, { hash: HASH, ancestors: [], gen: 1 }]));
    files.set("本文/第1話.txt", { hash: HASH, ancestors: [], gen: 1 });
    const manifest = buildDriveManifest({ deviceId: "note-c3d4", deviceName: "ノートPC", round: 1, sentAt: "2026-11-18T00:00:00.000Z", files });
    const decisions = planDriveReceive({
      lineage: new Map(),
      local: new Map(),
      peers: [{ deviceId: "note-c3d4", deviceName: "ノートPC", manifest }],
      ignoredPaths: IGNORED,
      ownDeviceId: "desk-a1b2",
    });
    expect(decisions.map((decision) => decision.path)).toEqual(["本文/第1話.txt"]);
  });

  test("自分の端末のファイルも同じように見分ける", () => {
    expect(deviceScopedPath(".AIWRITER/Sessions/desk-a1b2.json")?.deviceId).toBe("desk-a1b2");
  });

  test("落とすと空・「.」・「..」になる区切りは、作品の外を指しうるので読めない", () => {
    for (const entry of ["... /x.txt", "本文/. /x.txt", "本文/.. /x.txt", "本文/ /x.txt"]) {
      expect(isSafeSyncPath(entry)).toBe(false);
    }
    expect(isSafeSyncPath("本文/第1話.txt")).toBe(true);
    expect(isIgnoredSyncPath("本文/第1話.txt", IGNORED)).toBe(false);
  });
});
