/**
 * 縦書きで立てる半角数字の run を決める規則（原稿エディタの「組んで書く」面）。
 *
 * 縦書きは `text-orientation: mixed` で組んでいるので、半角の英数字は
 * **まとまりごと横に寝る**。「3月5日」の 3 や 5 が寝ると、日本語の行の中に
 * 横向きの字が点々と混ざって読みにくい。1〜2文字なら `text-combine-upright`
 * で1文字ぶんの幅へ立てられる（作者の依頼、2026-09-12
 * 「半角数字1、2文字は縦書き時縦中横にしてほしい。3文字以降は現行通り」）。
 *
 * **EPUB（`epubXhtml.ts` の `applyTateChuYoko`）とは別の決まりである。**
 * あちらは「!」「?」も立て、型番も外さない（設計書6.65.15）。本にするときの
 * 組み方と、画面で書いているときの見え方は別の面の話なので、揃えない。
 *
 * VS Code APIに依存しない。**規則の定義はこのファイルだけに置く**——
 * 画面（webview）側へは `TCY_RUN_PATTERN` の文字列がそのまま埋め込まれる
 * （`manuscriptEditorHtml.ts`）。写しを置くと、片方だけが直る日が必ず来る。
 */

/**
 * 立てる run の見つけ方。
 *
 * - `[0-9]{1,2}` … 半角数字が1〜2文字。**3文字以上は立てない**（1文字ぶんの
 *   幅に収まらず、かえって読みにくい）。前後を数字で挟まれた run は
 *   前後の言明で落ちるので、「123」からは1件も出ない
 * - `(?<![0-9A-Za-z])` / `(?![0-9A-Za-z])` … 直前・直後が ASCII の英字なら
 *   立てない。「F5」のような型番の数字だけが立つと、かえって読めない
 * - `(?<![A-Za-z][-_])` / `(?![-_][A-Za-z])` … 英字とハイフンで繋いだ型番
 *   （「A-13」「B_7」）も同じ理由で外す。ハイフンを挟んでも型番は型番である
 *
 * 後読み（`(?<=`）は VS Code の webview（Chromium）でも Node でも使える。
 */
export const TCY_RUN_PATTERN =
  "(?<![0-9A-Za-z])(?<![A-Za-z][-_])[0-9]{1,2}(?![0-9A-Za-z])(?![-_][A-Za-z])";

/** 立てる run の位置（`start` 以上 `end` 未満） */
export interface TcyRun {
  start: number;
  end: number;
}

/**
 * 1行（あるいは任意の文字列）から、縦中横にする run の位置を拾う。
 *
 * **ルビ記法の中も、ほかの平文と同じに扱う**（`{漢字|かんじ}` の読みの側を
 * 特別扱いしない）。表記ゆれ検知の既存の規則（`notationVariants.ts` の
 * `findOccurrences`）も記法を剥がさずに数えており、そちらに揃えてある。
 * 組んで書く面では、ルビ・傍点は部品として先に切り分けられてから
 * この関数へ来るので、記法の記号そのものが run に混ざることもない。
 */
export function tcyRuns(text: string): TcyRun[] {
  const runs: TcyRun[] = [];
  if (!text) return runs;

  const pattern = new RegExp(TCY_RUN_PATTERN, "g");
  for (;;) {
    const match = pattern.exec(text);
    if (match === null) break;
    runs.push({ start: match.index, end: match.index + match[0].length });
  }
  return runs;
}
