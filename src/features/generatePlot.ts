import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { AIRegistry, ensureConfigured } from "../ai/registry";
import { AIError, recoveryForAIError } from "../ai/types";
import { scanWork } from "../core/scanner";
import { loadEpisodeBodies } from "../core/episodeBodies";
import { SynopsisStore } from "../core/synopsisStore";
import { CharacterStore } from "../core/characterStore";
import { createLocationStore, createWorldStore } from "../core/abilityStore";
import {
  isBlankPlotSection,
  parsePlotMarkdown,
  PLOT_SECTIONS,
  type PlotSectionKey,
  type PlotSections,
} from "../core/plotDoc";
import { plotPath, readPlotText, writePlotSections } from "../core/plotFile";
import {
  parsePlotReverseResult,
  plotSectionLabel,
  validatePlotReverseResult,
} from "../core/plotReverseValidation";
import {
  buildPlotReversePrompt,
  PLOT_REVERSE_SCHEMA,
  PLOT_REVERSE_SYSTEM_PROMPT,
  PLOT_REVERSE_VERSION,
} from "../prompts/plotReverse";
import { confirmProviderReachable } from "./aiConnectivity";
import { confirmFormatFit } from "./formatFitPrompt";
import { withCancellableProgress } from "../views/progress";
import { logFailure, logStep, showLog, useLogFile } from "../core/logger";

/**
 * プロット逆算生成（P-02）。既に書いた本文からプロットを組み立て直す。
 *
 * **材料は既存の資料を使い、本文をもう一度AIに読ませない。**
 * プロンプト設計書のP-02はMap-Reduceだが、Map段階（チャンクごとに
 * 出来事・人物・場所を取り出す）は各話あらすじ（P-07）と設定資料の抽出
 * （P-04a）で既に済んでいる。もう一度読ませると同じ材料に二重の料金を払う。
 * よってAIの呼び出しは**1回だけ**である。
 *
 * **作者が書いたプロットは上書きしない。** 空の項目だけを既定で埋め、
 * 既に書かれている項目は「置き換える候補」として選ばせる。
 */

const OPENING_EXCERPT_CHARS = 3_000;

export async function generatePlot(
  work: WorkEntry,
  registry: AIRegistry
): Promise<void> {
  useLogFile(work.folderPath);

  // 短編集・SNS記事では、あらすじを時系列に並べても筋にならない（設計書6.4.5）。
  // **AIの設定より先に訊く。** 合わないと分かっているものに、
  // 未設定なら設定させてから断るのでは順序が逆である
  if (!(await confirmFormatFit(work, "plotReverse"))) return;

  const resolved = await ensureConfigured(registry);
  if (!resolved) return;

  const material = await collectMaterial(work);
  if (!material) return;

  const current = await readPlot(work);

  const confirm = await vscode.window.showInformationMessage(
    `${work.title} のプロットを、書いた本文から組み立て直します。`,
    {
      modal: true,
      detail: [
        `材料: 各話あらすじ ${material.chapterSynopses.length}話ぶん / ` +
          `登場人物 ${material.characterNames.length}人 / 冒頭 ${material.openingExcerpt.length}字`,
        "",
        "AIの呼び出しは1回です（本文全体は読み直しません）。",
        "作者が既に書いた項目は、確認せずに書き換えることはありません。",
        resolved.provider.isPaid
          ? `\n${resolved.provider.displayName} はトークンを消費し、利用量が加算されます。`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    },
    "実行"
  );
  if (confirm !== "実行") return;

  if (!(await confirmProviderReachable(resolved.provider, "プロットの逆算"))) {
    return;
  }

  let responseText: string | undefined;
  let failure: unknown;

  await withCancellableProgress(
    "プロットを組み立てています",
    async (_progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      try {
        logStep(
          `プロット逆算を開始: ${work.title} / ${resolved.provider.displayName} / ` +
            `${resolved.model} / v${PLOT_REVERSE_VERSION}`
        );
        const response = await resolved.provider.generate({
          systemPrompt: PLOT_REVERSE_SYSTEM_PROMPT,
          userPrompt: buildPlotReversePrompt({
            workTitle: work.title,
            chapterSynopses: material.chapterSynopses,
            openingExcerpt: material.openingExcerpt,
            characterNames: material.characterNames,
            worldItems: material.worldItems,
            locationNames: material.locationNames,
          }),
          model: resolved.model,
          // 事実の再構成なので揺らす必要がない。ただし言い回しは要るので0にはしない
          temperature: 0.3,
          jsonSchema: PLOT_REVERSE_SCHEMA as unknown as object,
          disableThinking: true,
          signal: controller.signal,
        });
        responseText = response.truncated ? undefined : response.text;
        if (response.truncated) failure = new Error("応答が出力上限で切れました");
      } catch (error) {
        failure = error;
      }
    }
  );

  if (failure) {
    const message =
      failure instanceof AIError
        ? `${failure.message} ${recoveryForAIError(failure)}`
        : failure instanceof Error
          ? failure.message
          : String(failure);
    logFailure("プロット逆算", { 内容: message });
    vscode.window
      .showWarningMessage(`プロットを作れませんでした: ${message}`, "ログを見る")
      .then((answer) => {
        if (answer === "ログを見る") showLog();
      });
    return;
  }
  if (!responseText?.trim()) return;

  const parsed = parsePlotReverseResult(responseText);
  if (!parsed) {
    logFailure("プロット逆算", {
      理由: "応答を読み取れません",
      応答: responseText.slice(0, 400),
    });
    vscode.window
      .showWarningMessage("応答を読み取れませんでした。", "ログを見る")
      .then((answer) => {
        if (answer === "ログを見る") showLog();
      });
    return;
  }

  const validated = validatePlotReverseResult(parsed);

  // タイトルはAIに聞かない（既に決まっているものを推測させる意味がない）。
  // 空のままだと「なぜここだけ埋まらないのか」と見えるので、作品名を入れる。
  // 別の題を考えている作者は、そのまま書き換えればよい
  if (!validated.sections.title.trim()) {
    validated.sections.title = work.title;
  }

  await applyPlot(work, current, validated.sections, {
    overLimit: validated.overLimit,
    notes: validated.notes,
  });
}

interface PlotMaterial {
  chapterSynopses: string[];
  openingExcerpt: string;
  characterNames: string[];
  worldItems: string[];
  locationNames: string[];
}

/**
 * 材料を集める。
 *
 * **各話あらすじが無ければ実行しない。** あらすじは出来事の時系列そのもので、
 * これが無いとAIは冒頭3,000字だけで全体のプロットを推測することになり、
 * 中盤以降を作り話で埋める。先にあらすじを作ってもらう。
 */
async function collectMaterial(
  work: WorkEntry
): Promise<PlotMaterial | undefined> {
  const scan = await scanWork(work);
  if (scan.episodes.length === 0) {
    vscode.window.showWarningMessage("本文ファイルが見つかりません。");
    return undefined;
  }

  let chapterSynopses: string[] = [];
  try {
    const set = await new SynopsisStore(work).load();
    chapterSynopses = set.episodes.map((item) =>
      item.chapter !== null
        ? `第${item.chapter}話: ${item.synopsis}`
        : item.synopsis
    );
  } catch {
    chapterSynopses = [];
  }

  if (chapterSynopses.length === 0) {
    const action = await vscode.window.showWarningMessage(
      "各話あらすじがまだありません。" +
        "あらすじが無いと、冒頭だけを見て中盤以降を推測することになり、" +
        "本文に無い筋書きが混ざります。先にあらすじを作ってください。",
      "各話あらすじを作る",
      "中止"
    );
    if (action === "各話あらすじを作る") {
      await vscode.commands.executeCommand("novelai.generateSynopses");
    }
    return undefined;
  }

  const bodies = (await loadEpisodeBodies(scan.episodes)).bodies;
  let openingExcerpt = "";
  for (const episode of bodies) {
    if (openingExcerpt.length >= OPENING_EXCERPT_CHARS) break;
    openingExcerpt += `${episode.body}\n\n`;
  }
  openingExcerpt = openingExcerpt.slice(0, OPENING_EXCERPT_CHARS);

  const [characters, locations, world] = await Promise.all([
    new CharacterStore(work).loadAll(),
    createLocationStore(work).loadAll(),
    createWorldStore(work).loadAll(),
  ]);

  return {
    chapterSynopses,
    openingExcerpt,
    // モブは筋を追うのに要らない。名前が普通名詞になりがちで紛れる
    characterNames: characters.characters
      .filter((character) => !character.isMob)
      .map((character) => character.name),
    worldItems: world.records.map((record) => record.name),
    locationNames: locations.records.map((record) => record.name),
  };
}

/**
 * 逆算した内容をプロットへ反映する。
 *
 * **空の項目は既定で埋め、書かれている項目は選ばせる。** プロットは
 * 作者の文書なので、黙って置き換えてはならない。逆に、空欄のまま
 * 一つずつ確認を取るのは手間だけが増える（作者が失うものが無いため）。
 */
async function applyPlot(
  work: WorkEntry,
  current: { sections: PlotSections; extra: string },
  generated: PlotSections,
  info: { overLimit: string[]; notes: string | null }
): Promise<void> {
  const filled: PlotSectionKey[] = [];
  const conflicts: PlotSectionKey[] = [];

  for (const section of PLOT_SECTIONS) {
    const value = generated[section.key]?.trim();
    if (!value) continue;
    if (isBlankPlotSection(current.sections[section.key])) {
      filled.push(section.key);
    } else if (current.sections[section.key].trim() !== value) {
      conflicts.push(section.key);
    }
  }

  if (filled.length === 0 && conflicts.length === 0) {
    vscode.window.showInformationMessage(
      "プロットに書き足せる内容はありませんでした。"
    );
    return;
  }

  const next: PlotSections = { ...current.sections };
  for (const key of filled) next[key] = generated[key];

  let replaced: PlotSectionKey[] = [];
  if (conflicts.length > 0) {
    const picked = await vscode.window.showQuickPick(
      conflicts.map((key) => ({
        label: plotSectionLabel(key),
        description: "既に書かれています",
        detail: `今の内容: ${oneLine(current.sections[key])}\nAIの案: ${oneLine(generated[key])}`,
        key,
      })),
      {
        title: "既に書かれている項目を置き換えますか",
        placeHolder: "置き換えるものだけを選んでください（選ばなければ残します）",
        canPickMany: true,
        ignoreFocusOut: true,
      }
    );
    replaced = (picked ?? []).map((item) => item.key);
    for (const key of replaced) next[key] = generated[key];
  }

  if (filled.length === 0 && replaced.length === 0) {
    vscode.window.showInformationMessage("プロットは変更しませんでした。");
    return;
  }

  try {
    // **変える節だけを渡す。** 全部渡すと、触っていない節まで書き直す形になり、
    // 作者が付けた空行や書き方の癖が失われる
    const updates: Partial<PlotSections> = {};
    for (const key of [...filled, ...replaced]) updates[key] = next[key];
    await writePlotSections(work, updates);
  } catch (error) {
    vscode.window.showErrorMessage(
      `プロットを保存できませんでした: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return;
  }

  const summary = [
    filled.length > 0
      ? `${filled.map(plotSectionLabel).join("・")}を書き足しました`
      : "",
    replaced.length > 0
      ? `${replaced.map(plotSectionLabel).join("・")}を置き換えました`
      : "",
    info.overLimit.length > 0
      ? `\n目安の字数を超えた項目があります: ${info.overLimit.join(" / ")}`
      : "",
    info.notes ? `\n補足: ${info.notes}` : "",
  ]
    .filter(Boolean)
    .join("。");

  const action = await vscode.window.showInformationMessage(
    summary,
    "プロットを開く"
  );
  if (action === "プロットを開く") {
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(await plotPath(work))
    );
    await vscode.window.showTextDocument(document);
  }
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
}


async function readPlot(
  work: WorkEntry
): Promise<{ sections: PlotSections; extra: string }> {
  return parsePlotMarkdown(await readPlotText(work));
}


