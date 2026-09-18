import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import type { FindingView } from "../models/finding";
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
    const restore = findingRestoreOf(finding.category);
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
  finding: FindingView & { line: number },
  filePath: string,
  label: string
): ProposalViewItem {
  return {
    id: finding.id,
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
 */
function toContradiction(
  finding: FindingView & { line: number },
  filePath: string,
  label: string
): ContradictionViewItem {
  return {
    id: finding.id,
    filePath,
    fileName: path.basename(filePath),
    chunkHash: "",
    line: finding.line,
    excerpt: finding.original,
    category: label,
    // **並べる2つに分けずに残してある**（`message` は組み上がった1文）。
    // 「／」で分け直す形にすると、本文に「／」が現れたときに割れ方が狂う
    leftLabel: "指摘",
    settingSays: finding.message,
    rightLabel: "",
    textSays: "",
    note: "",
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
