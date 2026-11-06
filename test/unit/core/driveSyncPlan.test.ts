import { describe, expect, test } from "vitest";
import * as path from "node:path";
import {
  DRIVE_SYNC_RECORD_PREFIX,
  buildDriveManifest,
  checkManifestArrival,
  deviceScopedPath,
  isIgnoredSyncPath,
  isSendableSyncPath,
  isSafeSyncPath,
  parseDriveManifest,
  planDriveReceive,
  planDriveReceiveChecked,
  serializeDriveManifest,
  type DriveManifest,
  type DriveSyncDecision,
} from "../../../src/core/driveSyncPlan";
import { IGNORED_PATHS } from "../../../src/core/workRegistry";
import { hashText } from "../../../src/core/hash";
import { SRC, chainTo, relativeName, walkStaticImports } from "../support/importGraph";

/**
 * Google ドライブで2台をそろえる（設計書5.10）の段階1：計画の関数。
 *
 * 書き込みはしないので、ここでは「何をするかの決定」だけを見る。
 * **見逃し（食い違いを素通りする）と誤検出（同じ中身を食い違いにする）の
 * 両方を数える**（設計書5.10.5。片方だけだと、何も訊かない実装が満点になる）。
 */

const H0 = hashText("前回そろえた中身");
const H1 = hashText("このパソコンで書いた中身");
const H2 = hashText("もう1台で書いた中身");
const H3 = hashText("さらに書き足した中身");

function manifest(over: Partial<DriveManifest> = {}): DriveManifest {
  return {
    formatVersion: 2,
    sentAt: "2026-11-06T12:00:00.000Z",
    round: 1,
    deviceId: "device-b",
    deviceName: "ノートPC",
    files: new Map(),
    bases: new Map(),
    deleted: [],
    resolvedConflicts: new Map(),
    ...over,
  };
}

/** 1ファイルだけの計画を立てて、その決定を返す */
function planOne(input: {
  mark?: string;
  local?: string;
  remote?: string | "deleted";
  resolved?: string;
  file?: string;
}): DriveSyncDecision {
  const file = input.file ?? "本文/第1話.txt";
  const files = new Map<string, string>();
  const deleted: string[] = [];
  if (input.remote === "deleted") deleted.push(file);
  else if (input.remote !== undefined) files.set(file, input.remote);
  const resolvedConflicts = new Map<string, { against: string; round: number }>();
  if (input.resolved !== undefined) {
    resolvedConflicts.set(file, { against: input.resolved, round: 1 });
  }

  const decisions = planDriveReceive({
    marks: new Map(input.mark === undefined ? [] : [[file, input.mark]]),
    local: new Map(input.local === undefined ? [] : [[file, input.local]]),
    manifest: manifest({ files, deleted, resolvedConflicts }),
    ignoredPaths: [],
  });
  expect(decisions).toHaveLength(1);
  return decisions[0];
}

describe("3点比較：設計書5.10.4 の表を1行ずつ", () => {
  test("印と同じ・印と同じ → 何もしない", () => {
    expect(planOne({ mark: H0, local: H0, remote: H0 }).kind).toBe("none");
  });

  test("手元が変わった・向こうは印と同じ → 何もしない（次に送る）", () => {
    expect(planOne({ mark: H0, local: H1, remote: H0 }).kind).toBe("none");
  });

  test("手元は印と同じ・向こうが変わった → 受け取る（期待ハッシュは手元の今）", () => {
    const decision = planOne({ mark: H0, local: H0, remote: H2 });
    expect(decision).toMatchObject({
      kind: "receive",
      expectedLocalHash: H0,
      remoteHash: H2,
      viaResolution: false,
    });
  });

  test("両方変わって同じ中身 → 印を進めるだけ", () => {
    expect(planOne({ mark: H0, local: H1, remote: H1 })).toMatchObject({
      kind: "advance",
      hash: H1,
    });
  });

  test("両方変わって違う中身 → 食い違い（機械は選ばない）", () => {
    expect(planOne({ mark: H0, local: H1, remote: H2 })).toMatchObject({
      kind: "conflict",
      markHash: H0,
      localHash: H1,
      remoteHash: H2,
    });
  });

  test("手元に無い・向こうに新しく在る → 新しく置く（create）", () => {
    expect(planOne({ remote: H2 })).toMatchObject({
      kind: "create",
      remoteHash: H2,
    });
  });

  test("印がある・向こうで消えた → 消さない。知らせるだけ", () => {
    expect(planOne({ mark: H0, local: H0, remote: "deleted" })).toMatchObject({
      kind: "remote_deleted",
      localHash: H0,
      localChanged: false,
    });
    // 手元で書き足していても消さない（書き足したことを知らせに添える）
    expect(planOne({ mark: H0, local: H1, remote: "deleted" })).toMatchObject({
      kind: "remote_deleted",
      localChanged: true,
    });
  });

  test("はじめてそろえる（印が無い）：同じ中身なら印を置くだけ", () => {
    expect(planOne({ local: H1, remote: H1 })).toMatchObject({
      kind: "advance",
      hash: H1,
    });
  });

  test("はじめてそろえる（印が無い）：違えば食い違い", () => {
    expect(planOne({ local: H1, remote: H2 })).toMatchObject({
      kind: "conflict",
      markHash: null,
      localHash: H1,
      remoteHash: H2,
    });
  });
});

describe("3点比較：表に無い行の扱い", () => {
  test("手元で消した・向こうは印と同じ → 何もしない（消えたことは次に送る）", () => {
    expect(planOne({ mark: H0, remote: H0 }).kind).toBe("none");
  });

  test("手元で消した・向こうで書き換えた → 食い違い（新しく置くと、消した話が戻ってくる）", () => {
    expect(planOne({ mark: H0, remote: H2 })).toMatchObject({
      kind: "conflict",
      localHash: null,
      remoteHash: H2,
    });
  });

  test("両方で消した → 印を外す（advance の hash が null）", () => {
    expect(planOne({ mark: H0, remote: "deleted" })).toMatchObject({
      kind: "advance",
      hash: null,
    });
  });

  test("印があるのに向こうの目録に載っていない → 何もしない（向こうがまだ受け取っていない）", () => {
    expect(planOne({ mark: H0, local: H0 }).kind).toBe("none");
    expect(planOne({ mark: H0, local: H1 }).kind).toBe("none");
  });

  test("手元にだけある新しい話 → 何もしない（次に送る）", () => {
    expect(planOne({ local: H1 }).kind).toBe("none");
  });
});

describe("見逃しと誤検出を数える（ばらばらの組み合わせ）", () => {
  type LocalState = "absent" | "mark" | "other";
  type RemoteState = "unlisted" | "deleted" | "mark" | "other";

  /**
   * 正解の表。**実装から写さず、設計書5.10.4 の表の言葉で書く。**
   * 鍵は「印の有無|手元|向こう|中身が同じか|選び終えた相手が手元の今か」。
   * 「*」はどちらでもよい。
   */
  function expectedKind(c: {
    hasMark: boolean;
    local: LocalState;
    remote: RemoteState;
    same: boolean;
    resolvedIsLocal: boolean;
  }): DriveSyncDecision["kind"] {
    const presentRemote = c.remote === "mark" || c.remote === "other";
    if (c.hasMark) {
      if (c.remote === "unlisted") return "none";
      if (c.remote === "deleted") return c.local === "absent" ? "advance" : "remote_deleted";
      if (c.local === "absent") return c.remote === "mark" ? "none" : "conflict";
      if (c.same) return c.local === "mark" ? "none" : "advance";
      // ここから下は手元と向こうの中身が違う
      if (c.resolvedIsLocal) return "receive";
      if (c.local === "mark") return "receive";
      if (c.remote === "mark") return "none";
      return "conflict";
    }
    if (c.local === "absent") return presentRemote ? "create" : "none";
    if (!presentRemote) return "none";
    if (c.same) return "advance";
    return c.resolvedIsLocal ? "receive" : "conflict";
  }

  test("全組み合わせで、見逃し0・誤検出0・決定の種類がすべて正解", () => {
    let cases = 0;
    let missed = 0;
    let falsePositive = 0;
    let conflictCases = 0;
    const wrong: string[] = [];

    for (const hasMark of [false, true]) {
      const mark = hasMark ? H0 : undefined;
      for (const localHash of [undefined, H0, H1, H2]) {
        for (const remote of [undefined, "deleted", H0, H1, H2] as const) {
          // 選び終えた食い違いは「手元の今」を指すときだけ意味がある。
          // 指さない値（別のハッシュ）も入れて、規則が誤って発動しないかも見る
          for (const resolved of [undefined, localHash, H3]) {
            if (localHash === undefined && remote === undefined) continue;
            if (!hasMark && (localHash === H0 || remote === H0)) continue;

            const local: LocalState =
              localHash === undefined ? "absent" : localHash === mark ? "mark" : "other";
            const remoteState: RemoteState =
              remote === undefined
                ? "unlisted"
                : remote === "deleted"
                ? "deleted"
                : remote === mark
                ? "mark"
                : "other";
            const same =
              localHash !== undefined && remote !== undefined && remote !== "deleted" && localHash === remote;
            const resolvedIsLocal =
              resolved !== undefined && localHash !== undefined && resolved === localHash;

            const expected = expectedKind({
              hasMark,
              local,
              remote: remoteState,
              same,
              resolvedIsLocal,
            });
            const actual = planOne({ mark, local: localHash, remote, resolved }).kind;
            cases += 1;
            if (expected === "conflict") conflictCases += 1;
            if (expected === "conflict" && actual !== "conflict") missed += 1;
            if (actual === "conflict" && expected !== "conflict") falsePositive += 1;
            if (expected !== actual) {
              wrong.push(
                `印${hasMark ? "あり" : "なし"}・手元${local}・向こう${remoteState}・` +
                  `同じ${same}・選び終え${resolvedIsLocal} → 期待${expected}／実際${actual}`
              );
            }
          }
        }
      }
    }

    // 数を先に見る（落ちたとき、見逃しと誤検出のどちらへ崩れたかが先に出る）
    expect({ missed, falsePositive }).toEqual({ missed: 0, falsePositive: 0 });
    expect(wrong).toEqual([]);
    // 組み合わせが減って「全部通った」にならないよう、件数も押さえる
    // 印なし 3×4×3−3＝33、印あり 4×5×3−3＝57（手元も向こうも無い組は除く）
    expect(cases).toBe(90);
    // うち正解が食い違いの組（見逃しを数える母数）。0件だと見逃しは測れない
    // 印なし：違う中身2組×選び終えでない2通り＝4。印あり：手元で消した×向こう変更
    // 2組×3通り＝6、両方変わって違う2組×2通り＝4。計14
    expect(conflictCases).toBe(14);
  });

  test("多数のファイルを一度に渡しても、ファイルごとに決まり、道の順に並ぶ", () => {
    // 種を決めた乱数で40件。1件ずつ計画したときと同じ決定になることを見る
    let seed = 20261106;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)];

    const marks = new Map<string, string>();
    const local = new Map<string, string>();
    const files = new Map<string, string>();
    const deleted: string[] = [];
    const singles = new Map<string, DriveSyncDecision["kind"]>();

    for (let i = 0; i < 40; i++) {
      const file = `本文/第${String(i + 1).padStart(2, "0")}話.txt`;
      const mark = pick([undefined, H0]);
      const localHash = pick([undefined, H0, H1, H2]);
      const remote = pick([undefined, "deleted", H0, H1, H2] as const);
      if (localHash === undefined && remote === undefined) continue;
      if (mark !== undefined) marks.set(file, mark);
      if (localHash !== undefined) local.set(file, localHash);
      if (remote === "deleted") deleted.push(file);
      else if (remote !== undefined) files.set(file, remote);
      singles.set(file, planOne({ file, mark, local: localHash, remote }).kind);
    }

    const decisions = planDriveReceive({
      marks,
      local,
      manifest: manifest({ files, deleted }),
      ignoredPaths: [],
    });
    expect(decisions.map((d) => d.path)).toEqual([...singles.keys()].sort());
    for (const decision of decisions) {
      expect(decision.kind).toBe(singles.get(decision.path));
    }
  });
});

describe("同じ食い違いを2台で2度訊かない（往復させる）", () => {
  const FILE = "本文/第3話.txt";

  test("A が「左（自分）を残す」→ B は受け取る → B が送り返すと A は何もしない", () => {
    // 前回そろえたとき、2台とも H0。そこから別々に書いた
    const marksA = new Map([[FILE, H0]]);
    const marksB = new Map([[FILE, H0]]);
    const localA = new Map([[FILE, H1]]);
    const localB = new Map([[FILE, H2]]);

    // B が先に送っていた
    const manifestB1 = buildDriveManifest({
      deviceId: "device-b",
      deviceName: "ノートPC",
      round: 1,
      sentAt: "2026-11-06T10:00:00.000Z",
      files: localB,
    });

    // A が受け取ろうとすると食い違い
    const atA = planDriveReceive({ marks: marksA, local: localA, manifest: manifestB1, ignoredPaths: [] });
    expect(atA).toMatchObject([{ path: FILE, kind: "conflict", localHash: H1, remoteHash: H2 }]);

    // 作者が A で「左を残す」。A の手元は H1 のまま、印は H1 へ。
    // 目録には「B の H2 との食い違いを選び終えた」と書く
    marksA.set(FILE, H1);
    const manifestA1 = buildDriveManifest({
      deviceId: "device-a",
      deviceName: "母艦",
      round: 1,
      sentAt: "2026-11-06T11:00:00.000Z",
      files: localA,
      resolvedConflicts: new Map([[FILE, H2]]),
    });
    // 目録は文字にしても同じに読める（ドライブを通るので）
    const parsed = parseDriveManifest(serializeDriveManifest(manifestA1));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // B では選び直させずに受け取る
    const atB = planDriveReceive({ marks: marksB, local: localB, manifest: parsed.manifest, ignoredPaths: [] });
    expect(atB).toMatchObject([
      { path: FILE, kind: "receive", expectedLocalHash: H2, remoteHash: H1, viaResolution: true },
    ]);

    // B が受け取って印を H1 にし、送り返す
    localB.set(FILE, H1);
    marksB.set(FILE, H1);
    const manifestB2 = buildDriveManifest({
      deviceId: "device-b",
      deviceName: "ノートPC",
      round: 2,
      sentAt: "2026-11-06T12:00:00.000Z",
      files: localB,
      previous: manifestB1,
    });
    const backAtA = planDriveReceive({ marks: marksA, local: localA, manifest: manifestB2, ignoredPaths: [] });
    expect(backAtA).toMatchObject([{ path: FILE, kind: "none" }]);
  });

  test("A の選択のあとに B でさらに書いていれば、食い違いに戻す", () => {
    const manifestA = buildDriveManifest({
      deviceId: "device-a",
      deviceName: "母艦",
      round: 1,
      sentAt: "2026-11-06T11:00:00.000Z",
      files: new Map([[FILE, H1]]),
      resolvedConflicts: new Map([[FILE, H2]]),
    });
    const atB = planDriveReceive({
      marks: new Map([[FILE, H0]]),
      local: new Map([[FILE, H3]]),
      manifest: manifestA,
      ignoredPaths: [],
    });
    expect(atB).toMatchObject([{ kind: "conflict", localHash: H3, remoteHash: H1 }]);
  });

  test("A が「右（向こう）を残す」→ B は同じ中身なので印を進めるだけ（選び終えた規則は使わない）", () => {
    const manifestA = buildDriveManifest({
      deviceId: "device-a",
      deviceName: "母艦",
      round: 1,
      sentAt: "2026-11-06T11:00:00.000Z",
      files: new Map([[FILE, H2]]),
      resolvedConflicts: new Map([[FILE, H2]]),
    });
    const atB = planDriveReceive({
      marks: new Map([[FILE, H0]]),
      local: new Map([[FILE, H2]]),
      manifest: manifestA,
      ignoredPaths: [],
    });
    expect(atB).toMatchObject([{ kind: "advance", hash: H2 }]);
  });
});

describe("設定資料は食い違いのとき decideSettingsConflict へ回す印を付ける", () => {
  test("設定/ の JSON は settings: true、base に使う印のハッシュを持つ", () => {
    const decision = planOne({ file: "設定/人物/char_001.json", mark: H0, local: H1, remote: H2 });
    expect(decision).toMatchObject({ kind: "conflict", settings: true, markHash: H0 });
  });

  test("本文は settings: false（ハッシュだけで扱う）", () => {
    const decision = planOne({ file: "本文/第1話.txt", mark: H0, local: H1, remote: H2 });
    expect(decision).toMatchObject({ kind: "conflict", settings: false });
  });
});

describe("送らないもの（IGNORED_PATHS）は計画に出さない", () => {
  test("本物の IGNORED_PATHS を渡すと、キャッシュ等は落ち、承認待ちは残る", () => {
    const files = new Map([
      [".aiwriter/cache/chunk.json", H2],
      [".aiwriter/external-access.json", H2],
      [".novelai-recovery/第1話.txt", H2],
      [".aiwriter/pending-characters/a.json", H2],
      ["本文/第1話.txt", H2],
    ]);
    const decisions = planDriveReceive({
      marks: new Map(),
      local: new Map([[".git/HEAD", H1]]),
      manifest: manifest({ files }),
      ignoredPaths: IGNORED_PATHS,
    });
    expect(decisions.map((d) => d.path)).toEqual([
      ".aiwriter/pending-characters/a.json",
      "本文/第1話.txt",
    ]);
  });

  test("「/」で終わる項目はその下の全部、そうでない項目はその道だけ", () => {
    expect(isIgnoredSyncPath(".aiwriter/cache/a/b.json", [".aiwriter/cache/"])).toBe(true);
    expect(isIgnoredSyncPath(".aiwriter/cache", [".aiwriter/cache/"])).toBe(false);
    expect(isIgnoredSyncPath(".aiwriter/external-access.json", [".aiwriter/external-access.json"])).toBe(true);
    expect(isIgnoredSyncPath(".aiwriter/external-access.json.bak", [".aiwriter/external-access.json"])).toBe(false);
    // .git の中は一覧に無くても送らない
    expect(isIgnoredSyncPath(".git/config", [])).toBe(true);
  });
});

describe("目録が届ききったか", () => {
  const FILE = "本文/第1話.txt";
  const arrived = manifest({ files: new Map([[FILE, H2], ["設定/a.json", H1]]) });

  test("全部のハッシュが合えば届いている（余分なファイルは問わない）", () => {
    expect(
      checkManifestArrival(arrived, new Map([[FILE, H2], ["設定/a.json", H1], ["古い写し.txt", H3]]))
    ).toEqual({ arrived: true });
  });

  test("1つでも足りない・違えば「まだ届ききっていません」で、計画を何も出さない", () => {
    const check = checkManifestArrival(arrived, new Map([[FILE, H0]]));
    expect(check).toEqual({ arrived: false, missing: ["設定/a.json"], mismatched: [FILE] });

    const plan = planDriveReceiveChecked({
      marks: new Map([[FILE, H0]]),
      local: new Map([[FILE, H0]]),
      manifest: arrived,
      actualRemoteHashes: new Map([[FILE, H0]]),
      ignoredPaths: [],
    });
    expect(plan.kind).toBe("not_arrived");
    expect("decisions" in plan).toBe(false);
  });

  test("届いていれば計画を返す", () => {
    const plan = planDriveReceiveChecked({
      marks: new Map([[FILE, H0]]),
      local: new Map([[FILE, H0]]),
      manifest: arrived,
      actualRemoteHashes: new Map([[FILE, H2], ["設定/a.json", H1]]),
      ignoredPaths: [],
    });
    expect(plan.kind).toBe("plan");
    if (plan.kind !== "plan") return;
    expect(plan.decisions.map((d) => [d.path, d.kind])).toEqual([
      ["本文/第1話.txt", "receive"],
      ["設定/a.json", "create"],
    ]);
  });
});

describe("目録の読み取り：壊れた・形の違う目録は直さず「読めない」", () => {
  const good = {
    formatVersion: 2,
    sentAt: "2026-11-06T12:00:00.000Z",
    round: 3,
    deviceId: "device-b",
    deviceName: "ノートPC",
    files: { "本文/第1話.txt": H1 },
    bases: { "本文/第1話.txt": H0 },
    deleted: ["本文/第2話.txt"],
    resolvedConflicts: { "本文/第1話.txt": { against: H2, round: 2 } },
  };

  test("正しい目録は読める", () => {
    const result = parseDriveManifest(JSON.stringify(good));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.round).toBe(3);
    expect(result.manifest.files.get("本文/第1話.txt")).toBe(H1);
    expect(result.manifest.deleted).toEqual(["本文/第2話.txt"]);
    expect(result.manifest.resolvedConflicts.get("本文/第1話.txt")).toEqual({ against: H2, round: 2 });
  });

  const broken: [string, string][] = [
    ["JSONでない", "{ formatVersion: 1"],
    ["配列", "[]"],
    ["版が違う", JSON.stringify({ ...good, formatVersion: 3 })],
    // 版1（選び終えた食い違いがハッシュだけ）は配っていないので読まない
    ["版1", JSON.stringify({ ...good, formatVersion: 1, resolvedConflicts: { "本文/第1話.txt": H2 } })],
    ["版が無い", JSON.stringify({ ...good, formatVersion: undefined })],
    ["回の番号が0", JSON.stringify({ ...good, round: 0 })],
    ["回の番号が小数", JSON.stringify({ ...good, round: 1.5 })],
    ["時刻が読めない", JSON.stringify({ ...good, sentAt: "きのう" })],
    ["端末IDが空", JSON.stringify({ ...good, deviceId: "" })],
    ["端末の名前が無い", JSON.stringify({ ...good, deviceName: undefined })],
    ["files が配列", JSON.stringify({ ...good, files: [] })],
    ["ハッシュの形が違う", JSON.stringify({ ...good, files: { "本文/第1話.txt": "abc" } })],
    ["作品の外を指す道", JSON.stringify({ ...good, files: { "../外.txt": H1 } })],
    ["根から始まる道", JSON.stringify({ ...good, files: { "/etc/x": H1 } })],
    ["ドライブ文字", JSON.stringify({ ...good, files: { "C:/x.txt": H1 } })],
    ["円記号の区切り", JSON.stringify({ ...good, files: { "本文\\第1話.txt": H1 } })],
    ["deleted が文字列", JSON.stringify({ ...good, deleted: "本文/第2話.txt" })],
    ["同じ道が files と deleted の両方", JSON.stringify({ ...good, deleted: ["本文/第1話.txt"] })],
    ["deleted に同じ道が2つ", JSON.stringify({ ...good, deleted: ["a.txt", "a.txt"] })],
    ["選び終えた食い違いのハッシュが壊れている", JSON.stringify({ ...good, resolvedConflicts: { "本文/第1話.txt": 1 } })],
    ["送った端末の印が無い", JSON.stringify({ ...good, bases: undefined })],
    ["送っていないファイルの印", JSON.stringify({ ...good, bases: { "本文/第9話.txt": H0 } })],
    ["印のハッシュが壊れている", JSON.stringify({ ...good, bases: { "本文/第1話.txt": "x" } })],
    ["選び終えた食い違いがハッシュだけ（版1の形）", JSON.stringify({ ...good, resolvedConflicts: { "本文/第1話.txt": H2 } })],
    ["選び終えた食い違いの回が0", JSON.stringify({ ...good, resolvedConflicts: { "本文/第1話.txt": { against: H2, round: 0 } } })],
    ["選び終えた食い違いの回が目録より後", JSON.stringify({ ...good, resolvedConflicts: { "本文/第1話.txt": { against: H2, round: 4 } } })],
  ];

  test.each(broken)("%s → 読めない", (_label, text) => {
    const result = parseDriveManifest(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.length).toBeGreaterThan(0);
  });

  test("道の検証", () => {
    expect(isSafeSyncPath("本文/第1話.txt")).toBe(true);
    expect(isSafeSyncPath(".aiwriter/sessions/device-a.json")).toBe(true);
    for (const bad of ["", "a//b", "./a", "a/./b", "a/../b", "a/", "a:b", "a\u005Cb", "a" + String.fromCharCode(0) + "b"]) {
      expect(isSafeSyncPath(bad)).toBe(false);
    }
  });
});

describe("目録を組む（送る側）", () => {
  test("前の回にあって今は無いファイルを「消えた」に積み、戻ってきたものは外す", () => {
    const first = buildDriveManifest({
      deviceId: "device-a",
      deviceName: "母艦",
      round: 1,
      sentAt: "2026-11-06T10:00:00.000Z",
      files: new Map([["a.txt", H0], ["b.txt", H0]]),
    });
    const second = buildDriveManifest({
      deviceId: "device-a",
      deviceName: "母艦",
      round: 2,
      sentAt: "2026-11-06T11:00:00.000Z",
      files: new Map([["a.txt", H1]]),
      previous: first,
    });
    expect(second.deleted).toEqual(["b.txt"]);
    // 一度消えたものは、次の回でも消えたまま載る（間の回を読み逃した端末のため）
    const third = buildDriveManifest({
      deviceId: "device-a",
      deviceName: "母艦",
      round: 3,
      sentAt: "2026-11-06T12:00:00.000Z",
      files: new Map([["a.txt", H1]]),
      previous: second,
    });
    expect(third.deleted).toEqual(["b.txt"]);
    const fourth = buildDriveManifest({
      deviceId: "device-a",
      deviceName: "母艦",
      round: 4,
      sentAt: "2026-11-06T13:00:00.000Z",
      files: new Map([["a.txt", H1], ["b.txt", H2]]),
      previous: third,
    });
    expect(fourth.deleted).toEqual([]);
  });

  test("選び終えた食い違いは、そのファイルがある間は次の回へ持ち越す", () => {
    const first = buildDriveManifest({
      deviceId: "device-a",
      deviceName: "母艦",
      round: 1,
      sentAt: "2026-11-06T10:00:00.000Z",
      files: new Map([["a.txt", H1]]),
      resolvedConflicts: new Map([["a.txt", H2]]),
    });
    const second = buildDriveManifest({
      deviceId: "device-a",
      deviceName: "母艦",
      round: 2,
      sentAt: "2026-11-06T11:00:00.000Z",
      files: new Map([["a.txt", H3]]),
      previous: first,
    });
    // 回の番号は最初に載せた回のまま（受け取った側が「どの選択を使ったか」を控える）
    expect(second.resolvedConflicts.get("a.txt")).toEqual({ against: H2, round: 1 });
    const third = buildDriveManifest({
      deviceId: "device-a",
      deviceName: "母艦",
      round: 3,
      sentAt: "2026-11-06T12:00:00.000Z",
      files: new Map(),
      previous: second,
    });
    expect(third.resolvedConflicts.size).toBe(0);
  });
});

describe("選び終えた食い違いの持ち越しを外す（0.132.0）", () => {
  const FILE = "本文/第3話.txt";
  const base = {
    deviceId: "device-a",
    deviceName: "母艦",
    sentAt: "2026-11-07T10:00:00.000Z",
  };
  // A が B の H2 と見比べて、自分の H1 を残した回
  const chosen = buildDriveManifest({
    ...base,
    round: 1,
    files: new Map([[FILE, H1]]),
    resolvedConflicts: new Map([[FILE, H2]]),
  });

  test("相手の目録が、こちらが前に送った中身を持っていれば外す", () => {
    const next = buildDriveManifest({
      ...base,
      round: 2,
      files: new Map([[FILE, H1]]),
      previous: chosen,
      peerManifest: manifest({ files: new Map([[FILE, H1]]) }),
    });
    expect(next.resolvedConflicts.size).toBe(0);
  });

  test("相手がまだ受け取っていなければ（目録が H2 のまま）持ち越す", () => {
    const next = buildDriveManifest({
      ...base,
      round: 2,
      files: new Map([[FILE, H1]]),
      previous: chosen,
      peerManifest: manifest({ files: new Map([[FILE, H2]]) }),
    });
    expect(next.resolvedConflicts.get(FILE)).toEqual({ against: H2, round: 1 });
  });

  test("選んだあと手元を相手のハッシュへ戻しても、相手が受け取っていなければ外さない", () => {
    // A が H1 → H2 に戻した。今回の中身は相手と同じだが、相手は前に送った H1 を持っていない
    const next = buildDriveManifest({
      ...base,
      round: 2,
      files: new Map([[FILE, H2]]),
      previous: chosen,
      peerManifest: manifest({ files: new Map([[FILE, H2]]) }),
    });
    expect(next.resolvedConflicts.has(FILE)).toBe(true);
  });

  test("相手の中身が、今回の中身とだけ偶然同じ（前に送った中身ではない）なら外さない", () => {
    const next = buildDriveManifest({
      ...base,
      round: 2,
      files: new Map([[FILE, H3]]),
      previous: chosen,
      peerManifest: manifest({ files: new Map([[FILE, H3]]) }),
    });
    expect(next.resolvedConflicts.has(FILE)).toBe(true);
  });

  test("自分の目録を相手のものとして渡しても外さない", () => {
    const next = buildDriveManifest({
      ...base,
      round: 2,
      files: new Map([[FILE, H1]]),
      previous: chosen,
      peerManifest: chosen,
    });
    expect(next.resolvedConflicts.has(FILE)).toBe(true);
  });
});

describe("使った選択は、手元が偶然同じハッシュへ戻っても2度効かない（0.132.0）", () => {
  const FILE = "本文/第3話.txt";
  // A の目録：B の H2 と見比べて H1 を残した（回1）。A はまだ送り直していない
  const fromA = manifest({
    deviceId: "device-a",
    files: new Map([[FILE, H1]]),
    resolvedConflicts: new Map([[FILE, { against: H2, round: 1 }]]),
  });

  test("B が一度受け取ったあと、元に戻して H2 になっても、受け取らない（作者の書き直しを押し流さない）", () => {
    // B は回1の選択を使って H1 を受け取り、印も H1。そのあと作者が元に戻して H2
    const decisions = planDriveReceive({
      marks: new Map([[FILE, H1]]),
      local: new Map([[FILE, H2]]),
      manifest: fromA,
      ignoredPaths: [],
      consumedResolutions: new Map([[FILE, 1]]),
    });
    expect(decisions).toMatchObject([{ kind: "none", reason: "local_changed" }]);
  });

  test("（比べ）使った控えが無ければ、同じ状況で受け取ってしまう——控えが守りになっている", () => {
    const decisions = planDriveReceive({
      marks: new Map([[FILE, H1]]),
      local: new Map([[FILE, H2]]),
      manifest: fromA,
      ignoredPaths: [],
    });
    expect(decisions).toMatchObject([{ kind: "receive", viaResolution: true, resolutionRound: 1 }]);
  });

  test("後の回で選び直した選択は、前の回を使ったあとでも効く", () => {
    const decisions = planDriveReceive({
      marks: new Map([[FILE, H0]]),
      local: new Map([[FILE, H2]]),
      manifest: manifest({
        deviceId: "device-a",
        round: 3,
        files: new Map([[FILE, H1]]),
        resolvedConflicts: new Map([[FILE, { against: H2, round: 3 }]]),
      }),
      ignoredPaths: [],
      consumedResolutions: new Map([[FILE, 1]]),
    });
    expect(decisions).toMatchObject([{ kind: "receive", viaResolution: true, resolutionRound: 3 }]);
  });
});

describe("こちらが送った中身が向こうから戻ってきたとき（0.132.0）", () => {
  const FILE = "本文/第5話.txt";

  test("送ったあとで書き足していても食い違いにしない（印を向こうへ進めるだけ）", () => {
    // 印 H0 → A が H1 を送る → A はさらに H3 へ。B は H1 を受け取って、そのまま送り返した
    const decisions = planDriveReceive({
      marks: new Map([[FILE, H0]]),
      local: new Map([[FILE, H3]]),
      manifest: manifest({ files: new Map([[FILE, H1]]) }),
      ignoredPaths: [],
      ownSent: new Map([[FILE, [H1]]]),
    });
    expect(decisions).toMatchObject([{ kind: "advance", hash: H1, echo: true }]);
  });

  test("（比べ）送った控えが無ければ食い違いになる——誤検出だった", () => {
    const decisions = planDriveReceive({
      marks: new Map([[FILE, H0]]),
      local: new Map([[FILE, H3]]),
      manifest: manifest({ files: new Map([[FILE, H1]]) }),
      ignoredPaths: [],
    });
    expect(decisions).toMatchObject([{ kind: "conflict" }]);
  });

  test("向こうがこちらの写しのあとで書いていれば（H2）、今までどおり食い違い", () => {
    const decisions = planDriveReceive({
      marks: new Map([[FILE, H0]]),
      local: new Map([[FILE, H3]]),
      manifest: manifest({ files: new Map([[FILE, H2]]) }),
      ignoredPaths: [],
      ownSent: new Map([[FILE, [H1]]]),
    });
    expect(decisions).toMatchObject([{ kind: "conflict", localHash: H3, remoteHash: H2 }]);
  });

  test("見逃しと誤検出を数える：送った控えのある組み合わせ全部", () => {
    let missed = 0;
    let falsePositive = 0;
    let conflicts = 0;
    let cases = 0;
    const wrong: string[] = [];
    for (const mark of [undefined, H0]) {
      for (const localHash of [undefined, H0, H1, H2, H3]) {
        for (const remote of [H0, H1, H2]) {
          if (mark === undefined && (localHash === H0 || remote === H0)) continue;
          // 控えは H1（こちらが送った中身）。正解は設計の言葉で：
          // 向こうが送った中身そのもので、印と違う → 向こうは写しを持つだけ。食い違いではない
          // それ以外は控えが無いときと同じ
          const withoutSent = planOne({ mark, local: localHash, remote });
          const echoed = remote === H1 && remote !== mark;
          const decision = planDriveReceive({
            marks: new Map(mark === undefined ? [] : [["a.txt", mark]]),
            local: new Map(localHash === undefined ? [] : [["a.txt", localHash]]),
            manifest: manifest({ files: new Map([["a.txt", remote]]) }),
            ignoredPaths: [],
            ownSent: new Map([["a.txt", [H1]]]),
          })[0];
          const expected = echoed ? "advance" : withoutSent.kind;
          cases += 1;
          if (expected === "conflict") conflicts += 1;
          if (expected === "conflict" && decision.kind !== "conflict") missed += 1;
          if (decision.kind === "conflict" && expected !== "conflict") falsePositive += 1;
          if (decision.kind !== expected) wrong.push(`印${mark ?? "なし"} 手元${localHash ?? "なし"} 向こう${remote}`);
        }
      }
    }
    expect({ missed, falsePositive }).toEqual({ missed: 0, falsePositive: 0 });
    expect(wrong).toEqual([]);
    // 印なし 4×2＋印あり 5×3＝23。うち食い違いが正解の組（母数）が0でないこと
    expect(cases).toBe(23);
    expect(conflicts).toBeGreaterThan(0);
  });
});

describe("向こうがこちらの送った中身の上に書いたとき（目録の bases。0.132.0）", () => {
  const FILE = "本文/第6話.txt";

  test("A が送った H1 を B が受け取り H2 へ書き足した → A は受け取る（印が無くても食い違いにしない）", () => {
    const decisions = planDriveReceive({
      marks: new Map(),
      local: new Map([[FILE, H1]]),
      manifest: manifest({ files: new Map([[FILE, H2]]), bases: new Map([[FILE, H1]]) }),
      ignoredPaths: [],
      ownSent: new Map([[FILE, [H1]]]),
    });
    expect(decisions).toMatchObject([{ kind: "receive", expectedLocalHash: H1, remoteHash: H2 }]);
  });

  test("（比べ）bases が無ければ食い違いになる——いちばんふつうの往復の誤検出だった", () => {
    const decisions = planDriveReceive({
      marks: new Map(),
      local: new Map([[FILE, H1]]),
      manifest: manifest({ files: new Map([[FILE, H2]]) }),
      ignoredPaths: [],
      ownSent: new Map([[FILE, [H1]]]),
    });
    expect(decisions).toMatchObject([{ kind: "conflict" }]);
  });

  test("A が送ったあとさらに書いていて、B も H1 の上に書いた → 食い違い（見逃さない）", () => {
    const decisions = planDriveReceive({
      marks: new Map([[FILE, H0]]),
      local: new Map([[FILE, H3]]),
      manifest: manifest({ files: new Map([[FILE, H2]]), bases: new Map([[FILE, H1]]) }),
      ignoredPaths: [],
      ownSent: new Map([[FILE, [H1]]]),
    });
    expect(decisions).toMatchObject([{ kind: "conflict", markHash: H1, localHash: H3, remoteHash: H2 }]);
  });

  test("B の印がこちらの送っていない中身なら比べ直さない（B が別に書いたものかもしれない）", () => {
    const decisions = planDriveReceive({
      marks: new Map(),
      local: new Map([[FILE, H1]]),
      manifest: manifest({ files: new Map([[FILE, H2]]), bases: new Map([[FILE, H3]]) }),
      ignoredPaths: [],
      ownSent: new Map([[FILE, [H1]]]),
    });
    expect(decisions).toMatchObject([{ kind: "conflict" }]);
  });

  test("向こうの中身がこちらの印と同じなら、古い bases が送った中身と偶然同じでも比べ直さない", () => {
    // B：H2 を送った → A の H1 を受け取った（印 H1）→ 元に戻して H2 をまた送った（ownSent [H2]）。
    // A の古い目録（中身 H1・A の印 H2）が届き直しても、B の戻しを押し流さない
    const decisions = planDriveReceive({
      marks: new Map([[FILE, H1]]),
      local: new Map([[FILE, H2]]),
      manifest: manifest({ files: new Map([[FILE, H1]]), bases: new Map([[FILE, H2]]) }),
      ignoredPaths: [],
      ownSent: new Map([[FILE, [H2]]]),
    });
    expect(decisions).toMatchObject([{ kind: "none", reason: "local_changed" }]);
  });
});

describe("端末ごとのファイル（sessions・stats）の扱い（0.132.0）", () => {
  const OWN = ".aiwriter/stats/desk-a1b2.json";
  const PEER = ".aiwriter/stats/note-c3d4.json";

  test("自分の端末のファイルは、向こうの写しと違っても受け取らず食い違いにもしない", () => {
    const decisions = planDriveReceive({
      marks: new Map(),
      local: new Map([[OWN, H1]]),
      manifest: manifest({ files: new Map([[OWN, H0]]) }),
      ignoredPaths: [],
      ownDeviceId: "desk-a1b2",
    });
    expect(decisions).toMatchObject([{ path: OWN, kind: "none", reason: "own_device" }]);
  });

  test("（比べ）端末IDを渡さないと食い違いになる——誤検出だった", () => {
    const decisions = planDriveReceive({
      marks: new Map(),
      local: new Map([[OWN, H1]]),
      manifest: manifest({ files: new Map([[OWN, H0]]) }),
      ignoredPaths: [],
    });
    expect(decisions).toMatchObject([{ kind: "conflict" }]);
  });

  test("向こうの端末のファイルは受け取る", () => {
    const decisions = planDriveReceive({
      marks: new Map([[PEER, H0]]),
      local: new Map([[PEER, H0]]),
      manifest: manifest({ files: new Map([[PEER, H2]]) }),
      ignoredPaths: [],
      ownDeviceId: "desk-a1b2",
    });
    expect(decisions).toMatchObject([{ path: PEER, kind: "receive" }]);
  });

  test("道の見分け", () => {
    expect(deviceScopedPath(".aiwriter/sessions/desk-a1b2.json")).toEqual({ dir: "sessions", deviceId: "desk-a1b2" });
    expect(deviceScopedPath(OWN)).toEqual({ dir: "stats", deviceId: "desk-a1b2" });
    // 端末IDの形でない名前・深い道・ほかの置き場は、ふつうのファイル
    expect(deviceScopedPath(".aiwriter/stats/作者のメモ.json")).toBeUndefined();
    expect(deviceScopedPath(".aiwriter/stats/a/b.json")).toBeUndefined();
    expect(deviceScopedPath(".aiwriter/stats/desk-a1b2.txt")).toBeUndefined();
    expect(deviceScopedPath(".aiwriter/history/desk-a1b2.json")).toBeUndefined();
    expect(deviceScopedPath("本文/stats/desk-a1b2.json")).toBeUndefined();
  });

  test("送るのは自分の端末の分だけ。印の置き場はどの端末のものも送らない", () => {
    const own = { ownDeviceId: "desk-a1b2", ignoredPaths: IGNORED_PATHS };
    expect(isSendableSyncPath(OWN, own)).toBe(true);
    expect(isSendableSyncPath(PEER, own)).toBe(false);
    expect(isSendableSyncPath("本文/第1話.txt", own)).toBe(true);
    expect(isSendableSyncPath(`${DRIVE_SYNC_RECORD_PREFIX}desk-a1b2.json`, own)).toBe(false);
    expect(isSendableSyncPath(".aiwriter/cache/x.json", own)).toBe(false);
    expect(isSendableSyncPath("../外.txt", own)).toBe(false);
  });

  test("印の置き場は、受け取りの計画にも出さない", () => {
    const record = `${DRIVE_SYNC_RECORD_PREFIX}note-c3d4.json`;
    const decisions = planDriveReceive({
      marks: new Map(),
      local: new Map(),
      manifest: manifest({ files: new Map([[record, H2]]) }),
      ignoredPaths: [],
    });
    expect(decisions).toEqual([]);
  });
});

describe("モバイル版へそのまま持っていける（vscode・node:・paths を読まない）", () => {
  test("driveSyncPlan.ts から静的にたどれる先に、vscode・node: ・core/paths.ts が無い", () => {
    const entry = path.join(SRC, "core", "driveSyncPlan.ts");
    const reach = walkStaticImports([entry]);
    const bare = reach.bare.map((item) => `${relativeName(item.file)} → ${item.spec}`);
    expect(bare.filter((line) => /→ (vscode|node:)/.test(line))).toEqual([]);
    const paths = path.join(SRC, "core", "paths.ts");
    expect(reach.files.has(paths) ? chainTo(reach, paths) : "").toBe("");
  });
});
