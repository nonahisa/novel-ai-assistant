/**
 * Ollamaの応答を**流しながら**受け取る（設計書6.63.1）。
 *
 * **0.42.0 から配布版でも使う**（作者の指示「思考の流れをリリースに組み込んで」）。
 * 0.41.0 までは開発ビルド限定の実験で、配布物には枝ごと入れていなかった。
 * 実機で「考えています…」に思考が流れることを確かめたうえで、設定
 * `novelai.ollama.streaming`（既定は入）で切れる形にして出す。
 * 切ると、生成が終わってからまとめて受け取る道（`fetchTimeouts.ts`）に戻る。
 *
 * ## なぜ流すのか
 *
 * まとめて1回で返す形（`stream: false`）だと、**応答ヘッダーは生成が
 * 全部終わってから届く**。Nodeの通信部品は「ヘッダーを待つ上限」を
 * 既定300秒で持っているので、生成が300秒を超えると切られる
 * （作者のログ、2026-09-01。302秒で `UND_ERR_HEADERS_TIMEOUT`）。
 *
 * 流す形なら**ヘッダーは即座に届く**ので、その上限に当たらない。
 * 待ち時間の話が根本から消える——本来こうあるべき形である。
 *
 * ## 受け取り方
 *
 * Ollamaは1行1件のJSON（NDJSON）を流してくる。
 *
 * ```
 * {"message":{"content":"あ"},"done":false}
 * {"message":{"content":"い"},"done":false}
 * {"done":true,"eval_count":123,"prompt_eval_count":456}
 * ```
 *
 * **行の途中で切れて届く**ので、改行までを溜めてから解く。ここを
 * 手を抜くと、日本語が半分に割れた行でJSONの解析に失敗する。
 */

/**
 * 設定 `novelai.ollama.streaming` を読む口（0.42.0）。
 *
 * **このファイルは VS Code に依存しない**（純粋な部品として試験する）ので、
 * 設定の読み方は `extension.ts` が起動時に差し込む。差し込まれていなければ
 * （単体テスト・環境変数だけの起動）、これまでどおり環境変数を見る。
 */
let settingReader: (() => boolean | undefined) | undefined;

export function setStreamingSettingReader(
  reader: (() => boolean | undefined) | undefined
): void {
  settingReader = reader;
}

/** 環境変数の旗。**ブラウザ版には `process` が無い**ので、無ければ切 */
function streamingFromEnvironment(): boolean {
  return (
    typeof process !== "undefined" &&
    process.env?.NOVELAI_OLLAMA_STREAM === "1"
  );
}

/**
 * 流して受け取るか。優先順は「設定 → 環境変数」。
 *
 * 設定の既定は入（`package.json`）。単体テストでは設定の読み口が無いので
 * 既定は切のまま——**配布する2つの道（流す・まとめて）の両方が検査される**。
 *
 * 0.45.0 まではもう一段、走らせたまま切り替える上書き（開発ビルド限定の
 * ボタン）が最優先で載っていた。設定が配布版に入って役目を終えたので外した。
 */
export function streamingEnabled(): boolean {
  return settingReader?.() ?? streamingFromEnvironment();
}

/** 流れてきた応答をまとめたもの。`stream:false` の応答と同じ形に揃える */
export interface StreamedChat {
  content: string;
  /** 思考する機種が別の欄で流してくる分。**本文には混ぜない** */
  thinking?: string;
  /** 最後の1件に入っている統計。取れなければ undefined */
  promptEvalCount?: number;
  evalCount?: number;
  /** 出力の上限で打ち切られたか */
  truncated: boolean;
  /** Ollamaが返したエラー文（あれば） */
  error?: string;
}

interface StreamLine {
  message?: { content?: unknown };
  done?: unknown;
  done_reason?: unknown;
  error?: unknown;
  eval_count?: unknown;
  prompt_eval_count?: unknown;
}

/**
 * 1行ぶんのJSONを取り込む。**解けない行は捨てる**（最後の空行など）。
 *
 * @returns 累積した結果（呼ぶ側が持ち回る）
 */
export function applyStreamLine(
  into: StreamedChat,
  line: string
): StreamedChat {
  const trimmed = line.trim();
  if (!trimmed) return into;
  let parsed: StreamLine;
  try {
    parsed = JSON.parse(trimmed) as StreamLine;
  } catch {
    return into;
  }
  const chunk = parsed.message?.content;
  if (typeof chunk === "string") into.content += chunk;
  /*
    **思考は本文と混ぜない**（設計書6.63.1）。

    Ollamaは思考する機種で `thinking` を**別の欄**に流してくる。
    `content` へ足し込むと、抽出のJSONの前に思考文が付いて
    **解析に失敗する**（そのチャンクが丸ごと無駄になる）。

    まとめて受け取る道も同じ扱いなので、**呼ぶ側から見た形は変わらない**。
    抽出などは `think: false` を送るのでそもそも流れてこないが、
    守らない機種がありうる前提で分けておく（CLAUDE.md 規則3）。
  */
  const thought = (parsed.message as { thinking?: unknown } | undefined)
    ?.thinking;
  if (typeof thought === "string") into.thinking = (into.thinking ?? "") + thought;
  if (typeof parsed.error === "string") into.error = parsed.error;
  if (typeof parsed.eval_count === "number") into.evalCount = parsed.eval_count;
  if (typeof parsed.prompt_eval_count === "number") {
    into.promptEvalCount = parsed.prompt_eval_count;
  }
  // **`length` は出力上限で切られた印**（`stream:false` の `done_reason` と同じ）
  if (parsed.done_reason === "length") into.truncated = true;
  return into;
}

/** 溜めた文字列から、完成している行だけを取り出す */
export function takeCompleteLines(buffer: string): {
  lines: string[];
  rest: string;
} {
  const parts = buffer.split("\n");
  // 最後の断片は、まだ改行が来ていない＝途中である
  const rest = parts.pop() ?? "";
  return { lines: parts, rest };
}

export function emptyStreamedChat(): StreamedChat {
  return { content: "", truncated: false };
}
