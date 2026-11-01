import type * as vscode from "vscode";
import type { ProposalView } from "../models/proposal";

/**
 * 編集者の側で「もう知らせた作者の採否」を覚える（作者の判断 2026-11-01「届いたら知らせる」）。
 *
 * **覚えは拡張機能の保管（`globalState`）に置く。** 作品フォルダーに書くと、編集者の写しに
 * 記録されない変更が増え、取り込みを止める（`editorGitignoreRescue.ts` と同じ理由）。
 *
 * 書くのは確かめる包み（`verifiedState`。設計書5.7.8）を通した保管で、`extension.ts` が包んで渡す。
 * 消えても起きるのは同じ知らせがもう一度出ることだけだが、鍵ごとの見張り（`mementoWrites.test.ts`）に揃える。
 *
 * 同期の後始末（`editingAutomation.ts`）は Node 側の束で動的に読まれるので、
 * `extension.ts` が起動時に保管を1回だけ覚えさせる（`rememberProposalPanel` と同じ形）。
 */

const STORAGE_KEY = "novelai.editorSeenDecisions";

/** 1つの作品につき覚えておく数の上限（古いものから捨てる。提案の数より十分大きい） */
const LIMIT_PER_WORK = 2000;

let memento: vscode.Memento | undefined;

export function rememberDecisionMemory(storage: vscode.Memento): void {
  memento = storage;
}

/** 試験で差し替えられる口 */
export interface DecisionMemory {
  seen(workId: string): ReadonlySet<string>;
  add(workId: string, keys: readonly string[]): Promise<void>;
}

export const globalDecisionMemory: DecisionMemory = {
  seen(workId) {
    const all = memento?.get<Record<string, string[]>>(STORAGE_KEY) ?? {};
    return new Set(Array.isArray(all[workId]) ? all[workId] : []);
  },
  async add(workId, keys) {
    if (!memento || keys.length === 0) return;
    const all = { ...(memento.get<Record<string, string[]>>(STORAGE_KEY) ?? {}) };
    const merged = [...new Set([...(all[workId] ?? []), ...keys])];
    all[workId] = merged.slice(-LIMIT_PER_WORK);
    await memento.update(STORAGE_KEY, all);
  },
};

/**
 * 採否1件を見分ける鍵。**決め直し（見送り → 採用）は別の鍵になる**ので、もう一度知らせる。
 * 時刻だけでなく状態も混ぜるのは、同じ時刻の書き直しを見落とさないため。
 */
export function decisionKey(view: ProposalView): string | undefined {
  const decision = view.decision;
  if (!decision) return undefined;
  return `${decision.proposalId}|${decision.time}|${decision.status}`;
}
