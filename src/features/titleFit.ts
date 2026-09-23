// ログの書き先：作品ごと（`useLogFile(work.folderPath)`）
import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { AIRegistry, ensureConfigured } from "../ai/registry";
import { AIError } from "../ai/types";
import {
  resolveOutputTokensForPlanning,
  resolveOutputTokensForSend,
} from "../ai/outputLimit";
import { atomicWriteFile } from "../core/atomicWrite";
import { scanWork } from "../core/scanner";
import {
  episodeListLabel,
  episodeTitle,
  formatChapterLabel,
  isCollectedFile,
} from "../core/episodeLabel";
import { readWorkFormat } from "../core/workFormatStore";
import {
  parseTitleFitRecord,
  parseTitleFitResponse,
  titleFitBatches,
  titleFitTargets,
  TITLE_FIT_SCHEMA_VERSION,
  type TitleFitBasis,
  type TitleFitItem,
  type TitleFitRecord,
} from "../core/titleFit";
import { READER_TYPES, type ReaderTypeId } from "../core/readerTarget";
import {
  buildTitleFitPrompt,
  TITLE_FIT_SCHEMA,
  TITLE_FIT_SYSTEM_PROMPT,
  TITLE_FIT_VERSION,
} from "../prompts/titleFit";
import { withCancellableProgress } from "../views/progress";
import { warnWithLog } from "../views/notify";
import { confirmPaidUsage, confirmProviderReachable } from "./aiConnectivity";
import { reportAIError } from "./reportAIError";
import {
  logFailure,
  logStep,
  responseExcerptForLog,
  useLogFile,
} from "../core/logger";
import { TARGET_SHEET_HISTORY_DIR } from "../core/targetSheetHistory";
import { titleFitPath } from "./targetSheet";

/**
 * タイトルとサブタイトルの適合度を測って残す（設計書6.108.6、P-41）。
 *
 * **測るのは作者が押したときだけ。** シートを作り直すたびに測ると、
 * 押すたびに料金と待ち時間がかかる。測った答えは
 * `設定/ターゲットシート/適合度.json` に残し、シートはそれを読んで並べる。
 *
 * ## 書くのは記録1つだけ
 *
 * 題（ファイル名・本文の見出し）は**1字も書き換えない**。見立てを
 * 読んで直すかどうかは作者が決める。
 *
 * ## 束ごとの失敗で全体を止めない
 *
 * 題が多い作品は `TITLE_FIT_BATCH` ずつに分けて頼む。1つの束が失敗しても
 * 残りは続け、**返らなかった題の数を記録に残す**（紙に出す）。
 *
 * 戻り値：`done`（記録を残した）／`cancelled`（取りやめ）／`failed`
 */
export async function measureTitleFit(
  work: WorkEntry,
  registry: AIRegistry,
  reader: { type: ReaderTypeId; basis: TitleFitBasis },
  settings: string
): Promise<"done" | "cancelled" | "failed"> {
  useLogFile(work.folderPath);

  /*
    **前の記録が壊れていたら測らない**（実装ルール2：壊れたJSONは直さず
    止める）。測った答えで上から書くと、作者が手で直しかけていた記録が
    黙って消える。
  */
  const recordPath = titleFitPath(settings);
  if (await isUnreadableRecord(recordPath)) {
    await warnWithLog(
      `設定/${TARGET_SHEET_HISTORY_DIR}/${path.basename(recordPath)} を読めませんでした。` +
        "こちらでは直しません。中身を直すか、名前を変えて避けてから、もう一度お試しください。"
    );
    return "failed";
  }

  const targets = await collectTargets(work);
  const batches = titleFitBatches(targets);
  if (batches.length === 0) {
    vscode.window.showWarningMessage("測れる題がありません（作品タイトルもサブタイトルも空です）。");
    return "cancelled";
  }

  const resolved = await ensureConfigured(registry, "generate");
  if (!resolved) return "cancelled";

  const actionLabel = "タイトルとサブタイトルの適合度";
  if (
    !(await confirmProviderReachable(resolved.provider, actionLabel, resolved.model))
  ) {
    return "cancelled";
  }
  const episodes = targets.filter((target) => target.kind === "episode").length;
  const ok = await confirmPaidUsage(resolved.provider, {
    actionLabel,
    remember: { id: "ai.paid.titleFit" },
    work,
    model: resolved.model,
    calls: batches.length,
    detail:
      `送るのは作品タイトルとサブタイトル${episodes}件だけです（本文は送りません）。\n` +
      `「${READER_TYPES[reader.type].label}」に向けて見立てます。題は書き換えません。`,
  });
  if (!ok) return "cancelled";

  const items: TitleFitItem[] = [];
  let failedBatches = 0;
  let cancelled = false;
  let lastError: unknown;

  await withCancellableProgress(
    "タイトルとサブタイトルの適合度を測っています",
    async (progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      logStep(
        `適合度の見立てを開始: ${work.title} / ${resolved.provider.displayName} / ` +
          `${resolved.model} / v${TITLE_FIT_VERSION} / ${READER_TYPES[reader.type].label} / ${batches.length}回`
      );

      for (const [index, batch] of batches.entries()) {
        if (token.isCancellationRequested) {
          cancelled = true;
          return;
        }
        progress.report({
          message: `${index + 1}/${batches.length}`,
          increment: 100 / batches.length,
        });
        try {
          const response = await resolved.provider.generate({
            systemPrompt: TITLE_FIT_SYSTEM_PROMPT,
            userPrompt: buildTitleFitPrompt({
              readerType: reader.type,
              targets: batch,
            }),
            model: resolved.model,
            // 見立ての点を返すだけ。揺らすと測り直すたびに点が大きく動く
            temperature: 0.2,
            maxOutputTokens: resolveOutputTokensForSend(
              resolved.provider.id,
              resolved.model,
              "title_fit"
            ),
            plannedOutputTokens: resolveOutputTokensForPlanning(
              resolved.provider.id,
              resolved.model,
              "title_fit"
            ),
            jsonSchema: TITLE_FIT_SCHEMA as unknown as object,
            disableThinking: true,
            meta: { feature: "title_fit", workFolder: work.folderPath },
            signal: controller.signal,
          });
          if (response.truncated) {
            failedBatches += 1;
            logFailure("適合度の見立てが出力上限で切れました", {
              束: `${index + 1}/${batches.length}`,
            });
            continue;
          }
          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(response.text);
          } catch (error) {
            failedBatches += 1;
            logFailure("適合度の応答を読み取れませんでした", {
              理由: error instanceof Error ? error.message : String(error),
              応答: responseExcerptForLog(response.text),
            });
            continue;
          }
          const parsed = parseTitleFitResponse(parsedJson, batch);
          // **捨てたものは黙って落とさない**（記録には残す）
          for (const note of parsed.notes) logStep(`適合度の検算：${note}`);
          items.push(...parsed.items);
        } catch (error) {
          if (error instanceof AIError && error.kind === "aborted") {
            cancelled = true;
            return;
          }
          failedBatches += 1;
          lastError = error;
          logFailure("適合度の見立てに失敗しました", {
            束: `${index + 1}/${batches.length}`,
            理由: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  );

  if (cancelled) return "cancelled";
  if (items.length === 0) {
    if (lastError) reportAIError(actionLabel, lastError);
    else {
      await warnWithLog(
        "適合度を読み取れませんでした。AIの返した形が読めませんでした。もう一度お試しください。"
      );
    }
    return "failed";
  }

  // 話の順に並べ直す（束の順に返るとは限らない）
  const order = new Map(targets.map((target, index) => [target.id, index]));
  items.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));

  const record: TitleFitRecord = {
    schemaVersion: TITLE_FIT_SCHEMA_VERSION,
    measuredAt: new Date().toISOString(),
    readerType: reader.type,
    basis: reader.basis,
    model: resolved.model,
    items,
    unmeasured: targets.length - items.length,
  };

  try {
    await vscode.workspace.fs.createDirectory(
      path.toUri(path.dirname(recordPath))
    );
    // **①の経路（指定なし・上書き）**。AIの見立ての記録で、作者が書く
    // ものではない。前の記録が読めることは上で確かめてある
    await atomicWriteFile(
      recordPath,
      new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`)
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logFailure("適合度の記録を保存できませんでした", { 詳細: detail });
    await warnWithLog("適合度の記録を保存できませんでした。");
    return "failed";
  }

  if (failedBatches > 0) {
    await warnWithLog(
      `適合度：${batches.length}回のうち${failedBatches}回は答えを受け取れませんでした。` +
        "受け取れた分だけを残しています。"
    );
  }
  return "done";
}

/** 測る題を集める（作品タイトルと、題のある話） */
async function collectTargets(work: WorkEntry) {
  const scan = await scanWork(work);
  const format = await readWorkFormat(work);
  const episodes = scan.episodes
    // 合本はファイルの題が中の話の題ではない。中の話ごとの題は
    // ファイル名から取れないので、測らない
    .filter((episode) => !isCollectedFile(episode.collectedCount))
    .map((episode) => {
      const chapter = formatChapterLabel(episode, format);
      return {
        label: episodeListLabel(episode, chapter, format),
        title: episodeTitle(episode, chapter),
      };
    });
  return titleFitTargets(work.title, episodes);
}

/** 記録があって、読めないか（無いのは「読めない」に入れない） */
async function isUnreadableRecord(recordPath: string): Promise<boolean> {
  let text: string;
  try {
    text = new TextDecoder().decode(
      await vscode.workspace.fs.readFile(path.toUri(recordPath))
    );
  } catch {
    return false;
  }
  try {
    return parseTitleFitRecord(JSON.parse(text)) === undefined;
  } catch {
    return true;
  }
}
