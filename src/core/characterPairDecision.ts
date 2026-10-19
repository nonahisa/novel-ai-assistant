import type { Character } from "../models/character";
import { unifyCharacters, type UnifyResult } from "./characterUnify";
import { planDistinctPair, type DistinctPairPlan } from "./characterSeparate";

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
}

/** 別人にするのに使う口（`CharacterStore` の一部） */
export interface DistinctWriter {
  saveOrUpdate(character: Character): Promise<void>;
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
 * @param plan 確認の窓に出すために先に組んだ結果があれば渡す（組み直すと、
 *   窓に出した別名と書いた別名が食い違いうる）
 */
export async function applyCharacterUnify(
  store: UnifyWriter,
  keep: Character,
  absorb: Character,
  everyone: readonly Character[],
  plan: UnifyResult = unifyCharacters(keep, absorb, everyone)
): Promise<UnifyApplied> {
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

  return { ...plan, keepRecoveryPath, absorbRecoveryPath };
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
): Promise<DistinctPairPlan> {
  const plan = planDistinctPair(a, b);
  await store.saveOrUpdate(plan.first);
  await store.saveOrUpdate(plan.second);
  return plan;
}

/**
 * ストアの失敗の文。`CharacterStoreError` も `Error` の文をそのまま持つので、
 * ここで種類を見分けない（`characterStore.ts` を読み込むと vscode まで付いてくる）
 */
function messageOfStoreError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
