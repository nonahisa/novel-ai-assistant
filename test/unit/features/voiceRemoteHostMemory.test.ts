import { describe, expect, test } from "vitest";
import { VoiceReadingService } from "../../../src/features/voiceReading";
import { buildReadingPlan } from "../../../src/core/readAloud";
import { workspace } from "../support/vscodeStub";
import { answerConfirms } from "../support/confirmPicker";
import { describeRemembered, withoutRemembered } from "../../../src/core/confirmMemory";
import { readConfirmMemory, saveConfirmMemory } from "../../../src/core/confirmMemoryStore";

/**
 * 外のホストへ本文を送る確認を、ホストごとに「以降は訊かない」にできる（設計書6.42.3・6.89）。
 *
 * 製品の確認の窓（`confirmRun`）と覚え書きの読み書きを本物のまま通し、
 * 設定だけを「書いたら次の読みで返る」入れ物に差し替える（= 次の起動で残るかを見る）。
 */

const HOST = "192.168.1.20:10101";
const SEND = "送る";
const SEND_AND_REMEMBER = "送る（以降は訊かない）";

function stubSettingStore(initial: Record<string, string> = {}) {
  let stored: Record<string, string> = { ...initial };
  const original = workspace.getConfiguration;
  workspace.getConfiguration = ((section?: string) => {
    if (section !== "novelai") return original();
    return {
      get: (_key: string) => stored,
      update: async (_key: string, value: Record<string, string>) => {
        stored = { ...value };
      },
    };
  }) as typeof workspace.getConfiguration;
  return {
    current: () => stored,
    restore: () => {
      workspace.getConfiguration = original;
    },
  };
}

function fakeFetch() {
  const calls: string[] = [];
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    const path = new URL(url).pathname;
    if (path === "/speakers") {
      return new Response(
        JSON.stringify([
          { name: "まい", speaker_uuid: "u", styles: [{ name: "ノーマル", id: 1, type: "talk" }] },
        ])
      );
    }
    if (path === "/audio_query") return new Response(JSON.stringify({ speedScale: 1 }));
    return new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]));
  };
  return { calls, impl: impl as unknown as typeof fetch };
}

/** 起動のたびに新しい係ができる（= メモリの許可は引き継がれない） */
async function speak(url: string): Promise<boolean> {
  const { impl } = fakeFetch();
  const service = new VoiceReadingService(() => url, impl);
  const sentences = buildReadingPlan("地の文。", "curly", [], { splitDialogue: true });
  const planned = await service.plan(undefined, "/x.txt", "地の文。", sentences);
  if (!("units" in planned)) throw new Error(planned.problem);
  return "wav" in (await service.audio(planned.units, 0, 1));
}

describe("外のホストへ送る確認：ホストごとに「以降は訊かない」", () => {
  test("［送る］だけなら覚えない。次の起動でまた訊く", async () => {
    const store = stubSettingStore();
    const first = answerConfirms(SEND);
    try {
      expect(await speak(`http://${HOST}`)).toBe(true);
      expect(first.shown).toHaveLength(1);
      expect(first.shown[0].buttons).toEqual([SEND, SEND_AND_REMEMBER]);
      expect(store.current()).toEqual({});
    } finally {
      first.restore();
    }
    const second = answerConfirms(SEND);
    try {
      expect(await speak(`http://${HOST}`)).toBe(true);
      expect(second.shown).toHaveLength(1);
    } finally {
      second.restore();
      store.restore();
    }
  });

  test("「以降は訊かない」を選んだホストへは、次の起動から訊かずに送る", async () => {
    const store = stubSettingStore();
    const first = answerConfirms(SEND_AND_REMEMBER);
    try {
      expect(await speak(`http://${HOST}`)).toBe(true);
      expect(store.current()).toEqual({ [`voice.remoteHost.${HOST}`]: SEND });
    } finally {
      first.restore();
    }
    const second = answerConfirms(undefined);
    try {
      expect(await speak(`http://${HOST}`)).toBe(true);
      expect(second.shown).toEqual([]);
    } finally {
      second.restore();
      store.restore();
    }
  });

  test("別のホストでは、覚えていても必ず訊く。断れば送らない", async () => {
    const store = stubSettingStore({ [`voice.remoteHost.${HOST}`]: SEND });
    const picker = answerConfirms(undefined);
    try {
      expect(await speak("http://192.168.1.21:10101")).toBe(false);
      expect(picker.shown).toHaveLength(1);
      // 同じホストでもポートが変われば別のホスト
      expect(await speak("http://192.168.1.20:50021")).toBe(false);
      expect(picker.shown).toHaveLength(2);
    } finally {
      picker.restore();
      store.restore();
    }
  });

  test("断った答えは覚えない", async () => {
    const store = stubSettingStore();
    const picker = answerConfirms(undefined);
    try {
      expect(await speak(`http://${HOST}`)).toBe(false);
      expect(store.current()).toEqual({});
    } finally {
      picker.restore();
      store.restore();
    }
  });

  test("見直しの画面から外すと、また訊く。名前は「人物の声の送り先」", async () => {
    const store = stubSettingStore({ [`voice.remoteHost.${HOST}`]: SEND });
    try {
      const listed = describeRemembered(readConfirmMemory());
      expect(listed).toEqual([
        {
          id: `voice.remoteHost.${HOST}`,
          label: `人物の声の送り先：${HOST}へ本文を送る`,
          answer: SEND,
        },
      ]);
      await saveConfirmMemory(withoutRemembered(readConfirmMemory(), listed[0].id));
    } finally {
      // 外したあとの設定のまま、確認が出ることを見る
    }
    const picker = answerConfirms(SEND);
    try {
      expect(await speak(`http://${HOST}`)).toBe(true);
      expect(picker.shown).toHaveLength(1);
    } finally {
      picker.restore();
      store.restore();
    }
  });

  test("この PC のエンジン（localhost）は今までどおり訊かない", async () => {
    const store = stubSettingStore();
    const picker = answerConfirms(undefined);
    try {
      expect(await speak("http://localhost:10101")).toBe(true);
      expect(picker.shown).toEqual([]);
    } finally {
      picker.restore();
      store.restore();
    }
  });
});
