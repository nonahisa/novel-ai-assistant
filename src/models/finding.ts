/**
 * AIの指摘を数日残すための置き場（設計書6.96）。
 *
 * **作者の指示**（2026-09-19）：「提案が一回ごとに消えるのは面倒なので、
 * 位置把握を厳にして数日保存する機能が欲しい」。
 *
 * ## ここは下書き置き場であって、台帳ではない
 *
 * 保存するのは**指摘そのもの**（どこに・何が・なぜ）と**作者の判断**だけ
 * である。設定資料・人物・伏線・章立てへは1バイトも書かないし、本文も
 * 1文字も書き換えない（6.96.2・6.96.6）。「検知結果を自動で保存しない」
 * という従来の方針が禁じていたのは、**AIの言ったことを確かめずに作者の
 * データへ流し込む**ことであって、下書きを残すことではない。
 *
 * ## 形は編集部の提案（`models/proposal.ts`）に揃える
 *
 * 1行1件の追記のみ。**本体は書き換えず、採った・退けたは別の行を足す。**
 * 同期されるファイルなので、同じ行を両方の機械が書き換える形にすると、
 * 競合したときにどちらかの記録が消える。
 *
 * ## 行番号は鍵ではない
 *
 * `hintLine` は**検知したときの行番号**にすぎない。三日ぶんの編集に
 * 耐えるため、開くたびに `original` を本文から探し直す（6.96.3、
 * `core/findingLocation.ts`）。番号（`id`）にも行を混ぜない——混ぜると、
 * 本文が1行ずれただけで同じ指摘が別物になり、退けたはずのものが復活する。
 */

/** 指摘の種類。**画面で分けるためではなく、出どころを残すため** */
export type FindingCategory =
  | "typo"
  | "notation"
  | "proofread"
  | "contradiction"
  | "deviation"
  | "other";

export interface Finding {
  /** 指摘を指すための番号。判断の記録がこれを指す */
  id: string;
  /** いつ検知したか（ISO 8601）。**期限（6.96.4）の起点** */
  time: string;
  /** 作品フォルダーからの相対パス（無理なら呼び出し側が渡した形のまま） */
  file: string;
  /**
   * 検知したときの行番号（1始まり）。
   *
   * **鍵ではなく手がかりである。** 同じ原文が何度も出るときに、
   * どれを指していたのかを決めるためだけに使う。
   */
  hintLine: number;
  /** 本文に実在するはずの原文。**探し直しの鍵はこれ** */
  original: string;
  /** `original` の中で実際に置き換える範囲。無い指摘もある（矛盾など） */
  target: string;
  /** 置き換えた後。無い指摘もある（矛盾・逸脱は直し方を出さない） */
  suggestion: string;
  /** 原文の直前にあった本文。同じ語が何度も出る作品で絞るため */
  before: string;
  /** 原文の直後にあった本文 */
  after: string;
  /** なぜ挙げたか。作者が判断するための材料 */
  message: string;
  /** どの検知から出たか */
  category: FindingCategory;
}

/**
 * 作者の判断。
 *
 * **指摘そのものは書き換えず、これを足す。** 片方の機械で退けたものが
 * もう片方でも退くのは、この形なら自然に成立する（6.96.4）。
 */
export interface FindingDecision {
  findingId: string;
  time: string;
  /** `accepted`＝採った（本文へ当てた） / `dismissed`＝退けた */
  status: "accepted" | "dismissed";
  /** 作者の覚え書き。無ければ空 */
  note: string;
}

export type FindingLine =
  | ({ kind: "finding" } & Finding)
  | ({ kind: "decision" } & FindingDecision);

export type FindingStatus = "pending" | "accepted" | "dismissed";

/** 指摘と判断を突き合わせた、いまの状態 */
export interface FindingView extends Finding {
  status: FindingStatus;
  decision?: FindingDecision;
}

const CATEGORIES: ReadonlySet<string> = new Set<FindingCategory>([
  "typo",
  "notation",
  "proofread",
  "contradiction",
  "deviation",
  "other",
]);

/**
 * 指摘の番号を作る。
 *
 * **同じ指摘が二度出ても1件で済むようにする。** 検知を何度走らせても
 * 同じ場所・同じ直しなら同じ番号になるので、一覧が同じもので埋まらない。
 *
 * **行番号を含めない**（6.96.3）。含めると、本文を1行足しただけで
 * 同じ指摘が別の番号になり、退けた記録が効かなくなる。
 */
export function findingId(
  file: string,
  original: string,
  target: string,
  suggestion: string,
  category: string
): string {
  // 絶対パスと相対パスが混ざって来るので、ファイル名だけで揃える
  // （`dismissKey` と同じ理由。同じ作品の中で名前は重ならない）
  const fileName = file.split(/[\\/]/).pop() ?? file;
  const source = `${fileName}|${original}|${target}|${suggestion}|${category}`;
  // 短い決定的な番号。暗号用途ではないので簡単な畳み込みで足りる
  let hash = 0;
  for (const char of source) {
    hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  }
  return `f${hash.toString(36)}`;
}

/**
 * 1行1件を読む。
 *
 * **読めない行は捨てて、読める行は残す。** 同期の競合で1行が壊れたときに、
 * 無事な指摘まで見えなくしない。競合マーカーの行も落とす
 * （`core/proposalStore.ts` の `parseProposalLines` と同じ作法）。
 */
export function parseFindingLines(text: string): FindingLine[] {
  const lines: FindingLine[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(<<<<<<<|=======|>>>>>>>)/.test(line)) continue;
    try {
      const parsed = toFindingLine(JSON.parse(line));
      if (parsed) lines.push(parsed);
    } catch {
      // 壊れた行は捨てる
    }
  }
  return lines;
}

function toFindingLine(value: unknown): FindingLine | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;

  if (record.kind === "finding") {
    const id = str(record.id);
    const file = str(record.file);
    const original = str(record.original);
    /*
      **原文の無い指摘は読まない。** 位置を探し直す手がかりが原文なので、
      それが無いと「どこの話か」を永久に決められない（6.96.3）。
    */
    if (!id || !file || !original) return undefined;
    return {
      kind: "finding",
      id,
      time: str(record.time),
      file,
      hintLine: typeof record.hintLine === "number" ? record.hintLine : 0,
      original,
      target: str(record.target),
      suggestion: str(record.suggestion),
      before: str(record.before),
      after: str(record.after),
      message: str(record.message),
      category: toCategory(record.category),
    };
  }

  if (record.kind === "decision") {
    const findingId = str(record.findingId);
    const status = record.status;
    if (!findingId || (status !== "accepted" && status !== "dismissed")) {
      return undefined;
    }
    return {
      kind: "decision",
      findingId,
      time: str(record.time),
      status,
      note: str(record.note),
    };
  }
  return undefined;
}

/**
 * 指摘と判断を突き合わせる。
 *
 * **判断は後から来たものが勝つ。** 退けてから考え直して採ることもある。
 * 追記だけの作りなので、時刻の新しいほうを見る。
 */
export function resolveFindings(lines: FindingLine[]): FindingView[] {
  const findings = new Map<string, Finding>();
  const decisions = new Map<string, FindingDecision>();

  for (const line of lines) {
    if (line.kind === "finding") {
      /*
        **同じ番号が2回来たら、後から来たものを採る。** 提案
        （`resolveProposals`）が先勝ちなのは編集部が書くものだからで、
        こちらは同じ機能が検知し直した結果である——`hintLine` と前後の
        本文が新しいほうが、探し直しの手がかりとして確かである。
      */
      findings.set(line.id, line);
      continue;
    }
    const existing = decisions.get(line.findingId);
    if (!existing || isNewer(line.time, existing.time)) {
      decisions.set(line.findingId, line);
    }
  }

  const views: FindingView[] = [];
  for (const finding of findings.values()) {
    const decision = decisions.get(finding.id);
    views.push({
      ...finding,
      status: decision?.status ?? "pending",
      decision,
    });
  }
  return views;
}

/**
 * その指摘が期限切れか（設計書6.96.4）。
 *
 * **隠すためだけの判定である。** ここが `true` を返しても、ファイルからは
 * 消さない——時計のずれや、ノートPCを久しぶりに開いたときに、
 * **作者が見る前に消える**のを防ぐため。消えるのは作者が明示の操作を
 * したときだけ。
 *
 * @param retentionDays 残す日数。`0` 以下なら無期限（何も隠さない）
 */
export function isFindingExpired(
  time: string,
  retentionDays: number,
  now: Date
): boolean {
  if (!(retentionDays > 0)) return false;
  const created = Date.parse(time);
  // **日時が読めない指摘は隠さない。** 消せるものより見られるほうを採る
  if (Number.isNaN(created)) return false;
  const elapsed = now.getTime() - created;
  // 未来の日時（時計のずれ）も隠さない
  if (elapsed < 0) return false;
  return elapsed > retentionDays * 24 * 60 * 60 * 1000;
}

function isNewer(candidate: string, current: string): boolean {
  const left = Date.parse(candidate);
  const right = Date.parse(current);
  if (Number.isNaN(left)) return false;
  if (Number.isNaN(right)) return true;
  return left > right;
}

function toCategory(value: unknown): FindingCategory {
  // 知らない種類で止めない。並べる側は種類で分けないので害が無い
  return typeof value === "string" && CATEGORIES.has(value)
    ? (value as FindingCategory)
    : "other";
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
