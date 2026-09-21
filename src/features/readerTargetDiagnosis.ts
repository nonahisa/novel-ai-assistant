// ログの書き先：作品ごと（`useLogFile(work.folderPath)`）
import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { AIRegistry, ensureConfigured } from "../ai/registry";
import { AIError } from "../ai/types";
import {
  resolveOutputTokensForPlanning,
  resolveOutputTokensForSend,
} from "../ai/outputLimit";
import { scanWork } from "../core/scanner";
import { loadEpisodeBodies } from "../core/episodeBodies";
import { readPlotText } from "../core/plotFile";
import { isBlankPlotSection, parsePlotMarkdown } from "../core/plotDoc";
import {
  READER_QUESTIONS,
  READER_TYPES,
  resolveReaderType,
  scoreReaderAnswers,
} from "../core/readerTarget";
import {
  ReaderTargetStore,
  ReaderTargetStoreError,
} from "../core/readerTargetStore";
import {
  isReadingUsable,
  parseReaderTargetReading,
  type ReaderTargetReading,
} from "../core/readerTargetValidation";
import { buildReaderGuide } from "../core/readerTargetDoc";
import {
  buildReaderTargetPrompt,
  READER_TARGET_SCHEMA,
  READER_TARGET_SYSTEM_PROMPT,
  READER_TARGET_VERSION,
} from "../prompts/readerTarget";
import {
  hasReaderProfile,
  type ReaderProfile,
} from "../models/readerProfile";
import type { AuthorReaderProfile } from "../core/authorReaderType";
import {
  CHECK_CANCELLED,
  CHECK_COMPLETED,
  CHECK_FAILED,
  type CheckCommandOutcome,
} from "../core/proofreadingSuite";
import { cancelItem, isCancelItem } from "../views/dialogs";
import { openGeneratedMarkdown } from "../views/openDocument";
import { withCancellableProgress } from "../views/progress";
import { confirmPaidUsage, confirmProviderReachable } from "./aiConnectivity";
import { reportAIError } from "./reportAIError";
import {
  logFailure,
  logStep,
  responseExcerptForLog,
  useLogFile,
} from "../core/logger";
import { warnWithLog } from "../views/notify";

/**
 * ターゲット読者診断（設計書6.91）。
 *
 * 作者の依頼（2026-09-13）：「作者の分類と同じように、ターゲット読者の
 * 分類も行えないでしょうか？」
 *
 * ## 2階建て
 *
 * | | 何が出るか | AI |
 * |---|---|---|
 * | **宣言** | 誰に向けて書いているつもりか（9問） | 使わない |
 * | **実像** | 書けているものは誰に向いているか | 使う（P-38） |
 *
 * **値打ちはズレのほうにある。** 片方だけでも紙は出るが、
 * 並べて初めて動かせる指摘になる。
 *
 * ## すぐに選択肢を出さない
 *
 * 作者の指摘（2026-09-13）「すぐに選択肢を表示するのではなく、
 * 作者が何をしたいか聞き取って、アドバイスしてから選択肢を表示して
 * ください」。**なぜこの選択肢が出ているか**を先に言ってから出す。
 */

/** 実像を読むのに渡す冒頭の字数。多くしても向き先の判断は変わらない */
const OPENING_CHARS = 3000;

/** 生成文書の種類（ファイル名の前置き。設計書6.17.7） */
export const READER_GUIDE_KIND = "読者像";

type Step = "declare" | "read" | "both";

export async function runReaderTargetDiagnosis(
  work: WorkEntry,
  registry: AIRegistry,
  /**
   * 作者自身の読者タイプ（設計書6.101）。**未診断なら渡さなくてよい**
   * ——紙の突き合わせの節がまるごと出なくなるだけである。
   */
  authorReader?: AuthorReaderProfile
  /*
    **結末を名乗って返す**（0.74.12）。手順書き（設計書6.104）の段になった
    ので、「画面で案内してもらう」が次へ進むかどうかを決められないと
    ——取りやめたのに案内だけが先へ行く。返す印は校正のまとめ実行と同じ
    ものを使う（`core/proofreadingSuite.ts`。印を2組みにしない）。
  */
): Promise<CheckCommandOutcome> {
  useLogFile(work.folderPath);

  const store = new ReaderTargetStore(work);
  let profile: ReaderProfile;
  try {
    profile = await store.load();
  } catch (error) {
    if (error instanceof ReaderTargetStoreError) {
      // **理由は本文へ混ぜる。** `warnWithLog` の第2引数はボタンの名前で、
      // ここへエラー文を渡すと、エラー文の書かれたボタンが出て押しても
      // ログが開かなかった（0.75.1で直した）
      await warnWithLog(`読者像を読めませんでした。${error.message}`);
      return CHECK_FAILED;
    }
    throw error;
  }

  const step = await chooseStep(work, profile);
  if (!step) return CHECK_CANCELLED;

  let next: ReaderProfile = { ...profile };
  let unmeasured: readonly string[] = [];

  if (step === "declare" || step === "both") {
    const answers = await askReaderQuestions(profile.declared?.answers);
    if (!answers) return CHECK_CANCELLED;
    next = {
      ...next,
      declared: {
        scores: scoreReaderAnswers(answers),
        answers,
        updatedAt: new Date().toISOString(),
      },
    };
  }

  if (step === "read" || step === "both") {
    const read = await readFromWork(work, registry);
    if (read === "cancelled") return CHECK_CANCELLED;
    if (read) {
      next = {
        ...next,
        actual: {
          scores: read.reading.scores,
          evidence: read.reading.evidence,
          basis: read.basis,
          model: read.model,
          updatedAt: new Date().toISOString(),
        },
      };
      unmeasured = read.reading.unmeasured;
    }
    // 読めなかったときも、宣言だけは残して紙を出す
    // （AIの失敗で、作者の9問の答えを捨てない）
  }

  // 何も決まらなかった（読めず、答えもしていない）。済んだとは言えない
  if (!hasReaderProfile(next)) return CHECK_CANCELLED;

  try {
    await store.save(next);
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : String(error);
    // **原因はログへ、作者にはひとことだけ。** 保存の失敗はファイル側の
    // 文言（権限・パス）がそのまま出るので、通知へ載せても読み解けない
    logFailure("読者像を保存できませんでした", { 詳細: detail });
    await warnWithLog("読者像を保存できませんでした。");
    // **保存できなくても紙は見せる。** 作者が答えた手間を無駄にしない
  }

  await openGeneratedMarkdown(
    READER_GUIDE_KIND,
    buildReaderGuide({
      workTitle: work.title,
      profile: next,
      unmeasured,
      authorReader,
    }),
    { preview: false },
    { work }
  );
  return CHECK_COMPLETED;
}

/**
 * 何をするかを選んでもらう。
 *
 * **選択肢の前に、いま何が分かっていて何が分かっていないかを言う。**
 * 作者の指摘（2026-09-13）。押す前に、なぜその道が出ているのかが
 * 分からないと選べない。
 */
async function chooseStep(
  work: WorkEntry,
  profile: ReaderProfile
): Promise<Step | undefined> {
  // **画面に出す文字列にMarkdownの記号を混ぜない**（`plainTextUi.test.ts`）。
  // 強調は紙（`readerTargetDoc.ts`）の側だけで使う
  const declared = profile.declared
    ? `向けているつもり：${READER_TYPES[resolveReaderType(profile.declared.scores)].label}`
    : "向けているつもり：まだお聞きしていません";
  const actual = profile.actual
    ? `書けているもの：${READER_TYPES[resolveReaderType(profile.actual.scores)].label}`
    : "書けているもの：まだ読んでいません";

  const items = [
    {
      label: profile.declared
        ? "向けている先を、答え直す"
        : "向けている先を答える",
      detail:
        "いくつかお答えいただくと、宛先が決まります。AIは使いません。途中でやめられます。",
      step: "declare" as Step,
    },
    {
      label: profile.actual
        ? "書けているものを、読み直す"
        : "書けているものを読む",
      detail:
        "冒頭とプロットをAIが読んで、向き先を測ります。本文は書き換えません。",
      step: "read" as Step,
    },
    {
      label: "両方やって、ズレを見る",
      detail: "この診断でいちばん役に立つところです。",
      step: "both" as Step,
    },
  ];

  // **閉じる道は、呼ぶところで渡す。** 配列を先に組んで渡すと
  // `quickPickCancel.test.ts` が閉じる道を見つけられない（見張りが
  // 呼び出しの本体を読むため）。見張りに合わせておくほうが安い
  const picked = await vscode.window.showQuickPick([...items, cancelItem("取りやめる")], {
    title: `ターゲット読者診断：${work.title}`,
    placeHolder: `${declared}／${actual}`,
    ignoreFocusOut: true,
  });
  if (!picked || isCancelItem(picked)) return undefined;
  return "step" in picked ? picked.step : undefined;
}

/**
 * 宣言の9問を順に聞く。
 *
 * **Esc で取りやめたら、何も保存しない。** 途中まで答えた分を残すと、
 * 次に開いたときに「前回の答え」として半端な値が出てくる
 * （`askAdviceQuestions` と同じ約束）。
 *
 * **押す前に質問の数を約束しない**（0.52.3 と同じ。作者の指摘）。
 * 数は、答えている最中の見出しに事実として出す。
 */
export async function askReaderQuestions(
  previous?: number[]
): Promise<number[] | undefined> {
  const answers: number[] = [];

  for (const [index, question] of READER_QUESTIONS.entries()) {
    const before = previous?.[index];
    const picked = await vscode.window.showQuickPick(
      [
        ...question.choices.map((choice, choiceIndex) => ({
          label: choice.label,
          description:
            choiceIndex === before ? "$(check) 前回の答え" : undefined,
          value: choiceIndex,
        })),
        cancelItem("診断をやめる"),
      ],
      {
        title: `ターゲット読者診断 ${index + 1}/${READER_QUESTIONS.length}`,
        placeHolder: question.text,
        // 選んでいる途中で別の窓へ目を移しても消えないようにする
        ignoreFocusOut: true,
      }
    );
    if (!picked || isCancelItem(picked)) return undefined;
    if (!("value" in picked)) return undefined;
    answers.push(picked.value);
  }

  return answers;
}

interface ReadResult {
  reading: ReaderTargetReading;
  basis: string;
  model: string;
}

/**
 * 本文から実像を読む。
 *
 * 戻り値は3通り。**「取りやめた」と「読めなかった」を分ける**——
 * 取りやめなら何も出さず、読めなかったら宣言だけで紙を出す。
 */
async function readFromWork(
  work: WorkEntry,
  registry: AIRegistry
): Promise<ReadResult | undefined | "cancelled"> {
  // 読者像は「生成系」の割当に従う（冒頭診断・紹介文と同じ扱い）
  const resolved = await ensureConfigured(registry, "generate");
  if (!resolved) return "cancelled";

  const material = await collectMaterial(work);
  if (!material) return "cancelled";

  // **繋がるかを、費用の確認より先に確かめる**（設計書6.51）
  if (
    !(await confirmProviderReachable(
      resolved.provider,
      "読者像の読み取り",
      resolved.model
    ))
  ) {
    return "cancelled";
  }

  const ok = await confirmPaidUsage(resolved.provider, {
    actionLabel: "読者像の読み取り",
    remember: { id: "ai.paid.readerTarget" },
    model: resolved.model,
    calls: 1,
    detail:
      `送るのは${material.basis}の${material.chars}字だけです。\n` +
      "本文は書き換えません。",
  });
  if (!ok) return "cancelled";

  let responseText: string | undefined;
  let failure: unknown;

  await withCancellableProgress("読者像を読んでいます", async (_progress, token) => {
    const controller = new AbortController();
    token.onCancellationRequested(() => controller.abort());
    try {
      logStep(
        `読者像の読み取りを開始: ${work.title} / ${resolved.provider.displayName} / ` +
          `${resolved.model} / v${READER_TARGET_VERSION}`
      );
      const response = await resolved.provider.generate({
        systemPrompt: READER_TARGET_SYSTEM_PROMPT,
        userPrompt: buildReaderTargetPrompt({
          workTitle: work.title,
          plot: material.plot,
          openingExcerpt: material.opening,
          logline: material.logline,
        }),
        model: resolved.model,
        // 点数と引用を返すだけなので、揺らす理由が無い
        temperature: 0.2,
        maxOutputTokens: resolveOutputTokensForSend(
          resolved.provider.id,
          resolved.model,
          "reader_target"
        ),
        plannedOutputTokens: resolveOutputTokensForPlanning(
          resolved.provider.id,
          resolved.model,
          "reader_target"
        ),
        jsonSchema: READER_TARGET_SCHEMA as unknown as object,
        disableThinking: true,
        meta: { feature: "reader_target", workFolder: work.folderPath },
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
    if (failure instanceof AIError && failure.kind === "aborted") {
      return "cancelled";
    }
    reportAIError("読者像の読み取り", failure);
    return undefined;
  }
  if (!responseText) return undefined;

  let reading: ReaderTargetReading;
  try {
    reading = parseReaderTargetReading(
      JSON.parse(responseText),
      material.sources
    );
  } catch (error) {
    logFailure("読者像の応答を読み取れませんでした", {
      理由: error instanceof Error ? error.message : String(error),
      応答: responseExcerptForLog(responseText),
    });
    await warnWithLog(
      "読者像を読み取れませんでした。AIの返した形が読めませんでした。" +
        "もう一度お試しください。"
    );
    return undefined;
  }

  // **捨てたものは黙って落とさない**（記録には残す）
  for (const note of reading.notes) logStep(`読者像の検算：${note}`);

  if (!isReadingUsable(reading)) {
    await warnWithLog(
      "読者像を読み取れませんでした。3つの軸のどれも読み取れませんでした。" +
        "話数が増えてからお試しください。"
    );
    return undefined;
  }

  return { reading, basis: material.basis, model: resolved.model };
}

interface Material {
  opening: string;
  plot: string;
  logline: string;
  /** 引用の照合に使う、渡した材料ぜんぶ */
  sources: string;
  /** 何から読んだか（紙に出す） */
  basis: string;
  chars: number;
}

/**
 * 材料を集める。
 *
 * **冒頭を見る。** 読者が読み続けるかを決めるのはそこで、
 * 向き先がいちばんはっきり出る（冒頭診断・6.30と同じ考え方）。
 */
async function collectMaterial(
  work: WorkEntry
): Promise<Material | undefined> {
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
        ? "未解決の競合があるため、本文を読めませんでした。競合を解決してから実行してください。"
        : "読める本文がありません。"
    );
    return undefined;
  }

  const sections = parsePlotMarkdown(await readPlotText(work)).sections;
  const opening = first.body.slice(0, OPENING_CHARS);
  const plot = plotValue(sections.outline);
  const logline = plotValue(sections.logline);

  const names = ["冒頭"];
  if (plot) names.push("プロット");
  if (logline) names.push("ひとことの粗筋");

  return {
    opening,
    plot,
    logline,
    sources: [opening, plot, logline].join("\n"),
    basis: names.join("・"),
    chars: opening.length + plot.length + logline.length,
  };
}

/** 書かれていない項目（テンプレートの案内だけ）は空として渡す */
function plotValue(body: string | undefined): string {
  if (!body) return "";
  return isBlankPlotSection(body) ? "" : body.trim();
}
