/**
 * 確認の文と補足を、画面上部の選択窓の行へ並べ替える（作者の裁定 A4、
 * 2026-09-23。`views/notify.ts` の `confirmRunOrChoose` が使う）。
 *
 * **なぜ折り返しを自前でするか。** 選択窓の1行は折り返さず、はみ出た分は
 * 「…」で切れる。モーダルだった頃は長い補足（処理量・所要時間・送る量）を
 * 折り返して全部見せていた。窓を替えたせいで**読めない字が出ると、確認の
 * 意味が無くなる**ので、字を1つも落とさずに行へ割る。
 *
 * VS Code に依存しない純粋な部品にしてある（行の割り方だけをテストで確かめる）。
 */

/**
 * 1行に入れる字数の目安（全角で数える）。
 *
 * 選択窓の幅は VS Code の窓の大きさで変わり、拡張機能からは分からない。
 * ふつうの幅で全角が「…」にならずに収まる長さに寄せた。短めに切るぶんには
 * 行が増えるだけで、字は落ちない。
 */
export const CONFIRM_ROW_WIDTH = 40;

/**
 * 切ってよい字の直後。**ここで切ると文として読みやすい。** 行の末尾から
 * この範囲に見つからなければ、幅で機械的に切る。
 */
const BREAK_AFTER = new Set(["。", "、", "）", "」", "』", "！", "？", "／", " ", "　"]);

/** 句読点を探す範囲（行の末尾から何字さかのぼるか） */
const BREAK_LOOKBACK = 12;

/**
 * 1行を、幅に収まるよう割る。**字は落とさない**（割った行をつなげば元に戻る）。
 *
 * 字は `Array.from` で数える——サロゲートペア（𠮷など）を途中で割ると、
 * 行の頭と末尾に壊れた字が出る。
 */
export function wrapConfirmLine(
  line: string,
  width: number = CONFIRM_ROW_WIDTH
): string[] {
  const chars = Array.from(line);
  if (chars.length <= width) return [line];
  const rows: string[] = [];
  let start = 0;
  while (chars.length - start > width) {
    let end = start + width;
    for (let i = end; i > end - BREAK_LOOKBACK && i > start + 1; i--) {
      if (BREAK_AFTER.has(chars[i - 1])) {
        end = i;
        break;
      }
    }
    rows.push(chars.slice(start, end).join(""));
    start = end;
  }
  if (start < chars.length) rows.push(chars.slice(start).join(""));
  return rows;
}

export interface ConfirmLayout {
  /** 窓の題（文の1行目） */
  readonly title: string;
  /**
   * 題の下に並べる行。`null` は段落の区切り（補足の空行）。
   * 区切りは重ねず、頭と末尾にも置かない
   */
  readonly rows: ReadonlyArray<string | null>;
}

/**
 * 確認の文（`message`）と補足（`detail`）を、題と行に分ける。
 *
 * - 題は文の1行目。長すぎれば、はみ出た分を行の頭へ送る
 * - 文の残りの行、空行（区切り）、補足の行の順に並べる
 */
export function layoutConfirm(
  message: string,
  detail?: string,
  width: number = CONFIRM_ROW_WIDTH
): ConfirmLayout {
  const messageLines = message.split("\n");
  const firstIndex = messageLines.findIndex((line) => line.trim() !== "");
  const first = firstIndex >= 0 ? messageLines[firstIndex] : "";
  const [title = "", ...titleOverflow] = wrapConfirmLine(first, width);

  const source: Array<string | null> = [...titleOverflow];
  const rest = firstIndex >= 0 ? messageLines.slice(firstIndex + 1) : [];
  for (const line of rest) source.push(line.trim() === "" ? null : line);
  if (detail !== undefined && detail.trim() !== "") {
    source.push(null);
    for (const line of detail.split("\n")) {
      source.push(line.trim() === "" ? null : line);
    }
  }

  const rows: Array<string | null> = [];
  for (const entry of source) {
    if (entry === null) {
      // 区切りは重ねない。頭にも置かない
      if (rows.length > 0 && rows[rows.length - 1] !== null) rows.push(null);
      continue;
    }
    rows.push(...wrapConfirmLine(entry, width));
  }
  // 末尾の区切りは落とす
  while (rows.length > 0 && rows[rows.length - 1] === null) rows.pop();
  return { title, rows };
}
