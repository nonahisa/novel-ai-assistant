/**
 * AI の答えの中で名指しされたメニュー項目を拾う（設計書6.104。0.75.6）。
 *
 * **作者の指示（2026-09-22）**：「テストでも製品版でも、AIからの回答で
 * 点滅すると良いと思うので、内部と外部のAIからメニュー操作して2回点滅を
 * 出せるようにしてください」。
 *
 * ## ここは判断だけ。光らせるのは呼ぶ側
 *
 * 拾うだけで、`vscode` にも `ActionSpotlight` にも触らない。相談パネル
 * （内部）と、MCP から来た依頼を捌く見張り（外部）の両方がここを通る。
 * **写しを作らない**ためで、片方だけ賢くなると「相談では光るのに
 * 外部からは光らない」という食い違いが出る。
 *
 * ## 素の一致は、長いラベルだけ
 *
 * 「推敲」「年表」のような短い語は、**本文の話題としてふつうに出てくる。**
 * 答えの中で「推敲について説明します」と言っただけで項目が光ると、
 * 作者は押す場所を指されたと思ってしまう。そこで、
 * **囲み（`「…」`・`**…**`・バッククォート）が付いていれば拾い、
 * 付いていないものは5文字以上のラベルだけ**にした。
 * 囲みは「これは画面の項目の名前だ」という書き手の意思表示なので、
 * 短い語でもそこは信じてよい。
 *
 * ## 長いラベルから先に照合する
 *
 * 「矛盾検知」と「矛盾検知（事実の照合）」のように、片方がもう片方を
 * 含む名前が実在する。短いほうを先に当てると、**長いほうは一生当たらない。**
 */

/** 照合する項目。**ラベルとコマンドIDだけ**あればよい（細い口にする） */
export interface MenuEntry {
  readonly label: string;
  readonly command: string;
}

/** 囲みが無いときに拾う、ラベルの最短の長さ */
export const BARE_MENTION_MIN_LENGTH = 5;

/**
 * 囲みの組。**開きと閉じが同じ長さ**である前提で持つ
 * （前後を同じ文字数だけ見れば済む）。
 */
const WRAPPERS: readonly { readonly open: string; readonly close: string }[] = [
  { open: "「", close: "」" },
  { open: "**", close: "**" },
  // バッククォート。**ふつうの文字列に入れる**（テンプレート文字列にしない）
  { open: "`", close: "`" },
];

interface Hit {
  /** 本文の中で見つかった位置（並べ替えに使う） */
  readonly at: number;
  /** 取られた範囲（囲みを含む）。ここに重なる短いラベルは拾わない */
  readonly start: number;
  readonly end: number;
}

/**
 * 答えの文章の中で名指しされたメニュー項目を、出てきた順に返す。
 *
 * **同じコマンドは1つに畳む。** 同じ項目を何度も言っただけで、
 * 光らせる札が何枚も並ぶのは邪魔なだけである。
 */
export function findMenuMentions(
  text: string,
  items: readonly MenuEntry[]
): MenuEntry[] {
  if (!text) return [];

  // **長いラベルから当てる**（短いほうが先だと、長いほうが当たらない）
  const ordered = [...items].sort(
    (left, right) => right.label.length - left.label.length
  );

  const taken: Hit[] = [];
  const found: { entry: MenuEntry; at: number }[] = [];
  const seen = new Set<string>();

  for (const item of ordered) {
    if (!item.label || seen.has(item.command)) continue;
    const hit = firstHit(text, item.label, taken);
    if (!hit) continue;
    seen.add(item.command);
    taken.push(hit);
    found.push({
      entry: { label: item.label, command: item.command },
      at: hit.at,
    });
  }

  // **出てきた順に戻す。** 長さの順のままだと、答えの流れと札の並びがずれる
  return found.sort((left, right) => left.at - right.at).map((one) => one.entry);
}

/**
 * ラベルを名指しで引く（外部AIが `label` で頼んできたとき）。
 *
 * **完全一致だけ。** ここは文章の中から拾う場面ではなく、呼んだ側が
 * 「この項目」と指してきた場面なので、部分一致で当てにいくと
 * **頼んでいない項目が光る。**
 */
export function findMenuCommandByLabel(
  label: string,
  items: readonly MenuEntry[]
): string | undefined {
  const wanted = label.trim();
  if (!wanted) return undefined;
  return items.find((item) => item.label.trim() === wanted)?.command;
}

/**
 * そのラベルが最初に現れる場所。無ければ undefined。
 *
 * **すでに取られた範囲に重なるものは飛ばす**——長いラベルの中に
 * 含まれているだけの短いラベルを、別の項目として拾わないため。
 */
function firstHit(
  text: string,
  label: string,
  taken: readonly Hit[]
): Hit | undefined {
  for (let at = text.indexOf(label); at >= 0; at = text.indexOf(label, at + 1)) {
    const end = at + label.length;
    const wrapper = WRAPPERS.find(
      (pair) =>
        text.slice(Math.max(0, at - pair.open.length), at) === pair.open &&
        text.slice(end, end + pair.close.length) === pair.close
    );
    // 囲みが無ければ、短い語は拾わない（本文の話題と紛れる）
    if (!wrapper && label.length < BARE_MENTION_MIN_LENGTH) continue;

    const start = wrapper ? at - wrapper.open.length : at;
    const stop = wrapper ? end + wrapper.close.length : end;
    if (taken.some((one) => start < one.end && one.start < stop)) continue;
    return { at, start, end: stop };
  }
  return undefined;
}
