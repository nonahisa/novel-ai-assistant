/**
 * **手元のPCで動くAI**（Ollama・LM Studio）のプロバイダID。**唯一の定義**。
 *
 * ## なぜ `core` に置くか
 *
 * 「手元かクラウドか」で振る舞いを分ける所が、あちこちにある——
 * 通信の口（`ai/fetchTimeouts.ts` の `localFetch`／`cloudFetch`）、
 * ブラウザ版で選ばせない（`ai/registry.ts`）、メモリを取り合う相手
 * （`ai/otherLocalAi.ts`）、そして**待ち時間の上限**（`core/modelTuning.ts`。
 * 作者の裁定、2026-09-23）。
 *
 * 待ち時間の台帳は `core` にあり、`ai/` を引き込めない（`ai/otherLocalAi.ts`
 * は `features/` まで引き込む）。そこで一覧をここへ置き、ほかはこれを読む。
 * **写しを作らない**——片方にだけ新しいAIを足すと、「通信は手元の口で
 * 投げるのに、待ち時間はクラウドの上限で切る」という食い違いが静かに生まれる。
 *
 * どのファイルがどちらの口で投げているかは `test/unit/core/fetchDispatcherNet.test.ts`
 * が見張っており、**そこの手元・クラウドの分けとこの一覧が一致すること**も
 * 同じテストが確かめる。
 *
 * `vscode` を引き込まない（MCP の束からも読めるように。`mcpReach.test.ts`）。
 */
export const LOCAL_PROVIDER_IDS: readonly string[] = ["ollama", "lmstudio"];

/** 手元のPCで動くAIか。**知らないIDはクラウド扱い**（上限の緩いほうへ倒さない） */
export function isLocalProviderId(providerId: string): boolean {
  return LOCAL_PROVIDER_IDS.includes(providerId);
}
