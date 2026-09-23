import { afterEach, describe, expect, it } from "vitest";
import {
  applyStreamLine,
  emptyStreamedChat,
  streamingEnabled,
  takeCompleteLines,
  setStreamingSettingReader,
} from "../../../src/ai/ollamaStream";

/**
 * **流しながら受け取る**（設計書6.63.1）。
 *
 * まとめて1回で返す形だと応答ヘッダーが生成の完了まで来ず、Nodeの
 * 通信部品が既定300秒で切る（作者のログ、2026-09-01で302秒）。
 * 流せばヘッダーは即座に届くので、その上限に当たらない。
 */
describe("流れてきた行の取り込み", () => {
  it("本文を順につなぐ", () => {
    const state = emptyStreamedChat();
    applyStreamLine(state, '{"message":{"content":"あ"},"done":false}');
    applyStreamLine(state, '{"message":{"content":"い"},"done":false}');
    expect(state.content).toBe("あい");
  });

  it("最後の1件から統計を拾う", () => {
    const state = emptyStreamedChat();
    applyStreamLine(
      state,
      '{"done":true,"eval_count":123,"prompt_eval_count":456}'
    );
    expect(state.evalCount).toBe(123);
    expect(state.promptEvalCount).toBe(456);
  });

  it("最後の1件から、読み込み・書き出しの時間（ナノ秒）も拾う", () => {
    // 押す前の目安に、読み込みの速さを測るため（設計書6.8.19）
    const state = emptyStreamedChat();
    applyStreamLine(
      state,
      '{"done":true,"prompt_eval_count":456,"prompt_eval_duration":17000000000,"eval_count":123,"eval_duration":19000000000}'
    );
    expect(state.promptEvalDuration).toBe(17_000_000_000);
    expect(state.evalDuration).toBe(19_000_000_000);
  });

  it("出力上限で切られた印を拾う", () => {
    const state = emptyStreamedChat();
    applyStreamLine(state, '{"done":true,"done_reason":"length"}');
    expect(state.truncated).toBe(true);
  });

  it("自分で終えたときは、切られた扱いにしない", () => {
    const state = emptyStreamedChat();
    applyStreamLine(state, '{"done":true,"done_reason":"stop"}');
    expect(state.truncated).toBe(false);
  });

  it("Ollamaのエラー文を拾う", () => {
    const state = emptyStreamedChat();
    applyStreamLine(state, '{"error":"model not found"}');
    expect(state.error).toBe("model not found");
  });

  it("解けない行は捨てる（末尾の空行など）", () => {
    const state = emptyStreamedChat();
    applyStreamLine(state, "");
    applyStreamLine(state, "   ");
    applyStreamLine(state, "これはJSONではない");
    expect(state.content).toBe("");
  });
});

describe("行の切り出し", () => {
  it("完成した行だけを取り、途中は残す", () => {
    // **ここを手抜きすると、日本語が半分に割れた行で解析に失敗する**
    const { lines, rest } = takeCompleteLines('{"a":1}\n{"b":2}\n{"c":');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(rest).toBe('{"c":');
  });

  it("改行がまだ来ていなければ、何も取らない", () => {
    const { lines, rest } = takeCompleteLines('{"a"');
    expect(lines).toEqual([]);
    expect(rest).toBe('{"a"');
  });

  it("ちょうど改行で終われば、残りは空", () => {
    const { lines, rest } = takeCompleteLines('{"a":1}\n');
    expect(lines).toEqual(['{"a":1}']);
    expect(rest).toBe("");
  });
});

/**
 * **日本語が壊れないこと**（設計書6.63.1）。
 *
 * 日本語は1文字3バイトなので、流れてくる断片の境目が**文字の途中**に
 * 落ちるのは普通に起きる。`TextDecoder` の持ち越し（`{ stream: true }`）で
 * そこは繋がるが、**最後に空にしないと溜まったままの分が消える**。
 */
describe("日本語の受け取り", () => {
  it("文字の途中で切れても、繋いで元に戻る", () => {
    const text = '{"message":{"content":"沼ワニに近づく"},"done":false}\n';
    const bytes = new TextEncoder().encode(text);
    const decoder = new TextDecoder();
    const state = emptyStreamedChat();
    let buffer = "";
    // 1バイトずつ流し込む（いちばん意地の悪い切れ方）
    for (const byte of bytes) {
      buffer += decoder.decode(new Uint8Array([byte]), { stream: true });
      const { lines, rest } = takeCompleteLines(buffer);
      buffer = rest;
      for (const line of lines) applyStreamLine(state, line);
    }
    buffer += decoder.decode();
    applyStreamLine(state, buffer);

    expect(state.content).toBe("沼ワニに近づく");
  });

  it("改行で終わっていない最後の行も取り込む", () => {
    const state = emptyStreamedChat();
    // done の行に改行が付かずに終わることがある
    applyStreamLine(state, '{"message":{"content":"槍"},"done":true}');
    expect(state.content).toBe("槍");
  });
});

describe("思考の扱い", () => {
  it("**本文には混ぜない**", () => {
    // 混ぜると、抽出のJSONの前に思考文が付いて解析に失敗する
    const state = emptyStreamedChat();
    applyStreamLine(
      state,
      '{"message":{"content":"{\\"characters\\":[]}","thinking":"まず人物を探す"}}'
    );
    expect(state.content).toBe('{"characters":[]}');
    expect(state.thinking).toBe("まず人物を探す");
  });

  it("思考が流れてこない機種では undefined のまま", () => {
    const state = emptyStreamedChat();
    applyStreamLine(state, '{"message":{"content":"あ"},"done":false}');
    expect(state.thinking).toBeUndefined();
  });
});

/**
 * 0.42.0：配布版でも流し受信を使う（作者の指示「思考の流れをリリースに組み込んで」）。
 * 設定 `novelai.ollama.streaming` の読み口は `extension.ts` が差し込む。
 *
 * **入口は2つだけ**（0.45.0）。優先順は「設定 → 環境変数」。
 * 0.44.x までは開発ビルド限定のボタンによる上書きが最優先で載っていたが、
 * 設定が配布版へ入って役目を終えたので撤去した。
 */
describe("流し受信の入切の優先順（0.42.0）", () => {
  afterEach(() => {
    // **必ず戻す。** 残ると、あとに走る試験が流す側だけを通ってしまう
    setStreamingSettingReader(undefined);
    delete process.env.NOVELAI_OLLAMA_STREAM;
  });

  it("何もしなければ、既定は切", () => {
    // **配布する道が検査されない状態にしない**（既定を入にすると、
    // 単体試験が流す側だけを通る）
    delete process.env.NOVELAI_OLLAMA_STREAM;
    expect(streamingEnabled()).toBe(false);
  });

  it("設定の読み口が無ければ、環境変数だけを見る（単体テストの既定は切）", () => {
    expect(streamingEnabled()).toBe(false);
    process.env.NOVELAI_OLLAMA_STREAM = "1";
    expect(streamingEnabled()).toBe(true);
  });

  it("設定の読み口があれば、環境変数より設定を優先する", () => {
    process.env.NOVELAI_OLLAMA_STREAM = "1";
    setStreamingSettingReader(() => false);
    expect(streamingEnabled()).toBe(false);
    setStreamingSettingReader(() => true);
    expect(streamingEnabled()).toBe(true);
  });

  it("設定が undefined を返すときは環境変数へ落ちる", () => {
    setStreamingSettingReader(() => undefined);
    expect(streamingEnabled()).toBe(false);
  });
});

/**
 * **空白だけの行が続いたら、それ以上待たない**（残課題8）。
 *
 * 実機（さくらのAI、2026-09-22）では空白が出力上限まで 12,288 トークン
 * 続いた。流して受け取る道なら途中で気づけるので、そこで打ち切る。
 */
describe("空白で埋まっていく応答", () => {
  function line(content: string): string {
    return JSON.stringify({ message: { content }, done: false });
  }

  it("空白が一定量続いたら、打ち切りの印を立てる", () => {
    const state = emptyStreamedChat();
    applyStreamLine(state, line('{"deviations": [{"lineStart": 0}'));
    expect(state.whitespaceRunaway).toBeFalsy();
    for (let i = 0; i < 400; i++) applyStreamLine(state, line("\n        "));
    expect(state.whitespaceRunaway).toBe(true);
  });

  it("字下げ付きのふつうの応答では立てない", () => {
    const state = emptyStreamedChat();
    for (let i = 0; i < 400; i++) {
      applyStreamLine(state, line('\n        {"lineStart": ' + i + "},"));
    }
    expect(state.whitespaceRunaway).toBeFalsy();
  });

  it("空白のあとに中身が続いたら、印は下ろす", () => {
    // 印は「いま末尾が空白で埋まっているか」。途中の空白の山で
    // 立ったままにすると、まっとうに書き終えた応答まで打ち切り扱いになる
    const state = emptyStreamedChat();
    applyStreamLine(state, line("{" + " ".repeat(5000)));
    expect(state.whitespaceRunaway).toBe(true);
    applyStreamLine(state, line('"deviations": []}'));
    expect(state.whitespaceRunaway).toBe(false);
  });
});
