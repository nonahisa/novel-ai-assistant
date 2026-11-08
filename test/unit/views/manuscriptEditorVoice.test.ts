import { describe, expect, it } from "vitest";
import { buildManuscriptEditorHtml } from "../../../src/views/manuscriptEditorHtml";

/**
 * 原稿エディタの読み上げ——人物の声で朗読する（設計書6.42.3）の画面側の約束。
 *
 * 音を鳴らすのは画面の中なので単体テストでは聞けない。ここでは
 * 「台本が JavaScript として読める」「止め方が1つに集まっている」
 * 「画面から外へ繋がない」を見る。実際に鳴るかは作者の実機（実機確認リスト）。
 */

const html = buildManuscriptEditorHtml("NONCE123", "vscode-resource:");
const script = html.slice(
  html.indexOf(">", html.indexOf('<script nonce="NONCE123">')) + 1,
  html.lastIndexOf("</script>")
);

function bodyOf(name: string, length = 1500): string {
  return script.slice(script.indexOf("function " + name + "("), script.indexOf("function " + name + "(") + length);
}

describe("人物の声の画面", () => {
  it("台本が JavaScript として読める（テンプレートリテラルの中で崩れていない）", () => {
    expect(() => new Function(script)).not.toThrow();
  });

  it("読み方の選択と、人物の声の操作がある（人物の声を選んだときだけ出す）", () => {
    expect(html).toContain('<select id="aloudEngine"');
    expect(html).toContain('<option value="engine">人物の声（AivisSpeech・VOICEVOX）【試作・テスト中】</option>');
    for (const id of ["aloudVoiceAssign", "aloudCastRun", "aloudCastOpen"]) {
      expect(html).toMatch(new RegExp('id="' + id + '" class="engine-only"'));
    }
    expect(html).toContain("body.aloudengine #aloud .engine-only { display: inline-block; }");
  });

  it("画面から外へは繋がない（CSP を広げない・fetch を使わない）", () => {
    expect(html).toContain("default-src 'none'");
    expect(html).not.toContain("connect-src");
    expect(html).not.toContain("media-src");
    expect(script).not.toContain("fetch(");
    expect(script).not.toContain("http://127.0.0.1");
    expect(script).not.toContain("XMLHttpRequest");
  });

  it("予約した音を止めるのは aloudCancel の中だけ（終える・飛ぶ・一時停止が同じ道を通る）", () => {
    const calls = script
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => !line.startsWith("*") && !line.startsWith("//"))
      .filter((line) => line.includes("voiceStopAll();"));
    expect(calls).toHaveLength(1);
    expect(bodyOf("aloudCancel", 900)).toContain("voiceStopAll();");
  });

  it("古い世代・古い計画の音は捨てる。続けるのは今の文の頭から（aloudSpeakSoon を通る）", () => {
    expect(bodyOf("voiceTakeAudio")).toContain(
      "if (message.gen !== voiceGen || message.planId !== voicePlanId) return;"
    );
    expect(bodyOf("voiceStopAll")).toContain("voiceGen++");
    expect(bodyOf("aloudSpeak", 600)).toContain("voiceSpeakFrom(index)");
  });

  it("前の音が終わる時刻に予約して続けて鳴らす（文の間は計画の gapMs）", () => {
    const schedule = bodyOf("voiceSchedule", 2200);
    expect(schedule).toContain("source.start(startAt)");
    expect(schedule).toContain("voiceEndAt + gap");
    expect(schedule).toContain("sentence.gapMs");
  });

  it("計画を頼むときに読み方を添える。読み方の違う計画は使わない", () => {
    expect(script).toContain('type: "readingPlan", text: text, voiced: voiceMode');
    expect(bodyOf("aloudTakePlan")).toContain("if (!!message.voiced !== voiceMode) return;");
  });

  /*
    作者の実機（2026-11-08、VOICEVOX）：「校正パネルをクリックすると音声が
    その文の最初に巻き戻ります」。ほかのパネルを押すと原稿の面が前から外れ、
    拡張機能は onDidChangeViewState で本文を送り直す（update）。画面は update の
    たびに計画を取り直し、人物の声は取り直すと今の文の頭から鳴らし直す
    （aloudTakePlan の末尾）。**本文が変わっていない update では取り直さない。**
  */
  it("本文が変わっていない update では、読み上げの計画を取り直さない（ほかのパネルを押しても巻き戻らない）", () => {
    expect(script).toContain(
      "if (aloudStartAt !== null || (aloudOn && aloudTextNow() !== aloudPlannedText)) aloudAskPlan();"
    );
    expect(script).not.toContain("if (aloudOn || aloudStartAt !== null) aloudAskPlan();");
    expect(bodyOf("aloudAskPlan", 300)).toContain("aloudPlannedText = text;");
    // 頼んだ本文と同じものを送る（覚えた本文と送った本文が食い違わない）
    expect(bodyOf("aloudAskPlan", 300)).toContain('type: "readingPlan", text: text, voiced: voiceMode');
  });

  it("使えない環境では選択肢を押せなくして理由を出す（消さない）", () => {
    const take = bodyOf("voiceTakeUsable");
    expect(take).toContain("option.disabled = !voiceUsable");
    expect(take).toContain("aloudEngine.title = voiceUsable");
  });

  it("エンジンに届かなかった窓で［OSの声で読む］を押されたら、OSの声へ切り替えて読み始める（覚えている選択は変えない）", () => {
    expect(script).toContain('message.type === "useOsVoice"');
    const use = bodyOf("voiceUseOsVoice", 600);
    expect(use).toContain("voiceSetMode(false, false)");
    expect(use).toContain("aloudStart()");
  });
});
