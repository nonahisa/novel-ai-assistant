/**
 * 外部AIが置く「台帳の案」（章立て・伏線・予定の段）。作者の裁定 2026-10-16 の5、設計書6.87.24。
 *
 * **採否は作者。** 外部AI（MCP `novel.propose` の `kind: chapter・foreshadow・schedule`）は
 * `.aiwriter/pending-ledger/` に1件1ファイルで案を置くだけで、台帳（`設定/章立て.json`・
 * `設定/foreshadows/`・`設定/スケジュール.json`）には触れない。作者が提案パネルで
 * 採ったときだけ、拡張機能が今のコマンドと同じ書き方で台帳へ書く
 * （`features/ledgerProposals.ts`）。外部AIが自分の案を承認する口は無い。
 *
 * **置いたときに見た値を一緒に持つ**（`currentName`・`fromStatus`・`before`）。作者が
 * 案を見る前に台帳を手で直していたら、採る時点で食い違いに気づいて止める
 * ——古い案で作者の直しを上書きしない（実装ルール2）。
 *
 * **壊れたファイルは直さない。** 読めなければ例外を投げ、呼ぶ側が並べずに断る。
 *
 * VS Code API には依存しない（`models` の約束。MCP の束からも読む）。
 */

import type { ForeshadowStatus } from "./foreshadow";
import type { StepStatus } from "./schedule";

/** `.aiwriter/` の直下。**同期する**（承認待ちと同じ。作者が別の機械で採れる） */
export const PENDING_LEDGER_DIR = "pending-ledger";
export const LEDGER_PROPOSAL_SCHEMA_VERSION = "1";

/** 段の欄のうち、案で変えられるもの（作者のメモ・並行・動かす人は変えさせない） */
export interface LedgerStepFields {
  label: string;
  days: number;
  due: string | null;
  status: StepStatus;
}

export type LedgerProposal =
  | {
      type: "chapter";
      /** 章を始める話（作品フォルダーからの相対。区切りは `/`。`Chapter.startEpisodePath` と同じ形） */
      startEpisodePath: string;
      name: string;
      /** 置いたときにその話から始まっていた章の名前。無ければ null（＝新しい章を始める案） */
      currentName: string | null;
    }
  | {
      type: "foreshadowAdd";
      label: string;
      note: string;
      plantedChapter: number | null;
      /** 張った箇所の本文の一続きの引用（置くときに本文と照らしてある）。無ければ空 */
      plantedQuote: string;
    }
  | {
      type: "foreshadowStatus";
      foreshadowId: string;
      /** 置いたときの伏線の名（画面に出す） */
      label: string;
      /** 置いたときの状態 */
      fromStatus: ForeshadowStatus;
      status: ForeshadowStatus;
      resolvedChapter: number | null;
      resolvedQuote: string;
    }
  | {
      type: "scheduleStep";
      scheduleId: string;
      /** 置いたときのスケジュールの名前（画面に出す） */
      scheduleName: string;
      /** 直す段の ID。**null なら段を足す案** */
      stepId: string | null;
      /** 直す段の、置いたときの名前（足す案では足す段の名前） */
      stepLabel: string;
      /** 足す案だけ：この段の後ろへ（null なら先頭） */
      afterStepId: string | null;
      /** 直す案だけ：置いたときの値（`patch` に入れた欄だけ） */
      before: Partial<LedgerStepFields> | null;
      /** 変える値（足す案では label と days が入る） */
      patch: Partial<LedgerStepFields>;
    };

export type LedgerProposalType = LedgerProposal["type"];

export interface LedgerProposalFile {
  schemaVersion: string;
  /** ファイル名（拡張子を除く）と同じ */
  id: string;
  createdAt: string;
  source: "external";
  /** 置いた接続元の名乗り（自己申告。身元の証明ではない） */
  client: string;
  /** なぜそう提案するか（作者が採否を決める材料） */
  reason: string;
  proposal: LedgerProposal;
}

const FORESHADOW_STATUS_VALUES: readonly ForeshadowStatus[] = ["open", "resolved", "intentional"];
const STEP_STATUS_VALUES: readonly StepStatus[] = ["todo", "doing", "done"];

/** ファイル名に使える ID か（置き場の外を指させない） */
export function isLedgerProposalId(value: string): boolean {
  return /^[a-zA-Z]+-[0-9a-f]{8,64}$/.test(value);
}

/** 案1件を読む。**形が合わなければ例外**（直さない） */
export function parseLedgerProposalFile(raw: unknown): LedgerProposalFile {
  const value = objectOf(raw, "案");
  const id = text(value.id, "id");
  if (!isLedgerProposalId(id)) fail(`id「${id}」の形が正しくありません。`);
  if (value.source !== "external") fail("source は external だけです。");
  return {
    schemaVersion:
      typeof value.schemaVersion === "string" ? value.schemaVersion : LEDGER_PROPOSAL_SCHEMA_VERSION,
    id,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    source: "external",
    client: typeof value.client === "string" ? value.client : "",
    reason: text(value.reason, "reason"),
    proposal: parseProposal(value.proposal),
  };
}

function parseProposal(raw: unknown): LedgerProposal {
  const value = objectOf(raw, "proposal");
  switch (value.type) {
    case "chapter":
      return {
        type: "chapter",
        startEpisodePath: text(value.startEpisodePath, "startEpisodePath").replace(/\\/g, "/"),
        name: text(value.name, "name"),
        currentName: value.currentName == null ? null : text(value.currentName, "currentName"),
      };
    case "foreshadowAdd":
      return {
        type: "foreshadowAdd",
        label: text(value.label, "label"),
        note: typeof value.note === "string" ? value.note : "",
        plantedChapter: chapterOrNull(value.plantedChapter, "plantedChapter"),
        plantedQuote: typeof value.plantedQuote === "string" ? value.plantedQuote : "",
      };
    case "foreshadowStatus":
      return {
        type: "foreshadowStatus",
        foreshadowId: text(value.foreshadowId, "foreshadowId"),
        label: typeof value.label === "string" ? value.label : "",
        fromStatus: oneOf(value.fromStatus, FORESHADOW_STATUS_VALUES, "fromStatus"),
        status: oneOf(value.status, FORESHADOW_STATUS_VALUES, "status"),
        resolvedChapter: chapterOrNull(value.resolvedChapter, "resolvedChapter"),
        resolvedQuote: typeof value.resolvedQuote === "string" ? value.resolvedQuote : "",
      };
    case "scheduleStep": {
      const stepId = value.stepId == null ? null : text(value.stepId, "stepId");
      const patch = stepFields(value.patch, "patch");
      if (Object.keys(patch).length === 0) fail("patch に変える値がありません。");
      if (stepId === null && (patch.label === undefined || patch.days === undefined)) {
        fail("段を足す案には label と days が要ります。");
      }
      return {
        type: "scheduleStep",
        scheduleId: text(value.scheduleId, "scheduleId"),
        scheduleName: typeof value.scheduleName === "string" ? value.scheduleName : "",
        stepId,
        stepLabel: typeof value.stepLabel === "string" ? value.stepLabel : "",
        afterStepId: value.afterStepId == null ? null : text(value.afterStepId, "afterStepId"),
        before: value.before == null ? null : stepFields(value.before, "before"),
        patch,
      };
    }
    default:
      return fail(`proposal.type「${String(value.type)}」は知らない種類です。`);
  }
}

function stepFields(raw: unknown, where: string): Partial<LedgerStepFields> {
  const value = objectOf(raw, where);
  const out: Partial<LedgerStepFields> = {};
  if (value.label !== undefined) out.label = text(value.label, `${where}.label`);
  if (value.days !== undefined) {
    if (typeof value.days !== "number" || !Number.isInteger(value.days)) {
      fail(`${where}.days は整数にしてください。`);
    }
    out.days = value.days;
  }
  if (value.due !== undefined) {
    if (value.due !== null && (typeof value.due !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.due))) {
      fail(`${where}.due は YYYY-MM-DD か null にしてください。`);
    }
    out.due = value.due as string | null;
  }
  if (value.status !== undefined) out.status = oneOf(value.status, STEP_STATUS_VALUES, `${where}.status`);
  return out;
}

function objectOf(raw: unknown, where: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(`${where}の形式が正しくありません。`);
  }
  return raw as Record<string, unknown>;
}

function text(raw: unknown, where: string): string {
  if (typeof raw !== "string" || !raw.trim()) fail(`${where} がありません。`);
  return raw.trim();
}

function chapterOrNull(raw: unknown, where: string): number | null {
  if (raw == null) return null;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    fail(`${where} は0以上の整数か null にしてください。`);
  }
  return raw;
}

function oneOf<T extends string>(raw: unknown, values: readonly T[], where: string): T {
  if (typeof raw !== "string" || !(values as readonly string[]).includes(raw)) {
    fail(`${where}「${String(raw)}」は知らない値です。`);
  }
  return raw as T;
}

function fail(message: string): never {
  throw new Error(message);
}
