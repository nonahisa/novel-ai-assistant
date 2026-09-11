import type { Character } from "../models/character";
import type { Location } from "../models/location";
import type { WorldItem } from "../models/world";
import { hasAppearedBy, isEmptyAfterRollback, recordAsOf } from "./settingsAsOf";
import {
  describeCharacter,
  describeLocation,
  describeWorldItem,
} from "./settingsSummary";
import { TermIndex, expandNameVariants, type TermEntry } from "./termIndex";
import { selectWorldview } from "./worldviewSelect";

/**
 * 矛盾検知（設計書6.10）へ渡す材料を組み立てる。
 *
 * **もとは `features/checkContradictions.ts` の中に閉じていた**（`collectSettings`
 * が返すオブジェクトのメソッド）。中身はVS Code APIに触っていない純粋な処理
 * なのに、features の閉じた中にあるせいで**外から一度も測れなかった**——
 * 「その話の時点で分かっていることだけを渡す」（6.10.3）が効いているかを
 * 確かめる手段が、実機でAIを回して出力を眺めることしか無かった。
 *
 * ここへ出すと単体テスト・統合テストから直接呼べる。依存の向き
 * （`features` → `core`）にも合う。
 *
 * **同じ入力からは必ず同じ文字列を返す。** キャッシュの鍵は「設定の指紋＋
 * チャンクのハッシュ」なので、組み立てが揺れると同じ鍵に違う材料の答えが入る。
 */

/**
 * 話数で巻き戻す項目（設計書6.10.3）。
 *
 * **名前と読みは巻き戻さない。** 作中で変わるものではないし、
 * 消すと誰の話か分からなくなる。
 *
 * **「あとで判明する事実」（6.10.4）も同じ並びを見る。** 向きが逆なだけで
 * 対象は同じ項目なので、2か所に書くと片方だけ足したときに食い違う。
 */
export const CHARACTER_AS_OF_FIELDS = [
  "summary",
  "role",
  "personality",
  "appearance",
  "gender",
  "affiliation",
];

export const LOCATION_AS_OF_FIELDS = ["summary", "region", "description"];

/** そのチャンクへ載せる材料（プロンプトの各欄へそのまま入る） */
export interface RelevantSettings {
  characters: string;
  locations: string;
  /** そのチャンクへ載せる世界観。上限内なら全項目（設計書6.27.6） */
  worldview: string;
  /**
   * 照らし合わせる相手があるか。
   *
   * **無いチャンクはAIへ送らない。** 材料なしで問うと、本文だけを見て
   * 矛盾を作り出す。
   */
  hasAnything: boolean;
}

export interface ContradictionMaterial {
  /**
   * 参照資料に見込む字数（世界観）。チャンクの大きさを決めるのに使う。
   *
   * **上限そのものではなく、上限と全文の小さいほう**を返す。世界観が
   * 3項目しかない作品で30,000字を確保すると、本文が要らないほど痩せる。
   */
  referenceBudgetChars: number;
  /**
   * @param chapter その本文が何話か。**その時点で分かっていることだけ**を返す
   */
  relevantFor(text: string, chapter: number | null): RelevantSettings;
  /**
   * その本文に出てくる、索引にある語（設計書6.74）。
   *
   * **種別で絞らない。** いま索引に載っているのは人物と場所だが、能力名・
   * 組織名も過去の場面を引く語としては同じように役に立つ（本体の裁定、
   * 0.32.6）。索引へ足せばそのまま検索語になるよう、ここでは
   * `TermKind` を見ずに全部返す。
   *
   * **本文に現れた表記そのもの**を返す（正式名称ではない）。過去の場面は
   * 語句一致で引くので、本文が「灯くん」としか書いていないのに正式名称の
   * 「月島 灯」で引くと当たらない。
   */
  namesIn(text: string): string[];
}

/**
 * 本文に出てくるものを探すための索引。用語ハイライトと同じ作り。
 *
 * **索引の組み方も、材料の組み立ての一部としてここに置く。** 呼ぶ側と
 * 試す側が別々に索引を組むと、別名の広げ方（`expandNameVariants`）が
 * 食い違い、**テストでは当たるのに実機では当たらない**という差が出る。
 */
export function buildContradictionTermIndex(options: {
  people: readonly Character[];
  places: readonly Location[];
}): TermIndex {
  const entries: TermEntry[] = [];
  for (const character of options.people) {
    for (const text of expandNameVariants([
      character.name,
      ...character.aliases,
    ])) {
      entries.push({
        text,
        kind: "character",
        id: character.id,
        canonicalName: character.name,
      });
    }
  }
  for (const place of options.places) {
    // **場所の別名は広げない。** 地名は区切りで切ると別の場所と重なる
    // （もとの `collectSettings` と同じ扱いを保つ）
    for (const text of [place.name, ...place.aliases]) {
      entries.push({
        text,
        kind: "location",
        id: place.id,
        canonicalName: place.name,
      });
    }
  }
  return new TermIndex(entries);
}

/**
 * 突き合わせる材料の組み立て役を作る。
 *
 * **索引と対応表は1回だけ作る。** `relevantFor` はチャンクごとに呼ばれるので、
 * ここで作り直すと作品の大きさぶんだけ効く。
 */
export function createContradictionMaterial(options: {
  people: readonly Character[];
  places: readonly Location[];
  worldItems: readonly WorldItem[];
  /** `buildContradictionTermIndex` で組んだもの。呼ぶ側が別の用途にも使う */
  index: TermIndex;
  /** そのモデルで世界観に使ってよい字数（`worldviewMaxChars`） */
  worldviewMax: number;
}): ContradictionMaterial {
  const { people, places, worldItems, index, worldviewMax } = options;

  const characterById = new Map(people.map((item) => [item.id, item]));
  const locationById = new Map(places.map((item) => [item.id, item]));

  // 世界観の全文（上限に掛ける前）の長さ。チャンクの大きさを決めるときに、
  // 「上限いっぱい確保する」のではなく実際に必要な分だけ引くために測る
  const worldviewWholeChars = worldItems
    .map((item) => describeWorldItem(item).length)
    .reduce((sum, length) => sum + length + 2, 0);

  return {
    referenceBudgetChars: Math.min(worldviewMax, worldviewWholeChars),
    relevantFor(text, chapter) {
      const seenCharacters = new Set<string>();
      const seenLocations = new Set<string>();
      for (const match of index.find(text)) {
        if (match.entry.kind === "character") seenCharacters.add(match.entry.id);
        if (match.entry.kind === "location") seenLocations.add(match.entry.id);
      }

      // **その話の時点で分かっていることだけを渡す**（設計書6.10.3）。
      // 資料は作品全体から作られているので、そのまま渡すと
      // **あとの話で明かされる事実**と食い違って見える
      const characterText = [...seenCharacters]
        .map((id) => characterById.get(id))
        .filter((item) => item !== undefined)
        .filter((item) => hasAppearedBy(item.appearedChapters, chapter))
        .map((item) => recordAsOf(item, CHARACTER_AS_OF_FIELDS, chapter))
        .filter((item) => !isEmptyAfterRollback(item, CHARACTER_AS_OF_FIELDS))
        .map((item) => describeCharacter(item, []))
        .join("\n\n");
      const locationText = [...seenLocations]
        .map((id) => locationById.get(id))
        .filter((item) => item !== undefined)
        .filter((item) => hasAppearedBy(item.appearedChapters, chapter))
        .map((item) => recordAsOf(item, LOCATION_AS_OF_FIELDS, chapter))
        .filter((item) => !isEmptyAfterRollback(item, LOCATION_AS_OF_FIELDS))
        .map((item) => describeLocation(item))
        .join("\n\n");

      return {
        characters: characterText,
        locations: locationText,
        // **世界観にも上限を置く**（設計書6.27.6の穴2）。上限内なら
        // 全項目が元の並び順で入るので、いまの作品では従来と同じ文字列になる
        worldview: selectWorldview({
          items: worldItems,
          chunkText: text,
          chapter,
          // **上限はモデルによって変わる**（設計書6.27.10）。固定30,000字だと
          // 小さいモデルでは資料だけで上限を使い切る
          maxChars: worldviewMax,
        }),
        // 世界観は誰が出ていても効くので、それだけでも材料になる。
        // 上限で絞っても1件は必ず残るので、項目があるかどうかで見てよい
        hasAnything: Boolean(
          characterText || locationText || worldItems.length > 0
        ),
      };
    },
    namesIn(text) {
      const names: string[] = [];
      for (const match of index.find(text)) {
        const term = match.entry.text.trim();
        if (!term || names.includes(term)) continue;
        names.push(term);
      }
      // **件数は切らない。** どれを検索語に使うかは選抜側の判断で、
      // ここは「本文に出た名前」をそのまま渡す役目（`pastSceneSelect`）
      return names;
    },
  };
}
