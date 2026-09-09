import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildTypoCheckPrompt,
  TYPO_CHECK_SCHEMA,
  TYPO_CHECK_SYSTEM_PROMPT,
  type ExtractedTypoIssue,
} from "../../src/prompts/typoCheck";
import {
  PARTICLE_CHARS,
  parseTypoCheckResult,
  validateTypoIssues,
} from "../../src/core/typoCheckValidation";
import { splitIntoChunks, withLineNumbers } from "../../src/core/chunker";
import { decodeByteFallback } from "../../src/core/byteFallback";
import type { KeepWord } from "../../src/models/keepWord";
import { LIVE_MODEL, OLLAMA_ENDPOINT } from "./support/liveEnv";

/**
 * 誤字脱字を、**設定資料がまだ無い作品**で測る。
 *
 * **これが新しい作品の実際の姿である。** 本文を書き始めた段階では
 * 人物も場所も抽出していないので、固有名詞の保護辞書は空になる。
 * P-09がいちばん危ないのはこの状態で、造語（「魔抜き」「商興会」「霊力」）を
 * 誤変換として指摘してくる恐れがある。
 *
 *   $env:NOVELAI_WORKS = "C:/path/to/作品を集めたフォルダー"
 *   npx vitest run --config vitest.live.config.mts test/live/typoAcrossWorks.test.ts
 *
 * **既定は各作品の先頭2ファイルだけ。** `NOVELAI_ALL_FILES=1` を立てると
 * 全ファイルを対象にする（時間はその分かかる）。
 *
 * 範囲ずれ（本文「すでの僕」に target「すで」→suggestion「すでに」を当てると
 * 「すでにの僕」になる型）は、先頭2ファイルの基準測定では1件も
 * 拾えなかった。**全話で拾えるかを、この道具で測り直す。**
 */
const ROOT = process.env.NOVELAI_WORKS?.trim();
const REPORT_PATH =
  process.env.NOVELAI_REPORT?.trim() ?? "typo-across-works.txt";
const ALL_FILES = process.env.NOVELAI_ALL_FILES?.trim() === "1";

/**
 * 固有名詞の辞書（`extractAcrossWorks` が書き出したもの）。
 *
 * **指定すれば「設定資料を先に抽出しておくと誤検出が減る」を確かめられる。**
 * 指定しなければ辞書は空で、**設定資料をまだ抽出していない作品**の姿になる。
 */
function loadDictionary(): Record<string, string[]> {
  const configured = process.env.NOVELAI_DICTIONARY?.trim();
  if (!configured) return {};
  try {
    return JSON.parse(fs.readFileSync(configured, "utf-8")) as Record<
      string,
      string[]
    >;
  } catch {
    return {};
  }
}

/**
 * 作者が「直さない」と決めた語（`設定/keep_words.json` の代わり）。
 *
 * **辞書では守れないものを、名指しで守れるか**を測るために渡す。
 */
function loadKeepWords(): Record<string, KeepWord[]> {
  const configured = process.env.NOVELAI_KEEP?.trim();
  if (!configured) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(configured, "utf-8")) as Record<
      string,
      string[]
    >;
    return Object.fromEntries(
      Object.entries(raw).map(([work, words]) => [
        work,
        words.map((word) => ({ word, note: "", addedAt: "" })),
      ])
    );
  } catch {
    return {};
  }
}

function worksIn(root: string): Array<{ name: string; files: string[] }> {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "backups")
    .map((entry) => {
      const dir = path.join(root, entry.name);
      const files = fs
        .readdirSync(dir)
        .filter((name) => name.endsWith(".txt") && !name.startsWith("about"))
        .sort()
        .map((name) => path.join(dir, name));
      return { name: entry.name, files };
    })
    .filter((work) => work.files.length > 0);
}

async function ask(prompt: string): Promise<string> {
  const response = await fetch(`${OLLAMA_ENDPOINT}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: LIVE_MODEL,
      stream: false,
      think: false,
      format: TYPO_CHECK_SCHEMA,
      // 誤字脱字は正解のある作業なので、揺らさない
      options: { temperature: 0.0, num_ctx: 32768 },
      messages: [
        { role: "system", content: TYPO_CHECK_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
  });
  const body = (await response.json()) as { message?: { content?: string } };
  // **プロバイダと同じ手当てを通す**（迂回すると製品に無い不具合が見える）
  return decodeByteFallback(body.message?.content ?? "");
}

/**
 * 助詞。B型（置き換え箇所の末尾と直後が、どちらも助詞になる）の判定に使う。
 *
 * **製品側と同じ一覧を使う**（写しを作ると、片方だけ直したときにずれる）。
 */
const PARTICLES = PARTICLE_CHARS;

/** `original`（AIが渡した抜粋）の中で、target の直前5字・直後5字を取り出す */
function contextAround(
  original: string,
  target: string
): { before: string; after: string } {
  const at = original.indexOf(target);
  if (at < 0) return { before: "", after: "" };
  return {
    before: original.slice(Math.max(0, at - 5), at),
    after: original.slice(at + target.length, at + target.length + 5),
  };
}

/**
 * 範囲ずれの疑い（A型）。
 *
 * suggestion が target を含んで長く（前方または後方一致）、
 * 伸びた分の端の文字が本文の直前／直後の文字と同じなら、当てると
 * 同じ文字が連続する（例：本文「すでの」target「すで」suggestion「すでの」）。
 */
function isRangeSlipA(
  target: string,
  suggestion: string,
  before: string,
  after: string
): boolean {
  if (suggestion.length <= target.length) return false;
  if (suggestion.startsWith(target)) {
    const extra = suggestion.slice(target.length);
    if (extra && after && extra.slice(-1) === after[0]) return true;
  }
  if (suggestion.endsWith(target)) {
    const extra = suggestion.slice(0, suggestion.length - target.length);
    if (extra && before && extra[0] === before[before.length - 1]) return true;
  }
  return false;
}

/**
 * 範囲ずれの疑い（B型）。
 *
 * 置き換えた結果の末尾と、本文の直後の文字が、どちらも助詞になるなら
 * 範囲が1文字ずれている疑いがある
 * （例：本文「すでの僕」target「すで」suggestion「すでに」→「すでにの僕」）。
 */
function isRangeSlipB(suggestion: string, after: string): boolean {
  if (!suggestion || !after) return false;
  return PARTICLES.has(suggestion.slice(-1)) && PARTICLES.has(after[0]);
}

/**
 * `rejected`（line・target・弾いた理由だけを持つ）に、AIが実際に返した
 * suggestion・reason を補う。
 *
 * `validateTypoIssues` は `raw.issues` を1件ずつ見て、必ず accepted か
 * rejected のどちらか一方へ1回だけ積む（`continue` で抜けるため）。
 * つまり accepted + rejected の並びは raw.issues と同じ順序になる。
 * ここでは raw.issues の複製から line・target が一致する最初の1件を
 * 取り出して消費することで、rejected 側にも元の内容を対応づける。
 */
function takeRawMatch(
  pool: ExtractedTypoIssue[],
  line: number | null,
  target: string | null
): ExtractedTypoIssue | null {
  if (target === null) return null;
  let idx = pool.findIndex((r) => r.line === line && r.target === target);
  // **検証側が範囲を1字広げていることがある**（`checkParticleRange`）。
  // そのときAIが返した target は1字短いので、前方一致でも探す
  if (idx === -1) {
    idx = pool.findIndex(
      (r) =>
        r.line === line &&
        r.target.length === target.length - 1 &&
        target.startsWith(r.target)
    );
  }
  if (idx === -1) return null;
  return pool.splice(idx, 1)[0] ?? null;
}

interface AcceptedRecord {
  work: string;
  file: string;
  line: number;
  target: string;
  suggestion: string;
  reason: string;
  confidence: string;
  before: string;
  after: string;
  /** 検証側が置き換える範囲を1字広げたか（`checkParticleRange`） */
  rangeExtended: boolean;
}

interface RejectedRecord {
  work: string;
  file: string;
  line: number | null;
  target: string | null;
  suggestion: string;
  aiReason: string;
  rejectReason: string;
}

describe.skipIf(!ROOT)(
  `誤字脱字を、設定資料の無い作品で測る${ROOT ? "" : "（NOVELAI_WORKS を指定すると走ります）"}`,
  () => {
    test(
      "辞書が空でも、造語を誤字にしないか",
      async () => {
        const startedAt = Date.now();
        const works = worksIn(ROOT!);
        const dictionary = loadDictionary();
        const dictSize = Object.values(dictionary).flat().length;
        const keepWords = loadKeepWords();
        const keepSize = Object.values(keepWords).flat().length;
        expect(works.length, "作品が読めない").toBeGreaterThan(1);

        const byReject = new Map<string, number>();
        const perWork = new Map<
          string,
          { raised: number; accepted: number; rejected: number }
        >();
        const targetToFiles = new Map<string, Set<string>>();
        const accepted: AcceptedRecord[] = [];
        const rejected: RejectedRecord[] = [];
        let raised = 0;
        let chars = 0;
        let looked = 0;
        let filesSeen = 0;

        for (const work of works) {
          const files = ALL_FILES ? work.files : work.files.slice(0, 2);
          const workStat = perWork.get(work.name) ?? {
            raised: 0,
            accepted: 0,
            rejected: 0,
          };
          perWork.set(work.name, workStat);

          for (const filePath of files) {
            filesSeen++;
            const fileLabel = path.basename(filePath);
            const text = fs.readFileSync(filePath, "utf-8");
            const chunk = splitIntoChunks(filePath, text, null, null, {
              maxChars: 4000,
            })[0];
            if (!chunk || chunk.text.length < 200) continue;
            chars += chunk.text.length;
            looked++;

            const raw = await ask(
              buildTypoCheckPrompt({
                chunkTextWithLineNumbers: withLineNumbers(chunk),
                properNounDictionary: dictionary[work.name] ?? [],
              })
            );
            const parsed = parseTypoCheckResult(raw);
            if (!parsed) continue;
            raised += parsed.issues.length;
            workStat.raised += parsed.issues.length;

            for (const issue of parsed.issues) {
              const key = issue.target.trim();
              if (!key) continue;
              const set = targetToFiles.get(key) ?? new Set<string>();
              set.add(`${work.name}/${fileLabel}`);
              targetToFiles.set(key, set);
            }

            const validated = validateTypoIssues(
              parsed,
              chunk,
              dictionary[work.name] ?? [],
              keepWords[work.name] ?? []
            );

            // rejected の順は raw.issues と同じなので、raw.issues の複製から
            // 1件ずつ取り出して対応づける（accepted 側は元データを持っている）
            const rawPool = [...parsed.issues];
            for (const item of validated.accepted) {
              takeRawMatch(rawPool, item.line, item.target);
            }
            for (const entry of validated.rejected) {
              byReject.set(entry.reason, (byReject.get(entry.reason) ?? 0) + 1);
              workStat.rejected++;
              const raw2 = takeRawMatch(rawPool, entry.line, entry.target);
              rejected.push({
                work: work.name,
                file: fileLabel,
                line: entry.line,
                target: entry.target,
                suggestion: raw2?.suggestion ?? "",
                aiReason: raw2?.reason ?? "",
                rejectReason: entry.reason,
              });
            }

            workStat.accepted += validated.accepted.length;
            for (const item of validated.accepted) {
              const { before, after } = contextAround(
                item.original,
                item.target
              );
              accepted.push({
                work: work.name,
                file: fileLabel,
                line: item.line,
                target: item.target,
                suggestion: item.suggestion,
                reason: item.reason,
                confidence: item.confidence,
                before,
                after,
                rangeExtended: item.rangeExtended === true,
              });
            }
          }
        }

        const rangeSlipA = accepted.filter((item) =>
          isRangeSlipA(item.target, item.suggestion, item.before, item.after)
        );
        const rangeSlipB = accepted.filter((item) =>
          isRangeSlipB(item.suggestion, item.after)
        );

        const rangeExtended = accepted.filter((item) => item.rangeExtended);

        const repeatedTargets = [...targetToFiles]
          .map(([target, files]) => [target, files] as const)
          .filter(([, files]) => files.size >= 3)
          .sort((a, b) => b[1].size - a[1].size)
          .slice(0, 10);

        const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);

        const report = [
          `=== 誤字脱字（${LIVE_MODEL}） / 辞書 ${dictSize}語 / 直さない語 ${keepSize}語 / ` +
            `${works.length}作品 / ${filesSeen}ファイル / ${chars.toLocaleString("ja-JP")}字 / ` +
            `${looked}チャンク / 所要 ${elapsedMin}分 / ` +
            `対象=${ALL_FILES ? "全ファイル" : "先頭2ファイル"} ===`,
          `AIが挙げた: ${raised}件`,
          `残った(accepted): ${accepted.length}件`,
          `弾いた(rejected): ${rejected.length}件`,
          "",
          "弾いた理由の内訳:",
          ...[...byReject].map(([reason, n]) => `  ${reason}: ${n}件`),
          "",
          `範囲を広げた件数（rangeExtended）: ${rangeExtended.length}件`,
          ...rangeExtended
            .slice(0, 10)
            .map(
              (item) =>
                `  ${item.work} / ${item.file} ${item.line}行 「${item.target}」→「${item.suggestion}」` +
                `（前後: ${item.before}｜${item.after}）`
            ),
          "",
          `範囲ずれの疑い（A型・同じ文字が連続）: ${rangeSlipA.length}件`,
          ...rangeSlipA.slice(0, 10).map(
            (item) =>
              `  ${item.work} / ${item.file} ${item.line}行 「${item.target}」→「${item.suggestion}」` +
              `（前後: ${item.before}｜${item.after}）`
          ),
          "",
          `範囲ずれの疑い（B型・末尾と直後がどちらも助詞）: ${rangeSlipB.length}件`,
          ...rangeSlipB.slice(0, 10).map(
            (item) =>
              `  ${item.work} / ${item.file} ${item.line}行 「${item.target}」→「${item.suggestion}」` +
              `（前後: ${item.before}｜${item.after}）`
          ),
          "",
          "同じ target が3話以上で指摘（上位10件）:",
          ...repeatedTargets.map(
            ([target, files]) =>
              `  「${target}」: ${files.size}話 (${[...files].join(", ")})`
          ),
          "",
          "作品ごとの件数（raised/accepted/rejected）:",
          ...[...perWork].map(
            ([name, stat]) =>
              `  ${name}: ${stat.raised}/${stat.accepted}/${stat.rejected}`
          ),
          "",
          "--- accepted 一覧 ---",
          ...accepted.map(
            (item) =>
              `[${item.confidence}]${item.rangeExtended ? "[範囲+1]" : ""} ${item.work} / ${item.file} ${item.line}行\n` +
              `  「${item.target}」→「${item.suggestion}」（${item.reason}）\n` +
              `  前後: ${item.before}｜${item.after}`
          ),
          "",
          "--- rejected 一覧 ---",
          ...rejected.map(
            (item) =>
              `[${item.rejectReason}] ${item.work} / ${item.file} ${item.line ?? "?"}行\n` +
              `  「${item.target ?? "?"}」→「${item.suggestion}」（AIの理由: ${item.aiReason}）`
          ),
        ].join("\n");
        fs.writeFileSync(REPORT_PATH, report, "utf-8");
        console.log(report);

        expect(true).toBe(true);
      },
      90 * 60 * 1000
    );
  }
);
