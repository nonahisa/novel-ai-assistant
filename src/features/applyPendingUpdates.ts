import * as vscode from "vscode";
import { WorkEntry } from "../models/types";
import { nextCharacterId, type Character } from "../models/character";
import { CharacterStore, CharacterStoreError } from "../core/characterStore";
import {
  PendingUpdateStore,
  pendingSourceLabel,
  type PendingUpdate,
} from "../core/pendingUpdates";
import {
  diffLinesForPanel,
  formatDiff,
  type CharacterDiff,
} from "../core/characterDiff";
import { diffChars } from "../core/inlineDiff";
import { dropDiffEntries } from "../core/dropDiffEntries";
import { recordRemovedRelations } from "../core/rejectedRelations";
import { CustomFieldStore } from "../core/customFieldStore";
import {
  PendingSettingsUpdateStore,
  type PendingSettingsUpdate,
} from "../core/pendingSettingsUpdates";
import {
  PENDING_KIND_SHORT_LABELS,
  type PendingSettingsKind,
  type PendingSettingsRecord,
} from "../core/pendingSettingsMerge";
/*
  **組み立て（どれを見せ、どれを古い案として片付けるか）と一行の説明は
  `core/pendingReview.ts` が持つ**（0.85.1）。MCP の `pending.list` が
  同じ関数を通るので、画面と外から読めるものがずれない。ここに残るのは
  ファイルの読み書きと、画面・確認の出し方だけ。
*/
import {
  assembleCharacterReview,
  assembleSettingsReview,
  describeCharacterReviewItem,
  describeSettingsReviewItem,
  type CharacterReviewItem,
  type SettingsReviewItem,
} from "../core/pendingReview";
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
import { logFailure, logLine, useLogFile } from "../core/logger";
import {
  describeNarratorMoveReviewItem,
  narratorMoveValueForLog,
} from "../core/pendingNarratorMoves";
import {
  applyPendingNarratorMove,
  describeDiscardedUpdatesNotice,
  dismissPendingNarratorMove,
  narratorMoveViewItems,
  reviewPendingNarratorMoves,
  type NarratorMoveApplied,
  type PendingNarratorMoveReview,
} from "./narratorMovePending";
import {
  describeNarratorMoveLog,
  describeRecordUpdateBatchLog,
  describeRecordUpdateLog,
  describeUpdatesDiscardedByMoveLog,
  type RecordUpdateVerdict,
  type RecordUpdateVia,
} from "../core/recordUpdateLog";
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

type ReviewItem = CharacterReviewItem;

/** その案が「新しく作る」ものか（設計書6.4.9） */
function isCreation(item: ReviewItem): boolean {
  return item.update.kind === "creation";
}

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

/**
 * 何が変わるかの要約に、出どころを添える（設計書6.4.9）。
 *
 * **AIが本文から読んだものと、作者がプロットへ書いたものは別物である。**
 * 同じ「紹介を変更」でも、承認するときの見方が変わる。文の組み立ては
 * `core/pendingReview.ts`（MCP の `pending.list` も同じ文を返す）。
 */
const describeChange = describeCharacterReviewItem;

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

  review.known = [...loaded.characters];
  // **分け方は core に1つだけ**（MCP の `pending.list` と同じものを通す）
  const assembled = assembleCharacterReview(
    pending.updates,
    loaded.characters,
    customFields
  );
  review.items = assembled.items;
  review.stale = assembled.stale;

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
  const byKind = new Map<PendingSettingsKind, PendingSettingsRecord[]>();
  for (const kind of kinds) {
    const ledger = openLedger(work, kind);
    const loaded = await ledger.loadAll();
    if (loaded.errors.length > 0) {
      // 台帳が読めなかった種類は `byKind` に入れない＝組み立てず片付けもしない
      review.ledgerErrors.push(
        ...loaded.errors.map((error) => ({ kind, ...error }))
      );
      continue;
    }
    review.ledgers[kind] = ledger;
    byKind.set(kind, loaded.records);
  }

  // **分け方は core に1つだけ**（MCP の `pending.list` と同じものを通す）
  const assembled = assembleSettingsReview(pending.updates, byKind, customFields);
  review.items = assembled.items;
  review.stale = assembled.stale;

  return review;
}

/** 人物以外の案の出どころの一行。種類を先に出す（組み立ては core） */
const describeSettingsChange = describeSettingsReviewItem;

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
  /** 何がどう変わるか。**移す案は持たない**（書き換え後の姿を反映のときに組むため） */
  diff?: CharacterDiff;
  change: string;
  source?: PendingUpdateSource;
  reason?: string;
  /** 種類の短い呼び名（人物・能力・組織・場所・世界観）。動作の記録に使う */
  kindLabel: string;
  /** 新しく作る案か（動作の記録で「新規作成」と言う） */
  creation: boolean;
  /** 反映する。落とした葉の数を返す（人物だけ。ほかは常に0） */
  apply: (dropKeys: string[]) => Promise<number>;
  /** 見送る（承認待ちから片付ける。レコードには触らない） */
  discard: () => Promise<void>;
  /**
   * ログの1行を自分で組む（移す案だけ。差分を持たないので
   * `describeRecordUpdateLog` を通せない。`describeNarratorMoveLog`）
   */
  logLineOf?: (verdict: RecordUpdateVerdict, via: RecordUpdateVia) => string;
  /**
   * 反映の行のあとに続けて残す行（移す案で、古くなった更新案を片づけたとき。0.102.4）
   */
  followUpLogLines?: (via: RecordUpdateVia) => string[];
  /**
   * 移し先を作者が選ばないと反映できない移す案か（名指しできなかった案）。
   * 確認ダイアログの道は選ぶ画面を持たないので、反映へ回さず数を分けて言う（0.102.4）
   */
  needsChoice?: boolean;
  /** 差分を持たない案の説明（「内容を確認」の文書に出す） */
  detail?: string[];
}

/**
 * 移す案（語り手の取り違えで主人公に入った値。設計書6.5.12、0.102.3）の反映の口。
 *
 * **移し先を選ぶのは提案パネルの行**（`moveChoice`）。選びは ✕ の印と同じ
 * 鍵の並びで届く（`destinationFromKeys`）。確認ダイアログの道（「すべて反映」）は
 * 選ぶ画面を持たないので、名指しできた案は既定の移し先へ、選ぶ案は
 * 「移し先を選んでください」で失敗として残る（承認待ちは消えない）。
 */
function moveTargets(work: WorkEntry, review: PendingNarratorMoveReview): ApplyTarget[] {
  return review.items.map((item) => {
    const view = describeNarratorMoveReviewItem(item);
    const value = narratorMoveValueForLog(item.move.item);
    let applied: NarratorMoveApplied | undefined;
    return {
      id: item.move.filePath,
      name: item.source.name,
      change: view.source,
      detail: view.changes,
      kindLabel: PENDING_KIND_SHORT_LABELS.character,
      creation: false,
      needsChoice: item.defaultId === null,
      apply: async (dropKeys) => {
        applied = await applyPendingNarratorMove(work, item, dropKeys, review.store);
        // 移し先の値を上書きしなかったことは黙らない（`applyNarratorMoves` の notes）
        if (applied.notes.length > 0) {
          void vscode.window.showInformationMessage(applied.notes.join(""));
        }
        // 古くなった更新案を片づけたことも黙らない（0.102.4）
        const discarded = describeDiscardedUpdatesNotice(applied.discardedUpdates);
        if (discarded) void vscode.window.showInformationMessage(discarded);
        return 0;
      },
      discard: () => dismissPendingNarratorMove(work, item, review.store),
      logLineOf: (verdict, via) =>
        describeNarratorMoveLog({
          verdict,
          sourceName: applied?.sourceName ?? item.source.name,
          value,
          destinationName: applied?.destinationName ?? null,
          via,
          keptNotes: applied?.notes.length ?? 0,
        }),
      followUpLogLines: (via) =>
        applied && applied.discardedUpdates.length > 0
          ? [describeUpdatesDiscardedByMoveLog({ names: applied.discardedUpdates, via })]
          : [],
    };
  });
}

function characterTargets(review: PendingUpdateReview): ApplyTarget[] {
  return review.items.map((item) => ({
    id: item.update.filePath,
    name: item.diff.name,
    diff: item.diff,
    change: describeChange(item),
    source: item.update.source,
    reason: item.update.reason,
    kindLabel: PENDING_KIND_SHORT_LABELS.character,
    creation: isCreation(item),
    apply: async (dropKeys) => {
      // **作者が ✕ を付けた葉は、保存の直前に落とす**（設計書6.32）。
      // 承認待ちのファイルは書き換えない——印はその1回の反映にだけ効く
      const { character, dropped } = dropDiffEntries(
        item.update.character,
        dropKeys
      );
      // **この承認で消える関係は「退けた関係」として残す**（作者の裁定、
      // 2026-09-23）。外部AIの提案で「ターナ=父の娘」を「ターナ=母」に
      // 直しても、人物が autoGenerated: true のままだと、次の抽出が
      // 「父の娘」をまた足す。消えるのが確定するのは作者が採ったこの時点
      const settled: Character = item.current
        ? {
            ...character,
            rejectedRelations: recordRemovedRelations({
              before: item.current.relations,
              after: character.relations,
              rejected: item.current.rejectedRelations,
              characters: review.known,
              // 出どころの無い更新案は抽出（`PendingUpdateSource` の約束）
              via: item.update.source ?? "extraction",
              now: new Date().toISOString(),
            }),
          }
        : character;
      // **書く前に、承認待ちのファイルがまだあるかを確かめる**（0.102.4）。
      // パネルは開いたときの写しを持つので、同じパネルで先に移す案を反映して
      // 片づいた更新案も、行は残る。写しを書くと、移した値が戻る
      if (!(await review.pendingStore.exists(item.update.filePath))) {
        throw new Error(
          "この更新案は、別の操作（移す案の反映など）で古くなったため片づけました。" +
            "提案パネルを開き直してください。もう一度「設定資料を抽出」すると作り直されます。"
        );
      }
      // 既存ファイルは上書きできないので saveOrUpdate を通す
      // （新規案はここでIDを採る。`applyItem` を参照）
      await applyItem(item, review.characterStore, review.known, settled);
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
    kindLabel: PENDING_KIND_SHORT_LABELS[item.update.recordKind],
    creation: false,
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
 * 反映・見送りを作品のログへ1行残す（0.101.13）。
 *
 * **成功も見送りも残す。** 2026-10-10、抽出の直後に人物6件が提案パネルから
 * 書き換わったのに、`.aiwriter/logs/actions.log` に1行も無く、いつ・どの画面
 * から押したのかが追えなかった。失敗だけは `logFailure` で残っていた。
 *
 * **記録の直前に書き先を向ける**（0.43.3 と同じ）。パネルの「反映する」は
 * 押されるまで間があり、そのあいだにほかの機能が別の作品へ向け直している
 * ことがある。
 */
function logVerdict(
  work: WorkEntry,
  target: ApplyTarget,
  verdict: RecordUpdateVerdict,
  via: RecordUpdateVia,
  drop: { dropKeys?: readonly string[]; dropped?: number } = {}
): void {
  useLogFile(work.folderPath);
  if (target.logLineOf || !target.diff) {
    logLine(
      target.logLineOf
        ? target.logLineOf(verdict, via)
        : `設定資料の更新を${verdict === "applied" ? "適用" : "見送り"}：${target.kindLabel}「${target.name}」 ${target.change}（${via}）`
    );
    if (verdict === "applied") {
      for (const line of target.followUpLogLines?.(via) ?? []) logLine(line);
    }
    return;
  }
  logLine(
    describeRecordUpdateLog({
      verdict,
      kindLabel: target.kindLabel,
      name: target.name,
      diff: target.diff,
      via,
      creation: target.creation,
      sourceLabel: pendingSourceLabel(target.source),
      ...drop,
    })
  );
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
  moveReview: PendingNarratorMoveReview,
  work: WorkEntry,
  panel: ProposalPanel,
  options: { quiet?: boolean } = {}
): void {
  const targets = [
    ...characterTargets(review),
    ...settingsTargets(settingsReview),
    ...moveTargets(work, moveReview),
  ];
  const find = (id: string): ApplyTarget | undefined =>
    targets.find((target) => target.id === id);

  panel.showRecordUpdates(
    work,
    [
      ...recordUpdateViewItems(review),
      ...settingsUpdateViewItems(settingsReview),
      // 移す案は人物の更新案のあとに並べる（同じ主人公の更新案と見比べられるように）
      ...narratorMoveViewItems(moveReview),
    ],
    async (id, dropKeys) => {
      const target = find(id);
      if (!target) return { ok: false, reason: "対象が見つかりません。" };
      try {
        const dropped = await target.apply(dropKeys ?? []);
        // 1件ずつでも、まとめて適用・外部AIのまとめての承認でもここを通る。
        // 件数の行はまとめの輪を持つパネル側が書く
        logVerdict(work, target, "applied", "提案パネル", { dropKeys, dropped });
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
        logVerdict(work, target, "dismissed", "提案パネル");
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
  const moveReview = await reviewPendingNarratorMoves(work);
  const count =
    review.items.length + settingsReview.items.length + moveReview.items.length;
  if (count === 0) return 0;
  showInPanel(review, settingsReview, moveReview, work, panel, { quiet: true });
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
  // 移す案（設計書6.5.12、0.102.3）。人物の更新案と同じ「設定資料の更新」に並ぶ
  const moveReview = await reviewPendingNarratorMoves(work);
  const { pendingStore } = review;

  const pendingErrors = [
    ...review.pendingErrors,
    ...settingsReview.pendingErrors,
    ...moveReview.pendingErrors,
  ];
  if (pendingErrors.length > 0) {
    await vscode.window.showWarningMessage(
      `読み込めない更新案が ${pendingErrors.length} 件あります（${pendingErrors
        .map((error) => error.file)
        .join("、")}）。残りだけを扱います。`
    );
  }
  if (
    review.totalPending + settingsReview.totalPending + moveReview.totalPending ===
    0
  ) {
    vscode.window.showInformationMessage("反映待ちの更新はありません。");
    return;
  }

  // 人物設定が読めないときは、人物の案は組み立てていない（差分の相手が欠ける）。
  // **人物以外の案が無ければ、これまでどおりここで止める**
  // （移す案も人物を書き換えるので、人物の案と同じく組み立てていない）
  const characterBlocked =
    review.characterErrors.length > 0 || moveReview.characterErrors.length > 0;
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
  // 主人公が居ない・値がもう無い移す案。**見送りとしては覚えない**
  // （作者が判断したのではない。値がまた入れば、また積まれてよい）
  for (const stale of moveReview.stale) {
    await moveReview.store.discard(stale.filePath);
  }

  const targets = [
    ...characterTargets(review),
    ...settingsTargets(settingsReview),
    ...moveTargets(work, moveReview),
  ];
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
    showInPanel(review, settingsReview, moveReview, work, panel);
    return;
  }

  // 人物だけなら「人」、場所などが混じれば「件」で数える
  // （移す案は1人に何件も並ぶので「件」）
  const unit =
    settingsReview.items.length > 0 || moveReview.items.length > 0 ? "件" : "人";
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

  await applyAll(chosen, unit, work);
}

async function applyAll(
  chosen: ApplyTarget[],
  unit: "人" | "件",
  /** 記録の書き先（作品フォルダー） */
  work: WorkEntry
): Promise<void> {
  const workFolder = work.folderPath;
  // **移し先を選ばないと反映できない移す案は、回さない**（0.102.4）。
  // 回すと「移し先を選んでください」の失敗に数えられ、「反映できなかった」と
  // 区別がつかない。承認待ちは残る（提案パネルで選べる）
  const unchosenMoves = chosen.filter((target) => target.needsChoice).length;
  const targets = chosen.filter((target) => !target.needsChoice);
  const unchosenNote =
    unchosenMoves > 0
      ? `移し先を選んでいない移す案 ${unchosenMoves}件は残しました（提案パネルで移し先を選べます）。`
      : "";
  if (targets.length === 0) {
    vscode.window.showInformationMessage(`反映できる更新がありません。${unchosenNote}`);
    return;
  }
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
          // 提案パネルの道と同じ言い方で残す（`core/recordUpdateLog.ts`）
          logVerdict(work, target, "applied", "確認ダイアログ");
        } catch (error) {
          // 1件の失敗で全体を止めない。何が反映できなかったかを最後にまとめて出す
          const message = errorText(error);
          useLogFile(workFolder);
          logFailure("更新の反映に失敗", {
            対象: target.name,
            詳細: message,
          });
          failed.push({ name: target.name, message });
        }
      }
    }
  );

  // 1件ずつの行のあとに件数の1行（提案パネルの「まとめて適用」と同じ形）
  useLogFile(workFolder);
  logLine(
    describeRecordUpdateBatchLog({
      category: "設定資料の更新",
      verb: "適用",
      applied: applied.length,
      total: targets.length,
      failed: failed.length,
      via: "確認ダイアログ",
    })
  );

  if (failed.length === 0) {
    vscode.window.showInformationMessage(
      `${applied.length} ${unit}の設定を更新しました。` +
        unchosenNote +
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
        "反映できなかった更新案は残してあります。" +
        unchosenNote,
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
      // 差分を持たない案（移す案）は、説明の行をそのまま出す
      if (!target.diff) {
        return [`## ${target.name}`, "", target.change, ...(target.detail ?? []), ""].join("\n");
      }
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
