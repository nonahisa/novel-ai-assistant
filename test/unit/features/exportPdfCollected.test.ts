import * as path from "path";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { WorkEntry } from "../../../src/models/types";
import { Uri, window, workspace } from "../support/vscodeStub";
import { memoryFs } from "../support/memoryDisk";

/**
 * 合本（1ファイルに複数話）をPDF（印刷用HTML）へ組む（設計書6.65.15）。
 *
 * **EPUBと同じ切り分けを通す。** PDF出力は長いあいだ
 * `parseEpisodeMetadata` だけを通っており、区切り行（`エピソードN開始`）も
 * 【エピソードタイトル】【後書き】【リアクション】も、まるごと本文として
 * 紙に出ていた（EPUBで直したのと同じ不具合。原稿は読むだけなので、
 * 被害は書き出したファイルの中だけ）。
 *
 * ここは作り物のファイルシステムで `exportPdf` をそのまま動かし、
 * 書き出されたHTMLを開いて確かめる。組版を別に組み直すと、**製品に無い紙**
 * を確かめたことになる。
 */

// 書き出したファイルを既定のアプリで開くところは、テストでは動かさない
// （`cmd /c start` が実際に走ってブラウザが開いてしまう）。
// 「開けなかった」ときの案内（F-25）も確かめたいので、成否を差し替えられるようにする
const openExternalFileState = { succeeds: true };
vi.mock("../../../src/core/openExternalFile", () => ({
  openInDefaultApp: async () => openExternalFileState.succeeds,
}));
const revealedFolders: string[] = [];
vi.mock("../../../src/views/openDocument", () => ({
  revealFolder: async (target: string) => {
    revealedFolders.push(target);
  },
}));

const { exportPdf } = await import("../../../src/features/exportPdf");

const work: WorkEntry = {
  id: "work_pdf_collected",
  title: "氷の街",
  folderPath: "C:\\novels\\work",
  registeredAt: "2026-09-05T00:00:00.000Z",
};

const disk = new Map<string, Uint8Array>();
const shown: string[] = [];

function diskPath(filePath: string): string {
  return Uri.file(filePath).fsPath;
}

function put(relativePath: string, text: string): void {
  disk.set(
    diskPath(path.join(work.folderPath, relativePath)),
    new TextEncoder().encode(text)
  );
}

/** 作り物のファイルシステム。キーは `Uri.file` が返す形に揃える */
function installDisk(): void {
  workspace.fs = memoryFs(disk, {
    fileStat: { mtime: Date.UTC(2026, 8, 5, 5, 0, 0), size: 1 },
    folderStat: { mtime: 0, size: 0 },
    readDirectory: "nested",
  });
}

/**
 * 3つの選択（範囲・紙の大きさ・上下の余白）に答える。
 *
 * **項目の形で見分ける。** 順番で決め打ちすると、選択が1つ増えた
 * ときに黙って別の答えを返すことになる。
 */
function answerQuickPicks(): void {
  (window as unknown as Record<string, unknown>).showQuickPick = async (
    items: Array<Record<string, unknown>>
  ) => {
    const all = items.find((item) => item.all === true);
    if (all) return all;
    // 上下の余白（0.84.1〜）は紙の既定のまま
    const keep = items.find((item) => item.margins === "default");
    if (keep) return keep;
    return items.find((item) => item.id === "bunko-vertical");
  };
}

beforeEach(() => {
  disk.clear();
  shown.length = 0;
  openExternalFileState.succeeds = true;
  revealedFolders.length = 0;
  installDisk();
  answerQuickPicks();

  window.showInformationMessage = async (message: string) => {
    shown.push(message);
    return undefined;
  };
  window.showWarningMessage = async (message: string) => {
    shown.push(message);
    return undefined;
  };
  window.showErrorMessage = async (message: string) => {
    shown.push(message);
    return undefined;
  };
});

/** 書き出された印刷用HTMLを開き直す */
function exportedHtml(): string {
  const found = [...disk.entries()].find(([name]) => name.endsWith(".html"));
  if (!found) throw new Error("印刷用HTMLが書き出されていません");
  return new TextDecoder().decode(found[1]);
}

/** 目に見える字だけを取り出す（札を落とす） */
function plain(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

/** 実データで観察された合本の形（区切り＋頭書き＋後書き＋リアクション） */
const COLLECTED = [
  "------------------------- エピソード1開始 -------------------------",
  "【エピソードタイトル】",
  "１話　転生",
  "",
  "【本文】",
  "　朝が来た。",
  "",
  "　鐘が鳴る。",
  "",
  "【後書き】",
  "　お読みいただきありがとうございます。",
  "",
  "【リアクション】",
  "いいね: 19件",
  "",
  "------------------------- エピソード2開始 -------------------------",
  "【エピソードタイトル】",
  "２話　再会",
  "",
  "【本文】",
  "　昼が来た。",
  "",
  "------------------------- エピソード3開始 -------------------------",
  "【エピソードタイトル】",
  "３話　別離",
  "",
  "【本文】",
  "　夜が来た。",
].join("\n");

describe("合本は話ごとに章へ割る（設計書6.65.15）", () => {
  beforeEach(() => {
    put("本文/全話.txt", COLLECTED);
  });

  test("3話ぶんの合本から、3つの章ができる", async () => {
    await exportPdf(work);
    const html = exportedHtml();

    // 話ごとに改ページする単位が `section.episode`（`core/printHtml.ts`）
    expect(html.match(/<section class="episode">/g)?.length).toBe(3);
  });

  test("区切り行・頭書き・後書き・リアクションは本文に入らない", async () => {
    await exportPdf(work);
    const text = plain(exportedHtml());

    expect(text).toContain("朝が来た。");
    expect(text).toContain("昼が来た。");
    expect(text).toContain("夜が来た。");

    expect(text).not.toContain("エピソード1開始");
    expect(text).not.toContain("エピソードタイトル");
    expect(text).not.toContain("【本文】");
    expect(text).not.toContain("お読みいただきありがとうございます");
    expect(text).not.toContain("いいね: 19件");
  });

  test("章の見出しは、その話の話数と題になる", async () => {
    await exportPdf(work);
    const headings = [
      ...exportedHtml().matchAll(/<h2 class="episode-heading">(.*?)<\/h2>/g),
      // 縦書きの紙では数字が縦中横の札に包まれる（2026-10-09）。字だけを見る
    ].map((matched) => matched[1].replace(/<[^>]*>/g, ""));

    expect(headings).toEqual(["第1話　転生", "第2話　再会", "第3話　別離"]);
  });

  /**
   * **話数が読めない話でも、番号を捏造しない**（EPUBと同じ約束）。
   * 並び順を話数として出すと、「プロローグ」が第1話になる。
   */
  test("話数の読めない話は、題だけを見出しにする", async () => {
    put(
      "本文/全話.txt",
      [
        "------- エピソード1開始 -------",
        "【エピソードタイトル】",
        "プロローグ",
        "",
        "【本文】",
        "　雪が降る。",
        "",
        "------- エピソード2開始 -------",
        "【エピソードタイトル】",
        "１話　転生",
        "",
        "【本文】",
        "　朝が来た。",
      ].join("\n")
    );

    await exportPdf(work);
    const headings = [
      ...exportedHtml().matchAll(/<h2 class="episode-heading">(.*?)<\/h2>/g),
      // 縦書きの紙では数字が縦中横の札に包まれる（2026-10-09）。字だけを見る
    ].map((matched) => matched[1].replace(/<[^>]*>/g, ""));

    expect(headings).toEqual(["プロローグ", "第1話　転生"]);
  });
});

/** 書き出したHTMLの、上下の余白の置き方（body の data-margins を読み戻す） */
function exportedMargins(): unknown {
  const raw = /data-margins="([^"]*)"/.exec(exportedHtml())?.[1] ?? "null";
  return JSON.parse(raw.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
}

/**
 * 上下の余白（ヘッダー・フッター）を選ぶ（設計書6.33.5 の2、0.84.1。2026-10-17 から
 * 奇数・偶数ページごとに、ヘッダー・フッターの左・中央・右へ置く）。
 *
 * 置き方は紙・範囲といっしょに作品の設定へ覚える（`exportPdfLastSettings.test.ts`）。
 * 作者名は EPUB の設計図に書いてあればそれを初めから入れて見せ、無ければ尋ねる。
 * **尋ねた名前を設計図へ書き込まない**（どこにも覚えない）。
 */
describe("上下の余白に刷るものを選ぶ", () => {
  const picks: Array<{ title?: string; items: Array<Record<string, unknown>> }> = [];
  const asked: Array<{ value?: string }> = [];

  /**
   * 範囲・紙は既定で答え、余白は「刷るものと置き場所を選ぶ」から、
   * `[刷るもの, 奇数の置き場所, 偶数の置き場所]` を順に選んで「これで決める」
   */
  function choose(placements: Array<[string, string, string]>, typedAuthor?: string): void {
    const contents = placements.map((item) => item[0]);
    const places = placements.flatMap((item) => [item[1], item[2]]);
    (window as unknown as Record<string, unknown>).showQuickPick = async (
      items: Array<Record<string, unknown>>,
      options?: { title?: string }
    ) => {
      picks.push({ title: options?.title, items });
      const all = items.find((item) => item.all === true);
      if (all) return all;
      const preset = items.find((item) => item.id === "bunko-vertical");
      if (preset) return preset;
      const chooseItem = items.find((item) => item.margins === "choose");
      if (chooseItem) return chooseItem;
      if (items.some((item) => item.done === true)) {
        const want = contents.shift();
        return want === undefined
          ? items.find((item) => item.done === true)
          : items.find((item) => item.content === want);
      }
      const label = places.shift();
      return items.find((item) => "place" in item && item.label === label);
    };
    (window as unknown as Record<string, unknown>).showInputBox = async (
      options?: { value?: string }
    ) => {
      asked.push(options ?? {});
      return typedAuthor;
    };
  }

  beforeEach(() => {
    picks.length = 0;
    asked.length = 0;
    put("本文/第1話 出会い.txt", "　朝が来た。");
  });

  const none = { left: "none", center: "none", right: "none" };

  test("既定のままなら、紙の既定（奇数はヘッダー右・偶数はヘッダー左に番号、中央に話の見出し）", async () => {
    await exportPdf(work);

    expect(exportedMargins()).toEqual({
      odd: { top: { left: "none", center: "episode", right: "page" }, bottom: none },
      even: { top: { left: "page", center: "episode", right: "none" }, bottom: none },
    });
  });

  test("既定の項目に、何が刷られるかを書いて見せる", async () => {
    choose([]);
    await exportPdf(work);

    const marginPick = picks.find((pick) => pick.items.some((item) => item.margins));
    const keep = marginPick?.items.find((item) => item.margins === "default");
    expect(keep?.description).toBe(
      "奇数ページ：ヘッダー中央に話の見出し・ヘッダー右にページ番号／偶数ページ：ヘッダー左にページ番号・ヘッダー中央に話の見出し"
    );
  });

  test("刷るものを選んで、奇数・偶数の置き場所を決めると、そのとおりに刷られる", async () => {
    choose([
      ["page", "フッター右", "フッター左"],
      ["episode", "刷らない", "刷らない"],
      ["title", "ヘッダー中央", "ヘッダー中央"],
    ]);
    await exportPdf(work);

    expect(exportedMargins()).toEqual({
      odd: { top: { ...none, center: "title" }, bottom: { ...none, right: "page" } },
      even: { top: { ...none, center: "title" }, bottom: { ...none, left: "page" } },
    });
    // 作者名を選んでいないので、名前は尋ねない
    expect(asked).toHaveLength(0);
  });

  test("ほかのものが置かれた枠を選ぶと、そちらは刷らなくなる（選ぶ画面にそう出す）", async () => {
    // 既定ではヘッダー中央に話の見出し。そこへ題名を置く
    choose([["title", "ヘッダー中央", "ヘッダー中央"]]);
    await exportPdf(work);

    const placePick = picks.find((pick) => pick.items.some((item) => "place" in item));
    const center = placePick?.items.find((item) => item.label === "ヘッダー中央");
    expect(center?.description).toBe("いまは話の見出し（置くと、そちらは刷らなくなります）");
    const margins = exportedMargins() as { odd: { top: Record<string, string> } };
    expect(margins.odd.top).toEqual({ left: "none", center: "title", right: "page" });
  });

  test("刷るものの選択肢は、題名・話の見出し・作者名・ページ番号と、これで決める・取りやめる", async () => {
    choose([]);
    await exportPdf(work);

    const contentPick = picks.find((pick) => pick.items.some((item) => item.done === true));
    expect(contentPick?.items.map((item) => item.label)).toEqual([
      "これで決める",
      "題名",
      "話の見出し",
      "作者名",
      "ページ番号",
      "$(close) 取りやめる",
    ]);
  });

  test("置き場所は、ヘッダー・フッターの左・中央・右と、刷らない", async () => {
    choose([["page", "フッター中央", "フッター中央"]]);
    await exportPdf(work);

    const placePick = picks.find((pick) => pick.items.some((item) => "place" in item));
    expect(placePick?.title).toBe("奇数ページの「ページ番号」をどこに置きますか");
    expect(placePick?.items.map((item) => item.label)).toEqual([
      "ヘッダー左",
      "ヘッダー中央",
      "ヘッダー右",
      "フッター左",
      "フッター中央",
      "フッター右",
      "刷らない",
      "$(close) 取りやめる",
    ]);
  });

  test("作者名を選び、設計図に名前が無ければ尋ねる。尋ねた名前は保存しない", async () => {
    choose([["author", "フッター左", "フッター右"]], "山田太郎");
    await exportPdf(work);

    expect(asked).toHaveLength(1);
    expect(exportedHtml()).toContain('data-author="山田太郎"');
    // 書き出したのは印刷用のHTMLだけ（設計図を作っていない）
    const written = [...disk.keys()].filter((name) => !name.includes("本文"));
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/\.html$/);
  });

  test("EPUBの設計図に作者名があれば、初めから入れて見せる", async () => {
    put("設定/書籍/book.json", JSON.stringify({ author: "筆名A" }));
    choose([["author", "フッター中央", "刷らない"]], "筆名A");
    await exportPdf(work);

    expect(asked[0]?.value).toBe("筆名A");
    expect(exportedHtml()).toContain('data-author="筆名A"');
  });

  test("設計図の筆名と違う名前を入れると、刷るのは入れた名前で、EPUBの設計図の筆名は変わらない", async () => {
    // 実機確認リスト 6472 行「尋ねられた名前を変えても、EPUBエディターの作者名は変わらないか」
    // （2026-10-15）。上の件は設計図が無いときに作らないことだけを見ていた。設計図があり、
    // 名前を打ち替えた形で、設計図のファイルが1字も変わらないことを見る
    const book = JSON.stringify({ author: "筆名A" });
    put("設定/書籍/book.json", book);
    choose([["author", "ヘッダー左", "ヘッダー左"]], "別の筆名B");
    await exportPdf(work);

    expect(asked[0]?.value).toBe("筆名A");
    expect(exportedHtml()).toContain('data-author="別の筆名B"');
    expect(exportedHtml()).not.toContain('data-author="筆名A"');
    const bookKey = [...disk.keys()].find((name) => name.replace(/\\/g, "/").endsWith("設定/書籍/book.json"));
    expect(bookKey, "設計図が見当たりません").toBeDefined();
    expect(new TextDecoder().decode(disk.get(bookKey ?? ""))).toBe(book);
  });

  test("作者名を尋ねられて取りやめたら、書き出さない", async () => {
    choose([["author", "フッター中央", "フッター中央"]], undefined);
    await exportPdf(work);

    expect([...disk.keys()].some((name) => name.endsWith(".html"))).toBe(false);
  });

  test("上下の余白の選択で取りやめたら、書き出さない", async () => {
    (window as unknown as Record<string, unknown>).showQuickPick = async (
      items: Array<Record<string, unknown>>
    ) => {
      const all = items.find((item) => item.all === true);
      if (all) return all;
      const preset = items.find((item) => item.id === "bunko-vertical");
      if (preset) return preset;
      // 「取りやめる」の項目を押す（Esc で閉じたのとは別の道）
      const cancel = items.find((item) => item.__cancel === true);
      expect(cancel).toBeDefined();
      return cancel;
    };
    await exportPdf(work);

    expect([...disk.keys()].some((name) => name.endsWith(".html"))).toBe(false);
  });
});

/**
 * 公募の納品用の組版を選ぶ（設計書6.33.5 の3、0.84.2）。
 *
 * 紙の選択の並びに「公募の納品用」を足し、字数×行数・向きと紙・
 * ぶら下げの有無を順に選ぶ。**選んだ字数と行数がそのまま紙になる**
 * （組版は `manuscriptGrid.ts`）。
 */
describe("公募の納品用で書き出す", () => {
  const shownTitles: string[] = [];
  const inputs: Array<{ validateInput?: (value: string) => unknown }> = [];

  /**
   * 紙の選択で公募を選び、あとは `answers` の順に項目の形で答える。
   * 余白を尋ねられたら `marginMm` を選ぶ（尋ねられない組み合わせもある）
   */
  function chooseManuscript(
    answers: Array<(item: Record<string, unknown>) => boolean>,
    typed: string[] = [],
    marginMm = 20
  ): void {
    const queue = [...answers];
    (window as unknown as Record<string, unknown>).showQuickPick = async (
      items: Array<Record<string, unknown>>,
      options?: { title?: string }
    ) => {
      shownTitles.push(options?.title ?? "");
      const all = items.find((item) => item.all === true);
      if (all) return all;
      const manuscript = items.find((item) => item.manuscript === true);
      if (manuscript) return manuscript;
      const keep = items.find((item) => item.margins === "default");
      if (keep) return keep;
      if (items.some((item) => typeof item.mm === "number")) {
        return items.find((item) => item.mm === marginMm);
      }
      const answer = queue.shift();
      return answer ? items.find(answer) : undefined;
    };
    (window as unknown as Record<string, unknown>).showInputBox = async (options?: {
      validateInput?: (value: string) => unknown;
    }) => {
      inputs.push(options ?? {});
      return typed.shift();
    };
  }

  beforeEach(() => {
    shownTitles.length = 0;
    inputs.length = 0;
    put("本文/第1話 出会い.txt", "　朝が来た。\n\n　鐘が鳴る。");
  });

  test("40字×40行・縦書き・A4横置き・ぶら下げありで組む", async () => {
    chooseManuscript([
      (item) => item.columns === 40 && item.rows === 40,
      (item) => item.paper === "a4-landscape" && item.vertical === true,
      (item) => item.hanging === true,
    ]);
    await exportPdf(work);
    const html = exportedHtml();

    expect(html).toContain('data-grid="1"');
    expect(html).toContain("@page { size: 297mm 210mm; margin: 0; }");
    expect(html).toContain("公募の納品用・縦書き・40字×40行・句読点のぶら下げあり");
    // 公募の上下の既定：上はなし、下の中央にページ番号（名前を出さない公募があるため）
    expect(html).toContain("上下の余白：奇数・偶数ページとも：フッター中央にページ番号");
  });

  /** 余白（作者の裁定、2026-10-09）：普通（20mm）／狭く（10mm）。既定は普通 */
  test("余白を尋ね、選んだ余白で組む。字の大きさを添える", async () => {
    chooseManuscript(
      [
        (item) => item.columns === 40 && item.rows === 40,
        (item) => item.paper === "a4-portrait" && item.vertical === true,
        (item) => item.hanging === true,
      ],
      [],
      10
    );
    await exportPdf(work);

    expect(shownTitles).toContain("紙の余白を選んでください");
    const html = exportedHtml();
    expect(html).toContain("・余白10mm）");
    expect(html).toContain("top: 10mm;");
  });

  test("余白を選ぶ画面に、字の大きさ（A4縦置き40×40で約8pt→約9pt）と端に刷れないことを出す", async () => {
    let marginItems: Array<Record<string, unknown>> = [];
    chooseManuscript([
      (item) => item.columns === 40 && item.rows === 40,
      (item) => item.paper === "a4-portrait" && item.vertical === true,
      (item) => item.hanging === true,
    ]);
    const answer = (window as unknown as Record<string, unknown>).showQuickPick as (
      items: Array<Record<string, unknown>>,
      options?: { title?: string }
    ) => Promise<unknown>;
    (window as unknown as Record<string, unknown>).showQuickPick = async (
      items: Array<Record<string, unknown>>,
      options?: { title?: string }
    ) => {
      if (items.some((item) => typeof item.mm === "number")) marginItems = items;
      return answer(items, options);
    };
    await exportPdf(work);

    const normal = marginItems.find((item) => item.mm === 20);
    const narrow = marginItems.find((item) => item.mm === 10);
    expect(normal?.label).toBe("普通（20mm）");
    expect(narrow?.label).toBe("狭く（10mm）");
    expect(String(normal?.detail)).toContain("約8.0pt");
    expect(String(narrow?.detail)).toContain("約8.0ptから約9.0pt");
    expect(String(narrow?.detail)).toContain("端の数mm");
    expect(exportedHtml()).toContain("・余白20mm）");
  });

  test("書き出したあとの知らせに、字数×行数と本文の枚数を出す", async () => {
    chooseManuscript([
      (item) => item.columns === 20 && item.rows === 20,
      (item) => item.paper === "a4-portrait" && item.vertical === false,
      (item) => item.hanging === false,
    ]);
    await exportPdf(work);

    expect(shown.some((message) => message.includes("20字×20行で本文1枚"))).toBe(true);
  });

  test("字数と行数を自分で決められる。数でないもの・範囲の外は断る", async () => {
    chooseManuscript(
      [
        (item) => item.custom === true,
        (item) => item.paper === "a4-landscape",
        (item) => item.hanging === true,
      ],
      ["42", "34"]
    );
    await exportPdf(work);

    expect(exportedHtml()).toContain("42字×34行");
    const validate = inputs[0]?.validateInput;
    expect(validate?.("abc")).toBeTruthy();
    expect(validate?.("3")).toBeTruthy();
    expect(validate?.("61")).toBeTruthy();
    expect(validate?.("40")).toBeFalsy();
    expect(validate?.(" 20 ")).toBeFalsy();
  });

  test("字数×行数の選択で取りやめたら、書き出さない", async () => {
    chooseManuscript([(item) => item.__cancel === true]);
    await exportPdf(work);

    expect([...disk.keys()].some((name) => name.endsWith(".html"))).toBe(false);
  });

  test("ふつうの紙を選んだときは、これまでどおり流し込みの組版", async () => {
    await exportPdf(work);

    expect(exportedHtml()).not.toContain('data-grid="1"');
    expect(exportedHtml()).toContain('id="print-source"');
  });
});

/**
 * **単話ファイルだけの作品の紙は、1バイトも変わらない**（回帰の固定）。
 *
 * 合本を割る道を足したせいで、いままで出ていた紙が変わっては困る。
 * 下の期待値は、合本を割る前の書き出しから採った。
 */
describe("単話だけの作品の紙は変わらない（回帰の固定）", () => {
  /** 1区切りだけの頭書き付き。**これは合本ではない**（単話の道を通る） */
  const WITH_HEADER = [
    "-------- エピソード1開始 --------",
    "【エピソードタイトル】",
    "２話　再会",
    "",
    "【本文】",
    "　昼が来た。",
  ].join("\n");

  test("組んだHTMLが1バイトも変わらない", async () => {
    put("本文/第1話 出会い.txt", "　朝が来た。\n\n　鐘が鳴る。");
    put("本文/第2話.txt", WITH_HEADER);

    await exportPdf(work);
    const digest = createHash("sha256")
      .update(new TextEncoder().encode(exportedHtml()))
      .digest("hex");

    expect(digest).toBe(GOLDEN);
  });
});

/**
 * 未解決の競合マーカーを含む話は、組まずに外す（実機確認リスト F-25 の代わり）。
 *
 * `exportPdf.ts` の「競合マーカーが残っている話。組んでも読めない紙になる
 * ので外す」という判断を、実際に `exportPdf` を走らせて確かめる。
 */
describe("未解決の競合は外す（設計書のとおり。実機確認リスト F-25 の代わり）", () => {
  test("競合マーカーを含む話は外され、その旨が案内に出る", async () => {
    put("本文/第1話.txt", "　朝が来た。");
    put(
      "本文/第2話.txt",
      [
        "<<<<<<< HEAD",
        "　昼が来た。",
        "=======",
        "　昼になった。",
        ">>>>>>> branch",
      ].join("\n")
    );

    await exportPdf(work);

    const text = plain(exportedHtml());
    expect(text).toContain("朝が来た。");
    expect(text).not.toContain("昼が来た。");
    expect(text).not.toContain("昼になった。");

    // 開けた側（成功）の案内に、外した理由とファイル名が添わる
    expect(
      shown.some((message) =>
        message.includes("未解決の競合を含む1件は外しました（第2話.txt）")
      )
    ).toBe(true);
  });

  test("全部が競合していれば、書き出さずに理由だけ言う", async () => {
    put(
      "本文/第1話.txt",
      ["<<<<<<< HEAD", "　朝が来た。", "=======", "　朝になった。", ">>>>>>> branch"].join(
        "\n"
      )
    );

    await exportPdf(work);

    expect(
      shown.some((message) => message.includes("すべて未解決の競合を含んでいる"))
    ).toBe(true);
    expect([...disk.entries()].some(([name]) => name.endsWith(".html"))).toBe(
      false
    );
  });
});

/**
 * ブラウザを開けなかったときの案内（実機確認リスト F-25 の代わり）。
 *
 * 以前は戻り値を見ずに「ブラウザで開きました」と告げていた不具合の直し
 * （0.24.5、作者の報告 2026-08-30）。開けなかったときは、成功したことに
 * せず、フォルダーを手で開く道を示す。
 */
describe("ブラウザを開けなかったとき（実機確認リスト F-25 の代わり）", () => {
  test("フォルダーの中の.htmlをダブルクリックしてくださいと案内する", async () => {
    openExternalFileState.succeeds = false;
    put("本文/第1話.txt", "　朝が来た。");

    await exportPdf(work);

    expect(
      shown.some((message) =>
        message.includes(
          "フォルダーの中の .html をダブルクリックすると開きます"
        )
      )
    ).toBe(true);
    // 開けなかったのに「開きました」と言っていないこと
    expect(shown.some((message) => message.includes("ブラウザで開きました"))).toBe(
      false
    );
  });

  test("「フォルダーを開く」を押すと、書き出し先が開く", async () => {
    openExternalFileState.succeeds = false;
    put("本文/第1話.txt", "　朝が来た。");
    window.showWarningMessage = async () => "フォルダーを開く";

    await exportPdf(work);

    expect(revealedFolders.length).toBe(1);
  });
});

/**
 * .md と .txt が混ざった作品でも両方組まれるか（実機確認リスト F-34 の代わり）。
 *
 * 実データに「DLした話（.txt）と、こちらで書き足した話（.md）」が混ざる
 * ことがあると `exportPdf.ts` のコメントにある。拡張子違いで片方が
 * 落ちないことを固定する。
 */
describe(".mdと.txtが混ざっても両方組まれる（実機確認リスト F-34 の代わり）", () => {
  test("拡張子が違っても、どちらの本文も紙に出る", async () => {
    put("本文/第1話.txt", "　朝が来た。");
    put("本文/第2話.md", "　夜になった。");

    await exportPdf(work);
    const text = plain(exportedHtml());

    expect(text).toContain("朝が来た。");
    expect(text).toContain("夜になった。");
  });
});

/**
 * 合本を割る前の書き出しから採ったハッシュ（2026-09-05）。
 *
 * **ここを更新してよいのは、紙の組み方を変えると決めたときだけ**である。
 * 合本の実装で動いたら、単話の道を巻き込んでいる。
 *
 * 更新の記録：
 * - 0.84.0（2026-09-24）：紙1枚ずつの面に割る組み方へ変えた（設計書6.33.5 の1）。
 *   案内帯・面を並べる場所・面に割るスクリプトが加わり、改ページの指定を
 *   流し込みの本文にだけ当てるようにした
 * - 0.84.1（2026-09-24）：上下の余白に刷るもの（ヘッダー・フッター）を足した
 *   （設計書6.33.5 の2）。body に選んだ中身と材料が付き、案内帯に何が刷られるかが出る
 * - 0.84.2（2026-09-24）：埋め込むスクリプトに、公募の納品用（面を組んで渡す）の
 *   ときは割り直さない分かれ道が加わった（設計書6.33.5 の3）。組み方そのものは変わらない
 * - 2026-10-09（作者の裁定）：読む紙に厳しい禁則（`line-break: strict` と、面の切れ目の
 *   小さい仮名・長音）と縦書きの縦中横（見出しの「第1話」の 1 も立つ）が加わった。
 *   話の割り方は変わらない
 * - 2026-10-17（作者の裁定）：上下の余白を奇数・偶数ページごとの左・中央・右に分けた
 *   （body の data-head・data-foot が data-margins に替わり、頭と足に3つの枠ができた）。
 *   読む紙の既定も、ページ番号をヘッダーの左右・話の見出しをヘッダーの中央に改めた。
 *   本文の組み方と話の割り方は変わらない
 */
const GOLDEN =
  "c6893dafb119530d03a262536c3693a69452401506c7f24d2511438719638cb2";
