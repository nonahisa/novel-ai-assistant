/**
 * Ollamaの応答を**流しながら**受け取る（設計書6.63.1）。
 *
 * **これは開発ビルドでだけ動く実験である。** 配布物には
 * `__DEV_HELPERS__` が false に畳まれて枝ごと落ちる（`esbuild.js`）。
 * 作者がF5で確かめるためのもので、利用者へ出すのは
 * 「通信部品の待ち時間を明示する」ほう（`fetchTimeouts.ts`）である。
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
 * 走らせたまま切り替えた分。**どこにも保存しない**（下の理由書きを参照）。
 *
 * `undefined` は「切り替えていない」——そのときは環境変数を見る。
 */
let overrideEnabled: boolean | undefined;

/**
 * この実験を使うか（開発ビルドでだけ意味がある）。
 *
 * **既定は「使わない」。** 入口は2つある。
 *
 * 1. 環境変数 `NOVELAI_OLLAMA_STREAM=1`。F5の起動設定
 *    （`.vscode/launch.json` の `env`）に足して使う
 * 2. 詳細メニューの「テスト中」→ 拡張機能の設定 → AI から切り替える
 *    （`src/dev/streamToggle.ts`。作者の依頼、2026-09-03）
 *
 * **1を残してあるのは、起動時から流したい人のため**である。2で切り替えれば
 * 起動し直さずに試せるが、launch.json に書いておけば毎回そこから始まる。
 *
 * **切り替えは、このウィンドウを閉じるまでの間だけ**にする（保存しない）。
 * 実験の旗を設定へ永続させると、**実験したことを忘れた頃に、本番の道とは
 * 違う挙動で悩む**ことになる。開発ホストを開き直せば必ず既定へ戻る、が
 * 実験の後始末として確実である。
 *
 * **設定（`novelai.*`）にはしない。** 配布物では枝ごと落ちるので、
 * 設定画面に「何もしない項目」が並ぶことになる。
 *
 * **既定を「使う」にしない理由**：単体テストは開発ビルドとして走るので、
 * 既定で有効にすると**テストが実験の側だけを通る**。実際に2件が
 * 通らなくなった（2026-09-02）——配布する道が検査されない状態は危うい。
 */
export function streamingEnabled(): boolean {
  return overrideEnabled ?? process.env.NOVELAI_OLLAMA_STREAM === "1";
}

/**
 * 走らせたまま入切する。
 *
 * `undefined` を渡すと切り替えを取り消し、環境変数の判断へ戻る
 * （試験は後始末でこれを呼ぶ。残ると、あとに走る試験が実験の側だけを通る）。
 */
export function setStreamingOverride(value: boolean | undefined): void {
  overrideEnabled = value;
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
