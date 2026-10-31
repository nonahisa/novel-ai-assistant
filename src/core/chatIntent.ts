import { parseChatRun, type ChatRun, type ChatRunKind } from "./chatEdit";

/**
 * 「作業を頼まれた」ことをコード側で見分ける。
 *
 * ## なぜAI任せにしないか
 *
 * プロンプトで「作業を頼まれたら run に機能名を入れよ」と何度書いても、
 * 8Bのモデルは**会話の中で作業を終わらせようとして run を落とす**。
 * 実機のログで2回続けて確認した（「すべての作品の設定を抽出してください」
 * 「設定を抽出して統合してください」のどちらも run が付かなかった）。
 * その結果、作者の画面には押せるボタンが出ず、「聞いてくるだけで
 * 全然やってくれない」ことになる。
 *
 * **この作品では、AIに任せて外れるところはコードで決める**方針を取ってきた
 * （マージ処理、文字数の再検証、逐語照合）。ここも同じにする。
 * 「抽出して」と書いてあるかどうかは、規則で十分に見分けられる。
 *
 * ## 規則で見分けただけでは動かさない
 *
 * `detectRunIntent` が見分けても、**ボタンを出すところまで**である。
 *
 * 作者の判断（2026-10-31「明確な意思表示があるなら、AIが機能を実行しても
 * 良いのでは？」）で、**作者がはっきり頼んだ回だけは、押すのを待たずに動かす**
 * ようになった。動かすのは、AIが答えで機能を名指しし（`run`）、
 * 「今すぐ動かす」の印（`runNow`）を立て、**しかも作者の最後の発言が
 * 頼みの形をしている**（`isExplicitRunRequest`）ときだけである。
 * 規則で補ったボタン（AIが名指ししていない）は、これまでどおり押すのを待つ。
 *
 * VS Code APIに依存しない。
 */

/**
 * 依頼の言い回し。
 *
 * **活用を文字で並べようとしない。** 最初は「して」を含むかで見ていたが、
 * 「重複をまとめて」「キャッチコピーを考えて」を取りこぼした。次に
 * テ形の直前の文字を並べたら「作って」（促音便）を落とした。
 * **語尾の形（〜て で終わる／ください等が付く）で見るほうが確実**である。
 */
const REQUEST_WORDS = /(ください|下さい|ほしい|欲しい|お願い|頼む|ませんか|くれる)/;
/** 「場所を抽出して」のように、テ形で言い切る頼み方 */
const REQUEST_TE_ENDING = /て[\s。．!！]*$/;

/**
 * 頼みではなく質問の形。
 *
 * 「抽出ってどうやるの？」に起動ボタンを出すと、**使い方を聞いただけなのに
 * 処理が始まりそうに見える**。こちらは機能の説明で答えるのが正しい。
 */
const QUESTION_PATTERN =
  /(どうやって|どうやる|どのように|どこから|なぜ|なんで|何ですか|とは|教えて|方法|使い方|できますか|できるの|ありますか)/;

interface Rule {
  kind: ChatRunKind;
  /** この語が含まれていれば候補になる */
  match: RegExp;
  /** この語があれば、より細かい種別を優先する */
  priority: number;
}

/**
 * 見分けの規則。**上から順に、当たったもののうち priority が高いものを採る。**
 *
 * 種別を絞った抽出（人物だけ・場所だけ）は、まとめて抽出より優先する。
 * 「人物を抽出して」と言われて全部を抽出すると、要らない待ち時間と料金がかかる。
 */
const RULES: Rule[] = [
  // 校正・校閲
  { kind: "checkNotation", match: /表記ゆれ|表記の揺れ|表記ブレ|表記のブレ/, priority: 90 },
  { kind: "checkTypos", match: /誤字|脱字|誤変換|校正/, priority: 90 },

  // 種別を絞った抽出。まとめて抽出より優先する
  { kind: "extractCharacters", match: /(登場人物|人物|キャラ).{0,6}(抽出|洗い出|拾)/, priority: 80 },
  { kind: "extractLocations", match: /(場所|地名|舞台).{0,6}(抽出|洗い出|拾)/, priority: 80 },
  { kind: "extractAbilities", match: /(能力|スキル|魔法).{0,6}(抽出|洗い出|拾)/, priority: 80 },
  { kind: "extractOrganizations", match: /(組織|勢力|ギルド).{0,6}(抽出|洗い出|拾)/, priority: 80 },
  { kind: "extractWorld", match: /(世界観|設定用語).{0,6}(抽出|洗い出|拾)/, priority: 80 },

  // まとめて抽出
  { kind: "extractSettings", match: /設定.{0,8}(抽出|洗い出|拾)|抽出/, priority: 60 },

  // 資料をまとめる・出す
  { kind: "unifyCharacters", match: /重複|同一人物|まとめ直/, priority: 70 },
  { kind: "applyPendingUpdates", match: /(更新|承認).{0,6}(反映|適用)/, priority: 70 },
  { kind: "generateSettingsDocs", match: /(設定資料集|資料集).{0,8}(出力|作|書き出)/, priority: 70 },
  { kind: "openSettingsPanel", match: /設定資料.{0,6}(開|見せ|表示)/, priority: 50 },

  // 整える
  { kind: "generateSynopses", match: /あらすじ.{0,8}(作|生成|つく|書)/, priority: 80 },
  { kind: "generateWorkBlurb", match: /(紹介文|あらすじ文|作品紹介).{0,8}(作|生成|つく|書)/, priority: 80 },
  { kind: "generateCatchphrases", match: /キャッチ(コピー|フレーズ).{0,8}(作|生成|つく|考)/, priority: 80 },
  { kind: "generatePlot", match: /プロット.{0,10}(起こ|逆算|作|生成)/, priority: 80 },
  { kind: "openSynopsisDocs", match: /(紹介文|あらすじ).{0,6}(開|見せ|表示)/, priority: 50 },

  // 応募先（設計書6.3.6.5。詳細メニューに無い隠し機能）
  {
    kind: "suggestContests",
    match: /(応募先|公募|コンテスト|新人賞|文学賞).{0,10}(提案|選ん|選び|探し|探す|すすめ|勧め|薦め)/,
    priority: 80,
  },
];

/**
 * 質問文から「起動を勧めるべき機能」を見分ける。
 *
 * 見分けられなければ undefined を返す。**迷ったら出さない。**
 * 関係のないボタンが出ると、押していいのか作者が迷う。
 */
export function detectRunIntent(question: string): ChatRunKind | undefined {
  const text = question.trim();
  if (!text) return undefined;

  // 使い方を聞かれているなら、機能の説明で答えるのが正しい
  if (QUESTION_PATTERN.test(text)) return undefined;
  // 依頼の形になっていなければ、ただの話題として扱う
  if (!REQUEST_WORDS.test(text) && !REQUEST_TE_ENDING.test(text)) {
    return undefined;
  }

  let best: Rule | undefined;
  for (const rule of RULES) {
    if (!rule.match.test(text)) continue;
    if (!best || rule.priority > best.priority) best = rule;
  }
  return best?.kind;
}

/**
 * 作者の発言が、**何かを今してほしいという頼みの形か**（作者の判断、2026-10-31）。
 *
 * AIが「今すぐ動かす」の印（`runNow`）を立てても、**AIの出力は信用しない**
 * （実装ルール3）。作者の言葉の側でも頼みの形をしているかを確かめ、
 * 両方がそろったときだけ、押すのを待たずに動かす。
 *
 * - 「資料抽出を実行して」「誤字脱字を走らせてください」「お願いします」→ 頼み
 * - 「抽出してくれる？」「検知してもらえますか？」→ 頼み（作者の判断 2026-11-01）
 * - 「どうすればいい？」「抽出ってできる？」「抽出の使い方を教えて」→ 頼みではない
 *   （使い方を訊いただけで処理が始まると、作者は止め方も分からないまま待たされる）
 *
 * 見る形は `detectRunIntent` と同じ（質問の形なら外し、依頼の語か「〜て」で
 * 言い切っていれば頼み）。**何を頼んだかは見ない**——それは AI の `run` と、
 * 話題の照合（`relatedChatRun`）が受け持つ。
 */
export function isExplicitRunRequest(question: string): boolean {
  const text = question.trim();
  if (!text) return false;
  if (QUESTION_PATTERN.test(text)) return false;
  /*
    「？」で終わる文は、**頼みの定型で結んでいるときだけ**頼みとみなす
    （作者の判断 2026-11-01「『〜てくれる？』は動かす」）。
    「抽出してくれる？」「検知してもらえますか？」は、日本語では訊く形を
    借りたふつうの頼み方である。0.116.1 では「？」で終わる文をすべて外して
    いたが、作者の言い方では頼んでいるのに動かなかった。

    定型以外の「？」（「抽出ってできる？」「〜したほうがいいですか？」
    「抽出してくれるの？」）は、これまでどおり訊いているとみなす。
    能力や方法を訊く語（`QUESTION_PATTERN`）は上で先に外してあるので、
    「使い方を教えてくれる？」は定型に当たっても動かない。
  */
  if (/[?？]\s*$/.test(text)) return REQUEST_QUESTION_ENDING.test(text);
  return REQUEST_WORDS.test(text) || REQUEST_TE_ENDING.test(text);
}

/**
 * 「？」の付いた頼みの定型（「〜てくれる？」「〜てもらえますか？」
 * 「〜ていただけますか？」「〜てくれない？」など）。
 *
 * **文の終わりで見る。** 「くれる」が文の途中にあるだけの問い
 * （「抽出してくれるの？」「〜してくれる機能はある？」）を頼みにしないため。
 * 「で」は「読んでくれる？」（撥音便）の形。
 */
const REQUEST_QUESTION_ENDING =
  /[てで](くれ|もらえ|いただけ|頂け)(る|ます|ない|ません)(か|かな)?[\s。]*[?？]+\s*$/;

/**
 * 起動できる操作ごとの「話題の語」（2026-09-25 深夜の実接続の測定）。
 *
 * ## なぜ要るか
 *
 * 相談の答えの `run`（実行ボタン）は**AIが選んで返す**。これまでコードは
 * 「許可した一覧にあるか」（`parseChatRun`）しか見ていなかったので、一覧に
 * ありさえすれば、質問と無関係でもボタンになった。実測では、読者層の質問に
 * 誤字脱字の検知（e4b）と応募先の提案（26b）、読み上げの質問に推敲と
 * 誤字脱字の検知（e4b）が返った。**AIの出力は信用しない**（実装ルール3）。
 *
 * ## 見方——頼みの形は問わず、話題だけを見る
 *
 * 上の `RULES` は「頼まれたか」まで見てボタンを**足す**ための規則で、厳しい。
 * こちらはAIが出したボタンを**落とす**ための規則なので、話題が合っているか
 * だけを見る（「誤字脱字が気になる」に誤字脱字の検知を出すのは的外れではない）。
 * 語は `RULES` の語を含めて広めに取る——落としすぎると、頼んだ作業の
 * ボタンまで消える（2026-08-15 に実機で続いた不具合の裏返し）。
 *
 * 語が当たる先は**作者の言葉だけ**（質問と直前の作者の発言）。AIの答えの
 * 文面は見ない。答えの中で「誤字脱字の検知も役立ちます」と自分で書けば、
 * 自分の出したボタンの裏づけになってしまう。
 */
const RUN_TOPIC_WORDS: Readonly<Record<ChatRunKind, RegExp>> = {
  checkTypos: /誤字|脱字|誤変換|校正|打ち間違|変換ミス|タイポ/,
  checkTyposForFile: /誤字|脱字|誤変換|校正|打ち間違|変換ミス|タイポ/,
  // 「ぶれ」は入れない。「性格がぶれている」は人物の相談である
  checkNotation: /表記|ゆれ|揺れ|不統一/,
  checkProofread: /推敲|冗長|同語|反復|係り受け|長文|読みやす|文章を(直|整|磨)|言い回し|くどい/,
  checkContradictions: /矛盾|食い違|整合|辻褄|つじつま|設定.{0,6}(違|合)/,
  checkDeviations: /逸脱|間延び|プロット.{0,8}(外れ|ずれ|ズレ|離れ|沿)|脱線/,
  extractSettings: /抽出|洗い出|設定資料|資料|拾/,
  extractCharacters: /登場人物|人物|キャラ/,
  extractLocations: /場所|地名|舞台|土地/,
  extractAbilities: /能力|スキル|魔法|技/,
  extractOrganizations: /組織|勢力|ギルド|団体|国家/,
  extractWorld: /世界観|設定用語|用語/,
  generateSettingsDocs: /資料集|設定資料/,
  openSettingsPanel: /資料集|設定資料/,
  unifyCharacters: /重複|同一人物|同じ人物|まとめ直|統合/,
  applyPendingUpdates: /承認|更新|反映/,
  generateSynopses: /あらすじ|要約/,
  generateWorkBlurb: /紹介文|作品紹介|あらすじ文|紹介/,
  generateCatchphrases: /キャッチ|コピー|惹句/,
  openSynopsisDocs: /紹介文|あらすじ/,
  generatePlot: /プロット|逆算|構成|筋書/,
  suggestContests: /応募|公募|コンテスト|新人賞|文学賞|賞|投稿先/,
};

/**
 * AIが返した実行ボタン（`run`）のうち、作者の言葉と話題が合うものだけを返す。
 *
 * `sources` は質問と、直前の作者の発言（「はい、お願い」のように、話題を
 * 前の発言が持っている返事のため）。**迷ったら出さない**（`detectRunIntent` と
 * 同じ構え）——関係の無いボタンが出ると、押していいのか作者が迷う。
 */
export function relatedChatRun(
  raw: unknown,
  sources: readonly string[]
): ChatRun | undefined {
  const parsed = parseChatRun(raw);
  if (!parsed) return undefined;

  const words = RUN_TOPIC_WORDS[parsed.kind];
  return sources.some((source) => words.test(source)) ? parsed : undefined;
}
