import * as fs from "node:fs";
import * as nodePath from "node:path";
import { z } from "zod";
import {
  WORK_CHAT_SCHEMA,
  WORK_CHAT_TEMPERATURE,
  WORK_CHAT_VERSION,
  buildWorkChatPrompt,
  buildWorkChatSystemPrompt,
  parseWorkChatAnswer,
  type WorkChatAnswer,
  type WorkChatInput,
  type WorkChatTurn,
} from "../../prompts/workChat";
import { sanitizeRequestedPaths, type FileHint } from "../../core/chatEdit";
import {
  CHAT_OVERVIEW_DOCUMENTS,
  MAX_REQUESTED_FILES,
  formatChatOverview,
  missingFileHintsFrom,
  readRequestedFiles,
  type RequestedFileAccess,
} from "../../core/chatFileRequest";
import { episodeLabel } from "../../core/episodeLabel";
import { parseEpisodeFileName } from "../../core/episodeParser";
import { parseEpisodeMetadata } from "../../core/metadataParser";
import { parseCollectedFile } from "../../core/collectedFile";
import { isWorkInfoFile } from "../../core/workInfoFile";
import { decodeBytes } from "../../core/textDecode";
import { buildAdvicePolicyPrompt } from "../../prompts/advicePolicy";
import { buildWriterStylePrompt } from "../../prompts/writerStyle";
import { buildReaderTypePrompt } from "../../prompts/readerTarget";
import { scoreAnswers, type AdviceProfile } from "../../core/advicePolicy";
import {
  readAdviceProfile,
  readWriterProfile,
  updateAdviceProfile,
  updateWriterProfile,
} from "../adviceProfileMirror";
// **指紋は `core/hash.ts` から取る**（`core/textFile.ts` の `hashText` は
// `vscode` を引くので、外から呼ぶ束には持ち込めない。設計書6.87.3）
import { hashText } from "../../core/hash";
import {
  buildWriterStyle,
  describeWriterStyleChange,
  WRITER_REVISE_LABELS,
  WRITER_REVISE_STREAK_NEEDED,
} from "../../core/writerStyle";
import { parseCharacter } from "../../models/character";
import { parseLocation } from "../../models/location";
import {
  McpToolError,
  SETTINGS_SUBDIRS,
  listBodyFiles,
  readBody,
  readReaderProfile,
  readSettingsRecords,
  resolveInsideFolder,
  settingsDirOf,
} from "./shared";
import { ollamaGenerate } from "./ollama";
import { askSampling } from "./sampling";
import {
  assertRunner,
  claudeNote,
  temperatureFor,
  type RunnerKind,
  validateWith,
} from "./run";

/**
 * AIへの相談（P-21、設計書6.19）を外から呼ぶ。
 *
 * **チャンクが無いのが、ほかの3機能と違うところ。** 推敲・誤字脱字・矛盾は
 * 本文を切って回すが、相談は「1つの問いに1つの答え」である。だから
 * `chunkId` の往復も要らない。
 *
 * ---
 *
 * **3つの診断のうち、作品フォルダーから読めるのは1つだけである**（0.64.2に
 * 調べた。残り2つは拡張機能の控えから読む）。
 *
 * | 診断 | どこに在るか | MCPから |
 * |---|---|---|
 * | ターゲット読者（P-38） | 作品の `設定/読者像.json` | **読める**（製品と同じファイル） |
 * | 助言方針（P-21） | `globalState`（機械ごと） | **控えを読む**（下記）／答えを渡してもらう |
 * | 執筆スタイル（P-39） | `globalState`（機械ごと） | **控えを読む**（2026-09-23。助言方針と同じ道）／答えを渡してもらう |
 *
 * `globalState` は VS Code の持ち物で、作品フォルダーの外にある。
 * **MCPが読むのは渡された `folder` の配下だけ**（設計書6.87.8の守り③）なので、
 * そこを覗きにいくことはしない。
 *
 * **助言方針だけは、控えを読む**（0.71.x。設計書6.86.7）。答えを渡してもらう
 * 形だと、**9問の点数までは組み立てられても「いまの調子」（受容度・自信度）が
 * 永久に渡らない**——あれは作者に聞かずに相談から推定する値なので、
 * 渡す口そのものが無い。拡張機能が `globalStorageUri` の下（作品フォルダーの
 * 外。作者の目にも Git にも触れない）へ書き出した控えを
 * `mcp/adviceProfileMirror.ts` が読む。**渡された答えのほうが優先**で、
 * 控えも無ければこれまでどおり1字も送らない。
 *
 * **執筆スタイルも控えを読む**（2026-09-23）。以前は明示したときだけ乗り、
 * 相談で読み取った直す時期（`writerStyleSignals`）も書き戻さなかった。
 * 置き場は同じ保管庫の `writer-profile.json`（`core/writerProfileMirror.ts`）。
 *
 * **代わりに「作者が診断で答えたもの」を受け取る。** 内部の保存の形ではなく
 * 答えそのものを受け取り、**製品の関数**（`scoreAnswers`・`buildWriterStyle`）で
 * 組み立てる。写しを置かずに済むうえ、**測るのにいちばん使いやすい**——
 * 「即興派だと答えが変わるか」を、答えを差し替えるだけで試せる。
 *
 * **渡さなければ、その軸は1字も送らない。** これは製品の決まりそのもので
 * （設計書6.90.1）、未診断の作者はまさにその状態である。
 */

const VALIDATE_WITH = validateWith("chat");

/** 相談で渡す材料の上限。**長い作品で本文が押し出されないように** */
const REFERENCE_LIMIT = 60;

/** 本文の抜粋の上限（字）。製品の相談も、開いている画面の一部だけを渡す */
const EXCERPT_LIMIT = 4000;

/*
  **形の定義はここ1か所。** 束ねた道具（`features.ts`）は `options` の中身を
  `z.unknown()` で受けるので、奥へ入れる前にこの形で確かめ直す
  ——写しを持つと、片方だけ緩んだときに**製品では通らない形が MCP では通る。**
*/
export const CHAT_HISTORY_SCHEMA = z.array(
  z.object({
    role: z.enum(["author", "assistant"]),
    text: z.string(),
  })
);

export const CHAT_ADVICE_ANSWERS_SCHEMA = z
  .array(z.number().int().min(0).max(2))
  .length(9);

export const CHAT_WRITER_STYLE_SCHEMA = z.object({
  situation: z.string(),
  plan: z.string(),
  revise: z.string(),
  material: z.string(),
  outlet: z.string(),
});

/** 相談へ足した診断の内訳。**何を送ったのかを、呼ぶ側が読めるように** */
export interface ChatDiagnosisReport {
  advicePolicy: boolean;
  /**
   * 助言方針をどこから取ったか。
   *
   * **中身は返さない**（タイプの方針は systemPrompt に在るが、
   * 受容度・自信度は作者にも見せないと決めたものである。6.86.2）。
   * ここで言うのは出どころだけ——測るときに「渡した答えが効いたのか、
   * 控えが効いたのか」を取り違えないために要る。
   */
  advicePolicySource?: "input" | "mirror";
  writerStyle: boolean;
  /** 執筆スタイルをどこから取ったか（渡された答えか、拡張機能の控えか） */
  writerStyleSource?: "input" | "mirror";
  readerType: boolean;
  /** 送らなかった軸と、その理由 */
  omitted: string[];
}

export interface ChatPromptResult {
  promptVersion: string;
  systemPrompt: string;
  schema: unknown;
  /** 製品が相談で使う温度（`prompts/workChat.ts`）。**写しを持たない** */
  temperature: number;
  validateWith: string;
  userPrompt: string;
  /** 材料として添えた語（登場人物・場所の名前）。`overview` を渡すと全体像の塊が先頭に入る */
  reference: string[];
  /** 作品の全体像（話の一覧・紹介文・プロット）を添えたか */
  overview: boolean;
  diagnoses: ChatDiagnosisReport;
}

export interface ChatPromptInput {
  folder: string;
  question: string;
  filePath?: string;
  history?: WorkChatTurn[];
  adviceAnswers?: number[];
  writerStyle?: Record<string, unknown>;
  featureIndex?: boolean;
  /**
   * 作品の全体像（話の一覧と各話のファイルの場所・紹介文・プロット）を添えるか。
   *
   * **既定は添えない**（これまでどおり）。製品の相談は作品のファイルを
   * 開いているときに必ず添えるが、MCP は材料を絞って測る口として作って
   * きたので、既定を変えると過去の測定と比べられなくなる。製品と同じ
   * 材料で測りたいときに `true` を渡す。組み方は製品と同じ
   * （`core/chatFileRequest.ts` の `formatChatOverview`）。
   */
  overview?: boolean;
}

/**
 * 聞き直しの回にだけ足す材料（`chatRun` が使う）。
 *
 * 形は製品の相談パネルが2回目に渡すものと同じ（`WorkChatInput` の
 * `requestedFiles`・`missingFiles`）。
 */
export interface ChatFollowUpMaterial {
  requestedFiles?: WorkChatInput["requestedFiles"];
  missingFiles?: WorkChatInput["missingFiles"];
}

/**
 * 診断の3つを、製品と同じ順で組み立てる。
 *
 * **順も製品のまま**（`features/workChatPanel.ts` の `buildSystemPrompt`）
 * ——助言方針 → 執筆スタイル → ターゲット読者。順を変えると、
 * 同じ材料でも答えが変わりうる。
 */
function buildDiagnosisBlocks(
  folder: string,
  input: ChatPromptInput,
  now: Date
): { blocks: string[]; report: ChatDiagnosisReport } {
  const blocks: string[] = [];
  const omitted: string[] = [];
  const report: ChatDiagnosisReport = {
    advicePolicy: false,
    writerStyle: false,
    readerType: false,
    omitted,
  };

  if (input.adviceAnswers) {
    // **明示が最優先。** 控えがあっても上書きしない——答えを差し替えて
    // 測る道（「即興派だと答えが変わるか」）を潰さないため
    const profile: AdviceProfile = {
      scores: scoreAnswers(input.adviceAnswers),
      answers: [...input.adviceAnswers],
      updatedAt: now.toISOString(),
    };
    blocks.push(buildAdvicePolicyPrompt(profile, now));
    report.advicePolicy = true;
    report.advicePolicySource = "input";
  } else {
    // **渡されなければ、拡張機能が書き出した控えを見る**（設計書6.86.7）。
    // ここで初めて「いまの調子」（受容度・自信度）が外からの相談にも効く
    const stored = readAdviceProfile(folder);
    if (stored) {
      blocks.push(buildAdvicePolicyPrompt(stored, now));
      report.advicePolicy = true;
      report.advicePolicySource = "mirror";
    } else {
      // **黙って省かない。** 診断していないのか、控えが届いていないのかは
      // ここでは見分けられないので、両方の直し方を並べる
      omitted.push(
        "助言方針（adviceAnswers を渡すか、拡張機能で診断すると足します）"
      );
    }
  }

  if (input.writerStyle) {
    const style = buildWriterStyle(input.writerStyle);
    if (style) {
      blocks.push(
        buildWriterStylePrompt({ style, updatedAt: now.toISOString() })
      );
      report.writerStyle = true;
      report.writerStyleSource = "input";
    } else {
      // **知らない値は受け取らない**（`buildWriterStyle` の約束）。
      // 黙って既定へ倒さず、足さなかったことを言う
      omitted.push("執筆スタイル（選択肢に無い値が混ざっていました）");
    }
  } else {
    // **渡されなければ、拡張機能が書き出した控えを見る**（2026-09-23。
    // 助言方針と同じ道）。以前は明示したときしか乗らなかった
    const stored = readWriterProfile();
    if (stored) {
      blocks.push(buildWriterStylePrompt(stored));
      report.writerStyle = true;
      report.writerStyleSource = "mirror";
    } else {
      omitted.push(
        "執筆スタイル（writerStyle を渡すか、拡張機能で作家タイプ診断をすると足します）"
      );
    }
  }

  const readerProfile = readReaderProfile(folder);
  const readerBlock = buildReaderTypePrompt(readerProfile);
  if (readerBlock) {
    blocks.push(readerBlock);
    report.readerType = true;
  } else {
    omitted.push("ターゲット読者（設定/読者像.json に宣言がありません）");
  }

  return { blocks, report };
}

/**
 * 材料（登場人物・場所の名前）。
 *
 * **製品の相談は、開いている画面に応じて材料を詰める。** ここは外から
 * 呼ぶ口なので、**作品に居る人物と場所の名前**という、いちばん外さない
 * ところに絞る。意味検索（RAG）は使わない——あれは索引を作ってあることが
 * 前提で、索引は作品フォルダーの外に在る。
 */
function collectReference(folder: string): string[] {
  const people = readSettingsRecords(
    folder,
    SETTINGS_SUBDIRS.characters,
    parseCharacter
  );
  const places = readSettingsRecords(
    folder,
    SETTINGS_SUBDIRS.locations,
    parseLocation
  );
  return [
    ...people.records.map((record) => `登場人物: ${record.name}`),
    ...places.records.map((record) => `場所: ${record.name}`),
  ].slice(0, REFERENCE_LIMIT);
}

/**
 * 話の一覧（作品フォルダーからの相対パスと表示名）。**全体像の話の一覧と、
 * 見つからなかったときの候補は、この1つから作る**（製品の相談パネルと同じ約束）。
 *
 * 表示名は製品と同じ関数（`core/episodeLabel.ts` の `episodeLabel`）で付ける。
 * 製品の走査（`core/scanner.ts`）は `vscode` を引くので使えず、走査が使う
 * 部品（ファイル名の解析・頭書き・合本の分け方）を直に通す（`workScan.ts` と同じ考え）。
 * 並びは名前順（製品は話数順に並べ直す。候補は番号の近いものを先に選ぶので、
 * 選ばれるものは変わらない）。
 *
 * 作品情報（`about.txt`）は話ではないので入れない。読めないファイルは
 * 名前だけで並べる（製品も読めないファイルを0字の話として一覧に残す）。
 */
export function episodeHintsOf(folder: string): FileHint[] {
  let files: string[];
  try {
    files = listBodyFiles(folder);
  } catch {
    return [];
  }
  const hints: FileHint[] = [];
  for (const relative of files) {
    const fileName = nodePath.basename(relative);
    const parsed = parseEpisodeFileName(fileName);
    let metaTitle: string | null = null;
    let chapterStart = parsed.chapterStart;
    let chapterEnd = parsed.chapterEnd;
    try {
      const text = decodeBytes(
        fs.readFileSync(resolveInsideFolder(folder, relative))
      ).text;
      if (isWorkInfoFile(fileName, text)) continue;
      metaTitle = parseEpisodeMetadata(text).title;
      // 合本はファイル名から話数を取れない。中の各話から範囲を読む（製品の走査と同じ）
      const chapters = (parseCollectedFile(text) ?? [])
        .map((episode) => episode.chapter)
        .filter((chapter): chapter is number => chapter !== null);
      if (chapters.length > 0) {
        chapterStart = Math.min(...chapters);
        chapterEnd = Math.max(...chapters);
      }
    } catch {
      // 読めなくても、ファイル名だけで並べる
    }
    hints.push({
      path: relative.split(nodePath.sep).join("/"),
      label: episodeLabel({
        fileName,
        metaTitle,
        subtitle: parsed.subtitle ?? metaTitle,
        kind: parsed.kind,
        chapterStart,
        chapterEnd,
      }),
    });
  }
  return hints;
}

/** 作品の全体像（製品と同じ組み方）。材料が何も無ければ undefined */
function overviewOf(folder: string): string | undefined {
  const settings = settingsDirOf(folder);
  const documents: Array<{ label: string; file: string; text: string }> = [];
  for (const document of CHAT_OVERVIEW_DOCUMENTS) {
    if (!settings) break;
    try {
      const text = decodeBytes(
        fs.readFileSync(nodePath.join(settings, document.file))
      ).text.trim();
      if (text) documents.push({ ...document, text });
    } catch {
      // 無い文書は載せないだけ（製品と同じ）
    }
  }
  return formatChatOverview({ episodes: episodeHintsOf(folder), documents });
}

/**
 * AIが求めたファイルを、作品フォルダーの中からだけ読む口（`RequestedFileAccess`）。
 *
 * **外を指す指定は読まない**（`resolveInsideFolder`。`sanitizeRequestedPaths` を
 * 通したあとでも、解決したパスをもう一度確かめる。製品の `isPathInside` と同じ役）。
 * 文字コードは製品の読み方（`decodeBytes`。MCP の読み方の決まり、6.87.8 の7）。
 */
function folderAccess(folder: string): RequestedFileAccess {
  const inside = (relative: string): string | undefined => {
    try {
      return resolveInsideFolder(folder, relative);
    } catch {
      return undefined;
    }
  };
  return {
    readText: async (relative) => {
      const target = inside(relative);
      if (!target) return undefined;
      try {
        return decodeBytes(fs.readFileSync(target)).text;
      } catch {
        return undefined;
      }
    },
    siblingNames: async (relative) => {
      const target = inside(relative);
      if (!target) return undefined;
      try {
        return fs
          .readdirSync(nodePath.dirname(target), { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name);
      } catch {
        return undefined;
      }
    },
  };
}

export function chatPrompt(
  input: ChatPromptInput,
  followUp: ChatFollowUpMaterial = {}
): ChatPromptResult {
  const now = new Date();
  const { blocks, report } = buildDiagnosisBlocks(input.folder, input, now);

  // **目次は既定で入れない。** 入れると「操作の話」へ寄りやすく、
  // 作品の相談の出来ばえを測るのに邪魔になる（製品は画面から渡す）
  const base = buildWorkChatSystemPrompt({
    featureIndex: input.featureIndex === true,
  });
  const systemPrompt =
    blocks.length === 0 ? base : `${base}\n\n${blocks.join("\n\n")}`;

  let excerpt = "";
  let truncated = false;
  if (input.filePath) {
    const text = readBody(input.folder, input.filePath);
    truncated = text.length > EXCERPT_LIMIT;
    excerpt = truncated ? text.slice(0, EXCERPT_LIMIT) : text;
  }

  // 全体像は製品と同じく材料の先頭に置く（`buildReference` の並び）
  const overview = input.overview === true ? overviewOf(input.folder) : undefined;
  const reference = [
    ...(overview ? [overview] : []),
    ...collectReference(input.folder),
  ];

  return {
    promptVersion: WORK_CHAT_VERSION,
    systemPrompt,
    schema: WORK_CHAT_SCHEMA,
    temperature: WORK_CHAT_TEMPERATURE,
    validateWith: VALIDATE_WITH,
    userPrompt: buildWorkChatPrompt({
      workTitle: input.folder.split(/[\\/]/).filter(Boolean).pop() ?? "",
      contextKind: input.filePath ? "manuscript" : "outside",
      contextLabel: input.filePath ?? "作品のファイル以外",
      excerpt,
      excerptTruncated: truncated,
      fromSelection: false,
      reference,
      requestedFiles: followUp.requestedFiles,
      missingFiles: followUp.missingFiles,
      history: input.history ?? [],
      question: input.question,
    }),
    reference,
    overview: overview !== undefined,
    diagnoses: report,
  };
}

export interface ChatValidateResult {
  answer: WorkChatAnswer;
  /**
   * 書き込みや実行の提案が入っていたか。
   *
   * **MCPは実行しない**（設計書6.87.7「原稿を書き換える操作を外へ出さない」）。
   * 入っていたことだけを知らせる——提案の中身は `answer` にそのまま在る。
   */
  proposals: { edit: boolean; run: boolean; reloadRecord: boolean };
  /**
   * 助言方針の控えを書き戻したときの一言。
   *
   * **黙って隠さない**（作者の機械の記録を、外からの相談が静かに書き換える
   * ことになるため）。**ただし中身は言わない**——受容度・自信度は
   * 作者にも操作ログにも出さないと決めたもの（6.86.2、`advicePolicyLogLines`）で、
   * MCP の返事から漏れては意味がない。
   */
  adviceProfileNote?: string;
  /**
   * 執筆スタイル（直す時期）の控えを書き戻したときの一言。
   *
   * **こちらは中身を言う。** 直す時期は作者自身が5問で答えた値で、
   * 作者に見せている（受容度・自信度とは扱いが違う）。黙って書き換えると、
   * 案内の並びが変わった理由が作者に分からない（設計書6.90.1「変わったら
   * 必ず見せる」）。
   */
  writerStyleNote?: string;
}

/**
 * 応答を読み解く。
 *
 * **JSONとして読めなくても止めない。** 製品の `parseWorkChatAnswer` は、
 * 読めなかったときに**本文をそのまま `reply` にする**——相談は
 * 「形が合っているか」より「作者に答えが届くか」が大事な機能で、
 * AIが素の文で返したからといって答えを捨てない作りになっている。
 *
 * **ここで自前の門番を足さない。** 足すと「製品では読める応答が
 * MCPでは捨てられる」という差ができ、測ったものが製品の姿でなくなる
 * （設計書6.87.6 の3と同じ理由）。
 *
 * **`profileSignals` はここで拾う**（0.71.x。設計書6.86.7）。製品は
 * `workChatPanel.updateAdvicePolicy` で拾っており、ここが拾わないと
 * **外部AI経由の相談だけ、調子の推定が永久に更新されない。**
 * 値の形を絞るのは `parseWorkChatAnswer`（`parseProfileSignals`）、
 * 点数の動かし方は `applyProfileSignals` で、どちらも製品と同じものを通る。
 */
export function chatValidate(input: {
  response: string;
  /** 控えの書き戻し先。**省くと書き戻さない**（読み解くだけ） */
  folder?: string;
}): ChatValidateResult {
  const answer = parseWorkChatAnswer(input.response);
  const result: ChatValidateResult = {
    answer,
    proposals: {
      edit: answer.edit !== undefined && answer.edit !== null,
      run: answer.run !== undefined && answer.run !== null,
      reloadRecord:
        answer.reloadRecord !== undefined && answer.reloadRecord !== null,
    },
  };

  if (input.folder && answer.profileSignals) {
    /*
      方針がどこにも無ければ何も起きない（"absent"）。診断していない作者の
      値を、推定で生やさないため（製品の `updateAdvicePolicy` と同じ）。

      **応答の指紋を渡す。** 外部AIは `novel.validate` を撃ち直せるので、
      渡さないと同じ答えで ±0.5 が2回効き、**「段階が1つ動くまでおおよそ
      10回の相談が要る」という歯止めが撃ち直しで迂回できる。**
    */
    const outcome = updateAdviceProfile(
      input.folder,
      answer.profileSignals,
      hashText(input.response)
    );
    if (outcome === "updated") {
      result.adviceProfileNote =
        "助言方針の推定を更新しました（内訳は出しません）。";
    } else if (outcome === "duplicate") {
      // **黙って無視しない。** 撃ち直したことを伝えないと、効かなかったのが
      // 二重取りの歯止めなのか、別の失敗なのかが呼ぶ側に分からない
      result.adviceProfileNote =
        "この答えの推定は反映済みです（同じ答えは二度効かせません）。";
    }
  }

  /*
    **直す時期の読み取り（`writerStyleSignals`）も書き戻す**（2026-09-23）。
    製品は `workChatPanel.updateWriterStyle` で拾っており、ここが拾わないと
    外部AI経由の相談だけ、作者の語った直し方が永久に反映されない。

    歯止めは製品と同じ（2回続けて同じに読めたときだけ動く）。**変わったら
    必ず見せる**——助言方針と違い、執筆スタイルは作者に見せている値なので、
    何が何へ変わったか・どう戻すかまで返す（`describeWriterStyleChange`）。
  */
  if (input.folder && answer.writerStyleSignals) {
    const update = updateWriterProfile(
      answer.writerStyleSignals,
      hashText(input.response)
    );
    if (update.outcome === "updated") {
      result.writerStyleNote = describeWriterStyleChange(
        update.before,
        update.after
      );
    } else if (update.outcome === "counted" && update.after.reviseStreak) {
      const streak = update.after.reviseStreak;
      result.writerStyleNote =
        `直す時期を「${WRITER_REVISE_LABELS[streak.value]}」と読み取りました` +
        `（${streak.count}回目。${WRITER_REVISE_STREAK_NEEDED}回続けて読み取れたら反映します）。`;
    } else if (update.outcome === "duplicate") {
      result.writerStyleNote =
        "この答えの直す時期の読み取りは反映済みです（同じ答えは二度効かせません）。";
    }
  }

  return result;
}

export interface ChatRunInput extends ChatPromptInput {
  runner: RunnerKind;
  endpoint?: string;
  model?: string;
  allowRemote?: boolean;
  temperature?: number;
  numCtx?: number;
}

/**
 * 1往復目でAIがファイルを求めたときの、聞き直しの記録（0.85.1）。
 *
 * **測るために全部返す。** 製品の相談パネルは、読めたファイルと見つから
 * なかったファイルを記録（`chat.md`）へ残し、画面にも「読んでいます」と
 * 出す。外から測るときも、何を求められ、何を渡し、何が無かったかが
 * 分からないと、2往復目の答えの良し悪しを読めない。
 */
export interface ChatFollowUp {
  /** 1往復目の答え（`reply`）。作者の画面には出ない回の答え */
  firstReply: string;
  /** 1往復目でAIが求めたもの（AIが書いたまま。文字列だけ） */
  requested: string[];
  /** そのうち読みに行ったもの（製品と同じ関門 `sanitizeRequestedPaths` を通したあと。最大3件） */
  needFiles: string[];
  /** 読めたファイル（拡張子違いを引き当てたときは、実際に読んだほうの場所） */
  readFiles: string[];
  /** 見つからなかったファイル */
  missingFiles: string[];
  /** 見つからなかったときにAIへ示した、作品にあるファイルの候補 */
  hints: FileHint[];
  /**
   * 2往復目でもAIがファイルを求めたか。**もう読まない**（製品も聞き直しは
   * 1回だけ）。求めていたら、その回の答えは材料が足りないまま書かれている
   */
  askedAgain: string[];
}

export type ChatRunResult =
  | {
      runner: "claude";
      note: string;
      systemPrompt: string;
      userPrompt: string;
      schema: unknown;
      temperature: number;
      validateWith: string;
      diagnoses: ChatDiagnosisReport;
    }
  | {
      runner: "ollama";
      model: string;
      temperature: number;
      diagnoses: ChatDiagnosisReport;
      /** 最後の答え（聞き直したなら2往復目）を検算したもの */
      result: ChatValidateResult;
      /** 聞き直したときだけ入る。聞き直さなかった回は null */
      followUp: ChatFollowUp | null;
    }
  | {
      /** 呼び出し元に考えてもらった（設計書6.87.12） */
      runner: "sampling";
      /** 答えたモデル。**こちらでは選べない** */
      model: string;
      temperature: number;
      diagnoses: ChatDiagnosisReport;
      /** 最後の答え（聞き直したなら2往復目）を検算したもの */
      result: ChatValidateResult;
      /** 聞き直したときだけ入る。聞き直さなかった回は null */
      followUp: ChatFollowUp | null;
    };

/** AIへ1回尋ねて、答えの本文と答えたモデルを返す（`runner` ごとの違いはここだけ） */
type AskOnce = (userPrompt: string) => Promise<{ text: string; model: string }>;

/**
 * 尋ね、ファイルを求められたら読んで**1回だけ**聞き直す（製品の相談パネルと同じ流れ）。
 *
 * - 読み方・拡張子違いの引き当て・長さの上限・見つからなかったときの候補は、
 *   製品と同じ core の部品（`core/chatFileRequest.ts`）を通す
 * - **1つも読めなくても聞き直す**（0.84.7 の製品と同じ）。見つからなかったことと
 *   候補を渡して、同じ1回の枠の中で答えさせる
 * - 検算（`chatValidate`）と控えの書き戻しは**最後の答えにだけ**掛ける。
 *   製品も、作者に見せた答え（2往復目）からだけ推定を拾う
 */
async function askWithFollowUp(
  input: ChatRunInput,
  prompt: ChatPromptResult,
  ask: AskOnce
): Promise<{
  model: string;
  result: ChatValidateResult;
  followUp: ChatFollowUp | null;
}> {
  const first = await ask(prompt.userPrompt);
  const firstAnswer = parseWorkChatAnswer(first.text);
  const wanted = sanitizeRequestedPaths(firstAnswer.needFiles, MAX_REQUESTED_FILES);
  if (wanted.length === 0) {
    return {
      model: first.model,
      result: chatValidate({ folder: input.folder, response: first.text }),
      followUp: null,
    };
  }

  const { files, missing } = await readRequestedFiles(wanted, folderAccess(input.folder));
  const hints =
    missing.length > 0
      ? missingFileHintsFrom(missing, episodeHintsOf(input.folder))
      : undefined;
  const again = chatPrompt(input, {
    requestedFiles: files,
    missingFiles: hints ? { paths: missing, ...hints } : undefined,
  });
  const second = await ask(again.userPrompt);
  const result = chatValidate({ folder: input.folder, response: second.text });

  return {
    model: second.model,
    result,
    followUp: {
      firstReply: firstAnswer.reply,
      requested: Array.isArray(firstAnswer.needFiles)
        ? firstAnswer.needFiles.filter(
            (entry): entry is string => typeof entry === "string"
          )
        : [],
      needFiles: wanted,
      readFiles: files.map((file) => file.path),
      missingFiles: missing,
      hints: hints?.available ?? [],
      askedAgain: sanitizeRequestedPaths(result.answer.needFiles, MAX_REQUESTED_FILES),
    },
  };
}

export async function chatRun(input: ChatRunInput): Promise<ChatRunResult> {
  // **省略を既定で埋めない**（設計書6.87.8 の5）
  assertRunner(input.runner);
  const prompt = chatPrompt(input);
  // **明示が無ければ製品と同じ**（6.87.16）。決め方は `run.ts` に1つだけ
  const temperature = temperatureFor(input, prompt.temperature);

  if (input.runner === "claude") {
    // **この道は1往復だけ**（プロンプトを返すだけで、答えはこちらに来ない）。
    // 聞き直すなら、呼び出し元が求められたファイルを filePath で渡して呼び直す
    return {
      runner: "claude",
      note: claudeNote(VALIDATE_WITH),
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      schema: prompt.schema,
      temperature,
      validateWith: VALIDATE_WITH,
      diagnoses: prompt.diagnoses,
    };
  }

  if (input.runner === "sampling") {
    // **呼び出し元に考えてもらい、検算まで通す**（設計書6.87.12）
    const done = await askWithFollowUp(input, prompt, async (userPrompt) => {
      const reply = await askSampling({
        folder: input.folder,
        systemPrompt: prompt.systemPrompt,
        userPrompt,
        temperature,
      });
      return { text: reply.text, model: reply.model };
    });
    return {
      runner: "sampling",
      model: done.model,
      temperature,
      diagnoses: prompt.diagnoses,
      result: done.result,
      followUp: done.followUp,
    };
  }

  const model = input.model;
  if (!model) {
    throw new McpToolError("runner が ollama のときは model が要ります。");
  }
  const done = await askWithFollowUp(input, prompt, async (userPrompt) => {
    const response = await ollamaGenerate({
      endpoint: input.endpoint,
      model,
      systemPrompt: prompt.systemPrompt,
      userPrompt,
      schema: prompt.schema,
      numCtx: input.numCtx ?? 16384,
      temperature,
      allowRemote: input.allowRemote,
    });
    return { text: response.text, model };
  });

  return {
    runner: "ollama",
    model,
    temperature,
    diagnoses: prompt.diagnoses,
    result: done.result,
    followUp: done.followUp,
  };
}
