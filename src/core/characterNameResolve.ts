import type { Character } from "../models/character";
import { expandNameVariants } from "./termIndex";

/**
 * 名前・別名から人物レコードを引く（設計書6.38.1）。
 *
 * **相関図（`relationGraph.ts`）と呼び合い（`addressPairs.ts`）が
 * 分け合う。** どちらも「資料に書かれた相手の名前」を人物レコードへ
 * 当てる同じ仕事をしており、写しを作ると片方だけ直る日が来る
 * （この作品では `termColors.ts` で同じ判断をしている）。
 *
 * 名前の広げ方は `termIndex.ts` の `expandNameVariants` を借りる。姓だけ・
 * 名だけで呼ぶ小説の書き方に合わせた規則が既にそこにある。
 *
 * **当てるのは全体が一致したときだけ。** `TermIndex.find` は本文の中から
 * 用語を探す道具なので、部分文字列にも当たる。名前どうしを突き合わせる
 * ここでそれを使うと、資料に無い「アリシア」が登録済みの「リシア」に
 * 化けて、**どこにも無い線**が引かれる（気づきようがない）。
 *
 * **同じ名前が複数の人物に当たるときは結ばない。** 先に見つかったほうへ
 * 当てると、別名が重なっているだけで別人が繋がる。`ambiguous` として
 * 残し、件数に出す（黙って落とさない・黙って繋がない）。
 *
 * VS Code APIに依存しない。
 */

/**
 * なぜ資料に結べなかったか。
 *
 * - `notFound`：その名前の人物が資料に居ない（抽出漏れか、脇役）
 * - `ambiguous`：同じ名前の人物が複数居て、どちらか決められない
 *
 * **2つを分ける。** 前者は抽出すれば消えるが、後者は別名の重複を
 * 直さないと消えない。同じ「資料に無い」で括ると、作者は抽出をやり直して
 * 何も変わらない、を繰り返すことになる。
 */
export type UnresolvedReason = "notFound" | "ambiguous";

export interface NameResolution {
  id: string | null;
  reason: UnresolvedReason | null;
}

export function createNameResolver(
  characters: readonly Character[]
): (name: string) => NameResolution {
  const idsByName = new Map<string, Set<string>>();
  for (const character of characters) {
    const names = expandNameVariants([
      character.name,
      ...(character.aliases ?? []),
    ]);
    for (const text of names) {
      const key = text.trim();
      if (!key) continue;
      const ids = idsByName.get(key);
      if (ids) ids.add(character.id);
      else idsByName.set(key, new Set([character.id]));
    }
  }

  return (name: string): NameResolution => {
    const ids = idsByName.get(name.trim());
    if (!ids || ids.size === 0) return { id: null, reason: "notFound" };
    if (ids.size > 1) return { id: null, reason: "ambiguous" };
    return { id: [...ids][0], reason: null };
  };
}
