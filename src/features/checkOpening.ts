import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { AIRegistry, ensureConfigured } from "../ai/registry";
import { AIError } from "../ai/types";
import { scanWork } from "../core/scanner";
import { loadEpisodeBodies } from "../core/episodeBodies";
import { readPlotText } from "../core/plotFile";
import { isBlankPlotSection, parsePlotMarkdown } from "../core/plotDoc";
import {
  buildOpeningCheckPrompt,
  OPENING_CHECK_SCHEMA,
  OPENING_CHECK_SYSTEM_PROMPT,
  OPENING_CHECK_VERSION,
  OPENING_ELEMENTS,
  OPENING_EXCERPT_MAX_CHARS,
  parseOpeningCheck,
  type OpeningCheckResult,
  type OpeningElementJudgement,
} from "../prompts/openingCheck";
import { openGeneratedMarkdown } from "../views/openDocument";
import { withCancellableProgress } from "../views/progress";
import { reportAIError } from "./reportAIError";
import { confirmPaidUsage, confirmProviderReachable } from "./aiConnectivity";
import {
  logFailure,
  logStep,
  responseExcerptForLog,
  showLog,
  useLogFile,
} from "../core/logger";

/**
 * 冒頭診断（P-24、設計書6.30）。
 *
 * **第1話の冒頭3,000字だけを、1回のAI呼び出しで見る。**
 * WEB小説は冒頭で読み続けるかが決まる（作者の創作論）ので、
 * そこだけを切り出して 5W1H と期待感を確かめる。
 *
 * **本文は書き換えない。** 出るのは読み物の診断レポートであって、
 * 適用する提案ではない。だから提案パネルへは流さず、
 * その場で組み立てたMarkdownとして開く。
 */

/** 表に出す判定の印 */
const MARK_CONVEYED = "◯";
/** 意図的な保留。**欠点ではないので、伝わらないものと同じ印にしない** */
const MARK_INTENTIONAL = "△";
const MARK_NOT_CONVEYED = "—";

/**
 * 「意図的な保留」と読める note の目印。
 *
 * プロンプトで「note の先頭に『意図的な保留』と書くこと」と指示しているので、
 * その語が入っているかで見る。**指示した言葉がそのまま返ってくる**のは
 * この作品で繰り返し起きたことなので、ここではそれを前提に使っている。
 */
const INTENTIONAL_MARKER = "意図的";

export async function checkOpening(
  work: WorkEntry,
  registry: AIRegistry
): Promise<void> {
  useLogFile(work.folderPath);

  // 冒頭診断は「生成系」の割当に従う（あらすじ・紹介文と同じ扱い）
  const resolved = await ensureConfigured(registry, "generate");
  if (!resolved) return;

  const material = await collectOpening(work);
  if (!material) return;

  // **繋がるかを、費用の確認より先に確かめる**（設計書6.51）。
  // 繋がらないと分かっているのに料金の話をしても意味がない。
  // 材料が集まらなかった回（上で return する）はAIを1度も呼ばないので、
  // ここより手前には置かない。モデル名を渡すのは、LM Studioを
  // この場から起こしたときの読み込みに要るため（`aiConnectivity.ts`）
  if (
    !(await confirmProviderReachable(
      resolved.provider,
      "冒頭の診断",
      resolved.model
    ))
  ) {
    return;
  }

  const ok = await confirmPaidUsage(resolved.provider, {
    actionLabel: "冒頭診断",
    model: resolved.model,
    calls: 1,
    detail:
      `送るのは第1話の冒頭 ${material.openingText.length}字だけです。\n` +
      "本文は書き換えません。",
  });
  if (!ok) return;

  let responseText: string | undefined;
  let failure: unknown;

  await withCancellableProgress("冒頭を診断しています", async (_progress, token) => {
    const controller = new AbortController();
    token.onCancellationRequested(() => controller.abort());
    try {
      logStep(
        `冒頭診断を開始: ${work.title} / ${resolved.provider.displayName} / ` +
          `${resolved.model} / v${OPENING_CHECK_VERSION}`
      );
      const response = await resolved.provider.generate({
        systemPrompt: OPENING_CHECK_SYSTEM_PROMPT,
        userPrompt: buildOpeningCheckPrompt({
          workTitle: work.title,
          genre: material.genre,
          logline: material.logline,
          openingText: material.openingText,
        }),
        model: resolved.model,
        // 判定と根拠を出すだけなので、揺らす理由が無い。
        // 0にしないのは、同じ言い回しが6要素に並ぶのを避けるため
        temperature: 0.2,
        jsonSchema: OPENING_CHECK_SCHEMA as unknown as object,
        disableThinking: true,
        // **numCtx は渡さない。** 送るのは冒頭3,000字だけなので、
        // 受け皿（プロバイダ側）が送る文字数から見積もるほうが正確になる
        meta: { feature: "opening_check", workFolder: work.folderPath },
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
    // 中止は失敗ではない。作者が自分で止めたことを警告で知らせ直さない
    if (failure instanceof AIError && failure.kind === "aborted") return;
    reportAIError("冒頭診断", failure);
    return;
  }
  if (responseText === undefined) return;

  const result = parseOpeningCheck(responseText);
  if (!result) {
    // **応答の中身は捨てない。** 通知には出さなくても、ログには残す
    logFailure("冒頭診断", {
      理由: "応答を読み取れません",
      応答: responseExcerptForLog(responseText),
    });
    const answer = await vscode.window.showWarningMessage(
      "冒頭診断の応答を読み取れませんでした。",
      "ログを見る"
    );
    if (answer === "ログを見る") showLog();
    return;
  }

  // **ファイル名には作品名を入れない。** 置き場が作品ごとに分かれており
  // （設計書6.17.7）、作品名を混ぜると古いものを片付ける前置きが
  // 一致しなくなる。作品名は文書の見出しに入っている
  await openGeneratedMarkdown(
    OPENING_CHECK_KIND,
    renderOpeningCheck({
      workTitle: work.title,
      excerptChars: material.openingText.length,
      result,
    }),
    undefined,
    { work }
  );
}

interface OpeningMaterial {
  /** 第1話の冒頭。上限まで切ってある */
  openingText: string;
  genre: string;
  logline: string;
}

/**
 * 診断の材料を集める。
 *
 * **冒頭本文の取り方は紹介文（`generateBlurb.ts`）と同じ道を通る**
 * （`scanWork` → `loadEpisodeBodies`）。合本（全話が1ファイル）の作品でも
 * 第1話を切り出せるのは、`loadEpisodeBodies` がその違いを吸収するからである。
 * 別の読み方を新しく作ると、片方の形の作品でだけ壊れる。
 *
 * 紹介文と違うのは、**先頭の1話しか使わない**ところである。あちらは作品の
 * 雰囲気が要るので数話ぶんを詰めるが、こちらは「冒頭で決まるか」を見るので、
 * 2話目以降を混ぜると前提が崩れる。
 */
async function collectOpening(
  work: WorkEntry
): Promise<OpeningMaterial | undefined> {
  const scan = await scanWork(work);
  if (scan.episodes.length === 0) {
    vscode.window.showWarningMessage("本文ファイルが見つかりません。");
    return undefined;
  }

  const loaded = await loadEpisodeBodies(scan.episodes);
  const first = loaded.bodies[0];
  if (!first) {
    vscode.window.showWarningMessage(
      loaded.conflicted.length > 0
        ? "未解決の競合があるため、冒頭を読めませんでした。競合を解決してから実行してください。"
        : "読める本文がありません。"
    );
    return undefined;
  }

  const sections = parsePlotMarkdown(await readPlotText(work)).sections;
  return {
    openingText: first.body.slice(0, OPENING_EXCERPT_MAX_CHARS),
    // プロットが無くても診断はできる。材料が1つ減るだけなので止めない
    genre: plotValue(sections.genre),
    logline: plotValue(sections.logline),
  };
}

/** 書かれていない項目（テンプレートの案内だけ）は空として渡す */
function plotValue(body: string): string {
  return isBlankPlotSection(body) ? "" : body.trim();
}

export interface OpeningCheckReport {
  workTitle: string;
  /** 実際に見た冒頭の字数。**末尾の断りに出す** */
  excerptChars: number;
  result: OpeningCheckResult;
}

/**
 * 生成文書の種類（ファイル名の前置き。設計書6.17.7）。
 *
 * 見出しには作品名まで入れるが、ファイル名には入れない
 * （置き場が作品ごとに分かれているので要らない）。
 */
export const OPENING_CHECK_KIND = "冒頭診断";

/**
 * 診断結果をMarkdownへ整形する。
 *
 * VS Code APIに依存しない純関数にしてある（単体テストの対象）。
 * **答えの見た目は、答えの中身と同じくらい壊れやすい**——印の出し分けを
 * 間違えると、意図的な保留が欠点として並ぶ。
 */
export function renderOpeningCheck(report: OpeningCheckReport): string {
  const byElement = new Map(
    report.result.elements.map((entry) => [entry.element, entry])
  );

  const lines: string[] = [
    `# ${OPENING_CHECK_KIND}：${report.workTitle}`,
    "",
    "## 読者に伝わるか（5W1H）",
    "",
    `| 要素 | 伝わるか | 根拠・理由 |`,
    `| --- | :---: | --- |`,
  ];

  for (const element of OPENING_ELEMENTS) {
    const judgement = byElement.get(element);
    lines.push(
      `| ${element} | ${elementMark(judgement)} | ${cell(reason(judgement))} |`
    );
  }

  lines.push(
    "",
    `${MARK_CONVEYED} 伝わる／${MARK_INTENTIONAL} 意図的な保留（欠点ではありません）／` +
      `${MARK_NOT_CONVEYED} 伝わらない`,
    "",
    "## 続きを読みたくなる引き",
    ""
  );

  const hook = report.result.hook;
  if (!hook) {
    // 読めなかったことを「引きが無い」に落とさない（`parseOpeningCheck` の注釈）
    lines.push("判定が返りませんでした。");
  } else if (hook.present) {
    lines.push(hook.note || "引きがあると判定されました（説明はありません）。");
  } else {
    lines.push(
      hook.note
        ? `引きは見当たりませんでした。${hook.note}`
        : "引きは見当たりませんでした。"
    );
  }

  lines.push("", "## 総評", "");
  lines.push(report.result.advice || "総評が返りませんでした。");

  lines.push(
    "",
    "---",
    "",
    `この診断は冒頭 ${report.excerptChars} 字だけを見ています。判断するのは作者です。`,
    ""
  );

  return lines.join("\n");
}

function elementMark(judgement: OpeningElementJudgement | undefined): string {
  if (!judgement) return MARK_NOT_CONVEYED;
  if (judgement.conveyed) return MARK_CONVEYED;
  return judgement.note.includes(INTENTIONAL_MARKER)
    ? MARK_INTENTIONAL
    : MARK_NOT_CONVEYED;
}

function reason(judgement: OpeningElementJudgement | undefined): string {
  if (!judgement) return "判定が返りませんでした。";
  return judgement.note || "説明が返りませんでした。";
}

/**
 * 表の升目に入れる形へ直す。
 *
 * 縦棒がそのまま入ると、そこで列が増えて表が崩れる。中身は消さずに逃がす。
 */
function cell(text: string): string {
  return text.split("|").join("\\|");
}

