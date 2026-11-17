import { describe, expect, test } from "vitest";
import { randomBytes } from "node:crypto";
import { createDriveClient } from "../../../src/core/driveApi";
import {
  checkSwitchToGithub,
  findDriveUnsent,
} from "../../../src/core/driveDestination";
import { applyDriveConflictChoice } from "../../../src/core/driveSyncEngine";
import { isSendableSyncPath } from "../../../src/core/driveSyncPlan";
import { emptyDriveSyncRecord, type DriveSyncRecord } from "../../../src/core/driveSyncRecord";
import { describeDriveWorkSync, runDriveWorkSync, type DriveWorkSyncResult } from "../../../src/core/driveWorkSync";
import { createGoogleAccessTokens, logoutGoogle, runGoogleLogin } from "../../../src/core/googleLogin";
import { hexToBytes } from "../../../src/core/googleOAuth";
import { hashBytes, sha256Bytes } from "../../../src/core/hash";
import { IGNORED_PATHS, ON_USE_IGNORED_PATHS } from "../../../src/core/workRegistry";
import { createFakeDrive, createFakeWork, type FakeWork } from "../support/fakeDrive";
import { createFakeGoogle, createMemoryVault } from "../support/fakeGoogleAuth";

/**
 * 段階3の往復（設計書5.10.9）：ログイン → 送る → もう1台で受け取る → 食い違い → 選ぶ →
 * 切り替えの確かめ → ログアウト。偽の Google の認可の口と偽のドライブ（`fetch` の段のまね）で、
 * 製品の手順（`runGoogleLogin`・`createGoogleAccessTokens`・`runDriveWorkSync`）をそのまま通す。
 * **本物の Google・ネットには出ない。** 確かめたのは偽物まで（本物は実機確認リスト）。
 *
 * 見逃しと誤検出の両方を数える：場面ごとに「訊くべき食い違い」を書き、最後にまとめて照らす。
 */

const CLIENT = { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-fake" };
const EP1 = "本文/第1話.txt";
const EP2 = "本文/第2話.txt";
const IGNORED = [...IGNORED_PATHS, ...ON_USE_IGNORED_PATHS];
const now = () => Date.parse("2026-11-18T09:00:00.000Z");

function machine(google: ReturnType<typeof createFakeGoogle>, drive: ReturnType<typeof createFakeDrive>, id: string, name: string, initial: Record<string, string>) {
  const vault = createMemoryVault();
  const tokens = createGoogleAccessTokens({ client: async () => CLIENT, vault, fetch: google.fetch, nowMs: now });
  const client = createDriveClient({ fetch: drive.fetch, accessToken: tokens.source, sleep: async () => undefined });
  const work: FakeWork = createFakeWork(initial);
  const state = { record: emptyDriveSyncRecord(id) as DriveSyncRecord };
  const layout = { workFolderName: "w-2026-0001-abcd", deviceId: id, deviceName: name };
  const sizes = () => new Map([...work.disk].map(([entry, bytes]) => [entry, bytes.byteLength]));
  return {
    vault,
    tokens,
    work,
    state,
    login: () =>
      runGoogleLogin({
        client: CLIENT,
        listen: google.listen,
        openBrowser: google.openBrowser,
        fetch: google.fetch,
        randomBytes: (n) => new Uint8Array(randomBytes(n)),
        sha256: (bytes) => hexToBytes(sha256Bytes(bytes)),
        nowMs: now,
        vault,
      }),
    async sync(receiveOnly = false): Promise<DriveWorkSyncResult> {
      const result = await runDriveWorkSync({
        client,
        layout,
        local: work.local,
        writer: work.writer,
        record: state.record,
        ignoredPaths: IGNORED,
        now: new Date(now()),
        sizes: sizes(),
        receiveOnly,
      });
      if (result.kind === "done") state.record = result.record;
      return result;
    },
    unsent: () =>
      findDriveUnsent({
        record: state.record,
        local: new Map([...work.disk].map(([entry, bytes]) => [entry, hashBytes(bytes)])),
        isSendable: (entry) => isSendableSyncPath(entry, { ownDeviceId: id, ignoredPaths: IGNORED }),
      }),
  };
}

const tally: { scene: string; expected: string[]; actual: string[] }[] = [];
function conflictsOf(scene: string, result: DriveWorkSyncResult, expected: string[]) {
  const actual = result.kind === "done" && result.receive.kind === "received" ? result.receive.conflicts.map((c) => c.decision.path).sort() : [];
  tally.push({ scene, expected: [...expected].sort(), actual });
  expect(actual).toEqual([...expected].sort());
  return result.kind === "done" && result.receive.kind === "received" ? result.receive.conflicts : [];
}

describe("段階3：ログインから切り替え・ログアウトまで", () => {
  test("2台の往復", async () => {
    const google = createFakeGoogle({ ...CLIENT, onAccessToken: (token) => drive.setToken(token) });
    const drive = createFakeDrive({ reportsSha256: true });
    const desk = machine(google, drive, "desk-a1b2", "デスクトップ", { [EP1]: "一行目\r\n二行目\r\n", [EP2]: "第2話" });
    const note = machine(google, drive, "note-c3d4", "ノートPC", {});

    // ログインしていなければ送らない（ドライブの口は鍵を求めて auth_expired）
    const before = await desk.sync();
    expect(before).toMatchObject({ kind: "send_failed", error: { kind: "auth_expired" } });
    expect(describeDriveWorkSync("作品", before).text).toMatch(/^「作品」は Google ドライブへ送れませんでした。Google へのログインをやり直してください。$/);

    expect((await desk.login()).ok).toBe(true);
    expect((await note.login()).ok).toBe(true);

    // 送る → もう1台で受け取る。CRLF のバイトをそのまま受け取る（手元の形へ直さない）
    conflictsOf("はじめて送る", await desk.sync(), []);
    const first = await note.sync();
    conflictsOf("はじめて受け取る", first, []);
    expect(note.work.text(EP1)).toBe("一行目\r\n二行目\r\n");
    expect(note.unsent()).toEqual([]);

    // 片方だけ直す → 食い違いにしない
    note.work.write(EP2, "第2話。ノートで書き足した");
    conflictsOf("ノートだけ直した（送る）", await note.sync(), []);
    conflictsOf("ノートだけ直した（受け取る）", await desk.sync(), []);
    expect(desk.work.text(EP2)).toBe("第2話。ノートで書き足した");

    // 2台で同じ所を直す → 食い違い。元の文が無いのでファイルごとに選ぶ
    desk.work.write(EP2, "第2話。デスクトップの直し");
    note.work.write(EP2, "第2話。ノートの直し");
    conflictsOf("同じ所（デスクトップが先に送る）", await desk.sync(), []);
    const atNote = conflictsOf("同じ所（ノートで受け取る）", await note.sync(), [EP2]);
    expect(describeDriveWorkSync("作品", (await note.sync(true)) as DriveWorkSyncResult).conflicts).toBe(1);

    // 選ぶまでは戻せない（選んでいない食い違い）
    expect(checkSwitchToGithub({ unsavedFiles: 0, unsent: note.unsent(), pendingConflicts: [EP2] }).ok).toBe(false);

    // 右（デスクトップ）を残す → ノートは書き、もう1台では2度訊かない
    const chosen = await applyDriveConflictChoice({
      report: atNote[0],
      choice: "remote",
      record: note.state.record,
      writer: note.work.writer,
    });
    expect(chosen.ok).toBe(true);
    if (chosen.ok) note.state.record = chosen.record;
    expect(note.work.text(EP2)).toBe("第2話。デスクトップの直し");
    conflictsOf("選んだあとノートが送る", await note.sync(), []);
    conflictsOf("選んだ結果がデスクトップへ届く", await desk.sync(), []);

    // 何も残っていなければ戻せる。送っていない変更があれば断る
    expect(checkSwitchToGithub({ unsavedFiles: 0, unsent: note.unsent(), pendingConflicts: [] })).toEqual({ ok: true });
    note.work.write(EP1, "まだ送っていない");
    expect(checkSwitchToGithub({ unsavedFiles: 0, unsent: note.unsent(), pendingConflicts: [] }).ok).toBe(false);

    // ログアウトすると送れない（鍵を消した）
    await logoutGoogle({ vault: note.vault, tokens: note.tokens });
    expect(note.vault.value()).toBeUndefined();
    expect(await note.sync()).toMatchObject({ kind: "send_failed", error: { kind: "auth_expired" } });
  });

  test("5MB を超えるファイルがあれば、送る前にファイル名つきで止める（目録まで届かない形にしない）", async () => {
    const google = createFakeGoogle({ ...CLIENT, onAccessToken: (token) => drive.setToken(token) });
    const drive = createFakeDrive();
    const desk = machine(google, drive, "desk-a1b2", "デスクトップ", { [EP1]: "一" });
    desk.work.disk.set("表紙.png", new Uint8Array(5_000_001));
    await desk.login();
    const result = await desk.sync();
    expect(result).toEqual({ kind: "too_large", paths: ["表紙.png"] });
    expect(drive.requests.filter((r) => r.op === "upload")).toHaveLength(0);
    expect(describeDriveWorkSync("作品", result).text).toContain("表紙.png");
  });

  test("ネットが切れたら、送れなかったことを先に書く", async () => {
    const google = createFakeGoogle({ ...CLIENT, onAccessToken: (token) => drive.setToken(token) });
    const drive = createFakeDrive();
    const desk = machine(google, drive, "desk-a1b2", "デスクトップ", { [EP1]: "一" });
    await desk.login();
    drive.setFault(() => "network");
    const result = await desk.sync();
    expect(result).toMatchObject({ kind: "send_failed", error: { kind: "network" } });
    expect(describeDriveWorkSync("作品", result)).toMatchObject({ problem: true });
    expect(describeDriveWorkSync("作品", result).text).toMatch(/送れませんでした。ネットにつながっているか/);
  });

  test("見逃しと誤検出の数（場面をまとめて）", () => {
    const missed = tally.filter((t) => t.expected.some((p) => !t.actual.includes(p)));
    const extra = tally.filter((t) => t.actual.some((p) => !t.expected.includes(p)));
    expect(tally.length).toBeGreaterThanOrEqual(8);
    expect(tally.reduce((n, t) => n + t.expected.length, 0)).toBe(1);
    expect({ missed: missed.map((t) => t.scene), extra: extra.map((t) => t.scene) }).toEqual({ missed: [], extra: [] });
  });
});
