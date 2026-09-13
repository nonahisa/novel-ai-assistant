// ログの書き先：作品が定まらない
// （使用開始時に、作品を1つも登録していない状態でも通る画面である）
import * as vscode from "vscode";
import {
  buildWriterStyle,
  describeWriterStyle,
  diagnosisNarrative,
  tutorialAdvice,
  tutorialGoals,
  WRITER_PLAN_TYPES,
  WRITER_QUESTIONS,
  type TutorialGoalInfo,
  type WriterStyle,
} from "../core/writerStyle";
import {
  buildWriterGuide,
  WRITER_GUIDE_TITLE,
} from "../core/writerGuideDoc";
import type { WriterProfileStore } from "../core/writerProfileStore";
import { openGeneratedMarkdown } from "../views/openDocument";
import { cancelItem, isCancelItem } from "../views/dialogs";
import { logStep } from "../core/logger";
import {
  ADVICE_QUESTIONS,
  ADVICE_TYPES,
  appendAdviceHistory,
  resolveAdviceType,
  scoreAnswers,
  type AdviceProfile,
} from "../core/advicePolicy";
import { askAdviceQuestions } from "./advicePolicyDiagnosis";

/**
 * 作家タイプ診断と、はじめの案内（設計書6.90）。
 *
 * ## 順番を守る
 *
 * **選択肢をいきなり出さない**（作者の指摘、2026-09-13）。
 *
 * 1. 5問聞く（`askStyle`）
 * 2. **いま何をしたいかを聞く**（`askGoal`。操作名ではなく目的を並べ、
 *    1つずつに「なぜ出ているか」を付ける）
 * 3. **紙を開いて助言を読ませる**（`buildWriterGuide`）
 * 4. **そのうえで操作を出す**（`askStep`。1つずつに理由を付ける）
 *
 * 3 を紙にしているのは、選択肢の一覧では理由を書く場所が1行しか無いためである。
 *
 * ## AIは呼ばない
 *
 * 診断も案内も、答えとコードだけで決まる。はじめて使う日に、AIの準備が
 * できていなくても最後まで通れるようにしてある。
 */
export interface WriterDiagnosisDeps {
  profiles: WriterProfileStore;
  /** 作品をもう登録しているか。押せない案内を並べないために要る */
  hasWork(): boolean;
  /**
   * 6.86 の助言方針を、**作者ごとの既定**として読み書きする。
   *
   * 使用開始時にはまだ作品が1つも無いので、作品ごとの置き場へは書けない。
   * **9問の答えを捨てない**ために、作者ごとの既定に置く（設計書6.90.2）。
   */
  adviceDefault: {
    get(): AdviceProfile | undefined;
    set(profile: AdviceProfile): Promise<void>;
  };
}

export async function runWriterDiagnosis(
  deps: WriterDiagnosisDeps,
  options: { skipIntro?: boolean } = {}
): Promise<void> {
  const existing = deps.profiles.get();

  if (existing && !options.skipIntro) {
    const action = await chooseAction(existing.style);
    if (!action) return;
    if (action === "guide") {
      await runTutorial(deps, existing.style);
      return;
    }
    if (action === "clear") {
      await deps.profiles.clear();
      logStep("作家タイプ診断：答えを消した");
      void vscode.window.showInformationMessage(
        "診断の答えを消しました。案内は出なくなります（作品や設定資料には影響しません）。"
      );
      return;
    }
  }

  const style = await askStyle(existing?.style);
  if (!style) return;

  await deps.profiles.set(style);
  await deps.profiles.setWelcomeState("done");
  logStep(`作家タイプ診断：${describeWriterStyle(style)}`);

  // **6.86 の9問も、ここで聞く**（作者の指摘、2026-09-13
  // 「診断に11タイプは入ってないということですか？」）。
  // 断ってもここまでの5問は残る
  if (!(await askAdvicePart(deps))) return;

  await runTutorial(deps, style);
}

/**
 * 相談の助言方針（6.86）の9問。**断れるようにする。**
 *
 * 5問の時点で一区切りついているので、ここから先は「もっと合わせたい人」
 * 向けである。**何のための9問かを先に言ってから聞く**（作者の指摘、
 * 2026-09-13「アドバイスしてから選択肢を表示してください」）。
 *
 * **答えは作者ごとの既定へ置く。** 使用開始時にはまだ作品が無いので、
 * 作品ごとの置き場には書けない。作品ができたら、相談がここから始まる
 * （`AdvicePolicyStore.getEffective`）。
 */
async function askAdvicePart(deps: WriterDiagnosisDeps): Promise<boolean> {
  const existing = deps.adviceDefault.get();

  const GO = `続けて答える（${ADVICE_QUESTIONS.length}問）`;
  const SKIP = "ここで終える";
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: `$(comment-discussion) ${GO}`,
        detail:
          "同じ助言でも、書き手によって正反対の意味で届きます。「もっと読者を意識して」は、読者を見ていない人には気づきになりますが、題材そのものが目的の人には「別人になれ」と聞こえます。その言い分けをするための9問です",
        go: true,
      },
      {
        label: `$(check) ${SKIP}`,
        detail:
          "ここまでの5問で、次にすることの案内はできます。あとから「相談の助言方針を決める」でいつでも答えられます",
        go: false,
      },
      cancelItem(),
    ],
    {
      title: "作家タイプ診断（ここまで5問）",
      placeHolder: "AIの言い方も、あなたに合わせますか",
      ignoreFocusOut: true,
    }
  );
  // **3つの道を分けておく。** 「ここで終える」は案内まで進む、
  // 「取りやめる」と Esc は閉じる。5問の答えはどちらでも残る
  if (!picked || isCancelItem(picked)) return false;
  if (!("go" in picked) || !picked.go) return true;

  const answers = await askAdviceQuestions(existing?.answers);
  // 9問の途中でやめても、5問の案内までは出す
  if (!answers) return true;

  const scores = scoreAnswers(answers);
  const fresh: AdviceProfile = {
    scores,
    baseScores: scores,
    answers,
    updatedAt: new Date().toISOString(),
    // 調子は聞かない（6.86.2）。相談での推定が届いたときに埋まる
    state: existing?.state,
    history: existing?.history,
  };
  await deps.adviceDefault.set(appendAdviceHistory(existing, fresh, "diagnosis"));
  logStep(
    `作家タイプ診断：相談の助言方針は` +
      `${ADVICE_TYPES[resolveAdviceType(scores)].label}`
  );
  return true;
}

type DiagnosisAction = "redo" | "guide" | "clear";

async function chooseAction(
  style: WriterStyle
): Promise<DiagnosisAction | undefined> {
  const plan = WRITER_PLAN_TYPES[style.plan];
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "$(compass) はじめの案内をもう一度見る",
        detail: "いまの答えのまま、次に何をするとよいかを案内します",
        action: "guide" as const,
      },
      {
        label: "$(refresh) 5問を答え直す",
        detail: "前回の答えに印が付きます。書き方が変わったときに",
        action: "redo" as const,
      },
      {
        label: "$(trash) 答えを消す",
        detail: "案内が出なくなります（作品や設定資料には影響しません）",
        action: "clear" as const,
      },
      cancelItem(),
    ],
    {
      title: "作家タイプ診断",
      placeHolder: `いまは「${plan.label}」として案内しています（${describeWriterStyle(style)}）`,
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked)) return undefined;
  return "action" in picked ? picked.action : undefined;
}

/**
 * 5問を順に聞く。
 *
 * **Esc で取りやめたら、何も保存しない**（6.86 の診断と同じ）。
 * 途中まで答えた分を残すと、次に開いたときに半端な値が「前回の答え」として出る。
 */
async function askStyle(
  previous: WriterStyle | undefined
): Promise<WriterStyle | undefined> {
  const answers: Record<string, string> = {};

  for (const [index, question] of WRITER_QUESTIONS.entries()) {
    const before = previous?.[question.key];
    const picked = await vscode.window.showQuickPick(
      [
        ...question.choices.map((choice) => ({
          label: choice.label,
          description: choice.value === before ? "$(check) 前回の答え" : undefined,
          detail: choice.detail,
          value: choice.value,
        })),
        cancelItem(),
      ],
      {
        title: `作家タイプ診断（${index + 1}/${WRITER_QUESTIONS.length}）`,
        placeHolder: question.text,
        ignoreFocusOut: true,
      }
    );
    if (!picked || isCancelItem(picked)) return undefined;
    if (!("value" in picked)) return undefined;
    answers[question.key] = picked.value;
  }

  return buildWriterStyle(answers);
}

/**
 * 聞き取り → 紙で助言 → 操作。
 *
 * **目的を選び直せるようにする。** 紙を読んで「思っていたのと違う」と
 * 気づくことがあるので、操作の一覧から戻れる道を残す。
 */
async function runTutorial(
  deps: WriterDiagnosisDeps,
  style: WriterStyle
): Promise<void> {
  for (;;) {
    const goal = await askGoal(style, deps.hasWork());
    if (!goal) return;

    const advice = tutorialAdvice(style, goal.goal);

    // **紙を先に開く。** 操作の一覧より前に、なぜそれを勧めるのかを読ませる
    await openGeneratedMarkdown(
      WRITER_GUIDE_TITLE,
      buildWriterGuide({
        style,
        goal,
        advice,
        advicePolicy: describeAdviceDefault(deps),
      }),
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }
    );

    const step = await askStep(goal, advice.steps, [
      ...advice.later,
      // **出さないと決めたものも、決めたと分かるように出す**（0.52.0）
      ...(advice.withheld ?? []).map(
        (line) => `いまは出していません：${line}`
      ),
    ]);
    if (step === "back") continue;
    if (!step) return;

    logStep(`はじめの案内：${goal.label} → ${step.label}`);
    await vscode.commands.executeCommand(step.command);
    return;
  }
}

async function askGoal(
  style: WriterStyle,
  hasWork: boolean
): Promise<TutorialGoalInfo | undefined> {
  const goals = tutorialGoals(style, hasWork);

  // 1つしか無いときは選ばせない（選択肢が1つの画面は、ただの確認になる）
  if (goals.length === 1) return goals[0];

  const picked = await vscode.window.showQuickPick(
    [
      ...goals.map((goal) => ({
        label: goal.label,
        // **なぜこれが出ているかを、選ぶ前に読ませる**
        detail: goal.why,
        goal,
      })),
      cancelItem(),
    ],
    {
      title: "はじめの案内",
      placeHolder: "いま、いちばんやりたいことはどれですか",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked)) return undefined;
  return "goal" in picked ? picked.goal : undefined;
}

async function askStep(
  goal: TutorialGoalInfo,
  steps: { command: string; label: string; why: string }[],
  later: string[]
): Promise<{ command: string; label: string } | "back" | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      ...steps.map((step, index) => ({
        label: `${index + 1}. ${step.label}`,
        detail: step.why,
        step,
      })),
      ...later.map((line) => ({
        label: "$(info) " + line,
        // **押せないものを押せる顔で出さない**（`processAvailability.ts` と
        // 同じ考え方）。選んでも何も起きず、一覧へ戻る
        detail: "いまはまだできません（説明だけ）",
        step: undefined,
      })),
      {
        label: "$(arrow-left) やりたいことを選び直す",
        detail: "紙を読んで、別のほうが近いと思ったら",
        step: undefined,
        back: true,
      },
      cancelItem(),
    ],
    {
      title: `はじめの案内：${goal.label}`,
      placeHolder: "横に開いた紙に、それぞれの理由が書いてあります",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked)) return undefined;
  if ("back" in picked && picked.back) return "back";
  if ("step" in picked && picked.step) return picked.step;
  // 説明だけの行を選んだときは、もう一度同じ一覧を出す
  return askStep(goal, steps, later);
}

/**
 * はじめての立ち上げで、1回だけ声をかける（設計書6.90.3）。
 *
 * **モーダルにしない。** 作者が原稿を開いた瞬間に前をふさぐと、
 * 「何か始まった」という印象だけが残る。通知で、断る道を並べて出す。
 *
 * **「あとで」は1回だけ許す。** 2回目に「あとで」を選んだら、もう出さない
 * ——3回目以降は、ただ邪魔になる。
 */
export async function offerWriterDiagnosis(
  deps: WriterDiagnosisDeps
): Promise<void> {
  if (deps.profiles.get()) return;
  const state = deps.profiles.welcomeState();
  if (state === "done") return;

  const START = "診断する（5問）";
  const LATER = "あとで";
  const NEVER = "出さない";
  const picked = await vscode.window.showInformationMessage(
    "はじめまして。5問お答えいただくと、あなたの書き方に合わせて" +
      "次にすることを案内します（AIは使いません）。",
    START,
    LATER,
    NEVER
  );

  if (picked === START) {
    await runWriterDiagnosis(deps, { skipIntro: true });
    return;
  }
  if (picked === NEVER) {
    await deps.profiles.setWelcomeState("done");
    return;
  }
  // 「あとで」または通知を閉じた。2回目までは出す
  await deps.profiles.setWelcomeState(state === "later" ? "done" : "later");
}

/** 結果を1行で言う（操作ログとステータスの説明で使う） */
export function describeWriterDiagnosis(style: WriterStyle): string {
  return diagnosisNarrative(style)[0];
}

/**
 * 作者ごとの既定から、11タイプの名前と説明を引く。
 *
 * **決めていなければ何も返さない。** 決めていない人に「あなたは◯◯型です」
 * と出すと、答えていないものを見せることになる。
 */
function describeAdviceDefault(
  deps: WriterDiagnosisDeps
): { label: string; summary: string } | undefined {
  const profile = deps.adviceDefault.get();
  if (!profile) return undefined;
  const info = ADVICE_TYPES[resolveAdviceType(profile.scores)];
  return { label: info.label, summary: info.summary };
}
