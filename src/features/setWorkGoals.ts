import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { scanWork } from "../core/scanner";
import { isDateKey, type ContestGoal, type WorkGoals } from "../models/workGoals";
import { readWorkGoalsOrEmpty, writeWorkGoals } from "../core/workGoalsStore";
import {
  buildContestProgress,
  describeContestProgress,
} from "../core/contestProgress";
import { statsDayKey } from "../core/writingStats";
import { boundaryHour } from "./writingProgress";
import { readWorkFormat } from "../core/workFormatStore";
import { episodeUnit } from "../core/episodeLabel";
import { askText, cancelItem, isCancelItem } from "../views/dialogs";

/**
 * 作品ごとの目標を決める（設計書6.3.6）。
 *
 * VS Codeの設定（`novelai.stats.dailyGoal`）は**登録している全作品で共有**
 * している。短編を1本仕上げるのと大長編を書き続けるのとでは狙いが違うので、
 * 作品ごとの目標をここで持つ。
 *
 * **コンテストの一覧は同梱しない。** 募集は日々変わり、締切も規定も入れ替わる。
 * 古い一覧を抱えるより、**作者が募集要項を見て入れる**ほうが確かである。
 * 探す場所は案内に書く。
 */

/** 募集を探す場所。同梱する一覧の代わりに、行き先だけを示す */
const CONTEST_DIRECTORIES = [
  { label: "文学賞・公募の一覧", url: "https://creative-story.net/bungakusyou/" },
  {
    label: "投稿サイトのコンテスト一覧",
    url: "https://creative-story.net/202111contest/",
  },
];

export async function setWorkGoals(work: WorkEntry): Promise<void> {
  const goals = await readWorkGoalsOrEmpty(work);

  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "$(edit) 1記事あたりの目標文字数",
        description: goals.perEpisodeChars
          ? `いま ${goals.perEpisodeChars.toLocaleString("ja-JP")}字`
          : "未設定",
        detail:
          "1話（1投稿）をどれくらいの長さで書くかの狙いです。" +
          "決めると、文字数一覧の「長い・短い」を平均ではなく目標と比べます。",
        action: "perEpisode" as const,
      },
      {
        label: "$(calendar) 応募先の締切と目標",
        description: goals.contest
          ? `${goals.contest.name}（${goals.contest.deadline}）`
          : "未設定",
        detail:
          "締切日・作品の文字量・日間目標を入れると、" +
          "執筆量パネルに「あと何日・あと何字・1日あたり何字」が出ます。",
        action: "contest" as const,
      },
      ...(goals.contest
        ? [
            {
              label: "$(trash) 応募先の情報を消す",
              description: goals.contest.name,
              detail: "締切の表示をやめます。書いたものは消えません。",
              action: "clearContest" as const,
            },
          ]
        : []),
      // **一覧の中に出口を置く。** Escを知らない作者にも見える
      { ...cancelItem(), action: "cancel" as const },
    ],
    {
      title: `「${work.title}」の目標`,
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked)) return;

  if (picked.action === "perEpisode") {
    const updated = await editPerEpisode(work, goals);
    if (updated) await save(work, updated);
    return;
  }
  if (picked.action === "clearContest") {
    await save(work, { ...goals, contest: null });
    vscode.window.showInformationMessage("応募先の情報を消しました。");
    return;
  }

  const contest = await editContest(goals.contest);
  if (!contest) return;
  await save(work, { ...goals, contest });
  await reportContest(work, contest);
}

async function editPerEpisode(
  work: WorkEntry,
  goals: WorkGoals
): Promise<WorkGoals | undefined> {
  const noun = episodeUnit(await readWorkFormat(work)).noun;
  const input = await askText({
    title: `1${noun}あたりの目標文字数`,
    prompt: "空にすると未設定に戻ります",
    value: goals.perEpisodeChars ? String(goals.perEpisodeChars) : "",
    placeHolder: "3000",
    ignoreFocusOut: true,
    validateInput: (value) => validateOptionalCount(value),
  });
  if (input === undefined) return undefined;

  const trimmed = input.trim();
  return { ...goals, perEpisodeChars: trimmed ? Number(trimmed) : null };
}

/**
 * 応募先を入れてもらう。
 *
 * **1画面ずつ順に訊く。** まとめて入れる画面（WebView）にすると、
 * 締切だけ直したいときにも全部を入れ直すことになる。
 * 既に入っている値を初期値に置くので、直したいところだけ書き換えられる。
 */
async function editContest(
  current: ContestGoal | null
): Promise<ContestGoal | undefined> {
  if (!current) {
    // 初めて入れるときだけ、どこで探すかを案内する
    const guide = await vscode.window.showQuickPick(
      [
        { label: "$(edit) 入力する", action: "input" as const },
        ...CONTEST_DIRECTORIES.map((site) => ({
          label: `$(link-external) ${site.label}を開く`,
          detail: site.url,
          action: "open" as const,
          url: site.url,
        })),
        { ...cancelItem(), action: "cancel" as const, url: undefined },
      ],
      {
        title: "応募先の情報を入れます",
        placeHolder: "募集要項の締切日と文字数を手元に用意してください",
        ignoreFocusOut: true,
      }
    );
    if (!guide || isCancelItem(guide)) return undefined;
    if (guide.action === "open") {
      await vscode.env.openExternal(vscode.Uri.parse(guide.url!));
      // 開いたあとも入力へ進む。読んでから戻ってくる手間を省く
    }
  }

  const name = await askText({
    title: "応募先の名前",
    prompt: "賞やコンテストの名前を入れてください",
    value: current?.name ?? "",
    placeHolder: "第40回ファンタジア大賞（前期）",
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim() ? null : "名前を入れてください",
  });
  if (name === undefined) return undefined;

  const deadline = await askText({
    title: "締切日",
    prompt: "YYYY-MM-DD の形で入れてください",
    value: current?.deadline ?? "",
    placeHolder: "2026-08-31",
    ignoreFocusOut: true,
    validateInput: (value) =>
      isDateKey(value.trim())
        ? null
        : "YYYY-MM-DD の形で入れてください（例: 2026-08-31）",
  });
  if (deadline === undefined) return undefined;

  const minChars = await askText({
    title: "作品の文字量（下限）",
    prompt: "「10万字以上」なら 100000。無ければ空のまま",
    value: current?.minChars ? String(current.minChars) : "",
    ignoreFocusOut: true,
    validateInput: (value) => validateOptionalCount(value),
  });
  if (minChars === undefined) return undefined;

  const maxChars = await askText({
    title: "作品の文字量（上限）",
    prompt: "「8,000字以内」なら 8000。無ければ空のまま",
    value: current?.maxChars ? String(current.maxChars) : "",
    ignoreFocusOut: true,
    validateInput: (value) => {
      const basic = validateOptionalCount(value);
      if (basic) return basic;
      const max = Number(value.trim());
      const min = Number(minChars.trim());
      // 逆に入っていると、達成率も残り字数も意味を成さない
      if (value.trim() && minChars.trim() && max < min) {
        return "下限より小さい値は入れられません";
      }
      return null;
    },
  });
  if (maxChars === undefined) return undefined;

  const dailyGoal = await askText({
    title: "日間目標（任意）",
    prompt:
      "空にすると、残り字数と締切までの日数から自動で割り出します。" +
      "「平日は書けない」など事情があるときだけ入れてください",
    value: current?.dailyGoal ? String(current.dailyGoal) : "",
    ignoreFocusOut: true,
    validateInput: (value) => validateOptionalCount(value),
  });
  if (dailyGoal === undefined) return undefined;

  return {
    name: name.trim(),
    // URLは入力させない。募集要項を開く導線は上で示している
    url: current?.url ?? null,
    deadline: deadline.trim(),
    minChars: toCountOrNull(minChars),
    maxChars: toCountOrNull(maxChars),
    dailyGoal: toCountOrNull(dailyGoal),
  };
}

/** 入れた直後に、いまの進み具合を見せる */
async function reportContest(
  work: WorkEntry,
  contest: ContestGoal
): Promise<void> {
  let written = 0;
  try {
    written = (await scanWork(work)).stats.totals.net;
  } catch {
    // 走査できなくても保存は済んでいる
  }
  const progress = buildContestProgress(
    { schemaVersion: "0.1", perEpisodeChars: null, contest },
    written,
    statsDayKey(new Date(), boundaryHour())
  );
  if (!progress) return;

  const answer = await vscode.window.showInformationMessage(
    describeContestProgress(progress),
    "執筆量を見る"
  );
  if (answer === "執筆量を見る") {
    await vscode.commands.executeCommand("novelai.showWritingStats", {
      type: "work",
      work,
    });
  }
}

async function save(work: WorkEntry, goals: WorkGoals): Promise<void> {
  try {
    await writeWorkGoals(work, goals);
  } catch (error) {
    vscode.window.showErrorMessage(
      `目標を保存できませんでした: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/** 空欄は「決めていない」。入れるなら正の整数 */
function validateOptionalCount(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return "半角の数字で入れてください";
  if (Number(trimmed) <= 0) return "1以上で入れてください";
  return null;
}

function toCountOrNull(value: string): number | null {
  const trimmed = value.trim();
  return trimmed ? Number(trimmed) : null;
}
