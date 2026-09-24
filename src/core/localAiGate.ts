/**
 * 手元のAIへ送る直前の「プロセスをまたいだ門」の差し込み口（設計書6.76.1）。
 *
 * 関所（`ai/meteredProvider.ts`）は `ai/` にあり、画面（進捗・警告）を出す
 * `features/` を引き込めない（依存の向き）。そこで門の形だけをここに置き、
 * 中身は拡張機能の起動時に `features/localAiGate.ts` が差し込む。
 *
 * **差し込まれていなければ何もしない**（単体テスト・ブラウザ版・MCP）。
 * 今までどおり送る。
 */

export interface LocalAiGateRequest {
  readonly providerId: string;
  readonly model: string;
  /** 記録の機能名（`meta.feature`）。無いこともある */
  readonly feature?: string;
  readonly signal?: AbortSignal;
}

export interface LocalAiGate {
  /**
   * 送ってよくなるまで待つ。戻り値は**送り終えたら必ず呼ぶ**抜け口。
   *
   * 中止・作者の「やめる」は `AiQueueAbortError` で投げる。
   * **それ以外の失敗は投げない**（札が壊れていても送る。理由はログへ）。
   */
  enter(request: LocalAiGateRequest): Promise<() => void>;
  /** 一括処理の札（6.76）を返したとき。持ち続けていた札を離す機会 */
  runEnded(): void;
}

let installed: LocalAiGate | undefined;

export function setLocalAiGate(gate: LocalAiGate | undefined): void {
  installed = gate;
}

export function localAiGate(): LocalAiGate | undefined {
  return installed;
}
