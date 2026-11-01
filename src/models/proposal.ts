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

/**
 * 提案のいまの状態。
 *
 * **`read` は、意見だけの提案（直した案が空）を作者が読んだ印**（作者の決定 2026-11-01）。
 * 採用（`accepted`）として残すと、編集部の側で意見が「採られた」と数えられる。
 * 意見は本文に当てるものではないので、採ったとも見送ったとも別に数える。
 */
export type ProposalStatus = "pending" | "accepted" | "rejected" | "read";

/** 作者が決めたときに足す状態（未決は記録しない） */
export type ProposalDecisionStatus = Exclude<ProposalStatus, "pending">;

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
  status: ProposalDecisionStatus;
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

/** 採否の内訳。編集部へ返す知らせと、編集者モードの案内で使う */
export interface DecisionCounts {
  accepted: number;
  rejected: number;
  read: number;
  pending: number;
}

/**
 * 採用・見送り・読まれたを数える。
 *
 * **意見だけの提案は、採用に数えない**（作者の決定 2026-11-01）。0.118.0 では
 * ［読んだ］を「採った」（`accepted`）で残していたので、**意見だけの提案に付いた
 * 「採った」も読まれたとして数える**（古い記録の読み方を変えずに、数えだけ直す。
 * 意見には当てる直しが無いので、それを「採った」と読む道は元から無い）。
 */
export function summarizeDecisions(
  views: readonly ProposalView[]
): DecisionCounts {
  const counts: DecisionCounts = { accepted: 0, rejected: 0, read: 0, pending: 0 };
  for (const view of views) {
    if (view.status === "accepted" && isOpinionOnly(view)) {
      counts.read += 1;
    } else {
      counts[view.status] += 1;
    }
  }
  return counts;
}

/** 内訳を「採用 N・見送り N・読まれた N」の形で書く（未決は呼ぶ側が別に言う） */
export function describeDecisionCounts(counts: DecisionCounts): string {
  return `採用 ${counts.accepted}・見送り ${counts.rejected}・読まれた ${counts.read}`;
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

/*
  ── 編集部が手で書く提案（作者の指示 2026-11-01「作る」） ──

  検知の［適用］から来る提案と**同じ台帳・同じ形**に載せる。作者の側は
  提案パネルで、いつもどおり採る／見送るだけで済む。新しい型を足さないのは、
  台帳を読む側（作者の環境・MCP・送り返し）をどこも直さずに済ませるためである。
*/

/** 編集部が手で書いた直しの分類（作者の画面で、検知から来たものと見分ける） */
export const HAND_EDIT_CATEGORY = "編集部の直し";
/** 編集部が「ここにメモを足す」で置いた意見の分類 */
export const HAND_MEMO_CATEGORY = "編集部のメモ";

/** 手で書いた提案の分類か（作者の画面で分類を添えるかを決める） */
export function isHandCategory(category: string): boolean {
  return category === HAND_EDIT_CATEGORY || category === HAND_MEMO_CATEGORY;
}

/**
 * 直した案の無い「意見だけ」の提案か。
 *
 * **`suggestion` が空なら意見だけ**と決める。検知の指摘でも、修正案が空のものは
 * 本文を書き換えない決まり（作者の裁定 2026-10-17。A23）なので、同じ読み方になる。
 * そのため、手書きの提案で「語を消す」直しは表せない（消したいときは理由に書いてもらう）。
 */
export function isOpinionOnly(proposal: { suggestion: string }): boolean {
  return proposal.suggestion === "";
}

/** 提案が本文のどこを指すか。採る側と置く側で同じ照らし方を使う */
export type ProposalLocation =
  | { kind: "found"; at: number }
  /** その行に `original` が無い（届いてから本文が変わった） */
  | { kind: "originalMissing" }
  /** `original` の中に `target` が無い（提案そのものが崩れている） */
  | { kind: "targetMissing" };

/**
 * 提案の `original`／`target` を、本文の `line` 行目に照らす。
 *
 * **行の中で最初に見つかった `original` の、その中の最初の `target`** を指す。
 * 採るとき（`acceptProposal`）はこの位置を書き換えるので、置くときもこの
 * 関数で「選んだ所を指しているか」を確かめる。`at` は行の頭からの位置。
 */
export function locateProposal(
  text: string,
  proposal: { line: number; original: string; target: string }
): ProposalLocation {
  const lineText = text.split("\n")[proposal.line - 1];
  if (lineText === undefined || !lineText.includes(proposal.original)) {
    return { kind: "originalMissing" };
  }
  const targetIndex = proposal.original.indexOf(proposal.target);
  if (targetIndex === -1) return { kind: "targetMissing" };
  return { kind: "found", at: lineText.indexOf(proposal.original) + targetIndex };
}

/**
 * `original` を広げて探す幅の上限（字）。
 *
 * 同じ字がずっと並ぶ行（「ーーー…」など）では、どこまで広げても1か所に
 * 決まらないことがある。探し続けると長い行で固まるので、ここで打ち切って断る。
 */
const ORIGINAL_WIDEN_LIMIT = 200;

/**
 * 選んだ所（行の中の `start`〜`end`）を、提案の `original`／`target` にする。
 *
 * **採る側は「最初に見つかった所」を書き換える**（`locateProposal`）。同じ語が
 * 1行に2度ある行で2つ目を選んだとき、`target` だけでは1つ目が書き換わる。
 * そこで、選んだ所だけを指すまで前後の字を `original` に含めて広げる
 * （いちばん短いもの）。決まらなければ断る。
 *
 * 選んでいない（`start === end`）ときは、その行ぜんたいを指す（「ここにメモを足す」）。
 */
export function handProposalTarget(
  rawLineText: string,
  start: number,
  end: number
):
  | { ok: true; original: string; target: string }
  | { ok: false; reason: string } {
  // 改行が CRLF の原稿では、行の末尾に CR が残って届くことがある
  const lineText = rawLineText.replace(/\r$/, "");
  if (start === end) {
    if (lineText.trim() === "") {
      return {
        ok: false,
        reason: "空の行には置けません。文のある行で実行してください。",
      };
    }
    return { ok: true, original: lineText, target: lineText };
  }
  if (start < 0 || end > lineText.length || start > end) {
    return { ok: false, reason: "選んだ所を本文の中に見つけられませんでした。" };
  }
  const target = lineText.slice(start, end);
  if (target.trim() === "") {
    return {
      ok: false,
      reason: "空白だけが選ばれています。直したい字を選んでください。",
    };
  }
  const room = lineText.length - target.length;
  for (let widen = 0; widen <= Math.min(room, ORIGINAL_WIDEN_LIMIT); widen++) {
    for (let left = 0; left <= widen; left++) {
      const from = start - left;
      const to = end + (widen - left);
      if (from < 0 || to > lineText.length) continue;
      const original = lineText.slice(from, to);
      if (
        lineText.indexOf(original) === from &&
        original.indexOf(target) === left
      ) {
        return { ok: true, original, target };
      }
    }
  }
  return {
    ok: false,
    reason:
      "同じ字の並びが続いていて、選んだ所を1か所に決められません。前後の字も含めて選んでください。",
  };
}

/**
 * 編集部が手で書いた提案を組み立てる。
 *
 * - 直した案が選んだ所と同じなら、直していない＝**意見だけ**として扱う
 * - 直した案も意見も無いものは置かない（作者が受け取っても何もできない）
 * - **番号に理由も混ぜる。** 同じ所への意見を2つ置いたとき、`target` と空の
 *   `suggestion` だけで番号を作ると2つ目が1つ目に畳まれて消える
 *
 * AI の出力ではないので字数は縛らない。本文に実在するかは呼ぶ側が
 * `locateProposal` で、置く直前のファイルに照らす。
 */
export function buildHandProposal(input: {
  file: string;
  line: number;
  original: string;
  target: string;
  suggestion: string;
  reason: string;
  proposer: string;
  time: string;
  category: string;
}): { ok: true; proposal: Proposal } | { ok: false; reason: string } {
  const suggestion = input.suggestion === input.target ? "" : input.suggestion;
  const reason = input.reason.trim();
  if (suggestion === "" && reason === "") {
    return {
      ok: false,
      reason: "直した案か意見の、どちらかを書いてください。",
    };
  }
  return {
    ok: true,
    proposal: {
      id: proposalId(
        input.file,
        input.line,
        input.target,
        `${suggestion}\u0000${reason}`
      ),
      time: input.time,
      proposer: input.proposer,
      file: input.file,
      line: input.line,
      original: input.original,
      target: input.target,
      suggestion,
      reason,
      category: input.category,
    },
  };
}
