import * as vscode from "vscode";
import type { WorkAnnounceConfig, WorkEntry } from "../models/types";
import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_MANUSCRIPT_DIR,
  DEFAULT_SETTINGS_DIR,
} from "../models/types";
import { AIRegistry, ensureConfigured } from "../ai/registry";
import { confirmProviderReachable } from "./aiConnectivity";

import { OUTPUT_RESERVE_TOKENS } from "../ai/contextGuard";
import { scanWork } from "../core/scanner";
import { loadEpisodeBodies, type EpisodeBody } from "../core/episodeBodies";
import { readWorkFormat } from "../core/workFormatStore";
import type { WorkFormatKey } from "../core/workFormat";
import { SynopsisStore } from "../core/synopsisStore";
import { AnnouncementHistory } from "../core/announcementHistory";
import {
  announceEpisodeLabel,
  ANNOUNCEMENT_COPY_LABELS,
  buildAnnouncementMarkdown,
  composeXPost,
  remainingCopyChoices,
  validateAnnouncement,
  xWeightedLength,
  type AnnouncementCopyKind,
} from "../core/announcement";
import { readWorkConfig, writeWorkConfig } from "../core/workRegistry";
import { stripCodeFence } from "../core/synopsisValidation";
import {
  ANNOUNCE_SCHEMA,
  ANNOUNCE_SYSTEM_PROMPT,
  BODY_TRUNCATED_MARK,
  buildAnnouncePrompt,
  type AnnounceResult,
} from "../prompts/announce";
import {
  describeChunkSettings,
  readChunkSettings,
  resolveModelInfoOrWarn,
} from "./chunkSettings";
import { readSynopsisDoc } from "./generateBlurb";
import { withCancellableProgress } from "../views/progress";
import { reportAIError } from "./reportAIError";
import { openGeneratedMarkdown } from "../views/openDocument";
import { logFailure, logStep, showLog, useLogFile } from "../core/logger";
import { askText, cancelItem, isCancelItem } from "../views/dialogs";

/**
 * 更新告知文（P-30、設計書6.41）。
 *
 * 話を公開したときの告知を、X用・活動報告用・後書き用の3種つくる。
 *
 * **投稿サイトへは書き込まない。** 作るのは文章だけで、貼るのは作者である。
 * **設定資料にも書き込まない**——読者に見せる文章に正解は無いので、
 * 紹介文（P-06）と同じく見せてコピーさせるだけにしてある。
 */

export async function generateAnnouncement(
  work: WorkEntry,
  registry: AIRegistry
): Promise<void> {
  useLogFile(work.folderPath);
  const resolved = await ensureConfigured(registry, "generate");
  if (!resolved) return;

  // **設定が無いまま作らせない。** ハッシュタグとURLは告知のたびに要るもので、
  // 後から気づいて貼り直すくらいなら、最初の一度だけ訊いたほうが早い。
  // 空のまま進んでもよい（URLは目印のまま残る）
  const announce = await ensureAnnounceConfig(work);
  if (!announce) return;

  const picked = await pickEpisode(work);
  if (!picked) return;

  const material = await collectMaterial(work, picked.episode, picked.format);

  // **繋がるかを、費用の確認より先に確かめる**（設計書6.51）。
  // 繋がらないと分かっているのに料金の話をしても意味がない。
  // 話を選ばずに抜けた回（上で return する）はAIを呼ばないので、ここに置く。
  // このあとの `resolveModelInfo` も、止まったままでは申告値を取れず
  // 既定の8192へ落ちてしまう——本文が黙って短く切られる。
  // モデル名を渡すのは、LM Studioをこの場から起こしたときの読み込みに要るため
  if (
    !(await confirmProviderReachable(
      resolved.provider,
      "更新告知文の作成",
      resolved.model
    ))
  ) {
    return;
  }

  const costNotice = resolved.provider.isPaid
    ? `\n${resolved.provider.displayName} は呼び出すたびに課金されます。`
    : "";
  const confirm = await vscode.window.showInformationMessage(
    `更新告知文を作ります（AIの呼び出しは1回）。\nモデル: ${resolved.model}${costNotice}`,
    "実行",
    "中止"
  );
  if (confirm !== "実行") return;

  // **本文を空にしてプロンプトを組み、その字数を固定費とする**（設計書6.27.10）。
  // 紹介文・前の話のあらすじ・前に出した告知は作品が育つほど伸びる。
  // 固定の字数で本文を切ると、伸びた分だけ本文の後半が黙って捨てられる
  const overheadChars =
    ANNOUNCE_SYSTEM_PROMPT.length +
    buildAnnouncePrompt({ ...material.prompt, bodyExcerpt: "" }).length;
  // **黙って8,192へ落とさない**（設計書6.64）。取れないまま進むと本文の
  // 切り出しが実際より短くなる。手順は5機能と同じ共通の1か所に寄せる
  const info = await resolveModelInfoOrWarn({
    registry,
    feature: "generate",
    provider: resolved.provider,
    model: resolved.model,
    actionLabel: "更新告知文の生成",
  });
  if (!info) return;
  const chunkSettings = readChunkSettings(info.contextWindow, {
    overheadChars,
    outputTokens: OUTPUT_RESERVE_TOKENS,
  });
  const budgetChars = chunkSettings.chunk.chars;

  // **頭から詰める。** 告知が示すのは今回の話の「入口」なので、
  // 足りないときに削るのは末尾でよい。切ったことはAIへも伝える
  const truncated = material.body.length > budgetChars;
  const bodyExcerpt = truncated
    ? `${material.body.slice(0, budgetChars)}\n${BODY_TRUNCATED_MARK}`
    : material.body;

  // **何を根拠に何字で切ったかを残す**（誤字脱字・推敲・矛盾・伏線と同じ形）。
  // 残さないと、告知が話の前半しか見ていない理由を後から追えない
  logStep(
    `更新告知のチャンク: ${describeChunkSettings(chunkSettings)}` +
      `／本文 ${material.body.length}字（${
        truncated ? `${budgetChars}字で切った` : "全文を送る"
      }）`
  );

  const response = await withCancellableProgress(
    "更新告知文を作っています",
    async (_progress, token) => {
      // **中止ボタンをAIまで届かせる。** 受け取らないと、ボタンは出るのに
      // 押しても何も起きない（有料AIでは課金が続く）。0.28.3
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      try {
        return await resolved.provider.generate({
          systemPrompt: ANNOUNCE_SYSTEM_PROMPT,
          userPrompt: buildAnnouncePrompt({ ...material.prompt, bodyExcerpt }),
          model: resolved.model,
          // 読ませる文章なので、抽出より少し揺らす（紹介文と同じ）
          temperature: 0.5,
          jsonSchema: ANNOUNCE_SCHEMA as unknown as object,
          disableThinking: true,
          signal: controller.signal,
          meta: { feature: "announce", workFolder: work.folderPath },
        });
      } catch (error) {
        // **関所（`ai/meteredProvider.ts`）で止まった場合もここへ来る。**
        // 再試行の梯子は組まない——1回呼びの機能なので、次の操作を
        // 示して作者に決めてもらうほうが早い
        reportAIError("更新告知文の生成", error);
        return undefined;
      }
    }
  );
  if (!response) return;

  const parsed = parseAnnounceResponse(response.text);
  if (!parsed) {
    logFailure("更新告知文の生成", {
      理由: "応答を読み取れません",
      応答: response.text.slice(0, 400),
    });
    vscode.window
      .showWarningMessage("応答を読み取れませんでした。", "ログを見る")
      .then((answer) => {
        if (answer === "ログを見る") showLog();
      });
    return;
  }

  const composedX = composeXPost({
    body: parsed.xPost,
    episodeLabel: material.episodeLabel,
    hashtags: announce.hashtags,
    workUrl: announce.workUrl,
  });
  // **注意が出ても切り詰めない。** そのまま見せて作者に判断させる
  const warnings = validateAnnouncement(parsed, composedX);

  // **採用したかどうかに関わらず覚える。** 目的は「同じ言い回しを避ける」
  // ことなので、貼らなかった案も次は避ける対象になる
  await new AnnouncementHistory(work).add([parsed.xPost]);

  const markdown = buildAnnouncementMarkdown({
    workTitle: work.title,
    episodeLabel: material.episodeLabel,
    composedX,
    weightedLength: xWeightedLength(composedX),
    activityReport: parsed.activityReport,
    afterword: parsed.afterword,
    spoilerCheck: parsed.spoilerCheck,
    warnings,
  });
  await openGeneratedMarkdown("更新告知文", markdown, undefined, { work });

  await offerCopies(
    {
      x: composedX,
      activityReport: parsed.activityReport,
      afterword: parsed.afterword,
    },
    warnings.length
  );
}

/**
 * 3種を、作者が閉じるまで何度でもコピーさせる。
 *
 * **1回で終わらせない。** 作者はたいていX用と活動報告用の両方を貼るので、
 * 1つ選んだ時点で通知が消えると、残りは開いた文書から手で拾うことになる。
 *
 * **modal にしない。** 開いた文書を見ながら押せるようにするため。
 * **ここで文章を作り直さない。** AIも呼ばない——コピーの入口を出すだけである。
 */
async function offerCopies(
  texts: Record<AnnouncementCopyKind, string>,
  warningCount: number
): Promise<void> {
  const copied = new Set<AnnouncementCopyKind>();

  for (;;) {
    const choices = remainingCopyChoices(copied);
    if (choices.length === 0) return; // 3つとも押した

    const answer = await vscode.window.showInformationMessage(
      copyPromptMessage(copied, warningCount),
      ...choices.map((choice) => choice.label)
    );
    // 閉じられた（Esc・×）。押し続けさせない
    if (answer === undefined) return;

    const chosen = choices.find((choice) => choice.label === answer);
    if (!chosen) return;
    await vscode.env.clipboard.writeText(texts[chosen.kind]);
    copied.add(chosen.kind);
  }
}

/**
 * 通知の文言。**押した種類は文の中で伝える。**
 *
 * ボタンとして残すと押せてしまい、「押したのに効いていない」ように見える
 * （通知は押した記録を持たない）。
 */
function copyPromptMessage(
  copied: ReadonlySet<AnnouncementCopyKind>,
  warningCount: number
): string {
  if (copied.size > 0) {
    const done = [...copied]
      .map((kind) => ANNOUNCEMENT_COPY_LABELS[kind].replace("をコピー", ""))
      .join("・");
    return `${done} をコピーしました。続けてコピーできます`;
  }
  return warningCount > 0
    ? `更新告知文ができました（気になる点が ${warningCount} 件あります）`
    : "更新告知文ができました";
}

/**
 * 告知の設定（ハッシュタグ・URL）を訊いて保存する。
 *
 * メニューからも呼べるし、告知文を作るときに未設定なら先にここへ来る。
 * 取りやめられたら undefined を返す。
 */
export async function configureAnnouncement(
  work: WorkEntry
): Promise<WorkAnnounceConfig | undefined> {
  const config = await readWorkConfig(work);
  const current = config?.announce;

  const hashtagsInput = await askText({
    title: `${work.title} の告知に付けるハッシュタグ`,
    value: current?.hashtags.join(" ") ?? "",
    prompt: "空白で区切って並べます。「#」は無くても付けます。空のままでも構いません",
    ignoreFocusOut: true,
  });
  // **Esc（undefined）と空文字を分ける。** 空文字は「タグを付けない」
  // という作者の指定で、Esc は「やめる」である
  if (hashtagsInput === undefined) return undefined;

  const workUrlInput = await askText({
    title: `${work.title} の作品ページのURL`,
    value: current?.workUrl ?? "",
    prompt: "告知の末尾に付けます。空のままなら告知文に目印（{URL}）を残します",
    ignoreFocusOut: true,
  });
  if (workUrlInput === undefined) return undefined;

  const next: WorkAnnounceConfig = {
    // 形を揃えるのは `parseWorkConfig`。ここで先に整えると規則が2か所になる
    hashtags: hashtagsInput.split(/\s+/u).filter(Boolean),
    workUrl: workUrlInput.trim(),
  };

  try {
    // **他の欄を落とさない。** 読んだ設定へ `announce` だけを重ねる。
    // 設定ファイルがまだ無い作品もあるので、そのときは既定で作る
    await writeWorkConfig(work, {
      schemaVersion: config?.schemaVersion ?? CONFIG_SCHEMA_VERSION,
      workTitle: config?.workTitle ?? work.title,
      manuscriptDir: config?.manuscriptDir ?? DEFAULT_MANUSCRIPT_DIR,
      settingsDir: config?.settingsDir ?? DEFAULT_SETTINGS_DIR,
      createdAt: config?.createdAt ?? work.registeredAt,
      announce: next,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logFailure("告知の設定の保存", { 詳細: detail });
    vscode.window.showWarningMessage(`告知の設定を保存できませんでした: ${detail}`);
    return undefined;
  }

  // 保存した形（`#` を補ったもの）を返す。画面と保存内容を食い違わせない
  const saved = (await readWorkConfig(work))?.announce;
  return saved ?? next;
}

/** 設定済みならそれを、未設定なら訊いてから返す */
async function ensureAnnounceConfig(
  work: WorkEntry
): Promise<WorkAnnounceConfig | undefined> {
  const existing = (await readWorkConfig(work))?.announce;
  if (existing) return existing;
  return configureAnnouncement(work);
}

interface PickedEpisode {
  episode: EpisodeBody;
  format: WorkFormatKey | undefined;
}

/** どの話の告知を作るかを選ばせる */
async function pickEpisode(
  work: WorkEntry
): Promise<PickedEpisode | undefined> {
  const scan = await scanWork(work);
  if (scan.episodes.length === 0) {
    vscode.window.showWarningMessage("本文ファイルが見つかりません。");
    return undefined;
  }

  // 合本（1ファイルに複数話）も話ごとに分かれて返る経路を通す。
  // シーンメモ（設計書6.40）はここで既に落ちている
  const loaded = await loadEpisodeBodies(scan.episodes);
  if (loaded.bodies.length === 0) {
    vscode.window.showWarningMessage(
      loaded.conflicted.length > 0
        ? "未解決の競合があるため、本文を読めませんでした。競合を解決してから実行してください。"
        : "読める本文がありません。"
    );
    return undefined;
  }

  // **黙って消さない。** 競合中のファイルは一覧に出ないので、いま公開した話が
  // 競合していると、作者が気づかないまま1つ前の話が既定として選ばれる
  // （告知したい話と、告知される話が食い違う）
  if (loaded.conflicted.length > 0) {
    const names = loaded.conflicted.slice(0, 3).join("、");
    vscode.window.showWarningMessage(
      `未解決の競合があるため、${loaded.conflicted.length}件の話は一覧に出ません` +
        `（${names}${loaded.conflicted.length > 3 ? " ほか" : ""}）。` +
        "競合を解決してから実行してください。"
    );
  }

  const format = await readWorkFormat(work);
  // **新しい話が上。** 告知を作るのはたいてい今しがた公開した話なので、
  // 先頭（＝話数が最大のもの）が既定の選択になるように並べる。
  // 話数が読めないものは順番を決められないので、末尾へ回す
  const ordered = [...loaded.bodies].sort((a, b) => {
    if (a.chapter === null && b.chapter === null) return 0;
    if (a.chapter === null) return 1;
    if (b.chapter === null) return -1;
    return b.chapter - a.chapter;
  });

  const answer = await vscode.window.showQuickPick(
    [
      ...ordered.map((episode) => ({
        label: announceEpisodeLabel(episode, format),
        description: `${episode.body.length}字`,
        detail: episode.file.fileName,
        episode,
      })),
      cancelItem(),
    ],
    {
      title: `${work.title} の更新告知`,
      placeHolder: "告知を作る話を選んでください",
      ignoreFocusOut: true,
    }
  );
  if (!answer || isCancelItem(answer) || !("episode" in answer)) {
    return undefined;
  }
  return { episode: answer.episode, format };
}

interface AnnounceMaterial {
  episodeLabel: string;
  /** 切る前の本文。予算は呼び出し側で決める */
  body: string;
  /** 本文以外の材料。固定費の測定と本番で同じものを使う */
  prompt: {
    workTitle: string;
    episodeLabel: string;
    blurb: string;
    previousSynopsis: string;
    pastAnnouncements: string[];
  };
}

async function collectMaterial(
  work: WorkEntry,
  episode: EpisodeBody,
  format: WorkFormatKey | undefined
): Promise<AnnounceMaterial> {
  const episodeLabel = announceEpisodeLabel(episode, format);
  const doc = await readSynopsisDoc(work);

  return {
    episodeLabel,
    body: episode.body,
    prompt: {
      workTitle: work.title,
      episodeLabel,
      // 作品全体の雰囲気を合わせるための材料。無ければプロンプト側が印を置く
      blurb: doc.blurb,
      previousSynopsis: await readPreviousSynopsis(work, episode.chapter),
      pastAnnouncements: await new AnnouncementHistory(work).load(),
    },
  };
}

/**
 * 1つ前の話のあらすじ。無ければ空。
 *
 * 「今回がどこからの続きか」を掴ませるために渡す。**話数が読めない話
 * （日付ファイル等）には前後が無い**ので、想像で近いものを当てない。
 */
async function readPreviousSynopsis(
  work: WorkEntry,
  chapter: number | null
): Promise<string> {
  if (chapter === null) return "";
  try {
    const set = await new SynopsisStore(work).load();
    const previous = set.episodes.find((item) => item.chapter === chapter - 1);
    return previous?.synopsis.trim() ?? "";
  } catch {
    // あらすじが読めなくても告知は作れる。材料が減るだけ
    return "";
  }
}

export function parseAnnounceResponse(text: string): AnnounceResult | null {
  let value: unknown;
  try {
    value = JSON.parse(stripCodeFence(text));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const xPost = typeof record.xPost === "string" ? record.xPost.trim() : "";
  const activityReport =
    typeof record.activityReport === "string"
      ? record.activityReport.trim()
      : "";
  const afterword =
    typeof record.afterword === "string" ? record.afterword.trim() : "";
  // **3つとも空なら読み取れなかったものとして扱う。** 1つでもあれば
  // 残りは作者が書き足せるので、空のまま見せる（黙って捨てない）
  if (!xPost && !activityReport && !afterword) return null;

  return {
    xPost,
    activityReport,
    afterword,
    spoilerCheck:
      typeof record.spoilerCheck === "string" ? record.spoilerCheck : null,
    confidence:
      typeof record.confidence === "string" ? record.confidence : "low",
  };
}

