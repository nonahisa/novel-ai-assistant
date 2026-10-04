import type { WorkChatTurn } from "../prompts/workChat";
import {
  buildReaderAimPrompt,
  buildReaderTypeGlossaryPrompt,
  buildReaderTypePrompt,
  buildReaderTypeReminder,
  buildReaderTypeUnknownPrompt,
  questionMentionsReader,
} from "../prompts/readerTarget";
import type { ReaderProfile } from "../models/readerProfile";
import { READER_TYPES } from "./readerTarget";
import type { ReaderAim } from "./targetSheetDoc";
import { clipReason } from "./targetSheetAdvice";
import { buildFeatureGuideForQuestion } from "./featureGuide";
import { CHARACTER_NAMES_HEADING } from "./chatFileRequest";

/**
 * 相談（P-21、設計書6.19）へ渡す材料のうち、**画面の状態に依らない組み方**。
 *
 * 製品の相談パネル（`features/workChatPanel.ts`）と、外から呼ぶ相談
 * （`mcp/tools/chat.ts`）の**両方がここを通る**（2026-10-01。残課題 R6）。
 *
 * 以前は組み立てがパネルの中にだけあり、MCP は「使い方の束」も
 * 「読者を決めていないことの断り」「読者の区分の一覧」も渡していなかった。
 * 外から相談の出来を測ると、**製品に無い答えを見ることになる**
 * （CLAUDE.md の失敗5）。写しを置くと片方だけ古くなるので、
 * 組み方そのものをここに1つだけ置く。
 *
 * **画面の状態（開いているファイル・カーソル位置・意味検索の索引）に
 * 関わる部分は、ここに置かない。** そちらは製品にしか無い材料で、
 * MCP 側では持てない（違いは `mcp/tools/chat.ts` の冒頭に一覧で書いてある）。
 */

/** 覚えておくやり取りの数。増やすほど入力が伸びて料金がかかる */
export const WORK_CHAT_HISTORY_TURNS = 12;

/**
 * 作者の最後の発言（あれば1件）。
 *
 * **今回の質問を履歴へ積む前に**渡すこと——積んだあとだと、今回の質問
 * そのものが返る。追い質問（「それはどこ？」）は話題を直前の発言が
 * 持っているので、使い方の束を選ぶ材料にする。
 */
export function lastAuthorTurnsOf(history: readonly WorkChatTurn[]): string[] {
  const last = [...history].reverse().find((turn) => turn.role === "author");
  return last ? [last.text] : [];
}

/**
 * 全体像（`formatChatOverview`）で、長い各話あらすじから載せる話を選ぶ手がかり
 * （2026-10-01）。今回の問いと、直前の作者の発言。
 *
 * 「それは何話？」のような追い質問は、話題（「塩不足」）を直前の発言が
 * 持っている。使い方の束を選ぶときと同じ考え方で、同じ範囲を見る。
 */
export function workChatOverviewFocus(
  question: string,
  history: readonly WorkChatTurn[]
): string[] {
  return [question, ...lastAuthorTurnsOf(history)];
}

/**
 * 使い方の束（目次＋関係しそうな説明＋手順書き）と、システムプロンプトの
 * 使い方の節を入れるか。
 *
 * **切り替えは1つの条件で**——創作の相談（`craft`）だけ目次を落とし、
 * 使い方の節も外す。2つに割れると、片方だけ直る日が来る。
 * **AIは呼ばない**（字面の照合だけ）。
 */
export function workChatFeatureGuide(
  question: string,
  history: readonly WorkChatTurn[]
): ReturnType<typeof buildFeatureGuideForQuestion> & { featureIndex: boolean } {
  const guide = buildFeatureGuideForQuestion({
    question,
    recentAuthorTurns: lastAuthorTurnsOf(history),
  });
  return { ...guide, featureIndex: guide.topic !== "craft" };
}

/**
 * ターゲット読者の段（設計書6.91.9）。**作品が決まっている相談でだけ**呼ぶ。
 *
 * - 決めていればその1タイプの文、**決めていなければ決めていないことだけ**
 *   （作者の実機報告、2026-09-21。書かないと年齢・性別の一般論で答えた）
 * - **区分の一覧は、読者の話をしている回にだけ**添える（作者の裁定、
 *   2026-09-21）。読者の話でない回にまで乗ると、助言の向きが揺れる
 *
 * 記録（`logStep`）は呼ぶ側が書く。何を足したかは `declared`・`glossary` で返す。
 */
export function workChatReaderBlocks(
  profile: ReaderProfile | undefined,
  question: string,
  /**
   * 作者がシートで選んだ狙いと理由（設計書6.108.6 の⑤）。あれば毎回
   * 2〜3行だけ足す。**読者像が無くても狙いがあれば「まだ決めていません」を
   * 送らない**——狙いは決めてあるので、その1行は嘘になる
   */
  aim?: ReaderAim
): {
  blocks: string[];
  declared: boolean;
  glossary: boolean;
  /** 狙いと理由を足したか */
  aim: boolean;
  /**
   * 問いの直前（ユーザープロンプト側）へ置く読者の要点。**読者の話をしている
   * 回で、読者が決まっているときだけ**（`buildReaderTypeReminder`）。
   * 絞り方は区分の一覧と同じ1つの条件——読者の話でない回の答えを動かさない。
   */
  reminder?: string;
} {
  const blocks: string[] = [];
  const readerBlock = buildReaderTypePrompt(profile);
  const hasAim = aim !== undefined && aim.types.length > 0;
  if (readerBlock) blocks.push(readerBlock);
  else if (!hasAim) blocks.push(buildReaderTypeUnknownPrompt());
  // 狙いは読者像の段のすぐ後ろ（読者の話の材料をひとまとまりに置く）
  if (hasAim) blocks.push(buildReaderAimPrompt(aim.types, clipReason(aim.reason)));
  const glossary = questionMentionsReader(question);
  if (glossary) blocks.push(buildReaderTypeGlossaryPrompt());
  const reminder = glossary ? buildReaderTypeReminder(profile) : undefined;
  return {
    blocks,
    declared: readerBlock !== undefined,
    glossary,
    aim: hasAim,
    ...(reminder ? { reminder } : {}),
  };
}

/**
 * 相談へ狙いを渡したことを、操作ログの1行にする（`readerTypeChatLogLines` と
 * 同じ理由——効いているかを確かめる手掛かり。文言は試験から見られる core に置く）。
 * **理由の中身は書かない**（作者の文。字数と有無だけ）。
 */
export function readerAimChatLogLine(aim: ReaderAim): string {
  const labels = aim.types.map((type) => READER_TYPES[type].label).join("、");
  const reason = aim.reason.trim();
  return `相談: 作者の狙い（${labels}）を添えた／理由 ${reason ? `${[...reason].length}字` : "なし"}`;
}

/**
 * 登場人物の名前の塊（作品の材料の1つ）。**端役を除いた名前**を渡すこと。
 *
 * 名前を知らないと、AIは人物を「主人公」としか呼べず話が噛み合わない。
 * 上限は60人——長い作品で本文が押し出されないように。名前が無ければ
 * 塊ごと出さない。
 */
export function characterNamesBlock(names: readonly string[]): string | undefined {
  if (names.length === 0) return undefined;
  return `${CHARACTER_NAMES_HEADING}${names.slice(0, 60).join("、")}`;
}

/** 素のシステムプロンプトへ、足す段を並べる（順は呼ぶ側が決めた順のまま） */
export function joinWorkChatSystemPrompt(
  base: string,
  blocks: readonly string[]
): string {
  return blocks.length === 0 ? base : `${base}\n\n${blocks.join("\n\n")}`;
}
