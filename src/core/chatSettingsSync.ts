import {
  CHAT_SETTINGS_SYNC_HINTS,
  type RawChatDecision,
} from "../prompts/chatSettingsSync";
import type { WorkChatTurn } from "../prompts/workChat";
import { evidenceSegments, normalizeForComparison } from "./groundedEvidence";
import { sha256Text } from "./hash";
import { isPlaceholderText } from "./placeholderText";
import type { PlotCharacterEntry } from "./plotCharacterSync";

/**
 * 相談から設定資料への書き込み（設計書6.72）の、読むだけの部品。
 *
 * ここは**純粋関数だけ**である。VS Code APIにも台帳にも触らない。
 * 積む側（`features/chatSettingsSync.ts`）が、ここで作った候補を
 * `plotCharacterSync` の突合へ渡す。
 *
 * ## plot差分反映と同じ骨組みを使う
 *
 * 出口を `PlotCharacterEntry`（名前＋説明）に揃えているのは、
 * **突合の決まりを1か所に置くため**である。「作者が確定させた人物は
 * 変えない」「同じ呼び名が複数居たら当てない」という守りを二重に持つと、
 * 片方だけ直したときに経路によって挙動が変わる。
 */

/** 検証で落ちた1件と、その理由 */
export interface ChatDecisionRejection {
  name: string;
  /**
   * placeholder: 「該当なし」のような、中身の無い言葉が値に入っていた
   * ungrounded: 根拠の引用が会話の中に見当たらない（言い換え・捏造）
   */
  reason: "placeholder" | "ungrounded";
}

/**
 * 短い同意（「うん」「OK」）で通した1件と、**どの案を認めたのか**。
 *
 * 結びつけるのはAIではなくコードである（実装ルール3）——引用に写された
 * AIの案が会話のどの発言か、その**すぐ次**が作者の同意だけの発言か、を
 * 発言の並びで確かめる。記録に残して、承認待ちに並んだ案の出どころを
 * 後から追えるようにする。
 */
export interface ChatAgreementBinding {
  name: string;
  /** 作者が同意した、直前のAIの発言（全文） */
  proposal: string;
  /** 作者の同意の発言（「うん」など、そのまま） */
  agreement: string;
}

export interface VerifiedChatDecisions {
  entries: PlotCharacterEntry[];
  rejected: ChatDecisionRejection[];
  /** 短い同意で通したもの。**通常の照合で通ったものは入らない** */
  agreements: ChatAgreementBinding[];
}

/**
 * 会話をAIへ渡す形にする。
 *
 * **この文字列が、根拠の逐語照合の母材にもなる。** プロンプト用と照合用で
 * 別々に組み立てると、AIが見た文と照合する文がずれて、正しい引用まで
 * 落ちる（あるいはその逆で、見ていない文と照合して通ってしまう）。
 *
 * 話し手を「AI」と書くのは、この相談の**外から読む**係だからである
 * （P-21では「あなた」と書いている。あちらは会話の当事者）。
 */
export function formatChatConversation(
  turns: readonly WorkChatTurn[]
): string {
  return turns
    .map((turn) => `${turn.role === "author" ? "作者" : "AI"}: ${turn.text}`)
    .join("\n");
}

/**
 * 作者の発言だけを並べたもの。**根拠の照合に使う**（0.32.6のレビュー）。
 *
 * この機能が拾うのは「**作者が**決めたこと」である。会話全体と照らすと、
 * AIが自分の提案文を引用しただけで逐語一致が通り、作者が受け入れて
 * いない案まで承認待ちへ積まれる（P-32のプロンプトは「作者の発言を必ず
 * 1つ含める」と言っているが、**AIの言うことは信用しない**）。
 *
 * 話し手の札（「作者:」）は付けない。**引用に札は入らない**ので、
 * 付けると行の境目で偽の一致が生まれる余地だけが増える。
 */
export function formatAuthorConversation(
  turns: readonly WorkChatTurn[]
): string {
  return turns
    .filter((turn) => turn.role === "author")
    .map((turn) => turn.text)
    .join("\n");
}

/**
 * 会話の内容ハッシュ。**同じ相談を二度積まない**ための鍵である。
 *
 * **並べ替えたら別物になる**（plotの `plotCharactersDigest` との違い）。
 * 人物の一覧は順不同の集合だが、相談は流れであり、同じ発言でも順番が
 * 変われば「何が決まったか」が変わる。
 *
 * 1発言を `JSON.stringify` で綴じる。**区切り文字を自前で決めない**
 * ——本文に現れない文字を選ぶのは難しく、NULのような制御文字を書けば
 * 今度はソースがバイナリ扱いされる。
 */
export function chatHistoryDigest(turns: readonly WorkChatTurn[]): string {
  return sha256Text(
    turns.map((turn) => JSON.stringify([turn.role, turn.text])).join("\n")
  );
}

export interface TrimmedChatHistory {
  turns: WorkChatTurn[];
  /** 削った発言の数。作者へ「古い分を外した」と伝えるために持つ */
  dropped: number;
}

/**
 * 長すぎる会話を、古いほうから削る。
 *
 * 相談は12往復までしか覚えていないので普通は収まるが、1回の発言が
 * 極端に長い（本文を貼った）ことはある。**入力を測るのは組んだ後**で、
 * 上限を超えたぶんだけ古い発言を落とす——直近の決定が落ちては、
 * この機能そのものが意味を失う。
 */
export function trimChatHistory(
  turns: readonly WorkChatTurn[],
  maxChars: number
): TrimmedChatHistory {
  const kept = [...turns];
  let dropped = 0;
  // 最後の1発言だけは、どれだけ長くても残す（削り切ると何も渡せない）
  while (kept.length > 1 && formatChatConversation(kept).length > maxChars) {
    kept.shift();
    dropped++;
  }
  return { turns: kept, dropped };
}

/**
 * P-32の答えを検証する。
 *
 * **AIが「決まった」と言っただけでは積まない。** 通すのは、
 *   1. 名前と決定の文が、指示語の言い換えでないこと
 *   2. 根拠の引用が、会話の中に逐語で実在すること
 *   3. その引用の断片が、**作者の発言の中に**1つ以上あること
 * のすべてを満たしたものだけである。落ちたものは黙って捨てず、理由つきで
 * 返す（完了通知に「根拠が確認できず見送りN件」と出す）。
 *
 * 3を足したのは0.32.6のレビューによる。会話全体とだけ照らしていたので、
 * **AIが自分の提案文を引用すれば通っていた。** それは「AIがそう言った」
 * ことの証拠でしかなく、作者が受け入れたかどうかを何も言っていない。
 *
 * 照合は `groundedEvidence` と同じ流儀にする——空白の全角半角差と、
 * gemma系が返すバイト表記（`<0xE3>`）を落としてから比べ、**断片のどれか
 * 1つでも会話にあれば通す**。すべてを求めると、句点で切れた末尾の
 * 一片が合わないだけで本物の引用まで落ちる。
 *
 * **会話は文字列ではなく発言の並びで受け取る。** 組み立てをここで行えば、
 * AIへ渡した文と照合する文がずれようがない（別々に組むと、正しい引用まで
 * 落ちる／見ていない文と照合して通る、のどちらも起こりうる）。
 */
export function verifyChatDecisions(
  decisions: readonly RawChatDecision[],
  turns: readonly WorkChatTurn[]
): VerifiedChatDecisions {
  const entries: PlotCharacterEntry[] = [];
  const rejected: ChatDecisionRejection[] = [];
  const agreements: ChatAgreementBinding[] = [];
  const normalizedConversation = normalizeForComparison(
    formatChatConversation(turns)
  );
  const normalizedAuthorSaid = normalizeForComparison(
    formatAuthorConversation(turns)
  );

  for (const decision of decisions) {
    const name = decision.name.trim();
    const decided = decision.decided.trim();

    // **指示の言葉がそのまま返ってくる**（この作品で繰り返し起きた失敗3）
    if (isEmptyAnswer(name) || isEmptyAnswer(decided)) {
      rejected.push({ name: name || "（名前なし）", reason: "placeholder" });
      continue;
    }
    if (isEmptyAnswer(decision.evidence)) {
      rejected.push({ name, reason: "placeholder" });
      continue;
    }

    // **話し手の札を外してから照らす**（残課題 F9）。会話は札を付けて
    // AIへ渡しているので、AIは「作者: 17歳でいこう」と札ごと写してくる。
    // 作者の発言だけの母材には札が無く、札つきのままでは必ず落ちていた
    const segments = evidenceSegments(stripSpeakerTags(decision.evidence));
    const grounded = segments.some((segment) =>
      normalizedConversation.includes(segment)
    );
    // **作者の発言にも当たっていること。** 会話にあるだけでは、
    // AIが自分の案を写しただけかもしれない
    const fromAuthor = segments.some((segment) =>
      normalizedAuthorSaid.includes(segment)
    );
    if (grounded && fromAuthor) {
      entries.push({ name, summary: decided });
      continue;
    }

    // 作者の発言側が短い同意（「うん」）だけのときは、照合に使える断片が
    // 残らない（4字未満は誤一致の元なので捨てている）。**直前のAIの案に
    // 作者が同意した**ことを発言の並びで確かめられたときだけ通す
    const bound = grounded
      ? bindAgreement(decision.evidence, segments, turns)
      : undefined;
    if (!bound) {
      rejected.push({ name, reason: "ungrounded" });
      continue;
    }
    entries.push({ name, summary: decided });
    agreements.push({ name, ...bound });
  }

  return { entries, rejected, agreements };
}

/**
 * 引用から話し手の札（「作者:」「AI:」）を外し、区切りに置き換える。
 *
 * 札は `formatChatConversation` が付けたもので、発言の中身ではない。
 * 区切り（改行）にするのは、1行に2人分を写した引用（「AI: …？ 作者: うん」）
 * を発言ごとの断片に割るため。
 */
function stripSpeakerTags(evidence: string): string {
  return evidence.replace(/(?:作者|AI)[ \t　]*[:：]/gu, "\n");
}

/**
 * 同意だけの返事として数える言葉（比べる形は `agreementKey`）。
 *
 * **並べた言葉の組み合わせだけ**を同意とみなす（「うん、それで」は通る）。
 * 「うーん」「いや」「NO」のような返事は、短くても同意ではない。
 * 迷う言葉は入れない——入れ損ねた同意は落ちるだけ（作者が承認待ちで
 * 足せる）だが、入れすぎると断った案が作者の決定として積まれる。
 */
const AGREEMENT_WORDS: readonly string[] = [
  "うん",
  "うむ",
  "はい",
  "ええ",
  "ok",
  "okay",
  "おk",
  "オッケー",
  "オーケー",
  "いいね",
  "いいよ",
  "いいです",
  "了解",
  "了解です",
  "賛成",
  "同意",
  "採用",
  "それで",
  "それだ",
  "それです",
  "それでいい",
  "それでいこう",
  "それでお願いします",
  "決まり",
  "よし",
  "そうしよう",
  "そうします",
  "お願いします",
];

const AGREEMENT_KEYS = new Set(AGREEMENT_WORDS.map(agreementKey));

/**
 * 同意の言葉を比べる形。全角半角と大小をそろえ、空白と句読点・感嘆符を落とす。
 * **長音（ー）は落とさない**——落とすと「うーん」が「うん」になる。
 */
function agreementKey(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s　。、，,.．！？!?…・「」『』"'“”‘’（）()〜~]/gu, "");
}

/** その発言が、同意の言葉だけでできているか（「うん、それで」も通す） */
function isAgreementOnly(text: string): boolean {
  const key = agreementKey(text);
  if (!key) return false;
  // 先頭から、並べた言葉で割り切れるかを見る（短い言葉の組み合わせ）
  const reachable = new Array<boolean>(key.length + 1).fill(false);
  reachable[0] = true;
  for (let start = 0; start < key.length; start++) {
    if (!reachable[start]) continue;
    for (const word of AGREEMENT_KEYS) {
      if (key.startsWith(word, start)) reachable[start + word.length] = true;
    }
  }
  return reachable[key.length];
}

/**
 * 引用が「AIの案」と「そのすぐ次の作者の同意」を写しているかを、
 * **発言の並びで**確かめる。確かめられたら、どの案に同意したかを返す。
 *
 * 条件は3つ。すべてコードで見る（AIの「作者が同意した」は信用しない）。
 *   1. 引用の断片（4字以上）が、あるAIの発言 i の中にある
 *   2. 発言 i のすぐ次が作者の発言で、それが同意の言葉だけでできている
 *   3. 引用の中に、その同意の発言が（札や句読点を除いて）そのまま写されている
 *
 * **すぐ次に限る。** 間に別の案が挟まると、「うん」がどの案への返事か
 * 決められない（16歳の案への「うん」を、17歳の案の同意として積まない）。
 */
function bindAgreement(
  evidence: string,
  segments: readonly string[],
  turns: readonly WorkChatTurn[]
): { proposal: string; agreement: string } | undefined {
  const quotedPieces = new Set(
    stripSpeakerTags(evidence)
      .split(/[\r\n。！？!?]+/u)
      .map(agreementKey)
      .filter((piece) => piece.length > 0)
  );
  for (let index = 0; index + 1 < turns.length; index++) {
    const proposal = turns[index];
    const reply = turns[index + 1];
    if (proposal.role !== "assistant" || reply.role !== "author") continue;
    if (!isAgreementOnly(reply.text)) continue;
    if (!quotedPieces.has(agreementKey(reply.text))) continue;
    const normalizedProposal = normalizeForComparison(proposal.text);
    if (!segments.some((segment) => normalizedProposal.includes(segment))) {
      continue;
    }
    return { proposal: proposal.text, agreement: reply.text };
  }
  return undefined;
}

/**
 * 「中身が無い」ことを中身として書いてきたか。
 *
 * 空・言い換え（`placeholderText`）に加えて、**出力例に書いた項目の
 * 言い換えが丸ごと返ってきた場合**も中身なしとして扱う
 * （`foreshadowValidation.ts` の同名の判定と同じ考え方）。
 * 部分一致では見ない——ヒント語は日本語として自然な句なので、
 * 本物の文の中にも普通に現れる。
 */
function isEmptyAnswer(text: string): boolean {
  if (isPlaceholderText(text)) return true;
  const body = normalizeForComparison(text);
  if (!body) return true;
  return CHAT_SETTINGS_SYNC_HINTS.some(
    (hint) => body === normalizeForComparison(hint)
  );
}
