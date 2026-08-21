import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { scanWork } from "../core/scanner";
import { readTextFile } from "../core/textFile";
import { parseEpisodeMetadata } from "../core/metadataParser";
import { parseCollectedFile } from "../core/collectedFile";
import {
  detectNotationVariants,
  type NotationSource,
  type NotationVariantGroup,
} from "../core/notationVariants";
import { CharacterStore } from "../core/characterStore";
import {
  createAbilityStore,
  createLocationStore,
  createOrganizationStore,
} from "../core/abilityStore";
import { dismissKey, TypoDismissedHistory } from "../core/typoIssueHistory";
import { locateBody, type TypoCheckIssue } from "./checkTypos";
import { cancelItem } from "../views/dialogs";

/**
 * 表記ゆれ検知（P-13）のオーケストレーション。
 *
 * **AIを呼ばない。** 判定はすべて `core/notationVariants.ts` のルールで行う。
 * そのため課金も待ち時間も無く、確認ダイアログで処理量を示す必要もない。
 *
 * 誤字脱字検知（P-09）と決定的に違うのは、**作者に「どちらへ揃えるか」を
 * 先に訊く**ことである。「良い」と「よい」はどちらも正しい日本語で、
 * 機械にはどちらが正しいか決められない。一度決めてもらえば、あとは
 * 作品全体へ機械的に反映できる。
 *
 * 生成した指摘は誤字脱字検知と同じ形（`TypoCheckIssue`）にして、
 * 実績のある提案パネルの適用経路をそのまま使う。本文を書き換える
 * 処理を新しく作らない（CLAUDE.mdの「4か所目の同じ失敗」を避ける）。
 */

export interface NotationCheckRunResult {
  issues: TypoCheckIssue[];
  /** 見つかった組の数 */
  groupCount: number;
  /** 作者が「揃える」を選んだ組の数 */
  unifiedCount: number;
  /** 無視の記録により除いた指摘の数 */
  dismissedCount: number;
  cancelled: boolean;
  /** 作者が選んだ組の数。0件だったときに理由を伝えるために持つ */
  selectedCount?: number;
  /** 組ごとの選択を途中で閉じたか */
  stoppedEarly?: boolean;
}

export async function checkNotation(
  work: WorkEntry
): Promise<NotationCheckRunResult | undefined> {
  const scan = await scanWork(work);
  if (scan.episodes.length === 0) {
    vscode.window.showWarningMessage("本文ファイルが見つかりません。");
    return undefined;
  }

  const conflicted: string[] = [];
  const sources: NotationSource[] = [];

  for (const episode of scan.episodes) {
    const file = await readTextFile(episode.filePath);
    if (file.hasConflictMarkers) {
      conflicted.push(episode.fileName);
      continue;
    }

    // 合本は話ごとに分かれているが、表記ゆれは作品全体で数えるため
    // ここでは1つの本文として扱ってよい。ただし行番号の基準は
    // 元ファイルに合わせる必要がある（ヘッダーの行数だけずれる）
    const collected = parseCollectedFile(file.text);
    if (collected) {
      let searchFrom = 0;
      for (const inner of collected) {
        if (!inner.body.trim()) continue;
        const located = locateBody(file.text, inner.body, searchFrom);
        searchFrom = located.nextSearchIndex;
        sources.push({
          filePath: episode.filePath,
          body: inner.body,
          startLine: located.line + 1,
        });
      }
      continue;
    }

    const meta = parseEpisodeMetadata(file.text);
    if (!meta.body.trim()) continue;
    const located = locateBody(file.text, meta.body, 0);
    sources.push({
      filePath: episode.filePath,
      body: meta.body,
      startLine: located.line + 1,
    });
  }

  if (conflicted.length > 0) {
    const proceed = await vscode.window.showWarningMessage(
      `未解決の競合が ${conflicted.length} 件あります（${conflicted
        .slice(0, 3)
        .join(", ")}${conflicted.length > 3 ? " ほか" : ""}）。` +
        "これらのファイルは対象から外れます。",
      "除外して続行",
      "中止"
    );
    if (proceed !== "除外して続行") return undefined;
  }

  if (sources.length === 0) {
    vscode.window.showWarningMessage("処理できる本文がありません。");
    return undefined;
  }

  const properNouns = await loadProperNouns(work);
  const groups = detectNotationVariants(sources, { properNouns });

  if (groups.length === 0) {
    vscode.window.showInformationMessage(
      "表記ゆれは見つかりませんでした。" +
        "（同じ語が2通り以上の書き方で本文に出ている場合だけを対象にしています）"
    );
    return { issues: [], groupCount: 0, unifiedCount: 0, dismissedCount: 0, cancelled: false };
  }

  const picked = await pickGroups(groups);
  if (!picked) {
    return { issues: [], groupCount: groups.length, unifiedCount: 0, dismissedCount: 0, cancelled: true };
  }

  // **14組あれば14回聞かれる。** 1回で決められる道を用意する（6.8.9）
  const mode =
    picked.length >= 2 ? await pickDecisionMode(picked.length) : "each";
  if (!mode) {
    return {
      issues: [],
      groupCount: groups.length,
      unifiedCount: 0,
      dismissedCount: 0,
      cancelled: true,
    };
  }

  const dismissed = await new TypoDismissedHistory(work).load();
  const issues: TypoCheckIssue[] = [];
  let unifiedCount = 0;
  let dismissedCount = 0;
  /** 途中で閉じたか。0件だったときに理由を伝えるために持つ */
  let stoppedEarly = false;

  for (const group of picked) {
    const keep =
      mode === "majority" ? majorityForm(group) : await pickTargetForm(group);
    if (keep === undefined) {
      // ここで中止すると、それまでに選んだ分まで捨てることになる。
      // 選び終えた分は活かし、残りは選ばなかったものとして扱う
      stoppedEarly = true;
      break;
    }
    if (keep === null) continue;

    unifiedCount++;
    for (const form of group.forms) {
      if (form.surface === keep) continue;
      for (const occurrence of form.occurrences) {
        const issue = buildIssue(group, occurrence, form.surface, keep);
        if (dismissed.has(dismissKey(issue.filePath, issue))) {
          dismissedCount++;
          continue;
        }
        issues.push(issue);
      }
    }
  }

  return {
    issues,
    groupCount: groups.length,
    unifiedCount,
    dismissedCount,
    cancelled: false,
    selectedCount: picked.length,
    stoppedEarly,
  };
}

/** 揃えたい組を選ばせる。既定では何も選ばない（勝手に直さない） */
async function pickGroups(
  groups: NotationVariantGroup[]
): Promise<NotationVariantGroup[] | undefined> {
  const items = groups.map((group) => ({
    label: group.label,
    description: group.forms
      .map((form) => `${form.surface} ${form.occurrences.length}回`)
      .join(" / "),
    detail: exampleOf(group),
    group,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: `表記ゆれが ${groups.length} 組見つかりました`,
    placeHolder: "揃えたい組を選んでください（複数選べます）",
    canPickMany: true,
    ignoreFocusOut: true,
  });
  if (!picked) return undefined;
  if (picked.length === 0) {
    // **黙って終わらない。** 押したのに何も起きないと、
    // 作者は壊れていると受け取る（2026-08-21、作者の報告）
    void vscode.window.showInformationMessage(
      "揃える組が1つも選ばれていません。左端の四角を押して選んでください。"
    );
    return undefined;
  }
  return picked.map((item) => item.group);
}

/**
 * 組ごとに聞くか、多い方でまとめて決めるか（設計書6.8.9）。
 *
 * **14組あれば14回聞かれる。** 途中で閉じると、それまでに選んだ分しか
 * 残らない。作者は「選んだのに何も出ない」と受け取る
 * （2026-08-21、作者が実機で報告）。
 *
 * **既定で決め打ちはしない**という方針は変えない。ただ、**1回で
 * 決められる道を用意する。** 多い方に揃えるのは、たいていの場合に
 * 作者が選ぶものである。少ないほうを採りたい組だけ、あとから
 * 「今後直さない」で外せばよい。
 */
type DecisionMode = "majority" | "each";

async function pickDecisionMode(
  count: number
): Promise<DecisionMode | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "$(check-all) 多い方の表記に揃える",
        detail: `${count}組すべてを、本文に多く出ているほうへ揃えます。1回で決まります`,
        mode: "majority" as const,
      },
      {
        label: "$(list-ordered) 1組ずつ選ぶ",
        detail: `${count}回聞かれます。少ないほうへ揃えたい組があるときはこちら`,
        mode: "each" as const,
      },
      cancelItem(),
    ],
    {
      title: `${count}組を選びました — どう決めますか`,
      placeHolder: "自動では書き換えません。指摘を作るだけです",
      ignoreFocusOut: true,
    }
  );
  if (!picked || !("mode" in picked)) return undefined;
  return picked.mode;
}

/** 出現の多い表記。`forms` は多い順に並んでいる */
function majorityForm(group: NotationVariantGroup): string | null {
  return group.forms[0]?.surface ?? null;
}

/**
 * どの表記に揃えるかを選ばせる。
 *
 * 戻り値は「選んだ表記」「この組はやめる（null）」「中止（undefined）」。
 * 出現の多い表記を先に出すが、**既定で決め打ちはしない。**
 * 少ないほうが作者の新しい方針ということもある。
 */
async function pickTargetForm(
  group: NotationVariantGroup
): Promise<string | null | undefined> {
  const total = group.forms.reduce(
    (sum, form) => sum + form.occurrences.length,
    0
  );

  const items: Array<{ label: string; description: string; keep: string | null }> =
    group.forms.map((form) => ({
      label: `「${form.surface}」に揃える`,
      description: `${form.surface} は ${form.occurrences.length}回。他の ${
        total - form.occurrences.length
      }箇所を書き換える候補として出します`,
      keep: form.surface,
    }));
  items.push({
    label: "$(close) この組は揃えない",
    description: "意図して使い分けている場合",
    keep: null,
  });

  const picked = await vscode.window.showQuickPick([...items, cancelItem()], {
    title: `${group.label} — どちらに揃えますか`,
    placeHolder: "選んだ表記に合わせる指摘を作ります（自動では書き換えません）",
    ignoreFocusOut: true,
  });
  // 取りやめ（undefined）は「残りも見ない」。「この組は揃えない」（null）とは別
  if (!picked || !("keep" in picked)) return undefined;
  return picked.keep;
}

function exampleOf(group: NotationVariantGroup): string {
  const first = group.forms[0]?.occurrences[0];
  if (!first) return "";
  const name = path.basename(first.filePath);
  return `${name} ${first.line}行目: ${first.lineText.trim().slice(0, 60)}`;
}

function buildIssue(
  group: NotationVariantGroup,
  occurrence: { filePath: string; line: number; lineText: string; column: number },
  from: string,
  to: string
): TypoCheckIssue {
  const context = buildUniqueContext(
    occurrence.lineText,
    occurrence.column,
    from.length
  );

  return {
    filePath: occurrence.filePath,
    // 無視の記録が本文の編集で消えないよう、内容ハッシュではなく
    // 「どのファイルのどの組か」で固定する
    chunkHash: `notation:${path.basename(occurrence.filePath)}:${group.key}`,
    line: occurrence.line,
    original: context,
    target: from,
    suggestion: to,
    reason:
      `表記ゆれ（「${to}」に揃える）。` +
      "意図して使い分けている場合は無視してください。",
    // 揃える方針は作者が選んでいるが、語の切れ目の判定は機械なので
    // 断定はしない。既定で隠れる low にはせず medium にする
    confidence: "medium",
  };
}

/**
 * その出現箇所だけを指せる前後の文脈を作る。
 *
 * 適用処理（`proposalPanel.ts`）は行の中から `original` を `indexOf` で
 * 探すため、**同じ行に同じ語が2回出ると、2件目が1件目の位置に化ける。**
 * そこで「先頭からの検索で確かにこの位置に当たる」ところまで前後を
 * 広げてから渡す。「よい。よい。」の2件目なら「。よい」まで広げれば足りる。
 */
export function buildUniqueContext(
  lineText: string,
  column: number,
  length: number
): string {
  const MAX_PAD = 16;
  for (let pad = 0; pad <= MAX_PAD; pad++) {
    const start = Math.max(0, column - pad);
    const end = Math.min(lineText.length, column + length + pad);
    const window = lineText.slice(start, end);
    if (lineText.indexOf(window) === start) return window;
    // これ以上広げられないなら打ち切る
    if (start === 0 && end === lineText.length) break;
  }
  return lineText;
}

async function loadProperNouns(work: WorkEntry): Promise<string[]> {
  const [characters, abilities, locations, organizations] = await Promise.all([
    new CharacterStore(work).loadAll(),
    createAbilityStore(work).loadAll(),
    createLocationStore(work).loadAll(),
    createOrganizationStore(work).loadAll(),
  ]);

  return [
    ...characters.characters.flatMap((record) => [record.name, ...record.aliases]),
    ...abilities.records.flatMap((record) => [record.name, ...record.aliases]),
    ...locations.records.flatMap((record) => [record.name, ...record.aliases]),
    ...organizations.records.flatMap((record) => [record.name, ...record.aliases]),
  ]
    .map((name) => name.trim())
    .filter(Boolean);
}

/**
 * 終わったときに何が起きたかを伝える（設計書6.8.9）。
 *
 * **0件のときこそ、理由が要る。** パネルが空のままだと、作者は
 * 壊れていると受け取る。実際に「表記ゆれが提案パネルに出ません」と
 * 報告があった（2026-08-21）。
 */
export function describeNotationResult(
  result: NotationCheckRunResult
): string {
  if (result.groupCount === 0) {
    return "表記ゆれは見つかりませんでした。";
  }

  if (result.issues.length > 0) {
    const parts = [
      `${result.groupCount}組のうち${result.unifiedCount}組を揃えます。`,
      `${result.issues.length}件の指摘を提案パネルに出しました。`,
    ];
    if (result.dismissedCount > 0) {
      parts.push(`（無視した分 ${result.dismissedCount}件は除いています）`);
    }
    if (result.stoppedEarly) {
      parts.push("途中で閉じたので、そこから先の組は見ていません。");
    }
    return parts.join("");
  }

  // ここから下は、指摘が0件だったときの理由
  if (result.stoppedEarly) {
    return (
      "指摘は作られませんでした。揃える表記を選ぶ前に閉じたためです。" +
      "もう一度実行してください。"
    );
  }
  if (result.unifiedCount === 0) {
    return (
      `選んだ${result.selectedCount ?? 0}組は、すべて「この組は揃えない」になりました。` +
      "指摘は作られていません。"
    );
  }
  if (result.dismissedCount > 0) {
    return (
      `${result.unifiedCount}組を揃えることにしましたが、` +
      `${result.dismissedCount}件はすべて「今後直さない」に登録済みでした。` +
      "「直さない語を管理」から外せます。"
    );
  }
  return "指摘は作られませんでした。選んだ組では書き換える箇所がありませんでした。";
}
