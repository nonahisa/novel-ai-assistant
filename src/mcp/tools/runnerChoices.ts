import { samplingSupport } from "./samplingHost";

/**
 * runner を選び直してもらう断り文句（設計書6.87.8 の5、6.87.15 の柱2の3）。
 *
 * **ここが唯一の定義。** ハンドラの断り（`run.ts` の `assertRunner`）と、
 * 入力の形の断り（`shared.ts` の `RUNNER_INPUT`）が同じ文を出す——runner を
 * 省いた呼び出しは、ハンドラへ届く前に入力の形で断られるので、片方だけ
 * 直しても AI には届かない。
 *
 * **いま使える選択肢だけを並べる。** sampling に対応していない相手
 * （LM Studio など）に sampling を見せると、AI はそれを選んでまた断られる。
 * **対応しているかが分からないときは3つとも並べ、分からないと書く**——
 * 分からないことを「対応していない」に畳むと、使える道を消すことになる。
 *
 * 文は呼ばれるたびに組む（接続の宣言は、サーバーが起きたあとで届く）。
 */
const CHOICE_OLLAMA = "ollama＝手元のOllamaで検算まで通す（原稿は外へ出ない）";
const CHOICE_CLAUDE = "claude＝プロンプトだけ返す（読んだ応答を validate へ戻す）";
const CHOICE_SAMPLING = "sampling＝呼び出し元に考えてもらい、検算まで通す";

export function runnerRefusal(): string {
  const head = "runner を指定してください（既定はありません）。";
  switch (samplingSupport()) {
    case "yes":
      return `${head}${CHOICE_OLLAMA}／${CHOICE_CLAUDE}／${CHOICE_SAMPLING}。`;
    case "no":
      /*
        **使えない道の名前は出さない。** 「〜は使えません」と書いても、
        名前が見えると選ぶ AI がいる。なぜ2つなのかは、名前を使わずに言う
      */
      return (
        `${head}${CHOICE_OLLAMA}／${CHOICE_CLAUDE}。` +
        "この呼び出し元は、サーバーから考えを頼む仕組みに対応していないので、選べるのはこの2つです。"
      );
    case "unknown":
      return (
        `${head}${CHOICE_OLLAMA}／${CHOICE_CLAUDE}／${CHOICE_SAMPLING}。` +
        "この呼び出し元が sampling に対応しているかは、まだ分かりません（対応していなければ sampling は断られます）。"
      );
  }
}
