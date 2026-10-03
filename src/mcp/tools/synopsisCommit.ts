import * as fs from "node:fs";
import * as nodePath from "node:path";
import { z } from "zod";
import { DEFAULT_SETTINGS_DIR } from "../../models/types";
import {
  SYNOPSIS_SCHEMA_VERSION,
  dedupeSynopsisEpisodes,
  findSynopsis,
  parseSynopsisSet,
  synopsisKey,
  type ChapterSynopsis,
  type ChapterSynopsisSet,
} from "../../models/synopsis";
import { SYNOPSIS_VERSION } from "../../prompts/synopsis";
import { BLURB_VERSION } from "../../prompts/blurb";
import {
  NEW_JSON_FILE_FORMAT,
  detectJsonFileFormat,
  formatJsonForFile,
} from "../../core/jsonFileFormat";
import { buildSynopsisMarkdown, SYNOPSIS_FILE } from "../../core/synopsisDoc";
import { buildSynopsisListMarkdown } from "../../core/synopsisMarkdown";
import { buildEmotionCurveMarkdown } from "../../core/emotionCurve";
import { decodeByteFallback } from "../../core/byteFallback";
import { measureBlurb } from "../../core/blurbValidation";
// 回復先の名前は製品の `atomicWrite.ts` と同じ形（`outbox.import` と共用。6.115）
import { recoveryPathFor } from "./recoveryFile";
import {
  FOLDER_INPUT,
  McpToolError,
  SYNOPSES_FILE,
  describeError,
  workTitleOf,
} from "./shared";
import {
  readSynopsisStash,
  resolveEpisodeForSynopsis,
  writeSynopsisStash,
  type EpisodeSynopsisStashEntry,
} from "./synopsisStash";

/**
 * 外部AIが作った各話あらすじ・作品紹介文を、**拡張機能のボタンと同じ形で**
 * 資料へ保存する（2026-10-02、作者の裁定「何もない状態からであれば承認は不要」）。
 * 設定資料の抽出の保存（`novel.extract.commit`）と同じ考え方で、
 * 設計書6.87.7「MCP は資料を書き換えない」の例外の2つ目。
 *
 * ## 各話あらすじ（kind: episodes → `設定/chapter_synopses.json`）
 *
 * 製品の［各話あらすじ］（`features/generateSynopses.ts`）は、本文が変わった話・
 * 版やモデルが違う話を**作り直して上書きする**（作者が書き直した話だけは残す）。
 * ここは**まだあらすじの無い話だけを足し、既にある話は AI が作ったものでも
 * 変えずに断る**（安全側。作り直したいなら作者が拡張機能のボタンで行う）。
 *
 * - 既存の話のエントリは**読んだままの形で書き戻す**（解析し直して整えない。
 *   1バイトも変えない）。改行の形（CRLF／LF）も元のファイルに揃える
 * - ファイルそのものは書き直すので、製品の `SynopsisStore.save` と同じく
 *   **元のファイルを回復先（`.novelai-recovery`）へ退避してから新しく作る**
 * - 読めない（壊れた）ファイルなら**何も書かずに止める**（規則2）
 *
 * ## 作品紹介文（kind: blurb → `設定/synopsis.md`）
 *
 * 製品の［作品紹介文］（`features/generateBlurb.ts`）は、案を見せて作者が
 * 「採用」を選べば、今ある文書の紹介文の欄だけを差し替える。ここは
 * **ファイルが無いときだけ作る**（`wx`）。あれば断る——作者が推敲して
 * 投稿サイトに貼っている文書なので、外から書き換えない。
 * 中身は製品と同じ組み立て（`buildSynopsisMarkdown`）で、各話あらすじと
 * 感情曲線の欄も `chapter_synopses.json` から組む。
 */

export const SYNOPSIS_COMMIT_INPUT = {
  ...FOLDER_INPUT,
  kind: z
    .enum(["episodes", "blurb"])
    .describe(
      "episodes＝各話あらすじ（設定/chapter_synopses.json へ、まだ無い話だけ足す）／" +
        "blurb＝作品紹介文（設定/synopsis.md が無いときだけ作る）"
    ),
  dryRun: z
    .boolean()
    .optional()
    .describe("true なら書かずに、保存されるもの・断るものの内訳だけを返します"),
};

export interface SynopsisCommitInput {
  folder: string;
  kind: "episodes" | "blurb";
  dryRun?: boolean;
}

interface EpisodeLabelled {
  /** 呼び名（第3話／ファイル名） */
  label: string;
  filePath: string;
}

export interface EpisodesCommitResult {
  kind: "episodes";
  dryRun: boolean;
  /** 足した（足す）話 */
  created: EpisodeLabelled[];
  createdCount: number;
  /** 足さなかった話（既にあらすじがある・同じ話が2つ貯まっていた） */
  refused: Array<EpisodeLabelled & { reason: string }>;
  /** 使わなかった貯め（本文が変わった・版が違う・話が見つからない） */
  discarded: Array<EpisodeLabelled & { reason: string }>;
  /** 書こうとして失敗したもの。**あれば貯め場所は消さない** */
  failed: Array<{ file: string; reason: string }>;
  /** 書いたファイル（作品フォルダーからの相対）。書かなければ null */
  file: string | null;
  /** 元のファイルを退避した場所（書き直したときだけ） */
  recoveryPath: string | null;
  stashCleared: boolean;
  nextStep: string;
  note: string;
}

export interface BlurbCommitResult {
  kind: "blurb";
  dryRun: boolean;
  /** 作った（作る）か */
  created: boolean;
  createdCount: number;
  /** 作らなかった理由（既にある・版が違う）。作ったなら null */
  refused: Array<{ reason: string }>;
  failed: Array<{ file: string; reason: string }>;
  file: string;
  /** 紹介文の字数（コードで数えたもの） */
  chars: number;
  tooShort: boolean;
  tooLong: boolean;
  /** 断ったときは、作者に見せられるよう紹介文をそのまま返す */
  blurb: string | null;
  stashCleared: boolean;
  nextStep: string;
  note: string;
}

export function synopsisCommit(
  input: SynopsisCommitInput & { kind: "episodes" }
): EpisodesCommitResult;
export function synopsisCommit(
  input: SynopsisCommitInput & { kind: "blurb" }
): BlurbCommitResult;
export function synopsisCommit(
  input: SynopsisCommitInput
): EpisodesCommitResult | BlurbCommitResult;
export function synopsisCommit(
  input: SynopsisCommitInput
): EpisodesCommitResult | BlurbCommitResult {
  const root = nodePath.resolve(input.folder);
  // **無い作品フォルダーには書かない**（`mkdirSync` は道を作ってしまう）
  if (!fs.existsSync(root)) {
    throw new McpToolError(
      `作品フォルダーが見つかりません: ${input.folder}（novel.scan が通る場所を指定してください）`
    );
  }
  return input.kind === "blurb"
    ? commitBlurb(input.folder, root, input.dryRun === true)
    : commitEpisodes(input.folder, root, input.dryRun === true);
}

/* ── 各話あらすじ ───────────────────────────────────────── */

interface ExistingSynopses {
  /** 読んだバイト。無ければ undefined */
  bytes: Uint8Array | undefined;
  /** 読んだままの JSON（エントリはこれをそのまま書き戻す） */
  raw: Record<string, unknown> | undefined;
  /** 製品の読み方で読んだもの（話がもうあるかを決めるのに使う） */
  set: ChapterSynopsisSet;
}

/**
 * `chapter_synopses.json` を読む。**壊れていれば止める**（製品の `SynopsisStore.load`
 * と同じ。空として扱って書くと、作者が書き直したあらすじがまるごと消える）。
 */
function readExistingSynopses(target: string): ExistingSynopses {
  if (!fs.existsSync(target)) {
    return {
      bytes: undefined,
      raw: undefined,
      set: { schemaVersion: SYNOPSIS_SCHEMA_VERSION, episodes: [] },
    };
  }
  const bytes = fs.readFileSync(target);
  let raw: unknown;
  let set: ChapterSynopsisSet;
  try {
    const text = new TextDecoder().decode(bytes);
    raw = JSON.parse(text);
    // 製品と同じく、文字化けを戻したうえで形を確かめる（`SynopsisStore.load`）
    set = parseSynopsisSet(JSON.parse(decodeByteFallback(text)));
  } catch (error) {
    throw new McpToolError(
      `${DEFAULT_SETTINGS_DIR}/${SYNOPSES_FILE} を読めません。上書きを避けるため保存を中止しました` +
        `（何も書いていません）: ${describeError(error)}`
    );
  }
  return { bytes, raw: raw as Record<string, unknown>, set };
}

function commitEpisodes(folder: string, root: string, dryRun: boolean): EpisodesCommitResult {
  const target = nodePath.join(root, DEFAULT_SETTINGS_DIR, SYNOPSES_FILE);
  const existing = readExistingSynopses(target);

  const stash = readSynopsisStash(folder);
  if (stash.episodes.length === 0) {
    throw new McpToolError(
      "保存する各話あらすじがありません。novel.validate（feature: synopsis）に stash: true を付けて検算してから呼んでください。"
    );
  }

  const created: EpisodesCommitResult["created"] = [];
  const refused: EpisodesCommitResult["refused"] = [];
  const discarded: EpisodesCommitResult["discarded"] = [];
  const records: ChapterSynopsis[] = [];
  const takenKeys = new Set<string>();
  const now = new Date().toISOString();

  // 返す内訳を話の順にする（貯めた順は外部AIの回し方で前後する）
  const orderedStash = [...stash.episodes].sort((a, b) =>
    compareEpisodeOrder(
      { chapter: a.chapter, fileName: a.filePath },
      { chapter: b.chapter, fileName: b.filePath }
    )
  );
  for (const entry of orderedStash) {
    const fallbackLabel = labelOf(entry.chapter, nodePath.basename(entry.filePath));
    let episode;
    try {
      episode = resolveEpisodeForSynopsis(folder, entry.filePath, entry.chapter);
    } catch (error) {
      discarded.push({ label: fallbackLabel, filePath: entry.filePath, reason: describeError(error) });
      continue;
    }
    const label = labelOf(episode.chapter, episode.fileName);
    const where = { label, filePath: entry.filePath };
    if (episode.hash !== entry.sourceHash) {
      discarded.push({ ...where, reason: "答えたあとに本文が変わりました（作り直してください）" });
      continue;
    }
    if (baseVersionOf(entry.promptVersion) !== SYNOPSIS_VERSION) {
      discarded.push({
        ...where,
        reason: `プロンプトの版が違います（貯めたとき ${entry.promptVersion}・いま ${SYNOPSIS_VERSION}）`,
      });
      continue;
    }
    /*
      **既にある話は、AI が作ったものでも変えない。** 製品のボタンは本文や版が
      変わった話を作り直すが、外からは「何もない所へ足す」線を越えない
    */
    if (findSynopsis(existing.set, episode.fileName, episode.chapter)) {
      refused.push({
        ...where,
        reason: "この話のあらすじは既にあります（書き換えません。作り直すなら拡張機能の［各話あらすじ］で）",
      });
      continue;
    }
    const key = synopsisKey(episode.fileName, episode.chapter);
    if (takenKeys.has(key)) {
      refused.push({ ...where, reason: "同じ話のあらすじが2つ貯まっていました（先のほうを使います）" });
      continue;
    }
    takenKeys.add(key);
    records.push(recordOf(entry, episode, now));
    created.push(where);
  }

  const relativeTarget = relativeTo(root, target);
  const failed: EpisodesCommitResult["failed"] = [];
  let recoveryPath: string | null = null;
  let wrote = false;
  if (!dryRun && records.length > 0) {
    try {
      recoveryPath = writeSynopses(target, existing, records);
      wrote = true;
    } catch (error) {
      failed.push({ file: relativeTarget, reason: describeError(error) });
    }
  }

  /*
    **貯め場所は、書き終えたら消す**（`novel.extract.commit` と同じ）。断った件・
    捨てた件は、もう一度保存しても同じ結果になるだけなので消してよい。
    **書けなかったら残す**（直してからもう一度保存できるように）。紹介文の貯めは残す
  */
  const stashCleared = !dryRun && failed.length === 0;
  if (stashCleared) writeSynopsisStash(folder, { ...stash, episodes: [] });

  return {
    kind: "episodes",
    dryRun,
    created: failed.length > 0 ? [] : created,
    createdCount: failed.length > 0 ? 0 : created.length,
    refused,
    discarded,
    failed,
    file: wrote ? relativeTarget : null,
    recoveryPath: recoveryPath ? relativeTo(root, recoveryPath) : null,
    stashCleared,
    nextStep: dryRun
      ? "dryRun です。何も書いていません。dryRun を外すと、この内訳で保存します。"
      : failed.length > 0
        ? "保存できませんでした。理由を作者に伝えてください（貯めた答えは残しています）。"
        : created.length > 0
          ? "各話あらすじを保存しました。VS Code の［各話あらすじ］の資料で確かめられます。設定/synopsis.md の各話あらすじの欄は、拡張機能で設定資料集を出力したときに組み直されます。"
          : "足せる話がありませんでした（refused・discarded に理由があります）。",
    note:
      "拡張機能の［各話あらすじ］と同じ検算を通した答えを、同じ形（設定/chapter_synopses.json）で保存しました。" +
      "まだあらすじの無い話だけを足し、既にある話は変えていません（拡張機能は本文の変わった話を作り直します）。" +
      "ファイルを書き直すときは、元のファイルを 設定/.novelai-recovery/ へ退避しています。",
  };
}

/** 製品の `upsertSynopsis` へ渡す形と同じ並びで組む */
function recordOf(
  entry: EpisodeSynopsisStashEntry,
  episode: { chapter: number | null; fileName: string; title: string | null; hash: string },
  now: string
): ChapterSynopsis {
  return {
    chapter: episode.chapter,
    fileName: episode.fileName,
    title: episode.title,
    synopsis: entry.synopsis,
    sourceHash: episode.hash,
    /*
      **モデル名は分からないので null。** 外部AI（Claude Code など）が自分の名前を
      名乗る口は無く、当て推量で書くと製品の作り直しの判断（モデル名の比較）を
      誤らせる。null なら、作者が拡張機能のボタンを押したときに作り直しの対象になる
    */
    model: null,
    promptVersion: entry.promptVersion,
    autoGenerated: true,
    authorNotes: "",
    emotion: entry.emotion,
    updatedAt: now,
  };
}

/**
 * 書く。返り値は退避先（書き直したとき）。
 *
 * - 無ければ：製品の `SynopsisStore.save` と同じ字面（字下げ2つ・LF・末尾改行）で `wx`
 * - あれば：読んだままのエントリに新しい話を足し、**話数の順に並べて**（製品の
 *   `upsertSynopsis` も並べ直す）、元の改行の形で書く。読んだあとに誰かが
 *   書き換えていれば止める。元のファイルは退避してから新しく作る
 */
function writeSynopses(
  target: string,
  existing: ExistingSynopses,
  records: ChapterSynopsis[]
): string | null {
  if (existing.bytes === undefined || existing.raw === undefined) {
    const body = formatJsonForFile(
      { schemaVersion: SYNOPSIS_SCHEMA_VERSION, episodes: sortRecords(records) },
      NEW_JSON_FILE_FORMAT
    );
    fs.mkdirSync(nodePath.dirname(target), { recursive: true });
    // **新規作成だけ**（`wx`）。確かめたあとに誰かが置いても上書きしない
    fs.writeFileSync(target, body, { encoding: "utf8", flag: "wx" });
    return null;
  }

  const rawEpisodes = existing.raw.episodes as unknown[];
  // 読んだままのエントリと、製品の読み方で読んだ話数・ファイル名を組にする
  // （`parseSynopsisSet` はエントリを同じ順に1つずつ読むので、添字が揃う）
  const ordered = sortEntries([
    ...rawEpisodes.map((raw, index) => ({
      raw,
      chapter: existing.set.episodes[index].chapter,
      fileName: existing.set.episodes[index].fileName,
    })),
    ...records.map((record) => ({
      raw: record as unknown,
      chapter: record.chapter,
      fileName: record.fileName,
    })),
  ]);
  const body = formatJsonForFile(
    { ...existing.raw, episodes: ordered.map((item) => item.raw) },
    detectJsonFileFormat(existing.bytes)
  );

  /*
    **読んだあとに書き換えられていれば止める**（製品の `SettingsStore` の
    ハッシュ照合と同じ考え）。作者が VS Code でちょうど直した内容を、
    退避先へ押しやってしまわないため
  */
  const current = fs.readFileSync(target);
  if (!Buffer.from(current).equals(Buffer.from(existing.bytes))) {
    throw new McpToolError(
      `${SYNOPSES_FILE} が、読んだあとに書き換えられました。上書きを避けるため保存を中止しました（もう一度呼んでください）。`
    );
  }

  const recoveryPath = recoveryPathFor(target);
  fs.mkdirSync(nodePath.dirname(recoveryPath), { recursive: true });
  try {
    fs.renameSync(target, recoveryPath);
  } catch (error) {
    throw new McpToolError(
      `${SYNOPSES_FILE} を退避できませんでした（何も書いていません）: ${describeError(error)}`
    );
  }
  try {
    fs.writeFileSync(target, body, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    throw new McpToolError(
      `${SYNOPSES_FILE} を保存できませんでした: ${describeError(error)} ` +
        `元の内容は「${recoveryPath}」にあります。手動で戻してください。`
    );
  }
  return recoveryPath;
}

/** 話数の順。話数の無いものは末尾（製品の `sortEpisodes` と同じ）。安定ソート */
function compareEpisodeOrder(
  a: { chapter: number | null; fileName: string },
  b: { chapter: number | null; fileName: string }
): number {
  if (a.chapter === null && b.chapter === null) {
    return a.fileName.localeCompare(b.fileName, "ja");
  }
  if (a.chapter === null) return 1;
  if (b.chapter === null) return -1;
  return a.chapter - b.chapter;
}

function sortEntries<T extends { chapter: number | null; fileName: string }>(items: T[]): T[] {
  return [...items].sort(compareEpisodeOrder);
}

function sortRecords(records: ChapterSynopsis[]): ChapterSynopsis[] {
  return sortEntries(records);
}

/* ── 作品紹介文 ─────────────────────────────────────────── */

function commitBlurb(folder: string, root: string, dryRun: boolean): BlurbCommitResult {
  const stash = readSynopsisStash(folder);
  const entry = stash.blurb;
  if (!entry) {
    throw new McpToolError(
      "保存する作品紹介文がありません。novel.validate（feature: blurb）に stash: true を付けて検算してから呼んでください。"
    );
  }
  const target = nodePath.join(root, DEFAULT_SETTINGS_DIR, SYNOPSIS_FILE);
  const file = relativeTo(root, target);
  const measured = measureBlurb(entry.blurb);
  const refused: BlurbCommitResult["refused"] = [];
  const failed: BlurbCommitResult["failed"] = [];

  if (baseVersionOf(entry.promptVersion) !== BLURB_VERSION) {
    refused.push({
      reason: `プロンプトの版が違います（貯めたとき ${entry.promptVersion}・いま ${BLURB_VERSION}）。作り直してください`,
    });
  } else if (fs.existsSync(target)) {
    refused.push({
      reason:
        `${file} は既にあります（書き換えません）。紹介文を差し替えるなら、作者に見せて手で直してもらうか、` +
        "拡張機能の［作品紹介文］で採用してください",
    });
  }

  let created = false;
  if (refused.length === 0) {
    // 各話あらすじと感情曲線の欄（製品の `buildEpisodeSection` と同じ材料）。
    // **読めなければ止める**（製品は欄を外して書くが、外からは安全側へ倒す）
    const sections = episodeSectionsOf(nodePath.join(root, DEFAULT_SETTINGS_DIR, SYNOPSES_FILE), folder);
    const body = buildSynopsisMarkdown(
      workTitleOf(folder),
      { catchphrase: null, blurb: entry.blurb },
      sections.episodes,
      sections.emotion
    );
    if (dryRun) {
      created = true;
    } else {
      try {
        fs.mkdirSync(nodePath.dirname(target), { recursive: true });
        // **新規作成だけ**（`wx`）。確かめたあとに誰かが置いても上書きしない
        fs.writeFileSync(target, body, { encoding: "utf8", flag: "wx" });
        created = true;
      } catch (error) {
        if ((error as { code?: unknown }).code === "EEXIST") {
          refused.push({ reason: `${file} が、確かめたあとに置かれました（書き換えません）` });
        } else {
          failed.push({ file, reason: describeError(error) });
        }
      }
    }
  }

  const stashCleared = !dryRun && failed.length === 0;
  if (stashCleared) writeSynopsisStash(folder, { ...stash, blurb: null });

  return {
    kind: "blurb",
    dryRun,
    created,
    createdCount: created ? 1 : 0,
    refused,
    failed,
    file,
    chars: measured.chars,
    tooShort: measured.tooShort,
    tooLong: measured.tooLong,
    blurb: created ? null : entry.blurb,
    stashCleared,
    nextStep: dryRun
      ? "dryRun です。何も書いていません。dryRun を外すと作ります。"
      : created
        ? `作品紹介文を ${file} に作りました。作者に確かめてもらってください。`
        : failed.length > 0
          ? "保存できませんでした。理由を作者に伝えてください（貯めた答えは残しています）。"
          : "作りませんでした。紹介文（blurb）を作者に見せ、使うかどうかを決めてもらってください。",
    note:
      "拡張機能の［作品紹介文］と同じ組み立て（題・紹介文・感情曲線・各話あらすじ）で、" +
      "設定/synopsis.md が無いときだけ作ります。キャッチコピーは入れていません。" +
      "題は作品フォルダーの名前です。章の見出しは付けていません（拡張機能で設定資料集を出力すると組み直されます）。",
  };
}

/** `chapter_synopses.json` から、各話あらすじと感情曲線の欄を組む（無ければ空） */
function episodeSectionsOf(
  file: string,
  folder: string
): { episodes: string; emotion: string } {
  if (!fs.existsSync(file)) return { episodes: "", emotion: "" };
  let set: ChapterSynopsisSet;
  try {
    // 製品の `SynopsisStore.load` と同じ読み方（文字化けを戻し、重なりを畳む）
    set = parseSynopsisSet(
      JSON.parse(decodeByteFallback(new TextDecoder().decode(fs.readFileSync(file))))
    );
    set = { ...set, episodes: dedupeSynopsisEpisodes(set.episodes).episodes };
  } catch (error) {
    throw new McpToolError(
      `${DEFAULT_SETTINGS_DIR}/${SYNOPSES_FILE} を読めません。紹介文の文書に各話あらすじを載せられないため、` +
        `作るのを中止しました（何も書いていません）: ${describeError(error)}`
    );
  }
  if (set.episodes.length === 0) return { episodes: "", emotion: "" };
  return {
    episodes: buildSynopsisListMarkdown(set, {
      workTitle: workTitleOf(folder),
      headingLevel: 2,
      includeTitle: false,
    }),
    emotion: buildEmotionCurveMarkdown(set.episodes),
  };
}

/* ── 小物 ───────────────────────────────────────────────── */

/** 版の本体（`2.2|reader:none` の `2.2`） */
function baseVersionOf(version: string): string {
  return version.split("|")[0];
}

function labelOf(chapter: number | null, fileName: string): string {
  return chapter !== null ? `第${chapter}話` : fileName;
}

/** 作品フォルダーからの相対。区切りは読みやすいほうへ揃える */
function relativeTo(root: string, target: string): string {
  return nodePath.relative(root, target).split(nodePath.sep).join("/");
}
