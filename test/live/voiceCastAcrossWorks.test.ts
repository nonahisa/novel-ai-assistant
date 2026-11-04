import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildReadingPlan, voiceDialogueSpans } from "../../src/core/readAloud";
import { quotedSpans } from "../../src/core/quotedSpans";
import {
  castChunksOf,
  castDialogues,
  countDropReasons,
  parseCastResult,
  validateCastItems,
  type CastPerson,
} from "../../src/core/voiceCast";
import {
  VOICE_CAST_CHUNK_CHARS,
  VOICE_CAST_SYSTEM_PROMPT,
  VOICE_CAST_VERSION,
  buildVoiceCastPrompt,
  buildVoiceCastSchema,
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

const GOLD_FILES = (process.env.VC_GOLD ?? "").split(";").map((s) => s.trim()).filter(Boolean);
const MODELS = (process.env.VC_MODELS ?? "gemma4:e4b").split(";").map((s) => s.trim()).filter(Boolean);

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
            const gold = loadGold(goldPath);
            const text = readUtf8(path.join(ROOT!, gold.work, gold.episode));
            const dialogues = castDialogues(text);
            const chunks = castChunksOf(text, VOICE_CAST_CHUNK_CHARS);
            // 正解は台詞の頭の字が揃っているものだけ。ずれていたら止める（比べる意味が無い）
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
            const byIndex = new Map(dialogues.map((d, i) => [d.index, gold.gold[i]]));
            const idOfName = new Map<string, string>();
            for (const p of gold.people) {
              for (const n of [p.name, ...p.aliases]) idOfName.set(n, p.id);
            }
            const t0 = Date.now();
            let hit = 0;
            let missed = 0;
            let wrong = 0;
            let unanswered = 0;
            let goldUnknownRight = 0;
            let goldUnknownWrong = 0;
            let emoHit = 0;
            let emoTotal = 0;
            const dropAll: Array<{ reason: string; item: unknown }> = [];
            const detail: string[] = [];
            const wrongExamples: string[] = [];
            const missedExamples: string[] = [];
            let failedChunks = 0;
            let ps: Array<{ name: string; size: number; size_vram: number; context_length?: number }> = [];
            for (const chunk of chunks) {
              const people = gold.people;
              const userPrompt = buildVoiceCastPrompt({
                text: chunk.text,
                count: chunk.dialogues.length,
                people: peopleForChunk(chunk, people),
              });
              const body = {
                model,
                stream: false,
                think: false,
                format: buildVoiceCastSchema(peopleForChunk(chunk, people)),
                options: {
                  temperature: 0,
                  // 製品の Ollama プロバイダと同じ式。出力の見込みは既定の 8,192
                  num_ctx: contextSizeForPrompt({
                    promptChars: VOICE_CAST_SYSTEM_PROMPT.length + userPrompt.length,
                    outputTokens: 8192,
                    contextWindow: 131072,
                  }),
                },
                messages: [
                  { role: "system", content: VOICE_CAST_SYSTEM_PROMPT },
                  { role: "user", content: userPrompt },
                ],
              };
              const res = await fetch(`${OLLAMA_ENDPOINT}/api/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
              });
              const j = (await res.json()) as { message?: { content?: string } };
              const content = decodeByteFallback(j.message?.content ?? "");
              ps = await ollamaPs();
              const items = parseCastResult(content);
              if (!items) {
                failedChunks++;
                continue;
              }
              const checked = validateCastItems(items, chunk.dialogues.length, peopleForChunk(chunk, people));
              dropAll.push(...checked.dropped);
              chunk.dialogues.forEach((d, k) => {
                const g = byIndex.get(d.index)!;
                const guess = checked.guesses.get(k + 1);
                if (!guess) {
                  unanswered++;
                  if (g.speaker !== "不明") missedExamples.push(`${d.quote.slice(0, 20)} 正:${g.speaker} → 答え無し／捨て`);
                  return;
                }
                const goldId = g.speaker === "不明" ? null : idOfName.get(g.speaker) ?? null;
                detail.push(
                  `${d.index}\t${d.quote.slice(0, 14)}\t正:${g.speaker}/${g.emotion}\t答:${
                    guess.speakerId === null ? "不明" : gold.people.find((p) => p.id === guess.speakerId)?.name
                  }/${guess.emotion}/${guess.intensity}`
                );
                emoTotal++;
                if (guess.emotion === g.emotion) emoHit++;
                if (goldId === null) {
                  if (guess.speakerId === null) goldUnknownRight++;
                  else goldUnknownWrong++;
                  return;
                }
                if (guess.speakerId === goldId) hit++;
                else if (guess.speakerId === null) {
                  missed++;
                  if (missedExamples.length < 6) missedExamples.push(`${d.quote.slice(0, 20)} 正:${g.speaker} → 不明`);
                } else {
                  wrong++;
                  const gotName = gold.people.find((p) => p.id === guess.speakerId)?.name;
                  if (wrongExamples.length < 8) wrongExamples.push(`${d.quote.slice(0, 20)} 正:${g.speaker} → ${gotName}`);
                }
              });
            }
            const sec = Math.round((Date.now() - t0) / 1000);
            const goldKnown = gold.gold.filter((g) => g.speaker !== "不明").length;
            report.push(
              "",
              `## ${model} × ${gold.work}/${gold.episode}`,
              `- 台詞 ${dialogues.length}（正解が人物 ${goldKnown}／不明 ${dialogues.length - goldKnown}）・区切り ${chunks.length}（失敗 ${failedChunks}）`,
              `- 当たり ${hit}／見逃し(不明に倒れた) ${missed}／取り違え ${wrong}／答え無し・検算で捨て ${unanswered}`,
              `- 正解が不明の台詞：不明のまま ${goldUnknownRight}／人物に当てた ${goldUnknownWrong}`,
              `- 感情一致 ${emoHit}/${emoTotal}（参考）`,
              `- 捨てた理由：${JSON.stringify(countDropReasons(dropAll))}`,
              `- 時間 ${sec}秒（版 ${VOICE_CAST_VERSION}）`,
              `- ps: ${JSON.stringify(ps.map((m) => ({ name: m.name, size: m.size, size_vram: m.size_vram, ctx: m.context_length })))}`,
              `- 取り違え例：${JSON.stringify(wrongExamples)}`,
              `- 見逃し例：${JSON.stringify(missedExamples)}`
            );
            fs.mkdirSync(OUT!, { recursive: true });
            fs.writeFileSync(path.join(OUT!, "cast-report.md"), report.join("\n"), "utf-8");
            fs.writeFileSync(
              path.join(OUT!, `cast-detail-${model.replace(/[:/]/g, "_")}-${path.basename(goldPath).length}.tsv`),
              detail.join("\n"),
              "utf-8"
            );
            report.push(`- 詳細：cast-detail-${model.replace(/[:/]/g, "_")}-${path.basename(goldPath).length}.tsv`);
            fs.writeFileSync(path.join(OUT!, "cast-report.md"), report.join("\n"), "utf-8");
          }
        }
        expect(true).toBe(true);
      },
      6 * 60 * 60 * 1000
    );
  }
);
