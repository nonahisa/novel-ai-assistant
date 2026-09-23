import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import {
  addMissingChapters,
  describeChapterImportPlan,
  localOutlineOf,
  outlineSections,
  planChapterImport,
  type LocalOutlineEpisode,
  type OutlineEpisode,
} from "../../../src/core/chapterOutline";
import { inspectWorkBackup } from "../../../src/core/workZip";

/**
 * バックアップ（や投稿サイトの作品管理の画面）から、章立てだけを取り込む（残課題 B7）。
 *
 * 作者の問い（2026-09-23）：「なろうやカクヨムのバックアップから章立ては
 * 読み取れませんでしたか？」
 *
 * - **なろう**：合本の【第N章】の次の行が章の題。`collectedFile.ts` は `part` で
 *   拾っていたが、取り込みの受け渡し（`WorkZipInspection`）には載っていなかった
 * - **既にある作品へ章だけを足す**：本文は触らない。章立てが既にあれば上書きせず、
 *   違いを見せて作者に選ばせる。話が合わなければ一覧で出して止める（推測で割り当てない）
 *
 * 材料は作り物の短い合本（題は架空）。作者のファイルは読まない。
 */

const SEP = (n: number) =>
  `------------------------- エピソード${n}開始 -------------------------`;

function wide(n: number): string {
  return String(n).replace(/[0-9]/g, (d) =>
    String.fromCharCode(d.charCodeAt(0) + 0xfee0)
  );
}

/** なろうの合本の1話ぶん。章の見出しは**章の最初の話にだけ**付く */
function narouEpisode(n: number, title: string, part?: [number, string]): string[] {
  return [
    SEP(n),
    ...(part ? [`【第${part[0]}章】`, part[1], ""] : []),
    "【エピソードタイトル】",
    `${wide(n)}話　${title}`,
    "",
    "【本文】",
    `${title}の本文。`,
    "",
    "【リアクション】",
    "いいね: 2件",
    "",
  ];
}

const NAROU_HEAD = [
  "【Nコード】",
  "N0000ZZ",
  "",
  "【作品タイトル】",
  "架空の灯台守",
  "",
];

function narouCollected(): string {
  return [
    ...NAROU_HEAD,
    ...narouEpisode(1, "潮の匂い", [1, "第一章『岬』"]),
    ...narouEpisode(2, "古い地図"),
    ...narouEpisode(3, "嵐の夜", [2, "第二章『灯』"]),
    ...narouEpisode(4, "迷い船"),
    ...narouEpisode(5, "夜明け", [3, "第三章『帰港』"]),
  ].join("\n");
}

const utf8 = (text: string) => new TextEncoder().encode(text);

describe("なろうの合本：章の見出しを取り込みの受け渡しに載せる", () => {
  it("合本の【第N章】が、話の並び（outline）の part として渡る", () => {
    const zip = zipSync({ "N0000ZZ.txt": utf8(narouCollected()) });
    const inspection = inspectWorkBackup(zip, "N0000ZZ.zip");

    expect(inspection.outline.map((episode) => episode.part)).toEqual([
      "第一章『岬』",
      "第一章『岬』",
      "第二章『灯』",
      "第二章『灯』",
      "第三章『帰港』",
    ]);
    expect(inspection.outline[2]).toMatchObject({ number: 3, title: "嵐の夜" });
  });

  it("展開済みの .txt（合本そのもの）でも同じ並びが渡る", () => {
    const inspection = inspectWorkBackup(utf8(narouCollected()), "N0000ZZ.txt");
    expect(outlineSections(inspection.outline).map((s) => s.name)).toEqual([
      "第一章『岬』",
      "第二章『灯』",
      "第三章『帰港』",
    ]);
  });

  it("アルファポリスの書き出しも、同じ形（章が変わる話ごとに1章）で渡る", () => {
    const text = [
      "第一章『岬』",
      "１話　潮の匂い",
      "本文。",
      "",
      "２話　古い地図",
      "本文。",
      "",
      "第二章『灯』",
      "３話　嵐の夜",
      "本文。",
    ].join("\n");
    const inspection = inspectWorkBackup(utf8(text), "架空の灯台守.txt");
    const sections = outlineSections(inspection.outline);
    expect(sections.map((s) => [s.name, s.startIndex])).toEqual([
      ["第一章『岬』", 0],
      ["第二章『灯』", 2],
    ]);
  });

  it("カクヨムの ZIP には章が無いので、part は全部 null", () => {
    const episodeText = (title: string) =>
      ["【タイトル】", title, "", "【本文（1行）】", "本文。", ""].join("\n");
    const zip = zipSync({
      "episode_0001.txt": utf8(episodeText("第1話　潮の匂い")),
      "episode_0002.txt": utf8(episodeText("第2話　古い地図")),
    });
    const inspection = inspectWorkBackup(zip, "架空の灯台守_20260924.zip");
    expect(inspection.outline).toHaveLength(2);
    expect(inspection.outline.every((episode) => episode.part === null)).toBe(true);
    expect(inspection.outline[1]).toMatchObject({ number: 2, title: "古い地図" });
  });
});

/* ── 既にある作品へ章だけを足す ─────────────────────────── */

function outline(): OutlineEpisode[] {
  return [
    { label: "1話　潮の匂い", number: 1, title: "潮の匂い", part: "第一章『岬』" },
    { label: "2話　古い地図", number: 2, title: "古い地図", part: "第一章『岬』" },
    { label: "3話　嵐の夜", number: 3, title: "嵐の夜", part: "第二章『灯』" },
    { label: "4話　迷い船", number: 4, title: "迷い船", part: "第二章『灯』" },
  ];
}

/** 分け済みの作品（話ごとのファイル）。題の書き方が違っても（全角・空白）照らせる */
function splitLocals(): LocalOutlineEpisode[] {
  return [
    { relPath: "本文/0001_潮の匂い.txt", indexInFile: 0, number: 1, title: "潮の匂い", label: "第1話" },
    { relPath: "本文/0002_古い地図.txt", indexInFile: 0, number: 2, title: "古い 地図", label: "第2話" },
    { relPath: "本文/0003_嵐の夜.txt", indexInFile: 0, number: 3, title: "嵐の夜", label: "第3話" },
    { relPath: "本文/0004_迷い船.txt", indexInFile: 0, number: 4, title: "迷い船", label: "第4話" },
    // 手元にしか無い書きかけ（まだ投稿していない）。あっても止めない
    { relPath: "本文/0005.txt", indexInFile: 0, number: 5, title: null, label: "第5話" },
  ];
}

describe("既にある作品へ、章立てだけを取り込む計画", () => {
  it("章立てが空なら、章の始まりの話のファイルを指して立てる", () => {
    const plan = planChapterImport({
      outline: outline(),
      locals: splitLocals(),
      existing: [],
    });
    expect(plan.kind).toBe("create");
    if (plan.kind !== "create") return;
    expect(plan.chapters).toEqual([
      { name: "第一章『岬』", startEpisodePath: "本文/0001_潮の匂い.txt" },
      { name: "第二章『灯』", startEpisodePath: "本文/0003_嵐の夜.txt" },
    ]);
  });

  it("章立てが既にあって違うときは、上書きせず違いを返す（足りない章だけ足す道もある）", () => {
    const existing = [
      { name: "序章（作者が付けた名前）", startEpisodePath: "本文/0001_潮の匂い.txt" },
    ];
    const plan = planChapterImport({ outline: outline(), locals: splitLocals(), existing });
    expect(plan.kind).toBe("differs");
    if (plan.kind !== "differs") return;
    expect(plan.diff.map((line) => line.kind)).toEqual(["rename", "add"]);

    // 足りない章だけ足す：作者の章（名前も）はそのまま残る
    expect(addMissingChapters(existing, plan.proposed)).toEqual([
      { name: "序章（作者が付けた名前）", startEpisodePath: "本文/0001_潮の匂い.txt" },
      { name: "第二章『灯』", startEpisodePath: "本文/0003_嵐の夜.txt" },
    ]);

    // 押す前に見せる文に、作者の章が消えないことと違いが出る
    const text = describeChapterImportPlan(plan).join("\n");
    expect(text).toContain("序章（作者が付けた名前）");
    expect(text).toContain("第二章『灯』");
  });

  it("章立てがバックアップと同じなら、何もしない", () => {
    const existing = [
      { name: "第二章『灯』", startEpisodePath: "本文/0003_嵐の夜.txt" },
      { name: "第一章『岬』", startEpisodePath: "本文/0001_潮の匂い.txt" },
    ];
    const plan = planChapterImport({ outline: outline(), locals: splitLocals(), existing });
    expect(plan.kind).toBe("same");
  });

  it("手元に無い話があれば、一覧にして止める（推測で割り当てない）", () => {
    const locals = splitLocals().filter((local) => local.number !== 2);
    const plan = planChapterImport({ outline: outline(), locals, existing: [] });
    expect(plan.kind).toBe("mismatch");
    if (plan.kind !== "mismatch") return;
    expect(plan.problems).toEqual([{ label: "2話　古い地図", reason: "missing" }]);
    expect(describeChapterImportPlan(plan).join("\n")).toContain("2話　古い地図");
  });

  it("題が同じでも話数が違えば、同じ話と見なさない", () => {
    const locals = splitLocals().map((local) =>
      local.number === 3 ? { ...local, number: 7 } : local
    );
    const plan = planChapterImport({ outline: outline(), locals, existing: [] });
    expect(plan.kind).toBe("mismatch");
  });

  it("手元の並びが違えば（入れ替わっていれば）止める", () => {
    const locals = splitLocals();
    const swapped = [locals[0], locals[2], locals[1], locals[3], locals[4]];
    const plan = planChapterImport({ outline: outline(), locals: swapped, existing: [] });
    expect(plan.kind).toBe("mismatch");
    if (plan.kind !== "mismatch") return;
    expect(plan.problems.map((problem) => problem.reason)).toContain("order");
  });

  it("手元が合本のままなら、途中から始まる章は置けないので止める（分けるよう案内）", () => {
    const locals: LocalOutlineEpisode[] = outline().map((episode, index) => ({
      relPath: "本文/N0000ZZ.txt",
      indexInFile: index,
      number: episode.number,
      title: episode.title,
      label: episode.label,
    }));
    const plan = planChapterImport({ outline: outline(), locals, existing: [] });
    expect(plan.kind).toBe("insideCollected");
    expect(describeChapterImportPlan(plan).join("\n")).toContain("話ごとのファイルに分ける");
  });

  it("章の見出しが1つも無ければ none、章立てを読めなければ unreadable", () => {
    const bare = outline().map((episode) => ({ ...episode, part: null }));
    expect(planChapterImport({ outline: bare, locals: splitLocals(), existing: [] }).kind).toBe(
      "none"
    );
    expect(
      planChapterImport({ outline: outline(), locals: splitLocals(), existing: null }).kind
    ).toBe("unreadable");
  });
});

describe("手元の原稿を照らし合わせる形にする（localOutlineOf）", () => {
  it("なろうの合本を分けたファイル（区切り行が残る）とバックアップが、そのまま照らせる", () => {
    const lines = narouCollected().split("\n");
    const starts = lines
      .map((line, index) => (line.startsWith("-------") ? index : -1))
      .filter((index) => index >= 0);
    const pieces = starts.map((start, i) =>
      lines.slice(start, starts[i + 1] ?? lines.length).join("\n")
    );
    const locals = localOutlineOf(
      pieces.map((text, i) => ({
        relPath: `本文/${i + 1}.txt`,
        label: `第${i + 1}話`,
        fileNumber: i + 1,
        fileSubtitle: null,
        text,
      }))
    );
    const inspection = inspectWorkBackup(utf8(narouCollected()), "N0000ZZ.txt");
    const plan = planChapterImport({ outline: inspection.outline, locals, existing: [] });
    expect(plan.kind).toBe("create");
    if (plan.kind !== "create") return;
    expect(plan.chapters.map((c) => c.startEpisodePath)).toEqual([
      "本文/1.txt",
      "本文/3.txt",
      "本文/5.txt",
    ]);
  });

  it("カクヨムの頭書き（【タイトル】）の題から話数と題を読む。読めなければファイル名", () => {
    const locals = localOutlineOf([
      {
        relPath: "本文/episode_0001.txt",
        label: "episode_0001.txt",
        fileNumber: 1,
        fileSubtitle: null,
        text: ["【タイトル】", "１話　潮の匂い", "", "【本文（1行）】", "本文。"].join("\n"),
      },
      {
        relPath: "本文/0002_古い地図.txt",
        label: "第2話",
        fileNumber: 2,
        fileSubtitle: "古い地図",
        text: "本文だけ。",
      },
      {
        relPath: "本文/0003_嵐の夜.txt",
        label: "第3話",
        fileNumber: 3,
        fileSubtitle: "嵐の夜",
        text: null,
      },
    ]);
    expect(locals.map((l) => [l.number, l.title])).toEqual([
      [1, "潮の匂い"],
      [2, "古い地図"],
      [3, "嵐の夜"],
    ]);
  });

  it("合本のままの作品は、中の話を1つずつ並べる（2話目からは indexInFile が進む）", () => {
    const locals = localOutlineOf([
      {
        relPath: "本文/N0000ZZ.txt",
        label: "N0000ZZ.txt",
        fileNumber: null,
        fileSubtitle: null,
        text: narouCollected(),
      },
    ]);
    expect(locals.map((l) => l.indexInFile)).toEqual([0, 1, 2, 3, 4]);
    const inspection = inspectWorkBackup(utf8(narouCollected()), "N0000ZZ.txt");
    expect(
      planChapterImport({ outline: inspection.outline, locals, existing: [] }).kind
    ).toBe("insideCollected");
  });
});
