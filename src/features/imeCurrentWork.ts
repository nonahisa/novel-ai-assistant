// ログの書き先：作品が定まらない——知らせと一覧は窓ごと・機械ごとの話で、どの作品の
// ログでもないので保管庫のログへ倒す（窓の札と同じ扱い）
import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { findWorkForFile, parseWorkConfig, workPaths } from "../core/workRegistry";
import { atomicWriteFile } from "../core/atomicWrite";
import { detectJsonFileFormat, formatJsonForFile } from "../core/jsonFileFormat";
import { isWatchedSettingsFile, kindOfSettingsFile } from "../core/externalChanges";
import { isNotFound } from "../core/fileRead";
import { sha256Bytes } from "../core/hash";
import { logLine } from "../core/logger";
import {
  canRunProcesses,
  environmentVariable,
  hostPlatform,
  hostTag,
  randomUuid,
} from "../core/runtime";
import { isEditorMode } from "../core/actorContext";
import { imeExcludedKey, imeFrequentExcludedKey } from "../core/imeDictionary";
import {
  IME_CURRENT_WORK_FILE,
  IME_DICTIONARY_SETTLE_MS,
  IME_HEARTBEAT_MS,
  IME_TSV_SEGMENTS,
  IME_WORKS_FILE,
  buildCurrentWorkNotice,
  buildImeTsv,
  buildWorksList,
  decideImeFront,
  imeNoticeKey,
  imeOldStateDir,
  imeStateDir,
  noticeWindowOf,
  serializeImeJson,
  shouldWriteImeNotice,
  withoutExcluded,
  workUidStateOf,
  createdAtOf,
  planWorkUids,
  type WorkUidCandidate,
  type ImeFront,
  type ImeFrontEvent,
  type ImeObservedFront,
  type ImeWorkRef,
} from "../core/imeCurrentWork";
import {
  countFrequentWords,
  frequentSkipSurfaces,
  isEpisodeFilePath,
  type FrequentWord,
} from "../core/imeFrequent";
import { scanWork } from "../core/scanner";
import { loadEpisodeBodies } from "../core/episodeBodies";
import { readMemoMarkers } from "../core/memoMarkerStore";
import { loadDictionaryForWork } from "./exportImeDictionary";

/**
 * 本文でよく使う語を辞書の末尾へ出すか。
 *
 * 2026-11-17 に true にした（デスクトップは AFDCA1AC、ノートPCは C3953A97 に入れ替わり、どちらの
 * エンジンも frequent を読める）。それより前のエンジンは frequent の行を先頭に出してしまうので、
 * 出さない形へ戻すときは false にする（false の間は数えもしない＝本文を読まない）。
 */
export const IME_FREQUENT_WORDS_ENABLED = true;

/** 定数を boolean として読む（false の間も、その先のコードが「到達しない」扱いにならないように） */
export function frequentWordsEnabled(): boolean {
  return IME_FREQUENT_WORDS_ENABLED as boolean;
}

/**
 * 作品の話の本文から、よく使う語を数える。**読めない話があっても止めず、読めた分で作る。**
 * 話の一覧は走査（`scanWork`）の結果——ゴミ箱・回復先・書き出しの写しは入らない。
 * シーンメモは `loadEpisodeBodies` が消す。
 */
export async function loadFrequentWords(
  work: WorkEntry,
  excludedSurfaces: ReadonlySet<string>
): Promise<FrequentWord[]> {
  try {
    const scan = await scanWork(work);
    const memoMarkers = await readMemoMarkers(work);
    const bodies: string[] = [];
    for (const episode of scan.episodes) {
      try {
        const loaded = await loadEpisodeBodies([episode], memoMarkers);
        for (const one of loaded.bodies) bodies.push(one.body);
      } catch (error) {
        logLine(
          `よく使う語を数えるとき、読めない話を飛ばしました：${episode.fileName}（${error instanceof Error ? error.message : String(error)}）`
        );
      }
    }
    return countFrequentWords(bodies, excludedSurfaces);
  } catch (error) {
    // 数えられなくても、設定資料の辞書は書く
    logLine(
      `よく使う語を数えられませんでした：${work.title}（${error instanceof Error ? error.message : String(error)}）`
    );
    return [];
  }
}

/**
 * オリジナルIME（Setsuna）へ、いまの作品・作品の一覧・核向けの辞書を書く（設計書6.13.7）。
 *
 * 形と決まりの正は IME の計画書（`novel-ime/docs/作品ごとの辞書の切り替え_計画.md` 3.1〜3.5）。
 * 何を書くか・いまの作品をどう決めるかは `core/imeCurrentWork.ts`（純粋な部分）。
 * ここは VS Code から読んでファイルへ書くだけ。
 *
 * **失敗しても画面には出さない。** 作者が頼んだ操作ではなく、IME の無い機械では
 * 起きて当たり前のことでもある。理由はログへ残す（窓の札と同じ扱い）。
 *
 * **書く物は作者のデータではない**（知らせ・一覧・派生の辞書）。上書きの経路
 * （`atomicWriteFile` の指定なし）で書く。作者のデータに触れるのは `config.json` へ
 * 番号を足すときだけで、読んだ中身に番号の1欄だけを足し（ほかの欄と改行の形はそのまま）、
 * 既にある番号は変えず、壊れた JSON は直さず止める（実装ルール2）。
 */

/** 設定の名前（package.json の `novelai.ime.notifyCurrentWork`） */
export const IME_NOTIFY_SETTING = "ime.notifyCurrentWork";

/** `config.json` の番号を確かめた結果 */
export type EnsureWorkUidResult =
  | { kind: "ready"; workUid: string; added: boolean }
  | { kind: "stopped"; reason: string };

/**
 * 作品の番号（`workUid`）を確かめ、無ければ足す（計画書 3.6）。
 *
 * - **既にある番号は変えない**
 * - 壊れた JSON・形の悪い番号は**直さず止める**（ログへ理由。次のきっかけでまた試す）
 * - `allowAdd` が偽（編集者モード）なら足さない。編集部の機械が作者の設定ファイルを
 *   書き換えると、作者の書庫に覚えのない変更が出る
 * - 読んでから書くまでの間に設定ファイルが変わったら書かない（同期の取り込みなどと
 *   重なったときに、その変更を古い中身で消さない）
 *
 * 番号は**毎回ファイルから読む**（覚えておかない）。2台で別々に足して同期でぶつかった
 * とき、ファイルに残ったほうへすぐ揃うため（設計書6.13.7）。
 */
export async function ensureWorkUid(
  work: WorkEntry,
  options: { allowAdd: boolean; newUid?: () => string }
): Promise<EnsureWorkUidResult> {
  const configUri = path.toUri(workPaths(work).configFile);
  const readBytes = async (): Promise<Uint8Array | undefined> => {
    try {
      return await vscode.workspace.fs.readFile(configUri);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  };

  let bytes: Uint8Array | undefined;
  try {
    bytes = await readBytes();
  } catch (error) {
    return { kind: "stopped", reason: `作品設定を読めません（${errorText(error)}）` };
  }
  if (!bytes) {
    // 設定ファイルの無い作品へ新しく作ることはしない（作品の形は登録が決める）
    return { kind: "stopped", reason: "作品設定（.aiwriter/config.json）がありません" };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(stripBom(new TextDecoder().decode(bytes)));
  } catch {
    return {
      kind: "stopped",
      reason: "作品設定（.aiwriter/config.json）が JSON として読めません。直さずに止めました",
    };
  }

  const state = workUidStateOf(raw);
  if (state.kind === "present") {
    return { kind: "ready", workUid: state.workUid, added: false };
  }
  if (state.kind === "invalid") {
    return {
      kind: "stopped",
      reason:
        "作品設定の workUid の形が違います（英数字と - の8〜99字）。書き換えずに止めました",
    };
  }
  if (!options.allowAdd) {
    return { kind: "stopped", reason: "編集者モードでは作品の番号を足しません" };
  }

  // 確かめるのは作品設定の読み口（`parseWorkConfig`）と同じ形。読めない設定へは足さない
  try {
    workPaths(work, parseWorkConfig(raw));
  } catch (error) {
    return { kind: "stopped", reason: `作品設定の形が違います（${errorText(error)}）` };
  }

  // 番号を決める道は1つ（`planWorkUids`）。ほかの作品との重なりまで見るときは
  // `ensureAllWorkUids` が決めた番号を `newUid` で渡す
  const workUid = (
    options.newUid ??
    (() =>
      planWorkUids(
        [
          {
            key: work.id,
            createdAt: createdAtOf(raw),
            title: work.title,
            folderName: path.basename(work.folderPath),
          },
        ],
        randomUuid
      ).get(work.id) ?? randomUuid())
  )();
  try {
    const again = await readBytes();
    if (!again || !sameBytes(again, bytes)) {
      return { kind: "stopped", reason: "作品設定が読んでいる間に変わったので、今回は足しません" };
    }
    /*
      **読んだ生の中身に番号だけを足して書く**（`writeWorkConfig` を通さない）。あちらは
      知っている欄だけで作り直すので、新しい版が足した欄や、形の悪い任意の欄（`announce`
      など）を落とす。作者が操作したときなら作者の書き直しだが、ここは起動のたびに全作品へ
      自動で走るので、番号以外の1字も変えない（実装ルール2）。改行の形は読んだまま
    */
    const next = { ...(raw as Record<string, unknown>), workUid };
    await atomicWriteFile(
      workPaths(work).configFile,
      new TextEncoder().encode(formatJsonForFile(next, detectJsonFileFormat(bytes)))
    );
  } catch (error) {
    return { kind: "stopped", reason: `作品設定へ番号を書けません（${errorText(error)}）` };
  }
  return { kind: "ready", workUid, added: true };
}

/**
 * 登録してある作品すべての番号を確かめ、無い作品へ足す（作者の決定 2026-11-17「A」）。
 *
 * 番号は `createdAt` から作る（`planWorkUids`）。作品を写して `createdAt` が重なったときに
 * 2台で同じ作品へ同じ番号が付くよう、**番号の無い作品だけでなく、既にある番号もまとめて
 * 見てから決める**（1作品ずつ決めると、機械ごとに見た順で重なりの避け方が変わる）。
 *
 * @returns 作品ID → 結果
 */
export async function ensureAllWorkUids(
  works: readonly WorkEntry[],
  options: { allowAdd: boolean; random?: () => string }
): Promise<Map<string, EnsureWorkUidResult>> {
  const results = new Map<string, EnsureWorkUidResult>();
  const candidates: WorkUidCandidate[] = [];
  const absent: WorkEntry[] = [];
  for (const work of works) {
    let raw: unknown;
    try {
      raw = JSON.parse(
        stripBom(
          new TextDecoder().decode(
            await vscode.workspace.fs.readFile(path.toUri(workPaths(work).configFile))
          )
        )
      );
    } catch {
      // 無い・読めない・壊れている。理由は `ensureWorkUid` が確かめて返す
      results.set(work.id, await ensureWorkUid(work, { allowAdd: false }));
      continue;
    }
    const state = workUidStateOf(raw);
    const base = {
      key: work.id,
      createdAt: createdAtOf(raw),
      title: work.title,
      folderName: path.basename(work.folderPath),
    };
    if (state.kind === "present") {
      candidates.push({ ...base, existing: state.workUid });
      results.set(work.id, { kind: "ready", workUid: state.workUid, added: false });
    } else if (state.kind === "absent") {
      candidates.push(base);
      absent.push(work);
    } else {
      results.set(work.id, await ensureWorkUid(work, { allowAdd: false }));
    }
  }
  if (absent.length === 0) return results;
  const planned = planWorkUids(candidates, options.random ?? randomUuid);
  for (const work of absent) {
    const workUid = planned.get(work.id);
    results.set(
      work.id,
      await ensureWorkUid(work, {
        allowAdd: options.allowAdd,
        newUid: workUid ? () => workUid : undefined,
      })
    );
  }
  return results;
}

/** 核向けの辞書の場所 */
export function imeTsvFile(work: WorkEntry): string {
  return path.join(work.folderPath, ...IME_TSV_SEGMENTS);
}

/** 書いた（または同じ中身で既にあった）辞書のハッシュ（`sha256:` を前に付ける） */
function dictionaryHashText(bytes: Uint8Array): string {
  return `sha256:${sha256Bytes(bytes)}`;
}

/**
 * 核向けの辞書を書く。**中身が同じなら書かない**（同期の外とはいえ、無駄に時刻を進めない）。
 * @returns 辞書のハッシュ
 */
export async function writeImeTsv(work: WorkEntry, text: string): Promise<string> {
  const file = imeTsvFile(work);
  const bytes = new TextEncoder().encode(text);
  try {
    const existing = await vscode.workspace.fs.readFile(path.toUri(file));
    if (sameBytes(existing, bytes)) return dictionaryHashText(bytes);
  } catch {
    // 無い・読めない。書き直す
  }
  await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(file)));
  await atomicWriteFile(file, bytes);
  return dictionaryHashText(bytes);
}

/** いまある辞書のハッシュ。無ければ null（核は設定資料を直に読む） */
async function existingDictionaryHash(work: WorkEntry): Promise<string | null> {
  try {
    return dictionaryHashText(await vscode.workspace.fs.readFile(path.toUri(imeTsvFile(work))));
  } catch {
    return null;
  }
}

/**
 * 設定資料から核向けの辞書を組み立てて書く。
 *
 * 語の選び方は IME 辞書出力と同じ（`loadDictionaryForWork` → `buildDictionary`。
 * 作者が外した語も外す）。**読めない設定資料が1つでもあれば書かない**——前の辞書を
 * 残す（欠けた辞書で作品の語が消えるより、少し古い語のほうが打てる）。
 *
 * @returns 辞書のハッシュ。書けなかったら前の辞書のハッシュ（無ければ null）
 */
export async function rebuildImeTsv(
  work: WorkEntry,
  state: vscode.Memento | undefined,
  frequentEnabled: boolean = IME_FREQUENT_WORDS_ENABLED
): Promise<string | null> {
  const loaded = await loadDictionaryForWork(work);
  if (!loaded.ok) {
    logLine(
      `六徳 IME 向けの辞書を書き直しませんでした（読めない設定ファイル：${loaded.errorFiles.join("、")}）。前の辞書のままです：${work.title}`
    );
    return existingDictionaryHash(work);
  }
  const excluded = state?.get<string[]>(imeExcludedKey(work.id)) ?? [];
  const entries = withoutExcluded(loaded.built.entries, excluded);
  // 設定資料の語（外した語も含む）と同じ表記は、よく使う語へ出さない
  // 「よく使う語」から外した語は別の鍵で覚えている（3つの IME の書き出しの覚えと混ぜない）
  const frequent = frequentEnabled
    ? await loadFrequentWords(
        work,
        frequentSkipSurfaces(
          loaded.built.entries.map((entry) => entry.surface),
          excluded,
          state?.get<string[]>(imeFrequentExcludedKey(work.id)) ?? []
        )
      )
    : [];
  return writeImeTsv(work, buildImeTsv(entries, frequent));
}

/** 知らせ・一覧を置き場へ書く（一時ファイルから名前を替える） */
export async function writeImeJson(file: string, text: string): Promise<void> {
  await atomicWriteFile(file, new TextEncoder().encode(text));
}

export interface ImeLinkOptions {
  /** 登録簿（作品の一覧と、変わったときの知らせ） */
  registry: {
    list(): WorkEntry[];
    onDidChange: vscode.Event<void>;
  };
  /** 作者が外した語の控え（IME 辞書出力と同じ globalState） */
  state?: vscode.Memento;
  /** 前に出ている原稿エディター（`features/manuscriptEditor.ts` の `frontManuscript`） */
  frontManuscript: () =>
    | { filePath: string; vertical: boolean; active: boolean }
    | undefined;
  /** 原稿エディターの面が前に来た・向きを替えた */
  onDidChangeFrontManuscript: (listener: () => void) => vscode.Disposable;
  /**
   * 置き場を差し替える（試験だけ。作者の %LOCALAPPDATA% に書かないため）。
   * 省くと OS ごとの決まった所（`imeStateDir`・`imeOldStateDir`）
   */
  stateDir?: string;
  /** 置き場を複数差し替える（試験だけ。古い→新しいの順に書く。`stateDir` より優先） */
  stateDirs?: readonly string[];
}

export interface ImeLinkHandle extends vscode.Disposable {
  /** 拡張機能がファイルを書いた（`atomicWrite` の受け口から。設定資料なら辞書を書き直す） */
  noteFileWritten(filePath: string): void;
  /** 作品の設定資料が変わった（外での書き換え・取り込み） */
  noteSettingsChanged(work: WorkEntry): void;
  /** 作者が IME 辞書出力を押した（外した語が変わったかもしれない） */
  dictionaryExported(work: WorkEntry): void;
  /** 拡張機能を止める。この窓が書いた知らせなら `workUid: null` にする（待たれないことがある） */
  close(): Promise<void>;
}

/**
 * オリジナルIME との連動を始める。**ブラウザ版・リモートでは何もしない**（undefined）。
 *
 * 書くのは4つがそろうときだけ（`shouldWriteImeNotice`）。設定と置き場は書くたびに
 * 確かめる——IME をあとから入れた・設定を切り替えたときも、窓を開き直さずに効く。
 */
export function startImeLink(
  context: vscode.ExtensionContext,
  options: ImeLinkOptions
): ImeLinkHandle | undefined {
  if (!canRunProcesses()) return undefined;
  if (vscode.env.remoteName) return undefined;

  // 窓の番号は拡張機能ホストのプロセス番号（計画書 3.2）。素の `process` は読まない
  // （`core/runtime.ts` だけが読む決まり）。手元では `hostTag()` がプロセス番号そのもの
  const pid = Number(hostTag());
  let closed = false;
  // 書き込みを1本の列に並べる（窓の札と同じ）。閉じるときの null が、あとから届いた
  // 打ち直しに追い越されると、閉じた窓の作品が「いまの作品」に戻る
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    queue = queue.then(task).catch((error) => {
      logLine(`六徳 IME への知らせを書けませんでした：${errorText(error)}`);
    });
    return queue;
  };

  let front: ImeFront<WorkEntry> | undefined;
  let lastNoticeKey: string | undefined;
  let lastWorksKey: string | undefined;
  /** この起動のあいだに辞書を書き直した作品（起動前の変更を拾うため、最初の1回は組み直す） */
  const freshDictionaries = new Set<string>();
  /** 番号を確かめられなかった理由を、同じ作品で何度も書かない */
  const loggedStops = new Map<string, string>();

  let stateDirsPromise: Promise<string[]> | undefined;
  /** 置き場の候補。改名前（novel-ime）→ 新しい名前（rittoku-ime）の順 */
  const resolveStateDirs = (): Promise<string[]> => {
    stateDirsPromise ??= (async () => {
      if (options.stateDirs !== undefined) return [...options.stateDirs];
      if (options.stateDir !== undefined) return [options.stateDir];
      const platform = hostPlatform();
      let home: string | undefined;
      if (platform === "darwin") {
        try {
          // `node:os` は動的に読む（実装ルール7。静的に書くとブラウザ版が起動で落ちる）
          home = (await import("node:os")).homedir();
        } catch {
          home = environmentVariable("HOME");
        }
      }
      const where = { platform, localAppData: environmentVariable("LOCALAPPDATA"), home };
      return [imeOldStateDir(where), imeStateDir(where)].filter(
        (dir): dir is string => dir !== undefined
      );
    })();
    return stateDirsPromise;
  };

  /**
   * 4つがそろえば、書いてよい置き場（**フォルダーがある方の全部**。古い→新しいの順）を返す。
   * **置き場は作らない**（IME の無い機械では何もしない）。移る間は古い版の IME も旧い置き場を
   * 読むので、両方あれば両方へ同じ中身を書く
   */
  const writableStateDirs = async (): Promise<string[]> => {
    const enabled = vscode.workspace
      .getConfiguration("novelai")
      .get<boolean>(IME_NOTIFY_SETTING, true);
    const found: string[] = [];
    for (const stateDir of await resolveStateDirs()) {
      let stateDirExists = false;
      try {
        const stat = await vscode.workspace.fs.stat(path.toUri(stateDir));
        stateDirExists = (stat.type & vscode.FileType.Directory) !== 0;
      } catch {
        stateDirExists = false;
      }
      const ok = shouldWriteImeNotice({
        canRunProcesses: canRunProcesses(),
        remoteName: vscode.env.remoteName,
        enabled,
        stateDirExists,
      });
      if (ok) found.push(stateDir);
    }
    return found;
  };

  /**
   * 置き場ごとに書く。片方が書けなくても、もう片方へは書く（理由はログへ）。
   * 1か所も書けなかったときだけ失敗として投げる（呼び手が「書いた」ことにしない）
   */
  const writeToAll = async (
    stateDirs: readonly string[],
    fileName: string,
    text: string
  ): Promise<void> => {
    let failure: unknown;
    let wrote = 0;
    for (const stateDir of stateDirs) {
      try {
        await writeImeJson(path.join(stateDir, fileName), text);
        wrote++;
      } catch (error) {
        failure ??= error;
        logLine(`六徳 IME への知らせを書けませんでした（${stateDir}）：${errorText(error)}`);
      }
    }
    if (wrote === 0 && failure !== undefined) throw failure;
  };

  /** 結果をログへ（足したとき・止めた理由が変わったとき）。番号を返す */
  const settle = (work: WorkEntry, result: EnsureWorkUidResult): string | undefined => {
    if (result.kind === "ready") {
      loggedStops.delete(work.id);
      if (result.added) {
        logLine(`六徳 IME の作品の番号を作品設定へ足しました：${work.title}`);
      }
      return result.workUid;
    }
    if (loggedStops.get(work.id) !== result.reason) {
      loggedStops.set(work.id, result.reason);
      logLine(`六徳 IME へこの作品を知らせません（${result.reason}）：${work.title}`);
    }
    return undefined;
  };

  /** 登録してある作品すべての番号（無い作品へは足す）。作品ID → 番号 */
  const allWorkUids = async (): Promise<Map<string, string>> => {
    const works = options.registry.list();
    const results = await ensureAllWorkUids(works, { allowAdd: !isEditorMode() });
    const uids = new Map<string, string>();
    for (const work of works) {
      const result = results.get(work.id);
      const uid = result ? settle(work, result) : undefined;
      if (uid) uids.set(work.id, uid);
    }
    return uids;
  };

  const workUidFor = async (work: WorkEntry): Promise<string | undefined> => {
    // 既にあれば、その作品の設定ファイルだけを読んで済ませる（タブを替えるたびに全作品を読まない）
    const own = await ensureWorkUid(work, { allowAdd: false });
    if (own.kind === "ready") return settle(work, own);
    return (await allWorkUids()).get(work.id);
  };

  const refOf = (work: WorkEntry, workUid: string): ImeWorkRef => ({
    workUid,
    title: work.title,
    workDir: work.folderPath,
    dictionary: imeTsvFile(work),
  });

  /** いまの作品の辞書のハッシュ。この起動で初めてなら組み直す（起動前の変更を拾う） */
  const dictionaryHashFor = async (work: WorkEntry): Promise<string | null> => {
    if (!freshDictionaries.has(work.id)) {
      freshDictionaries.add(work.id);
      return rebuildImeTsv(work, options.state);
    }
    return existingDictionaryHash(work);
  };

  const writeCurrent = (force: boolean): Promise<void> =>
    enqueue(async () => {
      if (closed) return;
      // 焦点の無い窓は書かない（焦点のある窓が「いまの作品」を持つ。計画書 3.4）
      if (!vscode.window.state.focused) return;
      const stateDirs = await writableStateDirs();
      if (stateDirs.length === 0 || !front) return;
      const workUid = await workUidFor(front.work);
      // 番号が無い作品は知らせない（直前の作品のまま。IME は名前で鍵を作らない）
      if (!workUid) return;
      const notice = buildCurrentWorkNotice({
        work: refOf(front.work, workUid),
        dictionaryHash: await dictionaryHashFor(front.work),
        vertical: front.vertical,
        window: pid,
        now: new Date(),
      });
      const key = imeNoticeKey(notice);
      if (!force && key === lastNoticeKey) return;
      await writeToAll(stateDirs, IME_CURRENT_WORK_FILE, serializeImeJson(notice));
      lastNoticeKey = key;
    });

  const writeWorks = (): Promise<void> =>
    enqueue(async () => {
      if (closed) return;
      const stateDirs = await writableStateDirs();
      if (stateDirs.length === 0) return;
      const refs: ImeWorkRef[] = [];
      const uids = await allWorkUids();
      for (const work of options.registry.list()) {
        const workUid = uids.get(work.id);
        if (workUid) refs.push(refOf(work, workUid));
      }
      const list = buildWorksList({ works: refs, window: pid, now: new Date() });
      const key = imeNoticeKey(list);
      if (key === lastWorksKey) return;
      await writeToAll(stateDirs, IME_WORKS_FILE, serializeImeJson(list));
      lastWorksKey = key;
    });

  /**
   * 「作品なし」（`workUid: null`）を書く（閉じるとき・いまの作品の登録を外したとき）。
   * **この窓が書いた知らせのときだけ**——ほかの窓が書いた「いまの作品」を消すと、
   * 開いている窓で打っているのに作品の語が消える。
   */
  const closedNoticeTask = async (): Promise<void> => {
    // 両方の置き場で、それぞれ「この窓が書いた知らせ」だけを消す
    const mine: string[] = [];
    for (const stateDir of await writableStateDirs()) {
      const text = await readText(path.join(stateDir, IME_CURRENT_WORK_FILE));
      if (text !== undefined && noticeWindowOf(text) === pid) mine.push(stateDir);
    }
    if (mine.length === 0) return;
    const notice = buildCurrentWorkNotice({
      work: null,
      dictionaryHash: null,
      vertical: null,
      window: pid,
      now: new Date(),
    });
    await writeToAll(mine, IME_CURRENT_WORK_FILE, serializeImeJson(notice));
    lastNoticeKey = imeNoticeKey(notice);
  };

  const findWork = (filePath: string): WorkEntry | undefined =>
    findWorkForFile(options.registry.list(), filePath);

  const manuscriptObserved = (): ImeObservedFront | undefined => {
    const manuscript = options.frontManuscript();
    return manuscript
      ? { source: "manuscript", filePath: manuscript.filePath, vertical: manuscript.vertical }
      : undefined;
  };

  /** 焦点・起動のとき：前の原稿エディター → 前のエディター → 最後の原稿エディター */
  const windowObserved = (): ImeObservedFront => {
    const manuscript = options.frontManuscript();
    if (manuscript?.active) {
      return { source: "manuscript", filePath: manuscript.filePath, vertical: manuscript.vertical };
    }
    const editor = vscode.window.activeTextEditor;
    if (editor) return { source: "text", filePath: path.fromUri(editor.document.uri) };
    return manuscriptObserved() ?? { source: "none" };
  };

  const apply = (event: ImeFrontEvent<WorkEntry>, force: boolean): void => {
    front = decideImeFront(front, event, findWork);
    void writeCurrent(force);
  };

  const openWorks = (): WorkEntry[] => {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) =>
      path.fromUri(folder.uri)
    );
    return options.registry.list().filter((work) =>
      folders.some(
        (folder) =>
          path.isSamePath(folder, work.folderPath) ||
          path.isPathInside(folder, work.folderPath) ||
          path.isPathInside(work.folderPath, folder)
      )
    );
  };

  // 起動：作品の一覧と、いまの作品（前のもので決まらなければ、開いている作品が1つならそれ）
  void writeWorks();
  apply({ kind: "startup", front: windowObserved(), openWorks: openWorks() }, true);

  const settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const scheduleDictionary = (work: WorkEntry): void => {
    const pending = settleTimers.get(work.id);
    if (pending) clearTimeout(pending);
    settleTimers.set(
      work.id,
      setTimeout(() => {
        settleTimers.delete(work.id);
        void enqueue(async () => {
          if (closed) return;
          if ((await writableStateDirs()).length === 0) return;
          // 番号が無い作品の辞書は読む相手がいない（作品の一覧にも載らない）
          if (!(await workUidFor(work))) return;
          freshDictionaries.add(work.id);
          await rebuildImeTsv(work, options.state);
        });
        // いまの作品なら、ハッシュを替えて知らせを書き直す
        if (front?.work.id === work.id) void writeCurrent(false);
      }, IME_DICTIONARY_SETTLE_MS)
    );
  };

  const disposables: vscode.Disposable[] = [
    options.onDidChangeFrontManuscript(() => {
      const observed = manuscriptObserved();
      if (observed) apply({ kind: "front", front: observed }, false);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      // 作品の外のファイル・エディターが無い（パネルが前）ときは替えない
      if (!editor) return;
      apply({ kind: "front", front: { source: "text", filePath: path.fromUri(editor.document.uri) } }, false);
    }),
    vscode.window.onDidChangeWindowState((windowState) => {
      // 焦点が来た窓が「いまの作品」を書き直す。ほかの窓が書いた知らせを上書きするので必ず書く
      if (windowState.focused) apply({ kind: "focus", front: windowObserved() }, true);
    }),
    options.registry.onDidChange(() => {
      void writeWorks();
      if (!front) return;
      const id = front.work.id;
      const fresh = options.registry.list().find((work) => work.id === id);
      if (fresh) {
        // 名前の変更・フォルダーの移動のあとも、心拍が古い題と道を書き続けないよう引き直す
        front = { ...front, work: fresh };
        void writeCurrent(false);
        return;
      }
      // 登録を外した作品が「いまの作品」だった。作品を閉じたのと同じく `workUid: null` にする
      front = undefined;
      void enqueue(async () => {
        if (!closed) await closedNoticeTask();
      });
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(`novelai.${IME_NOTIFY_SETTING}`)) return;
      // 入れたときにすぐ書く（切ったときは書かない。IME は古い知らせを15分で閉じた扱いにする）
      lastNoticeKey = undefined;
      lastWorksKey = undefined;
      void writeWorks();
      void writeCurrent(true);
    }),
  ];
  // 心拍：焦点のある窓だけが `at` を書き直す（writeCurrent が焦点を見る）
  const heartbeat = setInterval(() => void writeCurrent(true), IME_HEARTBEAT_MS);

  /*
    辞書に入る語の入った設定資料（人物・場所・組織・能力・世界観のフォルダーの JSON）だけを
    拾う。外での書き換えの見張り（SettingsWatcher）と同じ判定を通す——作品の中の JSON を
    みな拾うと、執筆量や履歴の保存のたびに設定資料を全部読み直すことになる
  */
  const settingsWork = (filePath: string): WorkEntry | undefined => {
    if (!isWatchedSettingsFile(filePath)) return undefined;
    const kind = kindOfSettingsFile(filePath);
    if (!kind || kind === "customFields") return undefined;
    return findWork(filePath);
  };

  /*
    話の保存でも辞書を組み直す（よく使う語の数え直し）。**定数が false の間は何もしない**
    （話の保存のたびに本文を読み直さない）。設定フォルダーは既定の場所で見る
    （作品設定を読み直さない。違う場所にした作品でも、数える側は走査の結果だけを読む）
  */
  const episodeWork = (filePath: string): WorkEntry | undefined => {
    if (!frequentWordsEnabled()) return undefined;
    const work = findWork(filePath);
    if (!work) return undefined;
    return isEpisodeFilePath(work.folderPath, workPaths(work).settings, filePath) ? work : undefined;
  };

  disposables.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (closed) return;
      const work = episodeWork(path.fromUri(document.uri));
      if (work) scheduleDictionary(work);
    })
  );

  const close = (): Promise<void> => {
    if (closed) return queue;
    closed = true;
    clearInterval(heartbeat);
    for (const timer of settleTimers.values()) clearTimeout(timer);
    settleTimers.clear();
    for (const item of disposables) item.dispose();
    queue = queue
      .then(() => closedNoticeTask())
      .catch((error) => {
        logLine(`六徳 IME へ閉じたことを知らせられませんでした：${errorText(error)}`);
      });
    return queue;
  };

  context.subscriptions.push({ dispose: () => void close() });

  return {
    noteFileWritten: (filePath) => {
      if (closed) return;
      const work = settingsWork(filePath) ?? episodeWork(filePath);
      if (work) scheduleDictionary(work);
    },
    noteSettingsChanged: (work) => {
      if (!closed) scheduleDictionary(work);
    },
    dictionaryExported: (work) => {
      if (!closed) scheduleDictionary(work);
    },
    close,
    dispose: () => void close(),
  };
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(path.toUri(file)));
  } catch {
    return undefined;
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
