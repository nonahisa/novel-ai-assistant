import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import {
  describeFindingOrigin,
  type Finding,
  type FindingView,
} from "../models/finding";
import { readTextFile } from "../core/textFile";
import { locateFindings } from "../core/findingLocation";
import {
  findingAppliesDirectly,
  findingFilePath,
  findingRestoreOf,
} from "../core/findingSource";
import { FindingStore, findingsRetentionDays, visibleFindings } from "./findingStore";
import type {
  ContradictionViewItem,
  FindingFixOutcome,
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

  const { texts, hashes } = await readTexts(work, saved);
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
    const origin = originOf(finding, hashes.get(finding.file));
    if (restore.shape === "item") {
      push(items, restore.panelCategory, {
        ...toItem(finding, filePath, restore.panelCategory),
        ...origin,
      });
    } else {
      push(contradictions, restore.panelCategory, {
        ...toContradiction(finding, filePath, restore.panelCategory),
        ...origin,
      });
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
 * 校正・メモパネルの［提案へ］（修正案の無い指摘）の行き先であり、［直す］
 * （`applyFindingFromMemo`）が行を一覧へ置く道でもある。ここでするのは
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
  // シーンメモからの1件は本文のハッシュを持って来ないので、出どころの札だけを付ける
  const origin = originOf(finding, undefined);
  if (restore.shape === "item") {
    panel.showRestoredFindings(work, restore.panelCategory, {
      items: [{ ...toItem(finding, filePath, restore.panelCategory), ...origin }],
    });
  } else {
    panel.showRestoredFindings(work, restore.panelCategory, {
      contradictions: [
        { ...toContradiction(finding, filePath, restore.panelCategory), ...origin },
      ],
    });
  }
  return true;
}

/**
 * 校正・メモパネルの［直す］——修正案のある1件を、1手で本文へ当てる
 * （設計書6.96.5。作者の裁定 2026-10-03「［直す］1手で本文が直る」）。
 *
 * **当てる道は提案パネルの［適用］と同じ関数**（`ProposalPanel.applyFinding` →
 * `applyIssue`）。ここでするのは、`handOverFinding` と同じ組み立てで行を一覧へ
 * 置くことだけである——写しの適用処理を作ると、検算や記録が片方だけ直る日が来る。
 * 行が一覧に残るので、提案パネルの［戻す］でも戻せる。
 *
 * 修正案の無い指摘（矛盾・逸脱など）は当てない。呼ぶ側は `handOverFinding` へ回す。
 */
export async function applyFindingFromMemo(
  work: WorkEntry,
  panel: ProposalPanel,
  finding: Finding & { line: number }
): Promise<FindingFixOutcome> {
  const restore = findingRestoreOf(finding);
  if (!restore || !findingAppliesDirectly(finding)) {
    return { ok: false, reason: "この指摘には修正案がありません。" };
  }
  if (!handOverFinding(work, panel, finding)) {
    return { ok: false, reason: "この指摘を提案の一覧へ置けませんでした。" };
  }
  return panel.applyFinding(work, restore.panelCategory, finding.id);
}

/**
 * 校正・メモパネルの［戻す］——［直す］で当てた1件を、提案パネルの［戻す］と
 * 同じ関数で戻す（設計書6.96.5）。戻すと置き場に「戻した」の行が足され、
 * 両方の画面にその指摘がまた並ぶ。
 */
export async function undoFindingFromMemo(
  work: WorkEntry,
  panel: ProposalPanel,
  finding: Finding
): Promise<FindingFixOutcome> {
  const restore = findingRestoreOf(finding);
  if (!restore) {
    return { ok: false, reason: "この指摘の戻し方が決まっていません。" };
  }
  return panel.undoFinding(work, restore.panelCategory, finding.id);
}

/**
 * 外から置かれた指摘の札と添え書き（MCP `novel.propose` の `kind: "finding"`。2026-10-01）。
 *
 * **中のAIの指摘には何も足さない**（空のオブジェクト）。
 *
 * **置いたときの指紋と、いまの本文のハッシュが違えば添え書きを出す**（設計書5.4.4
 * 「ファイル全体のハッシュが変わった場合…再チェックを推奨」）。**当てるのは止めない**
 * ——位置はいま原文で探し直してあり（6.96.3）、当てる直前にも原文を照らす。
 * ハッシュで止めると、同じ話の指摘を1つ当てた瞬間に残りが全部当てられなくなる。
 *
 * @param currentHash いまの本文のハッシュ。分からなければ `undefined`（比べない）
 */
export function originOf(
  finding: Finding,
  currentHash: string | undefined
): { originLabel?: string; originNote?: string } {
  if (!finding.origin) return {};
  const changed =
    currentHash !== undefined &&
    finding.fingerprint !== undefined &&
    finding.fingerprint.fileHash !== currentHash;
  return {
    originLabel: describeFindingOrigin(finding.origin),
    ...(changed
      ? {
          originNote:
            "置いたあとで原稿が変わっています。位置は引用で探し直しました（当てる前に本文を確かめてください）。",
        }
      : {}),
  };
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
): Promise<{ texts: Map<string, string>; hashes: Map<string, string> }> {
  const texts = new Map<string, string>();
  // 外から置かれた指摘の指紋と比べるため（`originOf`）。読んだついでに控える
  const hashes = new Map<string, string>();
  for (const file of new Set(findings.map((finding) => finding.file))) {
    try {
      const content = await readTextFile(findingFilePath(work.folderPath, file));
      texts.set(file, content.text);
      hashes.set(file, content.hash);
    } catch {
      // 移した・消した・まだ同期されていない。**騒がずに見送る**
    }
  }
  return { texts, hashes };
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
    // **出したときのAIを持ち越す**（設計書6.49.7）。いまの割当で引き直すと、
    // あいだに割当を替えていれば別のモデルの手柄になる
    producedBy: finding.producer,
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
    producedBy: finding.producer,
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
