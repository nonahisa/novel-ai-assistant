import * as path from "path";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { WorkEntry } from "../../../src/models/types";
import {
  FileSystemError,
  FileType,
  Uri,
  window,
  workspace,
} from "../support/vscodeStub";

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
  const separator = path.sep;
  workspace.fs = {
    createDirectory: async () => undefined,
    readFile: async (uri: { fsPath: string }) => {
      const bytes = disk.get(uri.fsPath);
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
      return bytes;
    },
    writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
      disk.set(uri.fsPath, bytes);
    },
    rename: async (
      from: { fsPath: string },
      to: { fsPath: string },
      options?: { overwrite?: boolean }
    ) => {
      const bytes = disk.get(from.fsPath);
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
      if (!options?.overwrite && disk.has(to.fsPath)) {
        throw new FileSystemError("exists", "FileExists");
      }
      disk.set(to.fsPath, bytes);
      disk.delete(from.fsPath);
    },
    delete: async (uri: { fsPath: string }) => {
      disk.delete(uri.fsPath);
    },
    stat: async (uri: { fsPath: string }) => {
      if (disk.has(uri.fsPath)) {
        return { mtime: Date.UTC(2026, 8, 5, 5, 0, 0), size: 1 };
      }
      const prefix = uri.fsPath + separator;
      for (const key of disk.keys()) {
        if (key.startsWith(prefix)) return { mtime: 0, size: 0 };
      }
      throw new FileSystemError("missing", "FileNotFound");
    },
    readDirectory: async (uri: { fsPath: string }) => {
      const prefix = uri.fsPath + separator;
      const names = new Map<string, FileType>();
      for (const key of disk.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const cut = rest.indexOf(separator);
        if (cut < 0) names.set(rest, FileType.File);
        else names.set(rest.slice(0, cut), FileType.Directory);
      }
      if (names.size === 0) throw new FileSystemError("missing", "FileNotFound");
      return [...names.entries()];
    },
  } as unknown as typeof workspace.fs;
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
      ...exportedHtml().matchAll(/<h2 class="episode-heading">([^<]*)<\/h2>/g),
    ].map((matched) => matched[1]);

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
      ...exportedHtml().matchAll(/<h2 class="episode-heading">([^<]*)<\/h2>/g),
    ].map((matched) => matched[1]);

    expect(headings).toEqual(["プロローグ", "第1話　転生"]);
  });
});

/**
 * 上下の余白（ヘッダー・フッター）を選ぶ（設計書6.33.5 の2、0.84.1）。
 *
 * **選ぶのは書き出すときだけ**で、どこにも保存しない（紙の大きさの選び方と
 * 同じ持ち方）。作者名は EPUB の設計図に書いてあればそれを初めから入れて
 * 見せ、無ければ尋ねる。**尋ねた名前を設計図へ書き込まない。**
 */
describe("上下の余白に刷るものを選ぶ", () => {
  const picks: Array<{ title?: string; items: Array<Record<string, unknown>> }> = [];
  const asked: Array<{ value?: string }> = [];

  /** 範囲・紙は既定で答え、上下の余白は `top`・`bottom` を選ぶ */
  function choose(top: string, bottom: string, typedAuthor?: string): void {
    const marginAnswers = [top, bottom];
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
      const want = marginAnswers.shift();
      return items.find((item) => item.margin === want);
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

  test("既定のままなら、紙の既定（文庫：上は話の見出し・下はページ番号）", async () => {
    await exportPdf(work);

    expect(exportedHtml()).toContain('data-head="episode" data-foot="page"');
  });

  test("既定の項目に、何が刷られるかを書いて見せる", async () => {
    choose("title", "page");
    await exportPdf(work);

    const marginPick = picks.find((pick) => pick.items.some((item) => item.margins));
    const keep = marginPick?.items.find((item) => item.margins === "default");
    expect(keep?.description).toBe("上：話の見出し／下：ページ番号");
  });

  test("上と下を選ぶと、選んだものが刷られる", async () => {
    choose("title", "none");
    await exportPdf(work);

    expect(exportedHtml()).toContain('data-head="title" data-foot="none"');
    // 作者名を選んでいないので、名前は尋ねない
    expect(asked).toHaveLength(0);
  });

  test("上と下の選択肢は、題名・話の見出し・作者名・ページ番号・なし と取りやめる", async () => {
    choose("title", "page");
    await exportPdf(work);

    const topPick = picks.find((pick) => pick.items.some((item) => item.margin));
    expect(topPick?.items.map((item) => item.label)).toEqual([
      "題名",
      "話の見出し",
      "作者名",
      "ページ番号",
      "なし",
      "$(close) 取りやめる",
    ]);
  });

  test("作者名を選び、設計図に名前が無ければ尋ねる。尋ねた名前は保存しない", async () => {
    choose("author", "page", "山田太郎");
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
    choose("page", "author", "筆名A");
    await exportPdf(work);

    expect(asked[0]?.value).toBe("筆名A");
    expect(exportedHtml()).toContain('data-author="筆名A"');
  });

  test("作者名を尋ねられて取りやめたら、書き出さない", async () => {
    choose("author", "page", undefined);
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
 */
const GOLDEN =
  "f038e058d76a0525f567ca6099232423936cd49dd35c76fca50822b1654e8a66";
