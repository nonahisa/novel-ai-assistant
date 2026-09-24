import type { Character } from "../models/character";
import { detectFirstPerson } from "./workStyleFacts";

/**
 * 地の文の「俺」が、設定のどの人物なのかを名指しする（設計書6.10.6）。
 *
 * **材料に載せるだけでは結びつかない。** 一人称小説では、地の文は「俺」、
 * 設定は「相沢 春人」と書かれている——引き継ぎ（`carryOverChapters`）で
 * 語り手の設定が材料に載るようになっても（80%→99%）、**答え付きの台での
 * 当たりは 2/4 のまま増えなかった。** その2つが同じ人物だと、AIが
 * 確信しきれないからである。
 *
 * **推測で決め打ちはしない。** 設計書6.10.6 で「一人称から人物を決める」
 * 案を出したとき、作者はこう指摘して退けている——**「『僕』はキャラごとに
 * 独自ということはないと思いますが……」。** 同じ一人称を使う人物は
 * いくらでもいるので、一人称だけで人物を決めれば必ず誤る。
 *
 * そこでここが言うのは、**候補がちょうど1人に絞れるとき**だけにした。
 * 台帳が埋まって同じ一人称の人物が2人以上になったら黙る＝安全側に倒す。
 * 絞れない作品では、これまでと1文字も変わらない材料が送られる。
 */

export interface NarratorHint {
  /** 地の文から数えた一人称（「俺」） */
  firstPerson: string;
  /** その一人称を持つ人物の正式名称 */
  name: string;
}

export function detectNarrator(options: {
  /** 一人称を数える本文（対象チャンク＋引き継いだ本文） */
  narrationText: string;
  /** **材料に載った人物だけ**を渡すこと（載っていない人物を語り手と呼ばない） */
  people: readonly Character[];
}): NarratorHint | null {
  // **数え方は書き写さない**（`workStyleFacts.ts` の `detectFirstPerson`）。
  // 台詞を落とす・10回未満なら決めない・6割未満なら決めない、という
  // 線引きを2か所に書くと、片方だけを直したときに黙って食い違う
  const firstPerson = detectFirstPerson(options.narrationText);
  if (!firstPerson) return null;

  // **名前で畳む。** 同じ人物の資料が2件ある作品があり（`missedCharacters`
  // と同じ事情）、そこで黙ると、重複があるというだけの理由で語り手を
  // 言えなくなる。**別人が2人いれば、名前が違うのでここで2件になる**
  const names: string[] = [];
  for (const person of options.people) {
    const forms = [
      person.firstPerson.default,
      ...person.firstPerson.variants.map((variant) => variant.form),
    ];
    // **完全一致だけを見る。** 「俺」と「俺様」は別の語なので、
    // 部分一致で拾うと別人まで候補に入って絞れなくなる
    if (!forms.some((form) => (form ?? "").trim() === firstPerson)) continue;
    if (names.includes(person.name)) continue;
    names.push(person.name);
  }

  // 0人（設定に一人称が登録されていない）も、2人以上（絞れない）も黙る
  if (names.length !== 1) return null;
  return { firstPerson, name: names[0] };
}
