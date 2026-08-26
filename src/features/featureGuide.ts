import { ACTION_TREE, visibleEntries } from "../views/actionList";
import { canRunProcesses } from "../core/runtime";

/**
 * 「この拡張機能の使い方」をAIへ渡すための説明を組み立てる。
 *
 * 作者から「AIに統合執筆環境の拡張機能の使い方を質問したら、
 * わかりやすく説明できるようにしたい」と要望があった（2026-08-15）。
 *
 * **説明書を別に手で書かない。** 操作メニューの定義（`ACTION_TREE`）には、
 * 全操作の名前と「何が起きるか」が既に日本語で書いてある。そこから作れば、
 * 機能を足したときに説明が古びない。手書きの説明書を持つと、**必ず**
 * 実装と食い違い、しかも食い違ったことに誰も気づけない。
 *
 * 操作メニューに出ないもの（パネル類・右クリック・考え方）だけを、
 * ここで補う。
 */

/**
 * 操作メニューに出ない事柄。
 *
 * ここに書くのは「メニューの項目では説明できないこと」に限る。
 * 個々の操作の説明を書き足すと、`ACTION_TREE` との二重管理になる。
 */
const EXTRA_GUIDE = `
【画面】
- 作品一覧（左）: 登録した作品と話数。話を右クリックすると「この話の誤字脱字を検知」「ファイルを削除」が出る
- 操作メニュー（左）: 下に並ぶ操作の一覧。分類→小分類→操作の3階層
- AIに相談（左）: この画面。開いているファイルについて日本語で相談できる
- 設定資料（エディター領域）: 登場人物・能力・組織・場所・世界観を見て、書き換えたり、AIに相談したりする画面
- 提案（下段）: 誤字脱字・表記ゆれの指摘が並ぶ。1件ずつ「適用」「無視」を選ぶ
- 本文やMarkdownを右クリックすると「設定情報を表示」「AIに相談する」が出る

【ファイルの置き場所】
- 本文: 作品フォルダーの直下、または「本文」フォルダー
- 設定/plot.md: プロット
- 設定/synopsis.md: 作品紹介文・キャッチコピー・各話あらすじ（読み物）
- 設定/characters/ 設定/locations/ など: 設定資料の本体（JSON）
- 設定/characters.md など: 設定資料の読み物。JSONから作り直されるので、直すならJSON側か設定資料パネル

【この拡張機能の考え方】
- 本文（原稿）は勝手に書き換えない。AIの指摘は必ず作者が1件ずつ確認して適用する
- 既にいる人物への変更は、その場では書き換えず「更新分を反映」で承認してから入る
- 作者が書き直した内容（作者メモなど）はAIが上書きしない
- 同じ本文を二度AIに読ませない。処理済みは記憶され、本文を変えた分だけ作り直す
- AIを呼ぶ操作には「AI」の印が付く。クラウドのAI（Claude・ChatGPT・Gemini）は実行のたびに課金され、Ollamaは無料
`.trim();

/**
 * 操作の一覧を、AIが読める形にまとめる。
 *
 * 見出しの階層はメニューと同じにする。作者が画面で見ている並びと
 * 説明の並びが違うと、「どこにあるか」を答えられない。
 */
export function buildFeatureGuide(): string {
  const lines: string[] = ["【操作メニューにある操作】"];

  // **画面に無い操作を案内させない。** 環境によって出さない操作があるので、
  // 一覧も同じ規則で絞る（`isItemVisibleInRuntime`）
  const allowsProcesses = canRunProcesses();

  // 写しの分類（「テスト中」）は案内に入れない。同じ機能を2回案内することになる
  for (const group of ACTION_TREE.filter((entry) => !entry.generated)) {
    lines.push(`■ ${group.label}`);
    for (const entry of visibleEntries(group.entries, allowsProcesses)) {
      if (entry.kind === "action") {
        lines.push(describeAction(entry, ""));
        continue;
      }
      lines.push(`  ▸ ${entry.label}`);
      for (const item of visibleEntries(entry.items, allowsProcesses)) {
        lines.push(describeAction(item, "  "));
      }
    }
  }

  return [lines.join("\n"), "", EXTRA_GUIDE].join("\n");
}

function describeAction(
  action: { label: string; detail: string; usesAI?: boolean },
  indent: string
): string {
  // 強調の記号は画面用なので落とす。AIへの指示と混ざると読みにくい
  const detail = action.detail.replace(/\*\*/g, "");
  const mark = action.usesAI ? "（AIを使う）" : "";
  return `${indent}  - ${action.label}${mark}: ${detail}`;
}
