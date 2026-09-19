import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import iconv from "iconv-lite";
import {
  inspectWorkBackup,
  WorkZipError,
  workTitleFromBackupFileName,
} from "../../src/core/workZip";
import { parseCollectedFile } from "../../src/core/collectedFile";

/**
 * `.txt` 直のバックアップ（アルファポリス）の取り込みと、
 * **全サイト共通**の話番号の点検（作者の指示、2026-09-19。0.69.10）。
 *
 * **実物は使わない**（`workZip.test.ts` と同じ流儀）。形だけを写す。
 */

/** アルファポリスの書き出しと同じ形（Shift_JIS 版は CRLF で降りてくる） */
const ALPHAPOLIS = [
  "第一章『死の谷』",
  "１話　転生",
  "",
  "　化学の先生が、無駄話をしていた&#x2014;&#x2014;。",
  "",
  "２話　てこの原理と救助",
  "",
  "　棒を渡して、支点を作る。",
  "",
  "４話　筋肉と電気",
  "",
  "　筋肉は電気で動く。",
  "",
  "４話　筋肉と電気",
  "",
  "　筋肉は電気で動く。",
  "",
].join("\r\n");

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("アルファポリスの .txt を取り込む", () => {
  it("題はファイル名から採る（ファイルの中に作品情報が無い）", () => {
    const result = inspectWorkBackup(
      utf8(ALPHAPOLIS),
      "転生受験生の教科書チート生活.txt"
    );

    expect(result.title).toBe("転生受験生の教科書チート生活");
    expect(result.titleSource).toBe("zipName");
    expect(result.info).toBeNull();
  });

  it("重複ダウンロードの印（(2)）は題から落とす", () => {
    expect(
      workTitleFromBackupFileName("転生受験生の教科書チート生活 (2).txt")
    ).toBe("転生受験生の教科書チート生活");
    expect(workTitleFromBackupFileName("星を継ぐ者たち_20260919.zip")).toBe(
      "星を継ぐ者たち"
    );
  });

  it("作者が題に付けた全角の（2）は落とさない", () => {
    expect(workTitleFromBackupFileName("星を継ぐ者たち（2）.txt")).toBe(
      "星を継ぐ者たち（2）"
    );
  });

  it("出どころをアルファポリスと見分ける", () => {
    expect(inspectWorkBackup(utf8(ALPHAPOLIS), "作品.txt").site).toBe(
      "alphapolis"
    );
  });

  it("全話が1ファイルの合本として、既存の形で書き出す", () => {
    const result = inspectWorkBackup(utf8(ALPHAPOLIS), "作品.txt");

    expect(result.collected).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].name).toBe("作品.txt");

    const text = new TextDecoder().decode(result.files[0].bytes);
    expect(parseCollectedFile(text)?.map((episode) => episode.chapter)).toEqual([
      1, 2, 4,
    ]);
  });

  it("文字参照は1つも残さない", () => {
    const result = inspectWorkBackup(utf8(ALPHAPOLIS), "作品.txt");
    const text = new TextDecoder().decode(result.files[0].bytes);

    expect(text).toContain("無駄話をしていた——。");
    expect(/&#?[0-9A-Za-z]+;/.test(text)).toBe(false);
  });

  it("中身まで同じ重複は1つだけ取り込み、落としたことを覚えておく", () => {
    const result = inspectWorkBackup(utf8(ALPHAPOLIS), "作品.txt");

    expect(result.episodeCount).toBe(3);
    expect(result.dropped).toEqual(["４話　筋肉と電気"]);
    expect(result.episodeNumbers.duplicates[0]).toMatchObject({
      number: 4,
      sameBody: true,
    });
  });

  it("欠番も指摘する（3話が飛んでいる）", () => {
    expect(
      inspectWorkBackup(utf8(ALPHAPOLIS), "作品.txt").episodeNumbers.missing
    ).toEqual([3]);
  });

  it("改行が LF でも CRLF でも同じ結果になる（文字コードの2種類ぶん）", () => {
    const crlf = inspectWorkBackup(utf8(ALPHAPOLIS), "作品.txt");
    const lf = inspectWorkBackup(
      utf8(ALPHAPOLIS.replace(/\r\n/g, "\n")),
      "作品.txt"
    );

    expect(lf.episodeCount).toBe(crlf.episodeCount);
    expect(lf.dropped).toEqual(crlf.dropped);
    expect(lf.totalChars).toBe(crlf.totalChars);
    expect(new TextDecoder().decode(lf.files[0].bytes)).toBe(
      new TextDecoder().decode(crlf.files[0].bytes)
    );
  });

  it("アルファポリスの形でない .txt は断る（原稿を作品と取り違えない）", () => {
    expect(() =>
      inspectWorkBackup(utf8("　夜が更けていく。\n　少年は机に向かった。\n"), "原稿.txt")
    ).toThrowError(WorkZipError);
  });
});

describe("話番号の点検は、ZIPの道でも効く", () => {
  const episode = (title: string, body: string): Uint8Array =>
    utf8(["【タイトル】", title, "", "【本文】", body, ""].join("\n"));

  it("カクヨムの複数ファイルでも、欠番を指摘する", () => {
    const zip = zipSync({
      "episode_0001.txt": episode("第1話　転生前夜", "夜が更けていく。"),
      "episode_0004.txt": episode("第4話　再会", "再び会った。"),
    });

    const result = inspectWorkBackup(zip, "作品.zip");

    expect(result.episodeNumbers.missing).toEqual([2, 3]);
  });

  it("カクヨムの複数ファイルでも、重複を指摘する", () => {
    const zip = zipSync({
      "episode_0001.txt": episode("第1話　転生前夜", "夜が更けていく。"),
      "episode_0001b.txt": episode("第1話　転生前夜", "夜が更けていく。"),
    });

    const result = inspectWorkBackup(zip, "作品.zip");

    expect(result.episodeNumbers.duplicates[0]).toMatchObject({
      number: 1,
      count: 2,
      sameBody: true,
    });
  });

  /*
    **ZIPからは落とさない**（判断：2026-09-19）。落とす単位が「ファイル1つ」に
    なり、そこには本文以外（カクヨムの【公開日時】、なろうの【リアクション】）が
    付いている。本文が同じでも、落とせば作者の持っていたものが減る。
  */
  it("ZIPでは、中身が同じでもファイルを落とさない", () => {
    const zip = zipSync({
      "episode_0001.txt": episode("第1話　転生前夜", "夜が更けていく。"),
      "episode_0001b.txt": episode("第1話　転生前夜", "夜が更けていく。"),
    });

    const result = inspectWorkBackup(zip, "作品.zip");

    expect(result.dropped).toEqual([]);
    expect(result.files).toHaveLength(2);
  });
});

/**
 * Shift_JIS で読んだときの助言（作者の指示、2026-09-19。設計書6.99）。
 *
 * 実物で測った：同じ作品の Shift_JIS 版と UTF-8 版を突き合わせると、
 * 半角 `?` が **9個 対 2個**、全角の `？` は **両方とも2,906個**だった。
 * 差の7個は `①②③④⑤⑥` と `•` ——**Shift_JIS に無い文字だけが `?` に
 * なる。** 疑問符そのものは無事なので、「化けている」とは言い切らない。
 *
 * **サイトに紐づけない。** 見ているのは「Shift_JIS で読んだ」という事実
 * だけなので、ZIPの道（なろう・カクヨム）でも同じ助言が出る。
 */
describe("Shift_JIS で読んだことを伝える", () => {
  /** 半角の `?` を2つ混ぜた版（作者が自分で書いた `?` の見立て） */
  const WITH_QUESTIONS = ALPHAPOLIS.replace(
    "　棒を渡して、支点を作る。",
    "　棒を渡して、支点を作る? いや、作れる?"
  );

  it("Shift_JIS の .txt では、文字コードと半角 ? の件数を持つ", () => {
    const result = inspectWorkBackup(
      new Uint8Array(iconv.encode(WITH_QUESTIONS, "shift_jis")),
      "作品.txt"
    );

    expect(result.encodingNotice).toEqual({
      shiftJis: true,
      questionMarks: 2,
    });
  });

  it("UTF-8 の .txt では何も持たない（言うことが無い）", () => {
    const result = inspectWorkBackup(utf8(WITH_QUESTIONS), "作品.txt");

    expect(result.encodingNotice).toEqual({
      shiftJis: false,
      questionMarks: 0,
    });
  });

  it("ZIPの中に Shift_JIS のファイルがあれば、同じように持つ", () => {
    const zip = zipSync({
      "episode_0001.txt": new Uint8Array(
        iconv.encode(
          ["【タイトル】", "第1話　転生前夜", "", "【本文】", "　夜が更けていく? そう思った。", ""].join(
            "\n"
          ),
          "shift_jis"
        )
      ),
    });

    const result = inspectWorkBackup(zip, "作品.zip");

    expect(result.encodingNotice).toEqual({
      shiftJis: true,
      questionMarks: 1,
    });
  });

  it("UTF-8 だけのZIPでは何も持たない", () => {
    const zip = zipSync({
      "episode_0001.txt": utf8(
        ["【タイトル】", "第1話　転生前夜", "", "【本文】", "　夜が更けていく? そう思った。", ""].join(
          "\n"
        )
      ),
    });

    expect(inspectWorkBackup(zip, "作品.zip").encodingNotice).toEqual({
      shiftJis: false,
      questionMarks: 0,
    });
  });
});
