import * as fs from "fs";
import * as path from "path";
import { describe, expect, test } from "vitest";

/**
 * AIの呼び出しに中止を届けているか（設計書6.43）。
 *
 * **中止ボタンは出るのに効かない、が起きる。** `withCancellableProgress` は
 * ステータスバーに「中止」を出すが、コールバックが `token` を受け取って
 * `AbortSignal` に繋がないと、押しても呼び出しは止まらない。**有料AIでは
 * その間ずっと課金される。** 実際に紹介文・キャッチコピー・各話あらすじ・
 * 更新告知文の4か所が繋がっていなかった（0.28.3で修正）。
 *
 * 呼び出しごとの配線は型では守れないので、**ソースの形で固定する**
 * （`sourceHygiene` や `plainTextUi` と同じ方式）。新しくAIを呼ぶ処理を
 * 足した人が忘れたら、ここが落ちる。
 */

const FEATURES_DIR = path.join(__dirname, "..", "..", "src", "features");

/**
 * `signal` を渡していなくてよい呼び出し。**増やすときは理由を書く。**
 *
 * どちらも「中止ボタンがそもそも出ない場所」である。ボタンを出すなら
 * 同時に `signal` を繋ぐこと——出ているのに効かないのがいちばん悪い。
 */
const ALLOWED_WITHOUT_SIGNAL = new Map<string, string>([
  [
    "settingsPanel.ts",
    "相談1回に付随する検索語づくり。短く、独立した中止の対象にしていない",
  ],
  [
    "workChatPanel.ts",
    "相談パネルは進捗と中止をパネル内で持っており、withCancellableProgress を通らない",
  ],
]);

interface Call {
  file: string;
  line: number;
  hasSignal: boolean;
}

/** `.generate({ … })` の呼び出しを、括弧の対応で切り出す */
function findGenerateCalls(file: string, source: string): Call[] {
  const calls: Call[] = [];
  const needle = ".generate({";
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at === -1) break;

    const open = source.indexOf("{", at);
    let depth = 0;
    let end = open;
    for (let i = open; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }

    calls.push({
      file,
      line: source.slice(0, at).split("\n").length,
      hasSignal: /\bsignal\s*:/.test(source.slice(open, end)),
    });
    from = end;
  }
  return calls;
}

function allCalls(): Call[] {
  return fs
    .readdirSync(FEATURES_DIR)
    .filter((name) => name.endsWith(".ts"))
    .flatMap((name) =>
      findGenerateCalls(name, fs.readFileSync(path.join(FEATURES_DIR, name), "utf8"))
    );
}

describe("AIの呼び出しに中止を届ける", () => {
  test("許可した場所のほかは、すべて signal を渡している", () => {
    const missing = allCalls()
      .filter((call) => !call.hasSignal)
      .filter((call) => !ALLOWED_WITHOUT_SIGNAL.has(call.file))
      .map((call) => `${call.file}:${call.line}`);

    // 落ちたら：その generate に `signal: controller.signal` を渡し、
    // 包んでいる withCancellableProgress のコールバックで
    // `token.onCancellationRequested(() => controller.abort())` を繋ぐ
    expect(missing).toEqual([]);
  });

  test("中止を届けている呼び出しが実際に多数ある（検査が空振りしていない）", () => {
    // 切り出しが壊れて0件になっても上のテストは通ってしまう
    const wired = allCalls().filter((call) => call.hasSignal);
    expect(wired.length).toBeGreaterThan(10);
  });

  test("許可リストは、実際に signal 無しの呼び出しを持つファイルだけを挙げる", () => {
    // 直したのに許可リストへ残り続けると、次の抜けを隠してしまう
    const filesWithout = new Set(
      allCalls().filter((call) => !call.hasSignal).map((call) => call.file)
    );
    for (const allowed of ALLOWED_WITHOUT_SIGNAL.keys()) {
      expect(filesWithout).toContain(allowed);
    }
  });
});
