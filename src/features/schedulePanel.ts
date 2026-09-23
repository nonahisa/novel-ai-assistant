import * as vscode from "vscode";
import * as paths from "../core/paths";
import type { WorkEntry } from "../models/types";
import {
  MILESTONE_LABELS,
  SCHEDULE_KIND_LABELS,
  type ScheduleFile,
  type ScheduleKind,
} from "../models/schedule";
import { isDateKey } from "../models/workGoals";
import type { WorkRegistry } from "../core/workRegistry";
import { ScheduleStore, ScheduleStoreError } from "../core/scheduleStore";
import {
  addSchedule,
  addStep,
  materializeGoalsSchedule,
  moveStep,
  removeSchedule,
  removeStep,
  updateSchedule,
  updateStep,
} from "../core/scheduleEdit";
import { createSchedule, defaultIdMaker } from "../core/scheduleTemplates";
import { parseScheduleMessage, type ScheduleMessage } from "../core/scheduleMessages";
import { readWorkGoalsOrEmpty } from "../core/workGoalsStore";
import { scanWork } from "../core/scanner";
import { findLatestEpisode } from "../core/latestEpisode";
import { logFailure, useLogFile } from "../core/logger";
import { askText, cancelItem, isCancelItem } from "../views/dialogs";
import { confirmRun } from "../views/notify";
import { openInDefaultEditor } from "../views/openDocument";
import { buildSchedulePanelHtml } from "../views/schedulePanelHtml";
import { columnForLocation, wideViewColumn } from "./editorColumn";
import { loadScheduleBoard, scheduleToday } from "./scheduleData";
import { importHolidays, loadHolidays } from "./holidayImport";
import { exportScheduleIcs } from "./scheduleCalendarExport";

/**
 * スケジュールの画面（設計書6.111）。**全作品を1枚に並べる**（縦が時間、横が作品）。
 *
 * ## 書き換えは「読み直してから当てる」
 *
 * 画面から直すたびに、**そのときのファイルを読み直し**、そこへ変更を1つ当てて保存する。
 * 画面を開いたときの中身を持ち回って書き戻すと、そのあいだに同期で降ってきた
 * 「済み」を消してしまう。読み直してから当てれば、ほかの機器の変更に自分の1つを
 * 足すだけになる。読み直しと保存のあいだに書き換わったときは、保存の照合
 * （`ScheduleStore`）が止める。
 */

let panel: vscode.WebviewPanel | undefined;
let showFinished = false;
/** 祝日の控え（保管庫）を読むのに要る。画面を開いたときに受け取る */
let panelContext: vscode.ExtensionContext | undefined;

export interface SchedulePanelDeps {
  readonly registry: WorkRegistry;
  readonly deviceId: string;
}

export async function openSchedulePanel(
  context: vscode.ExtensionContext,
  deps: SchedulePanelDeps
): Promise<void> {
  if (deps.registry.list().length === 0) {
    void vscode.window.showInformationMessage("作品が登録されていません。");
    return;
  }
  panelContext = context;
  if (panel) {
    panel.reveal();
    await postBoard(deps);
    return;
  }

  const created = vscode.window.createWebviewPanel(
    "novelai.schedule",
    "スケジュール",
    wideViewColumn(),
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel = created;
  context.subscriptions.push(created);
  created.onDidDispose(() => {
    panel = undefined;
  });
  created.webview.html = buildSchedulePanelHtml(createNonce(), created.webview.cspSource);
  created.webview.onDidReceiveMessage(async (raw: unknown) => {
    const message = parseScheduleMessage(raw);
    if (!message) return;
    try {
      await handleMessage(message, deps);
    } catch (error) {
      reportError(error);
    }
  });
}

/** 開いていれば描き直す（作品目標設定で応募先を変えたときなど） */
export async function refreshSchedulePanel(deps: SchedulePanelDeps): Promise<void> {
  if (panel) await postBoard(deps);
}

async function postBoard(
  deps: SchedulePanelDeps,
  select?: { workId: string; scheduleId: string; stepId: string | null }
): Promise<void> {
  if (!panel || !panelContext) return;
  const board = await loadScheduleBoard(deps.registry, deps.deviceId, {
    showFinished,
    holidays: await loadHolidays(panelContext),
  });
  void panel.webview.postMessage({ type: "board", board, select });
}

async function handleMessage(message: ScheduleMessage, deps: SchedulePanelDeps): Promise<void> {
  switch (message.type) {
    case "ready":
      await postBoard(deps);
      return;
    case "setShowFinished":
      showFinished = message.value;
      await postBoard(deps);
      return;
    case "addSchedule":
      await addScheduleFlow(deps, message.workId);
      return;
    case "openWork":
      await openWork(workOf(deps, message.workId));
      return;
    case "openFile": {
      const work = workOf(deps, message.workId);
      await openInDefaultEditor(await new ScheduleStore(work).filePath());
      return;
    }
    case "removeStep": {
      const work = workOf(deps, message.workId);
      if (
        !(await confirmRun("この段を消しますか？ 状態とメモも一緒に消えます。", "消す", {
          kind: "warning",
          work,
        }))
      ) {
        return;
      }
      await edit(work, message.scheduleId, (file, now) =>
        removeStep(file, message.scheduleId, message.stepId, now)
      );
      await postBoard(deps, { workId: work.id, scheduleId: message.scheduleId, stepId: null });
      return;
    }
    case "removeSchedule": {
      const work = workOf(deps, message.workId);
      if (
        !(await confirmRun(
          "このスケジュールを消しますか？ 段の済み・メモも消えます" +
            "（設定/スケジュール.json から外します。同期していれば「過去の版に戻す」で戻せます）。",
          "消す",
          { kind: "warning", work }
        ))
      ) {
        return;
      }
      await edit(work, message.scheduleId, (file) => removeSchedule(file, message.scheduleId));
      await postBoard(deps);
      return;
    }
    case "updateStep": {
      const work = workOf(deps, message.workId);
      await edit(work, message.scheduleId, (file, now) =>
        updateStep(file, message.scheduleId, message.stepId, message.patch, scheduleToday(), now)
      );
      await postBoard(deps, { workId: work.id, scheduleId: message.scheduleId, stepId: message.stepId });
      return;
    }
    case "addStep": {
      const work = workOf(deps, message.workId);
      let added = "";
      await edit(work, message.scheduleId, (file, now) =>
        addStep(
          file,
          message.scheduleId,
          { label: message.label, days: message.days, afterStepId: message.afterStepId },
          (prefix) => {
            added = defaultIdMaker(prefix);
            return added;
          },
          now
        )
      );
      await postBoard(deps, { workId: work.id, scheduleId: message.scheduleId, stepId: added || null });
      return;
    }
    case "moveStep": {
      const work = workOf(deps, message.workId);
      await edit(work, message.scheduleId, (file, now) =>
        moveStep(file, message.scheduleId, message.stepId, message.direction, now)
      );
      await postBoard(deps, { workId: work.id, scheduleId: message.scheduleId, stepId: message.stepId });
      return;
    }
    case "updateSchedule": {
      const work = workOf(deps, message.workId);
      await edit(work, message.scheduleId, (file, now) =>
        updateSchedule(file, message.scheduleId, message.patch, now)
      );
      await postBoard(deps, { workId: work.id, scheduleId: message.scheduleId, stepId: null });
      return;
    }
    case "exportIcs":
      if (panelContext) await exportScheduleIcs(panelContext, deps.registry);
      return;
    case "importHolidays":
      if (panelContext && (await importHolidays(panelContext))) await postBoard(deps);
      return;
    case "openWorkloadSettings":
      await vscode.commands.executeCommand("workbench.action.openSettings", "novelai.schedule");
      return;
  }
}

/** 設定の作業量の割合・重なりの損が変わったら描き直す（extension.ts が呼ぶ） */
export function watchWorkloadSettings(context: vscode.ExtensionContext, deps: SchedulePanelDeps): void {
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (panel && event.affectsConfiguration("novelai.schedule")) void postBoard(deps).catch(reportError);
    })
  );
}

/**
 * 読み直して、1つ当てて、保存する（冒頭の説明）。画面の上だけの公募
 * （作品目標設定の応募先から出したもの）は、当てる前にファイルへ下ろす。
 */
async function edit(
  work: WorkEntry,
  scheduleId: string,
  change: (file: ScheduleFile, now: string) => ScheduleFile
): Promise<void> {
  const store = new ScheduleStore(work);
  const now = new Date().toISOString();
  const current = materializeGoalsSchedule(await store.load(), scheduleId, now);
  await store.save(change(current, now));
  useLogFile(work.folderPath);
}

function workOf(deps: SchedulePanelDeps, workId: string): WorkEntry {
  const work = deps.registry.get(workId);
  if (!work) throw new Error("その作品が見つかりません。画面を開き直してください。");
  return work;
}

/** 見出しを押したら、いちばん新しい話を開く */
async function openWork(work: WorkEntry): Promise<void> {
  const latest = findLatestEpisode((await scanWork(work)).episodes);
  if (!latest) {
    void vscode.window.showInformationMessage(`「${work.title}」にはまだ話がありません。`);
    return;
  }
  const choice = columnForLocation(latest.filePath);
  await openInDefaultEditor(latest.filePath, { viewColumn: choice.column, preview: false });
}

const KIND_DETAILS: Record<ScheduleKind, string> = {
  contest: "締切から、執筆（初稿まで）・推敲・最終見直しを逆算します",
  selfPublish: "発売日から、執筆・推敲・表紙・最終校正・入稿・配信の申請を逆算します",
  publisher: "発売日から、打ち合わせ・改稿・初校・再校・見本を逆算します。編集部の日付は段に入れられます",
  webSerial: "連載開始日から書き溜めを逆算し、更新の決まりから各話の投稿予定日を並べます",
};

const DEFAULT_NAMES: Record<ScheduleKind, string> = {
  contest: "",
  selfPublish: "電子書籍",
  publisher: "",
  webSerial: "WEB連載",
};

/**
 * スケジュールを足す：作品 → 種類 → 名前 → マイルストーンの日付（空でもよい）。
 * 公募で作品目標設定の応募先があれば「応募先に従う」を先頭に出す（二重に持たない）。
 */
async function addScheduleFlow(deps: SchedulePanelDeps, workId: string | null): Promise<void> {
  const works = deps.registry.list();
  let work = workId ? deps.registry.get(workId) : undefined;
  if (!work) {
    const picked = await vscode.window.showQuickPick(
      [
        ...works.map((entry) => ({ label: entry.title, description: paths.basename(entry.folderPath), work: entry })),
        { ...cancelItem(), work: undefined },
      ],
      { title: "スケジュールを足す作品", ignoreFocusOut: true }
    );
    if (!picked || isCancelItem(picked) || !picked.work) return;
    work = picked.work;
  }

  const store = new ScheduleStore(work);
  const current = await store.load();
  const goals = await readWorkGoalsOrEmpty(work);
  const canFollow = goals.contest !== null && !current.schedules.some((schedule) => schedule.followsGoals);

  type KindPick = vscode.QuickPickItem & { scheduleKind?: ScheduleKind; follows?: boolean };
  const kindItems: KindPick[] = [
    ...(canFollow
      ? [
          {
            label: `$(target) 公募：${goals.contest!.name}`,
            description: `作品目標設定の応募先（締切 ${goals.contest!.deadline}）`,
            detail: "名前・締切・字数は作品目標設定に従います。応募先を変えれば締切も追います",
            scheduleKind: "contest" as const,
            follows: true,
          },
        ]
      : []),
    ...(["contest", "selfPublish", "publisher", "webSerial"] as const).map((kind) => ({
      label: kind === "contest" && canFollow ? "公募（ほかの応募先）" : SCHEDULE_KIND_LABELS[kind],
      detail: KIND_DETAILS[kind],
      scheduleKind: kind,
    })),
  ];
  const kindPick = await vscode.window.showQuickPick<KindPick>([...kindItems, cancelItem()], {
    title: `「${work.title}」に足すスケジュールの種類`,
    ignoreFocusOut: true,
  });
  if (!kindPick || isCancelItem(kindPick) || !kindPick.scheduleKind) return;
  const kind = kindPick.scheduleKind;

  let name = "";
  let milestone: string | null = null;
  let targetChars: number | null = null;
  if (!kindPick.follows) {
    const typed = await askText({
      title: `${SCHEDULE_KIND_LABELS[kind]}の名前`,
      prompt: "例：○○賞・Kindle版・第1巻・カクヨム連載",
      value: DEFAULT_NAMES[kind],
      validateInput: (value) => (value.trim() ? null : "名前を入れてください"),
    });
    if (typed === undefined) return;
    name = typed.trim();
    const label = MILESTONE_LABELS[kind];
    const date = await askText({
      title: `${label}（YYYY-MM-DD）`,
      prompt: `${label}から段取りを逆算します。未定なら空のまま Enter（今日から詰めて最短の日を出します）`,
      placeHolder: "2027-03-01",
      validateInput: (value) =>
        !value.trim() || isDateKey(value.trim()) ? null : "YYYY-MM-DD の形で入れてください（例：2027-03-01）",
    });
    if (date === undefined) return;
    milestone = date.trim() || null;
    if (kind === "contest" || kind === "selfPublish") {
      const chars = await askText({
        title: "予定の字数（任意）",
        prompt: "書き上げたときの作品全体の字数。入れると、執筆の日数を直近30日の平均の速さから出します",
        placeHolder: "100000",
        validateInput: (value) =>
          !value.trim() || /^\d+$/.test(value.trim()) ? null : "半角の数字で入れてください",
      });
      if (chars === undefined) return;
      targetChars = chars.trim() ? Number(chars.trim()) : null;
    }
  }

  const now = new Date().toISOString();
  const schedule = createSchedule(
    { kind, name, milestone, followsGoals: kindPick.follows === true, targetChars, now },
    defaultIdMaker
  );
  await store.save(addSchedule(current, schedule));
  useLogFile(work.folderPath);
  await postBoard(deps, { workId: work.id, scheduleId: schedule.id, stepId: null });
}

function reportError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof ScheduleStoreError)) {
    logFailure("スケジュール：画面の操作に失敗した", { error: message });
  }
  void vscode.window.showErrorMessage(message);
}

function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index++) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}
