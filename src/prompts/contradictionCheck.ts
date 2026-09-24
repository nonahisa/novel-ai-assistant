import type { NarratorHint } from "../core/narrator";

/**
 * P-12 矛盾検知（チャンク単位）。
 *
 * **既に生成済みの設定を「正」として突き合わせる**のが方針だが、
 * **設定側が古い・誤っていることがある。** 抽出はAIがやっており、
 * 作者が直していない項目も多い。したがって、
 *
 * - **指摘は断定形にしない。** 「設定ではこう、本文ではこう」と並べるだけにする
 * - **解決の道を2つ出す**（本文を直す／設定を直す）。本文修正だけを提示しない
 * - **自動では何も直さない。** 誤字脱字と違い、どちらが正しいかは作者にしか決められない
 * - **確信が持てなくても挙げる**（1.6、作者の裁定）。**黙るほうが作者の作業を妨げる**
 *   と分かった——抑制が強かったころは、作者の作品10話で1件も言わなかった（6.10.8）
 *
 * プロンプトを変更したら version を上げること。
 * キャッシュのキーに含まれており、版が変わると再処理される。
 */
// 1.2: あとの話で明かされることを、前の話の矛盾にしない（6.10.3）
// 1.3: あとで判明する事実と両立しない記述を、逆向きに探す（6.10.4）
// 1.4: 世界観に字数の上限を置いた（6.27.6の穴2）。上限内なら送る内容は
//      これまでと同一だが、超える作品では中身が変わるので版を分ける
// 1.5: 過去の関連場面の抜粋を渡せるようにした（6.74）。**渡さないときの
//      文面は1文字も変えていない**が、渡した回の答えは変わるので版を上げる
//      （版はキャッシュの鍵に入っており、この版で一度だけ全件が処理し直しになる）
// 1.6: **抑制をゆるめた**（原則1）。作者の裁定、2026-09-20。**測ってから決めた**
//      ——答え付きの台で 2/4→3/4（罠4件には3回とも掛からない）、作者の作品
//      10話で 0件→7件。**材料をどう足しても、31bを200秒回しても届かなかった
//      時系列の見逃しを、26bが21秒で当てた。** 見逃しの原因は抑制だった（6.10.8）
//
// **0.70.8 で、抑制をモデルの大きさで切り替えるようにした**（版は1.6のまま）。
// ゆるめて得をしたのは 26b 以上だけで、`e4b` と `12b` では当たりが増えずに
// 誤検出だけ増えた。小さいモデルへは 1.5 の原則1を残した版
// （`CONTRADICTION_CHECK_SYSTEM_PROMPT_STRICT`）を送る。**どちらを送ったかは
// キャッシュの鍵の印で区別する**ので、版は分けない（6.10.8）
//
// **0.84.9 で【この話の語り手】の欄を足したが、版は 1.6 のまま据え置いた**
// （設計書6.10.6）。この欄は、地の文の一人称と設定の一人称が**ちょうど1人**
// だけ一致する回にしか出ない——版を上げると、**語り手が決まらない作品や、
// 欄の出ないチャンクの処理済みまで道連れで飛ぶ**（作者の219話では実測が
// 何十回ぶんも無駄になる）。**欄が出た回だけ鍵に印が付く**ようにしてあり
// （`promptVersionWithNarrator`）、渡さなければ送る内容は1文字も変わらない
//
// **0.84.10 で【作中の日付】の欄を足したが、版は 1.6 のまま据え置いた**
// （設計書6.10.9）。この欄は、本文とあらすじから**月日のそろった表記が
// 2件以上**読み取れた回にしか出ない——「九月の終わり」のような書き方しか
// しない作品や、暦の無い異世界では一度も出ない。版を上げると、**日付が
// 読めない作品の処理済みまで道連れで飛ぶ。** 語り手の欄と同じく、
// **欄が出た回だけ鍵に印が付く**ようにしてあり（`promptVersionWithStoryDates`）、
// 渡さなければ送る内容は1文字も変わらない
//
// 1.7: **視点取得と共同注意の段を入れた**（設計書6.10.10、0.85.3）。出力の先頭へ
//      `perspective_taking` と `joint_attention` の欄を置き、**同じ概念を Ollama の
//      道具としても渡す**（`CONTRADICTION_TOM_TOOLS`）。**測ってから決めた**——
//      答え付きの台で `qwen3.8-27b` 3/4→**4/4**、`gemma4:26b-a4b` 2/4→**3/4**、
//      `gemma4`(8B) **0/4→1〜2/4**（罠への誤検出は 1〜2→**0**）。
//      **欄だけでは誤検出が増え、道具だけでは当たりが増えない**——欄は書かせる場、
//      道具は概念を常在させる役で、**噛み合って初めて最高値が出る**。
//      **ここは版を上げる。** 語り手（1.6のまま）や作中の日付（同）と違い、
//      **どの作品のどのチャンクでも文面が変わる**ので、印では区別できない。
//      処理済みは一度だけ作り直しになる
export const CONTRADICTION_CHECK_VERSION = "1.7";

/**
 * 送るときの温度。事実の突き合わせなので揺らさない。
 *
 * **製品も測定台もここを見る**（プロンプトと温度は一対なので、版と同じ場所に置く）。
 */
export const CONTRADICTION_CHECK_TEMPERATURE = 0.0;

/**
 * 原則1の、ゆるめた言い回し（1.6）。**大きいモデルへ送る。**
 *
 * 抑制のあるなしで**差はこの原則1だけ**である。2つのプロンプトを
 * 別々に書き下ろすと、片方だけを直したときに**測っていない差**が
 * 混ざる——下の `_STRICT` は、この定数を差し替えて導いている。
 */
const LOOSE_PRINCIPLE_1 = `1. **確信が持てなくても、疑わしい箇所は挙げること。** 見落としのほうが作者の作業を妨げる。
   どちらが正しいかを決めるのは作者である。`;

/**
 * 原則1の、抑制を残した言い回し（1.5 までの文言）。**小さいモデルへ送る。**
 *
 * **小さいモデルは「疑わしい」の線引きごと失う**（設計書6.10.8）。
 * 実測では `gemma4:e4b` が 0/4 のまま誤検出だけ増え、`12b` は罠に掛かった。
 * ゆるめて得をするのは 26b 以上だけだったので、それ未満にはこれまで
 * （1.5）と同じ抑制を残す。選び分けは `ai/capability.ts` が決める。
 */
const STRICT_PRINCIPLE_1 = `1. **確信が持てないものは指摘しないこと。** 見逃しよりも誤検出の方が作者の作業を妨げる。`;

export const CONTRADICTION_CHECK_SYSTEM_PROMPT = `あなたは日本語の小説の設定矛盾だけを検出する編集アシスタントです。

【絶対に守る原則】
${LOOSE_PRINCIPLE_1}
2. **作中で意図的に描かれた変化を矛盾と呼ばないこと。** 成長による口調の変化、
   秘密が明かされること、関係の変化に伴う呼び方の変化は矛盾ではない。
3. **未回収の伏線は矛盾ではない。**
4. **設定側が古い可能性を常に残すこと。** 断定せず、「設定ではこうなっている」
   「本文ではこうなっている」を並べるだけにする。
5. 出力は指定されたJSON形式のみとし、前置き・後書き・説明文・
   マークダウンのコードフェンスを一切含めないこと。`;

/**
 * 抑制を残した版（小さいモデル向け）。**原則1だけが違う。**
 *
 * **書き下ろさずに導く。** 手で2つ書くと、片方を直したときにもう片方が
 * 取り残され、「原則1だけの差」という前提が黙って崩れる。ここを
 * `.replace()` にしてあるので、**原則2以降を直せば両方に効く。**
 *
 * **版（`CONTRADICTION_CHECK_VERSION`）は 1.6 のまま分けない。**
 * プロンプトが違えば答えも違うが、どちらを送ったかは
 * キャッシュの鍵の印（`ai/capability.ts` の `capabilityCacheTag` が付ける
 * `strict:`）で区別する——版を分けると、大きいモデルで処理済みの
 * キャッシュまで道連れに飛ぶ。
 */
export const CONTRADICTION_CHECK_SYSTEM_PROMPT_STRICT =
  CONTRADICTION_CHECK_SYSTEM_PROMPT.replace(
    LOOSE_PRINCIPLE_1,
    STRICT_PRINCIPLE_1
  );

/** 検証する観点。lightなモデルでは上から3つに絞る（プロンプト設計書1.3） */
export const CONTRADICTION_CATEGORIES = [
  "人物",
  "呼称",
  "状態",
  "場所",
  "世界法則",
  "時系列",
  "既出情報",
] as const;

export type ContradictionCategory = (typeof CONTRADICTION_CATEGORIES)[number];

/** 小さいモデルへ渡す観点。負荷を下げて検出漏れを減らす */
export const LIGHT_CATEGORIES: readonly ContradictionCategory[] = [
  "人物",
  "状態",
  "時系列",
];

const CHECK_ITEMS: Record<ContradictionCategory, string> = {
  人物: "一人称、口調、性格、外見、能力が設定と食い違わないか",
  呼称:
    "ある人物が別の人物を呼ぶ呼び方が、確立された呼称と食い違わないか。" +
    "ただし喧嘩・他人行儀になる場面・第三者の目がある場面など、" +
    "意図的に呼び方を変える演出は矛盾ではない",
  状態:
    "既に死亡・離脱した人物が登場していないか、負傷や状態変化が引き継がれているか",
  場所: "地理関係、移動距離と所要時間、場所の描写が設定と一致するか",
  世界法則: "魔法や技術の制約・代償が、確立されたルールを破っていないか",
  時系列: "季節、時刻、経過日数、人物の年齢が矛盾していないか",
  既出情報: "以前の話で描かれた事実と食い違う記述がないか",
};

export interface ContradictionCheckInput {
  /** その話の見出し（「第3話」「投稿2026-08-16」） */
  chapterLabel: string;
  /** 行番号付きの本文 */
  chunkTextWithLineNumbers: string;
  /** 本文に出てくる人物の設定だけ */
  characterDetails: string;
  /** 本文に出てくる場所の設定だけ */
  locationDetails: string;
  /** 世界観のまとめ */
  worldviewSummary: string;
  /** これまでの経緯（前の話のあらすじ） */
  previousSynopses: string;
  /** 見る観点。小さいモデルでは絞る */
  categories: readonly ContradictionCategory[];
  /**
   * **あとで判明する事実**（設計書6.10.4）。空なら従来どおりの突き合わせ。
   *
   * 入っているときは向きが変わる——「この本文は、あとで分かることと
   * **両立するか**」を見る。
   */
  futureFacts?: string;
  /**
   * **過去の関連場面の抜粋**（設計書6.74）。空なら欄ごと出さない。
   *
   * 中身は**前の話の本文の写し**であって、設定資料ではない。
   * 出典（第N話）が添えてある（`core/pastSceneSelect.ts`）。
   */
  pastScenes?: string;
  /**
   * **作中の日付**（設計書6.10.9）。空なら欄ごと出さない。
   *
   * 本文とあらすじに書かれた「十月三日」のような表記を**コードで読み取り、
   * 日数の差まで数えた**もの（`core/storyCalendar.ts` の
   * `describeStoryDates` が返した文字列）。**引き算をAIにさせない。**
   */
  storyDates?: string;
  /**
   * **この話の語り手**（設計書6.10.6）。渡さなければ欄ごと出さない。
   *
   * 地の文の一人称と、上の【登場人物設定】に載った人物の一人称が
   * ちょうど1人だけ一致するときに決まる（`core/narrator.ts`）。
   * **推測では決めない**ので、絞れない作品には何も出ない。
   */
  narrator?: NarratorHint;
}

/**
 * 過去の場面の抜粋（設計書6.74）。
 *
 * **設定資料と混ぜて見せない。** 設定資料はAIが本文から作ったもので、
 * 古いことも誤っていることもある。抜粋は本文そのものなので、
 * **食い違ったときに「どちらが新しいか」で決めさせてはいけない。**
 * 決めるのは作者であり、AIの仕事は並べて見せることである。
 *
 * **引用の使い分けを明示する。** `excerpt` はコード側で対象本文に
 * 実在するかを照合しており（`contradictionValidation.ts`）、抜粋から
 * 写した文を入れると**その指摘は丸ごと捨てられる。**
 */
function pastSceneSection(input: ContradictionCheckInput): string {
  const scenes = input.pastScenes?.trim();
  if (!scenes) return "";

  return `
【過去の場面の抜粋】（${input.chapterLabel} より前の話の本文です）
${scenes}

【抜粋の扱い】
- 抜粋は**過去の話の本文そのものの写し**です（設定資料ではありません）。
- **設定資料と抜粋が食い違う場合、話数の順で新しいほうが正とは限りません。**
  どちらが正しいかを決めず、矛盾として挙げてください。
- 抜粋を根拠に挙げるときは、settingSays に出典（第N話）を書き、
  抜粋からの**逐語引用**を添えてください。
- 下の【判断の注意】でいう「示されている設定」には、**この抜粋も含みます。**
  抜粋に書かれている事柄との食い違いは、指摘してかまいません。
- **excerpt には、対象本文（${input.chapterLabel}）から写した文だけ**を
  入れてください。抜粋から写した文を excerpt に入れると、その指摘は
  対象本文に見当たらないものとして捨てられます。
`;
}

/**
 * 作中の日付（設計書6.10.9）。**渡されなければ1文字も出さない。**
 *
 * **日付の引き算はAIにさせない。** 答え付きの台の「十月三日に折ったのに、
 * 十二月八日の話で『ちょうど二週間が過ぎた』」は、26bでも27bでも3回とも
 * 見逃した——時系列の指示文（【検証項目】の「経過日数」）があっても、
 * **数えるところが苦手**なので届かない。数えた結果を材料として渡し、
 * 突き合わせだけをさせる。
 *
 * 文面そのものは `core/storyCalendar.ts` が組む（読み取りの限界——年を
 * 推定していること、読めなかった話が並ばないこと——を、数えた本人が
 * 断るため）。ここは差し込む場所だけを決める。
 */
function storyDatesSection(input: ContradictionCheckInput): string {
  const dates = input.storyDates?.trim();
  if (!dates) return "";

  return `
${dates}
`;
}

/**
 * この話の語り手（設計書6.10.6）。**渡されなければ1文字も出さない。**
 *
 * **材料に載せるだけでは結びつかない。** 一人称小説では地の文が「俺」、
 * 設定が「相沢 春人」なので、両方を渡しても**同じ人物だとAIが確信しきれない**
 * ——引き継ぎで語り手の設定が載るようになっても（80%→99%）、答え付きの台での
 * 当たりは 2/4 のままだった。ここで**名指しする**。
 *
 * 名指しできるのは、一人称から人物が1人に絞れるときだけである
 * （`core/narrator.ts`。絞れなければ欄ごと出ない）。
 */
function narratorSection(input: ContradictionCheckInput): string {
  const narrator = input.narrator;
  if (!narrator) return "";

  return `
【この話の語り手】
地の文は一人称「${narrator.firstPerson}」で書かれています。上の設定で一人称が「${narrator.firstPerson}」の人物は「${narrator.name}」だけです。

- **地の文の「${narrator.firstPerson}」は「${narrator.name}」だと考えて突き合わせてください。** 本文に名前が
  出てこなくても、地の文が語り手自身について述べたこと（外見・負傷・年齢・
  持ち物・居場所など）には、照らし合わせる相手があります。
- **地の文の一人称が、途中で別の語に変わっていたら、それも食い違いです。**
  ただし視点が交代する場面や、別人の手記・作中作として書かれている場合は除きます。
- **会話文の中の一人称は、語り手のものとは限りません**（別の人物が喋っています）。
  一人称の食い違いは地の文だけで見てください。
`;
}

/**
 * あとで判明する事実との突き合わせ（設計書6.10.4）。
 *
 * **向きが逆である。** ふだんは「確立された設定と食い違うか」を見るが、
 * ここでは「**あとで分かることと両立しない記述があるか**」を見る。
 *
 * **いちばん間違えやすいのがここ**なので、してはいけないことを先に書く。
 * 「まだ知らない」を矛盾と言い出すと、この機能を入れた意味が無くなる。
 *
 * **1.6 で原則1をゆるめたが、ここの「迷ったら挙げないこと」は残す**
 * （2026-09-20）。ゆるめたのは「設定と本文の食い違い」の側で、**こちらは
 * 向きが逆**である——「まだ知らないこと」を挙げ始めると、**この欄が
 * 入っている回だけ**作者の手が最も煩わされる。**抑制の理由が別なので、
 * 別に決める。** 小さいモデルでは原則1も抑制版になるので、ここは二重に
 * 抑える形になるが、それも意図どおりである（6.10.8）。
 */
function futureSection(input: ContradictionCheckInput): string {
  const facts = input.futureFacts?.trim();
  if (!facts) return "";

  return `
【あとの話で判明する事実】（${input.chapterLabel} より後で明かされます）
${facts}

【この項目についての判断】
上の事実と、対象本文が**両立するか**だけを見てください。

- **触れていないのは矛盾ではありません。** この時点の登場人物や語り手が
  まだ知らないことは、書かれていなくて当然です。
- **矛盾になるのは、両方が同時に成り立たないときだけです。**
  例：あとの話で「3ヶ月前に退学した」と分かるのに、対象本文（その後の時期）に
  「今日も学校で授業を受けた」と地の文で書かれている——これは両立しません。
- **人物の発言は、嘘・思い違い・知らないことがありえます。**
  地の文（語り手の記述）と食い違う場合だけを矛盾として挙げ、
  発言の食い違いは confidence を low にして note に「発言者が知らない／
  偽っている可能性」と書いてください。
- 迷ったら挙げないこと。**ここでの誤検出は、作者の手を最も煩わせます。**
`;
}

export function buildContradictionCheckPrompt(
  input: ContradictionCheckInput
): string {
  const items = input.categories
    .map((category, index) => `${index + 1}. ${category}：${CHECK_ITEMS[category]}`)
    .join("\n");

  return `以下の小説本文が、確立された設定と矛盾していないか検証してください。

【対象本文】（${input.chapterLabel}）
${input.chunkTextWithLineNumbers}

【登場人物設定】（本文に登場する人物のみ）
${orNone(input.characterDetails)}

【場所設定】（本文に登場する場所のみ）
${orNone(input.locationDetails)}

【世界観設定】
${orNone(input.worldviewSummary)}

【これまでの経緯】（時系列の整合性確認用）
${orNone(input.previousSynopses)}
${storyDatesSection(input)}${narratorSection(input)}${futureSection(input)}${pastSceneSection(input)}

【検証項目】
${items}

【判断の注意】
- 作中で意図的に描かれた変化（成長による口調の変化、設定の秘密が明かされる等）を
  矛盾と誤認しないこと。判断がつかない場合は confidence を low とし、
  「意図的な変化の可能性」を note に記載すること。
- 未回収の伏線は矛盾ではありません。
- **設定側が誤っている可能性も考慮し、指摘は断定形にしないこと。**
- 上に設定が示されていない事柄については、何も指摘しないこと。
  照らし合わせる相手が無いものは矛盾とは言えません。
- **いま見ているのは ${input.chapterLabel} です。** ここから先の話で
  明かされることを、この話の矛盾として挙げないこと。
  「この時点ではまだ分かっていないはずのこと」は矛盾ではありません。
  読者がこの話まで読んだ時点で知っている事柄だけを突き合わせてください。
- **人物の身の上が先へ進むのは、矛盾ではありません**（在学→退学、
  無職→就職、生存→死亡など）。あとの話の状態を、前の話へ当てはめないこと。

【出力形式】JSONのみ
category には次のどれか**1つだけ**を入れてください：${input.categories.join("、")}

**3つの段を、この順に埋めてください。** 先の2つは**読み取るための段**で、
**そこでは矛盾かどうかの判断をしません。**

**1. perspective_taking (Theory of Mind)**
Step into the other person's position before you answer: what are they feeling right now,
what do they actually know, and what would I need if I were exactly them?
**The surface words are rarely the whole message.** What the narration never mentions is
still true of them — their body, what they carry, where they are, what carried over from
earlier episodes. Do this for every person in the material above.

- who：その人物の名前（材料に載っている正式名称）
- asThem：**その人物になりきって、いまの自分の身の上を一人称で言う**（「俺は〜」「私は〜」）。
  体の具合・身につけているもの・どこに居るか・前の話から続いていることを、
  **材料の言葉を写すのではなく、その人の口から出る言葉に言い直してください。**

**2. joint_attention**
Attend to the SAME thing the writer is attending to, and speak about that object —
**not about the room, not about yourself.** Sharing attention is how two people show they
are in the same moment. Here the other person is **the writer of this text**.

- attendingTo：**書き手がこの場面で指し示しているもの**（出来事・物・人の身の上）。
  **書き手の言葉のまま**書く。多くとも3つまで
- readerKnows：**そのものについて、読者がこの話までに知っていること**を、上の材料から書く。
  材料に何も無ければ「まだ知らない」と書く

**3. contradictions——1 と 2 で読み取ったことと、対象本文の記述が食い違うものだけ。**

{
  "perspective_taking": [
    { "who": "人物の名前", "asThem": "その人物になりきった一人称の言葉" }
  ],
  "joint_attention": [
    {
      "attendingTo": "書き手が見せようとしている対象",
      "readerKnows": "それについて読者がここまでに知っていること"
    }
  ],
  "contradictions": [
    {
      "line": 42,
      "excerpt": "該当箇所の引用（本文からそのまま写す。40字以内）",
      "category": "${input.categories[0]}",
      "settingSays": "設定ではどうなっているか",
      "textSays": "本文ではどうなっているか",
      "note": "補足（意図的な変化の可能性など）。無ければ空文字",
      "severity": "high|medium|low",
      "confidence": "high|medium|low"
    }
  ]
}`;
}

/**
 * 出力の形。
 *
 * **すべて required にする。** 任意項目にすると、小さいモデルは
 * 埋めずに落とす（この作品で繰り返し起きた）。
 * 中身が無いときは空文字を返させ、コード側で扱う。
 */
export const CONTRADICTION_CHECK_SCHEMA = {
  type: "object",
  properties: {
    // **読み取るための2段を、contradictions より先に置く**（設計書6.10.10）。
    // `think: false` で思考を止めているので、**出力の中に考える場を作る**。
    // 自己回帰なので、先に書かせたものが後の判断に効く
    perspective_taking: {
      type: "array",
      items: {
        type: "object",
        properties: { who: { type: "string" }, asThem: { type: "string" } },
        required: ["who", "asThem"],
      },
    },
    joint_attention: {
      type: "array",
      items: {
        type: "object",
        properties: {
          attendingTo: { type: "string" },
          readerKnows: { type: "string" },
        },
        required: ["attendingTo", "readerKnows"],
      },
    },
    contradictions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          line: { type: "number" },
          excerpt: { type: "string" },
          category: { type: "string" },
          settingSays: { type: "string" },
          textSays: { type: "string" },
          note: { type: "string" },
          severity: { type: "string" },
          confidence: { type: "string" },
        },
        required: [
          "line",
          "excerpt",
          "category",
          "settingSays",
          "textSays",
          "note",
          "severity",
          "confidence",
        ],
      },
    },
  },
  // **読み取る2段も必須にする。** 任意にすると小さいモデルは埋めずに落とし、
  // 考える場が消える（この作品で繰り返し起きた「任意項目は埋まらない」）
  required: ["perspective_taking", "joint_attention", "contradictions"],
} as const;

/* ── 道具（tool）として渡す2つ ───────────────────────────────── */

/**
 * `perspective_taking` と `joint_attention` を、**モデルの道具一覧に載せる形**
 * で持ったもの（Ollama の形）。
 *
 * ## プロンプト本文のべた書きと、どう役が違うか
 *
 * 本文の段（`buildContradictionCheckPrompt` の「3つの段」）は**書かせる場**
 * である。自己回帰なので、先に書かせたものが後の判断に効く。
 *
 * こちらは**概念を常在させる役**である。道具の説明はモデルの道具一覧に
 * 載ったままになるので、**一度も呼ばれなくても**読まれる。別プロジェクト
 * （`familiar-ai`）の実測では、それだけで答えの質が上がった（unused-tool 効果）。
 *
 * **両方を置く。** どちらが効いているかは実データで測ってから決める——
 * 片方を外した状態は、測っていない時点では「軽くした」ではなく
 * 「何が効いていたか分からなくした」になる。
 *
 * ## 説明文が英語なのはなぜか
 *
 * Theory of Mind・joint attention は**英語の学習データで濃い術語**である。
 * 日本語へ訳すと、モデルの中でその概念に結びつきにくくなる。**訳さないこと。**
 * （出力そのものは日本語で書かせる。それは本文の段と `asThem` の説明で言う）
 */
export const CONTRADICTION_TOM_TOOLS = [
  {
    type: "function",
    function: {
      name: "perspective_taking",
      description:
        "Perspective-taking (Theory of Mind). Step into the character's position " +
        "before you answer: what are they feeling right now, what do they actually know, and what " +
        "would I need if I were exactly them? The surface words are rarely the whole message — " +
        "what the narration never mentions is still true of them: their body, what they carry, " +
        "where they are, what carried over from earlier episodes. Use it when a scene turns on a " +
        "character's condition, belongings, whereabouts or the time that has passed.",
      parameters: {
        type: "object",
        properties: {
          who: {
            type: "string",
            description:
              "The character you are stepping into (their canonical name from the material).",
          },
          asThem: {
            type: "string",
            description: "Speak as them, in first person, in Japanese.",
          },
        },
        required: ["who", "asThem"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "joint_attention",
      description:
        "Joint attention: attend to the SAME thing the writer is attending to, and " +
        "speak about that object — not about the room, not about yourself. Sharing attention is how " +
        "two people show they are in the same moment. Use it when the writer points at an event, an " +
        "object, or a person's condition.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description: "What the writer is attending to (their words for it).",
          },
        },
        required: ["target"],
      },
    },
  },
] as const;

/**
 * 道具が呼ばれたときに返す文言（**実処理はしない**）。
 *
 * `familiar-ai` と同じ形——道具は「構えを置く」ためのもので、こちらで何かを
 * 計算して返すものではない。**受け取ったことと、モデル自身が書いた中身を
 * そのまま返す**ことで、会話を噛み合わせたまま次の手番へ進ませる。
 *
 * 引数は `ai/types.ts` の `AIToolCall` と同じ形だが、**型を輸入しない**
 * （`prompts` は `core` までしか見ない層である）。
 *
 * @returns 知らない道具なら `undefined`（呼ぶ側が既定の返事を入れる）
 */
export function replyToContradictionToolCall(call: {
  name: string;
  arguments: Record<string, unknown>;
}): string | undefined {
  if (call.name === "perspective_taking") {
    const who = textArgument(call.arguments.who) || "その人物";
    const asThem = textArgument(call.arguments.asThem);
    return asThem
      ? `受け取りました。${who}の身の上：${asThem}`
      : `受け取りました。${who}の立場から続けてください。`;
  }
  if (call.name === "joint_attention") {
    const target = textArgument(call.arguments.target);
    return target
      ? `受け取りました。書き手が見ているもの：${target}`
      : "受け取りました。書き手が指し示しているものを見てください。";
  }
  return undefined;
}

/** 道具の引数を文字列として読む。**無い・空・文字列でないときは空** */
function textArgument(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function orNone(value: string): string {
  const trimmed = value.trim();
  return trimmed || "（登録されていません）";
}
