import type { ChatRunKind } from "./chatEdit";

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
 * ## 押すのは作者
 *
 * 見分けたからといって実行はしない。**ボタンを出すところまで**である。
 * 作者から許可されたのは「承諾性で起動すること」であり、
 * 会話の一言で処理が始まってよいわけではない。
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
