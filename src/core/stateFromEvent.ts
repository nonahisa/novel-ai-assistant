import type { StoryFact } from "../models/storyFact";

/**
 * 出来事から、その直前まで成り立っていた状態を導く（設計書6.88.6）。
 *
 * ## なぜ要るのか
 *
 * 事実には `state`（区間を作る側）と `event`（区間を切る側）がある。
 * 突き合わせは `state` どうしでしか起きないので、**同じ項目でも
 * 片方が `event` だと比べられない。**
 *
 * 2026-09-18 の測定で落ちたのがこれである。第2話は
 * 「怪我＝左の足首」（`state`）、第4話は「怪我＝右足のギプスが外れた」
 * （`event`）。項目名は揃っているのに、**左右の取り違えがどこにも出なかった。**
 *
 * ここは「ギプスが外れた」から「**それ以前はギプスをしていた**」を作る。
 * 作った状態は `derivedFrom` の印を持ち、元の出来事の id を残す。
 *
 * ## 当てにいきすぎない
 *
 * 出来事の言い回しから状態を作るのは、やろうと思えばいくらでも
 * 深読みできる。**確実に言える形だけに絞る**——「無くなった」「外れた」
 * のように、**何かが終わったと言い切っている**言い回しだけを見て、
 * その「何か」を直前の状態とする。「〜になった」のような、**あとの状態**を
 * 言っているものからは導かない（向きが逆になる）。
 *
 * **導けなかったことは失敗ではない。** 分からないものは `null` を返す。
 *
 * VS Code APIに依存しない（LLMも使わない）。
 */

/**
 * 「それが終わった」と言い切っている言い回し。
 *
 * **値の末尾がこれで終わっているときだけ**見る。途中に出てきたものを
 * 拾うと、「ギプスが外れた日に坂を上った」から「坂を上った」が消えて
 * 別の意味になる。
 *
 * 助詞（が・を・から）まで含めて並べてあるのは、剥がしたあとに
 * **名詞句がそのまま残る**ようにするためである。
 */
const ENDING_RULES: readonly string[] = [
  // 外れる・取れる（ギプス・包帯・手錠のたぐい）
  "が外れた",
  "がはずれた",
  "を外した",
  "をはずした",
  "が取れた",
  "がとれた",
  "を取った",
  "が抜けた",
  "を抜いた",
  "が解けた",
  "がとけた",
  "を解いた",
  // 治る
  "が治った",
  "がなおった",
  "が癒えた",
  "が完治した",
  // 消える・失う
  "が消えた",
  "がなくなった",
  "が無くなった",
  "を失った",
  "をなくした",
  "を無くした",
  "を手放した",
  // 身につけていたものを外す
  "を脱いだ",
  "を降ろした",
  "をおろした",
  // やめる・終わる
  "をやめた",
  "を辞めた",
  "が終わった",
  "を終えた",
];

/**
 * 導いた値の長さの上限。
 *
 * これを超えるものは、名詞句ではなく**一文まるごと**である見込みが高い。
 * 文どうしを値として突き合わせても、出るのは言い回しの違いだけになる。
 */
const MAX_DERIVED_LENGTH = 30;

/**
 * `event` から、その直前まで成り立っていた `state` を作る。
 *
 * @returns 導けたら印（`derivedFrom`）付きの事実。導けなければ `null`
 */
export function stateBeforeEvent(event: StoryFact): StoryFact | null {
  if (event.kind !== "event") return null;

  const value = event.value.trim();
  if (!value) return null;

  const rule = ENDING_RULES.find((ending) => value.endsWith(ending));
  if (!rule) return null;

  const derived = lastClauseOf(value.slice(0, value.length - rule.length));
  if (!derived || derived.length > MAX_DERIVED_LENGTH) return null;

  return {
    ...event,
    id: `${event.id}:derived`,
    // 区間を切る側ではなく、区間を作る側にする。**ここが直しの本体**である
    kind: "state",
    value: derived,
    derivedFrom: { eventId: event.id, rule },
  };
}

/** 事実の列から、導ける状態だけを並べる */
export function statesBeforeEvents(
  facts: readonly StoryFact[]
): StoryFact[] {
  const derived: StoryFact[] = [];
  for (const fact of facts) {
    const state = stateBeforeEvent(fact);
    if (state) derived.push(state);
  }
  return derived;
}

/**
 * 最後の一区切りだけを取り出す。
 *
 * 「坂を上った。右足のギプス」のように前に別の文が付いていることがある。
 * **句点の前は別の出来事**なので、後ろだけを状態とする。
 * 読点では切らない（「右足の、ギプス」を割ってしまう）。
 */
function lastClauseOf(text: string): string {
  const parts = text.split(/[。\n]/u);
  return (parts[parts.length - 1] ?? "").trim();
}
