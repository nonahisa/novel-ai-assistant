import type { Character } from "../models/character";
import { unifyCharacters, type UnifyResult } from "./characterUnify";
import { planDistinctPair, type DistinctPairPlan } from "./characterSeparate";
import type { PendingUpdate } from "./pendingReview";
import type { PendingUpdateKind, PendingUpdateSource } from "./pendingUpdateFormat";

/**
 * 重複の候補（設計書6.5.4）の1組について、作者が決めたことを資料へ書く。
 *
 * - **まとめる**：残す側を退避 → まとめた内容を新規作成 → 取り下げ側を退避
 * - **別人**：2人の `distinctFrom` に互いを足して、それぞれ `saveOrUpdate` で書き直す
 *
 * 詳細メニューの「重複をまとめる」（`features/unifyCharacters.ts`）と、設定資料パネルの
 * 候補の欄（`features/settingsPanel.ts`）の**両方がここを通る**。書く順番や失敗の
 * 伝え方を画面ごとに写すと、片方だけ直す日が来るため（作者の依頼 2026-10-19
 * 「一回ごとにメニューが出るのはツライ」で、入口が2つになった）。
 *
 * 確認の窓は出さない。出すかどうかは呼ぶ側が決める（メニューは警告の窓で訊き、
 * パネルは訊かずに帯で知らせる）。
 *
 * ストアは必要な口だけを受け取る。`CharacterStore` を丸ごと要求すると、
 * 単体テストでファイルを置かないと試せなくなる。
 */

/** まとめるのに使う口（`CharacterStore` の一部） */
export interface UnifyWriter {
  retire(id: string): Promise<string>;
  save(character: Character): Promise<void>;
  /**
   * 読み込んだときの保存先とハッシュ。［戻す］の札（`UnifyUndoTicket`）を作るのに使う。
   * 持たない口（古い呼び出し・単体テストの偽物）なら札を作らない
   */
  snapshotOf?(id: string): { filePath: string; hash: string } | undefined;
}

/**
 * 人物の反映待ち（`.aiwriter/pending-characters/`）を扱う口（`PendingUpdateStore` の一部）。
 *
 * 反映待ちは作者の原稿ではないので、積み直し（上書き）してよい（`PendingUpdateStore.stage`）。
 */
export interface PendingCharacterWriter {
  loadAll(): Promise<{
    updates: PendingUpdate[];
    errors: Array<{ file: string; message: string }>;
  }>;
  stage(
    characters: Character[],
    options?: {
      source?: PendingUpdateSource;
      kind?: PendingUpdateKind;
      reason?: string;
    }
  ): Promise<void>;
  discard(filePath: string): Promise<void>;
}

/** まとめたあとに、反映待ちをどう扱ったか（設計書6.5.4「まとめたあとの反映待ち」） */
export interface PendingAfterUnify {
  /** 取り下げた側の分を捨てた件数 */
  discarded: number;
  /** 残す側の分を、まとめたあとの姿に合わせて積み直した件数 */
  rebased: number;
  /** 読めなかった反映待ちのファイル名。**直さず残す**（規則2） */
  unreadable: string[];
  /** 片づけの途中で失敗したときの文。まとめ自体は成り立っている */
  failure?: string;
  /** 触る前の反映待ち（捨てた分と、寄せる前の分）。［戻す］で積み直す */
  before: PendingUpdate[];
  /** 触ったあとに残した反映待ち（寄せた分）。［戻す］の前に、変わっていないかを見る */
  after: PendingUpdate[];
}

/**
 * まとめた2人の反映待ちを、どう片づけるかを決める（純粋な関数）。
 *
 * - **取り下げた側の分は捨てる。** 台帳に居ない人物の案は、放っておいても確かめる画面で
 *   「対象が消えた」として片づくが、件数を作者へ伝えるためにここで捨てる
 * - **残す側の分は、まとめたあとの姿に合わせる。** 反映待ちは「積んだ時点の人物まるごとの写し」
 *   なので、まとめる前の写しを［確かめて反映］すると、別名・作者メモの併記・登場話が
 *   まとめる前へ巻き戻る（作者の裁定 2026-10-22）。写しを取り下げた側と同じ規則でまとめ直す
 *   （`unifyCharacters`）と、AIが足した分だけが差分に残る。名前・id を指す部分
 *   （呼称の相手・互いを指す別人の記録）も、まとめる操作と同じ規則で残す側へ寄る
 * - 新規案（`kind: "creation"`）は id が仮なので、まとめた2人とは結ばない
 * - ほかの人物の分には触らない
 */
export function planPendingAfterUnify(
  updates: readonly PendingUpdate[],
  keep: Character,
  absorb: Character,
  everyone: readonly Character[]
): {
  discard: PendingUpdate[];
  restage: Array<{ from: PendingUpdate; character: Character }>;
} {
  const discard: PendingUpdate[] = [];
  const restage: Array<{ from: PendingUpdate; character: Character }> = [];
  for (const update of updates) {
    if (update.kind === "creation") continue;
    if (update.character.id === absorb.id) {
      discard.push(update);
      continue;
    }
    if (update.character.id === keep.id) {
      restage.push({
        from: update,
        character: unifyCharacters(update.character, absorb, everyone).unified,
      });
    }
  }
  return { discard, restage };
}

/** 2人のどちらかを指す反映待ち（新規案は id が仮なので含めない） */
export function pendingOfPair(
  updates: readonly PendingUpdate[],
  firstId: string,
  secondId: string
): PendingUpdate[] {
  return updates.filter(
    (update) =>
      update.kind !== "creation" &&
      (update.character.id === firstId || update.character.id === secondId)
  );
}

/** 反映待ちの1件を、出どころ・種別・理由ごと積み直す */
export async function restagePendingUpdate(
  pending: PendingCharacterWriter,
  update: PendingUpdate,
  character: Character = update.character
): Promise<void> {
  await pending.stage([character], {
    // 積み直しの既定（`sourceOf`）に頼らず、元の印を明示して渡す
    ...(update.source ? { source: update.source } : {}),
    ...(update.kind ? { kind: update.kind } : {}),
    ...(update.reason ? { reason: update.reason } : {}),
  });
}

/**
 * 反映待ちを片づける。**失敗しても投げない**——まとめは書き終わっていて、ここで投げると
 * 作者は「まとめられなかった」と読んで、もう一度押してしまう。失敗は件数と文で返す。
 */
async function settlePendingAfterUnify(
  pending: PendingCharacterWriter,
  keep: Character,
  absorb: Character,
  everyone: readonly Character[]
): Promise<PendingAfterUnify> {
  const result: PendingAfterUnify = {
    discarded: 0,
    rebased: 0,
    unreadable: [],
    before: [],
    after: [],
  };
  try {
    const loaded = await pending.loadAll();
    result.unreadable = loaded.errors.map((error) => error.file);
    const plan = planPendingAfterUnify(loaded.updates, keep, absorb, everyone);
    result.before = [...plan.discard, ...plan.restage.map((entry) => entry.from)];
    for (const update of plan.discard) {
      await pending.discard(update.filePath);
      result.discarded++;
    }
    for (const entry of plan.restage) {
      await restagePendingUpdate(pending, entry.from, entry.character);
      result.rebased++;
    }
    // 残した姿は**読み直して**控える。書いた写しと読んだ写しは、読むときの補い
    // （`parseCharacter`）の分だけ違うので、書いた写しで控えると［戻す］の照合が必ず外れる
    if (plan.discard.length > 0 || plan.restage.length > 0) {
      result.after = pendingOfPair((await pending.loadAll()).updates, keep.id, absorb.id);
    }
  } catch (error) {
    result.failure = messageOfStoreError(error);
  }
  return result;
}

/**
 * まとめたあとの反映待ちの扱いを、作者へ伝える文。何もしていなければ空。
 * 帯（設定資料パネル）・知らせ（詳細メニュー）・操作ログが同じ文を使う
 */
export function describePendingAfterUnify(
  result: PendingAfterUnify,
  keepName: string,
  absorbName: string
): string {
  const parts: string[] = [];
  if (result.discarded > 0 || result.rebased > 0) {
    const done = [
      result.discarded > 0 ? `「${absorbName}」の ${result.discarded}件は捨て` : "",
      result.rebased > 0
        ? `「${keepName}」の ${result.rebased}件はまとめたあとの姿に合わせ`
        : "",
    ].filter((part) => part);
    parts.push(`反映待ちの更新のうち、${done.join("、")}ました。`);
  }
  if (result.unreadable.length > 0) {
    parts.push(
      `読み込めない反映待ちの更新が ${result.unreadable.length}件あります` +
        `（${result.unreadable.join("、")}）。中身を確かめられないので、そのままにしました。`
    );
  }
  if (result.failure) {
    parts.push(
      `反映待ちの更新を片づけられませんでした（${result.failure}）。` +
        `「${keepName}」と「${absorbName}」の更新案は、反映せずに退けてください（まとめる前の姿に戻ります）。`
    );
  }
  return parts.join("");
}

/** 別人にするのに使う口（`CharacterStore` の一部） */
export interface DistinctWriter {
  saveOrUpdate(character: Character): Promise<void>;
  /** `UnifyWriter.snapshotOf` と同じ。持たない口なら［戻す］の札を作らない */
  snapshotOf?(id: string): { filePath: string; hash: string } | undefined;
}

/** 別人として覚えた1手を戻すための控え */
export interface DistinctUndoTicket {
  kind: "distinct";
  /** 書く前の2人（候補の並びのまま）と、書いた直後のハッシュ */
  pair: [
    { before: Character; afterHash: string },
    { before: Character; afterHash: string },
  ];
  /** 外した別名（帯で「戻しました」と名指しする） */
  strippedAliases: DistinctPairPlan["strippedAliases"];
  /** 片づけた反映待ち。［戻す］で積み直す（呼ぶ側が片づけたあとで入れる） */
  pendingBefore: PendingUpdate[];
}

export interface DistinctApplied extends DistinctPairPlan {
  undo?: DistinctUndoTicket;
}

/** どの段で失敗したか。段ごとに、作者がすべきことが違う */
export type UnifyStage = "retire_keep" | "save_unified" | "retire_absorbed";

export class CharacterUnifyError extends Error {
  constructor(
    readonly stage: UnifyStage,
    readonly detail: string,
    /** 残す側の元ファイルの退避先。作成に失敗したとき、作者が手で戻す先 */
    readonly keepRecoveryPath?: string
  ) {
    super(detail);
    this.name = "CharacterUnifyError";
  }
}

export interface UnifyApplied extends UnifyResult {
  /** 残す側の元ファイルの退避先 */
  keepRecoveryPath: string;
  /** 取り下げた側のファイルの退避先（「退避先を開く」で開く） */
  absorbRecoveryPath: string;
  /** 反映待ちの扱い（件数と、［戻す］で積み直す控え） */
  pending: PendingAfterUnify;
  /**
   * ［戻す］の札（設計書6.5.4）。ストアが保存先とハッシュを教えない口なら無い。
   * 持つのは呼ぶ側（設定資料パネルは直近の1手だけを持つ）
   */
  undo?: UnifyUndoTicket;
}

/** 退避した1つのファイル。元の保存先・退避先・中身のハッシュ */
export interface RetiredFile {
  id: string;
  name: string;
  /** 元の保存先（正規の場所） */
  filePath: string;
  /** 退避先（`.novelai-recovery`） */
  recoveryPath: string;
  /** 退避したときの中身のハッシュ。戻す前に、変わっていないことを確かめる */
  hash: string;
}

/** まとめた1手を戻すための控え */
export interface UnifyUndoTicket {
  kind: "unify";
  keep: RetiredFile;
  absorb: RetiredFile;
  /** まとめた内容を書いた直後のハッシュ。戻す前に、その後書き換えられていないかを見る */
  unifiedHash: string;
  pendingBefore: PendingUpdate[];
  pendingAfter: PendingUpdate[];
}

/**
 * 2人を1人にまとめて書く。
 *
 * このプロジェクトは既存ファイルの上書きを行わない（atomicWrite の replaceGuarded は
 * 必ず失敗する）。そのため「残す側を退避 → 新しい内容を新規作成 → 取り下げ側を退避」
 * の順で進める。
 *
 * 順序はわざとこうしている。新規作成に失敗した時点で止まれば、
 * 取り下げ側のファイルは手つかずのまま残る。逆順にすると、
 * 作成に失敗したときに人物が2件とも退避先へ行ってしまう。
 *
 * @param everyone いま存在する人物すべて。まとめる2人以外の名前を別名にしないために使う
 * @param options.pending 人物の反映待ち。**必ず渡す**——省くと、まとめる前の写しが
 *   反映待ちに残り、［確かめて反映］でまとめが巻き戻る（入口が2つあるので、省ける形にすると
 *   片方が忘れる）
 * @param options.plan 確認の窓に出すために先に組んだ結果があれば渡す（組み直すと、
 *   窓に出した別名と書いた別名が食い違いうる）
 */
export async function applyCharacterUnify(
  store: UnifyWriter,
  keep: Character,
  absorb: Character,
  everyone: readonly Character[],
  options: { pending: PendingCharacterWriter; plan?: UnifyResult }
): Promise<UnifyApplied> {
  const plan = options.plan ?? unifyCharacters(keep, absorb, everyone);
  // 退避する前の保存先とハッシュ。退避したファイルの中身はこのハッシュと同じ
  // （`retire` が照合してから移す）
  const keepBefore = store.snapshotOf?.(keep.id);
  const absorbBefore = store.snapshotOf?.(absorb.id);
  let keepRecoveryPath: string;
  try {
    keepRecoveryPath = await store.retire(keep.id);
  } catch (error) {
    throw new CharacterUnifyError("retire_keep", messageOfStoreError(error));
  }

  try {
    await store.save(plan.unified);
  } catch (error) {
    throw new CharacterUnifyError(
      "save_unified",
      messageOfStoreError(error),
      keepRecoveryPath
    );
  }

  let absorbRecoveryPath: string;
  try {
    absorbRecoveryPath = await store.retire(plan.retiredId);
  } catch (error) {
    // まとめた内容は保存済み。取り下げ側が残ると一覧に重複が出るが、
    // データは失われていない。何が起きたかだけ正確に伝える
    throw new CharacterUnifyError("retire_absorbed", messageOfStoreError(error));
  }

  // 反映待ちは、人物の3段が通ったあとに片づける（途中で止まったまとめに合わせて
  // 反映待ちを寄せると、まとまっていない人物の案が「まとめたあと」の形になる）
  const pending = await settlePendingAfterUnify(options.pending, keep, absorb, everyone);

  const unifiedAfter = store.snapshotOf?.(plan.unified.id);
  const undo: UnifyUndoTicket | undefined =
    keepBefore && absorbBefore && unifiedAfter
      ? {
          kind: "unify",
          keep: {
            id: keep.id,
            name: keep.name,
            filePath: keepBefore.filePath,
            recoveryPath: keepRecoveryPath,
            hash: keepBefore.hash,
          },
          absorb: {
            id: absorb.id,
            name: absorb.name,
            filePath: absorbBefore.filePath,
            recoveryPath: absorbRecoveryPath,
            hash: absorbBefore.hash,
          },
          unifiedHash: unifiedAfter.hash,
          pendingBefore: pending.before,
          pendingAfter: pending.after,
        }
      : undefined;

  return {
    ...plan,
    keepRecoveryPath,
    absorbRecoveryPath,
    pending,
    ...(undo ? { undo } : {}),
  };
}

/**
 * まとめるのに失敗したときの文。
 *
 * `modal` は、作者が手で戻さないとファイルが正規の場所に無いとき（作成の失敗）だけ立てる。
 * そこで知らせを流れる形にすると、戻す先の道が読まれないまま消える。
 */
export function describeUnifyFailure(
  error: CharacterUnifyError,
  keepName: string,
  absorbName: string
): { message: string; modal: boolean } {
  if (error.stage === "retire_keep") {
    return {
      message: `残す側のファイルを退避できませんでした。${error.detail}`,
      modal: false,
    };
  }
  if (error.stage === "save_unified") {
    return {
      message:
        `まとめた内容を保存できませんでした。${error.detail}\n` +
        `「${keepName}」の元ファイルは次の場所にあります。` +
        `手動で戻してください:\n${error.keepRecoveryPath ?? ""}`,
      modal: true,
    };
  }
  return {
    message:
      `まとめた内容は保存しましたが、「${absorbName}」を取り下げられませんでした。` +
      `一覧に重複が残ります。${error.detail}`,
    modal: false,
  };
}

/**
 * 読み込めない人物のファイルがあるときに、まとめる・別人にする操作を断る文。
 *
 * 壊れたJSONがあるまま決めると、読めていない人物を見落とす（規則2「壊れたJSONは
 * 直さず止める」）。空なら断らない。
 */
export function describeDecisionBlockedByLoadErrors(
  errors: ReadonlyArray<{ file: string }>
): string {
  if (errors.length === 0) return "";
  return (
    "読み込めない設定ファイルがあるため、まとめる操作を中止しました。" +
    `（${errors.map((error) => error.file).join("、")}）`
  );
}

/**
 * 2人を別人として覚えて書く。
 *
 * **書く順番は問わない。** 片方だけ書けたところで止まっても、「別人だ」は
 * 片側の記録だけで効く（`characterMerge.ts` の `isDeclaredDistinct`）。
 * 失敗は投げて、呼ぶ側が作者へ伝える。
 */
export async function applyCharacterDistinct(
  store: DistinctWriter,
  a: Character,
  b: Character
): Promise<DistinctApplied> {
  const plan = planDistinctPair(a, b);
  await store.saveOrUpdate(plan.first);
  await store.saveOrUpdate(plan.second);
  const firstAfter = store.snapshotOf?.(a.id);
  const secondAfter = store.snapshotOf?.(b.id);
  if (!firstAfter || !secondAfter) return plan;
  return {
    ...plan,
    undo: {
      kind: "distinct",
      pair: [
        { before: a, afterHash: firstAfter.hash },
        { before: b, afterHash: secondAfter.hash },
      ],
      strippedAliases: plan.strippedAliases,
      pendingBefore: [],
    },
  };
}

/**
 * ストアの失敗の文。`CharacterStoreError` も `Error` の文をそのまま持つので、
 * ここで種類を見分けない（`characterStore.ts` を読み込むと vscode まで付いてくる）
 */
function messageOfStoreError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
