/**
 * 編集部からの提案（設計書5.6）。
 *
 * **編集部は本文を書き換えない。提案として置く**（2026-08-19、作者の判断）。
 *
 * はじめは「編集部も本文を直せる」前提で作っていたが、
 * **作者の意向に反して勝手に書き換えられる**恐れがある。
 * 提案にすれば、
 *
 * - 作者の許可なく本文が変わることが**構造として起きない**
 * - **競合も起きない。** 編集部が触るのは提案のファイルだけで、
 *   本文には一切書き込まない
 *
 * つまり「競合したときどちらを採るか」を考える必要が、そもそも無くなる。
 *
 * **提案は書き換えない。** 承認も却下も**新しい記録を足す**形にする。
 * 1行1件の追記だけなら、複数人が同時に触っても競合しにくい。
 */

export type ProposalStatus = "pending" | "accepted" | "rejected";

export interface Proposal {
  /** 提案を指すための番号。承認・却下の記録がこれを指す */
  id: string;
  /** いつ出したか（ISO 8601） */
  time: string;
  /** 誰が出したか（gitの user.name） */
  proposer: string;
  /** 作品フォルダーからの相対パス */
  file: string;
  /** 何行目か（1始まり） */
  line: number;
  /** その行の、置き換える前の文。**適用前に本文と照合する** */
  original: string;
  /** `original` の中で実際に置き換える範囲 */
  target: string;
  /** 置き換えた後 */
  suggestion: string;
  /** なぜ直したいか。作者が判断するための材料 */
  reason: string;
  /** どの検知から出たか（誤字脱字・表記ゆれ・推敲） */
  category: string;
}

/**
 * 承認・却下の記録。
 *
 * **提案そのものを書き換えず、これを足す。** 履歴が残るし、
 * 追記だけなので競合しにくい。
 */
export interface ProposalDecision {
  proposalId: string;
  time: string;
  /** 決めた人（作者） */
  decidedBy: string;
  status: "accepted" | "rejected";
  /** 却下の理由。作者が編集部へ伝えたいことがあれば */
  note: string;
}

export type ProposalLine =
  | ({ kind: "proposal" } & Proposal)
  | ({ kind: "decision" } & ProposalDecision);

/** 提案と決定を突き合わせた、いまの状態 */
export interface ProposalView extends Proposal {
  status: ProposalStatus;
  /** 決まっていれば、その記録 */
  decision?: ProposalDecision;
}

/**
 * 提案の番号を作る。
 *
 * **同じ内容の提案が二重に出るのを防ぐ。** 同じ場所・同じ直しなら
 * 同じ番号になるので、編集部が2回検知しても提案は1件で済む。
 */
export function proposalId(
  file: string,
  line: number,
  target: string,
  suggestion: string
): string {
  const source = `${file}|${line}|${target}|${suggestion}`;
  // 短い決定的な番号。暗号用途ではないので簡単な畳み込みで足りる
  let hash = 0;
  for (const char of source) {
    hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  }
  return `p${hash.toString(36)}`;
}

/**
 * 提案と決定を突き合わせる。
 *
 * **決定は後から来たものが勝つ。** 作者が却下してから考え直して承認する
 * こともある。追記だけの作りなので、時刻の新しいほうを見る。
 */
export function resolveProposals(lines: ProposalLine[]): ProposalView[] {
  const proposals = new Map<string, Proposal>();
  const decisions = new Map<string, ProposalDecision>();

  for (const line of lines) {
    if (line.kind === "proposal") {
      // 同じ番号が2回来ても、先に来たものを残す（内容は同じはず）
      if (!proposals.has(line.id)) proposals.set(line.id, line);
      continue;
    }
    const existing = decisions.get(line.proposalId);
    if (!existing || isNewer(line.time, existing.time)) {
      decisions.set(line.proposalId, line);
    }
  }

  const views: ProposalView[] = [];
  for (const proposal of proposals.values()) {
    const decision = decisions.get(proposal.id);
    views.push({
      ...proposal,
      status: decision?.status ?? "pending",
      decision,
    });
  }
  // 未決を先に、その中では新しいものを先に
  return views.sort((a, b) => {
    if (a.status !== b.status) {
      if (a.status === "pending") return -1;
      if (b.status === "pending") return 1;
    }
    return compareTimeDesc(a.time, b.time);
  });
}

function isNewer(candidate: string, current: string): boolean {
  const left = Date.parse(candidate);
  const right = Date.parse(current);
  if (Number.isNaN(left)) return false;
  if (Number.isNaN(right)) return true;
  return left > right;
}

function compareTimeDesc(a: string, b: string): number {
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (Number.isNaN(left) && Number.isNaN(right)) return 0;
  if (Number.isNaN(left)) return 1;
  if (Number.isNaN(right)) return -1;
  return right - left;
}
