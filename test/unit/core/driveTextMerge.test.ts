import { describe, expect, test } from "vitest";
import * as path from "node:path";
import {
  assembleDriveMerge,
  isDriveMergeTextPath,
  mergeDriveTexts,
  verifyDriveMerge,
  type DriveTextMerge,
} from "../../../src/core/driveTextMerge";
import { hashBytes } from "../../../src/core/hash";
import { SRC, chainTo, relativeName, walkStaticImports } from "../support/importGraph";

/**
 * 直した場所が違えば合わせ、同じ場所だけ選ばせる（設計書5.10.7）の、合わせる関数だけの試験。
 *
 * **正解の表**：場面ごとに「訊くべき場所の数」と、0なら「黙って合わせた結果の文」を書く。
 * 最後に **見逃し（訊くべき場所があるのに黙って合わせた・数が足りない）と
 * 誤検出（違う場所なのに訊いた・数が多い）の両方を数えて0** を見る。
 * 何も合わせない実装（いつも訊く）は見逃し0でも誤検出で落ち、
 * いつも合わせる実装は誤検出0でも見逃しで落ちる。
 */

const id = (text: string) => hashBytes(new TextEncoder().encode(text));
const lines = (...items: string[]) => items.join("\n") + "\n";

/** 元の文：段落を1行ずつ、間に空行なし（カクヨム形式の原稿と同じ） */
const BASE = lines("一の段落。", "二の段落。", "三の段落。", "四の段落。", "五の段落。", "六の段落。");
/** 段落の間に空行がある原稿 */
const SPACED = lines("一の段落。", "", "二の段落。", "", "三の段落。", "", "四の段落。");

/** 元の文の n 行目（1から）を差し替えた文 */
function edit(base: string, changes: Record<number, string | null>, inserts: Record<number, string[]> = {}): string {
  const src = base.split("\n");
  const out: string[] = [];
  // inserts[0] は冒頭、inserts[n] は n 行目の後ろ
  out.push(...(inserts[0] ?? []));
  src.forEach((line, i) => {
    const n = i + 1;
    if (i === src.length - 1 && line === "") {
      out.push(line);
      return;
    }
    const change = changes[n];
    if (change === undefined) out.push(line);
    else if (change !== null) out.push(change);
    out.push(...(inserts[n] ?? []));
  });
  return out.join("\n");
}

interface Scene {
  name: string;
  base: string;
  candidates: string[];
  /** 訊くべき場所の数 */
  regions: number;
  /** regions が 0 のときの、黙って合わせた結果の文（改行は \n にそろえたもの） */
  merged?: string;
  /** 場所ごとの選べる文の数（regions > 0 のとき） */
  options?: number[];
}

const scenes: Scene[] = [
  {
    name: "2台：別の段落",
    base: BASE,
    candidates: [edit(BASE, { 2: "二の段落を A が直した。" }), edit(BASE, { 5: "五の段落を B が直した。" })],
    regions: 0,
    merged: edit(BASE, { 2: "二の段落を A が直した。", 5: "五の段落を B が直した。" }),
  },
  {
    name: "2台：同じ段落",
    base: BASE,
    candidates: [edit(BASE, { 3: "三を A が直した。" }), edit(BASE, { 3: "三を B が直した。" })],
    regions: 1,
    options: [2],
  },
  {
    name: "2台：隣り合う段落（間に変わっていない行が無い）",
    base: BASE,
    candidates: [edit(BASE, { 3: "三を A が直した。" }), edit(BASE, { 4: "四を B が直した。" })],
    regions: 1,
    options: [2],
  },
  {
    name: "2台：空行を挟んだ隣の段落（空行が変わっていない行として間に残る）",
    base: SPACED,
    candidates: [edit(SPACED, { 3: "二を A が直した。" }), edit(SPACED, { 5: "三を B が直した。" })],
    regions: 0,
    merged: edit(SPACED, { 3: "二を A が直した。", 5: "三を B が直した。" }),
  },
  {
    name: "2台：同じ所へ違う文を挿入",
    base: BASE,
    candidates: [edit(BASE, {}, { 3: ["A が足した段落。"] }), edit(BASE, {}, { 3: ["B が足した段落。"] })],
    regions: 1,
    options: [2],
  },
  {
    name: "2台：同じ所へ同じ文を挿入",
    base: BASE,
    candidates: [edit(BASE, {}, { 3: ["足した段落。"] }), edit(BASE, {}, { 3: ["足した段落。"] })],
    regions: 0,
    merged: edit(BASE, {}, { 3: ["足した段落。"] }),
  },
  {
    name: "2台：別の所へ挿入",
    base: BASE,
    candidates: [edit(BASE, {}, { 1: ["A が足した。"] }), edit(BASE, {}, { 5: ["B が足した。"] })],
    regions: 0,
    merged: edit(BASE, {}, { 1: ["A が足した。"], 5: ["B が足した。"] }),
  },
  {
    name: "2台：挿入と、その直後の段落の直し（接する）",
    base: BASE,
    candidates: [edit(BASE, {}, { 3: ["A が足した。"] }), edit(BASE, { 4: "四を B が直した。" })],
    regions: 1,
    options: [2],
  },
  {
    name: "2台：片方が段落を消し、片方が同じ段落を直した",
    base: BASE,
    candidates: [edit(BASE, { 3: null }), edit(BASE, { 3: "三を B が直した。" })],
    regions: 1,
    options: [2],
  },
  {
    name: "2台：片方が段落を消し、片方は離れた段落を直した",
    base: BASE,
    candidates: [edit(BASE, { 2: null }), edit(BASE, { 5: "五を B が直した。" })],
    regions: 0,
    merged: edit(BASE, { 2: null, 5: "五を B が直した。" }),
  },
  {
    name: "2台：同じ直しを2台がした",
    base: BASE,
    candidates: [edit(BASE, { 3: "三を直した。" }), edit(BASE, { 3: "三を直した。" })],
    regions: 0,
    merged: edit(BASE, { 3: "三を直した。" }),
  },
  {
    name: "2台：同じ直しに加えて、片方は別の段落も直した",
    base: BASE,
    candidates: [edit(BASE, { 1: "一を A が直した。", 3: "三を直した。" }), edit(BASE, { 3: "三を直した。" })],
    regions: 0,
    merged: edit(BASE, { 1: "一を A が直した。", 3: "三を直した。" }),
  },
  {
    name: "2台：両方が末尾に違う文を書き足した",
    base: BASE,
    candidates: [edit(BASE, {}, { 6: ["A の続き。"] }), edit(BASE, {}, { 6: ["B の続き。"] })],
    regions: 1,
    options: [2],
  },
  {
    name: "2台：片方は冒頭を直し、片方は末尾に書き足した",
    base: BASE,
    candidates: [edit(BASE, { 1: "一を A が直した。" }), edit(BASE, {}, { 6: ["B の続き。"] })],
    regions: 0,
    merged: edit(BASE, { 1: "一を A が直した。" }, { 6: ["B の続き。"] }),
  },
  {
    name: "2台：改行の形が違う（A は CRLF、B は LF）。比べる前にそろえる",
    base: BASE.replace(/\n/g, "\r\n"),
    candidates: [edit(BASE, { 2: "二を A が直した。" }).replace(/\n/g, "\r\n"), edit(BASE, { 5: "五を B が直した。" })],
    regions: 0,
    merged: edit(BASE, { 2: "二を A が直した。", 5: "五を B が直した。" }),
  },
  {
    name: "2台：片方は何も変えていない（元の文のまま）",
    base: BASE,
    candidates: [BASE, edit(BASE, { 4: "四を B が直した。" })],
    regions: 0,
    merged: edit(BASE, { 4: "四を B が直した。" }),
  },
  {
    name: "3台：別の段落",
    base: BASE,
    candidates: [edit(BASE, { 1: "一を A。" }), edit(BASE, { 3: "三を B。" }), edit(BASE, { 5: "五を C。" })],
    regions: 0,
    merged: edit(BASE, { 1: "一を A。", 3: "三を B。", 5: "五を C。" }),
  },
  {
    name: "3台：2台が同じ段落、1台は別の段落",
    base: BASE,
    candidates: [edit(BASE, { 2: "二を A。" }), edit(BASE, { 2: "二を B。" }), edit(BASE, { 5: "五を C。" })],
    regions: 1,
    options: [2],
  },
  {
    name: "3台：3台とも同じ段落",
    base: BASE,
    candidates: [edit(BASE, { 2: "二を A。" }), edit(BASE, { 2: "二を B。" }), edit(BASE, { 2: "二を C。" })],
    regions: 1,
    options: [3],
  },
  {
    name: "3台：同じ段落で、2台は同じ直し（同じ文は1つにまとめる）",
    base: BASE,
    candidates: [edit(BASE, { 2: "二を直した。" }), edit(BASE, { 2: "二を直した。" }), edit(BASE, { 2: "二を C。" })],
    regions: 1,
    options: [2],
  },
  {
    name: "3台：3台とも同じ直し",
    base: BASE,
    candidates: [edit(BASE, { 2: "二を直した。" }), edit(BASE, { 2: "二を直した。" }), edit(BASE, { 2: "二を直した。" })],
    regions: 0,
    merged: edit(BASE, { 2: "二を直した。" }),
  },
  {
    name: "3台：隣り合う段落が連鎖する（A と B、B と C が接する）",
    base: BASE,
    candidates: [edit(BASE, { 2: "二を A。" }), edit(BASE, { 3: "三を B。" }), edit(BASE, { 4: "四を C。" })],
    regions: 1,
    options: [3],
  },
  {
    name: "3台：片方が消し、2台が別々に直した",
    base: BASE,
    candidates: [edit(BASE, { 4: null }), edit(BASE, { 4: "四を B。" }), edit(BASE, { 4: "四を C。" })],
    regions: 1,
    options: [3],
  },
  {
    name: "4台：別の段落",
    base: BASE,
    candidates: [
      edit(BASE, { 1: "一を A。" }),
      edit(BASE, { 3: "三を B。" }),
      edit(BASE, { 5: "五を C。" }),
      edit(BASE, {}, { 6: ["D の続き。"] }),
    ],
    regions: 0,
    merged: edit(BASE, { 1: "一を A。", 3: "三を B。", 5: "五を C。" }, { 6: ["D の続き。"] }),
  },
  {
    name: "4台：2か所でそれぞれ2台が同じ段落",
    base: BASE,
    candidates: [
      edit(BASE, { 1: "一を A。" }),
      edit(BASE, { 1: "一を B。" }),
      edit(BASE, { 5: "五を C。" }),
      edit(BASE, { 5: "五を D。" }),
    ],
    regions: 2,
    options: [2, 2],
  },
  {
    name: "4台：連鎖する3台と、離れた1台",
    base: BASE,
    candidates: [
      edit(BASE, { 1: "一を A。" }),
      edit(BASE, { 2: "二を B。" }),
      edit(BASE, { 3: "三を C。" }),
      edit(BASE, { 6: "六を D。" }),
    ],
    regions: 1,
    options: [3],
  },
  {
    name: "4台：同じ所へ2台が同じ挿入、2台が別の段落",
    base: BASE,
    candidates: [
      edit(BASE, {}, { 2: ["足した。"] }),
      edit(BASE, {}, { 2: ["足した。"] }),
      edit(BASE, { 4: "四を C。" }),
      edit(BASE, { 6: "六を D。" }),
    ],
    regions: 0,
    merged: edit(BASE, { 4: "四を C。", 6: "六を D。" }, { 2: ["足した。"] }),
  },
];

function run(scene: Scene, order: readonly number[] = scene.candidates.map((_, i) => i)): DriveTextMerge {
  const result = mergeDriveTexts({
    base: scene.base,
    candidates: order.map((i) => ({ id: id(scene.candidates[i]), text: scene.candidates[i] })),
  });
  if (result.kind === "unmergeable") throw new Error(`${scene.name}: ${result.reason}`);
  return result;
}

function original(scene: Scene) {
  return { base: scene.base, candidates: scene.candidates.map((text) => ({ id: id(text), text })) };
}

function permutations(n: number): number[][] {
  if (n <= 1) return [[0]];
  const out: number[][] = [];
  for (const rest of permutations(n - 1)) {
    for (let i = 0; i <= rest.length; i++) out.push([...rest.slice(0, i), n - 1, ...rest.slice(i)]);
  }
  return out;
}

describe("合わせる関数の正解の表（設計書5.10.7）", () => {
  test.each(scenes.map((scene) => [scene.name, scene] as const))("%s", (_name, scene) => {
    const result = run(scene);
    expect(result.regions.length).toBe(scene.regions);
    if (scene.regions === 0) {
      const text = assembleDriveMerge(result, []);
      expect(text).toBe(scene.merged);
      expect(verifyDriveMerge(result, [], original(scene))).toBe(true);
    } else {
      expect(result.regions.map((region) => region.options.length)).toEqual(scene.options);
    }
  });

  test("見逃し0・誤検出0（場面をまとめて数える）", () => {
    let missed = 0;
    let falsePositive = 0;
    let expectedRegions = 0;
    for (const scene of scenes) {
      const actual = run(scene).regions.length;
      expectedRegions += scene.regions;
      if (actual < scene.regions) missed += scene.regions - actual;
      if (actual > scene.regions) falsePositive += actual - scene.regions;
    }
    expect({ missed, falsePositive }).toEqual({ missed: 0, falsePositive: 0 });
    // 場面が減って「全部通った」にならないように数も押さえる
    expect(scenes.length).toBeGreaterThanOrEqual(27);
    expect(scenes.filter((scene) => scene.regions === 0).length).toBeGreaterThanOrEqual(14);
    expect(expectedRegions).toBeGreaterThanOrEqual(12);
  });

  test("候補を渡す順を入れ替えても、合わせた文も場所も選べる文の並びも同じ（どの台が合わせても同じ文）", () => {
    for (const scene of scenes) {
      const first = run(scene);
      const firstText = first.regions.length === 0 ? assembleDriveMerge(first, []) : undefined;
      for (const order of permutations(scene.candidates.length)) {
        const other = run(scene, order);
        expect(other.regions, scene.name).toEqual(first.regions);
        expect(other.pieces, scene.name).toEqual(first.pieces);
        if (firstText !== undefined) expect(assembleDriveMerge(other, []), scene.name).toBe(firstText);
      }
    }
  });

  test("場所ごとに選んだ文から最後の文を組む。選んだ文は候補の文そのもの", () => {
    const scene = scenes.find((item) => item.name === "4台：2か所でそれぞれ2台が同じ段落") as Scene;
    const result = run(scene);
    // 1か所目は B の文、2か所目は C の文を選ぶ（選べる文の並びは候補のハッシュの順）
    const pick = (region: number, text: string) =>
      result.regions[region].options.findIndex((option) => option.lines.join("\n") === text);
    const picks = [pick(0, "一を B。"), pick(1, "五を C。")];
    expect(picks.every((index) => index >= 0)).toBe(true);
    expect(assembleDriveMerge(result, picks)).toBe(edit(BASE, { 1: "一を B。", 5: "五を C。" }));
    expect(verifyDriveMerge(result, picks, original(scene))).toBe(true);
    // 選んだ文を持つ候補（ハッシュ）が添えてある
    expect(result.regions[0].options[picks[0]].candidates).toEqual([id(scene.candidates[1])]);
    // 元の文は選ぶ行ではなく、見比べのために添える
    expect(result.regions[0].baseLines).toEqual(["一の段落。"]);
    // 選びの数が合わない・範囲の外は組まない
    expect(assembleDriveMerge(result, [0])).toBeUndefined();
    expect(assembleDriveMerge(result, [0, 9])).toBeUndefined();
  });

  test("消すを選べる（片方が消し、片方が直した場所で、消すほうを選ぶ）", () => {
    const scene = scenes.find((item) => item.name === "2台：片方が段落を消し、片方が同じ段落を直した") as Scene;
    const result = run(scene);
    const deleteIndex = result.regions[0].options.findIndex((option) => option.lines.length === 0);
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    expect(assembleDriveMerge(result, [deleteIndex])).toBe(edit(BASE, { 3: null }));
  });
});

describe("合わせた結果を書く前に確かめる（verifyDriveMerge）", () => {
  const scene = scenes[0];

  test("当てた範囲の文が候補の文と違えば外れ（機械が新しい文を作らない）", () => {
    const result = run(scene);
    const tampered: DriveTextMerge = {
      ...result,
      pieces: result.pieces.map((piece) =>
        piece.kind === "take" ? { ...piece, lines: ["機械が作った文。"] } : piece
      ),
    };
    expect(verifyDriveMerge(tampered, [], original(scene))).not.toBe(true);
  });

  test("どの候補でも変わっていない元の文の行が欠ければ外れ", () => {
    const result = run(scene);
    const dropped: DriveTextMerge = {
      ...result,
      pieces: result.pieces.filter((piece, index) => !(piece.kind === "base" && index === 0)),
    };
    expect(verifyDriveMerge(dropped, [], original(scene))).not.toBe(true);
  });

  test("元の文の行を書き換えても外れ", () => {
    const result = run(scene);
    const changedBase: DriveTextMerge = { ...result, baseLines: ["別の文。", ...result.baseLines.slice(1)] };
    expect(verifyDriveMerge(changedBase, [], original(scene))).not.toBe(true);
  });

  test("選んだ文がどの候補の文でもなければ外れ", () => {
    const result = run(scenes[1]);
    const forged: DriveTextMerge = {
      ...result,
      regions: result.regions.map((region) => ({
        ...region,
        options: region.options.map((option) => ({ ...option, lines: ["作った文。"] })),
      })),
    };
    expect(verifyDriveMerge(forged, [0], original(scenes[1]))).not.toBe(true);
  });
});

describe("合わせられないもの（ファイルごとの扱いへ回す）", () => {
  test("候補に競合マーカーがある", () => {
    const marked = `${BASE}<<<<<<< HEAD\n行\n=======\n行\n>>>>>>> other\n`;
    expect(mergeDriveTexts({ base: BASE, candidates: [{ id: id(marked), text: marked }, { id: id(BASE), text: BASE }] })).toMatchObject({
      kind: "unmergeable",
    });
  });

  test("元の文に競合マーカーがある", () => {
    const marked = `<<<<<<< HEAD\n${BASE}`;
    const a = edit(BASE, { 1: "一。" });
    const b = edit(BASE, { 5: "五。" });
    expect(mergeDriveTexts({ base: marked, candidates: [{ id: id(a), text: a }, { id: id(b), text: b }] })).toMatchObject({
      kind: "unmergeable",
    });
  });

  test("1つのファイルの中で改行の形が混ざっている（5.4.2）", () => {
    const mixed = "一\r\n二\n三\n";
    const other = "一\n二\n三を直した\n";
    expect(mergeDriveTexts({ base: "一\n二\n三\n", candidates: [{ id: id(mixed), text: mixed }, { id: id(other), text: other }] })).toMatchObject({
      kind: "unmergeable",
    });
  });

  test("候補が1つしか無い", () => {
    expect(mergeDriveTexts({ base: BASE, candidates: [{ id: id(BASE), text: BASE }] })).toMatchObject({ kind: "unmergeable" });
  });
});

describe("合わせてよい本文", () => {
  test(".txt と .md だけ（設定資料の JSON は decideSettingsConflict のまま）", () => {
    expect(isDriveMergeTextPath("本文/第1話.txt")).toBe(true);
    expect(isDriveMergeTextPath("本文/第1話.MD")).toBe(true);
    expect(isDriveMergeTextPath("設定/人物/char_001.json")).toBe(false);
    expect(isDriveMergeTextPath("表紙.png")).toBe(false);
  });
});

describe("長い原稿でも合わせられる", () => {
  test("2000段落の原稿で、離れた2か所の直しを合わせる", () => {
    const many = Array.from({ length: 2000 }, (_, i) => `第${i + 1}段落。`);
    const base = many.join("\n") + "\n";
    const a = base.replace("第10段落。", "第10段落を A が直した。");
    const b = base.replace("第1990段落。", "第1990段落を B が直した。");
    const result = mergeDriveTexts({ base, candidates: [{ id: id(a), text: a }, { id: id(b), text: b }] });
    if (result.kind === "unmergeable") throw new Error(result.reason);
    expect(result.regions).toEqual([]);
    expect(assembleDriveMerge(result, [])).toBe(
      base.replace("第10段落。", "第10段落を A が直した。").replace("第1990段落。", "第1990段落を B が直した。")
    );
  });
});

describe("モバイル版へそのまま持っていける（vscode・node:・paths を読まない）", () => {
  test("driveTextMerge.ts から静的にたどれる先に、vscode・node: ・core/paths.ts が無い", () => {
    const reach = walkStaticImports([path.join(SRC, "core", "driveTextMerge.ts")]);
    const bare = reach.bare.map((item) => `${relativeName(item.file)} → ${item.spec}`);
    expect(bare.filter((line) => /→ (vscode|node:)/.test(line))).toEqual([]);
    const paths = path.join(SRC, "core", "paths.ts");
    expect(reach.files.has(paths) ? chainTo(reach, paths) : "").toBe("");
  });
});
