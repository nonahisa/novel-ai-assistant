import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import {
  inspectWorkZip,
  isUnsafeZipEntryName,
  sanitizeWorkFolderName,
  WorkZipError,
  workTitleFromZipFileName,
} from "../../../src/core/workZip";
import { parseTagList, parseWorkInfo } from "../../../src/core/workInfoParse";
import {
  plotDraftFromWorkInfo,
  synopsisDraftFromWorkInfo,
} from "../../../src/core/workInfoDraft";
import { emptyPlotSections } from "../../../src/core/plotDoc";
import { isWorkInfoFile } from "../../../src/core/workInfoFile";

/**
 * ZIPから作品を取り込む（設計書6.98）の、読み取りと下書きの決め方。
 *
 * **実物のZIPは使わない。** 作者の手元のバックアップを試験が読むと、
 * 手元にしか無いファイルに試験がぶら下がる。中身は `fflate` でその場で
 * 固めて、**製品と同じ `unzipSync` で開かせる。**
 */

/** カクヨムのバックアップの `about.txt` と同じ形 */
const ABOUT_TEXT = [
  "【タイトル】",
  "星を継ぐ者たち",
  "",
  "【作者名】",
  "hisa（@project_hisa）",
  "",
  "【ジャンル】",
  "異世界ファンタジー",
  "",
  "【キャッチコピー】",
  "教科書の力を見直してみませんか？",
  "",
  "【紹介文（9行）】",
  "　受験生の少年が、いきなり異世界に転生した。",
  "",
  "　これは、そんな少年を見守る人々の記録。",
  "",
  "【タグ】",
  "- 異世界転生",
  "- チート",
  "- 内政",
  "",
  "【目次】",
  "1. 第1話　転生前夜",
  "",
].join("\n");

const EPISODE_TEXT = [
  "【タイトル】",
  "第1話　転生前夜",
  "",
  "【本文（3行）】",
  "夜が更けていく。",
  "少年は机に向かっていた。",
  "",
].join("\n");

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function zipOf(entries: Record<string, Uint8Array>): Uint8Array {
  return zipSync(entries);
}

/** ふつうのカクヨム形式のZIP */
function backupZip(): Uint8Array {
  return zipOf({
    "about.txt": utf8(ABOUT_TEXT),
    "episode_0001.txt": utf8(EPISODE_TEXT),
    "episode_0002.txt": utf8(EPISODE_TEXT),
  });
}

describe("ZIPの中の名前を信じない", () => {
  it("`..` を含む名前を危ないと見なす", () => {
    expect(isUnsafeZipEntryName("../外へ.txt")).toBe(true);
    expect(isUnsafeZipEntryName("話/../../外へ.txt")).toBe(true);
  });

  it("区切りが `\\` でも `..` を見落とさない", () => {
    expect(isUnsafeZipEntryName("..\\外へ.txt")).toBe(true);
  });

  it("絶対パスを危ないと見なす", () => {
    expect(isUnsafeZipEntryName("/etc/passwd")).toBe(true);
    expect(isUnsafeZipEntryName("C:/Windows/system32/a.txt")).toBe(true);
  });

  it("制御文字を含む名前を危ないと見なす", () => {
    // **生の制御文字は書かない**（`sourceHygiene.test.ts`）のでエスケープで置く
    expect(isUnsafeZipEntryName("a\u0000b.txt")).toBe(true);
  });

  it("ふつうの原稿の名前は通す", () => {
    expect(isUnsafeZipEntryName("episode_0001.txt")).toBe(false);
    expect(isUnsafeZipEntryName("第1章/第1話　転生前夜.md")).toBe(false);
  });

  it("危ない名前が1つでもあれば、1件も取り込まずに止める", () => {
    const zip = zipOf({
      "episode_0001.txt": utf8(EPISODE_TEXT),
      "../外へ.txt": utf8("よそへ書きます"),
    });

    expect(() => inspectWorkZip(zip, "作品_20260919.zip")).toThrowError(
      WorkZipError
    );
  });
});

describe("小説に見えないZIPは断る", () => {
  it(".txt も .md も無ければ断る", () => {
    const zip = zipOf({ "表紙.png": new Uint8Array([1, 2, 3]) });

    expect(() => inspectWorkZip(zip, "作品.zip")).toThrowError(
      /原稿（\.txt \/ \.md）が入っていません/
    );
  });

  it("ZIPとして読めなければ断る", () => {
    expect(() =>
      inspectWorkZip(new Uint8Array([0, 1, 2, 3]), "壊れた.zip")
    ).toThrowError(WorkZipError);
  });

  it("原稿ではないファイルは、入れずに件数だけ数える", () => {
    const zip = zipOf({
      "episode_0001.txt": utf8(EPISODE_TEXT),
      "表紙.png": new Uint8Array([1, 2, 3]),
    });

    const result = inspectWorkZip(zip, "作品.zip");

    expect(result.files.map((file) => file.name)).toEqual([
      "episode_0001.txt",
    ]);
    expect(result.skipped).toEqual(["表紙.png"]);
  });
});

/**
 * なろうの合本の話数（0.70.1）。
 *
 * **作者の実物2つで、題の付け方が割れていた**（2026-09-19）。
 * `N2600GO` は「１話　転生」で219話すべて読めるが、`N4190FX` は
 * 「１　自殺の後始末」で**1つも読めない**——同じなろうの、同じ形式の
 * バックアップである。読めないほうを取り込むと、毎回「話数を
 * 読み取れなかった話が4件あります」と出ていた。
 */
describe("なろうの合本は、題に「話」が無くても話数が分かる", () => {
  /** 題に「話」を伴わないなろうの合本（実物の `N4190FX` と同じ形） */
  const NAROU_BACKUP = [
    "【Nコード】",
    "N4190FX",
    "",
    "【タイトル】",
    "肉片とラジオと心霊現象",
    "",
    "------------------------- エピソード1開始 -------------------------",
    "【エピソードタイトル】",
    "１　自殺の後始末",
    "",
    "【本文】",
    "　あれは、確か中学３年生の頃。",
    "",
    "------------------------- エピソード2開始 -------------------------",
    "【エピソードタイトル】",
    "２　供養と軋轢",
    "",
    "【本文】",
    "　線香の煙が、まっすぐに立った。",
    "",
    "【免責事項】",
    "本作品の著作権は作者に帰属します。",
    "",
  ].join("\n");

  it("区切り行の番号で埋めるので、読み取れない話が出ない", () => {
    const zip = zipOf({ "N4190FX.txt": utf8(NAROU_BACKUP) });

    const result = inspectWorkZip(zip, "N4190FX.zip");

    expect(result.episodeNumbers.unnumbered).toBe(0);
    expect(result.episodeNumbers.missing).toEqual([]);
    expect(result.episodeNumbers.duplicates).toEqual([]);
  });

  it("題から読めるときは、そちらを使う（「１話　転生」）", () => {
    const withKanji = NAROU_BACKUP.replace("１　自殺の後始末", "１話　自殺の後始末");
    const zip = zipOf({ "N4190FX.txt": utf8(withKanji) });

    const result = inspectWorkZip(zip, "N4190FX.zip");

    expect(result.episodeNumbers.unnumbered).toBe(0);
    expect(result.episodeNumbers.missing).toEqual([]);
  });
});

describe("作品名の採り方", () => {
  it("about.txt のタイトルから採る", () => {
    const result = inspectWorkZip(backupZip(), "作品_20260919.zip");

    expect(result.title).toBe("星を継ぐ者たち");
    expect(result.titleSource).toBe("about");
  });

  it("about.txt が無ければ、ZIPの名前から採る", () => {
    const zip = zipOf({ "episode_0001.txt": utf8(EPISODE_TEXT) });

    const result = inspectWorkZip(zip, "夜明けの手紙_20260919.zip");

    expect(result.title).toBe("夜明けの手紙");
    expect(result.titleSource).toBe("zipName");
  });

  it("ZIPの名前の末尾に付く日付を落とす", () => {
    expect(workTitleFromZipFileName("転生した受験生_20260919.zip")).toBe(
      "転生した受験生"
    );
    // 日付でない数字は落とさない（`西暦2525年` のような題を削らない）
    expect(workTitleFromZipFileName("西暦2525年.zip")).toBe("西暦2525年");
  });

  it("フォルダ名に使えない文字は落とす", () => {
    expect(sanitizeWorkFolderName('星: 第*1部?')).toBe("星 第1部");
  });

  it("名前が空になってしまうZIPでも、名前を返す", () => {
    expect(workTitleFromZipFileName("***.zip")).toBe("取り込んだ作品");
  });
});

describe("文字コードの見分け", () => {
  it("Shift_JISの原稿をUTF-8に直して取り込む", () => {
    // 「あい」の Shift_JIS。Nodeに Shift_JIS の書き出しが無いので手で置く
    const sjis = new Uint8Array([0x82, 0xa0, 0x82, 0xa2]);
    const zip = zipOf({ "episode_0001.txt": sjis });

    const result = inspectWorkZip(zip, "作品.zip");
    const file = result.files[0];

    expect(file.encoding).toBe("shift_jis");
    expect(new TextDecoder("utf-8").decode(file.bytes)).toBe("あい");
  });

  it("UTF-8の原稿は1バイトも書き換えない", () => {
    const original = utf8(EPISODE_TEXT);
    const zip = zipOf({ "episode_0001.txt": original });

    const file = inspectWorkZip(zip, "作品.zip").files[0];

    expect(file.encoding).toBe("utf8");
    expect([...file.bytes]).toEqual([...original]);
  });

  it("CRLFの原稿は、CRLFのまま取り込む", () => {
    // Shift_JIS の「あ」＋CRLF＋「い」。**書き直すのは文字コードだけ**
    const sjis = new Uint8Array([0x82, 0xa0, 0x0d, 0x0a, 0x82, 0xa2]);
    const zip = zipOf({ "episode_0001.txt": sjis });

    const file = inspectWorkZip(zip, "作品.zip").files[0];

    expect(new TextDecoder("utf-8").decode(file.bytes)).toBe("あ\r\nい");
  });
});

describe("数え方", () => {
  it("about.txt は話として数えず、字数にも入れない", () => {
    const result = inspectWorkZip(backupZip(), "作品.zip");

    expect(result.files).toHaveLength(3);
    expect(result.episodeCount).toBe(2);

    const about = result.files.find((file) => file.isWorkInfo);
    expect(about?.name).toBe("about.txt");
    expect(about?.charCount).toBe(0);
  });

  it("頭書きを除いた本文だけを数える", () => {
    const zip = zipOf({ "episode_0001.txt": utf8(EPISODE_TEXT) });

    // 「夜が更けていく。」8字 ＋「少年は机に向かっていた。」12字
    expect(inspectWorkZip(zip, "作品.zip").totalChars).toBe(20);
  });

  it("共通の入れ物フォルダーは剥がす", () => {
    const zip = zipOf({
      "星を継ぐ者たち/about.txt": utf8(ABOUT_TEXT),
      "星を継ぐ者たち/episode_0001.txt": utf8(EPISODE_TEXT),
    });

    const result = inspectWorkZip(zip, "作品.zip");

    expect(result.files.map((file) => file.name)).toEqual([
      "about.txt",
      "episode_0001.txt",
    ]);
  });

  it("入れ物が分かれているときは剥がさない", () => {
    const zip = zipOf({
      "第1章/001.txt": utf8(EPISODE_TEXT),
      "第2章/002.txt": utf8(EPISODE_TEXT),
    });

    const result = inspectWorkZip(zip, "作品.zip");

    expect(result.files.map((file) => file.name)).toEqual([
      "第1章/001.txt",
      "第2章/002.txt",
    ]);
  });
});

describe("about.txt の解析", () => {
  it("キャッチコピー・紹介文・ジャンル・タグを読み取る", () => {
    const info = parseWorkInfo(ABOUT_TEXT);

    expect(info.title).toBe("星を継ぐ者たち");
    expect(info.author).toBe("hisa（@project_hisa）");
    expect(info.genre).toBe("異世界ファンタジー");
    expect(info.catchphrase).toBe("教科書の力を見直してみませんか？");
    expect(info.blurb).toContain("受験生の少年が");
    expect(info.blurb).toContain("見守る人々の記録");
    expect(info.tags).toEqual(["異世界転生", "チート", "内政"]);
  });

  it("括弧つきの見出し（紹介文（9行））も読める", () => {
    const info = parseWorkInfo("【紹介文（9行）】\n本文です。\n");

    expect(info.blurb).toBe("本文です。");
  });

  it("紹介文が無ければ、あらすじを採る", () => {
    const info = parseWorkInfo("【あらすじ】\nこういう話です。\n");

    expect(info.blurb).toBe("こういう話です。");
  });

  it("書かれていない欄は null にする（空文字と区別する）", () => {
    const info = parseWorkInfo("【タイトル】\n題だけ\n");

    expect(info.catchphrase).toBeNull();
    expect(info.blurb).toBeNull();
    expect(info.tags).toEqual([]);
  });

  it("題の中の全角空白を、半角に変えない", () => {
    // 実物のバックアップで半角へ変わっていた（2026-09-19）。
    // 作者が題に入れた空白は、題の一部である
    const info = parseWorkInfo(
      "【タイトル】\n異世界成り上がり　～別視点バージョン～\n"
    );

    expect(info.title).toBe("異世界成り上がり　～別視点バージョン～");
  });

  it("行の途中の【】は見出しにしない", () => {
    const info = parseWorkInfo(
      "【紹介文】\n看板には【立入禁止】と書かれていた。\n"
    );

    expect(info.blurb).toBe("看板には【立入禁止】と書かれていた。");
  });

  it("箇条書きでないタグは、空白で区切って読む", () => {
    expect(parseTagList("異世界転生 チート 内政")).toEqual([
      "異世界転生",
      "チート",
      "内政",
    ]);
  });

  it("同じタグが2度書いてあれば、1つにする", () => {
    expect(parseTagList("- チート\n- チート")).toEqual(["チート"]);
  });

  it("見分け（workInfoFile）と読み取りが噛み合っている", () => {
    expect(isWorkInfoFile("about.txt", ABOUT_TEXT)).toBe(true);
    expect(isWorkInfoFile("episode_0001.txt", EPISODE_TEXT)).toBe(false);
  });
});

describe("下書きは、空の欄にだけ置く", () => {
  const info = parseWorkInfo(ABOUT_TEXT);

  it("空のプロットには、ジャンルとモチーフを置く", () => {
    const draft = plotDraftFromWorkInfo(info, emptyPlotSections());

    expect(draft.labels).toEqual(["ジャンル", "モチーフ"]);
    expect(draft.updates.genre).toBe("- 異世界ファンタジー");
    expect(draft.updates.motif).toBe("- 異世界転生\n- チート\n- 内政");
  });

  it("すでに書かれている節には触れない", () => {
    const current = emptyPlotSections();
    current.genre = "- ハイファンタジー（小説家になろう）";

    const draft = plotDraftFromWorkInfo(info, current);

    expect(draft.labels).toEqual(["モチーフ"]);
    expect(draft.updates.genre).toBeUndefined();
  });

  it("雛形が置いた空欄は「まだ書かれていない」と読む", () => {
    const current = emptyPlotSections();
    current.genre = "<!-- 投稿先ごとに体系が違う -->\n- ";

    const draft = plotDraftFromWorkInfo(info, current);

    expect(draft.labels).toContain("ジャンル");
  });

  it("タグもジャンルも無ければ、何も置かない", () => {
    const empty = parseWorkInfo("【タイトル】\n題だけ\n");

    expect(plotDraftFromWorkInfo(empty, emptyPlotSections()).labels).toEqual([]);
  });

  it("紹介文の文書がまだ無ければ、キャッチコピーと紹介文を置く", () => {
    const draft = synopsisDraftFromWorkInfo(info, null);

    expect(draft?.labels).toEqual(["キャッチコピー", "紹介文"]);
    expect(draft?.doc.catchphrase).toBe("教科書の力を見直してみませんか？");
  });

  it("紹介文の文書がすでにあれば、何も返さない", () => {
    const draft = synopsisDraftFromWorkInfo(info, {
      catchphrase: null,
      blurb: "",
    });

    expect(draft).toBeNull();
  });

  it("about.txt に書くものが無ければ、何も返さない", () => {
    const empty = parseWorkInfo("【タイトル】\n題だけ\n");

    expect(synopsisDraftFromWorkInfo(empty, null)).toBeNull();
  });
});
