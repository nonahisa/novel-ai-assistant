import type { Character } from "../models/character";
import type { Location } from "../models/location";
import type { WorldItem } from "../models/world";
import { sha1Text } from "./hash";
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
  /**
   * **直前の話の本文には名前が出ているのに、この材料に載らなかった人物**
   * （設計書6.10.6「落としたことを言う」）。正式名称で返す。
   *
   * **穴は塞がない。塞がずに、落としたことを言うためだけの欄**である
   * ——`characters` にも `hasAnything` にも影響しない（プロンプトが1文字
   * でも変わるとキャッシュが飛び、測り直しになる）。
   *
   * **材料に載らなかった人物を全部挙げはしない。** 登場人物が40人いれば、
   * 1話に出るのは数人なので、毎回37人が並んで騒がしくなる。**物語の流れ
   * では居るはずなのに落ちた人**＝直前の1話に名前が出ている人だけを挙げる。
   *
   * **話数で外れた人は入れない**（6.10.3）。その話の時点でまだ分かって
   * いないから外したのであって、名前が出ないせいで落ちたのではない。
   */
  missedCharacters: string[];
}

/**
 * 材料を組むときの、その回かぎりの指定。
 *
 * **状態は持たない。** MCP は1ファイルずつ呼ばれるので、話をまたいで
 * 覚えておくことはできない——引き継ぐ本文は**呼ぶ側が用意して渡す**。
 */
export interface RelevantOptions {
  /**
   * 索引に**一緒にかける**文字列（設計書6.10.6の「前の話に出た人物を
   * 引き継ぐ」）。ふつうは直前の数話の本文。
   *
   * **この文字列そのものはプロンプトへ入らない。** 人物を索引で見つける
   * ためだけに見るので、増えるのは【登場人物設定】の欄だけである。
   */
  carryOverText?: string;
  /**
   * **直前の1話の本文**（設計書6.10.6の「落としたことを言う」）。
   *
   * **材料には1文字も入らないし、人物も増やさない。** ここを見るのは
   * `missedCharacters` を数えるためだけである——プロンプトが変わると
   * キャッシュの鍵に対して別の材料で得た答えが入る。
   *
   * **1話ぶんでよい。** 「物語の流れでは居るはずなのに落ちた人」を言う
   * のが目的なので、遡るほど**もう居ない人**が並んで騒がしくなる。
   */
  previousBodyText?: string;
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
   * @param options 引き継ぐ本文（`RelevantOptions`）。省略すると従来どおり
   */
  relevantFor(
    text: string,
    chapter: number | null,
    options?: RelevantOptions
  ): RelevantSettings;
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
    relevantFor(text, chapter, relevantOptions) {
      const seenCharacters = new Set<string>();
      const seenLocations = new Set<string>();
      for (const match of index.find(text)) {
        if (match.entry.kind === "character") seenCharacters.add(match.entry.id);
        if (match.entry.kind === "location") seenLocations.add(match.entry.id);
      }

      /*
        **前の話に出た人物を引き継ぐ**（設計書6.10.6）。

        一人称で語る主人公は自分の名前を言わないので、その話では
        主人公の設定が1つも載らない（作者の219話で44話＝20%）。名前にも
        一人称にも頼らずに拾うには、**直前の話の本文も一緒に索引へかける**
        のがいちばん素直である（落ちた44話のうち33話は直前の話に載っていた）。

        **人物だけを引き継ぐ。** 場所は「その場面がどこか」を言う材料で、
        前の話の場所を足すと**もう居ない場所の設定**と本文を突き合わせる
        ことになり、誤検出を増やしかねない。落ちる穴が実測で見つかって
        いるのは人物（語り手）だけなので、測る対象もそこに絞る。
      */
      const carryOverText = relevantOptions?.carryOverText ?? "";
      if (carryOverText) {
        for (const match of index.find(carryOverText)) {
          if (match.entry.kind !== "character") continue;
          seenCharacters.add(match.entry.id);
        }
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

      /*
        **落としたことを言う**（設計書6.10.6）。

        材料の選び方はここまでで終わっており、以下は**数えるだけ**である
        ——`characterText` も `hasAnything` も、もう変わらない。

        挙げるのは「直前の1話には名前が出ているのに、この話の材料に載らな
        かった人物」だけ。**引き継ぎ（`carryOverText`）が効いている回では
        `seenCharacters` に入っているので、当然ここは空になる。**
      */
      const missedCharacters: string[] = [];
      const previousBodyText = relevantOptions?.previousBodyText ?? "";
      if (previousBodyText) {
        for (const match of index.find(previousBodyText)) {
          if (match.entry.kind !== "character") continue;
          // 本文に名前が出ているなら落ちていない（時系列で外れた人は下で落ちる）
          if (seenCharacters.has(match.entry.id)) continue;
          const record = characterById.get(match.entry.id);
          if (!record) continue;
          // **話数で外した人は「落とした」と言わない**（6.10.3）。その話の
          // 時点でまだ分かっていないから外したのであって、名前のせいではない
          if (!hasAppearedBy(record.appearedChapters, chapter)) continue;
          const asOf = recordAsOf(record, CHARACTER_AS_OF_FIELDS, chapter);
          if (isEmptyAfterRollback(asOf, CHARACTER_AS_OF_FIELDS)) continue;
          // 別名で何度も当たるので、正式名称で1回だけ
          if (missedCharacters.includes(record.name)) continue;
          missedCharacters.push(record.name);
        }
      }
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
        missedCharacters,
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

/** 突き合わせなかった1話ぶん（設計書6.10.6「落としたことを言う」） */
export interface MissedCharacters {
  /** 話の名前（`describeChunkScope`）。まとめたチャンクは「第4〜5話」 */
  label: string;
  /** 直前の話には名前が出ているのに、材料へ載らなかった人物 */
  names: string[];
}

/** 突き合わせなかった1チャンクぶん（`mergeMissedCharactersByEpisode` の入力） */
export interface MissedCharactersInChunk extends MissedCharacters {
  /**
   * そのチャンクが名乗る話数（`Chunk.chapterStart`）。
   *
   * **読めなければ null。** どの話の一部なのかを決められないので、
   * ほかのチャンクとまとめない（1つで1話ぶんとして扱う）。
   */
  chapter: number | null;
}

/**
 * チャンクごとの「落とした人物」を、話ごとにまとめる（設計書6.10.6）。
 *
 * **判定はチャンク単位、断りは話単位である。** 1話がチャンクの上限を
 * 超えて2つに割れ、人物Xが後半にだけ登場していると、前半のチャンクでは
 * Xが落ちる——そのまま並べると、**その話では実際に突き合わせているのに
 * 「突き合わせていません」と言う**（0.70.12で直した）。
 *
 * **その話のすべてのチャンクで落ちている人物だけ**を返す。1つのチャンクに
 * でも載っていれば、その話では突き合わせている。
 *
 * **まとめる単位は話数であって、札（`describeChunkScope`）ではない。**
 * 合本（1ファイルに全話）は札がファイル単位で決まるので、札でまとめると
 * 作品まるごとの積になり、今度は**言うべき断りが消える**。
 *
 * **落ちた人物が1人も残らない話は返さない**（断りに出さない）。
 */
export function mergeMissedCharactersByEpisode(
  chunks: readonly MissedCharactersInChunk[]
): MissedCharacters[] {
  /** 同じ話数を名乗るチャンクの束。**並びは渡された順のまま** */
  const groups: Array<{ label: string; lists: string[][] }> = [];
  const groupOfChapter = new Map<number, number>();

  for (const chunk of chunks) {
    const at =
      chunk.chapter === null ? undefined : groupOfChapter.get(chunk.chapter);
    if (at === undefined) {
      if (chunk.chapter !== null) groupOfChapter.set(chunk.chapter, groups.length);
      // 札は、その話で最初に出てきたチャンクのものを使う
      groups.push({ label: chunk.label, lists: [[...chunk.names]] });
      continue;
    }
    groups[at].lists.push([...chunk.names]);
  }

  const merged: MissedCharacters[] = [];
  for (const group of groups) {
    const [first, ...rest] = group.lists;
    const names = first.filter((name) =>
      rest.every((list) => list.includes(name))
    );
    if (names.length === 0) continue;
    merged.push({ label: group.label, names });
  }
  return merged;
}

/**
 * 落としたことを、完了の知らせへ1行で書く（設計書6.10.6）。
 *
 * **落ちた話が0なら何も言わない。** 毎回出る断り書きは読まれなくなる。
 *
 * **原稿を直せとは言わない。** 名前を本文に出すかどうかは文章の都合で、
 * こちらが決めることではない——**仕組みを説明して、作者に選ばせる。**
 * 誰を落としたのかは操作ログにあるので、そこへ案内する。
 *
 * 文言を `features` ではなくここへ置くのは、**VS Code を通さずに測る**
 * ためである（`core` は `vscode` に依存しない）。
 */
export function describeMissedCharacters(
  entries: readonly MissedCharacters[]
): string {
  if (entries.length === 0) return "";
  // **入るのは話ごとにまとめたもの**（`mergeMissedCharactersByEpisode`）。
  // 合本では隣り合う話が同じ札を名乗ることがあるので、なお札の数で数える
  const labels = new Set(entries.map((entry) => entry.label));
  return (
    `${labels.size}話で、直前の話に出ていた人物を突き合わせていません` +
    "（本文に名前が出ないため）。" +
    "本文に名前が1度でも出れば、その回でも突き合わせます。" +
    "詳しくは出力をご覧ください。"
  );
}

/**
 * 前の話を引き継げる上限（話数）。
 *
 * **材料を際限なく膨らませない。** 引き継ぐのは人物を索引で見つけるため
 * だけだが、遡るほど「いまの場面に居ない人物」の設定が積み上がる。実測
 * （作者の219話、2026-09-19）では**落ちた44話のうち33話は直前の話に載って
 * おり、連続して落ちるのは最長3話**だったので、5話あれば足りる。
 */
export const CARRY_OVER_MAX_CHAPTERS = 5;

/** 引き継ぎのもとになる本文（話数の順に並べて渡す） */
export interface CarryOverBody {
  /** その本文の話数。読めなければ null（**引き継ぎには使わない**） */
  chapter: number | null;
  text: string;
}

export interface CarryOverResult {
  /** 実際に引き継いだ話数（小さい順）。**黙って引き継がない** */
  chapters: number[];
  /** 索引に一緒にかける文字列。引き継ぐものが無ければ空文字 */
  text: string;
}

/**
 * いま見ている話より前の N 話ぶんの本文を、1つの文字列にまとめる
 * （設計書6.10.6）。
 *
 * **VS Code にも `fs` にも触らない。** 本文を読むのは呼ぶ側の仕事で、
 * ここは「どれを何話ぶん採るか」だけを決める——拡張機能（`loadExcerptSources`）と
 * MCP（`orderedEpisodeBodies`）で読み方が違っても、**採り方は1か所**にする。
 *
 * **数えるのは話数であって、ファイルでも塊でもない。** 合本（1ファイルに
 * 何話も入っている）は呼ぶ側が話ごとに分けて渡すので、同じ話数のものが
 * 複数あればまとめて採る。
 *
 * **話数の読めないチャンクには引き継がない。** 前後を決められないものに
 * 「前の話」は無い（`pastSceneSelect` が話数の読めない出典を落とすのと同じ）。
 *
 * 知らない値・大きすぎる値はここで丸める（負・小数・上限超え）。**丸める
 * のは最後の守りで、打ち間違いに気づかせるのは呼ぶ側の役目**である
 * （MCP は `carryOverOf` が断る）。
 */
export function carryOverBodyText(options: {
  bodies: readonly CarryOverBody[];
  /** いま見ている話。読めない（null）なら引き継がない */
  chapter: number | null;
  /** 何話ぶん遡るか。0以下なら引き継がない */
  chapters: number;
}): CarryOverResult {
  const empty: CarryOverResult = { chapters: [], text: "" };
  const requested = Math.floor(options.chapters);
  if (!Number.isFinite(requested) || requested <= 0) return empty;
  const count = Math.min(requested, CARRY_OVER_MAX_CHAPTERS);
  const chapter = options.chapter;
  if (chapter === null) return empty;

  const before = new Set<number>();
  for (const body of options.bodies) {
    if (body.chapter === null || body.chapter >= chapter) continue;
    before.add(body.chapter);
  }
  const picked = new Set(
    [...before].sort((left, right) => right - left).slice(0, count)
  );
  if (picked.size === 0) return empty;

  // **並びは渡された順のまま。** 呼ぶ側は話数の順に渡すので、
  // 引き継ぐ本文も話の順に並ぶ（同じ入力から同じ文字列が出る）
  const text = options.bodies
    .filter((body) => body.chapter !== null && picked.has(body.chapter))
    .map((body) => body.text)
    .join("\n\n");
  return {
    chapters: [...picked].sort((left, right) => left - right),
    text,
  };
}

/**
 * キャッシュの鍵（プロンプトの版）へ、引き継いだ本文の中身を混ぜる。
 *
 * **前の話を書き直すと、引き継ぐ人物が変わりうる。** 混ぜないと、
 * 書き直す前の顔ぶれで出した指摘が出続ける（`promptVersionWithPastScenes`
 * と同じ理屈）。
 *
 * **引き継がないときは混ぜない。** 既定（0話）の鍵はこれまでと同じままで、
 * 処理済みのキャッシュが無駄に飛ばない。
 */
export function promptVersionWithCarryOver(
  promptVersion: string,
  carryOverText: string
): string {
  if (!carryOverText) return promptVersion;
  return `${promptVersion}:carry${sha1Text(carryOverText).slice(0, 16)}`;
}
