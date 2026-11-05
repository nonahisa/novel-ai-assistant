import * as paths from "./pathText";
import { actorLabel } from "../models/actor";
import type { EditHistoryEntry } from "./editHistoryFormat";
import {
  dedupeExternalAccess,
  describeExternalAccess,
  type ExternalAccessEntry,
} from "./externalAccessLog";
import { findingCategoryLabel } from "./sceneMemoRows";
import type { FindingView } from "../models/finding";
import type { ProposalView } from "../models/proposal";
import { postingSiteInfo, type PostingLedger } from "../models/posting";

/**
 * VS Code の「タイムライン」欄に、話ごとの記録を並べる（設計書6.119）。
 *
 * **VS Code に依存しない。** 記録を読むのは features の側
 * （`features/episodeTimeline.ts`）で、ここは読んだものを並べて項目にするだけ。
 * 何を出すか・どの話の記録と見なすかを、画面を起こさずに試せるようにした。
 *
 * **新しく記録は作らない。** どれも既にある記録を読むだけである。
 */

/** 押したときに渡す先。合う画面が無い種類は持たない（押しても何も起きない） */
export type TimelineOpenTarget =
  | "editHistory"
  | "editorProposals"
  | "proposalPanel"
  | "recovery";

export type TimelineEntryKind =
  | "edit"
  | "proposal"
  | "finding"
  | "aiAction"
  | "posting"
  | "external"
  | "recovery";

export interface TimelineEntry {
  /** 欄の中で項目を見分ける番号。同じ記録からは毎回同じ番号になる */
  id: string;
  /** ミリ秒。**新しいものが先**に並ぶ */
  timestamp: number;
  kind: TimelineEntryKind;
  label: string;
  /** 項目の右に薄く出る短い補足 */
  description: string;
  /** 指を置いたときに出る中身（押しても画面が開かない種類も、ここで読める） */
  detail: string;
  open?: TimelineOpenTarget;
  /** 退避の写しの場所（`open: "recovery"` のとき） */
  recoveryPath?: string;
}

/** `ai_actions.log` の1行（`typoIssueHistory.ts` の `appendAiActionLog` が書く形） */
export interface AiActionLine {
  timestamp: string;
  category: string;
  action: string;
  file: string;
  line: number;
  target: string;
  suggestion: string;
}

export interface EpisodeTimelineSources {
  /** 作品フォルダー */
  workFolder: string;
  /** 開いている話のファイル */
  episodePath: string;
  edits?: readonly EditHistoryEntry[];
  proposals?: readonly ProposalView[];
  findings?: readonly FindingView[];
  aiActions?: readonly AiActionLine[];
  posting?: PostingLedger;
  external?: readonly ExternalAccessEntry[];
  /** その話の退避の写し（新しい順でなくてよい。ここで5件に絞る） */
  recoveries?: readonly { path: string; timestamp: number }[];
}

/** 退避の写しは新しいもの5件まで（作られるのも5世代まで。`RECOVERY_GENERATIONS_PER_FILE`） */
export const TIMELINE_RECOVERY_LIMIT = 5;

/**
 * 記録の `file` が、開いている話を指しているか。
 *
 * **記録ごとに書き方が違う**ので、ここ1か所で読み分ける。
 *
 * - 作品フォルダーからの相対（編集履歴・提案・指摘・投稿の台帳）
 * - **名前だけ**（`ai_actions.log`。提案パネルが `basename` を入れている）
 * - 絶対の場所や URI（外の AI の記録。MCP に渡された `filePath` をそのまま残す）
 *
 * 比べるのは `isSamePath`（ブラウザ版の符号化の割れを吸う）。相対を自分で
 * 計算して文字列で比べると、日本語の名前の話が別の場所に見える。
 */
export function recordPointsToEpisode(
  recordFile: string,
  workFolder: string,
  episodePath: string
): boolean {
  const file = recordFile.trim();
  if (!file || !episodePath) return false;
  if (paths.isAbsolute(file) || paths.isUriString(file)) {
    return paths.isSamePath(file, episodePath);
  }
  if (!/[\\/]/.test(file)) {
    // 名前だけの記録は名前どうしで比べる（別のフォルダーの同じ名前の話とは見分けられない）
    return (
      paths.pathKeyForComparison(file) ===
      paths.pathKeyForComparison(paths.basename(episodePath))
    );
  }
  if (!workFolder) return false;
  return paths.isSamePath(
    paths.join(workFolder, ...file.split(/[\\/]+/).filter(Boolean)),
    episodePath
  );
}

/**
 * `ai_actions.log` を読む。**壊れた行は飛ばして、残りを読む。**
 *
 * 時刻は ISO ではなく `formatLogTime` の「2026-11-06 12:34:56」（手元の時刻）。
 */
export function parseAiActionLog(text: string): AiActionLine[] {
  const lines: AiActionLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (typeof record.file !== "string" || typeof record.action !== "string") continue;
    lines.push({
      timestamp: typeof record.timestamp === "string" ? record.timestamp : "",
      category: typeof record.category === "string" ? record.category : "",
      action: record.action,
      file: record.file,
      line: typeof record.line === "number" ? record.line : 0,
      target: typeof record.target === "string" ? record.target : "",
      suggestion: typeof record.suggestion === "string" ? record.suggestion : "",
    });
  }
  return lines;
}

/** 「2026-11-06 12:34:56」を手元の時刻として読む。ISO の形もそのまま読む */
export function parseLogTime(value: string): number | undefined {
  const local = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (local) {
    const [, y, mo, d, h, mi, s] = local.map(Number);
    const time = new Date(y, mo - 1, d, h, mi, s).getTime();
    return Number.isNaN(time) ? undefined : time;
  }
  return isoTime(value);
}

function isoTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

const PROPOSAL_STATUS_LABELS: Record<string, string> = {
  accepted: "採った",
  rejected: "見送った",
  read: "読んだ",
};

const FINDING_STATUS_LABELS: Record<string, string> = {
  accepted: "採った",
  dismissed: "退けた",
  // 判断の取り消し（適用を戻した）は「戻した」と出す（models/finding.ts）
  pending: "戻した",
};

const AI_ACTION_LABELS: Record<string, string> = {
  applied: "反映した",
  dismissed: "無視した",
  reverted: "戻した",
  resolved: "書き直して片付いた",
  foreshadowed: "伏線へ移した",
  asked: "AIに訊いた",
};

const AI_ACTION_CATEGORY_LABELS: Record<string, string> = {
  typo: "誤字",
  contradiction: "矛盾",
};

/** 欄の1行に収める長さ。長い引用で行が埋まらないように */
const QUOTE_LIMIT = 24;

function quote(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > QUOTE_LIMIT ? `${flat.slice(0, QUOTE_LIMIT)}…` : flat;
}

function change(target: string, suggestion: string): string {
  if (target && suggestion) return `「${quote(target)}」→「${quote(suggestion)}」`;
  if (target) return `「${quote(target)}」`;
  return "";
}

function lines(...parts: (string | undefined | false)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join("\n");
}

/**
 * 開いている話の記録を、タイムラインの項目へ並べる。**新しいものが先。**
 *
 * 時刻の読めない記録は出さない（時刻順の欄に置き場所が無い）。
 * 提案と指摘は「出たとき」と「決めたとき」を別の項目にする——採否は
 * 出たときとは別の日に起きることが多く、1つにまとめるとどちらかの時刻が消える。
 */
export function buildEpisodeTimeline(sources: EpisodeTimelineSources): TimelineEntry[] {
  const { workFolder, episodePath } = sources;
  const hits = (file: string) => recordPointsToEpisode(file, workFolder, episodePath);
  const entries: TimelineEntry[] = [];

  (sources.edits ?? []).forEach((edit, index) => {
    if (!hits(edit.file)) return;
    const timestamp = isoTime(edit.time);
    if (timestamp === undefined) return;
    entries.push({
      id: `edit:${edit.time}:${index}`,
      timestamp,
      kind: "edit",
      label: edit.action,
      description: [actorLabel(edit.actor), edit.actorName].filter(Boolean).join(" "),
      detail: lines(`編集履歴：${edit.action}`, edit.actorName && `誰が：${edit.actorName}`, edit.detail),
      open: "editHistory",
    });
  });

  for (const proposal of sources.proposals ?? []) {
    if (!hits(proposal.file)) continue;
    const proposedAt = isoTime(proposal.time);
    const body = lines(
      proposal.line > 0 && `${proposal.line}行`,
      change(proposal.target, proposal.suggestion) || proposal.original && `「${quote(proposal.original)}」`,
      proposal.reason && `理由：${proposal.reason}`
    );
    if (proposedAt !== undefined) {
      entries.push({
        id: `proposal:${proposal.id}`,
        timestamp: proposedAt,
        kind: "proposal",
        label: `編集者の提案 ${change(proposal.target, proposal.suggestion)}`.trim(),
        description: proposal.proposer,
        detail: lines(`編集者の提案（${proposal.proposer || "名前なし"}）`, body),
        open: "editorProposals",
      });
    }
    const decision = proposal.decision;
    const decidedAt = isoTime(decision?.time);
    if (decision && decidedAt !== undefined) {
      const status = PROPOSAL_STATUS_LABELS[decision.status] ?? decision.status;
      entries.push({
        id: `proposalDecision:${proposal.id}:${decision.time}`,
        timestamp: decidedAt,
        kind: "proposal",
        label: `編集者の提案を${status}`,
        description: decision.decidedBy,
        detail: lines(`編集者の提案を${status}`, body, decision.note && `覚え書き：${decision.note}`),
        open: "editorProposals",
      });
    }
  }

  for (const finding of sources.findings ?? []) {
    if (!hits(finding.file)) continue;
    const name = finding.label || findingCategoryLabel(finding.category);
    const body = lines(
      finding.hintLine > 0 && `${finding.hintLine}行`,
      change(finding.target || finding.original, finding.suggestion),
      finding.message
    );
    const foundAt = isoTime(finding.time);
    if (foundAt !== undefined) {
      entries.push({
        id: `finding:${finding.id}`,
        timestamp: foundAt,
        kind: "finding",
        label: `AIの指摘（${name}）${change(finding.target || finding.original, finding.suggestion)}`,
        description: "",
        detail: lines(`AIの指摘（${name}）`, body),
        open: "proposalPanel",
      });
    }
    const decision = finding.decision;
    const decidedAt = isoTime(decision?.time);
    if (decision && decidedAt !== undefined) {
      const status = FINDING_STATUS_LABELS[decision.status] ?? decision.status;
      entries.push({
        id: `findingDecision:${finding.id}:${decision.time}`,
        timestamp: decidedAt,
        kind: "finding",
        label: `AIの指摘（${name}）を${status}`,
        description: "",
        detail: lines(`AIの指摘（${name}）を${status}`, body, decision.note && `覚え書き：${decision.note}`),
        open: "proposalPanel",
      });
    }
  }

  (sources.aiActions ?? []).forEach((action, index) => {
    if (!hits(action.file)) return;
    const timestamp = parseLogTime(action.timestamp);
    if (timestamp === undefined) return;
    const what = AI_ACTION_LABELS[action.action] ?? action.action;
    const category = AI_ACTION_CATEGORY_LABELS[action.category] ?? "指摘";
    entries.push({
      id: `aiAction:${action.timestamp}:${index}`,
      timestamp,
      kind: "aiAction",
      label: `${category}の指摘を${what}`,
      description: action.line > 0 ? `${action.line}行` : "",
      detail: lines(
        `${category}の指摘を${what}`,
        action.line > 0 && `${action.line}行`,
        change(action.target, action.suggestion)
      ),
      open: "proposalPanel",
    });
  });

  const ledger = sources.posting;
  if (ledger) {
    ledger.posts.forEach((post, index) => {
      // 導入したときにまとめて入れた記録は、投稿した日時ではない（台帳の決まり）
      if (post.importedBaseline === true) return;
      if (!hits(post.episodePath)) return;
      const timestamp = isoTime(post.postedAt);
      if (timestamp === undefined) return;
      const site = postingSiteInfo(post.site).label;
      entries.push({
        id: `post:${post.site}:${post.postedAt}:${index}`,
        timestamp,
        kind: "posting",
        label: `${site}へ投稿`,
        description: chapterOf(post.chapter, post.order),
        detail: lines(`${site}へ投稿した記録`, chapterOf(post.chapter, post.order)),
      });
    });
    (ledger.revisions ?? []).forEach((revision, index) => {
      if (!hits(revision.episodePath)) return;
      const timestamp = isoTime(revision.revisedAt);
      if (timestamp === undefined) return;
      const site = postingSiteInfo(revision.site).label;
      entries.push({
        id: `revision:${revision.site}:${revision.revisedAt}:${index}`,
        timestamp,
        kind: "posting",
        label: `${site}へ出し直し`,
        description: chapterOf(revision.chapter, revision.order),
        detail: lines(`${site}へ修正版を出し直した記録`, chapterOf(revision.chapter, revision.order)),
      });
    });
  }

  dedupeExternalAccess(sources.external ?? []).forEach((access, index) => {
    if (!hits(access.file)) return;
    const timestamp = isoTime(access.time);
    if (timestamp === undefined) return;
    entries.push({
      id: `external:${access.time}:${index}`,
      timestamp,
      kind: "external",
      label: `外のAIが使った（${access.tool}）`,
      description: access.client,
      detail: lines(
        "外のAI（MCP）が使った記録",
        access.client && `相手：${access.client}`,
        describeExternalAccess(access)
      ),
      open: "editHistory",
    });
  });

  [...(sources.recoveries ?? [])]
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, TIMELINE_RECOVERY_LIMIT)
    .forEach((recovery) => {
      entries.push({
        id: `recovery:${paths.basename(recovery.path)}`,
        timestamp: recovery.timestamp,
        kind: "recovery",
        label: "書き換える前の控え",
        description: "退避の写し",
        detail: lines(
          "書き換える前の本文の控え（.novelai-recovery）",
          "押すと写しを開きます。本文には触れません"
        ),
        open: "recovery",
        recoveryPath: recovery.path,
      });
    });

  return entries.sort((left, right) => right.timestamp - left.timestamp);
}

function chapterOf(chapter: number | undefined, order: number | undefined): string {
  if (typeof chapter === "number") return `第${chapter}話`;
  if (typeof order === "number") return `${order}番目`;
  return "";
}
