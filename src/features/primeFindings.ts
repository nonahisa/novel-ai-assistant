import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import type { Finding, FindingView } from "../models/finding";
import { readTextFile } from "../core/textFile";
import { locateFindings } from "../core/findingLocation";
import { findingFilePath, findingRestoreOf } from "../core/findingSource";
import { FindingStore, findingsRetentionDays, visibleFindings } from "./findingStore";
import type {
  ContradictionViewItem,
  ProposalPanel,
  ProposalViewItem,
} from "./proposalPanel";

/**
 * 開いたときに、置き場へ残っている指摘を提案パネルへ戻す（設計書6.96.4）。
 *
 * **先例は `primePendingRecordUpdates`**（6.11.6、承認待ちの読み込み）。
 * 同じ作法にしてある——作品ごとに読み、静かに出し、失敗しても他の作品の
 * 分は出す。
 *
 * ## 順序を変えない
 *
 * `load()` → `visibleFindings()` → `locateFindings()` の順に通す。
 *
 * - `visibleFindings` が、期限切れと判断済みを**隠す**（消しはしない）
 * - `locateFindings` が、本文から**消えた指摘を落とす**
 *
 * **画面側で捨てる処理を書かない。** 2か所で捨てると、片方だけが直った
 * ときに「消したはずのものが出る」と「出るはずのものが出ない」の両方が
 * 起きる。
 *
 * ## 本文を読むのがここに在る理由
 *
 * `core` から `vscode` を触らない決めなので、`locateFindings` は本文の
 * 文字列を受け取る形になっている。読むのは `features` 側の仕事である。
 */
export async function primeSavedFindings(
  work: WorkEntry,
  panel: ProposalPanel
): Promise<number> {
  const saved = visibleFindings(
    await new FindingStore(work).load(),
    findingsRetentionDays()
  );
  if (saved.length === 0) return 0;

  const texts = await readTexts(work, saved);
  const located = locateFindings(saved, texts);
  if (located.length === 0) return 0;

  /*
    **分類ごとにまとめて戻す。** 1件ずつ渡すと、そのたびに画面が
    組み直される（`replaceContents` は毎回 `postItems` を呼ぶ）。

    `Map` は入れた順を保つので、タブの並びは**話数 → 行の順で先に
    出てきた種類**になる（`locateFindings` が並べ替えた順）。
  */
  const items = new Map<string, ProposalViewItem[]>();
  const contradictions = new Map<string, ContradictionViewItem[]>();
  for (const finding of located) {
    const restore = findingRestoreOf(finding);
    // 戻し方の決まっていない種類（`other`）は出さない。
    // **押しても何も起きない口を作らない**のと同じ考え方である
    if (!restore) continue;
    const filePath = findingFilePath(work.folderPath, finding.file);
    if (restore.shape === "item") {
      push(items, restore.panelCategory, toItem(finding, filePath, restore.panelCategory));
    } else {
      push(
        contradictions,
        restore.panelCategory,
        toContradiction(finding, filePath, restore.panelCategory)
      );
    }
  }

  let restored = 0;
  for (const [category, list] of items) {
    panel.showRestoredFindings(work, category, { items: list });
    restored += list.length;
  }
  for (const [category, list] of contradictions) {
    panel.showRestoredFindings(work, category, { contradictions: list });
    restored += list.length;
  }
  return restored;
}

/**
 * 1件だけを提案パネルへ渡す（設計書6.96.5）。
 *
 * シーンメモの「直す」の行き先である。**この画面は本文を書き換えない**ので、
 * 当てるのは提案パネルの既存の処理に任せ、ここでするのは
 * 「いまの位置に直した1件を、元の分類へ置く」ことだけである。
 *
 * **中身は `primeSavedFindings` のループ本体と同じもの**を通す。写しを
 * 置くと、戻し方が片方だけ直る日が来る（`core/findingSource.ts` の表が
 * 1つしか無いのと同じ理由）。
 *
 * **位置は保存してある `hintLine` ではなく、探し直した `line` を使う**
 * （6.96.3）。シーンメモは開くたびに位置を決め直しており、渡す相手は
 * その行を本文の行番号として扱う。
 *
 * @returns 渡せたか。戻し方の決まっていない種類は `false`
 */
export function handOverFinding(
  work: WorkEntry,
  panel: ProposalPanel,
  finding: Finding & { line: number }
): boolean {
  const restore = findingRestoreOf(finding);
  if (!restore) return false;
  const filePath = findingFilePath(work.folderPath, finding.file);
  if (restore.shape === "item") {
    panel.showRestoredFindings(work, restore.panelCategory, {
      items: [toItem(finding, filePath, restore.panelCategory)],
    });
  } else {
    panel.showRestoredFindings(work, restore.panelCategory, {
      contradictions: [toContradiction(finding, filePath, restore.panelCategory)],
    });
  }
  return true;
}

/**
 * 指摘が指しているファイルの本文を読む。
 *
 * **鍵は `Finding.file` のまま**（`locateFindings` がこの表記で引く）。
 * 読めなかったファイルは入れない——`locateFindings` は本文を知らない
 * ファイルの指摘を返さないので、**置き場から消えるわけではない**
 * （「消えた」のではなく「まだ見ていない」だけである）。
 */
async function readTexts(
  work: WorkEntry,
  findings: readonly FindingView[]
): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  for (const file of new Set(findings.map((finding) => finding.file))) {
    try {
      const content = await readTextFile(findingFilePath(work.folderPath, file));
      texts.set(file, content.text);
    } catch {
      // 移した・消した・まだ同期されていない。**騒がずに見送る**
    }
  }
  return texts;
}

/**
 * 本文の置き換えの形へ戻す。
 *
 * **確信度は残していない**（`Finding` が持たない）ので「中」で出す。
 * 「高」にすると「まとめて適用」の対象へ入ってしまい、AIが弱いと言った
 * 指摘まで一括で本文へ当たる。「低」にすると、適用の道が無い指摘と
 * 区別が付かなくなる。
 */
function toItem(
  finding: Finding & { line: number },
  filePath: string,
  label: string
): ProposalViewItem {
  return {
    id: finding.id,
    // **置き場での番号を持ったまま渡す。** 番号の作り方をあとから変えても、
    // この1件の判断が置き場の行と噛み合い続ける
    findingId: finding.id,
    filePath,
    fileName: path.basename(filePath),
    // 検知のときのチャンクは残していない。**見送りの鍵はファイル名と
    // 直し方で作る**ので、無くても困らない（`dismissKey`）
    chunkHash: "",
    line: finding.line,
    original: finding.original,
    target: finding.target,
    suggestion: finding.suggestion,
    reason: label,
    detail: finding.message,
    confidence: "medium",
    status: "pending",
  };
}

/**
 * 食い違いの形へ戻す。
 *
 * **押せる口を絞る。** 残してあるのは「どこに・何が・なぜ」だけで、
 * 照らす相手（設定資料のどのレコードか、プロットのどの行か）も、
 * 再チェックへ渡す材料も残していない。出すと**押しても何も起きない口**に
 * なるので、「本文を見る」と「無視」だけにする。
 *
 * **左右の見出しは残してあるものを使う**（`compared`）。矛盾は
 * 「設定では／本文では」、逸脱は「プロットでは／この話では」で言葉が
 * 違うので、決め打ちにすると逸脱が「設定では」と読める形で戻る。
 * 古い記録（0.68.2 まで）は持っていないので、組み上がった1文で出す。
 */
function toContradiction(
  finding: Finding & { line: number },
  filePath: string,
  label: string
): ContradictionViewItem {
  const compared = finding.compared;
  return {
    id: finding.id,
    findingId: finding.id,
    filePath,
    fileName: path.basename(filePath),
    chunkHash: "",
    line: finding.line,
    excerpt: finding.original,
    category: label,
    leftLabel: compared?.leftLabel ?? "指摘",
    settingSays: compared?.left ?? finding.message,
    rightLabel: compared?.rightLabel ?? "",
    textSays: compared?.right ?? "",
    note: compared?.note ?? "",
    confidence: "medium",
    status: "pending",
    openTarget: "none",
    allowRecheck: false,
  };
}

function push<T>(into: Map<string, T[]>, key: string, value: T): void {
  const list = into.get(key);
  if (list) {
    list.push(value);
    return;
  }
  into.set(key, [value]);
}
