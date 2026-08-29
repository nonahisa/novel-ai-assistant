import * as path from "./paths";
import {
  defaultCanonical,
  nextLineId,
  nextTimepointId,
  normalizeEpisodePath,
  parseTimeline,
  type Timeline,
  type TimelineLine,
  type TimelineLineKind,
  type Timepoint,
} from "../models/timeline";

/**
 * 作中の時間（`設定/timeline.json`）の書き換え（設計書6.39.3）。
 *
 * **VS Code に依らない純粋関数だけを置く。** 選択画面や入力欄の流れは
 * `features/chronicleEdit.ts` にあり、こちらは「どう変わるか」だけを持つ。
 * 分けてあるのは、採番・入れ替え・対応の置き換えという間違えやすい部分を
 * 単体テストで固めるためである。
 *
 * **検証は写さない。** 参照切れ・重複・分岐の輪の検査は
 * `models/timeline.ts` の `parseTimeline` が持っている。同じ規則を
 * ここへ書き直すと、片方だけ厳しくなったときに気づけない。
 */

/**
 * 保存してよい形かを確かめ、正規化した写しを返す。
 *
 * `parseTimeline` を通すのは、**そこが唯一の検証**だからである
 * （`TimelineStore.load` も同じ関数を通る）。保存の直前に通しておくと、
 * 壊れた状態のまま書き込んで**次に開けなくなる**のを防げる。
 */
export function validateTimeline(timeline: Timeline): Timeline {
  return parseTimeline(timeline);
}

/**
 * 話（ファイル）を時期に結ぶときの鍵。
 *
 * **作品フォルダーからの相対パスで、区切りは `/`**（設計書6.18）。
 * GitHubを介して別の端末と行き来するため、`\` のまま保存すると
 * 環境をまたいで一致しなくなる。組み立ては `core/paths.ts` を通す
 * （ブラウザ上の作品は `vscode-vfs://...` にあり、`path` は使えない）。
 */
export function toTimelineEpisodePath(
  workRoot: string | undefined,
  filePath: string
): string {
  if (!workRoot) return normalizeEpisodePath(filePath);
  return normalizeEpisodePath(path.relative(workRoot, filePath));
}

/**
 * 本編の系統を用意する。
 *
 * **系統を1本も作っていない作品がふつうである**（設計書6.18「何も設定
 * しなければ、すべてが本編1本」）。そこへ最初の時期を足すとき、
 * 置き場になる系統だけは要るので、ここで黙って1本だけ作る。
 * 作者に「まず系統を作ってください」と言わせないための処理である。
 */
export function ensureLine(timeline: Timeline): {
  timeline: Timeline;
  line: TimelineLine;
} {
  const existing = timeline.lines.find((line) => line.kind === "main");
  if (existing) return { timeline, line: existing };
  // 本編以外の系統だけがある作品では、そちらを既定にする
  // （勝手に本編を足すと「本編が2本」の検証に触れる余地を作る）
  if (timeline.lines.length > 0) {
    return { timeline, line: timeline.lines[0] };
  }

  const line: TimelineLine = {
    id: nextLineId(timeline.lines),
    label: "本編",
    kind: "main",
    canonical: true,
    branchFrom: null,
    note: "",
  };
  return {
    timeline: { ...timeline, lines: [...timeline.lines, line] },
    line,
  };
}

export interface NewTimepoint {
  label: string;
  /** 作中の日時（「四月」「王暦312年春」）。**任意** */
  absolute?: string | null;
  /** 置き場の系統。省略すると本編（無ければ作る） */
  lineId?: string;
  note?: string;
}

/**
 * 時期を1つ足す。**末尾に足す**（並びは配列の順そのもの）。
 *
 * 途中へ挿し込む口を作らないのは、番号を振らない設計（6.18）と揃えるため。
 * 順序を直したいときは `moveTimepoint` で入れ替える。
 */
export function addTimepoint(
  timeline: Timeline,
  draft: NewTimepoint
): { timeline: Timeline; timepoint: Timepoint } {
  // 系統を指していないときだけ、置き場（本編）を用意する。
  // 指しているときは既存の系統をそのまま使う（勝手に本編を足さない）
  let current = timeline;
  let lineId = draft.lineId;
  if (!lineId) {
    const prepared = ensureLine(timeline);
    current = prepared.timeline;
    lineId = prepared.line.id;
  }

  const timepoint: Timepoint = {
    id: nextTimepointId(current.timepoints),
    lineId,
    label: draft.label,
    absolute: draft.absolute?.trim() ? draft.absolute.trim() : null,
    note: draft.note ?? "",
  };
  return {
    timeline: {
      ...current,
      timepoints: [...current.timepoints, timepoint],
    },
    timepoint,
  };
}

export interface NewLine {
  label: string;
  kind: TimelineLineKind;
  /** 分岐元の時期。`main` は常に null */
  branchFrom?: string | null;
  /** 本編の事実として扱うか。省略すると種別の既定（6.18の表） */
  canonical?: boolean;
  note?: string;
}

export function addLine(
  timeline: Timeline,
  draft: NewLine
): { timeline: Timeline; line: TimelineLine } {
  const line: TimelineLine = {
    id: nextLineId(timeline.lines),
    label: draft.label,
    kind: draft.kind,
    canonical: draft.canonical ?? defaultCanonical(draft.kind),
    // 本編はどこからも分岐しない（`parseTimeline` がここを見る）
    branchFrom: draft.kind === "main" ? null : (draft.branchFrom ?? null),
    note: draft.note ?? "",
  };
  return {
    timeline: { ...timeline, lines: [...timeline.lines, line] },
    line,
  };
}

/**
 * 話を時期へ結ぶ。**既に結ばれていれば置き換える。**
 *
 * 同じ話が2回出てくると「どちらの時期が正しいか決められない」として
 * `parseTimeline` が読み込みを止める（6.18）。足すのではなく差し替える。
 * 差し替えても**並びは動かさない**——作者が並べ直した順を、
 * 時期の付け替えのたびに崩さないため。
 */
export function assignEpisode(
  timeline: Timeline,
  episodePath: string,
  timepointId: string,
  note = ""
): Timeline {
  const key = normalizeEpisodePath(episodePath);
  const index = timeline.episodes.findIndex(
    (entry) => normalizeEpisodePath(entry.filePath) === key
  );
  const entry = { filePath: key, timepointId, note };

  if (index < 0) {
    return { ...timeline, episodes: [...timeline.episodes, entry] };
  }
  const episodes = [...timeline.episodes];
  // メモは作者が書いたもの。時期を付け替えただけで消さない
  episodes[index] = { ...entry, note: note || episodes[index].note };
  return { ...timeline, episodes };
}

/**
 * 話の対応を外す。
 *
 * **対応の無い話は本編とみなされる**（6.18）ので、これが「本編に戻す」
 * 操作にもなる。時期を決めていない状態へ戻すだけで、話は消えない。
 */
export function unassignEpisode(
  timeline: Timeline,
  episodePath: string
): Timeline {
  const key = normalizeEpisodePath(episodePath);
  return {
    ...timeline,
    episodes: timeline.episodes.filter(
      (entry) => normalizeEpisodePath(entry.filePath) !== key
    ),
  };
}

/**
 * 時期を1つ前／後ろへ動かす。
 *
 * **番号を振らずに配列の順で持っている**ので（6.18）、並べ替えは
 * 隣との入れ替えになる。端に居るものを動かそうとしたときは、
 * 黙って何もしない（作者から見れば「もう先頭にある」だけである）。
 *
 * 入れ替えるのは**同じ系統の中の隣**である。配列にはすべての系統の時期が
 * 混ざって並ぶので、素朴に隣と入れ替えると別の系統の時期を追い越して
 * しまい、作者から見て何も起きていないように見える。
 */
export function moveTimepoint(
  timeline: Timeline,
  timepointId: string,
  direction: "up" | "down"
): Timeline {
  const target = timeline.timepoints.find((point) => point.id === timepointId);
  if (!target) return timeline;

  // 同じ系統の時期が、配列のどこに並んでいるか
  const indices: number[] = [];
  timeline.timepoints.forEach((point, index) => {
    if (point.lineId === target.lineId) indices.push(index);
  });

  const at = indices.findIndex(
    (index) => timeline.timepoints[index].id === timepointId
  );
  const to = direction === "up" ? at - 1 : at + 1;
  if (at < 0 || to < 0 || to >= indices.length) return timeline;

  const timepoints = [...timeline.timepoints];
  const a = indices[at];
  const b = indices[to];
  [timepoints[a], timepoints[b]] = [timepoints[b], timepoints[a]];
  return { ...timeline, timepoints };
}
