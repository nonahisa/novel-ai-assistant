import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import type { AdvicePolicyStore } from "../core/advicePolicyStore";
import {
  ADVICE_QUESTIONS,
  ADVICE_TYPES,
  appendAdviceHistory,
  describeAdviceHistory,
  describeAdviceScoreShift,
  resolveAdviceType,
  scoreAnswers,
  type AdviceProfile,
} from "../core/advicePolicy";
import { cancelItem, isCancelItem } from "../views/dialogs";

/**
 * 相談の助言方針を決める診断（設計書6.86）。
 *
 * **ここは初期値を決める入口である。** 9問で3軸（読者志向・自己投影度・
 * 嗜好志向）を測ってタイプを決めたあとは、相談での発言から少しずつ
 * 推定で動く（`applyProfileSignals`）。やり直すと、推定で動いたぶんは
 * 消えて自己申告の値に戻る。
 *
 * **「いまの調子」（受容度・自信度）はここで聞かない**（作者の裁定、
 * 2026-09-07）。相談の中の発言から推定するだけで、画面にも出さない。
 * 見せるとラベルになって、それ自体が地雷になる。
 */

export async function setAdvicePolicy(
  work: WorkEntry,
  store: AdvicePolicyStore
): Promise<void> {
  const existing = store.get(work.id);

  if (existing) {
    const action = await chooseAction(work, existing, !!store.getDefault());
    if (!action) return;
    if (action === "show") {
      await showResult(work, existing, "いまの助言方針");
      return;
    }
    if (action === "clear") {
      await clearPolicy(work, store);
      return;
    }
  }

  // 「全部やり直す」と、まだ一度も答えていない場合
  const answers = await askAdviceQuestions(existing?.answers);
  if (!answers) return;

  const scores = scoreAnswers(answers);
  const fresh: AdviceProfile = {
    scores,
    // 診断した時点の値。以後この値と現在の値を並べて見せる
    baseScores: scores,
    answers,
    updatedAt: new Date().toISOString(),
    // 調子は聞かない。相談での推定が届いたときに埋まる
    state: existing?.state,
    history: existing?.history,
  };
  // 前回を履歴へ積む（初回は積むものが無い）
  const profile = appendAdviceHistory(existing, fresh, "diagnosis");

  await store.set(work.id, profile);
  await showResult(work, profile, "助言方針を決めました", existing);
}

type PolicyAction = "redo" | "show" | "clear";

async function chooseAction(
  work: WorkEntry,
  profile: AdviceProfile,
  hasDefault: boolean
): Promise<PolicyAction | undefined> {
  const type = ADVICE_TYPES[resolveAdviceType(profile.scores)];

  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "$(refresh) 全部やり直す",
        detail:
          "9問の診断からやり直します（前回の答えに印が付きます）。" +
          "相談での推定で動いたぶんは、答えた値に戻ります",
        action: "redo" as const,
      },
      {
        label: "$(eye) いまの方針を見る",
        detail: `${type.label}：${type.summary}`,
        action: "show" as const,
      },
      {
        label: "$(trash) 方針を消す",
        // **行き先を正しく言う**（0.51.1）。既定があるときは素ではなくそこへ戻る
        detail: hasDefault
          ? "この作品だけの方針を外します。診断で答えた既定に戻ります"
          : "相談は素の状態に戻ります（作品や設定資料には影響しません）",
        action: "clear" as const,
      },
      cancelItem(),
    ],
    {
      title: `${work.title}：相談の助言方針`,
      placeHolder: `いまは「${type.label}」で相談しています`,
      ignoreFocusOut: true,
    }
  );

  if (!picked || isCancelItem(picked)) return undefined;
  return "action" in picked ? picked.action : undefined;
}

/**
 * 9問を順に聞く。
 *
 * **Esc で取りやめたら、何も保存しない。** 途中まで答えた分を残すと、
 * 次に開いたときに「前回の答え」として半端な値が出てくる。
 *
 * **使用開始時の診断（6.90）からも呼ぶ**ので外へ出してある。写しを作ると、
 * 聞き方（前回の答えの印・やめる道・焦点が外れても消えないこと）が
 * 2か所に分かれ、片方だけ直る日が来る。
 */
export async function askAdviceQuestions(
  previous?: number[]
): Promise<number[] | undefined> {
  const answers: number[] = [];

  for (const [index, question] of ADVICE_QUESTIONS.entries()) {
    const before = previous?.[index];
    const picked = await vscode.window.showQuickPick(
      [
        ...question.choices.map((choice, choiceIndex) => ({
          label: choice.label,
          description:
            choiceIndex === before ? "$(check) 前回の答え" : undefined,
          value: choiceIndex,
        })),
        // 9問の途中でやめられることを見える形にする。Esc も効く
        cancelItem("診断をやめる"),
      ],
      {
        title: `相談の助言方針 ${index + 1}/${ADVICE_QUESTIONS.length}`,
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

async function clearPolicy(
  work: WorkEntry,
  store: AdvicePolicyStore
): Promise<void> {
  const yes = await vscode.window.showWarningMessage(
    "相談の助言方針を消しますか。",
    {
      modal: true,
      // **行き先を正しく言う**（0.51.1）。作者ごとの既定（使用開始時の診断で
      // 答えたもの）があるときは、素ではなくそこへ戻る
      detail:
        (store.getDefault()
          ? "以後、この作品の相談は、診断で答えた既定の方針に戻ります。\n"
          : "以後、相談は素の状態に戻ります（タイプ別の方針を渡しません）。\n") +
        "この作品でのこれまでの変化の記録も一緒に消えます。\n" +
        "作品のファイルや設定資料には影響しません。もう一度診断すれば作り直せます。",
    },
    "消す"
  );
  if (yes !== "消す") return;

  await store.clear(work.id);
  void vscode.window.showInformationMessage(
    `${work.title}：相談の助言方針を消しました。`
  );
}

/**
 * 結果を見せる。
 *
 * **何が変わるのかまで書く。** 診断だけ出して終わると、
 * 作者はこの結果がどこで使われるのか分からない。
 *
 * 受容度・自信度はここに出さない（見せないと決めたもの）。
 */
async function showResult(
  work: WorkEntry,
  profile: AdviceProfile,
  title: string,
  previous?: AdviceProfile
): Promise<void> {
  const type = ADVICE_TYPES[resolveAdviceType(profile.scores)];

  const lines = [type.summary, "", ...describeAdviceScoreShift(profile)];

  // 診断し直してタイプが変わったときだけ、変化を1行で示す（初回は出ない）
  if (previous) {
    const before = ADVICE_TYPES[resolveAdviceType(previous.scores)].label;
    if (before !== type.label) {
      const when = previous.updatedAt.slice(0, 10);
      lines.push("", `前回：${before}（${when}）→ 今回：${type.label}`);
    }
  }

  const history = describeAdviceHistory(profile);
  if (history.length > 0) {
    lines.push("", "これまでの変化", ...history);
  }

  lines.push(
    "",
    "相談のたびに、このタイプ向けの方針だけを AI に渡します。",
    "この後は相談での発言から少しずつ推定で動きます。",
    "固定したいときは診断をやり直してください。"
  );

  await vscode.window.showInformationMessage(
    `${work.title}：${title}——${type.label}`,
    { modal: true, detail: lines.join("\n") }
  );
}
