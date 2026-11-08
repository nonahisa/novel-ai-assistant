import { describe, expect, test } from "vitest";
import {
  isReadAloudEngineChoice,
  readAloudEngineChoiceOf,
  storedReadAloudEngine,
} from "../../../src/features/voiceEngineSettings";

/**
 * ［声］の欄の選択を端末に覚える形（0.146.0。設計書6.42.3）。
 * 前の版は「人物の声で読むか」を true／false で覚えていた。
 */

describe("［声］の選択の読み書き", () => {
  test("エンジンの名前はそのまま。OSの声と知らない値は OSの声", () => {
    expect(readAloudEngineChoiceOf("voicevox", {})).toBe("voicevox");
    expect(readAloudEngineChoiceOf("aivisspeech", {})).toBe("aivisspeech");
    expect(readAloudEngineChoiceOf(false, {})).toBe("os");
    expect(readAloudEngineChoiceOf(undefined, {})).toBe("os");
    expect(readAloudEngineChoiceOf("coeiroink", {})).toBe("os");
  });

  test("前の版の「人物の声」（true）は、古い接続先の設定が指している側", () => {
    expect(readAloudEngineChoiceOf(true, {})).toBe("aivisspeech");
    expect(readAloudEngineChoiceOf(true, { legacyUrl: "http://127.0.0.1:50021" })).toBe("voicevox");
    expect(readAloudEngineChoiceOf(true, { legacyUrl: "http://192.168.3.15:10101" })).toBe("aivisspeech");
  });

  test("OSの声は false で書く（前の版へ戻したとき、文字列が「人物の声」と読まれないように）", () => {
    expect(storedReadAloudEngine("os")).toBe(false);
    expect(storedReadAloudEngine("voicevox")).toBe("voicevox");
    expect(isReadAloudEngineChoice("os")).toBe(true);
    expect(isReadAloudEngineChoice("engine")).toBe(false);
  });
});
