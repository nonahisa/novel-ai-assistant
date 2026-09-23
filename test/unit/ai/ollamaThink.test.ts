import { afterEach, describe, expect, test } from "vitest";
import { thinkOptionFor, willStreamChat } from "../../src/ai/ollamaProvider";
import { setStreamingSettingReader } from "../../src/ai/ollamaStream";

/**
 * **思考を流す口を渡しているときは、思考を切らない**（作者の指摘、
 * 2026-09-07。設計書6.63.2）。
 *
 * 相談パネルは `onThinking` を渡しながら `disableThinking: true` も
 * 送っており、Ollamaが `think: false` を受けて思考を1文字も返さないため、
 * **「考えています…」のまま67秒間なにも流れなかった**。単体試験では
 * 気づけない形（呼ばれなくても壊れず、静かに何もしないだけ）なので、
 * **同時に立った状態がどう解決されるかを、ここで固める。**
 */
describe("Ollamaへ think:false を送るか", () => {
  afterEach(() => {
    // **必ず戻す。** 残ると、あとに走る試験が流す側だけを通ってしまう
    setStreamingSettingReader(undefined);
  });

  test("思考を流して受け取れるときは、送らない（＝思考が有効になる）", () => {
    expect(thinkOptionFor({ disableThinking: true, onThinking: () => {} }, true)).toBe(
      undefined
    );
  });

  test("受け取る口が無ければ、これまでどおり送る（遅くしない）", () => {
    expect(thinkOptionFor({ disableThinking: true }, true)).toBe(false);
  });

  test("流せない道（配布版・まとめて受け取る）では、口があっても送る", () => {
    // 流せないのに思考を有効にすると、見えないものを待つぶんだけ遅くなる
    expect(
      thinkOptionFor({ disableThinking: true, onThinking: () => {} }, false)
    ).toBe(false);
  });

  test("そもそも切ると言っていなければ、何も送らない", () => {
    expect(thinkOptionFor({}, true)).toBe(undefined);
    expect(thinkOptionFor({ onThinking: () => {} }, false)).toBe(undefined);
  });
});

describe("流して受け取る道を通るか", () => {
  afterEach(() => {
    setStreamingSettingReader(undefined);
    delete process.env.NOVELAI_OLLAMA_STREAM;
  });

  test("設定が入なら通る", () => {
    setStreamingSettingReader(() => true);
    expect(willStreamChat({})).toBe(true);
  });

  test("呼び出し側が断れば通らない（測定は配布と同じ道で行う）", () => {
    setStreamingSettingReader(() => true);
    expect(willStreamChat({ disableStreaming: true })).toBe(false);
  });

  test("既定（設定が切）では通らない", () => {
    delete process.env.NOVELAI_OLLAMA_STREAM;
    setStreamingSettingReader(() => false);
    expect(willStreamChat({})).toBe(false);
  });
});
