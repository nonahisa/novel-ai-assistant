import {
  chatReaderBasis,
  READER_TYPES,
  readerTypeCacheMark,
  resolveReaderType,
  type ReaderChatSource,
  type ReaderTypeId,
} from "./readerTarget";
import { READER_TYPE_IDS } from "./readerTypeNeighbors";
import {
  extractAuthorBlock,
  readAimReason,
  readAimTypes,
} from "./targetSheetDoc";
import { sha1Text } from "./hash";
import type { ReaderProfile } from "../models/readerProfile";
import { TARGET_READER_ENTRY_TITLE } from "../prompts/readerTarget";

/**
 * 読者に見せる文章（作品紹介文・キャッチコピー・更新告知文）へ添える
 * 「狙いの読者」（設計書6.6.5・6.41.2）。
 *
 * 作者の問い（2026-09-23）「キャッチコピーや作品紹介文は、読者層を
 * 反映させているでしょうか？」「告知文もですね」——それまで読者像を
 * 見ていたのはサブタイトルの案（P-07 2.1）だけだった。
 *
 * ## 材料の優先順位
 *
 * 1. **ターゲット読者の「狙い」**（シートの作者の欄。11層から2つまで＋理由）
 *    ——作者が「この読者に読んでもらいたい」と選んだもの。紹介文は
 *    まさにその読者へ向けて書くものなので、いちばん先に見る
 * 2. **読者像**（`設定/読者像.json`。書き方の判断 → 本文の実像の順）
 *    ——サブタイトルと同じ出どころ・同じ部品（`chatReaderBasis`）
 * 3. **どちらも無ければ添えない。** 「読者層に合わせて」とだけ言うと、
 *    AIが宛先を勝手に決める（一般論のままのほうが害が小さい。P-07 と同じ）
 *
 * **読むのはここ、組むのは `prompts/publicityReader.ts`、検査は
 * `findReaderTypeLabels`。** VS Code API に依存しない（MCP の束からも使う）。
 */

export type PublicityReader =
  | {
      readonly source: "aim";
      /** 作者が選んだ層（1〜2つ。選んだ順） */
      readonly types: readonly ReaderTypeId[];
      /** 作者の理由（1行。空文字もある）。**作者の文なのでそのまま渡す** */
      readonly reason: string;
    }
  | {
      readonly source: ReaderChatSource;
      readonly types: readonly [ReaderTypeId];
      /** プロンプトはサブタイトルと同じ `buildReaderTypePrompt` で組むので、台帳ごと持つ */
      readonly profile: ReaderProfile;
    };

/**
 * 材料から、添える読者を決める。**無ければ `undefined`**。
 *
 * 狙いの欄に読めない名前しか無ければ（「狙い：なんとなく広く」）、
 * 狙い無しとして読者像へ進む——推測で型を当てない（`readAimTypes` の約束）。
 */
export function resolvePublicityReader(input: {
  /** シートの作者の欄。紙が無い・作者が自分で置いた同名の紙なら渡さない */
  readonly authorBlock?: string;
  readonly profile?: ReaderProfile;
}): PublicityReader | undefined {
  if (input.authorBlock !== undefined) {
    const types = readAimTypes(input.authorBlock);
    if (types.length > 0) {
      return {
        source: "aim",
        types,
        reason: readAimReason(input.authorBlock),
      };
    }
  }
  const basis = chatReaderBasis(input.profile);
  if (!basis || !input.profile) return undefined;
  return {
    source: basis.source,
    types: [resolveReaderType(basis.scores)],
    profile: input.profile,
  };
}

/**
 * シートの文面から決める（MCP の道。製品は `readTargetSheetState` を通す）。
 *
 * **作者の欄の印が無い紙からは狙いを読まない**——製品が「作者が自分で
 * 置いた同名のファイル」として扱わない紙なので、ここでも読まない
 * （製品と測る側で材料を違えない）。
 */
export function publicityReaderFromSheet(
  sheetText: string | undefined,
  profile: ReaderProfile | undefined
): PublicityReader | undefined {
  const authorBlock =
    sheetText === undefined ? undefined : extractAuthorBlock(sheetText);
  return resolvePublicityReader({ authorBlock, profile });
}

/**
 * キャッシュの鍵（版の文字列）へ混ぜる印（CLAUDE.md 規則4）。
 *
 * - 無し：`none`（空文字にしない。`readerTypeCacheMark` と同じ理由）
 * - 読者像：`readerTypeCacheMark` そのもの（サブタイトルと同じ印。写しを作らない）
 * - 狙い：`aim:` ＋層（`+` でつなぐ）＋理由の短いハッシュ。**理由も混ぜる**
 *   ——作者の文がそのままプロンプトへ入るので、理由を書き換えれば文面が変わる
 *
 * **`|` を含めない。** 版の文字列は `1.2|reader:…` の形で、区切りが潰れる。
 */
export function publicityReaderMark(
  reader: PublicityReader | undefined
): string {
  if (!reader) return "none";
  if (reader.source !== "aim") return readerTypeCacheMark(reader.profile);
  const types = reader.types.join("+");
  const reason = reader.reason.trim();
  return reason ? `aim:${types}:${sha1Text(reason).slice(0, 8)}` : `aim:${types}`;
}

/** 層の呼び名（画面とログ用）。「考察層・没入層」 */
export function publicityReaderLabels(reader: PublicityReader): string {
  return reader.types.map((type) => READER_TYPES[type].label).join("・");
}

/** 読者像の出どころの言い方（作者向け） */
const PROFILE_SOURCE_PHRASES: Record<ReaderChatSource, string> = {
  declared: "書き方の判断から",
  actual: "本文の実像から",
};

/**
 * 生成の画面・完了の知らせに添える1行。
 *
 * **何に向けて書いたかを言う。** 言わないと、作者は狙いを変えたあと
 * 作り直すべきかが分からない。無いときは、決めれば向けられることを
 * 案内する（入口の名前は `TARGET_READER_ENTRY_TITLE`。写しを作らない）。
 */
export function publicityReaderNotice(
  reader: PublicityReader | undefined
): string {
  if (!reader) {
    return `「${TARGET_READER_ENTRY_TITLE}」で狙いの読者を決めると、その層に向けて書けます。`;
  }
  const labels = publicityReaderLabels(reader);
  if (reader.source === "aim") {
    return `狙いの読者（${labels}）に向けて書きました。`;
  }
  return (
    `読者像（${labels}。${PROFILE_SOURCE_PHRASES[reader.source]}）に向けて書きました。` +
    `「${TARGET_READER_ENTRY_TITLE}」で狙いを選ぶと、そちらを優先します。`
  );
}

/**
 * 読者に見せる文章に、層の呼び名が出ていないかを見る。
 *
 * **プロンプトへ「考察層」と書いて渡すので、そのまま答えに返ってくる
 * 前提で見る**（CLAUDE.md の失敗3）。「考察層のあなたへ」と書かれた紹介文を
 * 作者が投稿サイトへ貼ると、読者には意味の分からない言葉になる。
 *
 * **渡した層だけでなく11層すべてを見る。** どれも読者に見せる言葉ではない。
 * 見つけた順ではなく、層の並び順で返す（検査の結果を安定させる）。
 */
export function findReaderTypeLabels(text: string): string[] {
  return READER_TYPE_IDS.map((id) => READER_TYPES[id].label).filter((label) =>
    text.includes(label)
  );
}

/** 層の呼び名が出ていたときの言い方（紹介文・告知文で共用。写しを作らない） */
export function readerLeakNote(labels: readonly string[]): string {
  return (
    `読者層の呼び名「${labels.join("」「")}」がそのまま入っています。` +
    "読者には通じない言葉なので、貼る前に言い換えてください。"
  );
}
