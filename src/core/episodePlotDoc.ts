/**
 * 単話プロット（設計書6.36.2）を読み取る。
 *
 * 雛形（`resumeSheet.ts` の `buildEpisodePlotTemplate`）は3節――視点・
 * この話の目標・展開（箇条書き）――だが、**作者は見出しを言い換える。**
 * 「## 語り手の視点」と書かれた節を読み落として空を送ると、AIは材料の
 * 無いまま「緩んでいそうなところ」を作り出す（矛盾検知で実際に起きた形）。
 * そこで見出しは**言葉が含まれるか**で見分ける。
 *
 * **推測で埋めない。** 見出しが1つも無ければ、何も読み取らずに返す
 * ――全文を展開とみなすと、作者のメモ書きが箇条書きとしてAIへ渡る。
 *
 * VS Code APIに依存しない（画面もファイルも触らない純粋な読み取り）。
 */

import * as path from "./paths";
import {
  EPISODE_PLOTS_DIR,
  episodePlotChapterFromFileName,
} from "./resumeSheet";

/** 箇条書きの1行。行番号は指摘から飛ぶために持つ（1始まり） */
export interface EpisodePlotItem {
  text: string;
  line: number;
}

export interface EpisodePlotDoc {
  /** この話の視点。書かれていなければ空 */
  viewpoint: string;
  /** この話の目標。書かれていなければ空 */
  goal: string;
  /** 展開の箇条書き。書かれていなければ空配列 */
  items: EpisodePlotItem[];
  /**
   * まだ書かれていない節の名前。
   *
   * **「無い」ことを黙らない。** 目標が空のまま P-27 を掛けると、
   * 「目標に向かっているか」という問い自体が成り立たない。
   */
  blanks: string[];
}

/** 節の名前。画面の断り書きにもそのまま出す（言い方を2か所に持たない） */
export const EPISODE_PLOT_SECTION_LABELS = [
  "視点",
  "この話の目標",
  "展開（箇条書き）",
] as const;

/**
 * 見出しの見分け方。
 *
 * **雛形の見出しと完全一致では見ない。** 作者が「## 語り手の視点」と
 * 書き換えても読めるようにする。順に当てるので、先に当たったものが勝つ。
 */
const SECTION_MARKS: ReadonlyArray<{
  key: "viewpoint" | "goal" | "items";
  mark: RegExp;
}> = [
  { key: "viewpoint", mark: /視点|語り手/ },
  { key: "goal", mark: /目標|狙い|目的/ },
  { key: "items", mark: /展開|流れ|できごと|出来事/ },
];

/**
 * 中身の無い行か。
 *
 * 雛形は空欄を「（この話は誰の視点で語りますか）」という問いかけで置いて
 * いる。**問いかけをそのままAIへ渡さない**――渡すと、AIはその問いを
 * 視点の中身として読む（指示の言葉が答えとして返る、と同じ形）。
 */
function isBlankLine(line: string): boolean {
  const body = line.trim();
  if (!body) return true;
  // 箇条書きの印だけの行（雛形の「- 」）
  if (/^([-*+・]|\d+[.)])\s*$/.test(body)) return true;
  // 丸ごと括弧書きの問いかけ・注釈
  if (/^[（(].*[）)]$/.test(body)) return true;
  if (/^<!--[\s\S]*-->$/.test(body)) return true;
  return false;
}

/** 箇条書きの印を落とす。印が無い行はそのまま中身として扱う */
function stripBullet(line: string): string {
  return line.trim().replace(/^([-*+・]|\d+[.)])\s*/, "").trim();
}

export function parseEpisodePlot(text: string): EpisodePlotDoc {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");

  const viewpoint: string[] = [];
  const goal: string[] = [];
  const items: EpisodePlotItem[] = [];
  let current: "viewpoint" | "goal" | "items" | null = null;

  lines.forEach((line, index) => {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const name = heading[1];
      current =
        SECTION_MARKS.find((section) => section.mark.test(name))?.key ?? null;
      return;
    }
    if (current === null || isBlankLine(line)) return;

    if (current === "items") {
      // **印が無くても拾う。** 「-」を付けずに書く作者がいる。印の有無で
      // 落とすと、書いてあるのに「まだありません」と言うことになる
      items.push({ text: stripBullet(line), line: index + 1 });
      return;
    }
    (current === "viewpoint" ? viewpoint : goal).push(line.trim());
  });

  const blanks: string[] = [];
  if (viewpoint.length === 0) blanks.push(EPISODE_PLOT_SECTION_LABELS[0]);
  if (goal.length === 0) blanks.push(EPISODE_PLOT_SECTION_LABELS[1]);
  if (items.length === 0) blanks.push(EPISODE_PLOT_SECTION_LABELS[2]);

  return {
    viewpoint: viewpoint.join("\n"),
    goal: goal.join("\n"),
    items,
    blanks,
  };
}

/**
 * AIを掛けられる中身があるか。
 *
 * **展開の箇条書きだけを条件にする。** 視点と目標は判断を助ける材料だが、
 * 無くても「停滞・重複」は見られる。逆に箇条書きが空なら、P-27 も P-28 も
 * 照らす相手が無い（プロットが無いまま逸脱検知を掛けさせないのと同じ）。
 */
export function isEpisodePlotWritten(doc: EpisodePlotDoc): boolean {
  return doc.items.length > 0;
}

/**
 * そのファイルが単話プロットなら、その話数（設計書6.36.3）。
 *
 * **置き場まで見る。** 名前だけで決めると、本文の「第3話.md」を単話
 * プロットとして扱ってしまう。区切りはWindowsで `\`、ブラウザ上の作品で
 * `/` と変わるので、突き合わせは `paths` に任せる。
 */
export function episodePlotChapterOfPath(filePath: string): number | null {
  if (path.basename(path.dirname(filePath)) !== EPISODE_PLOTS_DIR) return null;
  return episodePlotChapterFromFileName(path.basename(filePath));
}
