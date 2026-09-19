import type { Encoding } from "./textDecode";

/**
 * バックアップを Shift_JIS で読んだことを、作者へ伝える（設計書6.99）。
 *
 * 作者の指示（2026-09-19）：**「文字コードのメッセージは製品版でも出して
 * ください」**——これまで、UTF-8 版のほうが情報が多いことは開発側しか
 * 知らなかった。
 *
 * ## 何が起きているか（実物で測った）
 *
 * 同じ作品の Shift_JIS 版と UTF-8 版を突き合わせた。
 *
 * | | Shift_JIS 版 | UTF-8 版 |
 * |---|---|---|
 * | 半角 `?` | **9個** | 2個 |
 * | 全角 `？` | 2,906個 | 2,906個 |
 *
 * 差の7個が、**Shift_JIS に無いために `?` へ置き換わった文字**である
 * （`①②③④⑤⑥`＝U+2460〜2465 と `•`＝U+2022）。**全角の `？` は両版とも
 * 同数**——疑問符そのものは無事で、置き換わるのは Shift_JIS に無い文字だけ。
 *
 * ## 「化けている」と断定しない
 *
 * 半角の `?` は、作者が自分で書いていることもある（UTF-8 版にも2個あった）。
 * **危ないかもしれない、と言うに留める。** 件数を添えるのは、作者が中身を
 * 見て自分で判断できるようにするためである。
 *
 * ## サイトに紐づけない
 *
 * アルファポリス専用にしない。**見ているのは「Shift_JIS で読んだ」という
 * 事実だけ**なので、将来ほかのサイトが Shift_JIS で書き出しても、なろう・
 * カクヨムの ZIP に Shift_JIS のファイルが混じっても、同じ助言が出る。
 *
 * VS Code API には依存しない。
 */

export interface BackupEncodingReport {
  /** Shift_JIS として読んだファイルが1つでもあったか。false なら言うことは無い */
  readonly shiftJis: boolean;
  /**
   * **Shift_JIS で読んだ本文**にあった半角 `?` の数。
   *
   * UTF-8 のファイルは数えない——助言を出さない相手の件数を持っても、
   * 作者へ見せる先が無い。
   */
  readonly questionMarks: number;
}

/** 点検にかける1ファイル。復号したあとの本文を渡す */
export interface BackupEncodingEntry {
  readonly encoding: Encoding;
  /** 復号したあとの全文。**UTF-8 のファイルは空文字でよい**（数えないため） */
  readonly text: string;
}

/**
 * 読み込んだファイルを点検する。**判定は文字コードだけに紐づける。**
 */
export function checkBackupEncoding(
  files: readonly BackupEncodingEntry[]
): BackupEncodingReport {
  const shiftJis = files.filter((file) => file.encoding === "shift_jis");
  return {
    shiftJis: shiftJis.length > 0,
    questionMarks: shiftJis.reduce(
      (total, file) => total + countHalfWidthQuestionMarks(file.text),
      0
    ),
  };
}

/**
 * 半角の `?` を数える。
 *
 * **全角の `？` は数えない。** Shift_JIS にある文字なので置き換わらない
 * （実物でも両版で同数だった）。ここで一緒に数えると、3千件近い数字が
 * 出て、作者に見るべきものが無くなる。
 */
export function countHalfWidthQuestionMarks(text: string): number {
  let count = 0;
  for (const char of text) {
    if (char === "?") count++;
  }
  return count;
}

/**
 * 作者へ見せる文面にする。**UTF-8 なら1行も返さない**（言うことが無い）。
 *
 * @param when `before`＝取り込む前の確認、`after`＝取り込んだあとのお知らせ。
 *   **取りやめの案内は取り込む前だけ**にする——済んだあとで「取りやめる」と
 *   言われても、作者にはどうしようもない。
 */
export function describeBackupEncoding(
  report: BackupEncodingReport,
  when: "before" | "after"
): string[] {
  if (!report.shiftJis) return [];

  const lines = [
    "このバックアップは Shift_JIS という文字コードで書かれています。" +
      "Shift_JIS に無い文字（丸数字の ①、記号の • など）は、" +
      "書き出したときに半角の ? に置き換わっていることがあります。",
  ];

  if (report.questionMarks > 0) {
    lines.push(
      `本文に半角の ? が${report.questionMarks}個あります。` +
        // **断定しない。** 作者が自分で書いた `?` かもしれない
        "もともと ? と書かれていた箇所かもしれませんし、" +
        "置き換わったものが混ざっているかもしれません。"
    );
  }

  lines.push(
    when === "before"
      ? "投稿サイトから UTF-8 で書き出し直したものを取り込むと、" +
          "その文字はそのまま残ります。いったん取りやめて、" +
          "書き出し直してから取り込むこともできます。"
      : "次に取り込むときに、投稿サイトから UTF-8 で書き出したものを選ぶと、" +
          "その文字はそのまま残ります。"
  );

  return lines;
}
