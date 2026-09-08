/**
 * 作品を選ぶ場面に添える補足（設計書6.28.11）。
 *
 * **件数の印は全作品を合わせた数なので、それだけではどの作品に溜まって
 * いるのか分からない**（実機で発覚、2026-08-14）。承認待ちのように作品
 * ごとに数が違うものは、選ぶ場面で内訳を見せる。
 *
 * 文言と並び順だけをここに置く。**数を読むところ（提案の台帳・辞書の
 * 新しさ・同期の状態）は呼び出し側に残す**——読み方は場面ごとに違うが、
 * 出る言葉は揃っているほうがよい。
 *
 * VS Code API に依存しない（試験から文言をそのまま見るため）。
 */

/** 選択肢の右に出す一言と、並び順の重み（大きいほど上） */
export interface WorkPickNote {
  note: string;
  /** 溜まっている作品を上に出す。作者はたいていそれを選びたい */
  order: number;
}

/** 「提案を確認」——未処理の提案が何件あるか */
export function pendingProposalNote(count: number): WorkPickNote {
  return {
    note: count > 0 ? `未処理の提案 ${count}件` : "未処理なし",
    order: count,
  };
}

/**
 * 「IME辞書を書き出す」——設定資料のほうが新しいか。
 *
 * **一度も書き出していない作品を「古い」と言わない**（催促にならない
 * ため、印でも数えていない）。ただしこの場面では判断材料になるので、
 * 書き出し済みかどうかは伝える。並び順は上げない。
 */
export function imeDictionaryNote(freshness: {
  stale: boolean;
  exported: boolean;
}): WorkPickNote {
  if (freshness.stale) return { note: "設定資料が辞書より新しい", order: 1 };
  return {
    note: freshness.exported ? "書き出し済み" : "まだ書き出していない",
    order: 0,
  };
}

/**
 * 「GitHubへ送る」——送信待ちが何件あるか。
 *
 * **送信は置き場が単位で、1つ送ると同じ置き場の作品はまとめて出ていく**
 * （設計書5.7.9）。この作品ぶんが0でも送信そのものは動くので、
 * 「ありません」で終わらせない。
 */
export function pushWaitingNote(status: {
  ahead: number;
  aheadHere: number;
}): WorkPickNote {
  if (status.aheadHere > 0) {
    return {
      note:
        `送信待ち ${status.aheadHere}件` +
        (status.ahead !== status.aheadHere
          ? `（置き場ぜんぶでは ${status.ahead}件）`
          : ""),
      order: status.aheadHere,
    };
  }
  if (status.ahead > 0) {
    return {
      note: `この作品ぶんはありません（置き場ぜんぶでは送信待ち ${status.ahead}件）`,
      order: 0,
    };
  }
  return { note: "送信するものはありません", order: 0 };
}

/**
 * 「分かれた分を合わせる」——この置き場が分かれているか。
 *
 * **分かれているかは置き場（リポジトリ）の性質**であって、作品ごとには
 * 決まらない。合わせる相手も置き場なので、`ahead`／`behind`（置き場
 * ぜんぶ）で見るのが正しい。同じ置き場の作品に同じ補足が並ぶのは、
 * それが事実だからである。
 */
export function divergenceNote(status: {
  ahead: number;
  behind: number;
}): WorkPickNote {
  if (status.ahead > 0 && status.behind > 0) {
    return {
      note:
        `分かれています（送信待ち ${status.ahead}件・` +
        `受け取り ${status.behind}件）`,
      order: 1,
    };
  }
  return { note: "分かれていません", order: 0 };
}

/**
 * 補足の重みで並べ替える（大きいものが上）。
 *
 * **元の配列は壊さない。** 登録簿の並びは他の場面でも使う。
 */
export function sortByPickOrder<T extends { order: number }>(
  items: readonly T[]
): T[] {
  return [...items].sort((left, right) => right.order - left.order);
}
