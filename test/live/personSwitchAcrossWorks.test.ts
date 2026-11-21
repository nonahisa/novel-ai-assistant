import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { sceneRanges } from "../../src/core/sceneBreaks";
import { maskQuoted } from "../../src/core/quotedSpans";
import { countNarrationFirstPersons } from "../../src/core/workStyleFacts";

/**
 * 人称の入れ替わり E（三人称の場面の地の文に一人称。設計書6.9.3）を、
 * **コードで数える試作**が作者の作品でどれだけ挙げるかを測る。AIは使わない。
 * **書き込みは一切しない**（報告のファイルだけ）。
 *
 *   $env:NOVELAI_WORKS = "C:/path/to/作品を集めたフォルダー"
 *   $env:NOVELAI_PERSON_BENCH = "C:/path/to/台（plant.mjs の出力）"   # 任意
 *   $env:NOVELAI_REPORT = "C:/path/to/report.md"
 *   npx vitest run --config vitest.live.config.mts test/live/personSwitchAcrossWorks.test.ts
 *
 * **試作の判定はこのファイルの中だけに置く**（製品へ入れるかは測った数を見て決める。
 * 6.9.3）。数え方の部品（場面の割り方・台詞の伏せ方・一人称の数え方）は製品のものを使う。
 */
const ROOT = process.env.NOVELAI_WORKS?.trim();
const BENCH = process.env.NOVELAI_PERSON_BENCH?.trim();
const REPORT = process.env.NOVELAI_REPORT?.trim();

/** 三人称の場面と見る：地の文の一人称が少なく、名前の主語が多い */
const MAX_SCENE_FIRST_PERSON = 3;
const MIN_NAMED_SUBJECTS = 3;
/**
 * 一人称の語＋助詞（地の文の主語の形だけを候補にする）。
 * 「自分」は入れない（三人称の地の文でも人物を指す再帰の語なので）
 */
const FIRST_PERSON_SUBJECT = /(俺|僕|私|わたし|あたし|ぼく|おれ|オレ|ボク|ワタシ|儂|わし|拙者)(は|が|も)/gu;
/** 名前の主語（片仮名2字以上か漢字1〜4字＋敬称？＋は／が） */
const NAMED_SUBJECT = /(?:^|[、。　\s」）])(?:[ァ-ヶー]{2,10}|[一-龯々]{1,4})(?:さん|くん|君|様|殿)?(?:は|が)/gu;
/** 心の声の手がかり（同じ文にあれば、地の文の一人称ではなく人物の考え） */
const INNER_CUE = /と思|とつぶや|と呟|心の中|胸の内|と考え|と念じ|内心/u;
const PAREN = /（[^）]*）|\([^)]*\)/gu;

interface Candidate {
  file: string;
  line: number;
  sentence: string;
  inner: boolean;
}

interface Tally {
  files: number;
  scenes: number;
  thirdScenes: number;
  candidates: Candidate[];
  sceneNotes: string[];
}

function decodeText(bytes: Buffer): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("shift_jis").decode(bytes);
  }
}

const SKIP_DIRS = new Set([".aiwriter", ".git", "設定", "backups", ".novelai-recovery", "node_modules", ".grimodex", ".vscode"]);

function episodeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...episodeFiles(path.join(dir, entry.name)));
    } else if (/\.(txt|md)$/i.test(entry.name) && !/^(README|CHANGELOG)/i.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/** 行の地の文（台詞と丸括弧を空白に伏せる。位置は保つ） */
function narrationOf(line: string): string {
  return maskQuoted(line, " ").replace(PAREN, (match) => " ".repeat(match.length));
}

function sentenceAt(line: string, index: number): string {
  const start = Math.max(line.lastIndexOf("。", index - 1) + 1, 0);
  const endAt = line.indexOf("。", index);
  return line.slice(start, endAt < 0 ? line.length : endAt + 1).trim();
}

function scanFile(file: string, tally: Tally, label: string): void {
  const text = decodeText(fs.readFileSync(file));
  const lines = text.split(/\r?\n/);
  tally.files++;
  for (const range of sceneRanges(lines)) {
    tally.scenes++;
    const sceneLines = lines.slice(range.start, range.end);
    const narration = sceneLines.map(narrationOf).join("\n");
    let firstPerson = 0;
    for (const hits of countNarrationFirstPersons(narration).values()) firstPerson += hits;
    const named = narration.match(NAMED_SUBJECT)?.length ?? 0;
    tally.sceneNotes.push(`${label}/${path.basename(file)}:${range.start + 1} 一人称 ${firstPerson}・名前の主語 ${named}`);
    if (firstPerson > MAX_SCENE_FIRST_PERSON || named < MIN_NAMED_SUBJECTS) continue;
    tally.thirdScenes++;
    sceneLines.forEach((raw, offset) => {
      const masked = narrationOf(raw);
      for (const match of masked.matchAll(FIRST_PERSON_SUBJECT)) {
        const at = match.index ?? 0;
        const sentence = sentenceAt(raw, at);
        tally.candidates.push({
          file: `${label}/${path.basename(file)}`,
          line: range.start + offset + 1,
          sentence: `［一人称 ${firstPerson}・名前の主語 ${named}・場面の地の文 ${narration.replace(/\s/gu, "").length}字］${sentence.slice(0, 60)}`,
          inner: INNER_CUE.test(sentence) || /[？！?!]$/u.test(sentence),
        });
      }
    });
  }
}

function emptyTally(): Tally {
  return { files: 0, scenes: 0, thirdScenes: 0, candidates: [], sceneNotes: [] };
}

describe.skipIf(!ROOT && !BENCH)("人称の入れ替わり E の試作（設計書6.9.3）", () => {
  test("作者の作品と台で、候補の数を出す", () => {
    const rows: string[] = ["# 人称の入れ替わり E の試作の数", ""];
    rows.push(`判定：場面の地の文の一人称が ${MAX_SCENE_FIRST_PERSON} 以下・名前の主語が ${MIN_NAMED_SUBJECTS} 以上の場面を三人称と見て、地の文の「一人称＋は／が／も」を候補にする。心の声の手がかり（と思・心の中 など）か「？！」で終わる文は inner として分ける。`, "");
    rows.push("| 作品 | ファイル | 場面 | 三人称と見た場面 | 候補 | うち inner | 残る候補 |", "|---|---|---|---|---|---|---|");
    const details: string[] = [];
    let compared = 0;
    const targets: Array<{ label: string; dir: string }> = [];
    if (ROOT) {
      for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
        if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) targets.push({ label: entry.name, dir: path.join(ROOT, entry.name) });
      }
    }
    if (BENCH) {
      targets.push({ label: "台:third", dir: path.join(BENCH, "third") });
      targets.push({ label: "台:first", dir: path.join(BENCH, "first") });
    }
    for (const target of targets) {
      const tally = emptyTally();
      for (const file of episodeFiles(target.dir)) scanFile(file, tally, target.label);
      compared += tally.files;
      const kept = tally.candidates.filter((c) => !c.inner);
      rows.push(`| ${target.label.slice(0, 20)} | ${tally.files} | ${tally.scenes} | ${tally.thirdScenes} | ${tally.candidates.length} | ${tally.candidates.length - kept.length} | ${kept.length} |`);
      if (target.label.startsWith("台:")) details.push(...tally.sceneNotes.map((note) => `- 場面 ${note}`));
      for (const c of tally.candidates.slice(0, 40)) {
        details.push(`- ${c.inner ? "（inner）" : ""}${c.file}:${c.line} ${c.sentence}`);
      }
    }
    rows.push("", "## 候補（作品ごとに先頭40件まで）", "", ...details, "");
    if (REPORT) fs.writeFileSync(REPORT, rows.join("\n"), "utf8");
    // 比べる相手が0件なら、測ったことにしない（ai-bench）
    expect(compared).toBeGreaterThan(0);
  });
});
