import { afterEach, describe, expect, it } from "vitest";
import {
  applyStreamLine,
  emptyStreamedChat,
  setStreamingOverride,
  streamingEnabled,
  takeCompleteLines,
} from "../../src/ai/ollamaStream";

/**
 * **流しながら受け取る**（設計書6.63.1、開発ビルド限定の実験）。
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
 * **走らせたまま切り替えられること**（作者の依頼、2026-09-03）。
 *
 * 環境変数だけだと `.vscode/launch.json` を書き換えてF5を掛け直すまで
 * 試せない。詳細メニューから押せるようにするために、実行中に上書きできる
 * 入口を設ける。**上書きはウィンドウを閉じるまで**で、どこにも保存しない。
 */
describe("実験の入切", () => {
  afterEach(() => {
    // **必ず戻す。** 残ると、あとに走る試験が実験の側だけを通ってしまう
    setStreamingOverride(undefined);
    delete process.env.NOVELAI_OLLAMA_STREAM;
  });

  it("入にすると、環境変数が無くても有効になる", () => {
    delete process.env.NOVELAI_OLLAMA_STREAM;
    setStreamingOverride(true);
    expect(streamingEnabled()).toBe(true);
  });

  it("切にすると、環境変数が立っていても無効になる", () => {
    // launch.json に書いたまま、その場で切りたいことがある
    process.env.NOVELAI_OLLAMA_STREAM = "1";
    setStreamingOverride(false);
    expect(streamingEnabled()).toBe(false);
  });

  it("undefined へ戻すと、環境変数の値に従う", () => {
    setStreamingOverride(true);
    setStreamingOverride(undefined);
    expect(streamingEnabled()).toBe(false);

    process.env.NOVELAI_OLLAMA_STREAM = "1";
    expect(streamingEnabled()).toBe(true);
  });

  it("何もしなければ、既定は切", () => {
    // **配布する道が検査されない状態にしない**（既定を入にすると、
    // 単体試験が実験の側だけを通る）
    delete process.env.NOVELAI_OLLAMA_STREAM;
    expect(streamingEnabled()).toBe(false);
  });
});
