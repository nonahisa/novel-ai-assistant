// JSON のオブジェクトだけを通す判定。配列は「オブジェクトではない」として外す
// （AI の応答や設定ファイルの JSON を読むとき、配列を辞書として扱わないため）。
// 配列も通す別の形（typeof と null 検査だけ）は、振る舞いが違うため各ファイルにそのまま残してある。
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
