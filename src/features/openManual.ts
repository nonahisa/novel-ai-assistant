import { ACTION_TREE, visibleEntries, type ActionItem } from "../views/actionList";
import { STEP_MENU, STEP_REFERENCED_COMMANDS } from "../views/stepMenu";
import { canRunProcesses } from "../core/runtime";
import { EXTRA_GUIDE } from "./featureGuide";
import { openGeneratedMarkdown } from "../views/openDocument";

/**
 * 使い方のマニュアルを、その場で組み立てて開く。
 *
 * 作者は**プログラマではない**。操作は120個以上あり、メニューを開いて
 * ホバーで説明を1つずつ読むしかなかった。「できることを増やしておいて」
 * という要望（2026-08-28）に対して、**まず何ができるのかを一望できる紙**を
 * 用意する。
 *
 * ## 説明文を手で書かない
 *
 * 中身は `ACTION_TREE`（詳細メニュー）・`STEP_MENU`（作品づくりの流れ）・
 * `EXTRA_GUIDE`（画面と考え方）から作る。**AIへ渡している説明と同じ出どころ**
 * である（`featureGuide.ts`）。手書きのマニュアルを別に持つと、機能を足した
 * ときに必ず食い違い、しかも食い違ったことに誰も気づけない。
 *
 * ## 置き場は拡張機能の保管庫
 *
 * 実ファイルとして置く（`openGeneratedMarkdown`、設計書6.17.7）が、
 * **作品フォルダーへは書き出さない**。書き出すと、古いマニュアルが
 * GitHubへ同期されて残る。いつでも作り直せるものを、作者の作品と
 * 一緒に持ち歩かせない。作品に属さないので、渡す作品も無い。
 */

/** 画面に出すときの名前。タブの見出しにもなる */
export const MANUAL_TITLE = "使い方";

export async function openManual(): Promise<void> {
  await openGeneratedMarkdown(MANUAL_TITLE, buildUserManual());
}

/**
 * マニュアルの本文を組み立てる。
 *
 * VS Code の画面には触れないので、ここだけ単体テストできる。
 */
export function buildUserManual(): string {
  // **画面に無い操作を載せない。** 環境によって出さない操作があるので、
  // メニューと同じ規則で絞る（AIへ渡す一覧と同じ扱い）
  const allowsProcesses = canRunProcesses();

  return [
    manualHeader(),
    stepChapter(),
    actionChapter(allowsProcesses),
    guideChapter(),
  ].join("\n\n");
}

function manualHeader(): string {
  return [
    `# ${MANUAL_TITLE}`,
    "",
    "この拡張機能でできることを、いま入っている版から書き出したものです。",
    "この文書は拡張機能の保管庫に置いてあり、GitHubへは同期しません。",
    "古いものは自動で消えるので、閉じて構いません。読みたくなったら",
    "詳細メニューの「ヘルプ → 使い方（マニュアル）」からいつでも開けます。",
    "",
    "AIを呼ぶ操作には「AIを使う」と書いてあります。",
    "クラウドのAI（Claude・ChatGPT・Gemini・さくらのAI）は実行のたびに課金され、",
    "手元で動くAI（Ollama・LM Studio）は無料です。",
  ].join("\n");
}

/**
 * 作品づくりの流れ。
 *
 * **最初に読む人が知りたいのは「どの順でやるか」である。** 何ができるかの
 * 一覧（次の章）より先に置く。並びは `STEP_MENU` そのままで、
 * ここで順序を書き写さない。
 */
function stepChapter(): string {
  const lines: string[] = ["## 作品づくりの流れ", ""];

  for (const step of STEP_MENU) {
    lines.push(`### ${step.label}`, "", plain(step.detail), "");
    for (const entry of step.entries) {
      if (entry.kind === "placeholder") {
        // 予定の項目も残す。**消すと「まだ無い」ことが伝わらない**
        lines.push(`- ${entry.label}（まだ使えません）: ${plain(entry.detail)}`);
        continue;
      }
      if (entry.kind === "section") {
        lines.push(`- ${entry.label}`);
        for (const item of entry.items) lines.push(`  ${actionLine(item, false)}`);
        continue;
      }
      lines.push(actionLine(entry, false));
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/** 詳細メニューにある操作を、メニューと同じ並びで全部出す */
function actionChapter(allowsProcesses: boolean): string {
  const lines: string[] = [
    "## 操作の一覧",
    "",
    "詳細メニュー（左の一覧）に並んでいるものと同じ順です。",
    "一部の操作はメニューに出さず、設定管理や簡単ステップメニューから使います（その旨を添えてあります）。",
    "",
  ];

  // 写しの分類（「テスト中」）は載せない。同じ操作が2度出てくる
  for (const group of ACTION_TREE.filter((entry) => !entry.generated)) {
    lines.push(`### ${group.label}`, "");
    for (const entry of visibleEntries(group.entries, allowsProcesses)) {
      if (entry.kind === "action") {
        lines.push(actionLine(entry));
        continue;
      }
      lines.push("", `#### ${entry.label}`, "");
      for (const item of visibleEntries(entry.items, allowsProcesses)) {
        lines.push(actionLine(item));
      }
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/**
 * 画面と考え方。
 *
 * `EXTRA_GUIDE` はAIへ渡すための平文なので、見出しの印
 * （墨付き括弧）だけをMarkdownの見出しへ直して載せる。
 * **中身の文は書き換えない**——書き換えると、AIの言うことと
 * マニュアルの記述が違うことになる。
 */
function guideChapter(): string {
  const body = EXTRA_GUIDE.split("\n")
    .map((line) => {
      const heading = /^【(.+)】$/.exec(line.trim());
      return heading ? `### ${heading[1]}` : line;
    })
    .join("\n");

  return ["## 画面と考え方", "", body].join("\n");
}

function actionLine(action: ActionItem, noteLocation = true): string {
  const mark = action.usesAI ? "（AIを使う）" : "";
  return `- ${action.label}${mark}${noteLocation ? whereToFind(action) : ""}: ${plain(action.detail)}`;
}

/**
 * 詳細メニューに**出ない**操作には、実際の入口を添える（設計書6.56.3）。
 *
 * マニュアルは冒頭で「詳細メニューに並んでいるものと同じ順です」と言う。
 * 0.29.8 で一部の操作を画面から隠したので、そのまま載せると**メニューに
 * 無いものを「ある」と書く**ことになる（作者の指示「マニュアル更新も
 * お願いします」2026-09-02）。
 *
 * **どこにあるかは、手で書かずに導く。** 簡単ステップメニューが参照して
 * いるか（`STEP_REFERENCED_COMMANDS`）で見分けられる——参照されていれば
 * そちらから、いなければ設定管理の説明のリンクから使う操作である。
 * 手で書くと、置き場所を変えたときにマニュアルだけが古いままになる。
 */
function whereToFind(action: ActionItem): string {
  if (!action.hiddenFromActionList) return "";
  const special = SPECIAL_ENTRANCES[action.command];
  if (special) return special;
  return STEP_REFERENCED_COMMANDS.includes(action.command)
    ? "（簡単ステップメニューから）"
    : "（設定管理の説明のリンクから）";
}

/**
 * 導き方では当てられない入口（作者の指定、2026-09-03）。
 *
 * `whereToFind` は「簡単ステップメニューが参照しているか」で入口を当てる。
 * ふつうはそれで足りるが、**相談の画面だけは入口がメニューの外にある**——
 * 横の細いパネル（本文の右クリックから開く）の「メインに表示」ボタンが、
 * 大きく開くいちばん近い道である。導きに任せると「簡単ステップメニューから」
 * とだけ書き、その道が案内から消える。
 *
 * **例外はここへ集める。** 説明文（`detail`）へ書き足す手もあるが、
 * detail はメニューのホバーとAIへ渡す説明にも出るので、
 * マニュアルの都合の一文が3か所に散らばることになる。
 */
const SPECIAL_ENTRANCES: Readonly<Record<string, string>> = {
  "novelai.openChatPanel":
    "（横の「AIに相談」パネルの「メインに表示」ボタンから。" +
    "簡単ステップメニューにもあります）",
};

/**
 * 説明文から、画面用の強調の印を落とす。
 *
 * メニューのホバーは `MarkdownString` なので印が効くが、こちらは
 * 本文の中に混ざると読みにくいだけである。記号そのものを文字列に
 * 書かない（画面に出す文字を見張る試験に引っかかる）。
 */
function plain(text: string): string {
  return text.split("*".repeat(2)).join("");
}
