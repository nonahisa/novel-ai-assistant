import * as path from "path";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_WORK_KIND,
  parseWorkKind,
  resolveWorkKind,
  WORK_KINDS,
  type WorkKindKey,
} from "../../../src/core/workKind";
import { newEpisodeTemplate } from "../../../src/core/episodeTemplate";
import { buildPlotTemplate } from "../../../src/core/plotTemplate";
import { parsePlotMarkdown } from "../../../src/core/plotDoc";
import {
  MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE,
  MANUSCRIPT_EDITOR_VIEW_TYPE,
  manuscriptViewTypeFor,
} from "../../../src/core/manuscriptViewTypes";
import { kindLineClass } from "../../../src/core/kindLines";
import { selectableWorkFormats, WORK_FORMATS } from "../../../src/core/workFormat";
import { matchWorkFormat } from "../../../src/core/workFormatStore";
import * as workRegistry from "../../../src/core/workRegistry";
import type { WorkConfig } from "../../../src/models/types";
import { FileSystemError, Uri, workspace } from "../support/vscodeStub";

/**
 * 作品の種類（設計書6.109）。
 *
 * **形式（長さ）とは別の軸。** 種類で変わるのは雛形・数え方の目安・
 * 組み方・出力だけで、**小説（と、種類の無いこれまでの作品）は何も変わらない**
 * ——ここがいちばん大事な約束なので、どの節でも小説の不変を確かめる。
 */

const parseWorkConfig = (
  workRegistry as unknown as { parseWorkConfig: (raw: unknown) => WorkConfig }
).parseWorkConfig;

const validConfig = {
  schemaVersion: "0.1",
  workTitle: "テスト作品",
  manuscriptDir: "本文",
  settingsDir: "設定",
  createdAt: "2026-09-23T00:00:00.000Z",
};

const ALL_KINDS: WorkKindKey[] = ["novel", "script", "manga", "essay", "lyrics"];

describe("選べる種類", () => {
  test("小説・台本・漫画の原作・エッセイ・歌詞の5つ", () => {
    expect(WORK_KINDS.map((kind) => kind.key)).toEqual(ALL_KINDS);
  });

  test("先頭（既定）は小説", () => {
    // 迷ったまま Enter を押しても、これまでと同じ作品になる
    expect(WORK_KINDS[0].key).toBe("novel");
    expect(DEFAULT_WORK_KIND).toBe("novel");
  });

  test("台本の名前に「脚本・シナリオ」が入っている", () => {
    // 呼び方が人によって違う。どの言葉で探しても見つかるように
    const script = WORK_KINDS.find((kind) => kind.key === "script");
    expect(script?.label).toContain("台本");
    expect(script?.label).toContain("脚本");
    expect(script?.label).toContain("シナリオ");
  });
});

describe("種類の決め方", () => {
  test("作品の設定に書かれた種類が勝つ", () => {
    expect(resolveWorkKind("essay", "sns")).toBe("essay");
    // 形式が「脚本」でも、作者が種類を決め直したならそちら
    expect(resolveWorkKind("novel", "script")).toBe("novel");
  });

  test("設定に無ければ、形式「脚本」の作品は台本として読む", () => {
    // 種類の軸ができる前（0.30.7〜）の作り方。縦書きも組み方も外さない
    expect(resolveWorkKind(undefined, "script")).toBe("script");
  });

  test("どちらも無ければ小説（これまでの振る舞い）", () => {
    expect(resolveWorkKind(undefined, undefined)).toBe("novel");
    expect(resolveWorkKind(undefined, "long")).toBe("novel");
    expect(resolveWorkKind(undefined, "sns")).toBe("novel");
  });

  test("知らない値は無かったことにする（作品が開けなくならない）", () => {
    expect(parseWorkKind("script")).toBe("script");
    expect(parseWorkKind("台本")).toBeUndefined();
    expect(parseWorkKind(3)).toBeUndefined();
    expect(parseWorkKind(undefined)).toBeUndefined();
  });
});

describe("作品の設定ファイル", () => {
  test("種類が書かれていれば読む", () => {
    expect(parseWorkConfig({ ...validConfig, kind: "manga" }).kind).toBe("manga");
  });

  test("無ければ欄ごと持たない（書き戻しで欄が現れない）", () => {
    expect(parseWorkConfig(validConfig)).toEqual(validConfig);
    expect("kind" in parseWorkConfig(validConfig)).toBe(false);
  });

  test("知らない値でも投げない（欄だけ落とす）", () => {
    const config = parseWorkConfig({ ...validConfig, kind: "novella" });
    expect(config.kind).toBeUndefined();
    expect(config.workTitle).toBe("テスト作品");
  });
});

describe("形式の選択肢から「脚本」を外す", () => {
  test("選ぶ画面には出さない（台本は種類で選ぶ）", () => {
    const labels = selectableWorkFormats().map((format) => format.label);
    expect(labels).not.toContain("脚本");
    // ほかの形式は残る
    expect(labels).toEqual(
      expect.arrayContaining(["短編", "短編集", "長編", "大長編", "SNS記事", "創作メモ集"])
    );
  });

  test("プロットに「脚本」と書いてある作品は、これまでどおり読める", () => {
    expect(WORK_FORMATS.map((format) => format.label)).toContain("脚本");
    expect(matchWorkFormat("脚本")).toBe("script");
  });
});

describe("雛形（①）", () => {
  test("小説は空のまま（これまでどおり）", () => {
    expect(newEpisodeTemplate("novel")).toBe("");
    expect(newEpisodeTemplate(undefined)).toBe("");
  });

  test("小説以外は見本が入る", () => {
    for (const kind of ["script", "manga", "essay", "lyrics"] as WorkKindKey[]) {
      expect(newEpisodeTemplate(kind).trim(), kind).not.toBe("");
    }
  });

  /**
   * **雛形の行が、組み方の規則にちゃんと当たる。** 見本と規則が別々に
   * 書かれているので、片方だけ直すと「見本どおりに書いたのに組まれない」
   * ことになる。
   */
  test("台本の雛形は、柱・ト書き・台詞として組まれる", () => {
    const lines = newEpisodeTemplate("script").split("\n").filter((line) => line);
    expect(lines.map((line) => kindLineClass("script", line))).toEqual([
      "script-hashira",
      "script-togaki",
      "script-serifu",
    ]);
    // 柱は「○場所（時）」の形
    expect(lines[0]).toMatch(/^\u25CB.+（.+）$/);
  });

  test("漫画の原作の雛形は、ページ・コマ・絵の説明・台詞として組まれる", () => {
    const lines = newEpisodeTemplate("manga").split("\n").filter((line) => line);
    expect(lines.map((line) => kindLineClass("manga", line))).toEqual([
      "manga-page",
      "manga-panel",
      "script-togaki",
      "script-serifu",
    ]);
  });

  test("エッセイの雛形の見出しは、見出しとして組まれる", () => {
    const first = newEpisodeTemplate("essay").split("\n")[0];
    expect(kindLineClass("essay", first)).toBe("essay-heading");
  });

  test("歌詞の雛形の札は、札として組まれる", () => {
    const labels = newEpisodeTemplate("lyrics")
      .split("\n")
      .filter((line) => kindLineClass("lyrics", line) === "lyrics-label");
    expect(labels).toEqual(["\u3010Aメロ\u3011", "\u3010サビ\u3011"]);
  });

  /** ルビ・傍点の記法（`{`・`｜`・`《`）と衝突しない字で書く */
  test("雛形はルビ・傍点の記法を含まない", () => {
    for (const kind of ALL_KINDS) {
      expect(newEpisodeTemplate(kind), kind).not.toMatch(/[{}｜|《》]/);
    }
  });
});

describe("プロットの書き出し（①）", () => {
  test("小説はこれまでと1文字も変わらない", () => {
    expect(buildPlotTemplate("作品", "novel")).toBe(buildPlotTemplate("作品"));
  });

  test("台本には人物表と箱書きが入る", () => {
    const plot = buildPlotTemplate("夜の駅", "script");
    expect(plot).toContain("## 登場人物表");
    expect(plot).toContain("## 箱書き");
    // 物語の骨組み（ログライン・あらすじ）は小説と同じく置く
    expect(plot).toContain("## ログライン");
  });

  test("エッセイは物語の見出しを置かない", () => {
    const plot = buildPlotTemplate("散歩の話", "essay");
    expect(plot).toContain("## 伝えたいこと");
    expect(plot).not.toContain("## ログライン");
  });

  test("種類ならではの見出しは、読み直しても落ちない", () => {
    // PLOT_SECTIONS に無い名前は「作者が足した節」として残る
    const parsed = parsePlotMarkdown(buildPlotTemplate("夜の駅", "script"));
    expect(parsed.extra).toContain("## 登場人物表");
    expect(parsed.extra).toContain("## 箱書き");
  });
});

describe("開く向き", () => {
  test("台本だけ縦書き", () => {
    expect(manuscriptViewTypeFor("script")).toBe(MANUSCRIPT_EDITOR_VIEW_TYPE);
    for (const kind of ["novel", "manga", "essay", "lyrics", undefined] as Array<
      WorkKindKey | undefined
    >) {
      expect(manuscriptViewTypeFor(kind), String(kind)).toBe(
        MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE
      );
    }
  });
});

/** 新規作成が書いたファイルを集めるスタブ（`workConfig.test.ts` と同じ形） */
function scaffoldStub(): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  workspace.fs = {
    stat: async () => {
      throw new FileSystemError("missing", "FileNotFound");
    },
    createDirectory: async () => undefined,
    writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
      files.set(uri.fsPath, bytes);
    },
  };
  return files;
}

function readJson(files: Map<string, Uint8Array>, file: string): Record<string, unknown> {
  const bytes = files.get(Uri.file(file).fsPath);
  if (!bytes) throw new Error(`書かれていません: ${file}`);
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

describe("新規作成（作品フォルダーの初期構造）", () => {
  test("種類を選んだら、作品の設定へ書く", async () => {
    const root = "C:\\novels\\script-work";
    const files = scaffoldStub();

    await workRegistry.scaffoldWorkFolder(root, "夜の駅", {
      withPlot: true,
      kind: "script",
    });

    expect(readJson(files, path.join(root, ".aiwriter", "config.json")).kind).toBe(
      "script"
    );
    const plot = new TextDecoder().decode(
      files.get(Uri.file(path.join(root, "設定", "plot.md")).fsPath)
    );
    expect(plot).toContain("## 箱書き");
  });

  test("小説なら、設定ファイルはこれまでと同じ形（欄を足さない）", async () => {
    for (const kind of ["novel", undefined] as Array<WorkKindKey | undefined>) {
      const root = `C:\\novels\\novel-${String(kind)}`;
      const files = scaffoldStub();

      await workRegistry.scaffoldWorkFolder(root, "新作", { kind });

      expect(
        "kind" in readJson(files, path.join(root, ".aiwriter", "config.json")),
        String(kind)
      ).toBe(false);
    }
  });
});
