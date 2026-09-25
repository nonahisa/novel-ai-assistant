import {
  CHARACTER_TEXT_FIELDS,
  isCharacterTextField,
  type Character,
  type RejectedValue,
} from "../models/character";
import {
  findChange,
  hasChange,
  mergeChangeLists,
  recordChangeChapters,
  type RecordChange,
  type RecordConflict,
} from "../models/jsonValidation";

/**
 * 食い違いを「作中での変化」へ昇格させる（設計書6.18）。
 *
 * 食い違い（`conflicts`）は「AIの取り違えかもしれない」ものとして
 * 作者の判断を待っている。作者が「これは作中で変わったのだ」と決めたら、
 * その判断を `changes` へ移す。移したあとは、
 *   - 資料に「変化かもしれない」ではなく変化として載る
 *   - 次の抽出で同じ食い違いが立て直されない（`characterMerge` が参照する）
 *
 * **判断そのものはAIにさせない。** どちらが正しいのか、あるいは両方正しくて
 * 作中で変わったのかは、書いた本人にしか分からない。
 */

export interface ConflictPromotion {
  /** 昇格後の変化の一覧 */
  changes: RecordChange[];
  /** 昇格した食い違いを取り除いたあとの一覧 */
  conflicts: RecordConflict[];
  /**
   * 「今の値」として項目へ入れ直す値。
   * いちばん後ろの話に出てきた値を選ぶ。決められなければ undefined
   * （そのときは元の値をそのまま残す）。
   */
  currentValue?: string;
}

export interface PromoteOptions {
  /** 作者が「今の値」を選んだ場合。省略すると話数から決める */
  currentValue?: string;
  /** 作中のいつのことか。時期を作っていなければ省略でよい */
  timepointId?: string | null;
  /**
   * 作者が画面で「作中の変化として記録」を押したか（作者の裁定、2026-09-23）。
   *
   * 押したなら、根拠の無い値も**作者が認めた変化**になる（`confirmed`）。
   * 抽出のたびに自動で畳む道（`foldCharacterConflicts`）では立てない——
   * そちらは作者が見ていないので、根拠の無い値は要確認のまま残す
   */
  confirmedByAuthor?: boolean;
}

/**
 * 指定した項目の食い違いを変化へ移す。
 * 対象の食い違いが無ければ undefined を返す（呼び出し側で「何もしない」）。
 */
export function promoteConflictToChanges(
  source: { changes: RecordChange[]; conflicts: RecordConflict[] },
  field: string,
  options: PromoteOptions = {}
): ConflictPromotion | undefined {
  const conflict = source.conflicts.find((entry) => entry.field === field);
  if (!conflict) return undefined;

  const entries = observationsOf(conflict);
  if (entries.length === 0) return undefined;

  const promoted: RecordChange[] = entries.map((entry, index) => ({
    field,
    value: entry.value,
    chapters: [...entry.chapters],
    timepointId: options.timepointId ?? null,
    // 食い違いの補足は値ごとではなく1件に付いている。
    // 捨てると作者が書いた文章が消えるので、先頭へ移して残す
    note: index === 0 ? conflict.note : null,
    // **値ごとの根拠を運ぶ**（2026-09-23）。落とすと、抽出が根拠を
    // 示していた値まで「根拠なし」になり、本体へ入れられなくなる
    evidence: entry.evidence ?? null,
    source: "extracted",
    ...(options.confirmedByAuthor ? { confirmed: true } : {}),
  }));

  return {
    changes: mergeChangeLists(source.changes, promoted),
    conflicts: source.conflicts.filter((entry) => entry.field !== field),
    currentValue: options.currentValue ?? latestValue(entries),
  };
}

/** 人物へ昇格の結果を反映する。「今の値」は対象の項目へ入れ直す */
export function applyPromotion(
  character: Character,
  field: string,
  promotion: ConflictPromotion
): Character {
  const updated: Character = {
    ...character,
    changes: promotion.changes,
    conflicts: promotion.conflicts,
  };
  // 変化として並べたうえで、レコード本体には最新の値を残す。
  // 残さないと、資料の「外見」が第1話の姿のままになる
  if (promotion.currentValue && isCharacterTextField(field)) {
    updated[field] = promotion.currentValue;
  }
  return updated;
}

/**
 * 抽出した値と、それが出てきた話数を履歴へ残す。
 *
 * **空欄を埋めるときにも呼ぶ。** ここで話数を残しておかないと、次に違う値が
 * 来たときに「作中で変わった」のか「同じ話の中で矛盾した」のかを見分けられない。
 * 見分けられないと、AIの取り違えまで変化として畳んでしまう。
 *
 * 1件しか無い項目は「変わっていない」ので、表示には出さない
 * （`changedFields` が2件以上の項目だけを返す）。
 */
export function recordValue(
  changes: RecordChange[],
  field: string,
  value: string,
  chapters: number[],
  evidence: string | null = null
): boolean {
  if (hasChange(changes, field, value)) {
    return recordChangeChapters(changes, field, value, chapters);
  }
  changes.push({
    field,
    value,
    chapters: sortedChapters(chapters),
    timepointId: null,
    note: null,
    evidence,
    source: "extracted",
  });
  return true;
}

/**
 * 同じ事実をより詳しく書き直したものへ差し替える
 * （「黒髪」→「短く切った黒髪」）。
 *
 * これは変化ではないので履歴を増やさない。増やすと
 * 「黒髪（第1話）→ 短く切った黒髪（第1話）」と、起きていない変化が資料に載る。
 */
export function refineValue(
  changes: RecordChange[],
  field: string,
  from: string,
  to: string,
  chapters: number[],
  /**
   * 詳しいほうの値を読み取った本文の引用（P-01 の `evidence`）。
   *
   * **書き換えた値には、書き換えたほうの根拠を添える**（0.75.4）。
   * 残っている記録の値は `to` になるので、`from` を読んだときの引用を
   * そのまま置いておくと、**値と根拠が食い違ったまま**設定資料パネルの
   * 「変化を落とす」に並ぶ。作者が取り違えを見抜く手掛かりは根拠しかない。
   * 手で入れる経路には根拠が無いので既定は null（そのときは前の根拠を残す）
   */
  evidence: string | null = null
): void {
  const existing = findChange(changes, field, from);
  if (!existing) {
    recordValue(changes, field, to, chapters, evidence);
    return;
  }
  existing.value = to;
  existing.chapters = sortedChapters([...existing.chapters, ...chapters]);
  if (evidence) existing.evidence = evidence;
}

/** その値がどの話のものか。履歴に無ければ undefined（判定できない） */
export function chaptersOfValue(
  changes: RecordChange[],
  field: string,
  value: string
): number[] | undefined {
  return findChange(changes, field, value)?.chapters;
}

/** 同じ話に両方が出ているか。出ていれば作中の変化では説明できない */
export function overlaps(left: number[], right: number[]): boolean {
  const seen = new Set(left);
  return right.some((chapter) => seen.has(chapter));
}

/**
 * 履歴のうち、いちばん後ろの話に出てきた値を「今の値」として返す。
 * どれにも話数が無ければ undefined（元の値をそのまま残す）。
 */
export function latestValueOfField(
  changes: RecordChange[],
  field: string
): string | undefined {
  return latestValue(
    changes
      .filter((change) => change.field === field)
      .map((change) => ({ value: change.value, chapters: change.chapters }))
  );
}

function sortedChapters(chapters: number[]): number[] {
  return [...new Set(chapters.filter((chapter) => Number.isSafeInteger(chapter)))].sort(
    (a, b) => a - b
  );
}

/**
 * 作中で変わらない項目。
 *
 * 読み仮名は人物の同定情報であって、その時点の描写ではない。
 * 話によって違う読みが出たら、それは作中の変化ではなく**AIの読み違い**である。
 * 畳むと「第13話までは『ふとし』だった」という、起きていない年表が資料に載る
 * （実データで太志と密倉文佳の両方で起きた）。
 *
 * 性別はここに入れない。この作者の作品には転生・転性があり
 * （`world_012_転生と転性`）、実際に変わりうるためである。
 */
const UNCHANGING_FIELDS = new Set(["reading"]);

/**
 * その項目は作中で変わりうるか。
 *
 * **食い違いを畳む側（`isFoldableConflict`）だけでは足りない。**
 * マージ側（`characterMerge.fillOrConflict`）が話数の違いを見て
 * 直接 `changes` へ積んでいたため、畳む前に「変化」ができていた
 * （実データで年表に「読み：たいし → たし」と出た）。判定はここ1か所に置く。
 */
export function isUnchangingField(field: string): boolean {
  return UNCHANGING_FIELDS.has(field);
}

/**
 * 面を積み重ねる項目（作者の裁定、2026-09-24 夜。`personalityFacets.ts`）。
 *
 * 性格は同時に成り立つ面を重ねて描かれるので、**変化の記録の値1つで
 * 本体を置き換えてはいけない。** 本体は面をつないだ文章で、変化の記録に
 * 残るのは作者が「変わった」と決めたものだけである。そこで、
 * - 食い違いを自動で畳まない（`isFoldableConflict`）
 * - 変化の値で本体を入れ替えない（`adoptableValueOfField`）
 * - 要確認として数えない（`heldChangesOfField`）
 * 本体を動かすのは、面を足す処理と作者の操作だけにする。
 *
 * 口調（2026-09-25。`speechStyle.ts`）も同じ積み方をする。マージは口調を
 * 変化・食い違いへ記録しないが、外から持ち込まれた記録があっても本体を
 * 入れ替えないよう、ここにも並べておく。
 */
const ACCUMULATING_FIELDS = new Set(["personality", "speechStyle"]);

export function isAccumulatingField(field: string): boolean {
  return ACCUMULATING_FIELDS.has(field);
}

/**
 * その食い違いを、作者に聞かずに変化として畳んでよいか。
 *
 * **判断の分かれ目は「同じ話の中で矛盾しているか」である。**
 *   - 第1話で「黒髪」、第7話で「銀髪」→ 作中で変わったと読むのが自然。畳む
 *   - 同じ第7話で「黒髪」と「銀髪」→ 両方が同時に正しいことはない。
 *     AIの取り違えの可能性が高いので、作者の判断へ回す
 *
 * 話数の無い値（食い違いに気づく前から入っていた値）は「それ以前」として
 * 最古に置けるので1つまで許す。2つ以上あると前後を決められないため畳まない。
 *
 * この判定を入れるまで、話ごとに違う言い方をされた要約が
 * すべて食い違いとして積み上がっていた（実データで太志のsummaryが9段）。
 */
export function isFoldableConflict(conflict: RecordConflict): boolean {
  if (UNCHANGING_FIELDS.has(conflict.field)) return false;
  // 性格の食い違いは変化へ畳まない。面へ移す（`migratePersonalityFacets`）
  if (ACCUMULATING_FIELDS.has(conflict.field)) return false;

  const entries = observationsOf(conflict);
  if (entries.length < 2) return false;

  // **別の人物の記述に似ていた値があれば畳まない**（精査 F4、作者の判断
  // 2026-09-25）。話数が重ならなくても、同じ場面から2人ぶんの記述が出て
  // 取り違えた見込みが高い。畳むと、別人の記述が年表へ流れる
  if (conflict.observations?.some((item) => item.resembles)) return false;

  // **話数の分かる値が2つ以上あること。**
  // 「変わった」と言うには、違う時点での値を2つ見る必要がある。
  // 片方の話数が分からないと前後を決められず、作者が手で書いた値を
  // AIの読みで押し流しかねない（品質ゲートの「印章師」で実際に起きた）。
  const dated = entries.filter((entry) => entry.chapters.length > 0);
  if (dated.length < 2) return false;

  // 話数の分からない値は「それ以前」として最古に置けるので1つまで。
  // 2つ以上あると、その間の前後を決められない
  const undated = entries.length - dated.length;
  if (undated > 1) return false;

  const seen = new Set<number>();
  for (const entry of dated) {
    for (const chapter of entry.chapters) {
      // 同じ話に2つの値が出ている。作中の変化では説明できない
      if (seen.has(chapter)) return false;
      seen.add(chapter);
    }
  }
  return true;
}

export interface FoldResult {
  character: Character;
  /** 畳んだ項目名。作者へ「黙って書き換えていない」と伝えるために返す */
  folded: string[];
}

/**
 * 畳める食い違いを、まとめて変化へ移す。
 *
 * **既存の値は消えない。** 変化の記録として残り、レコード本体には
 * いちばん後ろの話の値が入る。設計書5.4の「上書きせず作者に委ねる」を
 * 緩めているように見えるが、失われるものは無く、
 * 資料には「A（第1話）→ B（第7話）」と両方が並ぶ（設計書6.18）。
 *
 * **本体へ入れるのは、根拠のある値だけ**（作者の裁定、2026-09-23）。
 * 作者の画面を通らずに畳むので、根拠の無い値は変化として残すだけにし、
 * 本体は変えない（要確認。件数はマージの前後の差で数える——
 * `characterMerge.ts` の `newlyHeldChanges`）。作者が画面から押して
 * 昇格させる道（`applyPromotion`）は、作者の判断なのでこれまでどおり。
 *
 * **作者が確定させたレコード（`autoGenerated: false`）には使わない。**
 * 呼び出し側で除くこと。
 */
export function foldCharacterConflicts(character: Character): FoldResult {
  let result = character;
  const folded: string[] = [];

  // 走査中に conflicts が変わるので、対象は先に決めておく
  const targets = character.conflicts
    .filter((conflict) => isFoldableConflict(conflict))
    .map((conflict) => conflict.field);

  for (const field of targets) {
    const promotion = promoteConflictToChanges(result, field);
    if (!promotion) continue;
    result = {
      ...result,
      changes: promotion.changes,
      conflicts: promotion.conflicts,
    };
    if (isCharacterTextField(field)) {
      const adopted = adoptableValueOfField(result.changes, field, result[field]);
      if (adopted) result = { ...result, [field]: adopted };
    }
    folded.push(field);
  }

  return { character: result, folded };
}

/**
 * その変化は、台帳の本体の値を動かしてよいか（作者の裁定、2026-09-23）。
 *
 * 実データで、抽出の「変化」214件のうち根拠（本文の引用）のあるものは
 * 19件（9%）だった。根拠が無いと、作者は話し手の取り違えのような誤りを
 * 見抜けない。そのまま本体を入れ替えると、**確かめようのない読みが
 * 資料の顔になる。** そこで本体を動かすのは、次のどれかに限る。
 *
 * - 根拠（`evidence`）がある
 * - 作者が書いた（`source: "author"`）
 * - 作者が認めた（`confirmed`。設定資料パネルの「変化として認める」）
 *
 * **判定はここ1か所に置く。** マージ・畳み・画面の表示が別々に決めると、
 * 画面では要確認なのにマージが本体を動かす、といった食い違いが出る。
 */
export function changeMovesBody(change: RecordChange): boolean {
  return (
    Boolean(change.evidence?.trim()) ||
    change.source === "author" ||
    change.confirmed === true
  );
}

/**
 * 本体へ入れてよい値。入れ替えなくてよいなら undefined。
 *
 * **本体を動かしてよい変化**（`changeMovesBody`）のうち、いちばん後ろの話の値。
 * ただし**いまの本体の値より前の話へは戻さない**——根拠の無い値が以前の版で
 * 本体に入っていたとき、根拠のある古い値へ巻き戻すのも「勝手に変える」
 * ことになる。いまの値が履歴に無い（話数が分からない）ときは、これまでどおり
 * 後ろの話の値を入れる。
 */
export function adoptableValueOfField(
  changes: RecordChange[],
  field: string,
  current: string | null | undefined
): string | undefined {
  // 面を積む項目は、変化の値1つで本体を置き換えない（`isAccumulatingField`）
  if (ACCUMULATING_FIELDS.has(field)) return undefined;
  const latest = latestEntry(
    changes.filter((change) => change.field === field && changeMovesBody(change))
  );
  if (!latest || latest.value === current) return undefined;
  const currentLast = lastChapterOfValue(changes, field, current);
  if (currentLast !== undefined && currentLast >= latest.chapter) return undefined;
  return latest.value;
}

/**
 * 要確認の変化：**根拠が無いので、本体へ入れていないもの**。
 *
 * 本体を動かせない変化（`changeMovesBody` が偽）のうち、いまの本体の値より
 * **後の話**に出てきたもの。本体より前の話の値は、ただの経緯（「黒髪
 * （第1話）→ 銀髪（第7話）」の黒髪）なので要確認には入れない。
 */
export function heldChangesOfField(
  changes: RecordChange[],
  field: string,
  current: string | null | undefined
): RecordChange[] {
  // 面を積む項目の本体は変化の値ではないので、「本体へ入れていない」も無い
  if (ACCUMULATING_FIELDS.has(field)) return [];
  const currentLast = lastChapterOfValue(changes, field, current) ?? -Infinity;
  return changesOfField(changes, field).filter(
    (change) =>
      !changeMovesBody(change) &&
      change.value !== current &&
      change.chapters.length > 0 &&
      Math.max(...change.chapters) > currentLast
  );
}

/**
 * 抽出の完了報告に添える、要確認の件数（作者の裁定、2026-09-23）。
 *
 * **黙って本体を据え置いたことにしない**（CLAUDE.md 規則2の裏返し）。
 * 0件なら何も足さない（毎回「0件」が並ぶと、ほかの行が読まれなくなる）。
 * どこで確かめて認められるかを1つ示す。
 */
export function describeHeldChanges(count: number): string {
  if (count <= 0) return "";
  return (
    `\n根拠が無いので本体を変えなかった変化 ${count}件` +
    "（本文の引用が無い変化は、要確認として記録だけしてあります。" +
    "設定資料パネルの人物の「要確認」から、正しければ認めてください。" +
    "承認待ちの更新に含まれるものは、反映したあとに出ます）"
  );
}

export interface ConfirmHeldResult {
  /** 認めたあとの人物。**元のレコードは書き換えない** */
  character: Character;
  /** 認めた変化の件数。0なら `character` は渡したものそのもの */
  confirmed: number;
}

/**
 * 要確認の変化を、作者が「正しい」と認める（作者の裁定、2026-09-23）。
 *
 * 認めた変化には `confirmed` を立て、本体へ入れてよい値があれば入れる。
 * **値は消さない。** 誤りだった場合は、別の操作（誤りを落とす、
 * `dropChanges`）で作者が落とす。
 */
export function confirmHeldChanges(
  character: Character,
  field: string
): ConfirmHeldResult {
  const current = isCharacterTextField(field) ? character[field] : null;
  const held = new Set(
    heldChangesOfField(character.changes, field, current).map(changeEntryKey)
  );
  if (held.size === 0) return { character, confirmed: 0 };

  let confirmed = 0;
  const changes = character.changes.map((change) => {
    if (!held.has(changeEntryKey(change))) return change;
    confirmed++;
    return { ...change, confirmed: true };
  });
  let updated: Character = { ...character, changes };
  if (isCharacterTextField(field)) {
    const adopted = adoptableValueOfField(changes, field, updated[field]);
    if (adopted) updated = { ...updated, [field]: adopted };
  }
  return { character: updated, confirmed };
}

/** その項目の変化を、古い順に並べて返す */
export function changesOfField(
  changes: RecordChange[],
  field: string
): RecordChange[] {
  return sortChanges(changes.filter((change) => change.field === field));
}

/**
 * 変化の記録を1件ずつ見分ける鍵（作者の裁定、2026-09-21）。
 *
 * **鍵は文字列として分解しない**（`dropDiffEntries` と同じ考え方）。
 * レコード側からこの関数で組み立て、集合に入っているかだけを見る。
 * 分解すると、値に区切り文字が入ったときに引き当てを外す。
 *
 * 区切りのNULは、値にも項目名にも現れない文字だから選んだ。
 * **エスケープで書く**——生の制御文字を置くと、gitやgrepが
 * このファイルをバイナリとして扱う（`sourceHygiene.test.ts`）。
 */
export function changeEntryKey(change: RecordChange): string {
  return `${change.field}\u0000${change.value}\u0000${[...change.chapters]
    .sort((left, right) => left - right)
    .join(",")}`;
}

export interface DropChangesResult {
  changes: RecordChange[];
  /**
   * 実際に落とした件数。
   *
   * **黙って落としたことにしない**（CLAUDE.md 規則2）。作者へ
   * 「◯件を落としました」と伝えるために数える。
   */
  dropped: number;
}

/**
 * 誤って記録された変化を落とす（作者の裁定、2026-09-21）。
 *
 * 抽出は話者を取り違えることがある。実データでは、呼びかけられた側の
 * 名前を話し手と読み、女性の人物の第1話に「リーダー格の男性。」という
 * 変化が3項目ぶん残った。レコード本体は直せても、**変化の記録だけは
 * 消す手段がどこにも無かった**——MCP（`novel.propose`）では `changes` が
 * 白名簿の外で、画面にも落とす口が無かった。
 *
 * **落とすのは作者が選んだものだけ。** どれが取り違えかはAIには決められ
 * ないので、判断は必ず人が下す（設計書6.18と同じ立場）。
 *
 * **レコード本体（`summary` などの項目）には触らない。** 本体は作者が
 * すでに直していることがあり、変化を落としたついでに書き換えると、
 * 作者が書いた値を押し流す（CLAUDE.md 規則2）。
 */
export function dropChanges(
  changes: RecordChange[],
  keys: readonly string[]
): DropChangesResult {
  if (keys.length === 0) return { changes, dropped: 0 };

  const drop = new Set(keys);
  const remaining = changes.filter(
    (change) => !drop.has(changeEntryKey(change))
  );
  const dropped = changes.length - remaining.length;
  // 1件も当たらなかったなら、写しを作らずそのまま返す
  if (dropped === 0) return { changes, dropped: 0 };
  return { changes: remaining, dropped };
}

export interface DropConflictValueResult {
  /** 落としたあとの人物。**元のレコードは書き換えない** */
  character: Character;
  /** 食い違いが解けたか（残った値が1つになり、食い違いの記録ごと外した） */
  resolved: boolean;
  /** 本体の値が落とした値だったので、残った1つへ入れ替えたか */
  bodyReplaced: boolean;
  /**
   * 本体の値が落とした値のままか。残った値が2つ以上あり、どれを本体に
   * するかを決められなかったとき true（作者に欄を直してもらう）
   */
  bodyStillDropped: boolean;
  /** 同じ項目・同じ値の変化の記録から、一緒に外した件数 */
  droppedChanges: number;
}

/**
 * 食い違いの値の1つを、作者が「誤り」として落とす（作者の裁定、2026-09-26 深夜）。
 *
 * これまでは［作中の変化として記録］してから［誤りを落とす］で選び直す2手が
 * 要った。しかも1手目で誤りの値が「作者が認めた変化」になり、話数しだいで
 * 本体へ入る。**誤りだと分かっている値を、変化として経由させない。**
 *
 * - 食い違いからその値を外す。残りが1つなら食い違いは解けたので、記録ごと外す
 * - **本体が落とした値で、残りが1つなら、残りを本体に入れる**——作者が
 *   「本体のほうが誤り」と決めた。残りが2つ以上なら、どれにするかは決めない
 *   （同じ話の矛盾は作者が決める。設計書6.18）
 * - 同じ項目・同じ値の変化の記録も外す（残すと、後ろの話の値として本体へ
 *   戻る道になる）
 * - **落とした値は `rejectedValues` へ残す**（黙って消さない。次の抽出でも
 *   立て直さない——`characterMerge.ts` の `fillOrConflict` が見る）
 *
 * **作者の欄（`authorNotes`・`exportNote`）と `autoGenerated` には触らない。**
 * 作者が触ったのは1項目の1つの値であって、レコード全体を引き取ったわけでは
 * ない（`handlePromoteConflict` と同じ理由）。
 *
 * 対象が無い（別の窓で先に処理された）・落とすと値が1つも残らないときは
 * undefined（呼び出し側で「何もしない」）。
 */
export function dropConflictValue(
  character: Character,
  field: string,
  value: string,
  rejectedAt: string
): DropConflictValueResult | undefined {
  const conflict = character.conflicts.find((entry) => entry.field === field);
  if (!conflict) return undefined;
  const entries = observationsOf(conflict);
  const target = entries.find((entry) => entry.value === value);
  if (!target) return undefined;
  const remaining = entries.filter((entry) => entry.value !== value);
  // 全部を誤りにはできない。正しい値は作者が欄へ直接書く
  if (remaining.length === 0) return undefined;

  const resolved = remaining.length === 1;
  const conflicts = resolved
    ? character.conflicts.filter((entry) => entry !== conflict)
    : character.conflicts.map((entry) =>
        entry === conflict
          ? {
              ...entry,
              values: entry.values.filter((item) => item !== value),
              ...(entry.observations
                ? {
                    observations: entry.observations.filter(
                      (item) => item.value !== value
                    ),
                  }
                : {}),
            }
          : entry
      );

  const changes = character.changes.filter(
    (change) => !(change.field === field && change.value === value)
  );
  const droppedChanges = character.changes.length - changes.length;

  const rejected: RejectedValue = {
    field,
    value,
    chapters: [...target.chapters],
    ...(target.evidence?.trim() ? { evidence: target.evidence.trim() } : {}),
    rejectedAt,
  };
  const already = (character.rejectedValues ?? []).some(
    (entry) => entry.field === field && entry.value === value
  );

  let updated: Character = {
    ...character,
    conflicts,
    changes,
    rejectedValues: already
      ? character.rejectedValues
      : [...(character.rejectedValues ?? []), rejected],
  };

  let bodyReplaced = false;
  let bodyStillDropped = false;
  if (isCharacterTextField(field) && character[field] === value) {
    if (resolved) {
      updated = { ...updated, [field]: remaining[0].value };
      bodyReplaced = true;
    } else {
      bodyStillDropped = true;
    }
  }

  return {
    character: updated,
    resolved,
    bodyReplaced,
    bodyStillDropped,
    droppedChanges,
  };
}

/**
 * 食い違いの値を、古い順に並べて返す（画面の「こちらは誤り」の札に使う）。
 *
 * 話数の記録が無い古いデータの値も必ず含める（`observationsOf` と同じ理由）。
 */
export function conflictValuesOf(conflict: RecordConflict): string[] {
  return observationsOf(conflict).map((entry) => entry.value);
}

/**
 * その値は、作者が「誤り」として落としたものか（2026-09-26 深夜）。
 *
 * **前後の空白だけを揃えて、文字どおり比べる。** 似た言い方まで寄せると、
 * 作者が落としていない値まで黙って捨てることになる（規則2の裏返し）。
 */
export function isRejectedValue(
  character: Pick<Character, "rejectedValues">,
  field: string,
  value: string
): boolean {
  const wanted = value.trim();
  return (character.rejectedValues ?? []).some(
    (entry) => entry.field === field && entry.value.trim() === wanted
  );
}

/**
 * 承認待ちの更新案を、いまの台帳の「誤りとして落とした値」に合わせて整える
 * （承認の画面が組む前に通す。2026-09-26）。
 *
 * 更新案は**積んだ時点の写し**である。外部AIの提案（`novel.propose`）は
 * 置くときに落とした値を取り下げるが、**作者が値を落とす前に**置かれた案は、
 * 写しの中で「その値へ変える」差分のまま並び、承認すると誤りの値が本体へ
 * 戻る。退けた関係（`settlePendingRelations`）と同じ形で外す。
 *
 * - **文の欄**（`CHARACTER_TEXT_FIELDS`。食い違いが記録され、落とせるのはここだけ）
 *   で、案の値がいまの本体と違い、しかも落とした値に当たる（`isRejectedValue`）
 *   ときだけ、案の値をいまの本体の値へ戻す。外したものは返す（黙って外さない）
 * - いまの本体がその値のまま（落としたが残りが2つ以上で本体を決めなかった）なら、
 *   差分にならないので触らないし数えない
 * - **落とした記録そのものは、台帳の側を正とする。** 写しの古い記録
 *   （落とす前なので空）で巻き戻さない
 *
 * - **食い違い（`conflicts`）と変化の記録（`changes`）からも外す**（リーダーの
 *   方針、2026-09-26）。写しは落とす前の記録を持っており、差分の画面には
 *   出ないまま、承認すると誤りの値を含んだ食い違いが台帳へ戻る。外した結果、
 *   食い違いの値が1つになれば、解けたものとして記録ごと外す
 *   （`dropConflictValue` と同じ考え方）。**本体の値の入れ替えはしない**
 *   ——本体は上の文の欄の扱いで守っている
 * - 外したものは**項目と値の組で1件**に数える（本体・食い違い・変化の記録の
 *   3か所に同じ誤りがあっても、作者が落とした値は1つ）
 *
 * **作者の欄（`authorNotes`・`exportNote`）と `autoGenerated` には触らない**
 * （写しの値のまま。作者の欄は差分の側が見張っている）。
 */
export function settlePendingRejectedValues(
  current: Character,
  pending: Character
): { character: Character; skipped: Array<{ field: string; value: string }> } {
  const skipped: Array<{ field: string; value: string }> = [];
  const note = (field: string, value: string): void => {
    const trimmed = value.trim();
    if (!skipped.some((item) => item.field === field && item.value === trimmed)) {
      skipped.push({ field, value: trimmed });
    }
  };
  let character: Character = pending;
  for (const field of CHARACTER_TEXT_FIELDS) {
    const proposed = pending[field];
    if (typeof proposed !== "string" || !proposed.trim()) continue;
    if (proposed === current[field]) continue;
    if (!isRejectedValue(current, field, proposed)) continue;
    character = { ...character, [field]: current[field] };
    note(field, proposed);
  }

  if ((current.rejectedValues ?? []).length > 0) {
    const rejected = (field: string, value: string): boolean =>
      isRejectedValue(current, field, value);
    const conflicts: RecordConflict[] = [];
    let conflictsChanged = false;
    for (const conflict of character.conflicts) {
      const dropped = observationsOf(conflict)
        .map((entry) => entry.value)
        .filter((value) => rejected(conflict.field, value));
      if (dropped.length === 0) {
        conflicts.push(conflict);
        continue;
      }
      conflictsChanged = true;
      for (const value of dropped) note(conflict.field, value);
      const trimmedConflict: RecordConflict = {
        ...conflict,
        values: conflict.values.filter((value) => !dropped.includes(value)),
        ...(conflict.observations
          ? {
              observations: conflict.observations.filter(
                (item) => !dropped.includes(item.value)
              ),
            }
          : {}),
      };
      // 値が1つ以下になった食い違いは解けた（記録ごと外す）
      if (observationsOf(trimmedConflict).length >= 2) conflicts.push(trimmedConflict);
    }
    const changes = character.changes.filter((change) => {
      if (!rejected(change.field, change.value)) return true;
      note(change.field, change.value);
      return false;
    });
    if (conflictsChanged || changes.length !== character.changes.length) {
      character = { ...character, conflicts, changes };
    }
  }
  // 台帳が1件も持たなければ、欄ごと無い形に揃える（古い形の資料と同じ）
  if (current.rejectedValues === undefined) {
    const { rejectedValues: _stale, ...rest } = character;
    return { character: rest, skipped };
  }
  return {
    character: { ...character, rejectedValues: [...current.rejectedValues] },
    skipped,
  };
}

/**
 * 「誤りとして落とした値」の印を1件だけ外す（作者の裁定、2026-09-26）。
 *
 * 外すのは「次の抽出や外部AIの提案が、この値をまた出してよい」と許すことで、
 * **食い違いの記録も本体の値も元へ戻さない。** 落としたときに本体が
 * 入れ替わっていても（`dropConflictValue` の `bodyReplaced`）、それは作者が
 * 決めた結果なので、黙って巻き戻さない（退けた関係を外すときに関係そのものは
 * 戻さない `forgetRejectedRelation` と同じ立場）。値がまた出れば、抽出のマージが
 * 食い違いとして並べ直す。
 *
 * 当てる値は**画面が送ってきた記録そのまま**（項目と値の完全一致）。
 * `isRejectedValue` のように前後の空白を揃えて当てると、同じ項目に空白だけ
 * 違う記録が2件あったとき、押していないほうまで外れる。
 *
 * **作者の欄（`authorNotes`・`exportNote`）と `autoGenerated` には触らない。**
 *
 * 対象が無い（別の窓で先に外された）ときは undefined（呼び出し側で何もしない）。
 * 最後の1件を外したら、欄ごと消して古い形の資料と同じにする。
 */
export function undoRejectedValue(
  character: Character,
  field: string,
  value: string
): Character | undefined {
  const current = character.rejectedValues ?? [];
  const index = current.findIndex(
    (entry) => entry.field === field && entry.value === value
  );
  if (index < 0) return undefined;
  const remaining = current.filter((_, position) => position !== index);
  if (remaining.length > 0) {
    return { ...character, rejectedValues: remaining };
  }
  const { rejectedValues: _removed, ...rest } = character;
  return rest;
}

/**
 * 実際に変わった項目を返す。
 *
 * **値が1件しか記録されていない項目は含めない。** 空欄を埋めたときにも
 * 履歴を残しているので（`recordValue`）、全項目をそのまま返すと
 * 変わっていない項目まで「変化」として資料に載ってしまう。
 */
export function changedFields(changes: RecordChange[]): string[] {
  const counts = new Map<string, number>();
  for (const change of changes) {
    counts.set(change.field, (counts.get(change.field) ?? 0) + 1);
  }
  return [...new Set(changes.map((change) => change.field))].filter(
    (field) => (counts.get(field) ?? 0) >= 2
  );
}

/**
 * 古い順に並べる。
 * 話数の無いものは「気づく前からあった値」なので先に置く
 * （`describeConflictValues` の並べ方と揃える）。
 */
export function sortChanges(changes: RecordChange[]): RecordChange[] {
  return [...changes].sort(
    (left, right) => firstChapter(left.chapters) - firstChapter(right.chapters)
  );
}

/**
 * 食い違いの値を、値ごとの話数と組にして取り出す。
 *
 * 古いデータには `observations`（値ごとの話数）が無い。そのときは話数なしの
 * 値として扱う。**記録のある値だけを並べると、既にあった食い違いが消える**ので、
 * `values` 側にしか無い値も必ず拾う（`describeConflictValues` と同じ理由）。
 */
function observationsOf(
  conflict: RecordConflict
): Array<{ value: string; chapters: number[]; evidence?: string | null }> {
  const observations = conflict.observations ?? [];
  const missing = conflict.values
    .filter((value) => !observations.some((item) => item.value === value))
    .map((value) => ({ value, chapters: [] as number[] }));
  return (
    [...observations, ...missing]
      .filter((item) => item.value.trim())
      // **保存する時点で古い順に並べる。** 表示側でも並べ替えているが、
      // このJSONは作者が開いて読むものなので、ファイルの中でも
      // 「黒髪 → 銀髪」の順に並んでいてほしい
      .sort((a, b) => firstChapter(a.chapters) - firstChapter(b.chapters))
  );
}

/**
 * いちばん後ろの話に出てきた値。
 * どれにも話数が無ければ決められない（元の値をそのまま残す）。
 */
function latestValue(
  entries: Array<{ value: string; chapters: number[] }>
): string | undefined {
  return latestEntry(entries)?.value;
}

/** いちばん後ろの話に出てきた値と、その話数。話数がどれにも無ければ undefined */
function latestEntry(
  entries: Array<{ value: string; chapters: number[] }>
): { value: string; chapter: number } | undefined {
  let best: { value: string; chapter: number } | undefined;
  for (const entry of entries) {
    if (entry.chapters.length === 0) continue;
    const last = Math.max(...entry.chapters);
    if (!best || last > best.chapter) best = { value: entry.value, chapter: last };
  }
  return best;
}

/** その値が履歴に出てきた最後の話。履歴に無い・話数が無いなら undefined */
function lastChapterOfValue(
  changes: RecordChange[],
  field: string,
  value: string | null | undefined
): number | undefined {
  if (!value) return undefined;
  const chapters = changes
    .filter((change) => change.field === field && change.value === value)
    .flatMap((change) => change.chapters);
  return chapters.length > 0 ? Math.max(...chapters) : undefined;
}

function firstChapter(chapters: number[]): number {
  return chapters.length > 0 ? Math.min(...chapters) : -1;
}
