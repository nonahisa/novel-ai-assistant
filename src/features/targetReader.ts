// ログの書き先：作品ごと（`useLogFile(work.folderPath)`）
import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import type { AIRegistry } from "../ai/registry";
import {
  READER_QUESTIONS,
  READER_TYPES,
  resolveReaderType,
  scoreReaderAnswers,
  type ReaderTypeId,
} from "../core/readerTarget";
import { READER_TYPE_IDS } from "../core/readerTypeNeighbors";
import {
  ReaderTargetStore,
  ReaderTargetStoreError,
} from "../core/readerTargetStore";
import type { ReaderProfile } from "../models/readerProfile";
import type { AuthorReaderProfile } from "../core/authorReaderType";
import {
  applyAimToAuthorBlock,
  readAimReason,
  readAimTypes,
  TARGET_SHEET_AIM_LIMIT,
} from "../core/targetSheetDoc";
import type { TitleFitBasis } from "../core/titleFit";
import {
  CHECK_CANCELLED,
  CHECK_COMPLETED,
  CHECK_FAILED,
  type CheckCommandOutcome,
} from "../core/proofreadingSuite";
import { askText, cancelItem, isCancelItem } from "../views/dialogs";
import { warnWithLog } from "../views/notify";
import { logFailure, logStep, useLogFile } from "../core/logger";
import { askReaderQuestions, readFromWork } from "./readerTargetDiagnosis";
import {
  openTargetSheet,
  readTargetSheetState,
  refuseAuthorOwnedSheet,
  TARGET_READER_TITLE,
} from "./targetSheet";
import { measureTitleFit } from "./titleFit";

/**
 * 「ターゲット読者」——1つの入口に統合（設計書6.108.6）。
 *
 * 作者の指摘（2026-09-22 未明）：ターゲット読者診断・ターゲットシート・
 * 3つの輪は統合する。入口は詳細メニューと相談の案内の**「ターゲット読者」
 * 1つ**で、中は3段——
 *
 * | 段 | 何を聞く／測る | 誰が | 落ちる先 |
 * |---|---|---|---|
 * | 1 狙い | どんな読者に読んでもらいたいか（11層から1〜2つ＋理由1行） | 作者 | シートの作者の欄 |
 * | 2 書き方の判断 | 9問（あなたはこの作品で〜していますか） | 作者 | `設定/読者像.json` の宣言 |
 * | 3 本文の実像 | AIが冒頭とプロットを読む（P-38） | AI | `設定/読者像.json` の実像 |
 *
 * どの段も最後は**1枚のシート**（`設定/ターゲットシート.md`）へ落ちる。
 * タイトルとサブタイトルの適合度（P-41）は、料金が出るので段に入れず、
 * 押したときだけ測る。
 *
 * ## 途中でやめられる
 *
 * **済んだ段だけでシートを作る**（設計書6.108.6）。2段目の途中で閉じれば、
 * 1段目の狙いだけが残ったシートになる。途中まで答えた2段目は残さない
 * （半端な答えが次に「前回の答え」として出てくるため。6.91と同じ約束）。
 *
 * ## 旧入口は残す
 *
 * 「ターゲット読者診断」「ターゲットシート」「3つの輪」のコマンドは
 * これまでどおり動く（コマンドパレットと、既存の呼び出し元のため）。
 * 詳細メニューからは外し、この入口の選択肢から辿れるようにした。
 */

type Plan = "all" | "aim" | "declare" | "read" | "fit" | "sheet" | "circles";
type Stage = "aim" | "declare" | "read";

const STAGES_OF: Record<Plan, readonly Stage[]> = {
  all: ["aim", "declare", "read"],
  aim: ["aim"],
  declare: ["declare"],
  read: ["read"],
  fit: [],
  sheet: [],
  circles: [],
};

export interface TargetReaderSources {
  /** 作者自身の読者タイプ（3つの輪の1つ）。**未診断なら undefined** */
  readonly authorReader?: AuthorReaderProfile;
  /** 3つの輪の紙を開く（作家タイプなど、材料は呼ぶ側が持っている） */
  readonly openThreeCircles: (work: WorkEntry) => Promise<void>;
}

export async function runTargetReader(
  work: WorkEntry,
  registry: AIRegistry,
  sources: TargetReaderSources
): Promise<CheckCommandOutcome> {
  useLogFile(work.folderPath);

  const store = new ReaderTargetStore(work);
  let profile: ReaderProfile;
  try {
    profile = await store.load();
  } catch (error) {
    if (error instanceof ReaderTargetStoreError) {
      await warnWithLog(`読者像を読めませんでした。${error.message}`);
      return CHECK_FAILED;
    }
    throw error;
  }

  const state = await readTargetSheetState(work);
  // 作者が自分で置いた同名のファイルには、狙いも書き込まない
  if (state.authorOwned) {
    await refuseAuthorOwnedSheet(state);
    return CHECK_FAILED;
  }

  const plan = await choosePlan(work, profile, state.authorBlock);
  if (!plan) return CHECK_CANCELLED;

  if (plan === "circles") {
    await sources.openThreeCircles(work);
    return CHECK_COMPLETED;
  }

  if (plan === "fit") {
    const reader = await chooseFitReader(state.authorBlock, profile);
    if (!reader) return CHECK_CANCELLED;
    const measured = await measureTitleFit(work, registry, reader, state.settings);
    if (measured === "cancelled") return CHECK_CANCELLED;
    if (measured === "failed") return CHECK_FAILED;
    const opened = await openTargetSheet(work, { authorReader: sources.authorReader });
    return opened ? CHECK_COMPLETED : CHECK_FAILED;
  }

  let authorBlock = state.authorBlock;
  let next: ReaderProfile = { ...profile };
  let unmeasured: readonly string[] = [];
  let done = 0;

  for (const stage of STAGES_OF[plan]) {
    if (stage === "aim") {
      const result = await askAim(authorBlock);
      if (result.block !== undefined) {
        authorBlock = result.block;
        done += 1;
      }
      if (result.stopped) break;
      continue;
    }

    if (stage === "declare") {
      const answers = await askReaderQuestions(
        profile.declared?.answers,
        (index, total) =>
          `${TARGET_READER_TITLE} 2/3 書き方の判断 ${index + 1}/${total}`,
        "ここでやめる（済んだ段だけでシートを作る）"
      );
      // **途中まで答えた分は残さない**（半端な値が「前回の答え」になる）
      if (!answers) break;
      next = {
        ...next,
        declared: {
          scores: scoreReaderAnswers(answers),
          answers,
          updatedAt: new Date().toISOString(),
        },
      };
      done += 1;
      continue;
    }

    // stage === "read"
    const read = await readFromWork(work, registry);
    if (read === "cancelled") break;
    // 読めなかったときは、それまでの段だけでシートを作る
    // （AIの失敗で、作者が答えた狙いと9問を捨てない）
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
      done += 1;
    }
  }

  // 何も済まなかった（最初の段で閉じた）。**シートも作らない**
  // ——押しただけで紙が作り直されると、やめたつもりが済んだことになる
  if (plan !== "sheet" && done === 0) return CHECK_CANCELLED;

  if (next.declared !== profile.declared || next.actual !== profile.actual) {
    try {
      await store.save(next);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logFailure("読者像を保存できませんでした", { 詳細: detail });
      await warnWithLog("読者像を保存できませんでした。");
      // **保存できなくてもシートは作る。** 作者が答えた手間を無駄にしない
      // （答えた段は下で直に渡すので、シートには載る）
    }
  }

  logStep(`${TARGET_READER_TITLE}：${plan}（済んだ段 ${done}）`);
  const opened = await openTargetSheet(work, {
    authorBlock,
    authorReader: sources.authorReader,
    unmeasured,
    profile: next,
  });
  return opened ? CHECK_COMPLETED : CHECK_FAILED;
}

/**
 * 何をするかを選んでもらう。
 *
 * **選択肢の前に、いま何が分かっていて何が分かっていないかを言う**
 * （6.91 の作者の指摘、2026-09-13）。押す前に、なぜその道が出ているのかが
 * 分からないと選べない。
 */
async function choosePlan(
  work: WorkEntry,
  profile: ReaderProfile,
  authorBlock: string
): Promise<Plan | undefined> {
  const aims = readAimTypes(authorBlock);
  const aimNow =
    aims.length > 0
      ? `いま：${aims.map((type) => READER_TYPES[type].label).join("、")}`
      : "まだ選んでいません";
  const declaredNow = profile.declared
    ? `いま：${READER_TYPES[resolveReaderType(profile.declared.scores)].label}`
    : "まだ答えていません";
  const actualNow = profile.actual
    ? `いま：${READER_TYPES[resolveReaderType(profile.actual.scores)].label}`
    : "まだ読んでいません";

  const items = [
    {
      label: "3段とも通す",
      description: "狙い → 書き方の判断 → 本文の実像",
      detail:
        "途中でやめても、済んだ段だけでシートを作ります。3段目だけAIを使います。",
      plan: "all" as Plan,
    },
    {
      label: "1 狙いを選ぶ",
      description: aimNow,
      detail: "どんな読者に読んでもらいたいか。11の層から2つまでと、理由を1行。AIは使いません。",
      plan: "aim" as Plan,
    },
    {
      label: "2 書き方の判断に答える",
      description: declaredNow,
      detail: `この作品での書き方を${READER_QUESTIONS.length}問。AIは使いません。途中でやめられます。`,
      plan: "declare" as Plan,
    },
    {
      label: "3 本文の実像を読む",
      description: actualNow,
      detail: "冒頭とプロットをAIが読んで、向き先を測ります。本文は書き換えません。",
      plan: "read" as Plan,
    },
    {
      label: "タイトルとサブタイトルの適合度を測る",
      detail:
        "狙いの層（無ければ実像の層）に引かれる言い方かを、AIが題ごとに見立てます。題は書き換えません。",
      plan: "fit" as Plan,
    },
    {
      label: "いまの材料でシートを作り直す",
      detail: "何も聞かずに、1枚にまとめ直して開きます。AIは使いません。",
      plan: "sheet" as Plan,
    },
    {
      label: "3つの輪の紙を開く",
      detail:
        "書けたものの実績（話数・字数・反応）と、離れているときの近づける道まで並べた紙です。AIは使いません。",
      plan: "circles" as Plan,
    },
  ];

  // **閉じる道は、呼ぶところで渡す**（`quickPickCancel.test.ts` が呼び出しの
  // 本体を読んで見張るため）
  const picked = await vscode.window.showQuickPick(
    [...items, cancelItem("取りやめる")],
    {
      title: `${TARGET_READER_TITLE}：${work.title}`,
      placeHolder: "どこから始めますか。どの段も最後は1枚のシートにまとまります。",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked)) return undefined;
  return "plan" in picked ? picked.plan : undefined;
}

/**
 * 1段目：狙いと理由。
 *
 * - 選ばずに OK → **いまの狙いのまま**（空にはしない。消したいときは
 *   シートの欄を手で直す——押し間違いで作者の欄を空にしない）
 * - 3つ以上選んだら、選び直してもらう（黙って2つに削らない）
 * - 理由の窓を閉じたら、理由は変えずにここでやめる（狙いは残す）
 *
 * `block` は書き換えた作者の欄（最初の選択で閉じたら `undefined`＝
 * この段は済んでいない）、`stopped` はこの先の段へ進まないこと。
 */
async function askAim(
  authorBlock: string
): Promise<{ block?: string; stopped: boolean }> {
  const current = readAimTypes(authorBlock);
  let aims: ReaderTypeId[] | undefined;

  for (;;) {
    // 複数選択は VS Code が「OK」を出すので、閉じる項目は足さない
    // （`quickPickCancel.test.ts` の例外）
    const picked = await vscode.window.showQuickPick(
      READER_TYPE_IDS.map((type) => ({
        label: READER_TYPES[type].label,
        detail: READER_TYPES[type].summary,
        picked: current.includes(type),
        type,
      })),
      {
        title: `${TARGET_READER_TITLE} 1/3 狙い`,
        placeHolder:
          `どんな読者に読んでもらいたいですか（${TARGET_SHEET_AIM_LIMIT}つまで）。` +
          "選ばずに OK を押すと、いまの狙いのまま進みます。",
        canPickMany: true,
        ignoreFocusOut: true,
      }
    );
    if (!picked) return { stopped: true };
    if (picked.length > TARGET_SHEET_AIM_LIMIT) {
      await vscode.window.showWarningMessage(
        `狙いは${TARGET_SHEET_AIM_LIMIT}つまでです。選び直してください。` +
          "　3つ以上に向けると、どの層にも効く書き方が決まらなくなります。"
      );
      continue;
    }
    if (picked.length > 0) aims = picked.map((item) => item.type);
    break;
  }

  const reason = await askText({
    title: `${TARGET_READER_TITLE} 1/3 狙いの理由`,
    prompt:
      "なぜその読者に読んでもらいたいですか（1行。空でもかまいません）。" +
      "シートの「理由」の欄に入ります。",
    value: readAimReason(authorBlock),
  });

  // 狙いを選び終えた時点で、この段は済んだと数える（理由は任意の欄）
  return {
    block: applyAimToAuthorBlock(authorBlock, { aims, reason }),
    stopped: reason === undefined,
  };
}

/**
 * 適合度をどの層に向けて測るか（設計書6.108.6：狙いの型、無ければ実像の型）。
 *
 * **狙いが2つなら訊く**（どちらか一方を黙って選ぶと、作者が思っていない
 * 層に向けた点が出る）。狙いも実像も無ければ、書き方の判断の層で測る
 * ——それも無ければ測らない（推測で層を決めない）。
 */
async function chooseFitReader(
  authorBlock: string,
  profile: ReaderProfile
): Promise<{ type: ReaderTypeId; basis: TitleFitBasis } | undefined> {
  const aims = readAimTypes(authorBlock);
  if (aims.length === 1) return { type: aims[0], basis: "aim" };
  if (aims.length > 1) {
    const picked = await vscode.window.showQuickPick(
      [
        ...aims.map((type) => ({
          label: READER_TYPES[type].label,
          detail: READER_TYPES[type].summary,
          type,
        })),
        cancelItem("取りやめる"),
      ],
      {
        title: `${TARGET_READER_TITLE}：適合度を測る相手`,
        placeHolder: "狙いが2つあります。どちらの層に向けて測りますか",
        ignoreFocusOut: true,
      }
    );
    if (!picked || isCancelItem(picked)) return undefined;
    return "type" in picked ? { type: picked.type, basis: "aim" } : undefined;
  }
  if (profile.actual) {
    return { type: resolveReaderType(profile.actual.scores), basis: "actual" };
  }
  if (profile.declared) {
    return {
      type: resolveReaderType(profile.declared.scores),
      basis: "declared",
    };
  }
  await warnWithLog(
    "適合度を測る相手の層が決まっていません。先に「狙いを選ぶ」か、" +
      "書き方の判断・本文の実像のどれかを済ませてください。"
  );
  return undefined;
}
