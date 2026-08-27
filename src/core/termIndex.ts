/**
 * 本文中の用語（人名・地名・能力名）を探すための索引。
 *
 * 設定が増えるほど「用語ごとに本文を走査する」方式は遅くなる。
 * 73万字の作品で数百語を扱うと編集のたびに固まるため、
 * 本文を1回だけ走査して全用語を同時に照合する方式にする
 * （Aho-Corasick法。失敗リンクで後戻りせずに済む）。
 */

/** 用語の種類。表示色を分けるために使う */
export type TermKind = "character" | "location" | "ability" | "organization";

export interface TermEntry {
  /** 本文中に現れる文字列 */
  text: string;
  kind: TermKind;
  /** 元レコードのid。ホバー時に本体を引く */
  id: string;
  /** 正式名称。別名で一致したときに本来の名前を示す */
  canonicalName: string;
  /**
   * 紹介の一文。原稿エディタのホバーのチップに出す（作者の依頼、2026-08-28）。
   * 供給元が渡さなくてもよい（チップに紹介が出ないだけ）
   */
  summary?: string;
}

export interface TermMatch {
  start: number;
  end: number;
  entry: TermEntry;
}

/**
 * 本文に現れうる呼び方へ広げる。
 *
 * 小説では姓名を続けて書かず、片方だけで呼ぶことが多い。
 * 「マルキオ・イークェス」で登録しても本文には「マルキオ」としか出てこず、
 * そのままでは一致しない。すると別レコードの「マル」のような
 * 短い名前だけが引っかかり、途中までしか色が付かない（実データで確認）。
 *
 * 中黒・空白で区切られている場合だけ分ける。区切りが無い名前を
 * 推測で切ると、別人の名前と重なって誤って色が付く。
 */
export function expandNameVariants(names: string[]): string[] {
  const expanded = new Set<string>();

  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    expanded.add(trimmed);

    if (!/[\s　・･]/.test(trimmed)) continue;
    for (const part of trimmed.split(/[\s　・･]+/)) {
      // 1文字の部分は普通名詞と重なりやすいので広げない
      if (part.length >= 2) expanded.add(part);
    }
  }

  return [...expanded];
}

interface TrieNode {
  children: Map<string, TrieNode>;
  fail: TrieNode | null;
  /** このノードで終わる用語 */
  outputs: TermEntry[];
  depth: number;
}

function createNode(depth: number): TrieNode {
  return { children: new Map(), fail: null, outputs: [], depth };
}

export class TermIndex {
  private readonly root = createNode(0);
  private readonly byId = new Map<string, TermEntry[]>();
  readonly size: number;

  constructor(entries: TermEntry[]) {
    const usable = entries.filter((entry) => entry.text.trim().length > 0);
    this.size = usable.length;

    for (const entry of usable) {
      this.insert(entry);
      const list = this.byId.get(entry.id) ?? [];
      list.push(entry);
      this.byId.set(entry.id, list);
    }
    this.buildFailureLinks();
  }

  private insert(entry: TermEntry): void {
    let node = this.root;
    let depth = 0;
    for (const char of entry.text) {
      depth++;
      let next = node.children.get(char);
      if (!next) {
        next = createNode(depth);
        node.children.set(char, next);
      }
      node = next;
    }
    node.outputs.push(entry);
  }

  /** 幅優先で失敗リンクを張る */
  private buildFailureLinks(): void {
    const queue: TrieNode[] = [];
    for (const child of this.root.children.values()) {
      child.fail = this.root;
      queue.push(child);
    }

    while (queue.length > 0) {
      const node = queue.shift()!;
      for (const [char, child] of node.children) {
        let fallback = node.fail;
        while (fallback && !fallback.children.has(char)) {
          fallback = fallback.fail;
        }
        child.fail = fallback?.children.get(char) ?? this.root;
        // 失敗先で終わる用語もこのノードの一致として扱う
        child.outputs.push(...child.fail.outputs);
        queue.push(child);
      }
    }
  }

  /**
   * 本文を1回走査して一致を返す。
   *
   * 重なった一致は長い方を優先する。「灯」と「灯火」が
   * 両方登録されている場合、「灯火」の一部を「灯」として
   * 二重に装飾しないため。
   */
  find(text: string): TermMatch[] {
    if (this.size === 0) return [];

    const raw: TermMatch[] = [];
    let node = this.root;
    let index = 0;

    for (const char of text) {
      // Unicodeのサロゲートペアを1文字として数えるため、
      // for...of の進み幅をそのまま使う
      const charLength = char.length;

      while (node !== this.root && !node.children.has(char)) {
        node = node.fail ?? this.root;
      }
      node = node.children.get(char) ?? this.root;

      for (const entry of node.outputs) {
        const end = index + charLength;
        raw.push({ start: end - entry.text.length, end, entry });
      }
      index += charLength;
    }

    return resolveOverlaps(raw);
  }

  entriesFor(id: string): TermEntry[] {
    return this.byId.get(id) ?? [];
  }

  /**
   * 登録されている用語をすべて返す。
   *
   * 原稿エディタ（設計書6.25）が**凡例に出す種別**を決めるために使う。
   * 人物しか登録していない作品で「場所・能力・組織」の色まで並べても、
   * 何の色なのか確かめようがない。
   */
  allEntries(): TermEntry[] {
    return [...this.byId.values()].flat();
  }
}

/**
 * 重なりを解消する。装飾が重なると色が混ざって読みにくくなるため。
 *
 * 前から順に見て、同じ位置から始まる場合は長い方を採る（最左最長）。
 * 全体最適ではないが、走査1回で済む。
 * 採用済みを毎回見比べる方式は、用語が数万回出現する作品で
 * 編集のたびに数秒かかっていた（性能テストで確認）。
 */
export function resolveOverlaps(matches: TermMatch[]): TermMatch[] {
  const sorted = [...matches].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    // 同じ位置なら長い方を先に置き、短い方を捨てる
    return b.end - a.end;
  });

  const taken: TermMatch[] = [];
  let lastEnd = -1;
  for (const match of sorted) {
    if (match.start < lastEnd) continue;
    taken.push(match);
    lastEnd = match.end;
  }
  return taken;
}
