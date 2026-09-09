import {
  AddressTerm,
  Character,
  emptyCharacter,
  nextCharacterId,
  type CharacterTextField,
} from "../models/character";
import { ExtractedCharacter } from "../prompts/characterExtract";
import { clampSummary } from "./summaryLimit";
import { fillReading, toDictionaryReading } from "./reading";
import { normalizeGender } from "./gender";
import { isMeaningfulValue } from "./characterExtractionValidation";
import {
  HONORIFIC_SUFFIX_SOURCE,
  HONORIFIC_SUFFIXES,
  stripHonorific,
} from "./nameHonorific";
import { KINSHIP_WORDS, PRONOUN_WORDS } from "./genericPersonWords";
import {
  hasChange,
  recordChangeChapters,
  recordObservation,
} from "../models/jsonValidation";
import {
  chaptersOfValue,
  foldCharacterConflicts,
  isUnchangingField,
  latestValueOfField,
  overlaps,
  recordValue,
  refineValue,
} from "./recordChanges";

/**
 * 抽出結果を既存の人物一覧へマージする。
 *
 * 設計書ではReduce段階もAIに任せる案だったが、実装ではコード側で行う。
 * 理由は3つ:
 *  1. 作者の加筆を確実に保護できる（AIの指示追従に依存しない）
 *  2. 同じ入力なら必ず同じ結果になる
 *  3. AI呼び出し回数が減り、処理時間とコストが下がる
 *
 * AIには「本文から情報を取り出す」ことだけをさせ、
 * 「既存データとどう統合するか」はコードが決める。
 */
export interface MergeResult {
  characters: Character[];
  added: string[];
  updated: string[];
  /** 実際に追加・更新された人物。不要なJSON再書き込みを避けるために使う */
  changedIds: string[];
  /** 既存と食い違い、作者の判断が必要になったもの */
  conflicts: Array<{ characterName: string; field: string; values: string[] }>;
  /**
   * 作中の変化として自動で畳んだもの。
   * **黙って書き換えたことにしないため**、件数を作者へ伝えるのに使う。
   */
  folded: Array<{ characterName: string; field: string }>;
  /**
   * 作者が「別人だ」と決めた相手の呼び名が付いていたため、
   * 既存レコードへ取り込まなかった候補（設計書6.5.8）。
   *
   * **黙って捨てない。** 件数を作者へ伝えないと、
   * 資料が増えなかった理由が抽出の失敗と区別できない。
   */
  rejectedDistinct: Array<{
    /** 取り込み先になるはずだった既存レコードの名前 */
    characterName: string;
    /** 「別人だ」と決めた側に当たった呼び名（抽出が書いてきたまま） */
    blockedName: string;
    /** その候補が出てきた話数 */
    chapters: number[];
  }>;
  /**
   * 敬称違いの呼び方を、新しいレコードにせず既存の人物へ寄せたもの
   * （設計書6.5.9）。
   *
   * **AIは敬称違いを aliases に返さない**（実測。スキーマの required も
   * 説明文もプロンプトの規則も効かなかった）。寄せているのはコード側なので、
   * **黙って寄せたことにしない**ために件数と中身を返す。
   */
  honorificMerges: Array<{
    /** 寄せ先になった既存レコードの名前 */
    characterName: string;
    /** 抽出が書いてきた、敬称の付いた呼び方 */
    incomingName: string;
  }>;
  /** 同一人物かもしれない組。自動では統合せず、作者の判断に委ねる */
  mergeCandidates: MergeCandidate[];
}

/**
 * 同一人物の可能性がある組。
 *
 * 「ギルドマスター」と「ギルマス」のような省略形は敬称除去では吸収できない。
 * ただし自動で統合すると、別人を1人にまとめてしまったときに
 * 作者のデータを壊すことになる（取り消しも難しい）。
 * 統合し損ねるのは手間で済むが、誤統合は損害になるため、候補の提示に留める。
 */
export interface MergeCandidate {
  names: [string, string];
  /**
   * 組のレコードid。**名前だけでは組を特定できない。**
   * same_name の候補はまさに同名レコードの組であり（「お母さん」が4件）、
   * 名前で引き当てると同じ1件へ潰れて、まとめる操作が必ず失敗する
   */
  ids: [string, string];
  /**
   * abbreviation: 省略形とみられる（「ギルマス」と「ギルドマスター」）
   * suffix: 一方が他方の言い方を含む（「近所のおばあさん」と「ばあさん」）
   * name_part: 姓名を繋げた名前と、名だけの名前（「密倉文佳」と「文佳」）
   * honorific_family_name: 敬称を外すと、もう一方の姓（「密倉さん」と「密倉文佳」）
   * reading_match: かなの呼び名が、もう一方の読み仮名と重なる（「フミカ」と「密倉文佳」）
   * ambiguous: 統合先が複数あって決められなかった
   * same_name: 同じ呼称なのに別レコードになっている
   */
  reason:
    | "abbreviation"
    | "suffix"
    | "name_part"
    | "honorific_family_name"
    | "reading_match"
    | "ambiguous"
    | "same_name";
  /**
   * 一致した呼び名（same_name・honorific_family_name・reading_match のときだけ）。
   * honorific_family_name では、敬称を外した形＝姓が入る。
   * reading_match では、読みと重なったかなの呼び名が入る。
   *
   * **名指しで出すためにある。** 理由が「同じ呼び名が両方に登録されています」
   * だけだと、作者はどの呼び名で並んだのか分からず、姓の共有なのか
   * 同一人物なのかを判断できない（実データで20組中およそ半分が別人だった）。
   */
  matchedName?: string;
  /**
   * 突き合わせた読み仮名（reading_match のときだけ）。
   * 「何と何が重なったのか」を作者へそのまま見せるために持つ。
   */
  matchedReading?: string;
  /**
   * どれくらい確からしいか。
   * 姓の共有や別名の汚染で並んだかもしれない組は "weak" にする。
   *
   * "medium" は敬称を外した姓の一致（honorific_family_name）。
   * 同じ姓を持つレコードが1件しか無いことを確かめてあるので "weak" よりは
   * 確からしいが、**姓の一致は別人でも起きる**ので "strong" にはしない。
   */
  confidence?: "strong" | "medium" | "weak";
  /** "weak" にした理由。画面ではそのまま添える */
  weakNote?: string;
}

/** 姓の共有かもしれないときに添える一言 */
const WEAK_FAMILY_NAME_NOTE = "姓の共有かもしれません";
/** 別名に相手の名前が入っているだけかもしれないときに添える一言 */
const WEAK_ALIAS_NOTE = "別名に相手の名前が混ざっただけかもしれません";
/** 代名詞・家族関係語のように、誰にでも使う呼び方で並んだときに添える一言 */
const WEAK_GENERIC_WORD_NOTE = "誰にでも使う呼び方です。別人かもしれません";

/** 手掛かりの種類を表す短い文 */
const MERGE_REASON_LABELS: Record<MergeCandidate["reason"], string> = {
  same_name: "同じ呼び名が両方に登録されています",
  abbreviation: "省略形とみられます",
  suffix: "一方が他方の呼び方を含んでいます",
  name_part: "姓名と、名だけの呼び方とみられます",
  honorific_family_name: "敬称を外すと、もう一方の姓と同じです",
  reading_match: "読み仮名と同じ音です",
  ambiguous: "統合先を決められませんでした",
};

/**
 * 候補の理由を、作者が読んで判断できる文にする。
 *
 * **一致した呼び名を名指しする。** 「「三門」が両方にあります」と出れば、
 * 作者は姓の共有だと一目で分かって断れる（設計書6.5.9）。
 */
export function describeMergeCandidate(candidate: MergeCandidate): string {
  // 姓のどこが一致したのかを、外した敬称ごと見せる。
  // 「密倉さん」と「密倉文佳」が同じ人かは作者にしか分からないので、
  // 判断の材料（何を外して何と比べたか）をそのまま出す
  if (candidate.reason === "honorific_family_name" && candidate.matchedName) {
    return `敬称を外すと「${candidate.matchedName}」＝「${candidate.names[1]}」の姓です`;
  }
  // 読みで並んだ組も、突き合わせたものを全部見せる。
  // 「同じ音です」だけでは、同音の別人なのか表記違いなのか判断できない
  if (candidate.reason === "reading_match" && candidate.matchedName) {
    const reading = candidate.matchedReading
      ? `（${candidate.matchedReading}）`
      : "";
    const base = `「${candidate.matchedName}」が「${candidate.names[1]}」の読み仮名${reading}と重なります`;
    return candidate.weakNote ? `${base}（${candidate.weakNote}）` : base;
  }
  const base =
    candidate.reason === "same_name" && candidate.matchedName
      ? `「${candidate.matchedName}」が両方にあります`
      : MERGE_REASON_LABELS[candidate.reason];
  return candidate.weakNote ? `${base}（${candidate.weakNote}）` : base;
}

export function mergeExtractedCharacters(
  existing: Character[],
  extracted: Array<{ data: ExtractedCharacter; chapters: number[] }>
): MergeResult {
  // 作者が管理している元レコードを、入れ子の配列・オブジェクトを含めて保護する。
  const result: Character[] = existing.map((character) => structuredClone(character));
  const added: string[] = [];
  const updated: string[] = [];
  const changedIds = new Set<string>();
  const conflicts: MergeResult["conflicts"] = [];
  const rejectedDistinct: MergeResult["rejectedDistinct"] = [];
  const honorificMerges: MergeResult["honorificMerges"] = [];
  /** 統合先を決められず新規にした組。作者の判断へ回す */
  const ambiguousPairs: Array<{
    names: [string, string];
    ids: [string, string];
  }> = [];

  for (const item of extracted) {
    const ex = item.data;
    if (!ex.name || !ex.name.trim()) continue;

    const lookup = findCharacter(result, ex.name, ex.aliases ?? []);
    const match = lookup.match;

    if (!match) {
      const c = emptyCharacter(nextCharacterId(result), ex.name.trim());
      applyExtracted(
        c,
        ex,
        item.chapters,
        conflicts,
        otherRecordNames(result, c)
      );
      result.push(c);
      added.push(c.name);
      changedIds.add(c.id);
      // 統合先が複数あって決められなかった場合、データは残しつつ
      // 「どれかと同じかもしれない」ことを作者へ伝える。
      // 黙って新規にすると重複が増えるだけで気づけない。
      for (const other of lookup.ambiguous) {
        if (isDeclaredDistinct(c, other)) continue;
        ambiguousPairs.push({ names: [c.name, other.name], ids: [c.id, other.id] });
      }
      continue;
    }

    // 同名の相手が他にもいた場合、寄せ先へ統合したうえで
    // 「これらも同じかもしれない」と作者へ伝える。
    // 統合そのものは作者が決める（誤統合は取り返しがつかない）
    // 作者が「別人だ」と決めた組は、ここでも作者へ回さない（設計書6.5.8）。
    // 回すと「同じかもしれません」と毎回聞かれ、分けた判断が尊重されない
    for (const other of lookup.ambiguous) {
      if (isDeclaredDistinct(match, other)) continue;
      ambiguousPairs.push({ names: [match.name, other.name], ids: [match.id, other.id] });
    }

    // 作者が「別人だ」と決めた相手の呼び名が付いた候補は、まるごと取り込まない。
    //
    // **呼び名だけ外すのでは足りなかった**（`withoutDistinctNames`）。
    // 実データでは、冒険者アジャーノのレコードへ皇子の場面から作った候補
    // （name=アジャーノ / aliases=[殿下] / summary=「帝国の皇子…」）が届き、
    // 別名の「殿下」は弾いたのに、紹介文・役割・一人称・呼称・登場話数は
    // そのまま積まれて、冒険者の紹介文が皇子のものへ書き換わった
    // （2026-08-27に作者が発見。「違う話の値どうしは最後の話の値を本体へ」の
    // 規則が、別人の値に対してそのまま働いた）。
    //
    // 分けた相手の呼び名が付いていること自体が、AIが2人を混ぜた強いシグナルである。
    // **作者の判断はAIの読みより強い**（実装ルール2）ので、候補ごと捨てる。
    // 登場話数の追記もしない——それも別人の場面から来た値であるため。
    const blockedNames = distinctKeys(match);
    const blockedName = [ex.name, ...(ex.aliases ?? [])]
      .filter((name): name is string => Boolean(name && name.trim()))
      .find((name) => blockedNames.has(normalizeName(name)));
    if (blockedName !== undefined) {
      // 何を取り込まなかったかは完了報告に出す（黙って捨てたことにしない）
      rejectedDistinct.push({
        characterName: match.name,
        blockedName,
        chapters: [...item.chapters],
      });
      continue;
    }

    // 敬称の違いだけで既存レコードへ寄せた分を数える（設計書6.5.9）。
    // **AIは敬称違いを aliases に返さない**ので、寄せているのはコードである。
    // 報告に出さないと、作者からは「新しい人物が増えなかった」としか見えない
    const honorificMerge = describeHonorificMerge(match, ex.name);
    if (honorificMerge) honorificMerges.push(honorificMerge);

    // 作者が確定させた人物はAIで書き換えない。
    // 登場話数の追記だけ行う。
    if (!match.autoGenerated) {
      const before = match.appearedChapters.length;
      match.appearedChapters = mergeChapters(
        match.appearedChapters,
        item.chapters
      );
      if (match.appearedChapters.length !== before) {
        updated.push(match.name);
        changedIds.add(match.id);
      }
      continue;
    }

    const changed = applyExtracted(
      match,
      ex,
      item.chapters,
      conflicts,
      otherRecordNames(result, match)
    );
    if (changed) {
      if (!updated.includes(match.name)) updated.push(match.name);
      changedIds.add(match.id);
    }
  }

  // 話数の違う値は、作者に聞かずに作中の変化として畳む。
  // 聞いていた頃は、話ごとに違う言い方をされた要約がすべて食い違いとして
  // 積み上がり、資料が読めなくなっていた（実データで太志のsummaryが9段）。
  // **同じ話の中で矛盾しているものだけを作者へ回す**（`isFoldableConflict`）。
  //
  // 今回触れなかった人物にも掛ける。既に積み上がっている食い違いを
  // 畳むのが目的なので、対象を今回の更新分に絞ると古い分が残り続ける。
  const folded: MergeResult["folded"] = [];
  for (let index = 0; index < result.length; index++) {
    const character = result[index];
    // 作者が確定させたレコードは、こちらから書き換えない
    if (!character.autoGenerated) continue;
    const outcome = foldCharacterConflicts(character);
    if (outcome.folded.length === 0) continue;
    result[index] = outcome.character;
    changedIds.add(outcome.character.id);
    if (!updated.includes(outcome.character.name)) {
      updated.push(outcome.character.name);
    }
    for (const field of outcome.folded) {
      folded.push({ characterName: outcome.character.name, field });
    }
  }

  return {
    characters: result,
    added,
    updated,
    changedIds: [...changedIds],
    // 立てた直後に畳んだものは、作者の判断待ちではない。
    // 報告に残すと「見てください」と言われた先に何も無いことになる
    conflicts: conflicts.filter(
      (entry) =>
        !folded.some(
          (item) =>
            item.characterName === entry.characterName &&
            item.field === entry.field
        )
    ),
    folded,
    rejectedDistinct,
    honorificMerges,
    mergeCandidates: [
      ...ambiguousPairs.map((pair) => ({
        ...pair,
        reason: "ambiguous" as const,
      })),
      ...findMergeCandidates(result),
    ],
  };
}

/**
 * その人物以外のレコードの「名前」を、空白を落とした形で集める。
 *
 * 別名として取り込んでよいかの歯止めに使う。**名前だけを見る**——
 * 別名まで見ると、家族が共有する姓や肩書きで正しい呼び名まで落ちる。
 */
function otherRecordNames(
  characters: readonly Character[],
  self: Character
): Set<string> {
  const names = new Set<string>();
  for (const character of characters) {
    if (character.id === self.id) continue;
    const key = normalizeSpacing(character.name);
    if (key) names.add(key);
  }
  return names;
}

/**
 * 抽出の名前が、敬称の違いだけで既存レコードと一致したか（設計書6.5.9）。
 *
 * 書かれたままの形（空白だけ落とす）では一致しないのに、敬称を外すと
 * 一致する場合に限る。当てはまらなければ undefined。
 *
 * **寄せる判定そのものはここでは行わない。** 寄せ先を決めるのは
 * `findCharacter`（`normalizeName` が敬称を吸収する）であり、
 * ここはその結果が敬称違いだったかを見分けて報告へ回すだけである。
 * 判定を二重に持つと、片方だけ直したときに件数と実態がずれる。
 */
function describeHonorificMerge(
  match: Character,
  incomingName: string | undefined
): MergeResult["honorificMerges"][number] | undefined {
  const raw = incomingName?.trim();
  if (!raw) return undefined;
  const incoming = normalizeSpacing(raw);
  const known = [match.name, ...match.aliases].map(normalizeSpacing);
  // 既にその形で登録されているなら、敬称の違いで寄せたわけではない
  if (known.includes(incoming)) return undefined;
  const stripped = stripHonorific(incoming);
  if (!known.some((name) => stripHonorific(name) === stripped)) return undefined;
  return { characterName: match.name, incomingName: raw };
}

/**
 * 抽出結果を1人分のレコードへ反映する。
 * 既存の値を消さないことを原則とし、食い違いは conflicts に記録する。
 */
function applyExtracted(
  target: Character,
  ex: ExtractedCharacter,
  chapters: number[],
  conflicts: MergeResult["conflicts"],
  /**
   * ほかの既存レコードの名前（空白を落とした形）。
   * **そこに載っている名前は別名として取り込まない**（設計書6.5.9）。
   */
  otherRecordNames: ReadonlySet<string> = new Set()
): boolean {
  let changed = false;
  const validChapters = chapters.filter(Number.isFinite);

  // 別名は和集合。
  // 抽出時の名前が既存レコードと異なる場合（「玲司」で照合されたが
  // 登録名が「黒木 玲司」など）、その呼び名も別名として残す。
  //
  // **作者が「別人だ」と決めた呼び名は足さない**（設計書6.5.8）。
  // 抽出は毎回まっさらな目で本文を読むので、分けた翌日にはまた
  // 「アジャン＝アジャーノ」と返してくる。ここで受け取ると別名が戻り、
  // 用語ハイライトもIME辞書も1人に戻る。
  const aliases = new Set(target.aliases);
  const incomingName = ex.name?.trim();
  const incoming = withoutDistinctNames(target, [
    ...(incomingName ? [incomingName] : []),
    ...(ex.aliases ?? []).filter((a): a is string => Boolean(a)),
  ]);
  const ownKey = normalizeSpacing(target.name);
  const existingKeys = new Set([...aliases].map(normalizeSpacing));
  for (const a of incoming) {
    const key = normalizeSpacing(a);
    // **ほかのレコードの「名前」は別名にしない。**
    // 別人の名前が別名に入ると、その2人は「同じ呼び名を持つ」ことになり、
    // 「重複をまとめる」に別人どうしの組が並ぶ（実データで12件）。
    if (otherRecordNames.has(key)) continue;
    // 「密倉文佳」と「密倉 文佳」を別の呼び名として増やさない（設計書6.5.9）
    if (key === ownKey || existingKeys.has(key)) continue;
    aliases.add(a);
    existingKeys.add(key);
    changed = true;
  }
  target.aliases = [...aliases];

  if (ex.isMob === true && !target.isMob) {
    target.isMob = true;
    changed = true;
  }

  // 読みはカタカナならコード側で確実に作る。
  // 漢字を含む名前だけAIの推定（ex.reading）に委ねる
  changed =
    fillOrConflict(target, "reading", ex.reading, validChapters, conflicts) || changed;
  const derived = fillReading(target.reading, target.name);
  if (derived !== target.reading) {
    target.reading = derived;
    changed = true;
  }

  // 紹介文は長さをコード側で確かめてから入れる。
  // プロンプトで字数を指示しても、モデルは平気で超えてくる
  changed =
    fillOrConflict(target, "summary", clampSummary(ex.summary), validChapters, conflicts) ||
    changed;
  changed =
    fillOrConflict(target, "affiliation", ex.affiliation, validChapters, conflicts) || changed;

  // 性別はAIが本文の言い方のまま返してくるので、ここで「男性」「女性」に揃える。
  // 揃えないと、同じ人物が話ごとに「男」「男性」と揺れて食い違い扱いになる
  changed =
    fillOrConflict(target, "gender", normalizeGender(ex.gender), validChapters, conflicts) ||
    changed;

  // 単純なテキスト項目: 空なら埋める。既にあれば食い違いを記録し、上書きしない
  changed = fillOrConflict(target, "role", ex.role, validChapters, conflicts) || changed;
  changed =
    fillOrConflict(target, "personality", ex.personality, validChapters, conflicts) || changed;
  changed =
    fillOrConflict(target, "appearance", ex.appearance, validChapters, conflicts) || changed;

  // 一人称
  if (ex.firstPerson) {
    if (!target.firstPerson.default) {
      target.firstPerson.default = ex.firstPerson;
      changed = true;
    } else if (target.firstPerson.default !== ex.firstPerson) {
      // 場面によって変わることがあるため、矛盾ではなく変化形として保持する
      const exists = target.firstPerson.variants.some(
        (v) => v.form === ex.firstPerson
      );
      if (!exists) {
        target.firstPerson.variants.push({
          form: ex.firstPerson,
          context: null,
          chapters: [...validChapters],
          evidence: ex.evidence ?? null,
        });
        changed = true;
      }
    }
  }

  if (ex.defaultSecondPerson && !target.defaultSecondPerson) {
    target.defaultSecondPerson = ex.defaultSecondPerson;
    changed = true;
  }

  // 呼称: 相手ごとにまとめ、異なる呼び方はすべて残す
  for (const at of ex.addressTerms ?? []) {
    if (!at.targetName || !at.term) continue;
    if (mergeAddressTerm(target, at, validChapters)) changed = true;
  }

  // 関係。**同じ相手のぶんはまとめる**（設計書6.5.9）。
  // 話ごとに積むだけだと、124件のうち50件が同じ相手の重複になっていた
  // （三門太志は23件で相手は12人。「ばあさん」「おばあさん」だけで6件）。
  // 一覧が読めなくなるうえ、AIへ渡す資料も水増しされる
  const incomingRelations = (ex.relations ?? []).filter(
    (rel) => rel.name && rel.relation
  );
  const mergedRelations = dedupeRelations([
    ...target.relations,
    ...incomingRelations.map((rel) => ({
      name: rel.name,
      relation: rel.relation,
    })),
  ]);
  if (!sameRelations(target.relations, mergedRelations)) {
    target.relations = mergedRelations;
    changed = true;
  }

  if (!target.evidence && ex.evidence) {
    target.evidence = ex.evidence;
    changed = true;
  }

  const before = target.appearedChapters.length;
  target.appearedChapters = mergeChapters(target.appearedChapters, validChapters);
  if (target.appearedChapters.length !== before) changed = true;

  return changed;
}

/**
 * 同じ相手との関係を1つにまとめる（設計書6.5.9）。
 *
 * **相手の名前は揺れる。** 「ばあさん」「おばあさん」「お婆さん」は同じ人で、
 * 話ごとの抽出はそのときの言い方をそのまま返す。敬称と丁寧の「お」を
 * 落とした形で揃えて数える。
 *
 * **関係の文字列が違えば両方残す。** 「憑依している」と「同一人物（転生後）」は
 * 同時には成り立たないが、まとめてしまうと**矛盾に気づけなくなる**。
 * 片方を捨てるのはコードの仕事ではない。
 *
 * 表示に使う名前は**先に出てきた形**を残す。作者が読むのは資料なので、
 * こちらで正規化した形（「ばあ」）を書き込んではいけない。
 */
export function dedupeRelations(
  relations: ReadonlyArray<{ name: string; relation: string }>
): Array<{ name: string; relation: string }> {
  const seen = new Set<string>();
  const result: Array<{ name: string; relation: string }> = [];
  for (const relation of relations) {
    const name = relation.name.trim();
    const value = relation.relation.trim();
    if (!name || !value) continue;
    // 区切りにNULを使うのは、名前にも関係にも現れない文字だから。
    // ソースには生のNULを置かずエスケープで書く（生のまま置くと
    // gitやgrepがこのファイルをバイナリとみなす）
    const key = `${relationTargetKey(name)}\u0000${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ name, relation: value });
  }
  return result;
}

/** 関係の相手を数えるときの鍵。敬称と丁寧の「お」を落とす */
function relationTargetKey(name: string): string {
  return stripPolitePrefix(normalizeName(name));
}

/** 関係の一覧が同じ中身か。無駄な保存を避けるために見る */
function sameRelations(
  left: ReadonlyArray<{ name: string; relation: string }>,
  right: ReadonlyArray<{ name: string; relation: string }>
): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (item, index) =>
      item.name === right[index].name && item.relation === right[index].relation
  );
}

/**
 * 呼称をマージする。
 *
 * 同じ term は1件に統合するが、異なる term は統合しない。
 * 「澪」と「白瀬さん」を1つにまとめてはならない。呼び分けそのものが
 * 管理対象の情報であるため。
 */
function mergeAddressTerm(
  target: Character,
  incoming: NonNullable<ExtractedCharacter["addressTerms"]>[number],
  chapters: number[]
): boolean {
  let entry: AddressTerm | undefined = target.addressTerms.find(
    (a) => normalizeName(a.targetName) === normalizeName(incoming.targetName)
  );

  if (!entry) {
    entry = {
      targetName: incoming.targetName,
      targetId: null,
      forms: [],
      authorLocked: false,
    };
    target.addressTerms.push(entry);
  }

  // 作者がロックした呼称は触らない
  if (entry.authorLocked) return false;

  const chapter = chapters.length > 0 ? Math.min(...chapters) : null;
  const lastChapter = chapters.length > 0 ? Math.max(...chapters) : null;

  const existingForm = entry.forms.find((f) => f.term === incoming.term);
  if (existingForm) {
    let changed = false;
    if (
      chapter !== null &&
      (existingForm.firstChapter === null || chapter < existingForm.firstChapter)
    ) {
      existingForm.firstChapter = chapter;
      changed = true;
    }
    if (
      lastChapter !== null &&
      (existingForm.lastChapter === null ||
        lastChapter > existingForm.lastChapter)
    ) {
      existingForm.lastChapter = lastChapter;
      changed = true;
    }
    if (!existingForm.context && incoming.context) {
      existingForm.context = incoming.context;
      changed = true;
    }
    return changed;
  }

  entry.forms.push({
    term: incoming.term,
    category: incoming.category ?? null,
    context: incoming.context ?? null,
    firstChapter: chapter,
    lastChapter: lastChapter,
    status: "current",
    evidence: incoming.evidence ?? null,
  });
  return true;
}

/**
 * 空なら埋め、既存値と違えば「作中の変化」か「食い違い」に振り分ける。
 *
 * **振り分けの基準は話数である**（設計書6.18、2026-08-16）。
 *   - 第1話で「黒髪」、第7話で「銀髪」→ 作中で変わったと読む。両方を履歴に残し、
 *     レコードにはいちばん後ろの話の値を入れる
 *   - 同じ第7話で「黒髪」と「銀髪」→ 両方が同時に正しいことはない。
 *     AIの取り違えの可能性が高いので、これまでどおり作者の判断へ回す
 *
 * かつては違う値を必ず食い違いにしていたが、話ごとに違う言い方をされた要約が
 * すべて積み上がり、資料が読めなくなっていた（実データで太志のsummaryが9段）。
 *
 * **既存の値は消えない。** 変化の履歴に残り、資料には
 * 「A（第1話）→ B（第7話）」と両方が並ぶ。
 */
function fillOrConflict(
  target: Character,
  field: CharacterTextField,
  incoming: string | null | undefined,
  /** この値が出てきた話数。食い違いを『変化』として読めるようにする */
  chapters: number[],
  conflicts: MergeResult["conflicts"]
): boolean {
  const value = incoming?.trim();
  if (!value) return false;
  // 「（本文から読み取れる記述なし）」のような、値が無いことを述べた文言は
  // 空欄と同じ扱いにする。そのまま入れると設定資料へ載ってしまう
  if (!isMeaningfulValue(value)) return false;

  // **読み仮名は作中で変わらない**（CLAUDE.md 実装ルール2）。
  // 違う読みが出たらAIの読み違いなので、「作中の変化」として畳まず、
  // 必ず作者の判断（`conflicts`）へ回す。畳んでいた頃は、年表に
  // 「読み：たいし → たし」という起きていない変化が並んでいた（実データ）
  const foldable = !isUnchangingField(field);

  const current = target[field];
  if (!current) {
    target[field] = value;
    // **空欄を埋めるときにも話数を残す。** 残さないと、次に違う値が来たときに
    // 「作中で変わった」のか「同じ話で矛盾した」のかを見分けられない。
    // 変わらない項目では、そもそも変化として並べないので残さない
    if (foldable) recordValue(target.changes, field, value, chapters);
    return true;
  }

  // 既に履歴にある値。話数を足し、いちばん後ろの話の値を今の値にする。
  // 作者が確定させた変化を食い違いへ戻さないのも、この経路である
  if (foldable && hasChange(target.changes, field, value)) {
    const noted = recordChangeChapters(target.changes, field, value, chapters);
    return adoptLatest(target, field) || noted;
  }

  if (current === value) {
    // 履歴に無い（この項目より前に作られたデータ）。ここで話数が分かるので残す
    const recorded = target.conflicts.find((c) => c.field === field);
    if (recorded) return recordObservation(recorded, value, chapters);
    // 変わらない項目は変化として並べないので、履歴も作らない
    if (!foldable) return false;
    return recordValue(target.changes, field, value, chapters);
  }

  // 短い記述が長い記述に含まれる場合は、詳細な方を採用する。
  // これは変化ではないので履歴を増やさず、同じ記録を書き換える。
  //
  // **読み仮名では使わない。** 「ふみか」と「みっくらふみか」はどちらかが
  // 読み違いで、詳しく書き直したものではない。作者に選ばせる
  if (foldable && value.includes(current)) {
    target[field] = value;
    refineValue(target.changes, field, current, value, chapters);
    return true;
  }
  if (foldable && current.includes(value)) return false;

  // ここから先は本当に違う値。話数が重ならなければ作中の変化として扱う。
  // **両方の話数が分かっているときだけ。** 片方でも分からないと前後を
  // 決められず、作者が手で書いた値をAIの読みで押し流しかねない
  const currentChapters = chaptersOfValue(target.changes, field, current);
  if (
    foldable &&
    currentChapters?.length &&
    chapters.length &&
    !overlaps(currentChapters, chapters)
  ) {
    recordValue(target.changes, field, value, chapters);
    adoptLatest(target, field);
    return true;
  }

  const already = target.conflicts.find((c) => c.field === field);
  if (already) {
    const isNewValue = !already.values.includes(value);
    if (isNewValue) already.values.push(value);
    // 同じ値が別の話にも出てきたら、話数だけを足す
    const noted = recordObservation(already, value, chapters);
    if (!isNewValue) return noted;
    conflicts.push({
      characterName: target.name,
      field,
      values: already.values,
    });
    return true;
  }

  target.conflicts.push({
    field,
    values: [current, value],
    chapters: [...target.appearedChapters],
    note: null,
    // 値ごとの話数を残す。並べれば「作中で変わった」のか
    // 「AIが取り違えた」のかを作者が読み分けられる。
    // 履歴に無い古いデータでは、先にあった値の話数が分からないので空にする
    observations: [
      { value: current, chapters: [...(currentChapters ?? [])] },
      { value, chapters: [...chapters] },
    ],
  });
  conflicts.push({
    characterName: target.name,
    field,
    values: [current, value],
  });
  return true;
}

/** 1つの値を人物へ入れた結果（`insertFieldValue`） */
export interface FieldInsertResult {
  /** 入れたあとの人物。**元のレコードは書き換えない** */
  character: Character;
  /** 何かが変わったか。false なら保存する必要も無い */
  changed: boolean;
  /** 空欄を埋めたか */
  filled: boolean;
  /** 既存の値と食い違い、作者の判断待ちになったか */
  conflicted: boolean;
}

/**
 * 1つの値を、抽出と同じマージ規則にのせて人物へ入れる（設計書6.31.2）。
 *
 * はじいた記述を本来の人物へ挿入する操作（「AIで再読込」）のために、
 * `fillOrConflict` を1件だけ呼べるようにしたもの。
 * **規則を書き写さない。** 空欄なら埋め、値が違えば上書きせず
 * 食い違い（作者の判断待ち）へ回す、という判断は1か所にしかない。
 *
 * 話数は分かるときだけ渡す。分からないまま適当な話数を付けると、
 * 起きていない「作中の変化」が資料に載る（設計書6.18）。
 */
export function insertFieldValue(
  character: Character,
  field: CharacterTextField,
  value: string,
  chapters: number[] = []
): FieldInsertResult {
  // 呼び出し側のレコードを書き換えない。fillOrConflict は
  // 変化・食い違いの中身まで直に触るので、配列の要素まで写す
  const target: Character = {
    ...character,
    changes: character.changes.map((change) => ({
      ...change,
      chapters: [...change.chapters],
    })),
    conflicts: character.conflicts.map((conflict) => ({
      ...conflict,
      values: [...conflict.values],
      chapters: [...conflict.chapters],
      observations: conflict.observations?.map((observation) => ({
        ...observation,
        chapters: [...observation.chapters],
      })),
    })),
  };

  const before = target[field];
  const reported: MergeResult["conflicts"] = [];
  const changed = fillOrConflict(target, field, value, chapters, reported);

  return {
    character: target,
    changed,
    filled: !before && Boolean(target[field]),
    conflicted: reported.length > 0,
  };
}

/**
 * 履歴のうち、いちばん後ろの話に出てきた値をレコード本体へ入れる。
 *
 * 入れ直さないと、資料の「外見」が第1話の姿のまま止まる。
 * 話数の分かる値が1つも無ければ何もしない（順序を決められないため）。
 */
function adoptLatest(target: Character, field: CharacterTextField): boolean {
  const latest = latestValueOfField(target.changes, field);
  if (!latest || latest === target[field]) return false;
  target[field] = latest;
  return true;
}

/**
 * 作者が「別人だ」と決めた相手の呼び名（設計書6.5.8）。
 *
 * **敬称を落とした形で持つ。** 抽出は「アジャーノ」とも「アジャーノさん」とも
 * 返してくるので、書かれたままで比べると片方がすり抜ける。
 */
function distinctKeys(character: Character): Set<string> {
  return new Set(
    (character.distinctFrom ?? []).map((entry) => normalizeName(entry.name))
  );
}

/**
 * この2人は、作者が「別人だ」と決めた組か。
 *
 * **片側だけ見ればよい形にしない。** 分ける操作は両方へ記録を入れるが、
 * 作者が片方のJSONを手で直したときに、記録が片側だけになりうる。
 * どちらかが「別人だ」と言っていれば別人として扱う——
 * **作者の判断は、AIの読みより強い**（実装ルール2）。
 */
function isDeclaredDistinct(a: Character, b: Character): boolean {
  if (a.id === b.id) return false;
  const fromA = a.distinctFrom ?? [];
  const fromB = b.distinctFrom ?? [];
  return (
    fromA.some(
      (entry) =>
        entry.id === b.id ||
        [b.name, ...b.aliases].some(
          (name) => normalizeName(name) === normalizeName(entry.name)
        )
    ) ||
    fromB.some(
      (entry) =>
        entry.id === a.id ||
        [a.name, ...a.aliases].some(
          (name) => normalizeName(name) === normalizeName(entry.name)
        )
    )
  );
}

/**
 * 抽出結果の呼び名のうち、このレコードが「別人のもの」と決めたものを外す。
 *
 * 抽出はレコードを知らないので、**まだレコードになっていない呼び方**
 * （分けたばかりで本文からしか出てこない名前）も来る。名前で突き合わせる。
 */
function withoutDistinctNames(
  target: Character,
  names: readonly string[]
): string[] {
  const blocked = distinctKeys(target);
  return names.filter((name) => !blocked.has(normalizeName(name)));
}

/**
 * 統合先の探索結果。
 *
 * 「どれに統合すべきか決まらない」ことと「一致するものが無い」ことを
 * 区別する。前者で黙って新規レコードを作ると、既存2件に加えて3件目ができ、
 * 重複がかえって増えるため（実データで確認）。
 */
interface CharacterLookup {
  match?: Character;
  /** 複数一致して決められなかった相手。作者に提示する */
  ambiguous: Character[];
}

function findCharacter(
  list: Character[],
  name: string,
  aliases: string[]
): CharacterLookup {
  const incomingNames = [name, ...aliases];
  const keys = new Set(incomingNames.map(normalizeName));

  // 作者が「別人だ」と決めた呼び名では引き当てない（設計書6.5.8）。
  //
  // **ここを塞がないと、分ける操作は無意味になる。** 抽出は毎回まっさらな
  // 目で本文を読むので、「アジャン」と「アジャーノ」をまた1人として返す。
  // 名前で引き当てた先が「その名前は別人のものだ」と言っているなら、
  // そのレコードは候補から外す。
  const usable = list.filter((c) => !distinctKeys(c).has(normalizeName(name)));

  const exactMatches = usable.filter((c) => {
    // レコード側が別人だと決めた呼び名は、そのレコードの呼び名として使わない。
    // 作者が手でJSONを直したときなど、別名に残ったままのことがある
    const blocked = distinctKeys(c);
    const candidates = [c.name, ...c.aliases]
      .map(normalizeName)
      .filter((candidate) => !blocked.has(candidate));
    return candidates.some((candidate) => keys.has(candidate));
  });
  if (exactMatches.length === 1) return { match: exactMatches[0], ambiguous: [] };
  if (exactMatches.length > 1) {
    // 主たる名前がそのまま一致する相手だけを寄せ先の候補にする。
    const key = normalizeName(name);
    const samePrimaryName = exactMatches.filter(
      (character) => normalizeName(character.name) === key
    );

    if (samePrimaryName.length > 0) {
      // **同じ名前のレコードが既に複数あるのに、さらに新規を作ってはいけない。**
      // 3件目の別名が次回さらに多くのレコードと一致し、
      // 実行のたびに重複が増える。実データで「密倉 文佳」が3件、
      // 「お母さん」が4件に分裂した。
      //
      // 1件へ寄せたうえで、残りを統合候補として作者に見せる。
      const best =
        samePrimaryName.find((character) => !character.autoGenerated) ??
        samePrimaryName[0];
      return {
        match: best,
        ambiguous: exactMatches.filter((character) => character !== best),
      };
    }

    // 別名でしか一致しない場合は寄せ先を決めない。
    // 「黒木」と「白木」が同じ別名「玲司」を持つとき、どちらへ寄せても
    // 半分は誤りで、しかも既存レコードを汚す。
    // 新規として残せば作者が見て判断できる（誤統合は取り消しにくい）。
    return { ambiguous: exactMatches };
  }

  // 部分名は、姓名が空白・中黒で明示的に区切られている場合だけ使う。
  // 推測による部分一致は別人を壊すため、候補が一人に決まる場合に限る。
  //
  // **ただし、複数の人物が共有する部分（＝姓）では同一人物と判定しない。**
  // 実データで「ジェクティ・コンストラクタ」「ヴォイド・コンストラクタ」
  // 「イント・コンストラクタ」（母・父・息子）が、姓だけの「コンストラクタ」
  // という1件へまとめられた。姓だけのレコードが先にできると、家族が
  // 1人ずつ「候補が一人に決まる」判定を通ってしまい、次々に吸収される。
  const shared = sharedNameParts(list);
  const incomingParts = new Set(
    incomingNames.flatMap(splitNameParts).filter((part) => !shared.has(part))
  );
  const usableKeys = new Set([...keys].filter((key) => !shared.has(key)));

  const partMatches = usable.filter((character) =>
    [character.name, ...character.aliases].some((candidate) =>
      incomingParts.has(normalizeName(candidate)) ||
      splitNameParts(candidate).some((part) => usableKeys.has(part))
    )
  );
  if (partMatches.length === 1) return { match: partMatches[0], ambiguous: [] };
  return { ambiguous: partMatches.length > 1 ? partMatches : [] };
}

/**
 * 姓（家名）とみられる部分を集める。
 *
 * **姓は同一人物の証拠にならない。** 「イント・コンストラクタ」と
 * 「ストリナ・コンストラクタ」は別人であり、共有しているのは家名である。
 *
 * ## 語順で決めない
 *
 * 姓が先か名が先かは作品による（中黒区切りは「名・姓」、和名の空白区切りは
 * 「姓 名」）。**判定に語順を使わない。**
 *
 * ## 「何人が持っているか」ではなく「何と組んでいるか」で決める
 *
 * 人数で数えると、**同じ人物の重複レコードで名のほうも姓に見えてしまう。**
 * 実データでは「ヴォイド・コンストラクタ」が3件に分裂しており、
 * 人数で数えると「ヴォイド」まで姓と判定された。そうなると
 * 「ヴォイド」だけで呼ばれたときに本人へ寄せられなくなる。
 *
 * 組んだ相手の種類で数えれば、重複しても相手は同じなので増えない。
 * 実データ84人で、コンストラクタ4・フォートラン4・シーゲン3（いずれも家名）と、
 * ヴォイド1・ポインタ1（いずれも名）がきれいに分かれた。
 */
export function sharedNameParts(characters: readonly Character[]): Set<string> {
  // 部分 → 一緒に並んでいた別の部分の種類
  const partners = new Map<string, Set<string>>();

  for (const character of characters) {
    for (const full of [character.name, ...character.aliases]) {
      const parts = splitNameParts(full);
      for (const part of parts) {
        const set = partners.get(part) ?? new Set<string>();
        for (const other of parts) {
          if (other !== part) set.add(other);
        }
        partners.set(part, set);
      }
    }
  }

  const shared = new Set<string>();
  for (const [part, others] of partners) {
    // 2種類以上と組んでいれば家名とみなす。
    // 1種類だけなら、その相手との組でしか出てこない＝名とみなす
    if (others.size >= 2) shared.add(part);
  }
  return shared;
}

// 省略はカタカナ語で起きやすい。漢字を含む名前の部分一致は
// 別人（「田中」と「田中村」等）の可能性が高いため対象にしない。
const KATAKANA_ONLY = /^[ァ-ヶーｦ-ﾟ]+$/u;
/** これ以上に長さが開く組は、省略ではなく別語とみなす */
const MAX_LENGTH_RATIO = 2.5;

/**
 * 省略形とみられる組を洗い出す。統合はしない。
 *
 * 日本語の省略は元の語から文字を順に抜き出す形が多い
 * （ギルドマスター → ギルマス）ため、部分列であることを手掛かりにする。
 */
export function findMergeCandidates(characters: Character[]): MergeCandidate[] {
  const candidates: MergeCandidate[] = [];
  const appellations = buildAppellationIndex(characters);
  const sharedCounts = countSharedAppellations(characters, appellations);

  for (let i = 0; i < characters.length; i++) {
    for (let j = i + 1; j < characters.length; j++) {
      const a = characters[i];
      const b = characters[j];

      // 作者が「別人だ」と決めた組は、候補に出さない（設計書6.5.8）。
      // **出すと、操作メニューの「重複をまとめる」に永久に1件が残る。**
      // 分けたのに「重複しています」と言われ続けるのは、直っていないのと同じ
      if (isDeclaredDistinct(a, b)) continue;

      // 別レコードなのに呼称が重なっている。
      //
      // **「ほぼ確実に同一人物」とは決め打ちできない**（実データで崩れた）。
      // 姓を共有する家族（「三門」を4人が持つ）と、別名の汚染
      // （文佳の別名に別人の「太志」が入る）で、候補20組の半分が別人だった。
      // 一致した呼び名を名指しし、姓や汚染の疑いがあれば確信度を落とす。
      const keys = new Map(
        (appellations.get(a.id) ?? []).map((name) => [normalizeName(name), name])
      );
      const matched = (appellations.get(b.id) ?? []).find((name) =>
        keys.has(normalizeName(name))
      );
      if (matched !== undefined) {
        // 表示は a 側の書き方に寄せる。同じ呼び名の表記ゆれを2つ並べない
        const shown = keys.get(normalizeName(matched)) ?? matched;
        const weakNote = weakSameNameNote(shown, a, b, sharedCounts);
        candidates.push({
          names: [a.name, b.name],
          ids: [a.id, b.id],
          reason: "same_name",
          matchedName: shown,
          confidence: weakNote ? "weak" : "strong",
          ...(weakNote ? { weakNote } : {}),
        });
        continue;
      }

      // 主たる名前どうしが同じで、それが誰にでも使う呼び方だった組。
      //
      // **上の網（`isGenericAppellation`）で根拠から外した分の受け皿である。**
      // 外しっぱなしにすると、実データで「お母さん」が4件へ割れていたような
      // **本当の重複を直す手立てが無くなる**（別名の一致では拾えず、
      // 長さが同じなので suffix・name_part にも掛からない）。
      // 根拠としては弱いので、確信度を落として断りを添える
      if (
        isGenericAppellation(a.name) &&
        normalizeName(a.name) &&
        normalizeName(a.name) === normalizeName(b.name)
      ) {
        candidates.push({
          names: [a.name, b.name],
          ids: [a.id, b.id],
          reason: "same_name",
          matchedName: a.name,
          confidence: "weak",
          weakNote: WEAK_GENERIC_WORD_NOTE,
        });
        continue;
      }

      // 敬称を外すと、もう一方のフルネームの姓になる組（設計書6.5.9）。
      // 「密倉さん」が「密倉文佳」とは別レコードとして立ってしまう形で、
      // 呼び名が重ならないので same_name にも掛からず、実データでは
      // 「重複をまとめる」の一覧にすら出てこなかった。
      //
      // **自動では寄せない。** 姓は家族で共有されるので、
      // 「密倉さん」が母や兄である可能性が残る
      const family = honorificFamilyNamePair(a, b, characters);
      if (family) {
        candidates.push({
          names: [family.short.name, family.full.name],
          ids: [family.short.id, family.full.id],
          reason: "honorific_family_name",
          matchedName: family.family,
          confidence: "medium",
        });
        continue;
      }

      // かなで書かれた呼び名が、もう一方の読み仮名と重なる組（設計書6.5.9）。
      // 実データで第4話だけ「フミカ」と書かれ、「密倉文佳」（読み「みくらふみか」）
      // とは**別名が漢字ばかりで突き合わせる道が無く**、候補にすら出なかった。
      // 読みは `fillReading` がひらがなで持つので、かなの側を揃えれば比べられる
      const reading = readingMatchPair(a, b, appellations);
      if (reading) {
        candidates.push({
          names: [reading.kana.name, reading.owner.name],
          ids: [reading.kana.id, reading.owner.id],
          reason: "reading_match",
          matchedName: reading.matchedName,
          matchedReading: reading.reading,
          confidence: reading.confidence,
          ...(reading.weakNote ? { weakNote: reading.weakNote } : {}),
        });
        continue;
      }

      const pairs = appellationPairs(a, b);

      if (pairs.some(([left, right]) => isAbbreviationOf(left, right))) {
        candidates.push({ names: [a.name, b.name], ids: [a.id, b.id], reason: "abbreviation" });
        continue;
      }

      if (pairs.some(([left, right]) => isSuffixCallOf(left, right))) {
        candidates.push({ names: [a.name, b.name], ids: [a.id, b.id], reason: "suffix" });
        continue;
      }

      if (pairs.some(([left, right]) => isFamilyNameForm(left, right))) {
        candidates.push({ names: [a.name, b.name], ids: [a.id, b.id], reason: "name_part" });
      }
    }
  }
  return candidates;
}

/**
 * 一方の名前から敬称を外すと、もう一方のフルネームの姓になる組か
 * （設計書6.5.9）。当てはまれば、敬称の付いた側・フルネームの側・姓を返す。
 *
 * **その姓を持つレコードが2人以上いれば、候補にもしない。** 家族である
 * 可能性が高く（実データでは「三門」を4人が持っていた）、並べたところで
 * 作者はどれと結べばよいか決められない。誤った統合を誘うだけになる。
 */
function honorificFamilyNamePair(
  a: Character,
  b: Character,
  characters: readonly Character[]
): { short: Character; full: Character; family: string } | undefined {
  const directions: Array<[Character, Character]> = [
    [a, b],
    [b, a],
  ];
  for (const [short, full] of directions) {
    const called = normalizeSpacing(short.name);
    const family = stripHonorific(called);
    // 敬称が付いていること。付いていない組は name_part 側が見る
    if (family === called) continue;
    // 1字の姓は「子」「田」のような字で無関係な組が並ぶ。
    // 4字以上は姓ではなく、名まで含んだ呼び方とみるほうが確からしい
    if (family.length < 2 || family.length > MAX_FAMILY_NAME_LENGTH) continue;

    const fullName = normalizeSpacing(full.name);
    if (fullName.length <= family.length) continue;
    if (!fullName.startsWith(family)) continue;
    const given = fullName.slice(family.length);
    // 姓も名も漢字であること。カタカナ名の省略は isAbbreviationOf が見るし、
    // ひらがなだけの語（「おばあ」「ちゃん」）を姓とみなさないためでもある
    if (!HAS_KANJI.test(family) || !HAS_KANJI.test(given)) continue;

    if (countFamilyNameOwners(characters, family) !== 1) continue;
    return { short, full, family };
  }
  return undefined;
}

/** かな（カタカナ・ひらがな）と長音符だけでできた語 */
const KANA_ONLY = /^[ぁ-ゖァ-ヶー]+$/u;
/** これより短いかなは、誰の読みにも一致してしまう（「ア」「ふ」） */
const MIN_KANA_APPELLATION_LENGTH = 2;

/**
 * かなで書かれた呼び名が、もう一方の読み仮名と重なる組か（設計書6.5.9）。
 *
 * 実データで第4話だけ「フミカ」と書かれ、単独レコードとして残った。
 * 「密倉文佳」側の別名は漢字ばかりで、**呼び名どうしを比べる限り
 * 突き合わせる道が無い**——読み（みくらふみか）だけが両者を繋ぐ。
 *
 * **自動では寄せない。** 同じ読みの名は別人でも起きる
 * （`honorific_family_name` と同じ考え）。姓の側で一致した組は、
 * 家族の可能性が高いのでさらに確信度を落とす。
 *
 * **読みを持ち出すのは、名前どうしを直接比べられないときだけ。**
 * 両方がかなだけの名前なら、部分の重なりは省略形（`abbreviation`）や
 * 後ろの重なり（`suffix`）が名前そのもので見る。そちらを覆い隠すと、
 * 「ギルドマスター」と「マスター」が「読み仮名と同じ音です」になる。
 */
function readingMatchPair(
  a: Character,
  b: Character,
  appellations: ReadonlyMap<string, string[]>
):
  | {
      kana: Character;
      owner: Character;
      matchedName: string;
      reading: string;
      confidence: "medium" | "weak";
      weakNote?: string;
    }
  | undefined {
  const directions: Array<[Character, Character]> = [
    [a, b],
    [b, a],
  ];
  for (const [kana, owner] of directions) {
    const reading = toDictionaryReading(owner.reading ?? "");
    if (!reading) continue;
    // もう一方もかなだけの名前なら、**部分の重なりは名前そのもので比べられる**。
    // 読みを持ち出すと「マスター」と「ギルドマスター」が
    // 「読み仮名と同じ音です」になり、省略形という本当の手掛かりを覆い隠す。
    // 音が丸ごと同じ組（「フミカ」と「ふみか」）だけは、
    // カタカナとひらがなをまたいで比べる判定が他に無いので拾う
    const ownerIsKana = KANA_ONLY.test(normalizeSpacing(owner.name));

    for (const appellation of appellations.get(kana.id) ?? []) {
      const bare = stripHonorific(normalizeSpacing(appellation));
      if (bare.length < MIN_KANA_APPELLATION_LENGTH) continue;
      if (!KANA_ONLY.test(bare)) continue;
      // 「お母さん」「あんた」は誰にでも使う。読みと重なっても根拠にならない
      if (isGenericAppellation(bare)) continue;
      const sound = toDictionaryReading(bare);
      if (!sound) continue;

      // 完全一致と「名」の部分の一致は同じ強さで見る。
      // 「みくらふみか」の末尾が「ふみか」なら、姓を省いた呼び方とみてよい
      if (
        sound === reading ||
        (!ownerIsKana && reading.endsWith(sound) && reading.length > sound.length)
      ) {
        return {
          kana,
          owner,
          matchedName: appellation,
          reading,
          confidence: "medium",
        };
      }
      if (ownerIsKana) continue;
      // 読みの頭で一致した組は姓の側。「ミクラ」は母や兄でもありうる
      if (reading.startsWith(sound) && reading.length > sound.length) {
        return {
          kana,
          owner,
          matchedName: appellation,
          reading,
          confidence: "weak",
          weakNote: WEAK_FAMILY_NAME_NOTE,
        };
      }
    }
  }
  return undefined;
}

/**
 * その姓を名乗るレコードが何件あるか（姓＋名の形のものだけ）。
 *
 * 「密倉さん」のように**姓に敬称が付いただけ**のレコードは数えない。
 * 数えると、寄せ先を探している当のレコード自身が2件目になってしまい、
 * 候補が永久に出なくなる。
 */
function countFamilyNameOwners(
  characters: readonly Character[],
  family: string
): number {
  let count = 0;
  for (const character of characters) {
    const name = normalizeSpacing(character.name);
    if (name.length <= family.length || !name.startsWith(family)) continue;
    if (stripHonorific(name) === family) continue;
    count++;
  }
  return count;
}

/**
 * 呼び名ごとに、それを持つレコードが何件あるかを数える。
 *
 * **姓は複数人が持つ。** 「三門」を三門太志・三門・三門の母・圭織の4人が、
 * 「密倉さん」を3人が持っていた（実データ）。同一人物の証拠として弱い印になる。
 */
function countSharedAppellations(
  characters: readonly Character[],
  appellations: Map<string, string[]>
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const character of characters) {
    const keys = new Set(
      (appellations.get(character.id) ?? []).map(normalizeName)
    );
    for (const key of keys) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/** 姓とみなせる件数。これ以上のレコードが同じ呼び名を持てば家名を疑う */
const SHARED_APPELLATION_LIMIT = 3;

/**
 * 呼び名が一致しただけの組を、どこまで信じてよいか。
 *
 * 弱いと判断したら理由の文言を返す。強ければ undefined。
 *
 * **姓かどうかは「前に付いているか」で見る。** 件数だけで数えると、
 * 「密倉文佳／文佳／密倉 文佳」のように**同じ人物が3件に割れているとき**まで
 * 姓扱いになり、いちばん直したい候補が弱くなる。「三門」は「三門太志」の
 * 頭に付くが、「文佳」は「密倉文佳」の後ろに付く。
 */
function weakSameNameNote(
  matched: string,
  a: Character,
  b: Character,
  sharedCounts: Map<string, number>
): string | undefined {
  const key = normalizeName(matched);
  const nameA = normalizeName(a.name);
  const nameB = normalizeName(b.name);

  // 両方のフルネームの頭が、その呼び名で揃っている（＝姓でしか繋がっていない）
  const prefixOfBoth =
    nameA.startsWith(key) &&
    nameB.startsWith(key) &&
    (nameA.length > key.length || nameB.length > key.length);
  if (prefixOfBoth) return WEAK_FAMILY_NAME_NOTE;

  // 3件以上が持っており、かつ誰かの名前の頭に付いている
  if ((sharedCounts.get(key) ?? 0) >= SHARED_APPELLATION_LIMIT) {
    const usedAsPrefix = [a, b].some((character) =>
      [character.name, ...character.aliases].some((name) => {
        const normalized = normalizeName(name);
        return normalized.startsWith(key) && normalized.length > key.length;
      })
    );
    if (usedAsPrefix) return WEAK_FAMILY_NAME_NOTE;
  }

  // 一致したのが相手のレコードの名前そのもので、しかも2人の名前が
  // 姓名の関係にない。**別名に別人の名前が混ざった形**である（設計書6.5.9）。
  // 「密倉文佳」と「文佳」のように名前どうしが繋がっている組は、
  // 正しい重複なのでここには落ちない
  const equalsWholeName = key === nameA || key === nameB;
  const namesRelated =
    nameA.endsWith(nameB) || nameB.endsWith(nameA) || nameA === nameB;
  if (equalsWholeName && !namesRelated) return WEAK_ALIAS_NOTE;

  return undefined;
}

/**
 * shorter が longer の後ろに含まれる呼び方か
 * （「ばあさん」と「近所のおばあさん」）。
 *
 * 日本語では、同じ人物を「近所のおばあさん」と説明的に書いたり、
 * 単に「ばあさん」と呼んだりする。AIは場面ごとに違う書き方を拾うため、
 * 別レコードになりやすい。実データで起きた（「いじめられっ子」）。
 *
 * `isAbbreviationOf` はカタカナ語の省略（ギルマス）専用なので、
 * ひらがな・漢字の呼び方は拾えない。
 *
 * **統合はしない。候補として出すだけ。** 別人の可能性は残るので、
 * 判断は作者に委ねる（`findMergeCandidates` の方針）。
 */
export function isSuffixCallOf(shorter: string, longer: string): boolean {
  // ここでは normalizeName を通さない。あれは敬称を落とすので
  // 「ばあさん」が「ばあ」になり、短すぎて判定できなくなる。
  // 呼び方そのものの重なりを見たいので、書かれたまま比べる
  const left = shorter.trim();
  const right = longer.trim();

  // 3字未満だと「先生」「さん」「たち」のような語で無関係な組が大量に並ぶ。
  // 候補が多すぎると作者が全部読まなくなり、機能そのものが死ぬ
  if (left.length < 3) return false;
  if (left.length >= right.length) return false;
  // 離れすぎた長さの組は、たまたま末尾が揃っただけのことが多い
  if (right.length / left.length > MAX_LENGTH_RATIO) return false;

  if (right.endsWith(left)) return true;

  // 「おばあさん」と「近所のばあさん」のように、
  // 丁寧の「お」の有無だけが違う場合も同じ呼び方とみなす
  const bare = stripPolitePrefix(left);
  return bare.length >= 3 && bare !== left && right.endsWith(bare);
}

/** 漢字を1文字でも含むか */
const HAS_KANJI = /[一-鿿㐀-䶿]/u;

/** 姓とみなせる長さ。「密倉」「三門」「春原」「長谷川」まで */
const MAX_FAMILY_NAME_LENGTH = 3;

/**
 * 姓名を繋げた名前と、名だけの名前か（「密倉文佳」と「文佳」）。
 *
 * **日本語の名前は空白で区切られないことが多い。** `splitNameParts` は
 * 空白・中黒がある場合しか分解しないので、「密倉文佳」からは何も取り出せず、
 * 後から「文佳」が出てきても別人として登録される（実データで起きた）。
 *
 * `isSuffixCallOf` は3字以上しか見ない。日本語の名は2字が多いので、
 * 「文佳」「月夜」「太志」はそこを通れない。3字の下限は
 * 「先生」「さん」のような語で候補が溢れるのを防ぐためだった。
 * そこでこちらは**漢字であること**を条件にして、2字から拾えるようにする。
 *
 * **統合はしない。候補として出すだけ。** 「太郎」と「金太郎」のように
 * 別人の可能性は残るので、判断は作者に委ねる（`findMergeCandidates` の方針）。
 */
export function isFamilyNameForm(shorter: string, longer: string): boolean {
  const left = shorter.trim();
  const right = longer.trim();

  // 1字だと「子」「郎」のような字で無関係な組が大量に並ぶ
  if (left.length < 2) return false;
  if (!right.endsWith(left)) return false;

  const family = right.slice(0, right.length - left.length);
  if (family.length < 1 || family.length > MAX_FAMILY_NAME_LENGTH) return false;

  // 姓と名の両方が漢字であること。カタカナ名の省略は isAbbreviationOf が見る。
  // ひらがなだけの語（「ちゃん」「さん」）を姓とみなさないためでもある
  return HAS_KANJI.test(left) && HAS_KANJI.test(family);
}

/**
 * 頭に付く丁寧の「お」「御」を落とす。
 * 「おばあさん」と「ばあさん」は同じ言い方の丁寧・くだけた形にすぎない。
 */
function stripPolitePrefix(name: string): string {
  return name.replace(/^[お御]/, "");
}

/**
 * その人物を指す呼称を、全レコードを横断して集める。
 *
 * **呼称は「呼ぶ側」のレコードに入る。** 「マルキオがリンセップを『リン』と呼ぶ」
 * という情報は、リンセップではなくマルキオのレコードに記録される。
 * そのため1人分のレコードだけを見ても、その人物が何と呼ばれているかは分からない。
 *
 * これを見落としていたため、AIが関連を正しく記録していたにもかかわらず、
 * 「リン」と「リンセップ・アウクト」が別人のまま残っていた（実データで確認）。
 *
 * ただし「姫」「殿下」のような肩書きだけの呼称、代名詞、家族関係語は、
 * 別人どうしでも一致してしまうため除く（`isGenericAppellation`）。
 */
export function buildAppellationIndex(
  characters: Character[]
): Map<string, string[]> {
  const index = new Map<string, string[]>();

  for (const character of characters) {
    const names = [character.name, ...character.aliases].filter((name) =>
      name.trim()
    );
    // 宛先の照合には、網を掛ける前の呼び名を使う。掛けたあとの形で照合すると、
    // 「お母さん」というレコードへ宛てた呼称がどこにも結び付かなくなる
    const ownKeys = new Set(names.map(normalizeName));
    // **網は名前と別名にも掛ける**（設計書6.5.9、実機確認A-18の2026-09-08）。
    // 掛かっていたのは呼称（addressTerms）だけで、別名に入り込んだ「僕」
    // 「あんた」「お嬢様」がそのまま「ほぼ確実に同一人物」の根拠になっていた
    const collected = new Set(
      names.filter((name) => !isGenericAppellation(name))
    );

    // 誰のレコードに書かれていても、宛先がこの人物なら呼称として扱う
    for (const speaker of characters) {
      for (const term of speaker.addressTerms) {
        if (!ownKeys.has(normalizeName(term.targetName))) continue;
        for (const form of term.forms) {
          if (isGenericAppellation(form.term)) continue;
          collected.add(form.term);
        }
      }
    }
    index.set(character.id, [...collected]);
  }

  return index;
}

/**
 * 誰にでも使える呼び方か。**同一人物の根拠にしない**（設計書6.5.9）。
 *
 * 3種類ある。
 *  - 肩書き・敬称だけ（「姫」「王女殿下」）……別の王女とも一致する
 *  - 代名詞（「僕」「あんた」）……話者が変われば別人を指す
 *  - 家族関係語（「お母さん」「ばあさん」）……同じ家の中で複数の人が持つ
 *
 * 代名詞と家族関係語は、実データで「ほぼ確実に同一人物」の根拠になっていた
 * （「密倉 文佳／三門太志＝僕」「太志／フミカ＝あんた」。どれも別人。
 * 実機確認A-18の2026-09-08）。
 */
function isGenericAppellation(term: string): boolean {
  // normalizeName は敬称を落とすので「王女殿下」→「王女」になる
  const normalized = normalizeName(term);
  if (!normalized) return true;
  // 「姫」「殿下」のように敬称そのもの1語だけの呼び方
  if (HONORIFIC_SUFFIX_SOURCE.includes(normalized)) return true;
  return TITLE_WORDS.has(normalized) || GENERIC_APPELLATIONS.has(normalized);
}

/**
 * 肩書きだけで人を特定できない語。別の王女とも一致してしまう。
 *
 * **書くときは作中の言い方のままでよい。** 照合は敬称を落とした形で
 * 行うので、一覧側も同じ形へ通してから持つ（下の `TITLE_WORDS`）。
 * 通す前は「お嬢様」「奥様」が書かれたまま入っており、照合の側は
 * 「お嬢」「奥」を見ていたので**一度も効いていなかった**
 * （実機確認A-18の2026-09-08）。あとから足す語が同じ罠を踏まないよう、
 * 揃えるのは一覧の側ではなく機械にやらせる。
 */
const TITLE_WORD_SOURCE = [
  "王女", "王子", "王", "女王", "国王", "皇帝", "皇后", "王妃",
  "姫君", "師匠", "隊長", "副隊長", "団長", "会長",
  "社長", "部長", "課長", "店長", "旦那", "奥様", "お嬢様",
];

const TITLE_WORDS = new Set(TITLE_WORD_SOURCE.map(normalizeName));

/**
 * 代名詞と家族関係語（`core/genericPersonWords.ts`）。
 * こちらも照合と同じ形へ通してから持つ（理由は `TITLE_WORD_SOURCE` と同じ）。
 */
const GENERIC_APPELLATIONS = new Set(
  [...PRONOUN_WORDS, ...KINSHIP_WORDS].map(normalizeName)
);

/** 2人の呼称の総当たりを、短い方・長い方の順で返す */
function appellationPairs(a: Character, b: Character): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const left of [a.name, ...a.aliases]) {
    for (const right of [b.name, ...b.aliases]) {
      pairs.push(
        left.length <= right.length ? [left, right] : [right, left]
      );
    }
  }
  return pairs;
}

/** shorter が longer の省略形とみられるか */
export function isAbbreviationOf(shorter: string, longer: string): boolean {
  if (shorter.length < 2 || shorter.length >= longer.length) return false;
  if (!KATAKANA_ONLY.test(shorter) || !KATAKANA_ONLY.test(longer)) return false;
  if (longer.length / shorter.length > MAX_LENGTH_RATIO) return false;
  // 省略形は語頭を残すのが普通。頭が違うものは別語とみなす
  if (shorter[0] !== longer[0]) return false;
  return isSubsequence(shorter, longer);
}

function isSubsequence(shorter: string, longer: string): boolean {
  let index = 0;
  for (const char of longer) {
    if (char === shorter[index]) index++;
    if (index === shorter.length) return true;
  }
  return index === shorter.length;
}

function splitNameParts(name: string): string[] {
  if (!/[\s　・･]/.test(name)) return [];
  return name
    .split(/[\s　・･]+/)
    .map(normalizeName)
    .filter(Boolean);
}

/**
 * 空白だけを落とした形（設計書6.5.9）。
 *
 * 「密倉文佳」と「密倉 文佳」を同じ名前として比べるためにある。
 * **敬称は落とさない。** 落とすと「文佳ちゃん」が「文佳」と同じになり、
 * 正しい別名まで取り込めなくなる。`normalizeName` との違いはそこにある。
 *
 * **保存する名前はこの形にしない。** 作者の書き方をそのまま残す。
 */
export function normalizeSpacing(s: string): string {
  return s.replace(/[\s　]/gu, "");
}

/**
 * 表記ゆれを吸収する。全角空白・記号の違いで別人扱いしないため。
 * 敬称の有無も同様の理由で吸収する（「シル」と「シルさん」を別人扱いしない）。
 *
 * **`stripHonorific` より緩い。** こちらは「おばあさん」を「おばあ」まで削る。
 * 呼び名を数える鍵（`dedupeRelations`）では、「おばあさん」と「ばあさま」を
 * 同じ相手として畳みたいので、そこまで削る必要がある。
 * 資料に残る名前を組み立てる場面では、`stripHonorific` のほうを使う。
 */
export function normalizeName(s: string): string {
  const base = s
    .replace(/[\s　・･]/g, "")
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase();

  for (const suffix of HONORIFIC_SUFFIXES) {
    if (base.endsWith(suffix) && base.length > suffix.length) {
      return base.slice(0, -suffix.length);
    }
  }
  return base;
}

function mergeChapters(existing: number[], incoming: number[]): number[] {
  const set = new Set(existing);
  for (const n of incoming) {
    // 話数は整数。`isFinite` だと 1.5 が通り、「第1.5話」と表示される。
    // 設定資料側（settingsMerge）と食い違っていたので揃えた
    if (Number.isSafeInteger(n)) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}
