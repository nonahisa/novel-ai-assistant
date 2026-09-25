/**
 * 選ぶ画面の候補に出さないモデル（作者の裁定、2026-09-26 深夜）。
 *
 * **会話はできるが、この製品の仕事をこなせないと実測で分かったモデル**を、
 * AIの設定・機能別AI割当のモデル一覧から外す。一覧に出ていると、名前だけ
 * 見て選び、実行して初めて「何も指摘しない」「指示の言葉を返す」と分かる。
 *
 * ## 外すだけで、使えなくはしない
 *
 * **一覧から外すのは `listModels` だけである。** `getModel` と `generate` は
 * これまでどおり受け付けるので、
 * - 選ぶ画面の「一覧に無いモデルの名前を入れる」から名前を打てば使える
 *   （`registry.ts` の `pickProviderAndModel`）
 * - すでに割り当ててあるなら、そのまま動く（割当を勝手に外さない）
 *
 * 作者が「それでも使う」と決めたなら、それが勝つ——同梱の初期値の守り
 * 「作者の実測が常に勝つ」と同じ立場である。
 *
 * ## 同梱の初期値（`core/bundledTuning.ts`）と同じ作りにしたところ
 *
 * - 鍵は `providerId/model`（`modelTuningKey` と同じ形）
 * - **実際に測ったモデルだけを載せる。** 「同じ系統だから同じはず」は載せない
 *   （規則6の例外は「測らないと分からない値」だけ。推測は範囲の外）
 * - 測った日（`measuredAt`）と、何で測ったか（`bench`）を持つ。
 *   `preview/` の付くモデルは同じ名前で中身が入れ替わるので、次に測り直す
 *   ときの手がかりにする
 *
 * ## 同じ表に入れなかった理由
 *
 * あちらは**値の初期値**で、読むときに作者の台帳と欄ごとに混ぜる。こちらは
 * **一覧に出すかどうかの判断**で、混ぜる相手の台帳が無い。同じ表に置くと、
 * 「AIチューニングの測定値」の一覧（`allModelTuning`）に中身の無い「同梱」の
 * 行が並ぶ。また、同梱の表は作者の機械で測った数を運ぶものなので、
 * 「このモデルは仕事に向かない」という判定を混ぜると、表の約束（実測の数だけ）
 * が崩れる。
 *
 * ## 古くなったら
 *
 * 期限で自動的に戻すことはしない——判定の中身（19件中0件）は日付では
 * 古くならず、戻すかどうかは測り直した結果で決めるものだから。測り直して
 * 通ったら、ここから行を消す。
 *
 * VS Code API に依存しない。
 */

/** 候補から外す理由（実測の記録） */
export interface HiddenModel {
  /** 画面とログに出す、外した理由（1文） */
  readonly reason: string;
  /** 何で測ったか（比べの名前と、その数字） */
  readonly bench: string;
  /** 測った日（ISO 8601 の日付） */
  readonly measuredAt: string;
}

const HIDDEN: Readonly<Record<string, HiddenModel>> = {
  /*
    **誤字脱字検知の比べ（2026-09-25〜26）で、19件中0件。**

    教科書チートの先頭10話で、確実な誤り19件を1件も拾わなかった。
    llm-jp は読める長さ（4,096）を同梱して400を止めたあとも、指摘を延々と
    書き続けて出力の上限で切れ、**指示の言葉（「誤りを含む箇所（前後を
    含め30字以内）」）をそのまま返した**——接続ではなく、モデルの力の問題
    である（設計書6.22.1）。Qwen3-0.6B は6億パラメータの CPU 版で、
    同じ比べで何も拾わなかった。
  */
  "sakura/llm-jp-3.1-8x13b-instruct4": {
    reason: "誤字脱字の比べで確実な誤りを1件も拾わず、指示の言葉をそのまま返しました",
    bench: "誤字脱字検知の比べ（教科書チート先頭10話・確実な誤り19件）：当たり0件",
    measuredAt: "2026-09-26",
  },
  "sakura/preview/Qwen3-0.6B-cpu": {
    reason: "誤字脱字の比べで確実な誤りを1件も拾いませんでした",
    bench: "誤字脱字検知の比べ（教科書チート先頭10話・確実な誤り19件）：当たり0件",
    measuredAt: "2026-09-26",
  },
};

/** そのモデルを候補から外すなら、その理由。外さないなら undefined */
export function hiddenModel(
  providerId: string,
  model: string
): HiddenModel | undefined {
  return HIDDEN[`${providerId}/${model}`];
}

/** そのプロバイダで候補から外しているモデルの名前（選ぶ画面の案内に使う） */
export function hiddenModelsOf(providerId: string): string[] {
  const prefix = `${providerId}/`;
  return Object.keys(HIDDEN)
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
}

/**
 * 選ぶ画面で「一覧に無いモデルの名前を入れる」を選んだときの案内。
 * そのプロバイダで外しているモデルが無ければ undefined（項目ごと出さない）。
 *
 * **外したモデルの名前と理由を見せる。** 名前を覚えていない作者は打てないし、
 * 理由を見ずに打つと、外した意味が無くなる。
 */
export function manualModelEntryPrompt(providerId: string): string | undefined {
  const names = hiddenModelsOf(providerId);
  if (names.length === 0) return undefined;
  const lines = names.map((name) => {
    const entry = hiddenModel(providerId, name);
    return `${name}（${entry?.reason ?? ""}。${entry?.measuredAt ?? ""}）`;
  });
  return `候補から外しているモデル：${lines.join("、")}`;
}

/** 表そのものの鍵（テストが使う） */
export function hiddenModelKeys(): string[] {
  return Object.keys(HIDDEN);
}
