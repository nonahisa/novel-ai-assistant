/**
 * その場の時刻での日付（`YYYY-MM-DD`）。
 *
 * **`toISOString().slice(0, 10)` を使わない。** あれは UTC の日付なので、
 * 日本では**朝9時より前に押した操作が前日の日付になる**（実機で発覚、
 * 2026-09-11。「今後直さない」に足した語が 09-11 の朝に 09-10 と記録された）。
 * 作者が見る日付は、作者の時計の日付でなければ意味が通らない。
 *
 * `logger.ts` の `formatLogTime` と同じ組み立て方（`getFullYear` 系）にしてある。
 * `writingStats.ts` の `statsDayKey` は**別物**なので写さない——あちらは
 * 「1日の境をいつにするか」（深夜に書いた分を前日に数える）という設定を持つ。
 * こちらは境の無い、素直な暦の日付である。
 */
export function localDateKey(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
