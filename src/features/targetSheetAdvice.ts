// ログの書き先：作品ごと（`useLogFile(work.folderPath)`）
import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import type { ReaderProfile } from "../models/readerProfile";
import { AIRegistry, ensureConfigured } from "../ai/registry";
import { AIError } from "../ai/types";
import {
  resolveOutputTokensForPlanning,
  resolveOutputTokensForSend,
} from "../ai/outputLimit";
import { atomicWriteFile } from "../core/atomicWrite";
import {
  buildTargetSheetAdviceMaterial,
  isSameAdviceInput,
  parseTargetSheetAdvice,
  parseTargetSheetAdviceRecord,
  TARGET_SHEET_ADVICE_FILE,
  TARGET_SHEET_ADVICE_SCHEMA_VERSION,
  type TargetSheetAdviceRecord,
} from "../core/targetSheetAdvice";
import { TARGET_SHEET_HISTORY_DIR } from "../core/targetSheetHistory";
import {
  buildTargetSheetAdvicePrompt,
  targetSheetAdviceInstructions,
  TARGET_SHEET_ADVICE_SCHEMA,
  TARGET_SHEET_ADVICE_SYSTEM_PROMPT,
  TARGET_SHEET_ADVICE_TEMPERATURE,
  TARGET_SHEET_ADVICE_VERSION,
} from "../prompts/targetSheetAdvice";
import { withCancellableProgress } from "../views/progress";
import { warnWithLog } from "../views/notify";
import { cancelItem, isCancelItem } from "../views/dialogs";
import { confirmPaidUsage, confirmProviderReachable } from "./aiConnectivity";
import { reportAIError } from "./reportAIError";
import {
  logFailure,
  logStep,
  responseExcerptForLog,
  useLogFile,
} from "../core/logger";
import { TARGET_READER_TITLE, targetSheetAdvicePath } from "./targetSheet";

/**
 * ターゲットシートの助言を作って残す（設計書6.108.4 の第3段、P-46）。
 *
 * ## 作るのは作者が押したときだけ
 *
 * シートを作り直すたびに AI を呼ぶと、押すたびに料金と待ち時間がかかる。
 * 本文の実像（P-38）も適合度（P-41）も「押したときだけ」で、同じ扱いに
 * そろえた。答えは `設定/ターゲットシート/助言.json` に残し、シートは
 * それを読んで並べる。
 *
 * ## 材料が前回と同じなら作り直さない
 *
 * 狙い・理由・点数・根拠の指紋と、頼み方の版・AI・モデルが前回と同じなら
 * 呼ばない（推移の控えが「点数が同じなら作らない」のと同じ。キャッシュの
 * 鍵と同じ4つ——実装ルール4）。AI の言い回しを変えたいときのために、
 * 「それでも作り直す」は選べる。
 *
 * ## 書くのは記録1つだけ
 *
 * 本文・作者の欄・読者像の台帳は読むだけである。
 *
 * 戻り値：`done`（記録を残した／前回のままにした）／`cancelled`／`failed`
 */
export async function makeTargetSheetAdvice(
  work: WorkEntry,
  registry: AIRegistry,
  input: {
    readonly settings: string;
    readonly authorBlock: string;
    readonly profile: ReaderProfile;
  }
): Promise<"done" | "cancelled" | "failed"> {
  useLogFile(work.folderPath);

  const built = buildTargetSheetAdviceMaterial({
    authorBlock: input.authorBlock,
    profile: input.profile,
  });
  if ("missing" in built) {
    // **材料が無ければ呼ばない**（6.107「実行したふり」）。何を済ませれば
    // 作れるかを言う
    await warnWithLog(
      built.missing === "aim"
        ? `助言を作るには、先に狙いが要ります。「${TARGET_READER_TITLE}」の「1 狙いを選ぶ」で選んでください。`
        : `助言を作るには、作品の点数が要ります。「${TARGET_READER_TITLE}」の「2 書き方の判断に答える」か「3 本文の実像を読む」を済ませてください。`
    );
    return "failed";
  }
  const { material } = built;

  /*
    **前の記録が壊れていたら作らない**（実装ルール2：壊れたJSONは直さず
    止める）。上から書くと、作者が手で直しかけていた記録が黙って消える。
  */
  const recordPath = targetSheetAdvicePath(input.settings);
  const previous = await readRecord(recordPath);
  if (previous === "unreadable") {
    await warnWithLog(
      `設定/${TARGET_SHEET_HISTORY_DIR}/${TARGET_SHEET_ADVICE_FILE} を読めませんでした。` +
        "こちらでは直しません。中身を直すか、名前を変えて避けてから、もう一度お試しください。"
    );
    return "failed";
  }

  // 割当キーは生成系（P-38 の実像・P-41 の適合度と同じ。設計書6.28.9）
  const resolved = await ensureConfigured(registry, "generate");
  if (!resolved) return "cancelled";

  if (
    isSameAdviceInput(previous, {
      materialMark: material.mark,
      providerId: resolved.provider.id,
      model: resolved.model,
      promptVersion: TARGET_SHEET_ADVICE_VERSION,
    })
  ) {
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: "前回の助言のまま開く",
          detail: "狙い・理由・点数が前回と同じです。AIは使いません。",
          redo: false,
        },
        {
          label: "それでも作り直す",
          detail: "同じ材料で、AIにもう一度書いてもらいます。",
          redo: true,
        },
        cancelItem("取りやめる"),
      ],
      {
        title: `${TARGET_READER_TITLE}：助言`,
        placeHolder: "材料が前回と同じです。前回の助言のままにしますか",
        ignoreFocusOut: true,
      }
    );
    if (!choice || isCancelItem(choice)) return "cancelled";
    if ("redo" in choice && !choice.redo) {
      logStep("ターゲットシートの助言：材料が前回と同じなので作り直しませんでした");
      return "done";
    }
  }

  const actionLabel = "ターゲットシートの助言";
  if (
    !(await confirmProviderReachable(resolved.provider, actionLabel, resolved.model))
  ) {
    return "cancelled";
  }
  const ok = await confirmPaidUsage(resolved.provider, {
    actionLabel,
    remember: { id: "ai.paid.targetSheetAdvice" },
    work,
    model: resolved.model,
    calls: 1,
    detail:
      "送るのはシートの材料（狙いと理由・点数・ずれ・向かう先" +
      (material.evidence.length > 0
        ? `・本文の実像の根拠の引用${material.evidence.length}件`
        : "") +
      "）だけです。本文そのものは送りません。\n本文は書き換えません。",
  });
  if (!ok) return "cancelled";

  const sentText = buildTargetSheetAdvicePrompt(material);
  let responseText: string | undefined;
  let failure: unknown;

  await withCancellableProgress("助言を書いてもらっています", async (_progress, token) => {
    const controller = new AbortController();
    token.onCancellationRequested(() => controller.abort());
    logStep(
      `ターゲットシートの助言を開始: ${work.title} / ${resolved.provider.displayName} / ` +
        `${resolved.model} / v${TARGET_SHEET_ADVICE_VERSION} / 材料 ${material.mark}`
    );
    try {
      const response = await resolved.provider.generate({
        systemPrompt: TARGET_SHEET_ADVICE_SYSTEM_PROMPT,
        userPrompt: sentText,
        model: resolved.model,
        temperature: TARGET_SHEET_ADVICE_TEMPERATURE,
        maxOutputTokens: resolveOutputTokensForSend(
          resolved.provider.id,
          resolved.model,
          "target_sheet_advice"
        ),
        plannedOutputTokens: resolveOutputTokensForPlanning(
          resolved.provider.id,
          resolved.model,
          "target_sheet_advice"
        ),
        jsonSchema: TARGET_SHEET_ADVICE_SCHEMA as unknown as object,
        disableThinking: true,
        meta: { feature: "target_sheet_advice", workFolder: work.folderPath },
        signal: controller.signal,
      });
      if (response.truncated) {
        failure = new Error("応答が出力上限で切れました。");
        return;
      }
      responseText = response.text;
    } catch (error) {
      failure = error;
    }
  });

  if (failure) {
    if (failure instanceof AIError && failure.kind === "aborted") return "cancelled";
    reportAIError(actionLabel, failure);
    return "failed";
  }
  if (!responseText) return "failed";

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(responseText);
  } catch (error) {
    logFailure("助言の応答を読み取れませんでした", {
      理由: error instanceof Error ? error.message : String(error),
      応答: responseExcerptForLog(responseText),
    });
    await warnWithLog("助言を読み取れませんでした。AIの返した形が読めませんでした。もう一度お試しください。");
    return "failed";
  }
  const parsed = parseTargetSheetAdvice(
    parsedJson,
    material,
    sentText,
    targetSheetAdviceInstructions()
  );
  // **捨てたものは黙って落とさない**（記録には残す。紙には件数を出す）
  for (const note of parsed.notes) logStep(`助言の検算：${note}`);
  if (!parsed.usable) {
    logFailure("助言に載せられる中身がありませんでした", {
      応答: responseExcerptForLog(responseText),
    });
    await warnWithLog(
      "助言を読み取れませんでした。AIの答えに、載せられる中身がありませんでした。もう一度お試しください。"
    );
    return "failed";
  }

  const record: TargetSheetAdviceRecord = {
    schemaVersion: TARGET_SHEET_ADVICE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    providerId: resolved.provider.id,
    model: resolved.model,
    promptVersion: TARGET_SHEET_ADVICE_VERSION,
    materialMark: material.mark,
    aims: material.aims.map((aim) => aim.type),
    reasonGiven: material.reason.trim() !== "",
    source: material.source,
    overall: parsed.overall,
    keep: parsed.keep,
    advice: parsed.advice,
    dropped: parsed.dropped,
  };

  try {
    await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(recordPath)));
    // **①の経路（指定なし・上書き）**。AIの助言の記録で、作者が書くものでは
    // ない。前の記録が読めることは上で確かめてある
    await atomicWriteFile(
      recordPath,
      new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`)
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logFailure("助言の記録を保存できませんでした", { 詳細: detail });
    await warnWithLog("助言の記録を保存できませんでした。");
    return "failed";
  }
  logStep(
    `ターゲットシートの助言：合っている所 ${record.keep.length}件・寄せ方 ${record.advice.length}件・捨てた ${record.dropped}件`
  );
  return "done";
}

/** 記録を読む。無ければ `undefined`、読めなければ `"unreadable"` */
async function readRecord(
  recordPath: string
): Promise<TargetSheetAdviceRecord | undefined | "unreadable"> {
  let text: string;
  try {
    text = new TextDecoder().decode(
      await vscode.workspace.fs.readFile(path.toUri(recordPath))
    );
  } catch {
    return undefined;
  }
  try {
    return parseTargetSheetAdviceRecord(JSON.parse(text)) ?? "unreadable";
  } catch {
    return "unreadable";
  }
}
