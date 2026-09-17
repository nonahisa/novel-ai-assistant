/**
 * AI用の指示書を「どう使うか」（設計書6.87.14 の末尾、作者の指示 2026-09-18）。
 *
 * **作者の問い**：「VSCode の Claude Code を利用して統合小説執筆環境と
 * 連動する場合、エクスプローラーに作品が出ていたほうが良いでしょうか？」
 *
 * ここには2つの使い方があり、**門番（6.87.14）の効き方が変わる。**
 *
 * | 使い方 | 何が起きるか |
 * |---|---|
 * | 作品フォルダーを開いて使う | 指示書が自動で効く。ただし相手はワークスペースのファイルを**直接読める**ので、門番は助言になる |
 * | 作品を開かずに使う | 相手は道具（MCP）を通すしかないので、**許可も記録も本当に効く** |
 *
 * **どちらが正しいかは決めない**——作者が選ぶ（2026-09-18 の指示
 * 「選べるようにしてください」）。こちらの仕事は、**選んだ結果どうなるかを
 * 黙らないこと**である。開いて使う作品では、外部AIが直接読んだぶんが
 * 記録（`external.jsonl`）に残らない。記録だけを見た作者は
 * 「AIはこれだけしか見ていない」と読む——それがいちばん困る。
 *
 * VS Code API に依存しない（読み書きは `aiInstructionUsageStore.ts`）。
 */

/** 使い方。`open-work`＝作品フォルダーを開く／`keep-closed`＝開かない */
export type AiInstructionUsage = "open-work" | "keep-closed";

/**
 * 覚えておく場所。`.aiwriter/` の直下で、**同期しない**
 * （`workRegistry.ts` の `IGNORED_PATHS`）。
 *
 * 許可の印（`external-access.json`）と同じ考え——**その機械でどう使うか**
 * の話なので、リポジトリを共有した編集部の機械へ持ち越さない。
 */
export const AI_INSTRUCTION_USAGE_FILE = "ai-instruction-usage.json";

/** 覚えておく中身。**どちらを選んだかと、いつかだけ。** */
export interface AiInstructionUsageRecord {
  readonly usage: AiInstructionUsage;
  /** 選んだ時刻（ISO 8601） */
  readonly decidedAt: string;
}

/**
 * 読み取り。**読めない印は「選んでいない」に倒す**（`undefined`）。
 *
 * ここで勝手にどちらかへ倒すと、画面の断り書きが実態と食い違う。
 */
export function parseAiInstructionUsage(
  text: string
): AiInstructionUsageRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const usage = record.usage;
  if (usage !== "open-work" && usage !== "keep-closed") return undefined;
  return {
    usage,
    decidedAt: typeof record.decidedAt === "string" ? record.decidedAt : "",
  };
}

export function formatAiInstructionUsage(
  record: AiInstructionUsageRecord
): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/*
  **指示書の頭に足す数行は、`aiInstructions.ts` にある**
  （`buildWorkLocationPreamble`／`applyUsageToInstructionBody`）。

  あちらは Markdown を組み立てるファイルで、こちらは**画面に出す文字列**を
  持つファイルである。同じ場所に置くと、`plainTextUi.test.ts` の見張りを
  ファイルごと外すことになり、下の断りの文へ記号が混ざっても気づけない。
*/

/**
 * 編集履歴の画面（6.87.9）に出す断り。**この1行がこの作業の主目的である。**
 *
 * 記録に残るのは MCP を通った分だけで、作品フォルダーを開いた相手が
 * 直接読んだ分は残らない。**止める手立ては無い**（ワークスペースのファイルは
 * 読めて当たり前である）ので、**止められない約束をせず、そう断る。**
 */
export const DIRECT_READ_CAVEAT =
  "この作品は Claude Code などで直接開く設定です。開いた側が直接読んだぶんは、ここに残りません。";

/** 「開かずに使う」を選んだ作品に出す一行（黙っているのは不可） */
export const VIA_TOOLS_ONLY_NOTE =
  "この作品は、外部AIに開かせずに使う設定です。外部AIが読んだぶんは、すべてここに残ります。";

/**
 * 画面に出す一行と、目立たせるかどうか。
 *
 * **選んでいない作品では何も言わない**——どちらでもない状態を
 * 「開いていません」と言い切ると、開いている作品で嘘になる。
 */
export function describeAiInstructionUsage(
  record: AiInstructionUsageRecord | undefined
): { text: string; warn: boolean } | undefined {
  if (!record) return undefined;
  return record.usage === "open-work"
    ? { text: DIRECT_READ_CAVEAT, warn: true }
    : { text: VIA_TOOLS_ONLY_NOTE, warn: false };
}
