import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildReadingPlan, voiceDialogueSpans } from "../../src/core/readAloud";
import { quotedSpans } from "../../src/core/quotedSpans";
import {
  castChunkSpeakerSequence,
  castChunksOf,
  castDialogues,
  castFlowNames,
  castGuessesForChunk,
  castGuessesForStages,
  castSpeakersFromText,
  countDropReasons,
  parseCastResult,
  validateCastSpeakers,
  type CastChunk,
  type CastDrop,
  type CastGuess,
  type CastPerson,
} from "../../src/core/voiceCast";
import {
  VOICE_CAST_CHUNK_CHARS,
  VOICE_CAST_CONTEXT_AFTER_CHARS,
  VOICE_CAST_CONTEXT_BEFORE_CHARS,
  VOICE_CAST_FLOW_ENABLED,
  VOICE_CAST_FLOW_MAX,
  VOICE_CAST_SYSTEM_PROMPT,
  VOICE_CAST_VERSION,
  buildVoiceCastPrompt,
  buildVoiceCastSchema,
  voiceCastStageRequests,
} from "../../src/prompts/voiceCast";
import { decodeByteFallback } from "../../src/core/byteFallback";
import { contextSizeForPrompt } from "../../src/core/chunker";
import { peopleForChunk } from "../../src/features/voiceReading";
import { OLLAMA_ENDPOINT } from "./support/liveEnv";

/**
 * 人物の声で朗読する（設計書6.42.3・P-54）を、声のエンジン抜きで測る。
 *
 *   段1 VC_PHASE=extract : 全作品の全話で台詞の取り出しを数え、おかしな形を拾う
 *   段2 VC_PHASE=cast    : 手元の Ollama で話者と感情を推定し、正解（担当の判断）と比べる
 *   段4 VC_PHASE=rules   : AIを呼ばず、本文に書いてある話者をコードで決めた分だけを正解と比べる（案 A。版1.2）
 *
 *   段2は、製品と同じく本文に書いてある話者をコードで先に決め、その番号の話者はAIに訊かない。
 *   VC_RULES=off にすると、コードで決めずに全部AIに訊く（比べの基準）。
 *
 *   段2の訊き方は VC_STAGES で切り替える（同じ正解・同じ台本で比べる）：
 *     two     … 製品と同じ2段（版1.3。1段目で話者だけ、2段目で感情と強さだけ）。既定
 *     one     … 1回で全部を訊く（版1.2 の頼み方。案 A までの製品と同じ）
 *     speaker … 2段の1段目だけ（話者だけを測る。感情の段を撃たないぶん早い）
 *   two では「1段目だけの話者の当たり」と「2段で通した当たり」を並べて出す。
 *
 *   1段目に前の区切りの話者の流れを添えるか（案 C。版1.4）は VC_FLOW で切り替える：
 *     on  … 直前の区切りまでに決まった話者（コードで決めたもの＋1段目の答えの
 *           検算を通ったもの）の名前を、直前の VOICE_CAST_FLOW_MAX 件まで添える
 *           （製品の印 VOICE_CAST_FLOW_ENABLED を上書きして添える）
 *     off … 流れを添えない（版1.3 と同じ頼み）。同じ VC_STAGES・同じ正解で比べる
 *   既定は製品の印に合わせる（0.142.2 からは off。2026-11-08 の測定で取り違えが増えたため）。
 *   VC_STAGES=one では使わない。報告は cast-report-<VC_STAGES>-flow<on|off>.md に分けて書く。
 *
 *   $env:VC_PHASE = "cast"; $env:VC_STAGES = "two"
 *   $env:VC_GOLD = "正解1.json;正解2.json"; $env:VC_MODELS = "gemma4:e4b;gemma4:26b"
 *
 *   $env:NOVELAI_WORKS = "C:/path/to/作品を集めたフォルダー"
 *   $env:VC_OUT = "出力先フォルダー（原稿の外）"
 *   $env:VC_PHASE = "extract"
 *   npx vitest run --config vitest.live.config.mts test/live/voiceCastAcrossWorks.test.ts
 *
 * 作品の場所はソースに書かない。**原稿は読むだけ**で、書き込みは VC_OUT の下だけ。
 * 製品のコード（取り出し・プロンプト・スキーマ・検算）をそのまま通す。
 */
const ROOT = process.env.NOVELAI_WORKS?.trim();
const OUT = process.env.VC_OUT?.trim();
const PHASE = process.env.VC_PHASE?.trim();

function readUtf8(file: string): string {
  const raw = fs.readFileSync(file);
  return new TextDecoder("utf-8").decode(raw).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

interface WorkFiles {
  name: string;
  files: string[];
}

function worksIn(root: string): WorkFiles[] {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "backups")
    .map((e) => {
      // 作品の下のフォルダーも1段ずつたどる（入れ子の置き場に原稿がある作品がある）
      const files: string[] = [];
      const walk = (dir: string, depth: number): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            if (depth < 2 && !entry.name.startsWith(".") && entry.name !== "backups") {
              walk(path.join(dir, entry.name), depth + 1);
            }
          } else if (
            entry.name.endsWith(".txt") &&
            !/^about/i.test(entry.name) &&
            !/plot/i.test(entry.name)
          ) {
            files.push(path.join(dir, entry.name));
          }
        }
      };
      walk(path.join(root, e.name), 0);
      files.sort((a, b) => a.localeCompare(b, "ja", { numeric: true }));
      return { name: e.name, files };
    })
    .filter((w) => w.files.length > 0);
}

const excerpt = (s: string, n = 20): string => s.replace(/\n/g, "⏎").slice(0, n);

interface Example {
  file: string;
  text: string;
}

describe.skipIf(PHASE !== "extract" || !ROOT || !OUT)("台詞の取り出し（全作品）", () => {
  test("全話を数える", () => {
    const categories = [
      "nested", // 台詞の中に「か『がもう一つ入る（『』入りの台詞は正常。重なり括弧はoneChar側）
      "curlyOpenQuote", // 行頭の『で台詞に数えた
      "midLineDouble", // 行頭でない『』（地の文として台詞から除かれたもの）
      "oneChar", // 括弧1字だけの台詞（「「はぁい」」の重なりの片割れ）
      "unclosedLong", // 2字以上で閉じ括弧が無い（段落ごとに開く昔の書き方）
      "multiLine", // 改行をまたぐ台詞
      "veryLong", // 200字超
      "wordQuote", // 地の文の中の語の括弧（括弧込み3〜4字、前に地の文が続く）
      "headWordQuote", // 行頭（字下げ後）の『短い語』（地の文の書名・呼び名の疑い）
      "noSentence", // 台詞なのに計画の文に載らなかった
    ] as const;
    type Cat = (typeof categories)[number];
    const rows: string[] = [];
    const examples: Record<Cat, Example[]> = Object.fromEntries(
      categories.map((c) => [c, [] as Example[]])
    ) as Record<Cat, Example[]>;
    const totals = new Map<string, Record<string, number>>();
    const zeroEpisodes: string[] = [];

    const add = (work: string, cat: Cat | "files" | "chars" | "dialogues" | "narrationSentences" | "dialogueSentences", n = 1): void => {
      const row = totals.get(work) ?? {};
      row[cat] = (row[cat] ?? 0) + n;
      totals.set(work, row);
    };
    const note = (cat: Cat, work: string, file: string, text: string): void => {
      add(work, cat);
      const list = examples[cat];
      if (list.filter((e) => e.file.startsWith(work)).length < 2) {
        list.push({ file: `${work}/${path.basename(file)}`, text: excerpt(text) });
      }
    };

    for (const work of worksIn(ROOT!)) {
      for (const file of work.files) {
        const text = readUtf8(file);
        const notation = "site" as const;
        const all = quotedSpans(text, { unclosedToEnd: false });
        const voice = voiceDialogueSpans(text);
        const dialogues = castDialogues(text);
        const plan = buildReadingPlan(text, notation, [], { splitDialogue: true });
        add(work.name, "files");
        add(work.name, "chars", text.length);
        add(work.name, "dialogues", dialogues.length);
        add(work.name, "narrationSentences", plan.filter((s) => s.kind === "narration").length);
        add(work.name, "dialogueSentences", plan.filter((s) => s.kind === "dialogue").length);
        if (dialogues.length === 0 && text.length > 500) {
          zeroEpisodes.push(`${work.name}/${path.basename(file)}（${text.length}字）`);
        }

        const voiceStarts = new Set(voice.map((s) => s.start));
        for (const span of all) {
          if (!voiceStarts.has(span.start)) {
            note("midLineDouble", work.name, file, text.slice(span.start, span.end));
          }
        }
        const planned = new Set(plan.filter((s) => s.dialogue !== undefined).map((s) => s.dialogue));
        for (const d of dialogues) {
          const inner = d.quote.slice(1);
          if (d.quote[0] === "『") note("curlyOpenQuote", work.name, file, d.quote);
          if (/[「『]/.test(inner)) note("nested", work.name, file, d.quote);
          const last = d.quote[d.quote.length - 1];
          const lineHead = text.lastIndexOf("\n", d.start - 1) + 1;
          const before = text.slice(lineHead, d.start);
          const ctx = `${before.slice(-4)}【${d.quote.slice(0, 10)}】`;
          if (d.quote.length === 1) note("oneChar", work.name, file, ctx);
          else if (last !== "」" && last !== "』") note("unclosedLong", work.name, file, d.quote);
          if (d.quote.includes("\n")) note("multiLine", work.name, file, d.quote);
          if (d.quote.length > 200) note("veryLong", work.name, file, d.quote);
          if (d.quote.length >= 3 && d.quote.length <= 4) {
            if (/[^\s　「『]/.test(before) && !/[」』]\s*$/.test(before)) {
              note("wordQuote", work.name, file, ctx);
            } else if (d.quote[0] === "『") {
              note("headWordQuote", work.name, file, ctx);
            }
          }
          if (!planned.has(d.index)) note("noSentence", work.name, file, d.quote);
        }
      }
    }

    rows.push("# 台詞の取り出し（全作品）");
    rows.push("");
    rows.push(
      "作品 | 話数 | 字数 | 台詞 | 台詞の文 | 地の文の文 | " + categories.join(" | ")
    );
    for (const [work, row] of totals) {
      rows.push(
        [
          work,
          row.files ?? 0,
          row.chars ?? 0,
          row.dialogues ?? 0,
          row.dialogueSentences ?? 0,
          row.narrationSentences ?? 0,
          ...categories.map((c) => row[c] ?? 0),
        ].join(" | ")
      );
    }
    rows.push("");
    rows.push("## 台詞が0の話（500字超）");
    rows.push(...zeroEpisodes.map((z) => `- ${z}`));
    rows.push("");
    for (const c of categories) {
      rows.push(`## 実例：${c}`);
      for (const e of examples[c]) rows.push(`- ${e.file} :: ${e.text}`);
      rows.push("");
    }
    fs.mkdirSync(OUT!, { recursive: true });
    fs.writeFileSync(path.join(OUT!, "extract-report.md"), rows.join("\n"), "utf-8");
    expect(true).toBe(true);
  });
});

/* ───────── 段2 ───────── */

interface GoldFile {
  note: string;
  work: string;
  episode: string;
  people: CastPerson[];
  /** 本文の台詞の並び順。speaker は人物の name か「不明」 */
  gold: Array<{ head: string; speaker: string; emotion: string }>;
}

function loadGold(file: string): GoldFile {
  return JSON.parse(fs.readFileSync(file, "utf-8")) as GoldFile;
}

async function ollamaPs(): Promise<Array<{ name: string; size: number; size_vram: number; context_length?: number }>> {
  const r = await fetch(`${OLLAMA_ENDPOINT}/api/ps`);
  const j = (await r.json()) as { models?: Array<{ name: string; size: number; size_vram: number; context_length?: number }> };
  return j.models ?? [];
}

async function unloadOthers(keep: string): Promise<void> {
  for (const m of await ollamaPs()) {
    if (m.name === keep) continue;
    await fetch(`${OLLAMA_ENDPOINT}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: m.name, keep_alive: 0 }),
    });
  }
}

/*
  段3 VC_PHASE=regold：台詞の取り出しの規則を変えたとき、正解を新しい台詞の並びへ合わせ直す。
  古い規則のコードで VC_REGOLD_SIDE=old を1回回して台詞の位置を控え、新しい規則のコードで
  回すと、位置が残った台詞の正解だけを写した新しい正解を VC_OUT に書く（外れた台詞は正解からも外れる）。
*/
describe.skipIf(PHASE !== "regold" || !ROOT || !OUT || (process.env.VC_GOLD ?? "") === "")(
  "正解を台詞の並びに合わせ直す",
  () => {
    test("位置で突き合わせる", () => {
      fs.mkdirSync(OUT!, { recursive: true });
      for (const goldPath of (process.env.VC_GOLD ?? "").split(";").map((s) => s.trim()).filter(Boolean)) {
        const gold = JSON.parse(fs.readFileSync(goldPath, "utf-8")) as GoldFile;
        const text = readUtf8(path.join(ROOT!, gold.work, gold.episode));
        const dialogues = castDialogues(text);
        const dumpFile = path.join(OUT!, `old-starts-${path.basename(goldPath).length}.json`);
        if (process.env.VC_REGOLD_SIDE === "old") {
          if (gold.gold.length !== dialogues.length) {
            throw new Error(`古い規則の台詞数 ${dialogues.length} が正解の ${gold.gold.length} と合いません`);
          }
          fs.writeFileSync(dumpFile, JSON.stringify(dialogues.map((d) => d.start)), "utf-8");
          continue;
        }
        const oldStarts = JSON.parse(fs.readFileSync(dumpFile, "utf-8")) as number[];
        const indexOfStart = new Map(oldStarts.map((s, i) => [s, i]));
        const kept = dialogues.map((d) => {
          const i = indexOfStart.get(d.start);
          if (i === undefined) throw new Error(`新しい台詞が古い規則に無い: ${d.quote.slice(0, 20)}`);
          return gold.gold[i];
        });
        const dropped = gold.gold.length - kept.length;
        const out = {
          ...gold,
          note: `${gold.note}（行頭の括弧だけを台詞にする規則に合わせ直し。外した台詞 ${dropped} 件）`,
          gold: kept,
        };
        const outFile = path.join(OUT!, path.basename(goldPath).replace(/\.json$/, "-新.json"));
        fs.writeFileSync(outFile, JSON.stringify(out, null, 2), "utf-8");
        fs.appendFileSync(path.join(OUT!, "regold-report.md"), `${gold.work}/${gold.episode}: ${gold.gold.length} -> ${kept.length}\n`, "utf-8");
      }
      expect(true).toBe(true);
    });
  }
);

const GOLD_FILES = (process.env.VC_GOLD ?? "").split(";").map((s) => s.trim()).filter(Boolean);
const MODELS = (process.env.VC_MODELS ?? "gemma4:e4b").split(";").map((s) => s.trim()).filter(Boolean);
const RULES_ON = (process.env.VC_RULES ?? "").trim().toLowerCase() !== "off";
/** 訊き方（one＝1回で全部・two＝製品と同じ2段・speaker＝2段の1段目だけ） */
const STAGES = (process.env.VC_STAGES ?? "two").trim().toLowerCase();
if (PHASE === "cast" && !["one", "two", "speaker"].includes(STAGES)) {
  throw new Error(`VC_STAGES は one・two・speaker のどれかにしてください（${STAGES}）`);
}
/** 1段目に前の区切りの話者の流れを添えるか（案 C。版1.4。既定は製品の印と同じ） */
const FLOW = (process.env.VC_FLOW ?? (VOICE_CAST_FLOW_ENABLED ? "on" : "off")).trim().toLowerCase();
if (PHASE === "cast" && !["on", "off"].includes(FLOW)) {
  throw new Error(`VC_FLOW は on・off のどちらかにしてください（${FLOW}）`);
}
const FLOW_ON = FLOW === "on" && STAGES !== "one";

/** 話者の採点（見逃しと取り違えを分けて数える） */
interface SpeakerScore {
  hit: number;
  /** 正解が人物なのに「不明」に倒れた */
  missed: number;
  /** 正解と別の人物に当てた */
  wrong: number;
  /** 答えが無い・検算で捨てた（正解が人物かどうかを問わない） */
  unanswered: number;
  /** 正解が不明（役名だけの人物など）の台詞：不明のまま／人物に当てた */
  goldUnknownRight: number;
  goldUnknownWrong: number;
  wrongExamples: string[];
  missedExamples: string[];
}

function newScore(): SpeakerScore {
  return {
    hit: 0,
    missed: 0,
    wrong: 0,
    unanswered: 0,
    goldUnknownRight: 0,
    goldUnknownWrong: 0,
    wrongExamples: [],
    missedExamples: [],
  };
}

/** 1つの台詞の話者を採点する（`guessed` は人物の id・null＝不明・undefined＝答え無し） */
function scoreSpeaker(
  score: SpeakerScore,
  quote: string,
  gold: { speaker: string },
  goldId: string | null,
  guessed: string | null | undefined,
  nameOf: (id: string) => string | undefined
): void {
  if (guessed === undefined) {
    score.unanswered++;
    if (gold.speaker !== "不明" && score.missedExamples.length < 8) {
      score.missedExamples.push(`${quote.slice(0, 20)} 正:${gold.speaker} → 答え無し／捨て`);
    }
    return;
  }
  if (goldId === null) {
    if (guessed === null) score.goldUnknownRight++;
    else score.goldUnknownWrong++;
    return;
  }
  if (guessed === goldId) score.hit++;
  else if (guessed === null) {
    score.missed++;
    if (score.missedExamples.length < 8) score.missedExamples.push(`${quote.slice(0, 20)} 正:${gold.speaker} → 不明`);
  } else {
    score.wrong++;
    if (score.wrongExamples.length < 8) {
      score.wrongExamples.push(`${quote.slice(0, 20)} 正:${gold.speaker} → ${nameOf(guessed)}`);
    }
  }
}

function scoreLines(label: string, score: SpeakerScore): string[] {
  return [
    `- ${label}：当たり ${score.hit}／見逃し(不明に倒れた) ${score.missed}／取り違え ${score.wrong}／答え無し・検算で捨て ${score.unanswered}`,
    `  - 正解が不明の台詞：不明のまま ${score.goldUnknownRight}／人物に当てた ${score.goldUnknownWrong}`,
    `  - 取り違え例：${JSON.stringify(score.wrongExamples)}`,
    `  - 見逃し例：${JSON.stringify(score.missedExamples)}`,
  ];
}

/** 製品の Ollama プロバイダと同じ形で1回撃つ（num_ctx を明示・format にスキーマ・think:false） */
async function chatOnce(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  schema: object
): Promise<{ content: string; doneReason?: string }> {
  const body = {
    model,
    stream: false,
    think: false,
    format: schema,
    options: {
      temperature: 0,
      // 製品の Ollama プロバイダと同じ式。出力の見込みは既定の 8,192
      num_ctx: contextSizeForPrompt({
        promptChars: systemPrompt.length + userPrompt.length,
        outputTokens: 8192,
        contextWindow: 131072,
      }),
    },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  };
  const res = await fetch(`${OLLAMA_ENDPOINT}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await res.json()) as { message?: { content?: string }; done_reason?: string };
  return { content: decodeByteFallback(j.message?.content ?? ""), doneReason: j.done_reason };
}

/** 正解を読み、本文の台詞の並びと揃っているか確かめる（揃っていなければ比べる意味が無いので止める） */
function goldAndText(goldPath: string) {
  const gold = loadGold(goldPath);
  const text = readUtf8(path.join(ROOT!, gold.work, gold.episode));
  const dialogues = castDialogues(text);
  if (gold.gold.length !== dialogues.length) {
    throw new Error(
      `正解の台詞数 ${gold.gold.length} と取り出しの ${dialogues.length} が合いません: ${gold.work}/${gold.episode}`
    );
  }
  gold.gold.forEach((g, i) => {
    if (!dialogues[i].quote.startsWith(g.head)) {
      throw new Error(`台詞 ${i} の頭が正解と違います: ${g.head} / ${dialogues[i].quote}`);
    }
  });
  const idOfName = new Map<string, string>();
  for (const p of gold.people) {
    for (const n of [p.name, ...p.aliases]) idOfName.set(n, p.id);
  }
  const goldIdOf = (i: number): string | null => {
    const g = gold.gold[i];
    return g.speaker === "不明" ? null : idOfName.get(g.speaker) ?? null;
  };
  return { gold, text, dialogues, goldIdOf };
}

/* 段4：コードで決めた話者だけを採点する（AIを呼ばない。取り違えが0でなければ案 A は失格） */
describe.skipIf(PHASE !== "rules" || !ROOT || !OUT || GOLD_FILES.length === 0)(
  "本文に書いてある話者（コードで決めた分）",
  () => {
    test("正解と比べる", () => {
      const report: string[] = ["# 本文に書いてある話者（コードで決めた分）"];
      for (const goldPath of GOLD_FILES) {
        const { gold, text, dialogues, goldIdOf } = goldAndText(goldPath);
        const decided = castSpeakersFromText(text, gold.people);
        let hit = 0;
        let wrong = 0;
        let goldUnknown = 0;
        const wrongExamples: string[] = [];
        dialogues.forEach((d, i) => {
          const id = decided.get(d.index);
          if (id === undefined) return;
          const goldId = goldIdOf(i);
          const name = gold.people.find((p) => p.id === id)?.name;
          if (goldId === null) {
            goldUnknown++;
            wrongExamples.push(`${d.quote.slice(0, 20)} 正:不明 → ${name}`);
          } else if (goldId === id) {
            hit++;
          } else {
            wrong++;
            wrongExamples.push(`${d.quote.slice(0, 20)} 正:${gold.gold[i].speaker} → ${name}`);
          }
        });
        const goldKnown = gold.gold.filter((g) => g.speaker !== "不明").length;
        report.push(
          "",
          `## ${gold.work}/${gold.episode}`,
          `- 台詞 ${dialogues.length}（正解が人物 ${goldKnown}）・コードで決めた ${decided.size}`,
          `- 当たり ${hit}／取り違え ${wrong}／正解が不明なのに当てた ${goldUnknown}`,
          `- 取り違え例：${JSON.stringify(wrongExamples)}`
        );
      }
      fs.mkdirSync(OUT!, { recursive: true });
      fs.writeFileSync(path.join(OUT!, "rules-report.md"), report.join("\n"), "utf-8");
      expect(true).toBe(true);
    });
  }
);

describe.skipIf(PHASE !== "cast" || !ROOT || !OUT || GOLD_FILES.length === 0)(
  "話者と気持ちの推定（手元の Ollama）",
  () => {
    test(
      "正解と比べる",
      async () => {
        const report: string[] = ["# 話者と気持ちの推定"];
        for (const model of MODELS) {
          await unloadOthers(model);
          for (const goldPath of GOLD_FILES) {
            const { gold, text, dialogues, goldIdOf } = goldAndText(goldPath);
            // 製品（features/voiceReading.ts の runVoiceCast）と同じ順：人物の一覧で話者を
            // 先に決めてから区切る。2段のときは製品と同じく、前後の本文を1段目へ添える
            const chunks: CastChunk[] = castChunksOf(
              text,
              VOICE_CAST_CHUNK_CHARS,
              RULES_ON ? castSpeakersFromText(text, gold.people) : undefined,
              STAGES === "one"
                ? undefined
                : { before: VOICE_CAST_CONTEXT_BEFORE_CHARS, after: VOICE_CAST_CONTEXT_AFTER_CHARS }
            );
            const byIndex = new Map(dialogues.map((d, i) => [d.index, gold.gold[i]]));
            const goldIdByIndex = new Map(dialogues.map((d, i) => [d.index, goldIdOf(i)]));
            const nameOf = (id: string): string | undefined => gold.people.find((p) => p.id === id)?.name;
            const tag = `${model.replace(/[:/]/g, "_")}-${STAGES}-flow${FLOW_ON ? "on" : "off"}-${path.basename(goldPath).length}`;
            /** これまでの区切りで決まった話者（話の順。製品の runVoiceCast と同じ組み方。正解の作者の行は無い） */
            const history: Array<string | null> = [];
            const personName = new Map(gold.people.map((p) => [p.id, p.name]));
            let byCode = 0;
            let byCodeHit = 0;
            let byCodeWrong = 0;
            let byCodeGoldUnknown = 0;
            let disagreed = 0;
            let calmFilled = 0;
            let calls = 0;
            let skippedSpeakerStage = 0;
            const t0 = Date.now();
            /** 1段目だけの話者（コードで決めた分＋1段目の答え）。two・speaker のとき */
            const stage1 = newScore();
            /** 最後に保存される形の話者（one は1回の答え、two は2段を混ぜた答え） */
            const final = newScore();
            let emoHit = 0;
            let emoTotal = 0;
            const dropOne: CastDrop[] = [];
            const dropSpeaker: CastDrop[] = [];
            const dropEmotion: CastDrop[] = [];
            const detail: string[] = [];
            const failed = { one: 0, speaker: 0, emotion: 0 };
            let ps: Array<{ name: string; size: number; size_vram: number; context_length?: number }> = [];

            /** 撃って読む。読めなければ本文を残して undefined（何が返ったかを後で見る） */
            const ask = async (
              stage: keyof typeof failed,
              systemPrompt: string,
              userPrompt: string,
              schema: object
            ): Promise<unknown[] | undefined> => {
              calls++;
              const { content, doneReason } = await chatOnce(model, systemPrompt, userPrompt, schema);
              ps = await ollamaPs();
              const items = parseCastResult(content);
              if (!items) {
                failed[stage]++;
                fs.mkdirSync(OUT!, { recursive: true });
                fs.writeFileSync(
                  path.join(OUT!, `fail-${tag}-${stage}-${failed[stage]}.json`),
                  JSON.stringify({ done_reason: doneReason, content }, null, 2),
                  "utf-8"
                );
              }
              return items;
            };

            for (const chunk of chunks) {
              const chunkPeople = peopleForChunk(chunk, gold.people);
              for (const [number, id] of chunk.decided) {
                const goldId = goldIdByIndex.get(chunk.dialogues[number - 1].index) ?? null;
                byCode++;
                if (goldId === null) byCodeGoldUnknown++;
                else if (goldId === id) byCodeHit++;
                else byCodeWrong++;
              }

              let guesses: Map<number, CastGuess> | undefined;
              if (STAGES === "one") {
                const items = await ask(
                  "one",
                  VOICE_CAST_SYSTEM_PROMPT,
                  buildVoiceCastPrompt({
                    text: chunk.text,
                    count: chunk.dialogues.length,
                    people: chunkPeople,
                    decided: [...chunk.decided.keys()],
                  }),
                  buildVoiceCastSchema(chunkPeople)
                );
                if (!items) continue;
                const checked = castGuessesForChunk(items, chunk, chunkPeople);
                dropOne.push(...checked.dropped);
                disagreed += checked.disagreed;
                calmFilled += checked.calmFilled;
                guesses = checked.guesses;
              } else {
                // 製品と同じ頼み（voiceCastStageRequests）。全部コードで決まった区切りは1段目を撃たない
                // 案 C：前の区切りまでの話者の流れを添える（VC_FLOW=off では添えない＝版1.3 と同じ頼み）
                const requests = voiceCastStageRequests(
                  chunk,
                  chunkPeople,
                  FLOW_ON ? { flow: castFlowNames(history, personName, VOICE_CAST_FLOW_MAX) } : undefined
                );
                let speakerItems: unknown[] | undefined;
                if (requests.speaker) {
                  speakerItems = await ask(
                    "speaker",
                    requests.speaker.systemPrompt,
                    requests.speaker.userPrompt,
                    requests.speaker.jsonSchema
                  );
                  if (!speakerItems) {
                    // 読めなかった区切りは、流れでは決まらなかった（不明）として続ける
                    history.push(...castChunkSpeakerSequence(chunk, undefined));
                    continue;
                  }
                } else {
                  skippedSpeakerStage++;
                }
                const speakerCheck = speakerItems
                  ? validateCastSpeakers(speakerItems, chunk.dialogues.length, chunkPeople, chunk.decided)
                  : { speakers: new Map<number, string | null>(), dropped: [] };
                dropSpeaker.push(...speakerCheck.dropped);
                history.push(...castChunkSpeakerSequence(chunk, speakerCheck.speakers));
                chunk.dialogues.forEach((d, k) => {
                  const guessed = chunk.decided.get(k + 1) ?? speakerCheck.speakers.get(k + 1);
                  scoreSpeaker(stage1, d.quote, byIndex.get(d.index)!, goldIdByIndex.get(d.index) ?? null, guessed, nameOf);
                });
                if (STAGES === "speaker") continue;
                const emotionItems = await ask(
                  "emotion",
                  requests.emotion.systemPrompt,
                  requests.emotion.userPrompt,
                  requests.emotion.jsonSchema
                );
                if (!emotionItems) continue;
                const checked = castGuessesForStages({ speakerItems, emotionItems }, chunk, chunkPeople);
                dropEmotion.push(...checked.droppedEmotion);
                calmFilled += checked.calmFilled;
                guesses = checked.guesses;
              }

              chunk.dialogues.forEach((d, k) => {
                const g = byIndex.get(d.index)!;
                const guess = guesses!.get(k + 1);
                scoreSpeaker(final, d.quote, g, goldIdByIndex.get(d.index) ?? null, guess?.speakerId, nameOf);
                if (!guess) return;
                detail.push(
                  `${d.index}\t${d.quote.slice(0, 14)}\t正:${g.speaker}/${g.emotion}\t答:${
                    guess.speakerId === null ? "不明" : nameOf(guess.speakerId)
                  }/${guess.emotion}/${guess.intensity}`
                );
                emoTotal++;
                if (guess.emotion === g.emotion) emoHit++;
              });
            }
            const sec = Math.round((Date.now() - t0) / 1000);
            const goldKnown = gold.gold.filter((g) => g.speaker !== "不明").length;
            const how =
              STAGES === "one"
                ? "1回で全部を訊く（版1.2 の頼み方）"
                : STAGES === "two"
                  ? `2段（版 ${VOICE_CAST_VERSION}）`
                  : `2段の1段目だけ（版 ${VOICE_CAST_VERSION}）`;
            report.push(
              "",
              `## ${model} × ${gold.work}/${gold.episode} × VC_STAGES=${STAGES}${STAGES === "one" ? "" : ` × VC_FLOW=${FLOW_ON ? "on" : "off"}`}`,
              `- 訊き方：${how}・${RULES_ON ? "本文に書いてある話者をコードで決める" : "VC_RULES=off"}`,
              `- 台詞 ${dialogues.length}（正解が人物 ${goldKnown}／不明 ${dialogues.length - goldKnown}）・区切り ${chunks.length}` +
                `・AIを呼んだ回数 ${calls}（1段目を呼ばなかった区切り ${skippedSpeakerStage}）` +
                `・読めなかった答え ${JSON.stringify(failed)}`,
              ...(STAGES === "one" ? [] : scoreLines("1段目だけの話者", stage1)),
              ...(STAGES === "speaker" ? [] : scoreLines(STAGES === "two" ? "2段で通した話者" : "話者", final)),
              `- うちコードで決めた ${byCode}：当たり ${byCodeHit}／取り違え ${byCodeWrong}／正解が不明なのに当てた ${byCodeGoldUnknown}`,
              ...(STAGES === "one" ? [`- コードで決めた台詞で、AIの話者の欄が違った ${disagreed}`] : []),
              `- 感情が無く平静にした ${calmFilled}`,
              ...(STAGES === "speaker" ? [] : [`- 感情一致 ${emoHit}/${emoTotal}（参考）`]),
              STAGES === "one"
                ? `- 捨てた理由：${JSON.stringify(countDropReasons(dropOne))}`
                : `- 捨てた理由：話者の段 ${JSON.stringify(countDropReasons(dropSpeaker))}／感情の段 ${JSON.stringify(countDropReasons(dropEmotion))}`,
              `- 時間 ${sec}秒`,
              `- ps: ${JSON.stringify(ps.map((m) => ({ name: m.name, size: m.size, size_vram: m.size_vram, ctx: m.context_length })))}`
            );
            fs.mkdirSync(OUT!, { recursive: true });
            if (STAGES !== "speaker") {
              fs.writeFileSync(path.join(OUT!, `cast-detail-${tag}.tsv`), detail.join("\n"), "utf-8");
              report.push(`- 詳細：cast-detail-${tag}.tsv`);
            }
            // 訊き方ごとに別の報告にする（one と two を続けて流しても上書きし合わない）
            fs.writeFileSync(
              path.join(OUT!, `cast-report-${STAGES}${STAGES === "one" ? "" : `-flow${FLOW_ON ? "on" : "off"}`}.md`),
              report.join("\n"),
              "utf-8"
            );
          }
        }
        expect(true).toBe(true);
      },
      6 * 60 * 60 * 1000
    );
  }
);
