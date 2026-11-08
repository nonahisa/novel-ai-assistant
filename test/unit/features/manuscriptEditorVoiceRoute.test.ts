import { describe, expect, it } from "vitest";
import { blockAfter } from "../support/sourceBlock";
import { srcSource } from "../support/srcSources";

/**
 * 原稿エディターの受け口が、人物の声の操作をどこへ渡すか（設計書6.42.3・6.42.4）。
 *
 * 受け口は WebView の便を受ける大きな switch の中にあり、単体では動かせないので、
 * ソースを読んで道を確かめる。
 */

const source = srcSource("features/manuscriptEditor.ts");
const voiceCastCase = blockAfter(source, 'case "voiceCast":', { openAt: "afterMarker", where: "manuscriptEditor.ts" });

describe("人物の声の操作の受け口", () => {
  /*
    0.143.0 から 0.145.0 まで、画面の［音声に書き出す］は action "export" の便を送っていたが、
    受け口に export の枝が無く、様子を返すだけで何も書き出さなかった（右クリックの道だけが動いた）。
    0.146.0 でエンジンを渡す形に直すときに見つけた
  */
  it("［音声に書き出す］（action export）を、書き出しの口へ渡す", () => {
    expect(voiceCastCase).toMatch(/message\.action === "export"[\s\S]*?voiceReading\.exportAudio\(/);
  });

  it("［声の割り当て］と［音声に書き出す］には、画面で選んだエンジンを渡す（拡張機能の側で形を確かめる）", () => {
    expect(voiceCastCase).toContain("isVoiceEngineId(message.engine)");
    expect(voiceCastCase).toMatch(/voiceReading\.assignVoices\(filePath, engine\)/);
    expect(voiceCastCase).toMatch(/voiceReading\.exportAudio\(filePath, text, engine\)/);
  });
});
