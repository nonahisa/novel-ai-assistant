/**
 * 原稿の画面で選べる書体（設計書6.25）。
 *
 * 作者の依頼（2026-08-27）：「フォントの変更を可能にしてください」。
 *
 * ## 設定はあったが、変えられなかった
 *
 * `novelai.manuscriptEditor.fontFamily` は 0.19.0 からある。だが
 *
 * - **設定ファイルへCSSの書式で手打ちする**必要があった
 *   （`"Noto Serif JP", serif` のような形）。プログラマでない作者に、
 *   これは「変えられる」とは言えない
 * - **変えても、開き直すまで効かなかった**
 *
 * 「できる」と「できると分かる」は別である（6.5.7で同じ失敗をしている）。
 *
 * ## 選べるものを、こちらで並べる
 *
 * 端末に入っている書体を全部並べても選べない（数百ある）。**小説の本文に
 * 使うものだけ**を並べる。明朝を先に置くのは、縦書きの本文が明朝で読まれる
 * ためである。
 *
 * ## 入っているかは、画面の側で測る
 *
 * どの書体が入っているかは端末ごとに違う。**入っていないものを選ばせない**
 * ために、画面（webview）で幅を測って確かめる（`probe` を使う）。
 * ここは一覧だけを持ち、測るのは画面、選ばせるのは機能の側にする。
 */

export interface ManuscriptFont {
  /** 設定に書き込む値。CSSの font-family。空文字は「既定にまかせる」 */
  value: string;
  /** 画面に出す名前 */
  label: string;
  /** どんな書体か（明朝・ゴシック・等幅） */
  kind: "明朝" | "ゴシック" | "等幅" | "既定";
  /**
   * 入っているかを測るときの書体名。
   *
   * **並びの先頭1つだけを見る。** 後ろは同じ書体の別名や、入っていないときの
   * 逃げ先なので、そこまで測ると「入っている」が緩くなりすぎる。
   * 既定と等幅は端末の書体に頼るので測らない（`undefined`）。
   */
  probe?: string;
}

/**
 * 選べる書体。**明朝を先に置く。**
 *
 * 値（CSSの並び）は、同じ書体の別名を並べてから逃げ先で閉じる。
 * 例：游明朝は Windows で `Yu Mincho`、macOS で `YuMincho` と名乗る。
 */
export const MANUSCRIPT_FONTS: readonly ManuscriptFont[] = [
  {
    value: "",
    label: "既定（明朝を自動で選ぶ）",
    kind: "既定",
  },
  {
    value: '"Yu Mincho", "YuMincho", serif',
    label: "游明朝",
    kind: "明朝",
    probe: "Yu Mincho",
  },
  {
    value: '"Hiragino Mincho ProN", "Hiragino Mincho Pro", serif',
    label: "ヒラギノ明朝",
    kind: "明朝",
    probe: "Hiragino Mincho ProN",
  },
  {
    value: '"MS Mincho", "ＭＳ 明朝", serif',
    label: "ＭＳ 明朝",
    kind: "明朝",
    probe: "MS Mincho",
  },
  {
    value: '"Noto Serif JP", serif',
    label: "Noto Serif JP",
    kind: "明朝",
    probe: "Noto Serif JP",
  },
  {
    value: '"BIZ UDMincho", "BIZ UDPMincho", serif',
    label: "BIZ UD明朝",
    kind: "明朝",
    probe: "BIZ UDMincho",
  },
  {
    value: '"Yu Gothic", "YuGothic", sans-serif',
    label: "游ゴシック",
    kind: "ゴシック",
    probe: "Yu Gothic",
  },
  {
    value: '"Meiryo", sans-serif',
    label: "メイリオ",
    kind: "ゴシック",
    probe: "Meiryo",
  },
  {
    value: '"Hiragino Sans", "Hiragino Kaku Gothic ProN", sans-serif',
    label: "ヒラギノ角ゴシック",
    kind: "ゴシック",
    probe: "Hiragino Sans",
  },
  {
    value: '"BIZ UDGothic", "BIZ UDPGothic", sans-serif',
    label: "BIZ UDゴシック",
    kind: "ゴシック",
    probe: "BIZ UDGothic",
  },
  {
    value: '"Noto Sans JP", sans-serif',
    label: "Noto Sans JP",
    kind: "ゴシック",
    probe: "Noto Sans JP",
  },
  {
    value: "var(--vscode-editor-font-family)",
    label: "VS Codeの編集用フォント",
    kind: "等幅",
  },
];

/** 測らなくてよい書体か（端末の書体に頼るもの） */
export function alwaysAvailable(font: ManuscriptFont): boolean {
  return font.probe === undefined;
}

/**
 * いま選ばれている書体を、一覧の中から見つける。
 *
 * 一覧に無い値（作者が設定へ手で書いたもの）は `undefined`。
 * **そのときも設定は尊重する**——選び直すまで、書いた値がそのまま効く。
 */
export function findFont(value: string): ManuscriptFont | undefined {
  const wanted = normalize(value);
  return MANUSCRIPT_FONTS.find((font) => normalize(font.value) === wanted);
}

/** いまの設定を、画面に出す一言にする */
export function describeCurrentFont(value: string): string {
  const found = findFont(value);
  if (found) return found.label;
  return value.trim() === "" ? "既定（明朝を自動で選ぶ）" : `設定した書体（${value.trim()}）`;
}

/**
 * 選ばせる並びを作る。
 *
 * @param available 画面が測った「入っている書体」の \`probe\` の集まり。
 *   **測れなかったときは undefined を渡す**（全部並べる。測れないことを
 *   「入っていない」と読み替えると、選べるものが消える）
 */
export function listChoices(
  current: string,
  available?: ReadonlySet<string>
): Array<ManuscriptFont & { installed: boolean; selected: boolean }> {
  const currentFont = findFont(current);
  return MANUSCRIPT_FONTS.map((font) => ({
    ...font,
    installed:
      alwaysAvailable(font) ||
      available === undefined ||
      available.has(font.probe ?? ""),
    selected: currentFont !== undefined && currentFont.value === font.value,
  }));
}

function normalize(value: string): string {
  // 引用符と空白の違いで別物にしない（設定へ手で書いた値と見比べるため）
  return value.replace(/["']/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}
