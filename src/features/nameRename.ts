import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import type { Character } from "../models/character";
import { scanWork } from "../core/scanner";
import { readTextFile } from "../core/textFile";
import { deriveReading } from "../core/reading";
import { CharacterStore } from "../core/characterStore";
import {
  createAbilityStore,
  createLocationStore,
  createOrganizationStore,
  createWorldStore,
} from "../core/abilityStore";
import { createForeshadowStore } from "../core/foreshadowStore";
import type { SettingsStore, StorableRecord } from "../core/settingsStore";
import { SynopsisStore } from "../core/synopsisStore";
import { plotPath, readPlotText, writePlotText } from "../core/plotFile";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import { SYNOPSIS_FILE } from "../core/synopsisDoc";
import {
  activeMapping,
  applyMappingToRecord,
  applyMappingToText,
  buildRenameMapping,
  planTextReplacements,
  type RenameMappingEntry,
} from "../core/nameRename";
import type { TypoCheckIssue } from "./checkTypos";
import { askText, cancelItem } from "../views/dialogs";
import { logFailure } from "../core/logger";

/**
 * 名前の付け替え（設計書6.37.3）。
 *
 * **本文を書き換える経路を新しく作らない。** 表記ゆれ検知（`checkNotation.ts`）と
 * 同じく、置き換えの候補を `TypoCheckIssue` の形にして提案パネルへ渡す。
 * 1件ずつの「適用」＝個別確認変換、「まとめて適用」＝一括変換、
 * 「本文を見る」＝登場箇所へのジャンプで、**3つとも既存の口で足りる**
 * （CLAUDE.md 規則1・2）。
 *
 * 資料側（レコード・プロット・あらすじ・伏線）は、本文の適用が終わってから
 * 別のコマンドで1回にまとめて直す。本文と資料を同時に書き換えると、
 * 本文の適用に失敗した分だけ資料と食い違う。
 */

/** 付け替えの待ちを置く鍵。作品ごとに1つ */
const PENDING_RENAME_PREFIX = "novelai.pendingRename.";

export function pendingRenameKey(workId: string): string {
  return `${PENDING_RENAME_PREFIX}${workId}`;
}

/**
 * 本文へ出した指摘と、まだ当てていない資料の対応表。
 *
 * **本文と資料の間に時間が空く**（作者が提案パネルで1件ずつ確かめる）。
 * その間に対応表を持っておかないと、「資料にも反映」で作者にもう一度
 * 同じ入力をさせることになる。
 */
export interface PendingRename {
  characterId: string;
  oldName: string;
  newName: string;
  newReading: string | null;
  mapping: RenameMappingEntry[];
  /** いつ作ったか。古い待ちが残っていたときに作者へ伝える */
  createdAt: string;
}

export function loadPendingRename(
  state: vscode.Memento,
  workId: string
): PendingRename | undefined {
  return state.get<PendingRename>(pendingRenameKey(workId));
}

export async function savePendingRename(
  state: vscode.Memento,
  workId: string,
  pending: PendingRename
): Promise<void> {
  await state.update(pendingRenameKey(workId), pending);
}

export async function clearPendingRename(
  state: vscode.Memento,
  workId: string
): Promise<void> {
  await state.update(pendingRenameKey(workId), undefined);
}

export interface RenameCharacterOptions {
  /** 点検画面から呼ぶときの対象。省略すると選ばせる */
  characterId?: string;
  /** AIの候補から呼ぶときの新しい名前。入力欄の初期値になる */
  suggestedName?: string;
  /** 同、新しい読み */
  suggestedReading?: string;
}

export interface RenameCharacterResult {
  issues: TypoCheckIssue[];
  pending: PendingRename;
  /** 置き換えが見つかったファイルの数 */
  fileCount: number;
  /** 競合マーカーがあって見なかったファイル */
  conflicted: string[];
}

/**
 * 名前を付け替える指摘を作る（本文はまだ書き換えない）。
 *
 * @returns 取りやめられたら undefined
 */
export async function renameCharacter(
  work: WorkEntry,
  options: RenameCharacterOptions = {}
): Promise<RenameCharacterResult | undefined> {
  const store = new CharacterStore(work);
  const loaded = await store.loadAll();
  if (loaded.characters.length === 0) {
    vscode.window.showWarningMessage(
      "登場人物が登録されていません。先に設定資料を抽出してください。"
    );
    return undefined;
  }

  const character = options.characterId
    ? loaded.characters.find((entry) => entry.id === options.characterId)
    : await pickCharacter(loaded.characters);
  if (!character) return undefined;

  const newName = await askText({
    title: `「${character.name}」を何という名前にしますか`,
    value: options.suggestedName ?? character.name,
    prompt: "本文と資料の両方を、この名前へ付け替える候補を作ります。",
    validateInput: (value) =>
      value.trim() ? undefined : "名前を入れてください。",
  });
  if (newName === undefined) return undefined;
  const nextName = newName.trim();
  if (!nextName || nextName === character.name) {
    vscode.window.showInformationMessage("名前が変わっていません。");
    return undefined;
  }

  const readingInput = await askText({
    title: `「${nextName}」の読み`,
    // カタカナ名なら機械的に作れる。漢字なら空のまま出して作者に委ねる
    value: options.suggestedReading ?? deriveReading(nextName) ?? "",
    prompt: "空のままでも構いません（あとで設定資料パネルから入れられます）。",
  });
  if (readingInput === undefined) return undefined;
  const newReading = readingInput.trim() || null;

  const mapping = await confirmMapping(
    buildRenameMapping(character, nextName, newReading)
  );
  if (!mapping) return undefined;

  if (activeMapping(mapping).length === 0) {
    vscode.window.showInformationMessage(
      "置き換える対応が1つも選ばれていません。左端の四角を押して選んでください。"
    );
    return undefined;
  }

  const scanned = await collectIssues(work, character, mapping);
  if (!scanned) return undefined;

  const pending: PendingRename = {
    characterId: character.id,
    oldName: character.name,
    newName: nextName,
    newReading,
    mapping,
    createdAt: new Date().toISOString(),
  };

  const proceed = await confirmScope(scanned, character.name, nextName);
  if (!proceed) return undefined;

  return { ...scanned, pending };
}

/** 誰を付け替えるか。登場話数を添えて、取り違えを防ぐ */
async function pickCharacter(
  characters: Character[]
): Promise<Character | undefined> {
  const items = characters.map((character) => ({
    label: character.name,
    description: character.reading ?? "",
    detail: [
      character.summary ?? "",
      character.aliases.length > 0 ? `別名: ${character.aliases.join("、")}` : "",
    ]
      .filter(Boolean)
      .join(" / "),
    character,
  }));

  const picked = await vscode.window.showQuickPick([...items, cancelItem()], {
    title: "名前を付け替える人物",
    placeHolder: "選んでも、まだ何も書き換わりません",
    ignoreFocusOut: true,
  });
  if (!picked || !("character" in picked)) return undefined;
  return picked.character;
}

/**
 * 対応表を作者に確かめてもらう（設計書6.37.3）。
 *
 * **別名は1件ずつ訊く。** 「マル」を「レオ」にするのか、そのまま残すのかは
 * 作者にしか決められない。空のままなら変えない。
 */
async function confirmMapping(
  initial: RenameMappingEntry[]
): Promise<RenameMappingEntry[] | undefined> {
  const filled: RenameMappingEntry[] = [];
  for (const entry of initial) {
    if (entry.kind !== "alias") {
      filled.push(entry);
      continue;
    }
    const answer = await askText({
      title: `別名「${entry.from}」はどうしますか`,
      value: "",
      prompt: "新しい呼び方を入れてください。空のままなら変えません。",
    });
    if (answer === undefined) return undefined;
    const to = answer.trim();
    filled.push({
      ...entry,
      to,
      // 作者が自分で入れたものなので、短くても既定で有効にする
      enabled: Boolean(to),
    });
  }

  const items = filled.map((entry) => ({
    label: entry.to ? `${entry.from} → ${entry.to}` : `${entry.from}（変えない）`,
    description: describeMappingKind(entry),
    detail: describeMappingDetail(entry),
    picked: entry.enabled,
    entry,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: "この対応で付け替えます",
    placeHolder:
      "外すものは四角を押して解除してください（自動では書き換えません）",
    canPickMany: true,
    ignoreFocusOut: true,
  });
  if (!picked) return undefined;

  const chosen = new Set(picked.map((item) => item.entry));
  return filled.map((entry) => ({ ...entry, enabled: chosen.has(entry) }));
}

function describeMappingKind(entry: RenameMappingEntry): string {
  if (entry.kind === "alias") return "別名";
  if (entry.kind === "reading") return "ルビの読み（既定では外しています）";
  if (entry.kind === "part") {
    return entry.from.length <= 2
      ? "姓または名（短いので既定では外しています）"
      : "姓または名";
  }
  return entry.from.length <= 2
    ? "フルネーム（短いので既定では外しています）"
    : "フルネーム";
}

/**
 * 選ぶ前に、何が起きるかを1行で見せる。
 *
 * **読みは何が起きるか分かりにくい。** 選ばないとルビの base だけが変わって
 * `｜源《さなだ》` が残り、選ぶと読みが普通名詞と重なったところまで
 * 書き換わる。どちらも押す前には見えないので、両方を書く。
 */
function describeMappingDetail(entry: RenameMappingEntry): string | undefined {
  if (!entry.to) {
    return "付け替え先が空なので、この呼び方は本文にも資料にも残ります";
  }
  if (entry.kind === "reading") {
    return (
      "ルビの読みも変えます（｜真田《さなだ》→｜源《げん》）。" +
      "選ばないと、ルビの読みだけ旧いままになります"
    );
  }
  return undefined;
}

/** 本文を走査して、置き換えの指摘を組み立てる */
async function collectIssues(
  work: WorkEntry,
  character: Character,
  mapping: RenameMappingEntry[]
): Promise<Omit<RenameCharacterResult, "pending"> | undefined> {
  const scan = await scanWork(work);
  if (scan.episodes.length === 0) {
    vscode.window.showWarningMessage("本文ファイルが見つかりません。");
    return undefined;
  }

  const issues: TypoCheckIssue[] = [];
  const conflicted: string[] = [];
  const files = new Set<string>();

  for (const episode of scan.episodes) {
    const file = await readTextFile(episode.filePath);
    // 競合マーカーのあるファイルはAI処理も置換も通さない（CLAUDE.md 規則1）
    if (file.hasConflictMarkers) {
      conflicted.push(episode.fileName);
      continue;
    }

    // **ファイル全体を走査する。** 見出しやサブタイトルにも名前は出るし、
    // 提案パネルは行番号をファイルの先頭から数えるので、ここを切ると狂う
    for (const item of planTextReplacements(file.text, mapping)) {
      files.add(episode.filePath);
      issues.push({
        filePath: episode.filePath,
        // 無視の記録が本文の編集で消えないよう、内容ハッシュではなく
        // 「どのファイルの誰の付け替えか」で固定する（`checkNotation` と同じ）
        chunkHash: `rename:${path.basename(episode.filePath)}:${character.id}`,
        line: item.line,
        original: item.original,
        target: item.target,
        suggestion: item.suggestion,
        reason: item.reason,
        // 対応表は作者が確かめている。機械的な置き換えなので迷いはない
        confidence: "high",
      });
    }
  }

  if (conflicted.length > 0) {
    const proceed = await vscode.window.showWarningMessage(
      `未解決の競合が ${conflicted.length} 件あります（${conflicted
        .slice(0, 3)
        .join(", ")}${conflicted.length > 3 ? " ほか" : ""}）。` +
        "これらのファイルは対象から外れます。",
      "除外して続行",
      "中止"
    );
    if (proceed !== "除外して続行") return undefined;
  }

  return { issues, fileCount: files.size, conflicted };
}

/**
 * 件数と対象ファイル数を見せてから進む（設計書6.37.3）。
 *
 * **取り消し方を必ず添える。** 何十話ぶんを書き換える操作なので、
 * 元へ戻せることが分かっていないと押せない。
 */
async function confirmScope(
  scanned: Omit<RenameCharacterResult, "pending">,
  oldName: string,
  newName: string
): Promise<boolean> {
  if (scanned.issues.length === 0) {
    vscode.window.showInformationMessage(
      `本文に「${oldName}」は見つかりませんでした。` +
        "資料だけを直すなら「名前の付け替えを資料にも反映」を実行してください。"
    );
    // 本文が0件でも資料は直せる。待ちは残したいので、進んだことにする
    return true;
  }

  const answer = await vscode.window.showWarningMessage(
    `「${oldName}」→「${newName}」の置き換えを ${scanned.issues.length}件、` +
      `${scanned.fileCount}ファイルで見つけました。`,
    {
      modal: true,
      detail:
        "提案パネルに並べます。ここではまだ本文は書き換わりません。\n" +
        "1件ずつ「適用」するか、「まとめて適用」で一括にできます。\n" +
        "取り消しは Git の「復元」から行えます。",
    },
    "提案パネルに出す"
  );
  return answer === "提案パネルに出す";
}

/** 資料へ反映した結果。何をどれだけ直したかを報告に使う */
export interface RenameRecordsResult {
  characterUpdated: boolean;
  /** 種別ごとの書き換えた件数 */
  settingsUpdated: number;
  plotUpdated: boolean;
  synopsisDocUpdated: boolean;
  chapterSynopsesUpdated: number;
  foreshadowsUpdated: number;
  /** 直せなかったもの。**黙って飲み込まない** */
  failures: string[];
}

/**
 * 待っている付け替えを、資料の側にも当てる（設計書6.37.3）。
 *
 * **保存は各ストアの既存の口を通す。** 人物は `CharacterStore.saveOrUpdate`
 * （既存ファイルは上書きできないので、退避→新規作成を中で行う）。
 * 能力・場所・組織・世界観・伏線は `SettingsStore.saveAll`（読み込み時の
 * ハッシュと照合してから書く）。`atomicWriteFile` を直に呼ばない
 * （CLAUDE.md 規則2）。
 */
export async function applyRenameToRecords(
  work: WorkEntry,
  pending: PendingRename
): Promise<RenameRecordsResult> {
  const result: RenameRecordsResult = {
    characterUpdated: false,
    settingsUpdated: 0,
    plotUpdated: false,
    synopsisDocUpdated: false,
    chapterSynopsesUpdated: 0,
    foreshadowsUpdated: 0,
    failures: [],
  };

  await applyToCharacters(work, pending, result);
  await applyToSettings(work, pending, result);
  await applyToPlot(work, pending, result);
  await applyToSynopsisDoc(work, pending, result);
  await applyToChapterSynopses(work, pending, result);
  await applyToForeshadows(work, pending, result);

  return result;
}

async function applyToCharacters(
  work: WorkEntry,
  pending: PendingRename,
  result: RenameRecordsResult
): Promise<void> {
  const store = new CharacterStore(work);
  const loaded = await store.loadAll();

  for (const character of loaded.characters) {
    const self = character.id === pending.characterId;
    const next = applyMappingToRecord(character, pending.mapping, {
      // **他人物が持つ「相手の名前」まで直す。** ここを残すと、付け替えた
      // はずの旧名が人物相関図に点線のノードとして現れる（設計書6.38.5）
      applyCharacterLinks: true,
      ...(self
        ? {
            newName: pending.newName,
            newReading: pending.newReading,
            // 旧名を別名に残さない（残すと用語ハイライトが拾い続ける）
            dropAliases: [pending.oldName],
          }
        : {}),
    });
    if (JSON.stringify(next) === JSON.stringify(character)) continue;

    try {
      // **`save()` を直接呼ばない。** 既存ファイルは上書きできないので、
      // 退避→新規作成の呼び分けはストアに任せる
      await store.saveOrUpdate(next);
      if (self) result.characterUpdated = true;
      else result.settingsUpdated++;
    } catch (error) {
      result.failures.push(`人物「${character.name}」：${messageOf(error)}`);
    }
  }
}

async function applyToSettings(
  work: WorkEntry,
  pending: PendingRename,
  result: RenameRecordsResult
): Promise<void> {
  // **1つずつ型を保ったまま渡す。** 4つを1つの配列にまとめると、
  // `saveAll` の引数が4つの型の交わりになって受け取れなくなる
  await applyToStore("能力", createAbilityStore(work), pending, result);
  await applyToStore("場所", createLocationStore(work), pending, result);
  await applyToStore("組織", createOrganizationStore(work), pending, result);
  await applyToStore("世界観", createWorldStore(work), pending, result);
}

/** 1つの設定資料ストアへ当てる。書き換えのあったレコードだけを保存する */
async function applyToStore<T extends StorableRecord>(
  label: string,
  store: SettingsStore<T>,
  pending: PendingRename,
  result: RenameRecordsResult
): Promise<void> {
  const loaded = await store.loadAll();
  const changed = loaded.records
    .map((record) => ({
      record,
      next: applyMappingToRecord(record, pending.mapping),
    }))
    .filter((pair) => JSON.stringify(pair.next) !== JSON.stringify(pair.record));
  if (changed.length === 0) return;

  try {
    await store.saveAll(changed.map((pair) => pair.next));
    result.settingsUpdated += changed.length;
  } catch (error) {
    result.failures.push(`${label}の資料：${messageOf(error)}`);
  }
}

async function applyToPlot(
  work: WorkEntry,
  pending: PendingRename,
  result: RenameRecordsResult
): Promise<void> {
  try {
    const current = await readPlotText(work);
    if (!current) return;
    const next = applyMappingToText(current, pending.mapping);
    if (next === current) return;
    await writePlotText(await plotPath(work), next);
    result.plotUpdated = true;
  } catch (error) {
    result.failures.push(`プロット：${messageOf(error)}`);
  }
}

/**
 * 紹介文・あらすじの読み物（`設定/synopsis.md`）を直す。
 *
 * **書き込みは `writePlotText` を通す。** 名前はプロット向きだが、中身は
 * 「作者のMarkdownを退避してから作り直す」という汎用の手順で、この
 * プロジェクトでMarkdownを安全に置き換える唯一の口である。同じ手順を
 * ここへ書き写すと、退避の仕方が2通りになる。
 */
async function applyToSynopsisDoc(
  work: WorkEntry,
  pending: PendingRename,
  result: RenameRecordsResult
): Promise<void> {
  try {
    const config = await readWorkConfig(work);
    const target = path.join(workPaths(work, config).settings, SYNOPSIS_FILE);
    let current: string;
    try {
      current = new TextDecoder().decode(
        await vscode.workspace.fs.readFile(path.toUri(target))
      );
    } catch {
      return; // まだ作られていない。作らない
    }
    const next = applyMappingToText(current, pending.mapping);
    if (next === current) return;
    await writePlotText(target, next);
    result.synopsisDocUpdated = true;
  } catch (error) {
    result.failures.push(`${SYNOPSIS_FILE}：${messageOf(error)}`);
  }
}

async function applyToChapterSynopses(
  work: WorkEntry,
  pending: PendingRename,
  result: RenameRecordsResult
): Promise<void> {
  try {
    const store = new SynopsisStore(work);
    const set = await store.load();
    if (set.episodes.length === 0) return;

    let changed = 0;
    const episodes = set.episodes.map((episode) => {
      const next = applyMappingToRecord(episode, pending.mapping);
      if (JSON.stringify(next) !== JSON.stringify(episode)) changed++;
      return next;
    });
    if (changed === 0) return;

    await store.save({ ...set, episodes });
    result.chapterSynopsesUpdated = changed;
  } catch (error) {
    result.failures.push(`各話あらすじ：${messageOf(error)}`);
  }
}

/**
 * 伏線台帳を直す。
 *
 * **引用（`plantedQuote`・`resolvedQuote`）も直す。** 本文と逐語で一致して
 * いなければ、回収の照合が当たらなくなる（設計書6.35.1）。
 */
async function applyToForeshadows(
  work: WorkEntry,
  pending: PendingRename,
  result: RenameRecordsResult
): Promise<void> {
  try {
    const store = createForeshadowStore(work);
    const loaded = await store.loadAll();
    const changed = loaded.records
      .map((record) => ({
        record,
        next: applyMappingToRecord(record, pending.mapping),
      }))
      .filter(
        (pair) => JSON.stringify(pair.next) !== JSON.stringify(pair.record)
      );
    if (changed.length === 0) return;

    await store.saveAll(changed.map((pair) => pair.next));
    result.foreshadowsUpdated = changed.length;
  } catch (error) {
    result.failures.push(`伏線台帳：${messageOf(error)}`);
  }
}

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  logFailure("名前の付け替え（資料）", { 内容: message });
  return message;
}

/**
 * 何をどれだけ直したかを、作者の言葉で伝える。
 *
 * **0件のときこそ理由が要る**（`describeNotationResult` と同じ考え方）。
 */
export function describeRenameRecordsResult(
  pending: PendingRename,
  result: RenameRecordsResult
): string {
  const parts: string[] = [];
  if (result.characterUpdated) {
    parts.push(`人物「${pending.oldName}」を「${pending.newName}」にしました`);
  }
  if (result.settingsUpdated > 0) {
    parts.push(`他の資料 ${result.settingsUpdated}件`);
  }
  if (result.plotUpdated) parts.push("プロット");
  if (result.synopsisDocUpdated) parts.push("紹介文・あらすじ");
  if (result.chapterSynopsesUpdated > 0) {
    parts.push(`各話あらすじ ${result.chapterSynopsesUpdated}件`);
  }
  if (result.foreshadowsUpdated > 0) {
    parts.push(`伏線 ${result.foreshadowsUpdated}件`);
  }

  const head =
    parts.length > 0
      ? `資料を直しました：${parts.join(" / ")}。`
      : "直すところがありませんでした（資料に旧い名前は残っていません）。";

  if (result.failures.length === 0) return head;
  return (
    `${head} ただし ${result.failures.length}件は直せませんでした：` +
    result.failures.join(" / ")
  );
}
