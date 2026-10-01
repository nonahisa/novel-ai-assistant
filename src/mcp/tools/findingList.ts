import * as fs from "node:fs";
import * as nodePath from "node:path";
import { AIWRITER_DIR } from "../../models/types";
import {
  FINDINGS_FILE_NAME,
  parseFindingLines,
  resolveFindings,
  type FindingCategory,
  type FindingView,
} from "../../models/finding";
import {
  DEFAULT_FINDINGS_RETENTION_DAYS,
  FINDING_PANEL_STATES,
  FINDING_PANEL_STATE_LABELS,
  findingPanelStateOf,
  type FindingPanelState,
} from "../../core/findingPanelState";
import { McpToolError, readBody } from "./shared";

/**
 * 提案パネルの指摘を外から読む（MCP `pending.list` の `kind: "finding"`。
 * 作者の裁定、2026-10-01）。
 *
 * 目的：外部AIや手元のAIが出した指摘を、**作者が採ったか**を外から確かめる。
 * AIごとの当たり率の測定にも使う（設計書6.49.7 の外から見る口）。
 *
 * **状態の決め方は提案パネルと同じ関数を通す**（`core/findingPanelState.ts`）。
 * ここが持つのは Node の `fs` で置き場と本文を読むところだけ。
 *
 * **読むだけ。** 採る・退ける・片づける道は作らない（作者が VS Code で決める）。
 *
 * **数えられるのは置き場に残っている分だけ。** 「古い指摘を片づける」を
 * 押すと、期限切れの指摘は判断の行ごと消える（6.96.7）。長い期間の率は
 * `.aiwriter/history/ai-verdicts.jsonl`（6.49.7）のほうが正しい。
 */

/** 引用・提案・説明を切る長さ。**原稿をまとめて渡さない**（出方は `excerpt`） */
const QUOTE_CHARS = 60;
const SUGGESTION_CHARS = 80;
const MESSAGE_CHARS = 120;

export interface FindingListInput {
  folder: string;
  /** `external` だけ受ける（外部AIの指摘に絞る） */
  source?: string;
  limit: number;
  retentionDays?: number;
}

/** 出どころ。外から置いた印（`origin`）があれば外部AI、無ければ製品のAI */
export type FindingListSource = "internal" | "external";

export interface FindingListItem {
  id: string;
  /** 機能の種類（typo・proofread・contradiction など） */
  feature: FindingCategory;
  /** 提案パネルのタブの名前（「矛盾（事実の照合）」など）。古い記録は空 */
  label: string;
  /** 作品フォルダーからの相対 */
  file: string;
  /** 並ぶものは、いまの本文で探し直した行。それ以外は検知したときの行 */
  line: number;
  /** 直す語（無ければ原文）。短く切る */
  quote: string;
  /** 提案（直したあと）。無い指摘（矛盾）は空。短く切る */
  suggestion: string;
  /** なぜ挙げたか。短く切る */
  message: string;
  state: FindingPanelState;
  stateLabel: string;
  /** 検知した（置いた）日時 */
  detectedAt: string;
  /** 作者が判断した日時。判断が無ければ null（戻した判断もここに入る） */
  decidedAt: string | null;
  source: FindingListSource;
  /** 外部AIの接続元の名乗り（自己申告）。製品のAIは null */
  client: string | null;
  /** 製品のAIのプロバイダ（`ollama` など）。外部AIは `external:<接続元>`。記録が無ければ null */
  providerId: string | null;
  /** モデルの名前。記録が無ければ空 */
  model: string;
}

export interface FindingListGroup {
  source: FindingListSource;
  client: string | null;
  providerId: string | null;
  model: string;
  total: number;
  counts: Record<FindingPanelState, number>;
}

export interface FindingListResult {
  kind: "finding";
  /** 読んだ置き場（作品フォルダーからの相対） */
  file: string;
  /** 期限切れと見なした日数（0 は無期限） */
  retentionDays: number;
  /** 置き場の指摘の数（同じ番号は1件に畳んだあと。絞る前） */
  total: number;
  /** 状態ごとの件数（絞る前） */
  counts: Record<FindingPanelState, number>;
  /** 出どころ・モデルごとの件数（絞る前） */
  byProducer: FindingListGroup[];
  /** 絞ったあとの件数 */
  matched: number;
  truncated: boolean;
  /** 並びは未処理（パネルに並ぶもの）が先、それぞれファイル → 行の順 */
  items: FindingListItem[];
  stateLabels: Record<FindingPanelState, string>;
  nextStep: string;
  note: string;
}

export function findingList(input: FindingListInput): FindingListResult {
  const root = nodePath.resolve(input.folder);
  if (!fs.existsSync(root)) {
    throw new McpToolError(`作品フォルダーが見つかりません: ${input.folder}`);
  }
  if (input.source !== undefined && input.source !== "external") {
    throw new McpToolError(
      `kind: finding で絞れる source は external（外部AIから）だけです（${input.source} は設定資料の承認待ちの出どころです）。`
    );
  }
  const retentionDays = input.retentionDays ?? DEFAULT_FINDINGS_RETENTION_DAYS;
  const now = new Date();

  const views = readViews(nodePath.join(root, AIWRITER_DIR, FINDINGS_FILE_NAME));
  const texts = readTexts(input.folder, views);

  const all = views.map((view) => toItem(view, texts.get(view.file), retentionDays, now));
  const ordered = [
    ...sortByPlace(all.filter((item) => item.state === "pending")),
    ...sortByPlace(all.filter((item) => item.state !== "pending")),
  ];

  const counts = emptyCounts();
  for (const item of ordered) counts[item.state] += 1;

  const matching = ordered.filter(
    (item) => !input.source || item.source === input.source
  );

  return {
    kind: "finding",
    file: `${AIWRITER_DIR}/${FINDINGS_FILE_NAME}`,
    retentionDays,
    total: ordered.length,
    counts,
    byProducer: groupByProducer(ordered),
    matched: matching.length,
    truncated: matching.length > input.limit,
    items: matching.slice(0, input.limit),
    stateLabels: { ...FINDING_PANEL_STATE_LABELS },
    nextStep:
      "採否は作者が VS Code の提案パネル（またはシーンメモ）で決めます。",
    note:
      "読むだけです。採用・却下・片づけはしていません。状態の決め方は提案パネルと同じ関数を通しています。" +
      `期限切れは ${retentionDays === 0 ? "無期限（隠さない）" : `${retentionDays}日`} で判定しました` +
      "（VS Code の設定 novelai.findings.retentionDays と違えば retentionDays に同じ値を渡すと画面と揃います）。" +
      "「古い指摘を片づける」で消えた分は数えていません。",
  };
}

/** 置き場を読み、同じ番号を畳んで判断と突き合わせる。**無ければ空**（まだ何も残っていない） */
function readViews(target: string): FindingView[] {
  let text: string;
  try {
    text = fs.readFileSync(target, "utf8");
  } catch {
    return [];
  }
  return resolveFindings(parseFindingLines(text));
}

/**
 * 指摘が指す本文を読む（鍵は `Finding.file` のまま。製品の `readTexts` と同じ）。
 *
 * **判断の済んだもの・期限切れのものの本文は読まない**——位置を探す必要が無い。
 * 読めないファイル（移した・消した・作品の外・競合マーカー）は入れない
 * ——その指摘は `unchecked`（「消えた」ではなく「まだ見ていない」）。
 */
function readTexts(folder: string, views: readonly FindingView[]): Map<string, string> {
  const texts = new Map<string, string>();
  const files = new Set(
    views.filter((view) => view.status === "pending").map((view) => view.file)
  );
  for (const file of files) {
    try {
      texts.set(file, readBody(folder, file));
    } catch {
      // 読めなければ見送る（製品も騒がない）
    }
  }
  return texts;
}

function toItem(
  view: FindingView,
  text: string | undefined,
  retentionDays: number,
  now: Date
): FindingListItem {
  const { state, line } = findingPanelStateOf(view, text, retentionDays, now);
  const external = view.origin?.kind === "external";
  return {
    id: view.id,
    feature: view.category,
    label: view.label,
    file: view.file,
    line,
    quote: clip(view.target || view.original, QUOTE_CHARS),
    suggestion: clip(view.suggestion, SUGGESTION_CHARS),
    message: clip(view.message, MESSAGE_CHARS),
    state,
    stateLabel: FINDING_PANEL_STATE_LABELS[state],
    detectedAt: view.time,
    decidedAt: view.decision?.time ?? null,
    source: external ? "external" : "internal",
    client: external ? view.origin?.client ?? "" : null,
    providerId: view.producer?.providerId ?? null,
    // 外から置いた指摘は名乗ったモデルを先に見る（`producer` はモデル名があるときだけ持つ）
    model: (external ? view.origin?.model : "") || view.producer?.model || "",
  };
}

/**
 * 出どころ・モデルごとに数える。
 *
 * **鍵は 出どころ＋接続元（またはプロバイダ）＋モデル。** 同じモデル名でも
 * 製品のAIと外部AIは別に数える（当たり率を比べたいのはその違いである）。
 */
function groupByProducer(items: readonly FindingListItem[]): FindingListGroup[] {
  const groups = new Map<string, FindingListGroup>();
  for (const item of items) {
    const key = JSON.stringify([item.source, item.client, item.providerId, item.model]);
    let group = groups.get(key);
    if (!group) {
      group = {
        source: item.source,
        client: item.client,
        providerId: item.providerId,
        model: item.model,
        total: 0,
        counts: emptyCounts(),
      };
      groups.set(key, group);
    }
    group.total += 1;
    group.counts[item.state] += 1;
  }
  return [...groups.values()].sort(
    (a, b) => b.total - a.total || a.model.localeCompare(b.model)
  );
}

function emptyCounts(): Record<FindingPanelState, number> {
  const counts = {} as Record<FindingPanelState, number>;
  for (const state of FINDING_PANEL_STATES) counts[state] = 0;
  return counts;
}

/** パネルと同じ **ファイル → 行** の順（`locateFindings` と同じ並べ方） */
function sortByPlace(items: FindingListItem[]): FindingListItem[] {
  return items.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}
