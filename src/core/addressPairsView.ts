import type { Character } from "../models/character";
import {
  ADDRESS_ISSUE_LABELS,
  addressesOf,
  buildAddressPairs,
  describePair,
  pairsInChapter,
  useCoversChapter,
  type AddressPair,
  type AddressPairs,
} from "./addressPairs";

/**
 * 呼び合いを画面へ出す形に組む（設計書6.92）。
 *
 * 作者の依頼（2026-09-13）：「人物設定のパネルに、登場人物間の二人称を
 * 表示させることは可能でしょうか？　本編から開いている場合には、その話で
 * 登場している人物のみ表示するとか。」
 *
 * ## なぜ `addressPairs.ts` と分けるか
 *
 * あちらは「誰が誰をどう呼ぶか」を人物レコードから組み立てるところまでで、
 * 相関図や設定資料集からも使う。**どこへ出すか（何を畳み、何を絞り、
 * どう断るか）は画面ごとの都合**なので、混ぜると出し先が増えるたびに
 * 台帳側が太る。
 *
 * ## ここが文言を持つ
 *
 * 画面（`settingsPanelHtml.ts`）は WebView のスクリプトなので、そのままでは
 * 単体テストから触れない。**作者が読む文（絞り込みの断り・要確認の見出し・
 * 空のときの案内）はこちらに置き**、画面は受け取った文字列を
 * `textContent` で入れるだけにする。
 *
 * ## HTMLを組まない
 *
 * 返すのはすべて素の文字列である。人物名は作者が自由に付けられるので
 * `&` や `<` が入りうるが、画面側が `textContent` で入れる限り
 * 記号のまま表示され、HTMLとしては解釈されない（`innerHTML` で入れると
 * そこだけが抜け道になるので、呼び合いの行では使わない）。
 *
 * VS Code APIに依存しない。
 */

/** どこまで出すか。本文から開いているかで変わる */
export interface AddressScope {
  /** いま開いている本文の話数。本文から開いていなければ null */
  chapter: number | null;
  /** 作者が絞りを外したか。話数があっても、これが立っていれば全部出す */
  showAll: boolean;
}

/** 画面に出す1行 */
export interface AddressLine {
  /** 「コリンナ → 精霊姫ナイン：おひいさま（第3〜11話）」 */
  text: string;
  /** 要確認の理由の札（「自分あて」）。使える組には付かない */
  issue?: string;
}

/** 呼び合いの絞りを切り替える札。押す先が無ければ `label` は空 */
export interface AddressToggle {
  /** 「全部を見る」「第5話に出る人どうしだけ」 */
  label: string;
  /** 押したときに渡す値（`showAll`） */
  all: boolean;
}

/** 人物ごとの節（人物詳細の中） */
export interface CharacterAddressView {
  /** この人 → 相手 */
  calls: AddressLine[];
  /** 相手 → この人 */
  calledBy: AddressLine[];
  /** 絞り込みの断り。絞っていなければ空文字 */
  notice: string;
  /** この人がらみで要確認に回った件数の断り。0件なら空文字 */
  needsCheckNote: string;
  /** 絞りの切り替え。話数が分からなければ label は空文字 */
  toggle: AddressToggle;
}

/** 作品ぜんたいの一覧（作品情報タブ） */
export interface AddressListView {
  /** 「第5話に出る人どうし：11組」 */
  summary: string;
  usable: AddressLine[];
  /** 畳んだ見出し（「要確認（18件）」）。0件なら空文字 */
  needsCheckLabel: string;
  /** 畳みの中身。理由の札つき */
  needsCheck: AddressLine[];
  /** 要確認の読み方。0件なら空文字 */
  needsCheckHint: string;
  /** 1組も無いときの案内。あるときは空文字 */
  emptyNote: string;
  /** 絞りの切り替え。話数が分からなければ label は空文字 */
  toggle: AddressToggle;
}

/** 絞りを掛けたあとの組 */
interface ScopedPairs {
  usable: AddressPair[];
  needsCheck: AddressPair[];
  /** いま話で絞っているか */
  filtered: boolean;
  /**
   * 絞る前の組。**「絞ったから0件」と「そもそも0件」を分ける**ために持つ。
   * 同じ「ありません」で済ませると、絞りを外せば見られることに気づけない。
   */
  before: AddressPairs;
}

/**
 * その話に出る人どうし・その話で使っている呼び方だけにする。
 *
 * **呼び方の範囲でも絞る。** 人だけで絞ると、第3話までの「お嬢ちゃん」が
 * 第10話の会話を書くときにも並ぶ。範囲を持たない呼び方は落とさない
 * （`useCoversChapter` が「使っている」と読む）。
 */
function narrow(
  pairs: readonly AddressPair[],
  chapter: number,
  characters: readonly Character[]
): AddressPair[] {
  return pairsInChapter(pairs, chapter, characters)
    .map((pair) => ({
      ...pair,
      uses: pair.uses.filter((use) => useCoversChapter(use, chapter)),
    }))
    .filter((pair) => pair.uses.length > 0);
}

function scopePairs(
  characters: readonly Character[],
  scope: AddressScope
): ScopedPairs {
  const all = buildAddressPairs(characters);
  const chapter = scope.chapter;
  if (chapter === null || scope.showAll) {
    return {
      usable: all.usable,
      needsCheck: all.needsCheck,
      filtered: false,
      before: all,
    };
  }
  return {
    usable: narrow(all.usable, chapter, characters),
    needsCheck: narrow(all.needsCheck, chapter, characters),
    filtered: true,
    before: all,
  };
}

/**
 * 絞りの切り替えの札。
 *
 * **絞ったら外せるようにする**（作者の依頼、2026-09-13）。その話の会話を
 * 書くための絞りだが、「前はどう呼んでいたか」を確かめたくなることがある。
 */
function toggleOf(scope: AddressScope, filtered: boolean): AddressToggle {
  if (scope.chapter === null) return { label: "", all: false };
  return filtered
    ? { label: "全部を見る", all: true }
    : { label: `第${scope.chapter}話に出る人どうしだけ`, all: false };
}

function usableLine(pair: AddressPair): AddressLine {
  return { text: describePair(pair) };
}

function needsCheckLine(pair: AddressPair): AddressLine {
  return {
    text: describePair(pair),
    issue: pair.issue ? ADDRESS_ISSUE_LABELS[pair.issue] : "",
  };
}

/**
 * 要確認の読み方。
 *
 * **「自分あて」を「壊れている」で済ませない。** 実データでは但し書きに
 * 「アジャーノから呼ばれた際」と入っているものが多く、向きが逆なだけで
 * 中身は使える。捨てずに出しているのはそのためである、と読めるようにする。
 */
const NEEDS_CHECK_HINT =
  "抽出が呼び方と呼ばれ方を取り違えたものです。" +
  "「自分あて」は但し書きに「だれそれから呼ばれた際」と入っていることが多く、" +
  "向きが逆なだけで中身は読めます。";

/**
 * 作品ぜんたいの呼び合い（作品情報タブ）。
 *
 * **使える組を先に、要確認は畳んで出す**（作者の裁定、2026-09-13）。
 * 実データでは31組のうち18組が要確認で、混ぜて並べると3行に2行が
 * 意味を成さない。かといって捨てると、抽出が壊れていることに
 * 気づく機会まで消える。
 */
export function buildAddressListView(
  characters: readonly Character[],
  scope: AddressScope
): AddressListView {
  const scoped = scopePairs(characters, scope);
  const count = scoped.usable.length;
  const summary = scoped.filtered
    ? `第${scope.chapter}話に出る人どうし：${count}組`
    : `作品ぜんたい：${count}組`;

  return {
    summary,
    usable: scoped.usable.map(usableLine),
    needsCheckLabel:
      scoped.needsCheck.length > 0
        ? `要確認（${scoped.needsCheck.length}件）`
        : "",
    needsCheck: scoped.needsCheck.map(needsCheckLine),
    needsCheckHint: scoped.needsCheck.length > 0 ? NEEDS_CHECK_HINT : "",
    emptyNote: emptyNoteOf(scoped),
    toggle: toggleOf(scope, scoped.filtered),
  };
}

/**
 * 1組も出ないときの案内。
 *
 * **絞ったから0件なのか、そもそも0件なのかを分ける。** 同じ「ありません」
 * だと、絞りを外せば見られることに気づけない。
 */
function emptyNoteOf(scoped: ScopedPairs): string {
  if (scoped.usable.length + scoped.needsCheck.length > 0) return "";
  const before = scoped.before.usable.length + scoped.before.needsCheck.length;
  if (scoped.filtered && before > 0) {
    return (
      "この話に出る人どうしの呼び合いはありません。" +
      "「全部を見る」でほかの話の分が見られます。"
    );
  }
  return (
    "呼び合いはまだありません。" +
    "「設定資料を抽出」を実行すると、本文の呼び方から拾います。"
  );
}

/**
 * 人物ごとの節（人物詳細の中）。
 *
 * **1組も無ければ返さない。** 見出しだけが並ぶと壊れて見える
 * （この製品の流儀。押せない札を出さないのと同じ）。
 *
 * 要確認はここでは並べず、件数だけ添えて一覧へ送る。呼ぶ側の人物には
 * 何十件も付いていることがあり（実データのエルシーで25件）、
 * 会話を書きながら見る節に混ぜると、使える組が押し流される。
 */
export function buildCharacterAddressView(
  characters: readonly Character[],
  characterId: string,
  scope: AddressScope
): CharacterAddressView | undefined {
  const scoped = scopePairs(characters, scope);
  const { calls, calledBy } = addressesOf(scoped.usable, characterId);
  if (calls.length === 0 && calledBy.length === 0) {
    /*
      **絞ったせいで空になったときは、節を残す。**

      節ごと消すと、絞りを外す札まで一緒に消える——作者は資料の画面から
      抜け出さないと全部を見られなくなる（絞りは外せるようにする、
      という作者の指示に反する）。見出しだけが並ぶわけではなく、
      断りと外す札が入るので、壊れて見えることもない。
    */
    const wider = addressesOf(scoped.before.usable, characterId);
    if (!scoped.filtered || wider.calls.length + wider.calledBy.length === 0) {
      return undefined;
    }
    return {
      calls: [],
      calledBy: [],
      notice:
        `第${scope.chapter}話に出る人どうしだけを出しています。` +
        "この人の呼び合いは、この話にはありません。",
      needsCheckNote: "",
      toggle: toggleOf(scope, scoped.filtered),
    };
  }

  // 要確認は相手を資料に当てられなかった組なので、当たるのは呼ぶ側だけ。
  // それでも両側を見るのは、当たる形の要確認（同じ名前が複数）が
  // 増えたときに黙って数え落とさないためである
  const pending = scoped.needsCheck.filter(
    (pair) => pair.fromId === characterId || pair.toId === characterId
  ).length;

  return {
    calls: calls.map(usableLine),
    calledBy: calledBy.map(usableLine),
    notice: scoped.filtered
      ? `第${scope.chapter}話に出る人どうしだけを出しています。`
      : "",
    needsCheckNote:
      pending > 0
        ? `この人の呼び方のうち ${pending}件 は相手を資料に当てられませんでした。` +
          "「作品情報」の「呼び合い」で確認できます。"
        : "",
    toggle: toggleOf(scope, scoped.filtered),
  };
}
