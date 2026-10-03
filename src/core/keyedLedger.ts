/**
 * 1つの鍵に、**いくつもの面を載せられる**台帳（作者の報告、2026-10-03。設計書6.25.11）。
 *
 * ## なぜ「鍵1つに1件」ではいけないか
 *
 * 原稿エディターの台帳は、もとは `Map<鍵, 面>` だった。同じ原稿の面が
 * 2枚できると（縦と横の入口で1枚ずつ、または別の列にもう1枚）、
 * **2枚目が1枚目を上書きし**、2枚目を閉じた瞬間に鍵ごと消える。
 * 1枚目はまだ開いているのに台帳には無い——飛ぶ道は「開いていない」と読んで
 * もう1枚開き、作者の目には「右にもう1枚開いて、元の画面が空白」に見えた。
 * 本物の VS Code（1.138.0）で、2枚目を閉じると窓の札が
 * `editors: 0／orphanTabs: 1` になることを確かめてある。
 *
 * ## 何を返すか
 *
 * 同じ鍵に複数あるときは、`rank` の高いもの（前面・見えている面）を返す。
 * 同点なら**最後に使った**もの（`touch` で後ろへ回す）。
 *
 * VS Code に依存させない（試験しやすくするため、`core` に置く）。
 */
export class KeyedLedger<Entry> {
  private readonly byKey = new Map<string, Entry[]>();

  /**
   * @param rank 面の優先度。大きいほど先に選ぶ（例：前面 2・見えている 1・隠れている 0）
   */
  constructor(private readonly rank: (entry: Entry) => number = () => 0) {}

  /** 載せる。同じ面を2度載せても1件のまま（最後に使ったことにする） */
  add(key: string, entry: Entry): void {
    const list = this.byKey.get(key) ?? [];
    const kept = list.filter((existing) => existing !== entry);
    kept.push(entry);
    this.byKey.set(key, kept);
  }

  /**
   * その面だけを外す。**同じ鍵のほかの面は残す**（ここが直した所）。
   * 外したら true。
   */
  remove(key: string, entry: Entry): boolean {
    const list = this.byKey.get(key);
    if (!list) return false;
    const kept = list.filter((existing) => existing !== entry);
    if (kept.length === list.length) return false;
    if (kept.length === 0) this.byKey.delete(key);
    else this.byKey.set(key, kept);
    return true;
  }

  /** 最後に使ったことにする（同点のときに選ばれる） */
  touch(key: string, entry: Entry): void {
    const list = this.byKey.get(key);
    if (!list || !list.includes(entry)) return;
    this.add(key, entry);
  }

  /** その鍵で選ぶ面（無ければ undefined） */
  get(key: string): Entry | undefined {
    const list = this.byKey.get(key);
    if (!list || list.length === 0) return undefined;
    let best = list[list.length - 1];
    let bestRank = this.rank(best);
    // 後ろ（最後に使ったもの）から見て、より高いものだけで置き換える＝同点なら新しい方
    for (let index = list.length - 2; index >= 0; index--) {
      const candidate = list[index];
      const candidateRank = this.rank(candidate);
      if (candidateRank > bestRank) {
        best = candidate;
        bestRank = candidateRank;
      }
    }
    return best;
  }

  /** その鍵に載っている面すべて（古い順） */
  all(key: string): readonly Entry[] {
    return [...(this.byKey.get(key) ?? [])];
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  /** 面が1つでも載っている鍵 */
  keys(): IterableIterator<string> {
    return this.byKey.keys();
  }

  /** 載っている面すべて（鍵をまたいで） */
  values(): Entry[] {
    return [...this.byKey.values()].flat();
  }
}
