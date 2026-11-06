import { describe, expect, test } from "vitest";
import * as path from "node:path";
import {
  DRIVE_DELETED,
  DRIVE_LINEAGE_LIMIT,
  DRIVE_SYNC_RECORD_PREFIX,
  buildDriveManifest,
  checkManifestArrival,
  compareDriveLineage,
  deviceScopedPath,
  isIgnoredSyncPath,
  isSendableSyncPath,
  isSafeSyncPath,
  joinDriveLineage,
  localDriveLineage,
  parseDriveManifest,
  planDriveReceive,
  planDriveSend,
  serializeDriveManifest,
  type DriveLineage,
  type DriveManifest,
  type DrivePeer,
  type DriveSyncDecision,
} from "../../../src/core/driveSyncPlan";
import { IGNORED_PATHS } from "../../../src/core/workRegistry";
import { hashText } from "../../../src/core/hash";
import { SRC, chainTo, relativeName, walkStaticImports } from "../support/importGraph";

/**
 * Google ドライブで作品をそろえる（設計書5.10）の計画の関数。0.133.0 で
 * 中身の系譜（設計書5.10.6）へ置き換えた。
 *
 * 書き込みはしないので、ここでは「何をするかの決定」だけを見る。
 * **見逃し（食い違いを素通りする）と誤検出（訊かなくてよいものを訊く）の
 * 両方を数える**（片方だけだと、何も訊かない実装が満点になる）。
 * 正解は実装から写さず、設計書5.10.6 の言葉（どちらの中身がもう一方の
 * 祖先に入っているか）で表に書く。
 */

const H0 = hashText("前回そろえた中身");
const H1 = hashText("このパソコンで書いた中身");
const H2 = hashText("もう1台で書いた中身");
const H3 = hashText("3台目で書いた中身");

const FILE = "本文/第1話.txt";

const lin = (hash: string, gen: number, ancestors: string[] = []): DriveLineage => ({ hash, gen, ancestors });

function manifest(over: Partial<DriveManifest> = {}): DriveManifest {
  return {
    formatVersion: 3,
    sentAt: "2026-11-07T12:00:00.000Z",
    round: 1,
    deviceId: "note-c3d4",
    deviceName: "ノートPC",
    files: new Map(),
    ...over,
  };
}

function peer(deviceId: string, files: Record<string, DriveLineage>): DrivePeer {
  return {
    deviceId,
    deviceName: deviceId,
    manifest: manifest({ deviceId, files: new Map(Object.entries(files)) }),
  };
}

/** 1ファイルだけの計画を立てて、その決定を返す */
function planOne(input: {
  head?: DriveLineage;
  local?: string;
  remotes: (DriveLineage | undefined)[];
  file?: string;
}): DriveSyncDecision {
  const file = input.file ?? FILE;
  const peers = input.remotes.map((remote, i) =>
    peer(["note-c3d4", "tab-e5f6", "mac-g7h8"][i], remote === undefined ? {} : { [file]: remote })
  );
  const decisions = planDriveReceive({
    lineage: new Map(input.head === undefined ? [] : [[file, input.head]]),
    local: new Map(input.local === undefined ? [] : [[file, input.local]]),
    peers,
    ignoredPaths: [],
  });
  expect(decisions).toHaveLength(1);
  return decisions[0];
}

describe("系譜の比べ（設計書5.10.6 の4通り）", () => {
  test("同じ中身 → same／手元が向こうの祖先 → newer／向こうが手元の祖先 → older／どちらでもない → diverged", () => {
    expect(compareDriveLineage(lin(H1, 1, [H0]), lin(H1, 3, [H2]))).toBe("same");
    expect(compareDriveLineage(lin(H0, 0), lin(H1, 1, [H0]))).toBe("newer");
    expect(compareDriveLineage(lin(H1, 1, [H0]), lin(H0, 0))).toBe("older");
    expect(compareDriveLineage(lin(H1, 1, [H0]), lin(H2, 1, [H0]))).toBe("diverged");
    // 手元が知らないファイルは、向こうが新しい
    expect(compareDriveLineage(undefined, lin(H2, 0))).toBe("newer");
  });

  test("書いてから元に戻した中身（互いに相手を祖先に持つ）は、回の数が多い側が新しい", () => {
    // 元の文 H0 → 直した文 H1 → 元の文 H0
    const reverted = lin(H0, 2, [H1, H0]);
    const edited = lin(H1, 1, [H0]);
    expect(compareDriveLineage(edited, reverted)).toBe("newer");
    expect(compareDriveLineage(reverted, edited)).toBe("older");
  });

  test("互いに相手を祖先に持ち、回の数も同じ（2台で同じ食い違いを別々に選んだ）→ 決めずに食い違い", () => {
    expect(compareDriveLineage(lin(H1, 2, [H2, H0]), lin(H2, 2, [H1, H0]))).toBe("diverged");
  });

  test("祖先の上限より古い中身は見つからないので diverged（黙って上書きしない）", () => {
    let head = lin(H0, 0);
    for (let i = 1; i <= DRIVE_LINEAGE_LIMIT + 1; i++) head = localDriveLineage(head, hashText(`第${i}版`)) as DriveLineage;
    expect(head.ancestors).toHaveLength(DRIVE_LINEAGE_LIMIT);
    expect(head.ancestors).not.toContain(H0);
    expect(compareDriveLineage(lin(H0, 0), head)).toBe("diverged");
  });
});

describe("手元の系譜（localDriveLineage）", () => {
  test("頭と同じならそのまま。違えば頭を祖先の先頭に足す。消えたら「消えた」を積む", () => {
    const head = lin(H1, 1, [H0]);
    expect(localDriveLineage(head, H1)).toBe(head);
    expect(localDriveLineage(head, H2)).toEqual(lin(H2, 2, [H1, H0]));
    expect(localDriveLineage(head, undefined)).toEqual(lin(DRIVE_DELETED, 2, [H1, H0]));
    expect(localDriveLineage(lin(DRIVE_DELETED, 2, [H1, H0]), undefined)).toEqual(lin(DRIVE_DELETED, 2, [H1, H0]));
    // 頭が無ければ、どこから来たか分からない中身
    expect(localDriveLineage(undefined, H1)).toEqual(lin(H1, 0));
    expect(localDriveLineage(undefined, undefined)).toBeUndefined();
  });

  test("合流（joinDriveLineage）は、退けた側の中身と祖先も祖先へ入れ、回の数を両方より1つ上げる", () => {
    expect(joinDriveLineage(lin(H1, 1, [H0]), [lin(H2, 3, [H0])])).toEqual(lin(H1, 4, [H2, H0]));
    // 設定資料を合わせたときは、合わせた中身を頭にして両方を祖先へ
    expect(joinDriveLineage(lin(H1, 1, [H0]), [lin(H2, 1, [H0])], H3)).toEqual(lin(H3, 2, [H1, H2, H0]));
  });
});

describe("相手1台との比べ：設計書5.10.4 の表を系譜の言葉で", () => {
  const BASE = lin(H0, 0);

  test("そろえたまま・向こうも同じ → 何もしない", () => {
    expect(planOne({ head: BASE, local: H0, remotes: [BASE] })).toMatchObject({ kind: "none", reason: "unchanged" });
  });

  test("手元で書いた・向こうはそろえたときの中身 → 何もしない（次に送る）", () => {
    expect(planOne({ head: BASE, local: H1, remotes: [BASE] })).toMatchObject({ kind: "none", reason: "local_changed" });
  });

  test("そろえたまま・向こうが書いた → 受け取る（期待ハッシュは手元の今、系譜は向こうのもの）", () => {
    expect(planOne({ head: BASE, local: H0, remotes: [lin(H2, 1, [H0])] })).toMatchObject({
      kind: "receive",
      expectedLocalHash: H0,
      remoteHash: H2,
      lineage: lin(H2, 1, [H0]),
      from: ["note-c3d4"],
    });
  });

  test("両方で書いて同じ中身 → 系譜だけ進める", () => {
    expect(planOne({ head: BASE, local: H1, remotes: [lin(H1, 1, [H0])] })).toMatchObject({
      kind: "advance",
      lineage: { hash: H1 },
    });
  });

  test("両方で書いて違う中身 → 食い違い（相手の一覧を返す）", () => {
    expect(planOne({ head: BASE, local: H1, remotes: [lin(H2, 1, [H0])] })).toMatchObject({
      kind: "conflict",
      localHash: H1,
      local: lin(H1, 1, [H0]),
      remotes: [{ devices: [{ deviceId: "note-c3d4" }], lineage: lin(H2, 1, [H0]) }],
      localIsAncestor: false,
    });
  });

  test("手元に無い・向こうに在る → 新しく置く（create）", () => {
    expect(planOne({ remotes: [lin(H2, 0)] })).toMatchObject({ kind: "create", remoteHash: H2 });
  });

  test("向こうで消えた → 消さない。知らせるだけ（手元で書いていればそれも添える）", () => {
    const deleted = lin(DRIVE_DELETED, 1, [H0]);
    expect(planOne({ head: BASE, local: H0, remotes: [deleted] })).toMatchObject({
      kind: "remote_deleted",
      localHash: H0,
      localChanged: false,
    });
    expect(planOne({ head: BASE, local: H1, remotes: [deleted] })).toMatchObject({
      kind: "remote_deleted",
      localChanged: true,
    });
  });

  test("はじめてそろえる：同じ中身なら系譜を置くだけ、違えば食い違い", () => {
    expect(planOne({ local: H1, remotes: [lin(H1, 0)] })).toMatchObject({ kind: "advance" });
    expect(planOne({ local: H1, remotes: [lin(H2, 0)] })).toMatchObject({ kind: "conflict", local: lin(H1, 0) });
  });

  test("はじめてそろえる台の中身が向こうの祖先にある → 受け取る（0.132.0 までは食い違いだった）", () => {
    expect(planOne({ local: H1, remotes: [lin(H2, 1, [H1])] })).toMatchObject({ kind: "receive", remoteHash: H2 });
  });

  test("表に無い行：手元で消した×向こうは同じ → 何もしない／×向こうで書いた → 食い違い／両方で消した → 系譜を「消えた」へ", () => {
    expect(planOne({ head: BASE, remotes: [BASE] })).toMatchObject({ kind: "none", reason: "local_deleted" });
    expect(planOne({ head: BASE, remotes: [lin(H2, 1, [H0])] })).toMatchObject({
      kind: "conflict",
      localHash: null,
      local: lin(DRIVE_DELETED, 1, [H0]),
    });
    expect(planOne({ head: BASE, remotes: [lin(DRIVE_DELETED, 1, [H0])] })).toMatchObject({
      kind: "advance",
      lineage: { hash: DRIVE_DELETED },
    });
  });

  test("どの相手の目録にも載っていない → 何もしない（相手がまだ受け取っていない）", () => {
    expect(planOne({ head: BASE, local: H0, remotes: [undefined] })).toMatchObject({ kind: "none", reason: "unchanged" });
    expect(planOne({ head: BASE, local: H1, remotes: [undefined] })).toMatchObject({ kind: "none", reason: "local_changed" });
    expect(planOne({ local: H1, remotes: [undefined] })).toMatchObject({ kind: "none", reason: "local_only" });
  });
});

describe("見逃しと誤検出を数える（手元5通り×相手8通り）", () => {
  type Kind = DriveSyncDecision["kind"];
  const localCases: Record<string, { head?: DriveLineage; local?: string }> = {
    知らない: {},
    そろえたまま: { head: lin(H0, 0), local: H0 },
    手元で書いた: { head: lin(H0, 0), local: H1 },
    手元で消した: { head: lin(H0, 0) },
    初めて手元にある: { local: H1 },
  };
  const remoteCases: Record<string, DriveLineage | undefined> = {
    載っていない: undefined,
    そろえたときの中身: lin(H0, 0),
    手元と同じに書いた: lin(H1, 1, [H0]),
    別に書いた: lin(H2, 1, [H0]),
    手元の書いた中身の上に書いた: lin(H2, 2, [H1, H0]),
    消した: lin(DRIVE_DELETED, 1, [H0]),
    由来の分からない別の中身: lin(H2, 0),
    由来の分からない手元と同じ中身: lin(H1, 0),
  };
  /**
   * 正解の表（設計書5.10.6 の言葉で手で書いた。実装から写さない）。
   * 並びは remoteCases の順
   */
  const expected: Record<string, Kind[]> = {
    // 知らないファイル：中身があれば置く、消えたものは何もしない
    知らない: ["none", "create", "create", "create", "create", "none", "create", "create"],
    // そろえたまま：手元の中身（H0）を祖先に持つものは受け取る。由来の分からない違う中身は食い違い
    そろえたまま: ["none", "none", "receive", "receive", "receive", "remote_deleted", "conflict", "conflict"],
    // 手元で書いた（H1←H0）：同じ中身なら進める、H0 は古い、H1 の上に書いたものは受け取る
    手元で書いた: ["none", "none", "advance", "conflict", "receive", "remote_deleted", "conflict", "advance"],
    // 手元で消した（消えた←H0）：書き換えたものとは食い違い、両方で消したら進める
    手元で消した: ["none", "none", "conflict", "conflict", "conflict", "advance", "conflict", "conflict"],
    // 初めて手元にある（H1、由来なし）：同じ中身なら進める、H1 の上に書いたものは受け取る
    初めて手元にある: ["none", "conflict", "advance", "conflict", "receive", "none", "conflict", "advance"],
  };

  test("全組み合わせで、見逃し0・誤検出0・決定の種類がすべて正解", () => {
    let cases = 0;
    let missed = 0;
    let falsePositive = 0;
    let conflictCases = 0;
    const wrong: string[] = [];
    const remoteNames = Object.keys(remoteCases);
    for (const [localName, localCase] of Object.entries(localCases)) {
      remoteNames.forEach((remoteName, i) => {
        if (localCase.head === undefined && localCase.local === undefined && remoteCases[remoteName] === undefined) {
          return; // 手元も向こうも何も無い組は計画に出ない
        }
        const want = expected[localName][i];
        const got = planOne({ ...localCase, remotes: [remoteCases[remoteName]] }).kind;
        cases += 1;
        if (want === "conflict") conflictCases += 1;
        if (want === "conflict" && got !== "conflict") missed += 1;
        if (got === "conflict" && want !== "conflict") falsePositive += 1;
        if (want !== got) wrong.push(`${localName}×${remoteName} → 期待${want}／実際${got}`);
      });
    }
    expect({ missed, falsePositive }).toEqual({ missed: 0, falsePositive: 0 });
    expect(wrong).toEqual([]);
    // 5×8−1（知らない×載っていない）＝39。うち正解が食い違いの組（見逃しの母数）は
    // そろえたまま2・手元で書いた2・手元で消した5・初めて手元にある3＝12
    expect(cases).toBe(39);
    expect(conflictCases).toBe(12);
  });
});

describe("相手が2台以上（設計書5.10.6）", () => {
  const BASE = lin(H0, 0);
  const B_EDIT = lin(H1, 1, [H0]);
  const C_EDIT = lin(H2, 1, [H0]);
  const ON_B = lin(H2, 2, [H1, H0]);
  const DELETED = lin(DRIVE_DELETED, 1, [H0]);

  /** 場面：手元・相手2台・正解の決定。正解は設計書の言葉で書く */
  const scenes: { name: string; head?: DriveLineage; local?: string; remotes: DriveLineage[]; want: DriveSyncDecision["kind"]; remoteCount?: number }[] = [
    { name: "2台が別々に書いた（手元はそろえたまま）", head: BASE, local: H0, remotes: [B_EDIT, C_EDIT], want: "conflict", remoteCount: 2 },
    { name: "順送り：B の中身の上に C が書いた", head: BASE, local: H0, remotes: [B_EDIT, ON_B], want: "receive" },
    { name: "2台が同じ中身に書いた", head: BASE, local: H0, remotes: [C_EDIT, lin(H2, 2, [H1, H0])], want: "receive" },
    { name: "手元と同じ中身の台と、その上に書いた台", head: BASE, local: H1, remotes: [B_EDIT, ON_B], want: "receive" },
    { name: "1台は古い、1台は手元と食い違う", head: BASE, local: H1, remotes: [BASE, C_EDIT], want: "conflict", remoteCount: 1 },
    { name: "1台は消した、1台は書いた（書いた中身を受け取る）", head: BASE, local: H0, remotes: [DELETED, C_EDIT], want: "receive" },
    { name: "2台とも消した", head: BASE, local: H0, remotes: [DELETED, DELETED], want: "remote_deleted" },
    { name: "手元で書いた・1台は消した・1台は古い", head: BASE, local: H1, remotes: [DELETED, BASE], want: "remote_deleted" },
    { name: "3台が別々に書いた", head: BASE, local: H1, remotes: [C_EDIT, lin(H3, 1, [H0])], want: "conflict", remoteCount: 2 },
    // 手元（H0）と同じ中身の台が「元に戻した」ことを知っている。B の H1 は古い
    { name: "元に戻した中身を同じ中身の台から知る", head: BASE, local: H0, remotes: [lin(H0, 2, [H1, H0]), B_EDIT], want: "advance" },
    // A で H2 を退けて H1 を残した結果（H1 の祖先に H2）を、同じ H1 の台から知る
    { name: "選び終えた結果を同じ中身の台から知る", head: lin(H1, 1, [H0]), local: H1, remotes: [lin(H1, 2, [H2, H0]), C_EDIT], want: "advance" },
  ];

  test("場面ごとに決定が正解どおり。見逃し0・誤検出0", () => {
    let missed = 0;
    let falsePositive = 0;
    let conflicts = 0;
    const wrong: string[] = [];
    for (const scene of scenes) {
      const decision = planOne({ head: scene.head, local: scene.local, remotes: scene.remotes });
      if (scene.want === "conflict") conflicts += 1;
      if (scene.want === "conflict" && decision.kind !== "conflict") missed += 1;
      if (decision.kind === "conflict" && scene.want !== "conflict") falsePositive += 1;
      if (decision.kind !== scene.want) wrong.push(`${scene.name}：期待${scene.want}／実際${decision.kind}`);
      if (decision.kind === "conflict" && scene.remoteCount !== undefined) {
        expect(decision.remotes, scene.name).toHaveLength(scene.remoteCount);
      }
    }
    expect({ missed, falsePositive }).toEqual({ missed: 0, falsePositive: 0 });
    expect(wrong).toEqual([]);
    expect(scenes).toHaveLength(11);
    expect(conflicts).toBe(3);
  });

  test("相手どうしだけが食い違うときは localIsAncestor が立つ", () => {
    const decision = planOne({ head: BASE, local: H0, remotes: [B_EDIT, C_EDIT] });
    expect(decision).toMatchObject({ kind: "conflict", localIsAncestor: true });
  });

  test("同じ中身の台はまとめて1件にし、読む端末を並べる", () => {
    const decision = planOne({ head: BASE, local: H0, remotes: [C_EDIT, C_EDIT] });
    expect(decision).toMatchObject({ kind: "receive", from: ["note-c3d4", "tab-e5f6"] });
  });

  test("多数のファイルを一度に渡しても、ファイルごとに決まり、道の順に並ぶ", () => {
    let seed = 20261107;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
    const heads = [undefined, BASE];
    const locals = [undefined, H0, H1];
    const remotes = [undefined, BASE, B_EDIT, C_EDIT, ON_B, DELETED];
    const lineage = new Map<string, DriveLineage>();
    const local = new Map<string, string>();
    const filesB = new Map<string, DriveLineage>();
    const filesC = new Map<string, DriveLineage>();
    const singles = new Map<string, DriveSyncDecision["kind"]>();
    for (let i = 0; i < 40; i++) {
      const file = `本文/第${String(i + 1).padStart(2, "0")}話.txt`;
      const head = pick(heads);
      const localHash = pick(locals);
      const b = pick(remotes);
      const c = pick(remotes);
      if (head === undefined && localHash === undefined && b === undefined && c === undefined) continue;
      if (head) lineage.set(file, head);
      if (localHash) local.set(file, localHash);
      if (b) filesB.set(file, b);
      if (c) filesC.set(file, c);
      singles.set(file, planOne({ file, head, local: localHash, remotes: [b, c] }).kind);
    }
    const decisions = planDriveReceive({
      lineage,
      local,
      peers: [
        { deviceId: "note-c3d4", deviceName: "", manifest: manifest({ files: filesB }) },
        { deviceId: "tab-e5f6", deviceName: "", manifest: manifest({ deviceId: "tab-e5f6", files: filesC }) },
      ],
      ignoredPaths: [],
    });
    expect(decisions.map((d) => d.path)).toEqual([...singles.keys()].sort());
    for (const decision of decisions) expect(decision.kind).toBe(singles.get(decision.path));
  });
});

describe("送るときの系譜（planDriveSend）", () => {
  const all = () => true;

  test("頭と同じ中身はそのまま、書いた中身は頭を祖先に足す、控えに無い中身は祖先なし", () => {
    const out = planDriveSend({
      lineage: new Map([["a.txt", lin(H0, 0)], ["b.txt", lin(H0, 0)]]),
      local: new Map([["a.txt", H0], ["b.txt", H1], ["c.txt", H2]]),
      isSendable: all,
    });
    expect(out.get("a.txt")).toEqual(lin(H0, 0));
    expect(out.get("b.txt")).toEqual(lin(H1, 1, [H0]));
    expect(out.get("c.txt")).toEqual(lin(H2, 0));
  });

  test("手元から消えたものは「消えた」を積む。控えを失っても、前の回の目録から積み続ける", () => {
    const out = planDriveSend({
      lineage: new Map([["a.txt", lin(H1, 1, [H0])]]),
      local: new Map(),
      isSendable: all,
    });
    expect(out.get("a.txt")).toEqual(lin(DRIVE_DELETED, 2, [H1, H0]));
    const previous = manifest({ files: new Map([["b.txt", lin(DRIVE_DELETED, 3, [H2])], ["c.txt", lin(H2, 0)]]) });
    const carried = planDriveSend({ lineage: new Map(), local: new Map(), previous, isSendable: all });
    expect(carried.get("b.txt")).toEqual(lin(DRIVE_DELETED, 3, [H2]));
    expect(carried.get("c.txt")).toEqual(lin(DRIVE_DELETED, 1, [H2]));
  });

  test("送らない道（ほかの端末のファイル・キャッシュ）は載せない", () => {
    const out = planDriveSend({
      lineage: new Map([[".aiwriter/stats/note-c3d4.json", lin(H0, 0)]]),
      local: new Map([[".aiwriter/stats/note-c3d4.json", H0], [".aiwriter/cache/x.json", H1], ["本文/a.txt", H2]]),
      isSendable: (entry) => isSendableSyncPath(entry, { ownDeviceId: "desk-a1b2", ignoredPaths: IGNORED_PATHS }),
    });
    expect([...out.keys()]).toEqual(["本文/a.txt"]);
  });

  test("祖先は上限で切る（新しい順を保つ）", () => {
    let lineage = new Map<string, DriveLineage>([["a.txt", lin(H0, 0)]]);
    for (let i = 1; i <= DRIVE_LINEAGE_LIMIT + 5; i++) {
      lineage = planDriveSend({ lineage, local: new Map([["a.txt", hashText(`第${i}版`)]]), isSendable: all });
    }
    const last = lineage.get("a.txt") as DriveLineage;
    expect(last.ancestors).toHaveLength(DRIVE_LINEAGE_LIMIT);
    expect(last.ancestors[0]).toBe(hashText(`第${DRIVE_LINEAGE_LIMIT + 4}版`));
    expect(last.gen).toBe(DRIVE_LINEAGE_LIMIT + 5);
  });
});

describe("送らないもの（IGNORED_PATHS）は計画に出さない", () => {
  test("本物の IGNORED_PATHS を渡すと、キャッシュ等は落ち、承認待ちは残る", () => {
    const files: Record<string, DriveLineage> = {
      ".aiwriter/cache/chunk.json": lin(H2, 0),
      ".aiwriter/external-access.json": lin(H2, 0),
      ".novelai-recovery/第1話.txt": lin(H2, 0),
      ".aiwriter/pending-characters/a.json": lin(H2, 0),
      "本文/第1話.txt": lin(H2, 0),
    };
    const decisions = planDriveReceive({
      lineage: new Map(),
      local: new Map([[".git/HEAD", H1]]),
      peers: [peer("note-c3d4", files)],
      ignoredPaths: IGNORED_PATHS,
    });
    expect(decisions.map((d) => d.path)).toEqual([".aiwriter/pending-characters/a.json", "本文/第1話.txt"]);
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
  const arrived = manifest({
    files: new Map([[FILE, lin(H2, 0)], ["設定/a.json", lin(H1, 0)], ["消えた.txt", lin(DRIVE_DELETED, 1, [H0])]]),
  });

  test("全部のハッシュが合えば届いている（余分なファイル・消えたものは問わない）", () => {
    expect(
      checkManifestArrival(arrived, new Map([[FILE, H2], ["設定/a.json", H1], ["古い写し.txt", H3]]))
    ).toEqual({ arrived: true });
  });

  test("1つでも足りない・違えば「まだ届ききっていません」", () => {
    expect(checkManifestArrival(arrived, new Map([[FILE, H0]]))).toEqual({
      arrived: false,
      missing: ["設定/a.json"],
      mismatched: [FILE],
    });
  });
});

describe("目録の読み取り：壊れた・形の違う目録は直さず「読めない」", () => {
  const good = {
    formatVersion: 3,
    sentAt: "2026-11-07T12:00:00.000Z",
    round: 3,
    deviceId: "note-c3d4",
    deviceName: "ノートPC",
    files: {
      "本文/第1話.txt": { hash: H1, gen: 1, ancestors: [H0] },
      "本文/第2話.txt": { hash: DRIVE_DELETED, gen: 2, ancestors: [H2, H0] },
    },
  };
  const withFile = (value: unknown) => JSON.stringify({ ...good, files: { "本文/第1話.txt": value } });

  test("正しい目録は読め、文字にして読み直しても同じ", () => {
    const result = parseDriveManifest(JSON.stringify(good));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.round).toBe(3);
    expect(result.manifest.files.get("本文/第1話.txt")).toEqual(lin(H1, 1, [H0]));
    expect(result.manifest.files.get("本文/第2話.txt")?.hash).toBe(DRIVE_DELETED);
    const again = parseDriveManifest(serializeDriveManifest(result.manifest));
    expect(again).toEqual(result);
  });

  const broken: [string, string][] = [
    ["JSONでない", "{ formatVersion: 3"],
    ["配列", "[]"],
    ["版が違う", JSON.stringify({ ...good, formatVersion: 4 })],
    // 版2（印 bases・選び終えた食い違い）は配っていないので読まない
    ["版2", JSON.stringify({ ...good, formatVersion: 2 })],
    ["版が無い", JSON.stringify({ ...good, formatVersion: undefined })],
    ["回の番号が0", JSON.stringify({ ...good, round: 0 })],
    ["回の番号が小数", JSON.stringify({ ...good, round: 1.5 })],
    ["時刻が読めない", JSON.stringify({ ...good, sentAt: "きのう" })],
    ["端末IDが空", JSON.stringify({ ...good, deviceId: "" })],
    ["端末の名前が無い", JSON.stringify({ ...good, deviceName: undefined })],
    ["files が配列", JSON.stringify({ ...good, files: [] })],
    ["系譜でなくハッシュだけ（版2の形）", withFile(H1)],
    ["ハッシュの形が違う", withFile({ hash: "abc", gen: 0, ancestors: [] })],
    ["祖先のハッシュの形が違う", withFile({ hash: H1, gen: 1, ancestors: ["abc"] })],
    ["祖先が上限より長い", withFile({ hash: H1, gen: 1, ancestors: Array.from({ length: DRIVE_LINEAGE_LIMIT + 1 }, (_, i) => hashText(String(i))) })],
    ["祖先が重なっている", withFile({ hash: H1, gen: 1, ancestors: [H0, H0] })],
    ["回の数が負", withFile({ hash: H1, gen: -1, ancestors: [] })],
    ["何が消えたのか書かれていない", withFile({ hash: DRIVE_DELETED, gen: 1, ancestors: [] })],
    ["作品の外を指す道", JSON.stringify({ ...good, files: { "../外.txt": { hash: H1, gen: 0, ancestors: [] } } })],
    ["根から始まる道", JSON.stringify({ ...good, files: { "/etc/x": { hash: H1, gen: 0, ancestors: [] } } })],
    ["ドライブ文字", JSON.stringify({ ...good, files: { "C:/x.txt": { hash: H1, gen: 0, ancestors: [] } } })],
    ["円記号の区切り", JSON.stringify({ ...good, files: { "本文\\第1話.txt": { hash: H1, gen: 0, ancestors: [] } } })],
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

  test("目録を組むと、渡した系譜がそのまま載る", () => {
    const built = buildDriveManifest({
      deviceId: "desk-a1b2",
      deviceName: "母艦",
      round: 2,
      sentAt: "2026-11-07T10:00:00.000Z",
      files: new Map([["a.txt", lin(H1, 1, [H0])]]),
    });
    expect(built).toMatchObject({ formatVersion: 3, round: 2, deviceId: "desk-a1b2" });
    expect(built.files.get("a.txt")).toEqual(lin(H1, 1, [H0]));
  });
});

describe("設定資料は食い違いのとき decideSettingsConflict へ回す印を付ける", () => {
  test("設定/ の JSON は settings: true、本文は false", () => {
    const base = lin(H0, 0);
    expect(planOne({ file: "設定/人物/char_001.json", head: base, local: H1, remotes: [lin(H2, 1, [H0])] })).toMatchObject({
      kind: "conflict",
      settings: true,
    });
    expect(planOne({ head: base, local: H1, remotes: [lin(H2, 1, [H0])] })).toMatchObject({ kind: "conflict", settings: false });
  });
});

describe("端末ごとのファイル（sessions・stats）の扱い（0.132.0）", () => {
  const OWN = ".aiwriter/stats/desk-a1b2.json";
  const PEER = ".aiwriter/stats/note-c3d4.json";

  test("自分の端末のファイルは、向こうの写しと違っても受け取らず食い違いにもしない", () => {
    const decisions = planDriveReceive({
      lineage: new Map(),
      local: new Map([[OWN, H1]]),
      peers: [peer("note-c3d4", { [OWN]: lin(H0, 0) })],
      ignoredPaths: [],
      ownDeviceId: "desk-a1b2",
    });
    expect(decisions).toMatchObject([{ path: OWN, kind: "none", reason: "own_device" }]);
  });

  test("（比べ）端末IDを渡さないと食い違いになる——誤検出だった", () => {
    const decisions = planDriveReceive({
      lineage: new Map(),
      local: new Map([[OWN, H1]]),
      peers: [peer("note-c3d4", { [OWN]: lin(H0, 0) })],
      ignoredPaths: [],
    });
    expect(decisions).toMatchObject([{ kind: "conflict" }]);
  });

  test("向こうの端末のファイルは受け取る", () => {
    const decisions = planDriveReceive({
      lineage: new Map([[PEER, lin(H0, 0)]]),
      local: new Map([[PEER, H0]]),
      peers: [peer("note-c3d4", { [PEER]: lin(H2, 1, [H0]) })],
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

  test("送るのは自分の端末の分だけ。控えの置き場はどの端末のものも送らない", () => {
    const own = { ownDeviceId: "desk-a1b2", ignoredPaths: IGNORED_PATHS };
    expect(isSendableSyncPath(OWN, own)).toBe(true);
    expect(isSendableSyncPath(PEER, own)).toBe(false);
    expect(isSendableSyncPath("本文/第1話.txt", own)).toBe(true);
    expect(isSendableSyncPath(`${DRIVE_SYNC_RECORD_PREFIX}desk-a1b2.json`, own)).toBe(false);
    expect(isSendableSyncPath(".aiwriter/cache/x.json", own)).toBe(false);
    expect(isSendableSyncPath("../外.txt", own)).toBe(false);
  });

  test("控えの置き場は、受け取りの計画にも出さない", () => {
    const decisions = planDriveReceive({
      lineage: new Map(),
      local: new Map(),
      peers: [peer("note-c3d4", { [`${DRIVE_SYNC_RECORD_PREFIX}note-c3d4.json`]: lin(H2, 0) })],
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
