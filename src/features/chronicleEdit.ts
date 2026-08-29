import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import {
  findLine,
  LINE_KIND_LABELS,
  timepointsOfLine,
  type Timeline,
  type TimelineLineKind,
  type Timepoint,
} from "../models/timeline";
import { TimelineStore } from "../core/timelineStore";
import { scanWork } from "../core/scanner";
import { formatChapterLabel } from "../core/episodeLabel";
import { readWorkFormat } from "../core/workFormatStore";
import { logFailure, logStep } from "../core/logger";
import {
  addLine,
  addTimepoint,
  assignEpisode,
  moveTimepoint,
  toTimelineEpisodePath,
  unassignEpisode,
  validateTimeline,
} from "../core/timelineEdit";
import { askText, cancelItem, isCancelItem } from "../views/dialogs";

/**
 * 時期と系統を作る流れ（設計書6.39.3）。
 *
 * **年表の表からは書き換えない。** 書き換えは選択画面と入力欄で行い、
 * 画面から直接JSONを触らせない（設定資料パネルと同じ流儀）。
 * `timeline.json` へ書く口は `TimelineStore` だけである（6.39.5）。
 *
 * 判断の要る部分（採番・入れ替え・対応の置き換え・検証）は
 * `core/timelineEdit.ts` にある。ここが持つのは「何を訊くか」だけで、
 * その順序を変えても保存の正しさは変わらない。
 */

/** 1回の操作で読み書きするひとまとまり。読んでから書くのを崩さないため */
interface EditContext {
  work: WorkEntry;
  store: TimelineStore;
  timeline: Timeline;
}

export async function editTimeline(work: WorkEntry): Promise<void> {
  const store = new TimelineStore(work);

  let timeline: Timeline;
  try {
    timeline = await store.load();
  } catch (error) {
    // **`loadOrEmpty` を使わない。** 空として扱って保存すると、
    // 作者が組み立てた年表がまるごと消える（`timelineStore.ts` の注意）
    const detail = messageOf(error);
    logFailure("時期・系統の編集", { 作品: work.title, 内容: detail });
    void vscode.window.showErrorMessage(
      `${detail} ファイルを直してから、もう一度お試しください。`
    );
    return;
  }

  const context: EditContext = { work, store, timeline };
  const action = await pickAction(timeline);
  if (!action) return;

  switch (action) {
    case "addTimepoint":
      await runAddTimepoint(context);
      return;
    case "assignEpisode":
      await runAssignEpisode(context);
      return;
    case "addLine":
      await runAddLine(context);
      return;
    case "moveEpisodeToLine":
      await runMoveEpisodeToLine(context);
      return;
    case "moveTimepoint":
      await runMoveTimepoint(context);
      return;
  }
}

type EditAction =
  | "addTimepoint"
  | "assignEpisode"
  | "addLine"
  | "moveEpisodeToLine"
  | "moveTimepoint";

async function pickAction(
  timeline: Timeline
): Promise<EditAction | undefined> {
  const items: Array<vscode.QuickPickItem & { action: EditAction }> = [
    {
      label: "$(add) 時期を作る",
      description: "「十年前・火事の夜」など",
      detail: "作中の時期を1つ足します。日付が決まっていなくても構いません。",
      action: "addTimepoint",
    },
    {
      label: "$(calendar) この話の時期を決める",
      detail:
        "話を1つ選び、作中のいつのことかを決めます。時期はその場でも作れます。",
      action: "assignEpisode",
    },
  ];

  if (timeline.timepoints.length > 1) {
    items.push({
      label: "$(arrow-both) 時期の並びを入れ替える",
      detail: "時期を1つ選び、1つ前・1つ後ろへ動かします。番号は振りません。",
      action: "moveTimepoint",
    });
  }

  items.push({
    label: "$(git-branch) 系統を作る",
    description: "IF編・夢・劇中劇・並行する時間",
    detail:
      "本編とは別の筋を足します。本編ではない筋の出来事は、" +
      "本編の年表や資料に混ぜません。",
    action: "addLine",
  });

  if (timeline.lines.length > 1) {
    items.push({
      label: "$(arrow-right) この話を系統へ",
      detail: "話を1つ選び、どの筋のものかを決めます。本編へも戻せます。",
      action: "moveEpisodeToLine",
    });
  }

  const picked = await vscode.window.showQuickPick([...items, cancelItem()], {
    title: "時期・系統の編集",
    placeHolder: "何をしますか？",
    ignoreFocusOut: true,
  });
  if (!picked || isCancelItem(picked)) return undefined;
  return "action" in picked ? picked.action : undefined;
}

// ---------------------------------------------------------------------------
// 時期を作る
// ---------------------------------------------------------------------------

async function runAddTimepoint(context: EditContext): Promise<void> {
  const created = await createTimepoint(context.timeline);
  if (!created) return;

  await save(
    context,
    created.timeline,
    `時期「${created.timepoint.label}」を作りました。`
  );
}

/**
 * 時期を1つ作る。**保存はしない**（呼び出し側がまとめて保存する）。
 *
 * 「この話の時期を決める」の途中からも呼ぶ。時期が1つも無い状態で
 * 「時期を選んでください」とだけ言われても、作者は先へ進めない。
 *
 * @param lineId 置き場の系統が既に決まっているとき。**決まっているなら
 *   訊き直さない**——「この話を系統へ」の途中で別の系統を選べてしまうと、
 *   選んだはずの筋と違うところへ話が入る
 */
async function createTimepoint(
  timeline: Timeline,
  lineId?: string
): Promise<{ timeline: Timeline; timepoint: Timepoint } | undefined> {
  // 系統を訊くのは、決まっておらず、かつ2本以上あるときだけ
  const asksLine = !lineId && timeline.lines.length >= 2;
  const steps = asksLine ? 3 : 2;

  const label = await askText({
    title: `時期を作る（1/${steps}）`,
    placeHolder: "例: 十年前・火事の夜 / 王都陥落からの三日間",
    prompt: "作中の時期に名前を付けてください。年表の見出しになります。",
    validateInput: (value) =>
      value.trim().length === 0 ? "名前を入れてください。" : undefined,
  });
  if (label === undefined) return undefined;

  const absolute = await askText({
    title: `時期を作る（2/${steps}）　作中の日時（省略できます）`,
    placeHolder: "例: 四月 / 王暦312年春",
    prompt:
      "暦のある作品だけで構いません。年表に必要なのは順序だけなので、" +
      "分からなければ空のままにしてください。",
  });
  if (absolute === undefined) return undefined;

  let target = lineId;
  if (!target) {
    const chosen = await pickLineId(
      timeline,
      `時期を作る（3/${steps}）　どの系統の時期ですか？`
    );
    if (chosen === undefined) return undefined;
    // 空文字は「本編に任せる」。無ければ `addTimepoint` が本編ごと作る
    target = chosen || undefined;
  }

  return addTimepoint(timeline, {
    label: label.trim(),
    absolute,
    lineId: target,
  });
}

/**
 * 系統を選ばせる。**2本以上あるときだけ訊く。**
 *
 * @returns 空文字は「本編（無ければ作る）に任せる」。`undefined` は取りやめ
 */
async function pickLineId(
  timeline: Timeline,
  title: string
): Promise<string | undefined> {
  if (timeline.lines.length < 2) return "";

  const picked = await vscode.window.showQuickPick(
    [
      ...timeline.lines.map((line) => ({
        label: line.label,
        description: LINE_KIND_LABELS[line.kind],
        detail: line.canonical ? "本編の事実" : "本編ではない筋",
        lineId: line.id,
      })),
      cancelItem(),
    ],
    { title, placeHolder: "系統を選んでください", ignoreFocusOut: true }
  );
  if (!picked || isCancelItem(picked)) return undefined;
  return "lineId" in picked ? picked.lineId : undefined;
}

// ---------------------------------------------------------------------------
// この話の時期を決める
// ---------------------------------------------------------------------------

async function runAssignEpisode(context: EditContext): Promise<void> {
  const episode = await pickEpisode(
    context.work,
    context.timeline,
    "この話の時期を決める（1/2）"
  );
  if (!episode) return;

  const chosen = await pickTimepoint(
    context.timeline,
    "この話の時期を決める（2/2）",
    undefined
  );
  if (!chosen) return;

  let timeline = chosen.timeline;
  const timepointId = chosen.timepointId;

  // 既に決めてあるなら、置き換えてよいかを訊く。黙って差し替えると、
  // 作者が前に決めた時期がどこへ行ったか分からなくなる
  const current = timeline.episodes.find(
    (entry) => entry.filePath === episode.workPath
  );
  if (current && current.timepointId !== timepointId) {
    const before =
      timeline.timepoints.find((point) => point.id === current.timepointId)
        ?.label ?? current.timepointId;
    const after =
      timeline.timepoints.find((point) => point.id === timepointId)?.label ??
      timepointId;
    const answer = await vscode.window.showWarningMessage(
      `${episode.label} は「${before}」に決めてあります。「${after}」へ置き換えますか？`,
      { modal: true },
      "置き換える"
    );
    if (answer !== "置き換える") return;
  }

  timeline = assignEpisode(timeline, episode.workPath, timepointId);
  await save(context, timeline, `${episode.label} の時期を決めました。`);
}

/**
 * 時期を選ばせる。末尾に「新しい時期を作る…」を置く。
 *
 * **その場で作れるようにする。** 一度取りやめて「時期を作る」からやり直せ、
 * では手が止まる。
 */
async function pickTimepoint(
  timeline: Timeline,
  title: string,
  lineId: string | undefined
): Promise<{ timeline: Timeline; timepointId: string } | undefined> {
  const candidates = lineId
    ? timepointsOfLine(timeline, lineId)
    : timeline.timepoints;

  const items: Array<vscode.QuickPickItem & { timepointId?: string }> =
    candidates.map((point) => ({
      label: point.label,
      description: point.absolute ?? "",
      detail: lineDetail(timeline, point.lineId),
      timepointId: point.id,
    }));
  items.push({ label: "$(add) 新しい時期を作る…" });

  const picked = await vscode.window.showQuickPick([...items, cancelItem()], {
    title,
    placeHolder:
      candidates.length > 0
        ? "時期を選んでください"
        : "まだ時期がありません。新しく作ってください",
    ignoreFocusOut: true,
  });
  if (!picked || isCancelItem(picked)) return undefined;

  if ("timepointId" in picked && picked.timepointId) {
    return { timeline, timepointId: picked.timepointId };
  }

  // 系統が決まっている流れ（「この話を系統へ」）では、その系統へ作る
  const created = await createTimepoint(timeline, lineId);
  if (!created) return undefined;
  return { timeline: created.timeline, timepointId: created.timepoint.id };
}

/** その時期がどの系統のものか。系統が1本の作品では何も出さない */
function lineDetail(timeline: Timeline, lineId: string): string {
  if (timeline.lines.length < 2) return "";
  const line = findLine(timeline, lineId);
  return line ? line.label : "";
}

// ---------------------------------------------------------------------------
// 系統を作る
// ---------------------------------------------------------------------------

async function runAddLine(context: EditContext): Promise<void> {
  const label = await askText({
    title: "系統を作る（1/3）",
    placeHolder: "例: IF・もし文佳が生きていたら / 太志の夢",
    prompt: "本編とは別の筋に名前を付けてください。",
    validateInput: (value) =>
      value.trim().length === 0 ? "名前を入れてください。" : undefined,
  });
  if (label === undefined) return;

  const kind = await pickLineKind();
  if (!kind) return;

  let branchFrom: string | null = null;
  if (kind !== "main" && kind !== "parallel") {
    // 分岐元は「どこから分かれたか」「その夢を見た位置」を示す。
    // 決めていなければ空のままでよい（6.18）
    const chosen = await pickBranchOrigin(context.timeline, kind);
    if (chosen === undefined) return;
    branchFrom = chosen;
  }

  const { timeline, line } = addLine(context.timeline, {
    label: label.trim(),
    kind,
    branchFrom,
  });
  await save(
    context,
    timeline,
    line.canonical
      ? `系統「${line.label}」を作りました。本編の事実として扱います。`
      : `系統「${line.label}」を作りました。本編の年表や資料には混ぜません。`
  );
}

async function pickLineKind(): Promise<TimelineLineKind | undefined> {
  // 本編は選ばせない。本編は1本と決まっており、無ければ時期を作るときに
  // 自動で用意される（`ensureLine`）
  const kinds: Array<{ kind: TimelineLineKind; detail: string }> = [
    {
      kind: "parallel",
      detail:
        "流れる速さが違う異世界など。その世界で実際に起きたこととして扱います。",
    },
    {
      kind: "branch",
      detail:
        "ある時点から別の筋へ分かれるもの。本編とは両立しないので、資料には混ぜません。",
    },
    {
      kind: "dream",
      detail: "見た内容は本編で実際には起きていません。資料には混ぜません。",
    },
    {
      kind: "inner",
      detail: "作中で語られる別の物語。資料には混ぜません。",
    },
  ];

  const picked = await vscode.window.showQuickPick(
    [
      // `kind` は `QuickPickItem` が区切り線のために使う名前なので、
      // 種別は別の名前で載せる
      ...kinds.map((entry) => ({
        label: LINE_KIND_LABELS[entry.kind],
        detail: entry.detail,
        lineKind: entry.kind,
      })),
      cancelItem(),
    ],
    {
      title: "系統を作る（2/3）　どんな筋ですか？",
      placeHolder: "種別を選んでください",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked)) return undefined;
  return "lineKind" in picked ? picked.lineKind : undefined;
}

/**
 * 分岐元の時期を選ばせる。
 *
 * @returns `null` は「決めない」。`undefined` は取りやめ
 */
async function pickBranchOrigin(
  timeline: Timeline,
  kind: TimelineLineKind
): Promise<string | null | undefined> {
  const meaning =
    kind === "branch"
      ? "ここまでの人物の状態を引き継ぐ分かれ目"
      : "その夢を見た（語られた）位置";

  if (timeline.timepoints.length === 0) {
    // 時期が1つも無ければ選びようがない。ここで止めずに先へ進める
    return null;
  }

  const picked = await vscode.window.showQuickPick(
    [
      ...timeline.timepoints.map((point) => ({
        label: point.label,
        description: point.absolute ?? "",
        detail: lineDetail(timeline, point.lineId),
        timepointId: point.id as string | null,
      })),
      {
        label: "$(circle-slash) 決めない",
        detail: "あとから決められます。",
        timepointId: null,
      },
      cancelItem(),
    ],
    {
      title: `系統を作る（3/3）　分岐元（${meaning}）`,
      placeHolder: "分岐元の時期を選んでください",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked)) return undefined;
  return "timepointId" in picked ? picked.timepointId : undefined;
}

// ---------------------------------------------------------------------------
// この話を系統へ
// ---------------------------------------------------------------------------

async function runMoveEpisodeToLine(context: EditContext): Promise<void> {
  const episode = await pickEpisode(
    context.work,
    context.timeline,
    "この話を系統へ（1/3）"
  );
  if (!episode) return;

  const picked = await vscode.window.showQuickPick(
    [
      ...context.timeline.lines.map((line) => ({
        label: line.label,
        description: LINE_KIND_LABELS[line.kind],
        detail: line.canonical ? "本編の事実" : "本編ではない筋",
        lineId: line.id as string | null,
      })),
      {
        // 対応を外した話は本編とみなされる（6.18）。時期を決めずに
        // 本編へ戻すのは、この道である
        label: "$(home) 本編（時期を決めない）",
        detail: "時期の対応を外します。対応の無い話は本編として扱います。",
        lineId: null,
      },
      cancelItem(),
    ],
    {
      title: "この話を系統へ（2/3）",
      placeHolder: `${episode.label} はどの筋の話ですか？`,
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked)) return;
  if (!("lineId" in picked)) return;

  if (picked.lineId === null) {
    await save(
      context,
      unassignEpisode(context.timeline, episode.workPath),
      `${episode.label} を本編（時期なし）へ戻しました。`
    );
    return;
  }

  // 話が結ぶのは時期であって系統ではない（6.18）。選んだ系統の中から
  // 置き場を決めてもらう
  const chosen = await pickTimepoint(
    context.timeline,
    "この話を系統へ（3/3）",
    picked.lineId
  );
  if (!chosen) return;

  await save(
    context,
    assignEpisode(chosen.timeline, episode.workPath, chosen.timepointId),
    `${episode.label} の系統を決めました。`
  );
}

// ---------------------------------------------------------------------------
// 時期の並びを入れ替える
// ---------------------------------------------------------------------------

async function runMoveTimepoint(context: EditContext): Promise<void> {
  const picked = await vscode.window.showQuickPick(
    [
      ...context.timeline.timepoints.map((point, index) => ({
        label: point.label,
        description: point.absolute ?? "",
        detail: `${index + 1}番目　${lineDetail(context.timeline, point.lineId)}`,
        timepointId: point.id,
      })),
      cancelItem(),
    ],
    {
      title: "時期の並びを入れ替える（1/2）",
      placeHolder: "動かす時期を選んでください",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked)) return;
  if (!("timepointId" in picked)) return;

  const direction = await vscode.window.showQuickPick(
    [
      { label: "$(arrow-up) 1つ前へ", direction: "up" as const },
      { label: "$(arrow-down) 1つ後ろへ", direction: "down" as const },
      cancelItem(),
    ],
    {
      title: "時期の並びを入れ替える（2/2）",
      placeHolder: `「${picked.label}」をどちらへ動かしますか？`,
      ignoreFocusOut: true,
    }
  );
  if (!direction || isCancelItem(direction)) return;
  if (!("direction" in direction)) return;

  const moved = moveTimepoint(
    context.timeline,
    picked.timepointId,
    direction.direction
  );
  if (moved === context.timeline) {
    // 端に居るものは動かない。押しても何も起きないのは不安なので、そう言う
    void vscode.window.showInformationMessage(
      `「${picked.label}」は、もうその端にあります。`
    );
    return;
  }
  await save(context, moved, `「${picked.label}」を動かしました。`);
}

// ---------------------------------------------------------------------------
// 共通の部品
// ---------------------------------------------------------------------------

interface EpisodeChoice {
  /** 作品フォルダーからの相対パス（`/` 区切り）。保存する鍵 */
  workPath: string;
  /** 画面に出す呼び名。「第3話 火事の夜」 */
  label: string;
}

/**
 * 話を選ばせる。**話数順**に並べる（作者が探す順）。
 *
 * いま決まっている時期を説明に添える。決めてある話をもう一度選んだときに、
 * 何を置き換えようとしているのかが分かる。
 */
async function pickEpisode(
  work: WorkEntry,
  timeline: Timeline,
  title: string
): Promise<EpisodeChoice | undefined> {
  const scanned = await scanWork(work);
  if (scanned.episodes.length === 0) {
    void vscode.window.showInformationMessage(
      "本文ファイルが見つかりません。作品に話を入れてからお試しください。"
    );
    return undefined;
  }

  const format = await readWorkFormat(work);
  const items = scanned.episodes.map((episode) => {
    const chapterLabel = formatChapterLabel(episode, format);
    const workPath = toTimelineEpisodePath(work.folderPath, episode.filePath);
    const assigned = timeline.episodes.find(
      (entry) => entry.filePath === workPath
    );
    const point = assigned
      ? timeline.timepoints.find((entry) => entry.id === assigned.timepointId)
      : undefined;
    const label = chapterLabel
      ? `${chapterLabel}　${episode.metaTitle ?? episode.subtitle ?? ""}`.trim()
      : episode.fileName;
    return {
      label,
      description: episode.fileName,
      detail: point ? `いまは「${point.label}」` : "時期は未設定",
      workPath,
    };
  });

  const picked = await vscode.window.showQuickPick([...items, cancelItem()], {
    title,
    placeHolder: "話を選んでください",
    ignoreFocusOut: true,
    matchOnDescription: true,
  });
  if (!picked || isCancelItem(picked)) return undefined;
  if (!("workPath" in picked)) return undefined;
  return { workPath: picked.workPath, label: picked.label.trim() };
}

/**
 * 保存する。**検証を通してから書く。**
 *
 * 参照の壊れた状態で書き込むと、次に開いたとき読み込みが止まる
 * （`TimelineStore.load` が例外を投げる）。作者から見れば「編集したら
 * 年表が開かなくなった」になるので、書く前に止める。
 */
async function save(
  context: EditContext,
  timeline: Timeline,
  message: string
): Promise<void> {
  let validated: Timeline;
  try {
    validated = validateTimeline(timeline);
  } catch (error) {
    const detail = messageOf(error);
    logFailure("時期・系統の編集", { 作品: context.work.title, 内容: detail });
    void vscode.window.showErrorMessage(
      `保存できる形になりませんでした：${detail} 変更は保存していません。`
    );
    return;
  }

  try {
    await context.store.save(validated);
  } catch (error) {
    const detail = messageOf(error);
    logFailure("時期・系統の編集", { 作品: context.work.title, 内容: detail });
    void vscode.window.showErrorMessage(detail);
    return;
  }

  logStep(`時期・系統：${context.work.title} の timeline.json を保存しました`);
  void vscode.window.showInformationMessage(message);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
