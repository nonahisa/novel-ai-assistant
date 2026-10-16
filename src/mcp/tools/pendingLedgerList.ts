import * as fs from "node:fs";
import * as nodePath from "node:path";
import { AIWRITER_DIR, DEFAULT_SETTINGS_DIR } from "../../models/types";
import { CHAPTERS_FILE } from "../../models/chapter";
import { SCHEDULE_FILE } from "../../models/schedule";
import {
  PENDING_LEDGER_DIR,
  isLedgerProposalId,
  parseLedgerProposalFile,
  type LedgerProposalFile,
  type LedgerProposalType,
} from "../../models/ledgerProposal";
import { describeLedgerProposal } from "../../core/ledgerProposalPlan";
import { estimateResultTokens, READ_RESULT_TOKEN_BUDGET } from "./payloadBudget";
import type { LedgerProposeKind } from "./proposeLedger";
import { SETTINGS_SUBDIRS, describeError } from "./shared";

/**
 * 外部AIの台帳の案（`.aiwriter/pending-ledger/`。設計書6.87.24）を `pending.list` で返す
 * （2026-10-16 の続き）。
 *
 * 外部AIは `novel.propose kind: chapter・foreshadow・schedule` で案を置けるが、置いた案が
 * まだ残っているか（作者が採ると・見送るとファイルが消える）を読む口が無かった。読めないと、
 * 外部AIは同じ案を置き直そうとして「判断待ちがあります」で断られるまで分からない。
 *
 * **読み方は提案パネル（`features/ledgerProposals.ts` の `loadLedgerProposals`）と揃える**：
 * 同じ `parseLedgerProposalFile` を通し、ファイル名と id が食い違うものは並べない。
 * パネルに並ばない案を MCP だけ「ある」と返すと、外部AIと作者で見えるものがずれる。
 * 文（見出し・中身）も同じ `describeLedgerProposal` を通す（写しを作らない）。
 * `features/` は `vscode` を持つので import せず、Node の `fs` で同じ手順を踏む。
 *
 * **読むだけ。** 採る・見送るは作者が提案パネルで決める。壊れた案は直さず消さない。
 */

/** 置き場（作品フォルダーからの相対。返事にそのまま出す） */
const LEDGER_RELATIVE = `${AIWRITER_DIR}/${PENDING_LEDGER_DIR}`;

/** 案の形（`proposal.type`）を、置いたときの `novel.propose` の kind に畳む */
const KIND_OF_TYPE: Record<LedgerProposalType, LedgerProposeKind> = {
  chapter: "chapter",
  foreshadowAdd: "foreshadow",
  foreshadowStatus: "foreshadow",
  scheduleStep: "schedule",
};

export interface PendingLedgerItem {
  /** 案のファイル（作品フォルダーからの相対） */
  file: string;
  id: string;
  /** 置いたときの `novel.propose` の kind */
  kind: LedgerProposeKind;
  /** 案の形（伏線は登録 foreshadowAdd と状態 foreshadowStatus、予定は段 scheduleStep） */
  proposalType: LedgerProposalType;
  /** 置いた時刻（ISO 8601） */
  createdAt: string;
  source: "external";
  /** 置いた接続元の名乗り（自己申告） */
  client: string;
  reason: string;
  /** 提案パネルの見出し・中身・一行の要約（パネルと同じ文） */
  name: string;
  changes: string[];
  summary: string;
  /** どの台帳の何を指すか */
  target: Record<string, string | null>;
  /**
   * 置いたときに見た台帳の値（作者が採る直前に、いまの台帳と照らす値）。
   * 新しく登録する伏線の案は照らす値が無いので null
   */
  placed: Record<string, unknown> | null;
  /** 案が入れる値 */
  proposed: Record<string, unknown>;
}

export interface PendingLedgerListResult {
  /** 読めた案の数（絞ったあと。読めない案は入れない——提案パネルに並ぶ数と揃える） */
  total: number;
  offset: number;
  truncated: boolean;
  /** 続きを読む印。同じ引数に `ledgerOffset` を足して呼び直す */
  next: { ledgerOffset: number } | null;
  /** 並びは置いた時刻の順（提案パネルと同じ） */
  items: PendingLedgerItem[];
  /** 読めない案（壊れたJSON・知らない形・ファイル名と id の食い違い）。**直さず残す** */
  unreadable: Array<{ file: string; message: string }>;
  notices: string[];
}

/** 置き場の案を全部読む。読めないものは `unreadable` へ積み、直さない */
export function readPendingLedgerFs(folder: string): {
  proposals: Array<{ file: string; proposal: LedgerProposalFile }>;
  unreadable: Array<{ file: string; message: string }>;
} {
  const directory = nodePath.join(nodePath.resolve(folder), AIWRITER_DIR, PENDING_LEDGER_DIR);
  const proposals: Array<{ file: string; proposal: LedgerProposalFile }> = [];
  const unreadable: Array<{ file: string; message: string }> = [];
  let names: string[];
  try {
    names = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name);
  } catch {
    // 置き場が無い＝案が無い
    return { proposals, unreadable };
  }
  for (const name of names) {
    const relative = `${LEDGER_RELATIVE}/${name}`;
    const id = name.slice(0, -".json".length);
    try {
      const parsed = parseLedgerProposalFile(
        JSON.parse(fs.readFileSync(nodePath.join(directory, name), "utf8"))
      );
      // 提案パネルと同じ条件（中の id とファイル名が食い違うものは並べない）
      if (parsed.id !== id || !isLedgerProposalId(id)) {
        throw new Error("ファイル名と id が食い違っています。");
      }
      proposals.push({ file: relative, proposal: parsed });
    } catch (error) {
      unreadable.push({ file: relative, message: describeError(error) });
    }
  }
  proposals.sort((left, right) => left.proposal.createdAt.localeCompare(right.proposal.createdAt));
  return { proposals, unreadable };
}

function itemOf(file: string, proposalFile: LedgerProposalFile): PendingLedgerItem {
  const view = describeLedgerProposal(proposalFile);
  const p = proposalFile.proposal;
  const base = {
    file,
    id: proposalFile.id,
    kind: KIND_OF_TYPE[p.type],
    proposalType: p.type,
    createdAt: proposalFile.createdAt,
    source: proposalFile.source,
    client: proposalFile.client,
    reason: proposalFile.reason,
    name: view.name,
    changes: view.changes,
    summary: view.summary,
  };
  // 伏線は1件1ファイルで、ファイル名に名前が入る（名前が変わると変わる）ので、置き場と id で指す
  const foreshadowLedger = `${DEFAULT_SETTINGS_DIR}/${SETTINGS_SUBDIRS.foreshadows}/`;
  switch (p.type) {
    case "chapter":
      return {
        ...base,
        target: { ledger: `${DEFAULT_SETTINGS_DIR}/${CHAPTERS_FILE}`, startEpisodePath: p.startEpisodePath },
        placed: { currentName: p.currentName },
        proposed: { name: p.name },
      };
    case "foreshadowAdd":
      return {
        ...base,
        target: { ledger: foreshadowLedger },
        placed: null,
        proposed: {
          label: p.label,
          note: p.note,
          plantedChapter: p.plantedChapter,
          plantedQuote: p.plantedQuote,
        },
      };
    case "foreshadowStatus":
      return {
        ...base,
        target: { ledger: foreshadowLedger, foreshadowId: p.foreshadowId },
        placed: { status: p.fromStatus },
        proposed: {
          status: p.status,
          resolvedChapter: p.resolvedChapter,
          resolvedQuote: p.resolvedQuote,
        },
      };
    case "scheduleStep":
      return {
        ...base,
        target: {
          ledger: `${DEFAULT_SETTINGS_DIR}/${SCHEDULE_FILE}`,
          scheduleId: p.scheduleId,
          stepId: p.stepId,
          // 足す案だけ、どの段の後ろへ足すか（null なら先頭）
          ...(p.stepId === null ? { afterStepId: p.afterStepId } : {}),
        },
        placed: p.before,
        proposed: { ...p.patch },
      };
  }
}

/** 返さないとき（絞り方が台帳の案に当たらない）の空の欄 */
export function emptyPendingLedgerList(): PendingLedgerListResult {
  return { total: 0, offset: 0, truncated: false, next: null, items: [], unreadable: [], notices: [] };
}

/**
 * 台帳の案の欄を、**返事全体が大きさの上限に収まるよう**に組む（`read.ts` の年表・予定と同じ作法）。
 *
 * 1件ずつ足して、上限（`READ_RESULT_TOKEN_BUDGET`）を超える手前で止める。**最低1件は返す**
 * ——0件で続きを示すと、同じ所で永遠に止まる。大きさは返事全体（ほかの承認待ちを含む）で
 * 見積もる。呼び出し側で切られるのは返事全体だから。
 *
 * @param compose 台帳の案の欄を受け取って、返事全体を組む関数
 */
export function fitPendingLedgerList<T>(
  read: ReturnType<typeof readPendingLedgerFs>,
  filter: (kind: LedgerProposeKind) => boolean,
  offsetInput: number | undefined,
  compose: (ledger: PendingLedgerListResult) => T
): T {
  const items = read.proposals
    .map((entry) => itemOf(entry.file, entry.proposal))
    .filter((item) => filter(item.kind));
  const offset = offsetInput ?? 0;
  const candidates = items.slice(offset);
  const section = (count: number): PendingLedgerListResult => {
    const page = candidates.slice(0, count);
    const nextOffset = offset + page.length;
    const truncated = nextOffset < items.length;
    return {
      total: items.length,
      offset,
      truncated,
      next: truncated ? { ledgerOffset: nextOffset } : null,
      items: page,
      unreadable: read.unreadable,
      notices: [
        ...(truncated
          ? [
              `全${items.length}件の台帳の案のうち${offset + 1}〜${nextOffset}件目を返しました。` +
                `続きは ledgerOffset: ${nextOffset} で読めます（ほかの引数は同じまま）。`,
            ]
          : []),
        ...(offset > 0 && offset >= items.length
          ? [`ledgerOffset（${offset}）が台帳の案の件数（${items.length}）を超えています。`]
          : []),
      ],
    };
  };
  let count = Math.min(1, candidates.length);
  while (
    count < candidates.length &&
    estimateResultTokens(compose(section(count + 1))) <= READ_RESULT_TOKEN_BUDGET
  ) {
    count++;
  }
  const ledger = section(count);
  if (count === 1 && estimateResultTokens(compose(ledger)) > READ_RESULT_TOKEN_BUDGET) {
    ledger.notices.push(
      `${offset + 1}件目の台帳の案だけで返事の大きさの目安を超えています。呼び出し側で切られることがあります。`
    );
  }
  return compose(ledger);
}
