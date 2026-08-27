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
 *
 * ## 毎回送るので、短くする（2026-08-27）
 *
 * この一覧は**相談の1回ごとに毎回**送っている。測ったところ8,111字あり、
 * **1回の問いかけで送る量の半分**を占めていた（本文は19%しかない）。
 * 設計書には「約4,300字」とあるが、機能を足すたびに自動で伸びるので、
 * **誰も気づかないまま倍近くになっていた。**
 *
 * **名前は全部残し、説明は要るところだけにする。** 機能の名前が欠けると
 * 「その機能はありません」と嘘を答える。残すのは**1文目**（何ができるか）と、
 * **「〜ません」で終わる文**（しないことの断り）だけにする。後者を落とすと、
 * 「原稿は書き換えません」「AIは使いません」が消えて、AIが逆を答えかねない。
 */

/**
 * 操作メニューに出ない事柄。
 *
 * ここに書くのは「メニューの項目では説明できないこと」に限る。
 * 個々の操作の説明を書き足すと、`ACTION_TREE` との二重管理になる。
 *
 * **作者向けのマニュアル（`openManual.ts`）もここを使う。** AIへ渡す説明と
 * 作者が読む説明で、書いてあることが違ってはいけない。文面を2か所に持つと、
 * 片方だけ直したときに「AIの言うことと、マニュアルの記述が違う」ことになる。
 */
export const EXTRA_GUIDE = `
【画面】
- 作品一覧（左）: 登録した作品と話数。話を右クリックすると「この話の誤字脱字を検知」「ファイルを削除」が出る
- ステップメニュー（左）: 作品づくりの流れ（1.作品登録→2.新作構想→3.作品執筆→4.自己校正→5.投稿脱稿→6.編集部校正・校閲→7.電子出版等）に沿って主な操作を並べたメニュー。最上段で選んだ作品にだけ効く。全操作は詳細メニューにある
- 詳細メニュー（左）: 下に並ぶ操作の一覧。分類→小分類→操作の3階層
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
export function buildFeatureGuide(
  options: {
    /**
     * 説明の詳しさ。
     *
     * - `short`（既定）：1文目まで。**毎回送るのはこちら**
     * - `full`：全文。作者が「詳しく」と聞いたときに渡す道を作るための口
     */
    detail?: "short" | "full";
  } = {}
): string {
  const detailLevel = options.detail ?? "short";
  const lines: string[] = ["【詳細メニューにある操作】"];

  // **画面に無い操作を案内させない。** 環境によって出さない操作があるので、
  // 一覧も同じ規則で絞る（`isItemVisibleInRuntime`）
  const allowsProcesses = canRunProcesses();

  // 写しの分類（「テスト中」）は案内に入れない。同じ機能を2回案内することになる
  for (const group of ACTION_TREE.filter((entry) => !entry.generated)) {
    lines.push(`■ ${group.label}`);
    for (const entry of visibleEntries(group.entries, allowsProcesses)) {
      if (entry.kind === "action") {
        lines.push(describeAction(entry, "", detailLevel));
        continue;
      }
      lines.push(`  ▸ ${entry.label}`);
      for (const item of visibleEntries(entry.items, allowsProcesses)) {
        lines.push(describeAction(item, "  ", detailLevel));
      }
    }
  }

  return [lines.join("\n"), "", EXTRA_GUIDE].join("\n");
}

function describeAction(
  action: { label: string; detail: string; usesAI?: boolean },
  indent: string,
  level: "short" | "full"
): string {
  // 強調の記号は画面用なので落とす。AIへの指示と混ざると読みにくい。
  // 記号そのものを文字列に書かない（画面に出す文字を見張る試験に引っかかる）
  const emphasis = "*".repeat(2);
  const full = action.detail.split(emphasis).join("");
  const detail = level === "full" ? full : shorten(full);
  const mark = action.usesAI ? "（AIを使う）" : "";
  return `${indent}  - ${action.label}${mark}: ${detail}`;
}

/**
 * 説明を短くする。**毎回送るので、要る分だけ残す。**
 *
 * 残すのは2種類だけである。
 *
 * 1. **1文目**——この作品の説明文は「何ができるか」を1文目に書く決まりで
 *    揃えてある
 * 2. **「〜ません」で終わる文**——「原稿は書き換えません」「元のフォルダーは
 *    消しません」「AIは使いません」。**しないことの断りは、作者がいちばん
 *    知りたいこと**であり、落とすとAIが「する」と答えかねない
 *
 * 2文目以降の但し書き（使いどころ・言い換え・例）は落とす。
 */
export function shorten(text: string): string {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return text.trim();

  const kept = [sentences[0]];
  for (const sentence of sentences.slice(1)) {
    // 「〜ません」「〜しません」。**しないことの断りは落とさない**
    if (/ません[。」]?$/.test(sentence.trim())) kept.push(sentence);
  }
  return kept.join("");
}

/** 句点で文に割る。句点そのものは前の文へ付ける */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const char of text.trim()) {
    current += char;
    if (char === "。") {
      out.push(current);
      current = "";
    }
  }
  if (current.trim()) out.push(current);
  return out;
}
