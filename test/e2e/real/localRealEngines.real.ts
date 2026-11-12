/**
 * 本物の音声エンジン（AivisSpeech 127.0.0.1:10101・VOICEVOX 127.0.0.1:50021）へ向けた画面の自動テストの続き
 * （実機確認リストの 26・28・99・104・111・113・123 行の「機械で見られる所」。耳の所は MP3 を残して作者へ渡す）。
 * 2026-11-12 母艦の頼み「本物の声のエンジンと作者の耳の項目を、頼んだときだけ流れる件へ移す」。
 * 土台は `localRealAivis.real.ts`（48・74・49・80）と同じ。共通の部品は `realSupport.ts`。
 *
 * | 行 | 件 | 門 | 機械で見ること | 作者の耳に残ること |
 * |---|---|---|---|---|
 * | 26・28 | 混ぜた声 | AIVIS + VOICEVOX | 窓が出ずに読み終える・その人物の台詞だけ VOICEVOX へ頼まれる・MP3 が 44100Hz・注意書きに両方 | 高さと速さが読み上げと同じか・エンジンの替わり目の間 |
 * | 99・113 | VOICEVOX で読み・書き出す | VOICEVOX | 窓が出ずに読み終える・書き出しの規約が取れて MP3 とライセンスができる・人物ごとに別のスタイルの番号で頼む | VOICEVOX の声で読み分けて聞こえるか |
 * | 123 | 感情 | AIVIS | 感情ごとに頼んだスタイルの番号を記録し、選び方の表と合うか見る | 感情に合って聞こえるか・調子の寄せが大げさでないか |
 * | 104 | 速い PC で遅さの知らせが出ない | AIVIS + FAST_PC | 10文以上読んで、遅さの知らせが0回 | （なし） |
 * | 111 | AivisSpeech の書き出し | AIVIS | `localRealAivis.real.ts` の 49・80 の件が、できた MP3 と注意書きを置き場へ写す | MP3 の声・注意書きの要点が全文と合うか（読み比べはセッション） |
 *
 * 流し方：スキル `e2e` の「本物の AivisSpeech で流す」の節。門の環境変数は `realSupport.ts` の頭に書いてある。
 * **`npm run test:e2e`・`check`・CI には入らない**（名前が `*.real.ts`。専用の設定 `vitest.real.config.mts` だけが拾う）。
 * 本文は見本の話をこのファイルの中で作る（作者の作品は読まない）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { castDialogues } from "../../../src/core/voiceCast";
import {
  isNormalStyleName,
  pickNormalStyle,
  pickStyleForEmotion,
  styleEmotionOf,
  voiceParamsFor,
  VOICE_ADJUST_PRESETS,
  type VoiceAdjust,
  type VoiceEmotion,
  type VoiceSpeaker,
} from "../../../src/core/voiceEngine";
import { withVsCode } from "../support/vscodeApp";
import { describeNotices } from "../support/noticeRecord";
import {
  castBySpeaker,
  engineSettings,
  exportEpisode,
  GATE_AIVIS,
  GATE_FAST_PC,
  GATE_MIX,
  GATE_VOICEVOX,
  noteListening,
  openRow,
  outDir,
  readUntil,
  realCharacter,
  realSpeakers,
  sampleEpisode,
  slowCount,
  startRecordingProxy,
  stopReading,
  synthDone,
  writeCast,
  writeCharacters,
  writeVoices,
  type Logged,
} from "./realSupport";

/** 件の結果を、置き場の `<keepAs>/結果.json` へ書く（作者の話の題名は入らない。見本の話だけ） */
async function writeResult(keepAs: string, result: Record<string, unknown>): Promise<void> {
  const dir = path.join(await outDir(), keepAs);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "結果.json"), JSON.stringify(result, null, 2), "utf8");
}

/** 本文を運ぶ頼み（`/audio_query`）のうち、本文に `needle` を含むもの */
function queriesWith(log: Logged[], needle: string): Logged[] {
  return log.filter((entry) => entry.path === "/audio_query" && (entry.text ?? "").includes(needle));
}

/** 台詞の字から、括弧を除いた頭の3字（この話の中で、台詞の外には出てこない字だけ目印にする） */
function dialogueMarkers(text: string, picked: ReadonlySet<number>): string[] {
  const dialogues = castDialogues(text);
  let outside = text;
  for (const dialogue of [...dialogues].reverse()) outside = outside.slice(0, dialogue.start) + outside.slice(dialogue.end);
  return dialogues
    .filter((dialogue) => picked.has(dialogue.index))
    .map((dialogue) => dialogue.quote.replace(/^「/, "").slice(0, 3))
    .filter((marker) => !outside.includes(marker));
}

/* ───────────────────────── 26・28：混ぜた声 ───────────────────────── */

test.skipIf(!GATE_MIX)(
  "26・28：語りを AivisSpeech、台詞の人物1人を VOICEVOX にして、止まらずに読み終え、書き出した MP3 は 44100Hz で、注意書きに両方が並ぶ",
  async () => {
    const aivis = await startRecordingProxy("aivisspeech");
    const voicevox = await startRecordingProxy("voicevox");
    const aSpeakers = await realSpeakers("aivisspeech");
    const vSpeakers = await realSpeakers("voicevox");
    const akari = realCharacter("char_001", "灯");
    const ep = sampleEpisode("episode_0001_混ぜた声.md", "朝の駅前", 20);
    const stem = ep.name.replace(/\.md$/, "");
    // 台詞の1つおきを灯（VOICEVOX）、残りは台詞の既定（＝語りの声。AivisSpeech）で読ませる
    const akariIndexes = new Set(castDialogues(ep.text).filter((d) => d.index % 2 === 0).map((d) => d.index));
    const akariMarkers = dialogueMarkers(ep.text, akariIndexes);
    const otherMarkers = dialogueMarkers(ep.text, new Set(castDialogues(ep.text).filter((d) => !akariIndexes.has(d.index)).map((d) => d.index)));
    expect(akariMarkers.length, "灯の台詞の目印").toBeGreaterThan(0);
    const result: Record<string, unknown> = { episode: ep.name, chars: ep.text.length, akariMarkers, otherMarkers };
    try {
      await withVsCode(
        "混ぜた声で読み・書き出す",
        [ep],
        async (session) => {
          const frame = await openRow(session, ep.name, "朝の駅前", "aivisspeech");
          /* ── 読む（26） ── */
          const since = Date.now();
          await frame.locator("#aloudPlay").click();
          const read = await readUntil(session, frame, [aivis, voicevox], since, Number.MAX_SAFE_INTEGER, 20 * 60_000);
          result.read = { ...read, seconds: Math.round((Date.now() - since) / 1000), notices: await describeNotices(session, since) };
          await stopReading(frame);
          /* ── 書き出す（28） ── */
          const exported = await exportEpisode(session, frame, stem, "混ぜた声", 45 * 60_000);
          result.export = exported;
        },
        {
          settings: engineSettings({ aivisspeech: aivis.url, voicevox: voicevox.url }),
          prepareWork: async (folders) => {
            await writeCharacters(folders.workFolder, [akari]);
            await writeVoices(folders.workFolder, {
              narrator: { engine: "aivisspeech", speaker: aSpeakers[0] },
              characters: [{ id: akari.id, name: akari.name, voice: { engine: "voicevox", speaker: vSpeakers[0] } }],
            });
            await writeCast(folders, ep.name, castBySpeaker(ep.text, (index) => (akariIndexes.has(index) ? { id: akari.id, name: akari.name } : undefined)));
          },
        }
      );
    } finally {
      result.requests = { aivis: aivis.log.length, voicevox: voicevox.log.length };
      await writeResult("混ぜた声", result);
      await aivis.close();
      await voicevox.close();
    }
    const read = result.read as { dialogs: string[]; done: number };
    const exported = result.export as Awaited<ReturnType<typeof exportEpisode>>;
    expect(read.dialogs, "読んでいる間に真ん中の窓が出た").toEqual([]);
    // 灯の台詞だけが VOICEVOX へ、そのほか（語り・ほかの台詞）は AivisSpeech へ頼まれる
    for (const marker of akariMarkers) {
      expect(queriesWith(voicevox.log, marker).length, `灯の台詞「${marker}…」が VOICEVOX へ頼まれた`).toBeGreaterThan(0);
      expect(queriesWith(aivis.log, marker).length, `灯の台詞「${marker}…」が AivisSpeech へ頼まれた`).toBe(0);
    }
    expect(queriesWith(aivis.log, "冷たい風").length, "語りが AivisSpeech へ頼まれた").toBeGreaterThan(0);
    expect(queriesWith(voicevox.log, "冷たい風").length, "語りが VOICEVOX へ頼まれた").toBe(0);
    expect(synthDone(voicevox.log, 0).length, "VOICEVOX の合成").toBeGreaterThan(0);
    // 書き出し
    expect(exported.dialogs, "書き出しの途中で真ん中の窓が出た").toEqual([]);
    const mp3s = exported.files.filter((file) => file.endsWith(".mp3"));
    expect(mp3s.length, `できたファイル：${JSON.stringify(exported.files)}`).toBeGreaterThan(0);
    for (const mp3 of mp3s) expect(exported.mp3Rates[mp3], `MP3 の標本化の速さ（${mp3}）`).toBe(44100);
    expect(exported.credits, "注意書きに VOICEVOX の話者").toContain(`VOICEVOX:${vSpeakers[0].name}`);
    expect(exported.credits, "注意書きに AivisSpeech の声").toMatch(/Aivis|ACML/);
    await noteListening(
      `混ぜた声/${mp3s[0]}`,
      "26・28行",
      "語りは AivisSpeech の声、灯の台詞だけ VOICEVOX の声。声の高さと速さが読み上げのときと同じか（高く速い・低く遅いなら標本化の揃えの不具合）。エンジンが替わる所で間があきすぎないか"
    );
    await noteListening("混ぜた声/クレジットと利用条件.txt", "28行", "AivisSpeech の声と「VOICEVOX:〈キャラ名〉」の両方が並んでいるか（機械では並ぶことを確認済み。読んで変でないかだけ）");
  },
  50 * 60_000
);

/* ───────────────────────── 99・113：VOICEVOX ───────────────────────── */

test.skipIf(!GATE_VOICEVOX)(
  "99・113：VOICEVOX で人物2人を別の声にして読み、1話を書き出すと、規約が取れて止まらずに MP3 とライセンスができる",
  async () => {
    const voicevox = await startRecordingProxy("voicevox");
    const speakers = await realSpeakers("voicevox");
    if (speakers.length < 2) throw new Error("VOICEVOX の話者が2人未満です（別の声にする人物が選べません）");
    const [narratorVoice, akariVoice, hotaruVoice] = [speakers[0], speakers[1], speakers[2] ?? speakers[0]];
    const akari = realCharacter("char_001", "灯");
    const hotaru = realCharacter("char_002", "蛍");
    const text = [
      "　駅前のベンチに、二人は並んで座っていた。",
      "「今日はいい天気ですね」と灯は言った。",
      "　蛍は小さくうなずいて、空を見上げた。",
      "「ええ、雲ひとつありません」と蛍は答えた。",
      "　風が、そっと二人の間を通りすぎた。",
      "「そろそろ行きましょうか」と灯が立ち上がった。",
      "「はい、行きましょう」と蛍も続いた。",
    ].join("\n") + "\n";
    const ep = { name: "episode_0001_ベンチ.md", text };
    const stem = ep.name.replace(/\.md$/, "");
    const result: Record<string, unknown> = { episode: ep.name, chars: text.length };
    try {
      await withVsCode(
        "VOICEVOX で読み・書き出す",
        [ep],
        async (session) => {
          const frame = await openRow(session, ep.name, "駅前のベンチ", "voicevox");
          const since = Date.now();
          await frame.locator("#aloudPlay").click();
          const read = await readUntil(session, frame, [voicevox], since, Number.MAX_SAFE_INTEGER, 10 * 60_000);
          result.read = { ...read, seconds: Math.round((Date.now() - since) / 1000), notices: await describeNotices(session, since) };
          await stopReading(frame);
          result.export = await exportEpisode(session, frame, stem, "VOICEVOX書き出し", 20 * 60_000);
        },
        {
          settings: engineSettings({ voicevox: voicevox.url }),
          prepareWork: async (folders) => {
            await writeCharacters(folders.workFolder, [akari, hotaru]);
            await writeVoices(folders.workFolder, {
              narrator: { engine: "voicevox", speaker: narratorVoice },
              characters: [
                { id: akari.id, name: akari.name, voice: { engine: "voicevox", speaker: akariVoice } },
                { id: hotaru.id, name: hotaru.name, voice: { engine: "voicevox", speaker: hotaruVoice } },
              ],
            });
            await writeCast(folders, ep.name, castBySpeaker(text, (index) => (index % 2 === 0 ? { id: akari.id, name: akari.name } : { id: hotaru.id, name: hotaru.name })));
          },
        }
      );
    } finally {
      const used = [...new Set(voicevox.log.filter((entry) => entry.path === "/audio_query").map((entry) => entry.speaker))];
      result.requestedStyleIds = used;
      await writeResult("VOICEVOX書き出し", result);
      await voicevox.close();
    }
    const read = result.read as { dialogs: string[]; done: number };
    const exported = result.export as Awaited<ReturnType<typeof exportEpisode>>;
    expect(read.dialogs, "読んでいる間に真ん中の窓が出た").toEqual([]);
    expect(read.done, "VOICEVOX で合成できた文の数").toBeGreaterThan(0);
    // 人物ごとに別のスタイルの番号で頼む（語り・灯・蛍。話者が2人しかいなければ2つ）
    const distinct = new Set([narratorVoice.uuid, akariVoice.uuid, hotaruVoice.uuid]).size;
    expect((result.requestedStyleIds as unknown[]).length, `頼んだスタイルの番号：${JSON.stringify(result.requestedStyleIds)}`).toBeGreaterThanOrEqual(distinct);
    expect(exported.dialogs, "書き出しの途中で真ん中の窓が出た").toEqual([]);
    expect(exported.files.some((file) => file.endsWith(".mp3")), `できたファイル：${JSON.stringify(exported.files)}`).toBe(true);
    expect(exported.files, "クレジットと利用条件").toContain("クレジットと利用条件.txt");
    expect(exported.files.some((file) => file.startsWith("ライセンス")), `ライセンス：${JSON.stringify(exported.files)}`).toBe(true);
    expect(exported.credits, "注意書きに灯の声の話者").toContain(`VOICEVOX:${akariVoice.name}`);
    expect(exported.credits, "注意書きに蛍の声の話者").toContain(`VOICEVOX:${hotaruVoice.name}`);
    await noteListening(
      `VOICEVOX書き出し/${stem}.mp3`,
      "99・113行",
      "語り・灯・蛍が別々の VOICEVOX の声で読み分けて聞こえるか。読み上げのときと同じ声か"
    );
    await noteListening("VOICEVOX書き出し/クレジットと利用条件.txt", "113行", "本物のキャラクターの規約が取れて、「VOICEVOX:〈キャラ名〉」が並んでいるか");
  },
  30 * 60_000
);

/* ───────────────────────── 123：感情 ───────────────────────── */

const EMOTION_LINES: Array<{ emotion: VoiceEmotion; quote: string; key: string }> = [
  { emotion: "喜び", quote: "「やったあ！うれしいな」", key: "やった" },
  { emotion: "怒り", quote: "「ふざけるな！ゆるさない」", key: "ふざけ" },
  { emotion: "悲しみ", quote: "「もう会えないなんて、かなしい」", key: "もう会え" },
  { emotion: "ささやき", quote: "「しずかに、だれかがくる」", key: "しずか" },
  { emotion: "叫び", quote: "「たすけてえええ！」", key: "たすけ" },
  // 比べる元（平静）。選んだのが感情のスタイルかノーマルなら同じ話者のノーマル、声の形なら選んだまま（作者の答え 2026-11-13）
  { emotion: "平静", quote: "「そろそろ帰りましょう」", key: "そろそろ" },
];

test.skipIf(!GATE_AIVIS)(
  "123：AI を呼ばずに感情（喜び・怒り・悲しみ・ささやき・叫び）を決めて書き出し、感情ごとに頼んだスタイルの番号を記録する",
  async () => {
    const aivis = await startRecordingProxy("aivisspeech");
    const speakers = await realSpeakers("aivisspeech");
    // 感情に合うスタイルを持つ話者がいちばん多い話者で試す（見つからない話者では、何も切り替わらない）
    const emotions = EMOTION_LINES.filter((line) => line.emotion !== "平静").map((line) => line.emotion);
    const styledCount = (speaker: VoiceSpeaker): number => emotions.filter((emotion) => pickStyleForEmotion([speaker], speaker.styles[0].id, emotion).styled).length;
    const speaker = [...speakers].sort((a, b) => styledCount(b) - styledCount(a))[0];
    const base = speaker.styles[0];
    const akari = realCharacter("char_001", "灯");
    const text = EMOTION_LINES.map((line) => `${line.quote}と灯は言った。`).join("\n") + "\n";
    const ep = { name: "episode_0001_感情.md", text };
    const stem = ep.name.replace(/\.md$/, "");
    const result: Record<string, unknown> = { episode: ep.name, speaker: speaker.name, baseStyle: { id: base.id, name: base.name }, styledEmotions: styledCount(speaker) };
    try {
      await withVsCode(
        "感情で書き出す",
        [ep],
        async (session) => {
          const frame = await openRow(session, ep.name, "やったあ", "aivisspeech");
          result.export = await exportEpisode(session, frame, stem, "感情の声", 30 * 60_000);
        },
        {
          settings: engineSettings({ aivisspeech: aivis.url }),
          prepareWork: async (folders) => {
            await writeCharacters(folders.workFolder, [akari]);
            await writeVoices(folders.workFolder, {
              narrator: { engine: "aivisspeech", speaker },
              characters: [{ id: akari.id, name: akari.name, voice: { engine: "aivisspeech", speaker } }],
            });
            // 台詞の話者と感情は作者が直した形で置く（AI は呼ばない）
            const entries = EMOTION_LINES.map((line) => ({
              quote: line.quote,
              nth: 0,
              speakerId: akari.id,
              speakerName: akari.name,
              emotion: line.emotion,
              intensity: "中" as const,
            }));
            await writeCast(folders, ep.name, entries);
          },
        }
      );
    } finally {
      // 感情ごとに、頼んだスタイルの番号と名前（見つからなければ元のスタイルのまま）
      const styleName = (id: string | undefined): string => speaker.styles.find((style) => String(style.id) === id)?.name ?? "（この話者に無い番号）";
      result.perEmotion = EMOTION_LINES.map((line) => {
        const requested = [...new Set(queriesWith(aivis.log, line.key).map((entry) => entry.speaker))];
        // 平静の台詞は製品（voicePlanUnits）と同じ決まり：声の形は選んだまま、それ以外は同じ話者のノーマル
        const keepShape = !isNormalStyleName(base.name) && styleEmotionOf(base.name) === undefined;
        const expected =
          line.emotion === "平静"
            ? { styleId: keepShape ? base.id : pickNormalStyle([speaker], base.id), styled: false }
            : pickStyleForEmotion([speaker], base.id, line.emotion);
        return {
          emotion: line.emotion,
          requestedStyleIds: requested,
          requestedStyleNames: requested.map(styleName),
          expectedStyleId: expected.styleId,
          expectedStyled: expected.styled,
        };
      });
      await writeResult("感情の声", result);
      await aivis.close();
    }
    const exported = result.export as Awaited<ReturnType<typeof exportEpisode>>;
    expect(exported.dialogs, "書き出しの途中で真ん中の窓が出た").toEqual([]);
    expect(exported.files.some((file) => file.endsWith(".mp3")), `できたファイル：${JSON.stringify(exported.files)}`).toBe(true);
    for (const row of result.perEmotion as Array<{ emotion: string; requestedStyleIds: Array<string | undefined>; expectedStyleId: number }>) {
      expect(row.requestedStyleIds, `${row.emotion}の台詞が頼まれた`).not.toEqual([]);
      expect(row.requestedStyleIds, `${row.emotion}の台詞のスタイルの番号`).toEqual([String(row.expectedStyleId)]);
    }
    const summary = (result.perEmotion as Array<{ emotion: string; requestedStyleNames: string[] }>).map((row) => `${row.emotion}→${row.requestedStyleNames.join("・")}`).join("、");
    await noteListening(
      `感情の声/${stem}.mp3`,
      "123行",
      `${speaker.name}の声で、喜び・怒り・悲しみ・ささやき・叫び・（比べる元の平静）の順に台詞が6つ。感情に合って聞こえるか、調子の寄せが大げさすぎないか。切り替えたスタイル：${summary}`
    );
  },
  40 * 60_000
);

/* ───────────────────────── 人物ごとの声の調整（作者の頼み 2026-11-13） ───────────────────────── */

/**
 * 見本の文（作者の作品の本文は使わない）。同じ台詞を4人に言わせ、調整だけを変える。
 * 地の文で「何番目が何か」を読み上げるので、1つの MP3 を頭から聞けば比べられる
 */
const ADJUST_VARIANTS: Array<{ id: string; name: string; label: string; adjust?: VoiceAdjust }> = [
  { id: "char_101", name: "一郎", label: "調整なし" },
  { id: "char_102", name: "二郎", label: "老けた声", adjust: VOICE_ADJUST_PRESETS.find((preset) => preset.name === "老けた声")?.adjust },
  { id: "char_103", name: "三郎", label: "高さだけマイナス0.06", adjust: { pitch: -0.06 } },
  { id: "char_104", name: "四郎", label: "速さだけ0.85", adjust: { speed: 0.85 } },
];
const ADJUST_QUOTE = "「今日はいい天気ですね。少し歩きましょうか」";

for (const engine of ["aivisspeech", "voicevox"] as const) {
  const gate = engine === "aivisspeech" ? GATE_AIVIS : GATE_VOICEVOX;
  const engineName = engine === "aivisspeech" ? "AivisSpeech" : "VOICEVOX";
  test.skipIf(!gate)(
    `声の調整：本物の ${engineName} で、調整なし・老けた声・高さだけ −0.06・速さだけ 0.85 の4通りを1つの MP3 に書き出す（作者が耳で数字を決める材料）`,
    async () => {
      const proxy = await startRecordingProxy(engine);
      const speakers = await realSpeakers(engine);
      // ノーマルを持つ最初の話者（平静の台詞はノーマルで読むので、4人とも同じ声の形で比べられる）
      const speaker = speakers.find((s) => s.styles.some((style) => isNormalStyleName(style.name))) ?? speakers[0];
      const normalIndex = Math.max(0, speaker.styles.findIndex((style) => isNormalStyleName(style.name)));
      const people = ADJUST_VARIANTS.map((variant) => realCharacter(variant.id, variant.name));
      const text =
        ADJUST_VARIANTS.map((variant, index) => `　${index + 1}つ目は、${variant.label}。\n${ADJUST_QUOTE}と${variant.name}は言った。`).join("\n") + "\n";
      const ep = { name: "episode_0001_声の調整.md", text };
      const stem = ep.name.replace(/\.md$/, "");
      const keepAs = `${engineName}声の調整`;
      const result: Record<string, unknown> = {
        engine,
        speaker: speaker.name,
        style: speaker.styles[normalIndex]?.name,
        // 製品が頼む値（平静・中・列の速さ1）。耳で決めるときの手がかり
        params: ADJUST_VARIANTS.map((variant) => ({ label: variant.label, ...voiceParamsFor("平静", "中", false, 1, variant.adjust) })),
      };
      try {
        await withVsCode(
          `声の調整（${engineName}）`,
          [ep],
          async (session) => {
            const frame = await openRow(session, ep.name, "1つ目は", engine);
            result.export = await exportEpisode(session, frame, stem, keepAs, 30 * 60_000);
          },
          {
            settings: engineSettings(engine === "aivisspeech" ? { aivisspeech: proxy.url } : { voicevox: proxy.url }),
            prepareWork: async (folders) => {
              await writeCharacters(folders.workFolder, people);
              await writeVoices(folders.workFolder, {
                narrator: { engine, speaker, styleIndex: normalIndex },
                characters: ADJUST_VARIANTS.map((variant) => ({
                  id: variant.id,
                  name: variant.name,
                  voice: { engine, speaker, styleIndex: normalIndex, ...(variant.adjust ? { adjust: variant.adjust } : {}) },
                })),
              });
              // 台詞の話者は作者が直した形で置く（同じ字の台詞の何番目か）。AI は呼ばない
              await writeCast(
                folders,
                ep.name,
                ADJUST_VARIANTS.map((variant, index) => ({
                  quote: ADJUST_QUOTE,
                  nth: index,
                  speakerId: variant.id,
                  speakerName: variant.name,
                  emotion: "平静" as const,
                  intensity: "中" as const,
                }))
              );
            },
          }
        );
      } finally {
        await writeResult(keepAs, result);
        await proxy.close();
      }
      const exported = result.export as Awaited<ReturnType<typeof exportEpisode>>;
      expect(exported.dialogs, "書き出しの途中で真ん中の窓が出た").toEqual([]);
      expect(exported.files.some((file) => file.endsWith(".mp3")), `できたファイル：${JSON.stringify(exported.files)}`).toBe(true);
      await noteListening(
        `${keepAs}/${stem}.mp3`,
        "声の調整",
        `${speaker.name}の同じ声で、同じ台詞を4回：1つ目＝調整なし、2つ目＝老けた声（高さ −0.06・速さ 0.85・抑揚 0.8）、3つ目＝高さだけ −0.06、4つ目＝速さだけ 0.85。違いが聞き取れるか、「老けた声」らしく聞こえるか、変えすぎて不自然でないか（数字は結果.json）`
      );
    },
    40 * 60_000
  );
}

/* ───────────────────────── 104：速い PC で遅さの知らせが出ない ───────────────────────── */

test.skipIf(!GATE_FAST_PC)(
  "104：速い PC で、本物の AivisSpeech の［▶ 読む］を10文以上読んでも、遅さの知らせが出ない",
  async () => {
    const aivis = await startRecordingProxy("aivisspeech");
    const ep = sampleEpisode("episode_0001_朝の坂道.md", "朝の駅前", 20);
    const result: Record<string, unknown> = { episode: ep.name, chars: ep.text.length };
    try {
      await withVsCode(
        "速い PC で読む",
        [ep],
        async (session) => {
          const frame = await openRow(session, ep.name, "朝の駅前", "aivisspeech");
          const since = Date.now();
          await frame.locator("#aloudPlay").click();
          const read = await readUntil(session, frame, [aivis], since, 11, 10 * 60_000);
          // 知らせが遅れて記録されるのを待つ（記録は1秒まとめて書かれる）
          await new Promise((resolve) => setTimeout(resolve, 2_500));
          result.read = { ...read, seconds: Math.round((Date.now() - since) / 1000), slowNotices: await slowCount(session, since), notices: await describeNotices(session, since) };
          await stopReading(frame);
        },
        { settings: engineSettings({ aivisspeech: aivis.url }) }
      );
    } finally {
      await writeResult("速いPCの読み上げ", result);
      await aivis.close();
    }
    const read = result.read as { dialogs: string[]; done: number; slowNotices: number };
    expect(read.dialogs, "真ん中の窓が出た").toEqual([]);
    expect(read.done, "合成できた文の数").toBeGreaterThanOrEqual(10);
    expect(read.slowNotices, "遅さの知らせの数").toBe(0);
  },
  20 * 60_000
);

