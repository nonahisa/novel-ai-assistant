import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  beginAiWork,
  endAiWork,
  isAiBusy,
  resetAiActivity,
  withAiWork,
} from "../../src/core/aiActivity";
import { LmStudioProvider } from "../../src/ai/lmstudioProvider";

/**
 * AIが仕事中かどうか。独り言が割り込まないための印。
 */
describe("AIの仕事中の印", () => {
  beforeEach(() => resetAiActivity());

  test("何もしていなければ空いている", () => {
    expect(isAiBusy()).toBe(false);
  });

  test("依頼の間だけ仕事中になる", async () => {
    const promise = withAiWork(async () => {
      expect(isAiBusy()).toBe(true);
      return 1;
    });

    expect(await promise).toBe(1);
    expect(isAiBusy()).toBe(false);
  });

  test("失敗しても印を降ろす", async () => {
    // 降ろし忘れると、以後ずっと独り言が出なくなる
    await expect(
      withAiWork(async () => {
        throw new Error("失敗");
      })
    ).rejects.toThrow("失敗");

    expect(isAiBusy()).toBe(false);
  });

  test("並行して投げても、全部終わるまで仕事中のまま", () => {
    // 抽出はチャンクを並行して投げる。真偽値で持つと、
    // 先に終わった1本が「もう空いた」と言ってしまう
    beginAiWork();
    beginAiWork();
    endAiWork();

    expect(isAiBusy()).toBe(true);

    endAiWork();
    expect(isAiBusy()).toBe(false);
  });

  test("合わない降ろし方をされても壊れない", () => {
    // 「ずっと空いている」ことにして黙るより害が小さい
    endAiWork();
    endAiWork();

    expect(isAiBusy()).toBe(false);
    beginAiWork();
    expect(isAiBusy()).toBe(true);
  });
});

/**
 * **手元のAIは、どれも印を立てる**（0.33.0のレビュー）。
 *
 * 印を立てていたのはOllamaだけだった。独り言はローカルAIでしか動かない
 * ——つまり**LM Studioを使っている作者では、抽出の最中でも独り言が
 * 割り込む**（そして30秒で時間切れになり、その一言は失われる）。
 * 「Ollamaにだけ入れている」という当時の理由づけは、LM Studioを足した
 * 0.18.0の時点で成り立たなくなっていた。
 */
describe("手元のAIは、依頼のあいだ仕事中の印を立てる", () => {
  beforeEach(() => resetAiActivity());
  afterEach(() => vi.unstubAllGlobals());

  test("LM Studio：generate のあいだは仕事中", async () => {
    let busyDuringCall: boolean | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes("/api/v0/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        busyDuringCall = isAiBusy();
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
          { status: 200 }
        );
      })
    );

    await new LmStudioProvider().generate({
      systemPrompt: "指示",
      userPrompt: "本文",
      model: "test-model",
      temperature: 0.2,
    });

    expect(busyDuringCall, "送っている最中に印が立っていない").toBe(true);
    // 終わったら必ず降ろす。降ろし忘れると以後ずっと独り言が出なくなる
    expect(isAiBusy()).toBe(false);
  });
});
