import * as vscode from "vscode";
import { WorkEntry } from "../models/types";
import {
  emptyCharacter,
  nextCharacterId,
  type Character,
} from "../models/character";
import { findCharactersByAppellation } from "../core/plotCharacterSync";
import { CharacterStore, CharacterStoreError } from "../core/characterStore";
import {
  PendingUpdateStore,
  pendingSourceLabel,
  type PendingUpdate,
} from "../core/pendingUpdates";
import {
  diffCharacter,
  diffLinesForPanel,
  formatDiff,
  summarizeDiff,
  type CharacterDiff,
} from "../core/characterDiff";
import { diffChars } from "../core/inlineDiff";
import { dropDiffEntries } from "../core/dropDiffEntries";
import { CustomFieldStore } from "../core/customFieldStore";
import { fieldsFor } from "../models/customField";
import {
  PendingSettingsUpdateStore,
  type PendingSettingsUpdate,
} from "../core/pendingSettingsUpdates";
import {
  PENDING_KIND_SHORT_LABELS,
  diffSettingsRecord,
  mergePendingSettingsRecord,
  type PendingSettingsKind,
  type PendingSettingsRecord,
} from "../core/pendingSettingsMerge";
import {
  createAbilityStore,
  createLocationStore,
  createOrganizationStore,
  createWorldStore,
} from "../core/abilityStore";
import type { Ability } from "../models/ability";
import type { Location } from "../models/location";
import type { Organization } from "../models/organization";
import type { WorldItem } from "../models/world";
import type { PendingUpdateSource } from "../core/pendingUpdates";
import { logFailure, useLogFile } from "../core/logger";
import { openGeneratedMarkdown } from "../views/openDocument";
import { whenNoticePicked } from "../views/notify";
import type { ProposalPanel, RecordUpdateViewItem } from "./proposalPanel";

/**
 * 抽出で作られた既存人物の更新案を、作者が確認して反映する。
 *
 * 自動では反映しない。抽出はAIの判断であり、作者が確定させた記述を
 * 黙って書き換えないというのがこのプロジェクトの約束である。
 * ただし1件ずつ承認させると19話ぶんで手が止まるので、
 * 中身を見たうえで「すべて反映」できるようにする。
 */

interface ReviewItem {
  update: PendingUpdate;
  /** 更新前のレコード。**新規案には無い**（まだ台帳に居ない） */
  current: Character | undefined;
  diff: CharacterDiff;
}

/** その案が「新しく作る」ものか（設計書6.4.9） */
function isCreation(item: ReviewItem): boolean {
  return item.update.kind === "creation";
}

/**
 * 何が変わるかの要約に、出どころを添える（設計書6.4.9）。
 *
 * **AIが本文から読んだものと、作者がプロットへ書いたものは別物である。**
 * 同じ「紹介を変更」でも、承認するときの見方が変わる。
 */
/** 確認文に名前を並べる上限。多いと読まずに押される */
const CONFIRM_PREVIEW_LIMIT = 5;

/**
 * 「N人の設定に更新があります」の確認文（設計書6.8）。
 *
 * **数と並びを1つの配列から作る。** 前は「N人」と一覧と「ほかN人」を
 * 別々に組んでおり、片方だけ直せば黙って食い違う形だった。
 * 数の整合は目で数えるしかなかったので、純粋関数にして機械に確かめさせる。
 */
export function describePendingUpdatesConfirm(
  entries: ReadonlyArray<{ name: string; change: string }>,
  /**
   * 数える単位。人物だけなら「人」、場所などが混じれば「件」
   * （2026-09-23〜。「3 人の設定」に場所が入っていると読み違える）
   */
  unit: "人" | "件" = "人"
): string {
  const shown = entries.slice(0, CONFIRM_PREVIEW_LIMIT);
  const rest = entries.length - shown.length;

  return (
    `${entries.length} ${unit}の設定に更新があります。\n` +
    shown.map((entry) => `・${entry.name}: ${entry.change}`).join("\n") +
    (rest > 0 ? `\n…ほか ${rest} ${unit}` : "")
  );
}

function describeChange(item: ReviewItem): string {
  const label = pendingSourceLabel(item.update.source);
  const summary = isCreation(item) ? "新規の人物" : summarizeDiff(item.diff);
  /*
    **理由があれば、出どころの隣に出す**（設計書6.87.16）。外部AIの案は
    本文の根拠（`evidence`）を持たないことがあるので、**なぜそう提案したか
    だけが作者の判断材料**になる。確認文は1行なので、ここは短く切る
    （長い理由は差分の文書側に全部出る）。
  */
  const base = label ? `${label}：${summary}` : summary;
  const reason = item.update.reason?.trim();
  return reason ? `${base}（理由：${clampReason(reason)}）` : base;
}

/** 確認文へ入れる理由の長さ。長いと一覧が読めなくなる */
const REASON_PREVIEW_MAX = 40;

function clampReason(reason: string): string {
  const oneLine = reason.replace(/\s+/g, " ").trim();
  return oneLine.length > REASON_PREVIEW_MAX
    ? `${oneLine.slice(0, REASON_PREVIEW_MAX)}…`
    : oneLine;
}

/**
 * 承認された1件を台帳へ入れる。
 *
 * **新規案のIDは、ここで採る。** 積んだ時点の番号を使うと、承認までの
 * あいだに別の操作（抽出・分割）が同じ番号を使っていることがある。
 * `known` には台帳の全員とこの操作で作ったぶんを入れておき、続けて
 * 承認したときに同じ番号を二度使わないようにする。
 *
 * **`save` を直に呼ばない。** `saveOrUpdate` は既知のIDなら退避つきの
 * 書き換え、未知なら新規作成へ振り分ける（`atomicWrite` の約束）。
 */
async function applyItem(
  item: ReviewItem,
  characterStore: CharacterStore,
  known: Character[],
  /**
   * 実際に書き込むレコード。
   *
   * 既定は更新案そのままだが、作者が画面で葉に ✕ を付けた場合は
   * その分を落としたものが渡る（設計書6.32）。**承認待ちのファイルは
   * 触らない**ので、落とした形はここへ引数で来る。
   */
  character: Character = item.update.character
): Promise<void> {
  if (!isCreation(item)) {
    await characterStore.saveOrUpdate(character);
    return;
  }
  const created: Character = {
    ...character,
    id: nextCharacterId(known),
  };
  await characterStore.saveOrUpdate(created);
  known.push(created);
}

/**
 * 承認待ちの更新を読み、確認できる形に組む（設計書6.32）。
 *
 * **開いたときにも「更新分を反映」からも、ここを通す**（0.45.0）。以前は
 * この組み立てが `applyPendingCharacterUpdates` の中にしか無く、
 * **押して初めて提案パネルへ入る**形だった。そのため、ツリーの印が
 * 「未反映の更新 37件」と言っているのにパネルは「まだ検知結果が
 * ありません」と出て、印を見て開いた作者には消えたように読めた
 * （実機、2026-09-11）。写しを作ると片方だけ直る形になるので、切り出す。
 *
 * **ここでは何も書かない。** 古くなった案の片付け（`discard`）は
 * 呼び出し側が決める——開いただけでファイルを消してはいけない。
 */
export interface PendingUpdateReview {
  /** 作者の確認が要る更新案 */
  items: ReviewItem[];
  /** 反映の要らなくなった案（対象が消えた・差分が無い・同名が既にいる） */
  stale: PendingUpdate[];
  /** 承認待ちのファイル数。**「0件」と「全部片付いた」を区別する**ために持つ */
  totalPending: number;
  /** 読めなかった更新案 */
  pendingErrors: Array<{ file: string; message: string }>;
  /**
   * 読めなかった人物設定。
   *
   * **1件でもあれば組み立てない。** 差分の相手が欠けたまま並べると、
   * 更新のはずの案が「新しく作る」に見える
   */
  characterErrors: Array<{ file: string; message: string }>;
  characterStore: CharacterStore;
  pendingStore: PendingUpdateStore;
  /** 新規案の採番に使う顔ぶれ。**承認するたびに増やす** */
  known: Character[];
}

export async function reviewPendingCharacterUpdates(
  work: WorkEntry
): Promise<PendingUpdateReview> {
  const pendingStore = new PendingUpdateStore(work);
  const characterStore = new CharacterStore(work);

  const pending = await pendingStore.loadAll();
  const review: PendingUpdateReview = {
    items: [],
    stale: [],
    totalPending: pending.updates.length,
    pendingErrors: pending.errors,
    characterErrors: [],
    characterStore,
    pendingStore,
    known: [],
  };
  if (pending.updates.length === 0) return review;

  const loaded = await characterStore.loadAll();
  review.characterErrors = loaded.errors;
  if (loaded.errors.length > 0) return review;

  // 作者が足した項目の変化も差分に出す。出さないと、
  // 気付かないうちに書き換わることになる
  const customFields = await new CustomFieldStore(work).loadFields();

  const byId = new Map(loaded.characters.map((c) => [c.id, c]));
  review.known = [...loaded.characters];

  for (const update of pending.updates) {
    // **新規案は、居ないことの判定より先に分ける**（設計書6.4.9）。
    // 台帳に居ないのが当たり前なので、更新案の規則（居なければ片付ける）を
    // そのまま当てると、確認される前に必ず消える
    if (update.kind === "creation") {
      // 積んだあとに同じ名前の人物が資料へ増えていたら、作らない。
      // 二重に作ると、次の抽出で「同じかもしれません」と言われ続ける
      if (
        findCharactersByAppellation(loaded.characters, update.character.name)
          .length > 0
      ) {
        review.stale.push(update);
        continue;
      }
      review.items.push({
        update,
        current: undefined,
        // 何が入るのかを、更新案と同じ並びで見せる。
        // 比べる相手は空のレコード（すべてが「追加」になる）
        diff: diffCharacter(
          emptyCharacter(update.character.id, ""),
          update.character,
          customFields
        ),
      });
      continue;
    }

    const current = byId.get(update.character.id);
    if (!current) {
      // 対象が消えている（まとめた・削除した）。反映しても復活させるだけ
      review.stale.push(update);
      continue;
    }
    const diff = diffCharacter(current, update.character, customFields);
    if (diff.changes.length === 0) {
      review.stale.push(update);
      continue;
    }
    review.items.push({ update, current, diff });
  }

  return review;
}

/**
 * 提案パネルへ出す形へ組み替える（設計書6.32）。
 *
 * **表示の組み立ては、ここだけが持つ。** 開いたときの読み込みと
 * 「更新分を反映」で見え方が違ってはいけない。
 */
export function recordUpdateViewItems(
  review: PendingUpdateReview
): RecordUpdateViewItem[] {
  return review.items.map((item) => ({
    id: item.update.filePath,
    name: item.diff.name,
    // **何がどう変わるかを全部並べる。** 折り畳むと読まずに押される
    changes: diffLinesForPanel(item.diff),
    // 違うところだけを塗れるよう、項目ごとに分けても渡す
    changeParts: item.diff.changes.map((change) => {
      const before = change.before || "（未設定）";
      const after = change.after || "（未設定）";
      return {
        label: change.label,
        before,
        after,
        diff: diffChars(before, after),
        // 呼称・関係・別名は、1つずつ落とせる形でも渡す（設計書6.32）
        entries: change.entries,
      };
    }),
    source: describeChange(item),
    // 出どころの印（まとめて承認はこれで見分ける。設計書6.87.18）
    ...(item.update.source ? { origin: item.update.source } : {}),
    status: "pending" as const,
  }));
}

/**
 * 人物以外（能力・組織・場所・世界観）の更新案の1件（作者の裁定、2026-09-23 問11 B）。
 *
 * `merged` は**いまの台帳のレコードへ、コードで取り込んだ結果**である
 * （`mergePendingSettingsRecord`）。更新案をそのまま保存すると、積んでから
 * 承認までに作者が書いたものを古い写しで巻き戻すため。
 */
interface SettingsReviewItem {
  update: PendingSettingsUpdate;
  current: PendingSettingsRecord;
  merged: PendingSettingsRecord;
  diff: CharacterDiff;
}

/** 種類ごとの台帳の読み書き。`SettingsStore<T>` の型の違いをここで吸収する */
interface SettingsLedger {
  loadAll(): Promise<{
    records: PendingSettingsRecord[];
    errors: Array<{ file: string; message: string }>;
  }>;
  save(record: PendingSettingsRecord): Promise<void>;
}

/**
 * 台帳を開く。**書き込みは `SettingsStore.saveAll` を通す**——読み込み時の
 * ハッシュと照らし、読んだあとに外（作者・他のツール）で書き換えられて
 * いたら保存しない（`assertSaveAllowed`。CLAUDE.md 規則2の①の経路）。
 */
function openLedger(work: WorkEntry, kind: PendingSettingsKind): SettingsLedger {
  switch (kind) {
    case "ability": {
      const store = createAbilityStore(work);
      return {
        loadAll: () => store.loadAll(),
        save: (record) => store.saveAll([record as Ability]),
      };
    }
    case "organization": {
      const store = createOrganizationStore(work);
      return {
        loadAll: () => store.loadAll(),
        save: (record) => store.saveAll([record as Organization]),
      };
    }
    case "location": {
      const store = createLocationStore(work);
      return {
        loadAll: () => store.loadAll(),
        save: (record) => store.saveAll([record as Location]),
      };
    }
    case "world": {
      const store = createWorldStore(work);
      return {
        loadAll: () => store.loadAll(),
        save: (record) => store.saveAll([record as WorldItem]),
      };
    }
  }
}

export interface PendingSettingsReview {
  items: SettingsReviewItem[];
  /** 反映の要らなくなった案（対象が消えた・取り込んでも何も変わらない） */
  stale: PendingSettingsUpdate[];
  totalPending: number;
  /** 読めなかった更新案。**消さない**（壊れたJSONは直さない） */
  pendingErrors: Array<{ file: string; message: string }>;
  /**
   * 読めなかった台帳のファイル。
   *
   * **その種類の案は組み立てず、片付けもしない。** 差分の相手が欠けたまま
   * 並べると、居るはずの場所が「消えた」と読まれて案が捨てられる
   * （人物で「1件でもあれば組み立てない」としているのと同じ理由）
   */
  ledgerErrors: Array<{ kind: PendingSettingsKind; file: string; message: string }>;
  ledgers: Partial<Record<PendingSettingsKind, SettingsLedger>>;
  pendingStore: PendingSettingsUpdateStore;
}

/**
 * 人物以外の承認待ちを読み、確認できる形に組む。
 *
 * **ここでは何も書かない。** 片付け（`discard`）は呼び出し側が決める
 * （開いただけでファイルを消してはいけない。人物の `reviewPendingCharacterUpdates` と同じ）。
 */
export async function reviewPendingSettingsUpdates(
  work: WorkEntry
): Promise<PendingSettingsReview> {
  const pendingStore = new PendingSettingsUpdateStore(work);
  const pending = await pendingStore.loadAll();
  const review: PendingSettingsReview = {
    items: [],
    stale: [],
    totalPending: pending.updates.length,
    pendingErrors: pending.errors,
    ledgerErrors: [],
    ledgers: {},
    pendingStore,
  };
  if (pending.updates.length === 0) return review;

  // 追加項目の見出し。読めなくても差分はキーで出せるので、止めない
  const customFields = await new CustomFieldStore(work).loadOrEmpty();

  const kinds = [...new Set(pending.updates.map((update) => update.recordKind))];
  const byKind = new Map<PendingSettingsKind, Map<string, PendingSettingsRecord>>();
  for (const kind of kinds) {
    const ledger = openLedger(work, kind);
    const loaded = await ledger.loadAll();
    if (loaded.errors.length > 0) {
      review.ledgerErrors.push(
        ...loaded.errors.map((error) => ({ kind, ...error }))
      );
      continue;
    }
    review.ledgers[kind] = ledger;
    byKind.set(kind, new Map(loaded.records.map((record) => [record.id, record])));
  }

  for (const update of pending.updates) {
    const records = byKind.get(update.recordKind);
    // 台帳が読めなかった種類は、組み立てず片付けもしない（上の ledgerErrors を参照）
    if (!records) continue;
    const current = records.get(update.record.id);
    if (!current) {
      // 対象が消えている（取り下げた・まとめた）。反映しても復活させるだけ
      review.stale.push(update);
      continue;
    }
    const merged = mergePendingSettingsRecord(
      update.recordKind,
      current,
      update.record
    );
    const diff = diffSettingsRecord(
      update.recordKind,
      current,
      merged,
      fieldsFor(customFields, update.recordKind)
    );
    if (diff.changes.length === 0) {
      review.stale.push(update);
      continue;
    }
    review.items.push({ update, current, merged, diff });
  }

  return review;
}

/** 人物以外の案の出どころの一行。種類を先に出す（人物と取り違えないため） */
function describeSettingsChange(item: SettingsReviewItem): string {
  const kind = PENDING_KIND_SHORT_LABELS[item.update.recordKind];
  const label = pendingSourceLabel(item.update.source);
  const base = `${label ? `${kind}・${label}` : kind}：${summarizeDiff(item.diff)}`;
  const reason = item.update.reason?.trim();
  return reason ? `${base}（理由：${clampReason(reason)}）` : base;
}

/** 提案パネルへ出す形（人物の `recordUpdateViewItems` と同じ組み立て） */
export function settingsUpdateViewItems(
  review: PendingSettingsReview
): RecordUpdateViewItem[] {
  return review.items.map((item) => ({
    id: item.update.filePath,
    name: item.diff.name,
    changes: diffLinesForPanel(item.diff),
    changeParts: item.diff.changes.map((change) => {
      const before = change.before || "（未設定）";
      const after = change.after || "（未設定）";
      return { label: change.label, before, after, diff: diffChars(before, after) };
    }),
    source: describeSettingsChange(item),
    ...(item.update.source ? { origin: item.update.source } : {}),
    status: "pending" as const,
  }));
}

/**
 * 反映の対象1件。人物の案と人物以外の案を、同じ手順で扱うための形。
 *
 * **保存の約束は作る側（下の2つの関数）が持つ。** パネルと確認の
 * ダイアログは、どの台帳へどう書くかを知らなくてよい。
 */
interface ApplyTarget {
  id: string;
  name: string;
  diff: CharacterDiff;
  change: string;
  source?: PendingUpdateSource;
  reason?: string;
  /** 反映する。落とした葉の数を返す（人物だけ。ほかは常に0） */
  apply: (dropKeys: string[]) => Promise<number>;
  /** 見送る（承認待ちから片付ける。レコードには触らない） */
  discard: () => Promise<void>;
}

function characterTargets(review: PendingUpdateReview): ApplyTarget[] {
  return review.items.map((item) => ({
    id: item.update.filePath,
    name: item.diff.name,
    diff: item.diff,
    change: describeChange(item),
    source: item.update.source,
    reason: item.update.reason,
    apply: async (dropKeys) => {
      // **作者が ✕ を付けた葉は、保存の直前に落とす**（設計書6.32）。
      // 承認待ちのファイルは書き換えない——印はその1回の反映にだけ効く
      const { character, dropped } = dropDiffEntries(
        item.update.character,
        dropKeys
      );
      // 既存ファイルは上書きできないので saveOrUpdate を通す
      // （新規案はここでIDを採る。`applyItem` を参照）
      await applyItem(item, review.characterStore, review.known, character);
      await review.pendingStore.discard(item.update.filePath);
      return dropped;
    },
    discard: () => review.pendingStore.discard(item.update.filePath),
  }));
}

function settingsTargets(review: PendingSettingsReview): ApplyTarget[] {
  return review.items.map((item) => ({
    id: item.update.filePath,
    name: item.diff.name,
    diff: item.diff,
    change: describeSettingsChange(item),
    source: item.update.source,
    reason: item.update.reason,
    apply: async () => {
      const ledger = review.ledgers[item.update.recordKind];
      if (!ledger) throw new Error("台帳を開けませんでした。読み込み直してください。");
      // 取り込み済みのレコードを書く。読んだあとに作者が書き換えていたら
      // `SettingsStore` のハッシュ照合で止まり、承認待ちは残る
      await ledger.save(item.merged);
      await review.pendingStore.discard(item.update.filePath);
      return 0;
    },
    discard: () => review.pendingStore.discard(item.update.filePath),
  }));
}

/**
 * 組んだ更新案を提案パネルへ渡す。
 *
 * **反映と見送りの手順もここで作る。** パネルは保存の約束（既存ファイルは
 * 上書きできない・新規案はここで採番する・人物以外は取り込み済みを書く）を知らなくてよい。
 */
function showInPanel(
  review: PendingUpdateReview,
  settingsReview: PendingSettingsReview,
  work: WorkEntry,
  panel: ProposalPanel,
  options: { quiet?: boolean } = {}
): void {
  const targets = [...characterTargets(review), ...settingsTargets(settingsReview)];
  const find = (id: string): ApplyTarget | undefined =>
    targets.find((target) => target.id === id);

  panel.showRecordUpdates(
    work,
    [...recordUpdateViewItems(review), ...settingsUpdateViewItems(settingsReview)],
    async (id, dropKeys) => {
      const target = find(id);
      if (!target) return { ok: false, reason: "対象が見つかりません。" };
      try {
        const dropped = await target.apply(dropKeys ?? []);
        // **黙って落としたことにしない**（CLAUDE.md 規則2）。
        // 何件が入らなかったのかを、その場で伝える
        if (dropped > 0) {
          void vscode.window.showInformationMessage(
            `${target.name}：${dropped} 件を落として反映しました。`
          );
        }
        // まとめて適用の完了の知らせが、合計を出せるように返す
        return { ok: true, dropped };
      } catch (error) {
        const message = errorText(error);
        // **記録の直前に書き先を向ける**（0.43.3 と同じ）。向けないと
        // 出力チャンネル止まりで、VS Code を閉じると消える
        useLogFile(work.folderPath);
        logFailure("更新の反映に失敗", {
          対象: target.name,
          詳細: message,
        });
        return { ok: false, reason: message };
      }
    },
    // 見送る＝承認待ちから片付ける（レコードには触らない）。
    // これを渡していなかったころ、「見送る」は押しても黙って何も
    // 起きなかった（作者の報告、2026-08-28）
    async (id) => {
      const target = find(id);
      if (!target) return { ok: false, reason: "対象が見つかりません。" };
      try {
        await target.discard();
        return { ok: true };
      } catch (error) {
        const message = errorText(error);
        useLogFile(work.folderPath);
        logFailure("更新の見送りに失敗", {
          対象: target.name,
          詳細: message,
        });
        return { ok: false, reason: message };
      }
    },
    undefined,
    options
  );
}

function errorText(error: unknown): string {
  return error instanceof CharacterStoreError
    ? error.message
    : error instanceof Error
      ? error.message
      : String(error);
}

/**
 * 溜まっている承認待ちを、提案パネルへ出しておく（0.45.0）。
 *
 * **開いたときに呼ぶ。** 「更新分を反映」を押して初めて出るのでは、
 * ツリーの印（未反映の更新 37件）を見て開いた作者に「消えた」と読める。
 *
 * **画面は奪わないし、知らせも出さない。** 作者が自分で開いた場面なので、
 * 前へ出す必要も「届きました」と言う必要もない。**溜まりが無ければ
 * 何もしない**——今までどおり「まだ検知結果がありません」のままにする。
 * 読めない資料があるときも黙って何もしない（開いただけの場面で
 * 断りのダイアログを出しても、作者には脈絡が無い）。
 *
 * @returns パネルへ出した件数
 */
export async function primePendingRecordUpdates(
  work: WorkEntry,
  panel: ProposalPanel
): Promise<number> {
  const review = await reviewPendingCharacterUpdates(work);
  const settingsReview = await reviewPendingSettingsUpdates(work);
  const count = review.items.length + settingsReview.items.length;
  if (count === 0) return 0;
  showInPanel(review, settingsReview, work, panel, { quiet: true });
  return count;
}

/**
 * 承認待ちの更新を確かめて反映する（「更新分を反映」）。
 *
 * **人物以外の案も同じ流れで出す**（作者の裁定、2026-09-23 問11 B）。
 * 名前は人物だけだったころのまま（呼び出し元が多いため）。
 */
export async function applyPendingCharacterUpdates(
  work: WorkEntry,
  /**
   * 提案パネル。**渡されたらそちらへ出す**（設計書5.6）。
   *
   * 作者への提案の窓口を1つにする。本文の直しは提案パネル、設定資料の
   * 更新は別のダイアログ、では**片方を見落とす。**
   */
  panel?: ProposalPanel
): Promise<void> {
  useLogFile(work.folderPath);
  const review = await reviewPendingCharacterUpdates(work);
  const settingsReview = await reviewPendingSettingsUpdates(work);
  const { pendingStore } = review;

  const pendingErrors = [...review.pendingErrors, ...settingsReview.pendingErrors];
  if (pendingErrors.length > 0) {
    await vscode.window.showWarningMessage(
      `読み込めない更新案が ${pendingErrors.length} 件あります（${pendingErrors
        .map((error) => error.file)
        .join("、")}）。残りだけを扱います。`
    );
  }
  if (review.totalPending + settingsReview.totalPending === 0) {
    vscode.window.showInformationMessage("反映待ちの更新はありません。");
    return;
  }

  // 人物設定が読めないときは、人物の案は組み立てていない（差分の相手が欠ける）。
  // **人物以外の案が無ければ、これまでどおりここで止める**
  const characterBlocked = review.characterErrors.length > 0;
  if (characterBlocked) {
    const files = review.characterErrors.map((error) => error.file).join("、");
    if (settingsReview.totalPending === 0) {
      await vscode.window.showErrorMessage(
        "読み込めない人物設定があるため、反映を中止しました。" + `（${files}）`
      );
      return;
    }
    await vscode.window.showErrorMessage(
      "読み込めない人物設定があるため、人物の更新は見合わせました。" + `（${files}）`
    );
  }
  if (settingsReview.ledgerErrors.length > 0) {
    const kinds = [
      ...new Set(
        settingsReview.ledgerErrors.map(
          (error) => PENDING_KIND_SHORT_LABELS[error.kind]
        )
      ),
    ].join("・");
    await vscode.window.showWarningMessage(
      `読み込めない設定資料があるため、${kinds}の更新は見合わせました。` +
        `（${settingsReview.ledgerErrors.map((error) => error.file).join("、")}）` +
        "ファイルを直してから、もう一度お試しください。"
    );
  }

  for (const stale of review.stale) {
    await pendingStore.discard(stale.filePath);
  }
  for (const stale of settingsReview.stale) {
    await settingsReview.pendingStore.discard(stale.filePath);
  }

  const targets = [...characterTargets(review), ...settingsTargets(settingsReview)];
  if (targets.length === 0) {
    vscode.window.showInformationMessage(
      "反映が必要な更新はありませんでした。古い更新案は片付けました。"
    );
    return;
  }

  // **提案の窓口を1つにする**（設計書5.6）。本文の直しは提案パネル、
  // 設定資料の更新は別のダイアログ、では作者が片方を見落とす。
  // **組み立ては開いたときと同じものを通す**（0.45.0。写しを作らない）
  if (panel) {
    showInPanel(review, settingsReview, work, panel);
    return;
  }

  // 人物だけなら「人」、場所などが混じれば「件」で数える
  const unit = settingsReview.items.length > 0 ? "件" : "人";
  const choice = await vscode.window.showInformationMessage(
    describePendingUpdatesConfirm(
      targets.map((target) => ({ name: target.name, change: target.change })),
      unit
    ),
    { modal: true },
    "内容を確認",
    "すべて反映",
    "選んで反映"
  );

  if (choice === "内容を確認") {
    await showDiffDocument(work, targets);
    return;
  }

  let chosen: ApplyTarget[];
  if (choice === "すべて反映") {
    chosen = targets;
  } else if (choice === "選んで反映") {
    const picked = await vscode.window.showQuickPick(
      targets.map((target) => ({
        label: target.name,
        description: target.change,
        picked: true,
        target,
      })),
      {
        title:
          unit === "人"
            ? "反映する人物を選んでください"
            : "反映するものを選んでください",
        canPickMany: true,
        ignoreFocusOut: true,
      }
    );
    if (!picked || picked.length === 0) return;
    chosen = picked.map((entry) => entry.target);
  } else {
    return;
  }

  await applyAll(chosen, unit, work.folderPath);
}

async function applyAll(
  targets: ApplyTarget[],
  unit: "人" | "件",
  /** 失敗の記録の書き先（作品フォルダー） */
  workFolder: string
): Promise<void> {
  const applied: string[] = [];
  const failed: Array<{ name: string; message: string }> = [];

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "更新を反映しています" },
    async (progress) => {
      for (const [index, target] of targets.entries()) {
        progress.report({
          message: `${index + 1}/${targets.length} ${target.name}`,
        });
        try {
          await target.apply([]);
          applied.push(target.name);
        } catch (error) {
          // 1件の失敗で全体を止めない。何が反映できなかったかを最後にまとめて出す
          const message = errorText(error);
          logFailure("更新の反映に失敗", {
            対象: target.name,
            詳細: message,
          });
          failed.push({ name: target.name, message });
        }
      }
    }
  );

  if (failed.length === 0) {
    vscode.window.showInformationMessage(
      `${applied.length} ${unit}の設定を更新しました。` +
        "「設定資料集出力」を実行すると一覧にも反映されます。"
    );
    return;
  }

  // **「詳細を表示」が押されるのを待たない**（ノートPCの実機、2026-09-23。
  // 抽出の完了の知らせと同じ直し）。待つと、知らせを閉じるまで
  // 「更新分を反映」の「動いている」札を持ったままになる
  whenNoticePicked(
    vscode.window.showWarningMessage(
      `${applied.length} ${unit}を更新し、${failed.length} ${unit}は反映できませんでした。` +
        "反映できなかった更新案は残してあります。",
      "詳細を表示"
    ),
    async (action) => {
      if (action !== "詳細を表示") return;
      const document = await vscode.workspace.openTextDocument({
        content: failed
          .map((entry) => `${entry.name}: ${entry.message}`)
          .join("\n"),
        language: "text",
      });
      await vscode.window.showTextDocument(document);
    },
    { label: "更新分の反映", workFolder }
  );
}

/** 何が変わるのかを読める形で出す。JSONを見比べさせない */
async function showDiffDocument(
  work: WorkEntry,
  targets: ApplyTarget[]
): Promise<void> {
  const content = [
    "# 反映待ちの更新",
    "",
    "この内容はまだ保存されていません。",
    "確認したら「人物重複統合」の隣の「設定資料更新分反映」から実行してください。",
    "",
    // 出どころは名前の見出しの直後に置く（設計書6.4.9）。
    // どこから来た提案かは、中身より先に知りたい
    ...targets.map((target) => {
      const label = pendingSourceLabel(target.source);
      // 理由（設計書6.87.16）は**切らずに全部出す**。確認のダイアログは
      // 1行しか出せないので、判断の材料はこちらで読ませる
      const reason = target.reason?.trim();
      const body = formatDiff(target.diff);
      if (!label && !reason) return body;
      const [heading, ...rest] = body.split("\n");
      const notes: string[] = [];
      if (label) notes.push(`出どころ: ${label}`);
      if (reason) notes.push(`提案の理由: ${reason}`);
      return [heading, "", ...notes, ...rest].join("\n");
    }),
  ].join("\n");

  // **どの画面で読むかは作者が決める。** 前は開いた直後に
  // `markdown.showPreview` を呼んでプレビューへ切り替えていたが、
  // それは作者が既定にした画面（Markdown編集画面など）を押しのける。
  // 作者の報告「反映待ちの更新がデフォルトで開きません」（2026-08-27）。
  // 作品に属する読み物なので、作品の中へ置く（設計書6.17.7）
  await openGeneratedMarkdown(
    "反映待ちの更新",
    content,
    { preview: false },
    { work }
  );
}
