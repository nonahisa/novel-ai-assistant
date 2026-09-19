import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import type { AuthorReaderTypeStore } from "../core/authorReaderTypeStore";
import {
  authorReaderProfileFromAnswers,
  authorReaderTypeLabel,
  describeAuthorReaderChange,
  describeAuthorReaderHistory,
  AUTHOR_READER_QUESTIONS,
  AUTHOR_READER_REDIAGNOSE_DAYS,
  isAuthorReaderStale,
  type AuthorReaderProfile,
} from "../core/authorReaderType";
import { compareAuthorReader } from "../core/authorReaderGap";
import { READER_TYPES, resolveReaderType } from "../core/readerTarget";
import { ReaderTargetStore } from "../core/readerTargetStore";
import { cancelItem, isCancelItem } from "../views/dialogs";
import { logFailure, logStep, useLogFile } from "../core/logger";

/**
 * 作者自身の読者タイプ（設計書6.101、実装の順「1」「2」）。
 *
 * **作品のターゲット読者診断（6.91）とは別物である。** あちらは
 * 「この作品は誰に届けるか」を作品ごとに持つ。こちらは
 * 「**あなた自身が読者として何を求めるか**」で、**作者ごとに1つ**。
 *
 * 聞き方は 6.86（助言方針）の診断をそのまま写す——前回の答えに印を付け、
 * 途中でやめられ、焦点が外れても消えない。
 *
 * **問いは 6.91 のものを主語だけ変えて使う**（`AUTHOR_READER_QUESTIONS`）。
 * 診断を3つに増やすと27問になり、答えるのが苦行になる。
 *
 * ## 作品が分かるときだけ、突き合わせる
 *
 * 作品が手元にあれば、その作品のターゲット読者と突き合わせて
 * **ズレ（または重なり）**を最後に見せる。**作品を選ばせには行かない**
 * ——ここで保存するのは作者ごとの答えで、作品の情報ではないからである。
 * 作品ごとの見え方は、ターゲット読者診断の紙のほうに出る。
 */

export async function setAuthorReaderType(
  store: AuthorReaderTypeStore,
  work?: WorkEntry
): Promise<void> {
  // **作品が分かるときは、その作品のログへ向ける。** 分からないときは
  // 出力チャンネルに残る——ここで答えるのは作者ごとの答えなので、
  // どれか1つの作品のログへ無理に押し込まない
  if (work) useLogFile(work.folderPath);

  const existing = store.get();

  if (existing) {
    const action = await chooseAction(existing);
    if (!action) return;
    if (action === "show") {
      await showResult(existing, "いまの読者タイプ", work);
      return;
    }
    if (action === "clear") {
      await clearType(store);
      return;
    }
  }

  const answers = await askAuthorReaderQuestions(existing?.answers);
  if (!answers) return;

  const profile = authorReaderProfileFromAnswers(
    answers,
    new Date(),
    existing
  );
  await store.set(profile);
  logStep(`自分の読者タイプ: ${authorReaderTypeLabel(profile)}`);

  await showResult(profile, "あなた自身の読者タイプ", work, existing);
}

type TypeAction = "redo" | "show" | "clear";

async function chooseAction(
  profile: AuthorReaderProfile
): Promise<TypeAction | undefined> {
  const type = READER_TYPES[resolveReaderType(profile.scores)];
  const stale = isAuthorReaderStale(profile, new Date());

  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "$(refresh) 答え直す",
        detail: stale
          ? `前にお答えいただいてから${AUTHOR_READER_REDIAGNOSE_DAYS}日以上たっています。読むものは変わります`
          : "9問にもう一度お答えいただきます（前回の答えに印が付きます）",
        action: "redo" as const,
      },
      {
        label: "$(eye) いまの読者タイプを見る",
        detail: `${type.label}：${type.summary}`,
        action: "show" as const,
      },
      {
        label: "$(trash) 消す",
        detail:
          "答えを消します。作品のファイルや設定資料には影響しません",
        action: "clear" as const,
      },
      cancelItem(),
    ],
    {
      title: "あなた自身の読者タイプ",
      placeHolder: `いまは「${type.label}」としてお預かりしています`,
      ignoreFocusOut: true,
    }
  );

  if (!picked || isCancelItem(picked)) return undefined;
  return "action" in picked ? picked.action : undefined;
}

/**
 * 9問を順に聞く。
 *
 * **Esc で取りやめたら、何も保存しない**（`askAdviceQuestions`・
 * `askReaderQuestions` と同じ約束）。途中まで答えた分を残すと、
 * 次に開いたときに「前回の答え」として半端な値が出てくる。
 */
export async function askAuthorReaderQuestions(
  previous?: number[]
): Promise<number[] | undefined> {
  const answers: number[] = [];

  for (const [index, question] of AUTHOR_READER_QUESTIONS.entries()) {
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
        title: `あなた自身の読者タイプ ${index + 1}/${AUTHOR_READER_QUESTIONS.length}`,
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

async function clearType(store: AuthorReaderTypeStore): Promise<void> {
  const yes = await vscode.window.showWarningMessage(
    "あなた自身の読者タイプを消しますか。",
    {
      modal: true,
      detail:
        "これまでの変化の記録も一緒に消えます。\n" +
        "作品のファイルや設定資料、作品ごとのターゲット読者診断には影響しません。\n" +
        "もう一度お答えいただければ作り直せます。",
    },
    "消す"
  );
  if (yes !== "消す") return;

  await store.clear();
  void vscode.window.showInformationMessage(
    "あなた自身の読者タイプを消しました。"
  );
}

/**
 * 結果を見せる。
 *
 * **変わったら必ず3点を出す**（何が何に変わったか・なぜそう読み取ったか・
 * 戻し方）。6.86 と同じ約束で、黙って変えると助言の調子が変わった理由が
 * 作者に分からなくなる。
 *
 * 作品が分かるときは、その作品のターゲット読者との突き合わせも添える。
 * **材料が無ければ何も足さない**（推測で埋めない）。
 */
async function showResult(
  profile: AuthorReaderProfile,
  title: string,
  work?: WorkEntry,
  previous?: AuthorReaderProfile
): Promise<void> {
  const type = READER_TYPES[resolveReaderType(profile.scores)];

  const lines = [
    type.summary,
    "",
    `あなたに効くのは、${type.works}`,
    `あなたが離れるのは、${type.loses}`,
  ];

  const change = describeAuthorReaderChange(previous, profile);
  if (change.length > 0) lines.push("", ...change);

  const history = describeAuthorReaderHistory(profile);
  if (history.length > 0) lines.push("", "これまでの変化", ...history);

  const comparison = work ? await compareWithWork(profile, work) : undefined;
  if (comparison) lines.push("", `${work?.title}との突き合わせ`, ...comparison);

  lines.push(
    "",
    "これは作品の宛先ではなく、あなた自身の読み方です。",
    "答えはこの端末の中だけに残り、作品のファイルにもGitHubにも入りません。",
    "上下はありません——どの層にもその層なりの読み方があり、効く相手が違うだけです。"
  );

  await vscode.window.showInformationMessage(`${title}——${type.label}`, {
    modal: true,
    detail: lines.join("\n"),
  });
}

/**
 * その作品のターゲット読者と突き合わせる。
 *
 * **読めなかったら黙る。** 台帳が壊れていても、9問に答えた手間まで
 * 巻き添えにしない（記録には残す）。
 */
async function compareWithWork(
  profile: AuthorReaderProfile,
  work: WorkEntry
): Promise<string[] | undefined> {
  try {
    const target = await new ReaderTargetStore(work).load();
    return compareAuthorReader(profile, target)?.lines;
  } catch (error) {
    logFailure("読者像を読めなかったため、突き合わせを省きました", {
      作品: work.title,
      理由: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
