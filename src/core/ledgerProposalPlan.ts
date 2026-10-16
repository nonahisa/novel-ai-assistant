import {
  findChapterStartingAt,
  withChapterStartingAt,
  type ChapterSet,
} from "../models/chapter";
import type { Foreshadow, ForeshadowStatus } from "../models/foreshadow";
import { STEP_STATUS_LABELS, type ScheduleFile } from "../models/schedule";
import type {
  LedgerProposal,
  LedgerProposalFile,
  LedgerStepFields,
} from "../models/ledgerProposal";
import { addStep, updateStep, type StepPatch } from "./scheduleEdit";
import type { IdMaker } from "./scheduleTemplates";

/**
 * 外部AIの「台帳の案」（章立て・伏線・予定の段。設計書6.87.24）を、いまの台帳に
 * 当てたらどうなるかを決める。**書かない**——書くのは呼ぶ側（拡張機能は採ったとき、
 * MCP は置く前の検算だけ）。
 *
 * 置くときと採るときで**同じ関数**を通す。置くときに通った案が、採るときに別の理由で
 * 落ちるのは「そのあいだに台帳が変わった」ときだけになる。
 *
 * 台帳の書き換え方は今のコマンドと同じ関数（章＝`withChapterStartingAt`、
 * 予定＝`updateStep`・`addStep`）。伏線は `foreshadowStore` の口が書くので、ここでは
 * 採ってよいかだけを見る。
 *
 * VS Code API には依存しない。
 */

export type PlanResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/** 伏線の状態の呼び名（`features/foreshadows.ts` の選ぶ画面と同じ言葉） */
export const FORESHADOW_STATUS_LABELS: Record<ForeshadowStatus, string> = {
  open: "未回収",
  resolved: "回収済み",
  intentional: "意図して開けたまま",
};

/** 台帳が案を置いたあとで変わっていたときの言い方（3つの台帳で揃える） */
function changedSince(what: string, detail: string): string {
  return (
    `案を置いたあとで${what}が変わっています（${detail}）。` +
    "作者の直しを古い案で上書きしないよう、反映しませんでした。必要なら外部AIにもう一度提案させてください。"
  );
}

/* ── 章 ─────────────────────────────────────── */

/**
 * 章の案を当てた章立て。**その話から始まる章があれば改名**（手動の「ここから章を始める」と
 * 同じ約束。設計書6.66.2）。
 */
export function planChapterProposal(
  set: ChapterSet,
  proposal: Extract<LedgerProposal, { type: "chapter" }>
): PlanResult<ChapterSet> {
  const existing = findChapterStartingAt(set.chapters, proposal.startEpisodePath);
  const currentName = existing?.name ?? null;
  if (currentName !== proposal.currentName) {
    return {
      ok: false,
      reason: changedSince(
        "章立て",
        `置いたとき：${proposal.currentName === null ? "章なし" : `「${proposal.currentName}」`}、` +
          `いま：${currentName === null ? "章なし" : `「${currentName}」`}`
      ),
    };
  }
  if (currentName === proposal.name) {
    return { ok: false, reason: `章の名前は既に「${proposal.name}」です。変えるものがありません。` };
  }
  return {
    ok: true,
    value: {
      ...set,
      chapters: withChapterStartingAt(set.chapters, proposal.startEpisodePath, proposal.name),
    },
  };
}

/* ── 伏線 ─────────────────────────────────────── */

/** 伏線を足す案を採ってよいか。同じ名の伏線が既にあれば断る（二重に登録しない） */
export function checkForeshadowAdd(
  records: readonly Foreshadow[],
  proposal: Extract<LedgerProposal, { type: "foreshadowAdd" }>
): string | undefined {
  const same = records.find((record) => record.label.trim() === proposal.label.trim());
  return same
    ? `「${proposal.label}」という伏線は既にあります（${same.id}）。状態を変える案なら foreshadowId を渡してください。`
    : undefined;
}

/** 伏線の状態を変える案を採ってよいか。置いたときの状態と違えば断る */
export function checkForeshadowStatus(
  current: Foreshadow | undefined,
  proposal: Extract<LedgerProposal, { type: "foreshadowStatus" }>
): string | undefined {
  if (!current) {
    return `伏線「${proposal.label || proposal.foreshadowId}」が台帳にありません（消されたか、読めないファイルの中にあります）。`;
  }
  if (current.status !== proposal.fromStatus) {
    return changedSince(
      "伏線の状態",
      `置いたとき：${FORESHADOW_STATUS_LABELS[proposal.fromStatus]}、いま：${FORESHADOW_STATUS_LABELS[current.status]}`
    );
  }
  if (
    current.status === proposal.status &&
    (proposal.status !== "resolved" || current.resolvedChapter === proposal.resolvedChapter)
  ) {
    return `伏線「${current.label}」は既に${FORESHADOW_STATUS_LABELS[proposal.status]}です。変えるものがありません。`;
  }
  return undefined;
}

/* ── 予定の段 ─────────────────────────────────────── */

/**
 * 予定の段の案を当てたスケジュール。**直す案は、置いたときの値（`before`）といまの値が
 * 揃っているときだけ**当てる。値の確かめは今の画面と同じ `updateStep`・`addStep`
 * （形が合わなければ日本語の理由で断る）。
 */
export function planScheduleStepProposal(
  file: ScheduleFile,
  proposal: Extract<LedgerProposal, { type: "scheduleStep" }>,
  clock: { today: string; now: string; makeId: IdMaker }
): PlanResult<ScheduleFile> {
  const schedule = file.schedules.find((entry) => entry.id === proposal.scheduleId);
  if (!schedule) {
    return {
      ok: false,
      reason: `スケジュール「${proposal.scheduleName || proposal.scheduleId}」がありません（消されたか、まだファイルに無い予定です）。`,
    };
  }
  try {
    if (proposal.stepId === null) {
      if (proposal.afterStepId !== null && !schedule.steps.some((step) => step.id === proposal.afterStepId)) {
        return { ok: false, reason: changedSince("予定", "足す位置の段がありません") };
      }
      return {
        ok: true,
        value: addStep(
          file,
          schedule.id,
          {
            label: proposal.patch.label ?? "",
            days: proposal.patch.days ?? 0,
            afterStepId: proposal.afterStepId,
          },
          clock.makeId,
          clock.now
        ),
      };
    }
    const step = schedule.steps.find((entry) => entry.id === proposal.stepId);
    if (!step) {
      return { ok: false, reason: `段「${proposal.stepLabel || proposal.stepId}」がありません（消されたようです）。` };
    }
    const keys = Object.keys(proposal.patch) as Array<keyof LedgerStepFields>;
    const moved = keys.filter((key) => proposal.before && proposal.before[key] !== step[key]);
    if (moved.length > 0) {
      return {
        ok: false,
        reason: changedSince(
          "予定",
          moved.map((key) => `${STEP_FIELD_LABELS[key]}：置いたとき ${show(key, proposal.before?.[key])}、いま ${show(key, step[key])}`).join("／")
        ),
      };
    }
    if (keys.every((key) => proposal.patch[key] === step[key])) {
      return { ok: false, reason: `段「${step.label}」は既にその値です。変えるものがありません。` };
    }
    const patch: StepPatch = { ...proposal.patch };
    return { ok: true, value: updateStep(file, schedule.id, step.id, patch, clock.today, clock.now) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

const STEP_FIELD_LABELS: Record<keyof LedgerStepFields, string> = {
  label: "名前",
  days: "日数",
  due: "期日",
  status: "状態",
};

function show(key: keyof LedgerStepFields, value: unknown): string {
  if (value === null || value === undefined) return key === "due" ? "（逆算）" : "（なし）";
  if (key === "status") return STEP_STATUS_LABELS[value as keyof typeof STEP_STATUS_LABELS] ?? String(value);
  if (key === "days") return `${String(value)}日`;
  return String(value);
}

/* ── 画面に出す言葉 ─────────────────────────────── */

export interface LedgerProposalView {
  /** 一覧の見出し（「章：第一章　出立」） */
  name: string;
  /** 何が変わるか。1行ずつ */
  changes: string[];
  /** 「反映する」の代わりの言葉 */
  applyLabel: string;
  /** 記録に残す短い言い方 */
  summary: string;
}

/** 提案パネルの1行に出す中身 */
export function describeLedgerProposal(file: LedgerProposalFile): LedgerProposalView {
  const p = file.proposal;
  const reason = `理由：${file.reason}`;
  switch (p.type) {
    case "chapter": {
      const where = episodeLabelOf(p.startEpisodePath);
      return p.currentName === null
        ? {
            name: `章：${p.name}`,
            changes: [`「${where}」から章「${p.name}」を始めます。`, reason],
            applyLabel: "章にする",
            summary: `章「${p.name}」を${where}から始める`,
          }
        : {
            name: `章：${p.name}`,
            changes: [`章「${p.currentName}」の名前を「${p.name}」に変えます（${where}から始まる章）。`, reason],
            applyLabel: "名前を変える",
            summary: `章「${p.currentName}」を「${p.name}」に改名`,
          };
    }
    case "foreshadowAdd":
      return {
        name: `伏線：${p.label}`,
        changes: [
          `伏線「${p.label}」を登録します。`,
          ...(p.note ? [`何を示唆しているか：${p.note}`] : []),
          `張った話：${p.plantedChapter === null ? "話数不明" : `第${p.plantedChapter}話`}`,
          ...(p.plantedQuote ? [`張った箇所：「${p.plantedQuote}」`] : []),
          reason,
        ],
        applyLabel: "登録する",
        summary: `伏線「${p.label}」を登録`,
      };
    case "foreshadowStatus":
      return {
        name: `伏線：${p.label || p.foreshadowId}`,
        changes: [
          `状態を${FORESHADOW_STATUS_LABELS[p.fromStatus]}から${FORESHADOW_STATUS_LABELS[p.status]}に変えます。`,
          ...(p.status === "resolved"
            ? [`回収した話：${p.resolvedChapter === null ? "話数不明" : `第${p.resolvedChapter}話`}`]
            : []),
          ...(p.status === "resolved" && p.resolvedQuote ? [`回収の箇所：「${p.resolvedQuote}」`] : []),
          reason,
        ],
        applyLabel: "状態を変える",
        summary: `伏線「${p.label || p.foreshadowId}」を${FORESHADOW_STATUS_LABELS[p.status]}に`,
      };
    case "scheduleStep": {
      const where = p.scheduleName || p.scheduleId;
      if (p.stepId === null) {
        return {
          name: `予定：${where} › ${p.patch.label ?? ""}`,
          changes: [
            `「${where}」に段「${p.patch.label ?? ""}」（${p.patch.days ?? 0}日）を足します（未着手・期日は逆算）。`,
            reason,
          ],
          applyLabel: "段を足す",
          summary: `予定「${where}」に段「${p.patch.label ?? ""}」を足す`,
        };
      }
      const keys = Object.keys(p.patch) as Array<keyof LedgerStepFields>;
      return {
        name: `予定：${where} › ${p.stepLabel}`,
        changes: [
          ...keys.map(
            (key) => `${STEP_FIELD_LABELS[key]}：${show(key, p.before?.[key])} → ${show(key, p.patch[key])}`
          ),
          reason,
        ],
        applyLabel: "予定を直す",
        summary: `予定「${where}」の段「${p.stepLabel}」を直す`,
      };
    }
  }
}

/** 話の指し方（`本文/012_港.txt`）から、画面に出す名前（ファイル名）へ */
function episodeLabelOf(startEpisodePath: string): string {
  const parts = startEpisodePath.split("/");
  return parts[parts.length - 1] || startEpisodePath;
}
