import { parseActorKind, type ActorKind } from "../models/actor";
// `paths.ts` は vscode を読むので、MCP（VS Code の外）でも読める半分だけを使う
import * as paths from "./pathText";

/**
 * 編集履歴（設計書5.6）の**読み方と置き場所の名前**。VS Code API に依存しない。
 *
 * 書く側（`editHistory.ts`）は `vscode` の fs を使うが、MCP の読む口
 * （`novel.read kind: editHistory`。設計書6.87.24）も同じ読み方で読む必要がある。
 * 写すと、片方だけ直した日に外部AIの読む履歴が作者の画面と食い違うので、
 * 読み方だけをここへ切り出した。
 */

/** 同期される場所（`cache/` と `logs/` だけが除外されている） */
export const HISTORY_DIRECTORY = "history";
export const HISTORY_FILE = "edits.jsonl";

export interface EditHistoryEntry {
  /** ISO 8601。**並べ替えは読むときに行う**ので、書く側は素直に今の時刻 */
  time: string;
  actor: ActorKind;
  /** 誰か（gitの user.name）。同じ編集者が複数いることもある */
  actorName: string;
  /** 何をしたか。作者が読む言葉で入れる（「誤字を直した」など） */
  action: string;
  /**
   * どのファイルか。作品フォルダーからの相対パス（区切りは `/`）。無ければ空。
   * **0.130.3 までの記録には、ファイル名だけのものが混じる**（読む側は
   * `episodeTimeline.ts` の `recordPointsToEpisode` で両方を読み分ける）
   */
  file: string;
  /** 補足。直した中身など。無ければ空 */
  detail: string;
  /**
   * 編集者の GitHub のユーザー名（設計書5.7.5.9。0.138.0 から）。
   *
   * **画面に出す編集者の名前はこれだけ**（作者の答え 2026-11-07「GitHub のユーザー名だけ」）。
   * `actorName` は git の名前（例「Kota Mizushima」）で、画面には出さない。
   * 作者が編集者の提案を採った・見送った行と、編集用の写しから取り込んだ編集者の行に、
   * その時点の名前を書き写す。解除で `.aiwriter/editing.json` から名前が消えても、行には残る。
   * それより前の行には無い（名前なしで出す）。
   */
  editorLogin?: string;
}

/**
 * 編集履歴の `file` に入れる形（作品フォルダーからの相対・`/` 区切り）。
 *
 * **ファイル名だけ（`basename`）を書かない。** 章ごとのフォルダーに同じ名前の話
 * （`第1章/episode_0001.md`）があると、タイムラインの欄がほかの章の話の記録まで
 * 拾ってしまう（0.130.4 で直した）。
 *
 * - 区切りを `/` に揃える：履歴は同期され、Windows と Mac・ブラウザ版の両方で読まれる
 * - **大小は変えない**：ブラウザ版の場所の比べ方（`isSamePath`）は大小を区別する
 * - 比べる前に URI の符号を解く：ブラウザ版では作品の場所が生の日本語、開いた
 *   文書の場所が符号化された形で来ることがあり、そのまま相対を取ると外へ出て見える
 * - 作品の外のファイルは、場所をそのまま残す（相対で表すと `../` が付いて読めない）
 */
export function editHistoryFile(workFolder: string, filePath: string): string {
  if (!filePath) return "";
  if (!workFolder || !paths.isPathInside(workFolder, filePath)) return filePath;
  return paths
    .relative(paths.decodeUriEscapes(workFolder), paths.decodeUriEscapes(filePath))
    .replace(/\\/g, "/");
}

/**
 * 1行1件のJSONを読む。
 *
 * **読めない行は捨てて、読める行は残す。** 競合で行が壊れることがあり、
 * そこで全部を諦めると、無事な履歴まで見えなくなる。
 *
 * **競合マーカーの行も落とす。** 解決前でも中身は読めたほうがよい。
 */
export function parseHistory(text: string): EditHistoryEntry[] {
  const entries: EditHistoryEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(<<<<<<<|=======|>>>>>>>)/.test(line)) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      const entry = toEntry(parsed);
      if (entry) entries.push(entry);
    } catch {
      // 壊れた行は捨てる
    }
  }
  return entries;
}

/**
 * 同じ操作が二重に入っていないか。
 *
 * **競合を「両方残す」で解決すると、同じ行が2つになることがある。**
 * 時刻・誰・何が全部同じなら、同じ操作とみなして1つにする。
 */
export function dedupeHistory(
  entries: EditHistoryEntry[]
): EditHistoryEntry[] {
  const seen = new Set<string>();
  const kept: EditHistoryEntry[] = [];
  for (const entry of entries) {
    const key = historyKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(entry);
  }
  return kept;
}

/** 新しいものが先。**時刻が読めない行は末尾へ**（捨てはしない） */
export function sortNewestFirst(
  entries: EditHistoryEntry[]
): EditHistoryEntry[] {
  return dedupeHistory(entries).sort((a, b) => {
    const left = Date.parse(a.time);
    const right = Date.parse(b.time);
    if (Number.isNaN(left) && Number.isNaN(right)) return 0;
    if (Number.isNaN(left)) return 1;
    if (Number.isNaN(right)) return -1;
    return right - left;
  });
}

function toEntry(value: unknown): EditHistoryEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const actor = parseActorKind(record.actor);
  const action = asString(record.action);
  // **誰と何が分からない行は、履歴として意味が無い**
  if (!actor || !action) return undefined;
  return {
    time: asString(record.time),
    actor,
    actorName: asString(record.actorName),
    action,
    file: asString(record.file),
    detail: asString(record.detail),
    ...(typeof record.editorLogin === "string" && record.editorLogin !== ""
      ? { editorLogin: record.editorLogin }
      : {}),
  };
}

/**
 * 画面に出す「誰が」の名前（編集履歴の画面とタイムラインの欄で同じものを使う）。
 *
 * **編集者の行は、git の名前（`actorName`）を出さない**（作者の答え 2026-11-07）。
 * 編集者の行なら GitHub のユーザー名（`editorLogin`）、無ければ空（印の「編集者」だけが出る）。
 * 作者と AI の行は、これまでどおり `actorName`。
 */
export function historyDisplayName(entry: EditHistoryEntry): string {
  if (entry.actor === "editor") return entry.editorLogin ?? "";
  return entry.actorName;
}

/** 同じ行かを見分ける鍵（`dedupeHistory` と同じ項目。`editorLogin` は混ぜない） */
function historyKey(entry: EditHistoryEntry): string {
  return [
    entry.time,
    entry.actor,
    entry.actorName,
    entry.action,
    entry.file,
    entry.detail,
  ].join("\u0000");
}

/**
 * 編集用の写しの編集履歴から、作者の作品へ足す編集者の行を選ぶ（設計書5.7.5.9）。
 *
 * - **編集者の行（`actor: "editor"`）だけ**を取る。写しにある作者や AI の行は、作者の作品の
 *   側が正なので持ち込まない
 * - **同じ行は二度入れない。** 鍵は `dedupeHistory` と同じ（時刻・誰・何・どこ・中身）で、
 *   こちらが書き足した `editorLogin` は鍵に混ぜない。混ぜると、名前を足した行と写しの元の行が
 *   別物に見え、取り込むたびに同じ行が積み上がる
 * - 足す行には、取り込んだ時点の編集者の GitHub のユーザー名を書き写す（分からなければ書かない）
 *
 * 返すのは足す行（JSON の1行ずつ）。書き込みは呼ぶ側（`EditHistory.mergeIncomingEditorLines`）。
 */
export function pickIncomingEditorLines(
  existing: string,
  incoming: string,
  editorLogin: string | undefined
): string[] {
  const seen = new Set(parseHistory(existing).map(historyKey));
  const added: string[] = [];
  for (const entry of parseHistory(incoming)) {
    if (entry.actor !== "editor") continue;
    const key = historyKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    // 写しの行がもとから名前を持っていれば、それを使う（作り変えない）
    const login = entry.editorLogin ?? editorLogin;
    added.push(JSON.stringify({ ...entry, ...(login ? { editorLogin: login } : {}) }));
  }
  return added;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
