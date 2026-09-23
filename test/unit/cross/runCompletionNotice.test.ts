import * as fs from "fs";
import * as path from "path";
import { describe, expect, test } from "vitest";

/**
 * 一部が失敗したときに「完了しました」と言わない（設計書6.47）。
 *
 * 実データで、誤字脱字検知が3件中2件タイムアウトした回に
 * 「完了しました。指摘 0件 / 失敗 2チャンク」と出ていた
 * （作者のログ、2026-08-29）。作者からは「誤字が無かった」と読めるが、
 * 実際には**本文の3分の2を見ていない**。
 *
 * 通知の組み立ては vscode に依存するので、**ソースの形で固定する**
 * （`generateCancellation` と同じ方式）。
 */

const EXTENSION = path.join(__dirname, "..", "..", "src", "extension.ts");

function source(): string {
  return fs.readFileSync(EXTENSION, "utf8");
}

/**
 * `notifyRunCompletion` の本体を、**次の関数定義までを丸ごと**取り出す。
 *
 * **固定長の窓（`slice(start, start + 2000)`）にしない。** かつてそう
 * 書いており、本体に数行足しただけで窓の外へはみ出した末尾の検査
 * （「成功時だけ完了しましたと言う」）が、**無関係な追記で落ちる**状態に
 * なっていた。落ちても原因が「文字数」なので、直し方が誰にも分からない。
 */
function notifyRunCompletionBody(): string {
  const code = source();
  const start = code.indexOf("function notifyRunCompletion");
  const next = code.indexOf(
    "\nfunction ",
    start + "function notifyRunCompletion".length
  );
  return code.slice(start, next > 0 ? next : code.length);
}

describe("一部が失敗したら「完了」と言わない", () => {
  /**
   * 直接 `showInformationMessage` へ「〜が完了しました」を渡している箇所。
   *
   * 共通の入口（`notifyRunCompletion`）の中身は数えない——そこが唯一
   * 「完了しました」と言ってよい場所である。
   */
  function directCompletionNotices(): string[] {
    const code = source();
    const start = code.indexOf("function notifyRunCompletion");
    // **次の関数定義までを丸ごと除く。** `\n}` で切ると、関数の途中の
    // 閉じ括弧に当たって本体の一部が残る（最初の版で実際にそうなった）
    const next = code.indexOf("\nfunction ", start + "function notifyRunCompletion".length);
    const outside = code.slice(0, start) + code.slice(next > 0 ? next : code.length);
    return [...outside.matchAll(/showInformationMessage\(\s*`([^`]*が完了しました[^`]*)`/g)]
      .map((match) => match[1].slice(0, 30))
      // AIを使わない機能はチャンクを回さないので、失敗の概念が無い
      .filter((text) => !text.startsWith("表記ゆれ検知"));
  }

  test("チャンクを回す機能の完了通知は、共通の入口を通る", () => {
    // 落ちたら：その通知を `notifyRunCompletion` へ寄せる。
    // 一部が失敗しても「完了しました」と言ってしまう形になっている
    expect(directCompletionNotices()).toEqual([]);
  });

  test("共通の入口は、失敗があれば警告にして「見ていない」と伝える", () => {
    expect(source().indexOf("function notifyRunCompletion")).toBeGreaterThan(0);
    const body = notifyRunCompletionBody();

    // 失敗時は警告、かつ「完了」と言わない
    expect(body).toContain("showWarningMessage");
    expect(body).toMatch(/一部を処理できませんでした/);
    // **数だけで済ませない。** 見ていない部分があることを言葉で伝える
    expect(body).toMatch(/失敗した部分は見ていない/);
    // 成功時だけ「完了しました」
    expect(body).toMatch(/が完了しました/);
  });

  /**
   * 時間切れのときは、直し方まで出す（作者の要望、2026-08-30
   * 「タイムアウトが起きているときも、その旨を明示して検査を促せば良い」）。
   *
   * **何秒あれば足りるかは測れば分かる**（設計書6.49）。作者に秒数を
   * 当てさせず、「AIチューニング」へ1押しで行けるようにする。
   * チューニングはAIを呼ぶので、**料金の断りを落とさない**。
   */
  test("時間切れが混じっていたら、チューニングへの導線を出す", () => {
    const body = notifyRunCompletionBody();

    // 押せるボタンにする（文章だけだと、どこから実行するのか分からない）
    expect(body).toContain("AIチューニングを実行");
    expect(body).toContain('"novelai.measureContext"');
    // 時間切れでないときにまで出さない（毎回出ると誰も読まなくなる）
    expect(body).toMatch(/timedOut/);
  });

  /**
   * **測るのは「時間切れになった機能が使うAI」でなければならない**
   * （設計書6.28.9の機能別割当）。
   *
   * 誤字脱字だけ「さくら / gpt-oss-120b」を割り当て、既定は「Ollama」
   * という作者がいる。機能キーを渡さないと既定のOllamaを測ってしまい、
   * **さくらの待ち時間は1秒も変わらない**。作者には「測ったのに直らない」
   * としか見えず、料金の断りも食い違う（無料のOllamaで判定して
   * 有料AIを呼ぶ経路ができる）。
   */
  test("チューニングには、その機能のキーを渡す", () => {
    const body = notifyRunCompletionBody();

    // 呼び出しに機能キーを載せる（引数なしだと既定のAIを測ってしまう）
    expect(body).toMatch(
      /executeCommand\(\s*"novelai\.measureContext",\s*options\.tuningFeature/
    );

    // 誤字脱字の通知は "typo" を渡している（`AssignableFeature` のキー）
    expect(source()).toMatch(/tuningFeature: "typo"/);
  });

  /**
   * 料金の断りは、**分かっているなら言い切る**（作者の要望、2026-08-30
   * 「有料であればそれも明示して」）。
   *
   * 有料と無料で言い分け、**どちらか分からないときだけ中立にする**。
   * 「無料です」と間違って言うことだけは、どの経路でも起きてはならない。
   */
  test("チューニングの料金を、有料・無料・不明で言い分ける", () => {
    const body = notifyRunCompletionBody();

    expect(body).toMatch(/AIを呼ぶので料金がかかります/);
    expect(body).toMatch(/AIを呼びますが、このAIは無料です/);
    expect(body).toMatch(/有料のAIでは料金がかかります/);
    // 「無料です」と言ってよいのは isPaid === false のときだけ。
    // 既定値や `??` で false へ倒すと、有料AIに「無料です」と出る
    expect(body).toContain("options.isPaid === false");
    expect(body).not.toMatch(/isPaid\s*(\?\?|\|\|)/);
  });

  test("誤字脱字の通知は、時間切れの件数と有料かどうかを渡している", () => {
    // **空振りさせない。** `notifyRunCompletion` に口だけ用意して
    // 誰も渡していないと、案内は永久に出ない
    const code = source();
    expect(code).toMatch(/timedOut: result\.timedOutChunks > 0/);
    expect(code).toMatch(/isPaid: result\.usedPaidProvider/);
  });

  test("失敗の件数を渡している呼び出しが複数ある（空振りしていない）", () => {
    const calls = [...source().matchAll(/notifyRunCompletion\(\{/g)];
    // 誤字脱字・伏線検知・伏線回収・逸脱・推敲・矛盾
    expect(calls.length).toBeGreaterThanOrEqual(6);
  });
});
