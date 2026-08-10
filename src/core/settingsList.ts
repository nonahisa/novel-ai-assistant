import type { Character } from "../models/character";
import type { Ability } from "../models/ability";
import type { Location } from "../models/location";
import { membersOf, type Organization } from "../models/organization";
import { WORLD_CATEGORY_LABELS, type WorldItem } from "../models/world";

/**
 * 設定資料パネルの一覧に並べる1件。
 *
 * 画面（WebView）はここで作った並びをそのまま描く。
 * 並べ替えや振り分けを画面側のスクリプトに書くとテストが書けないため、
 * 判断はすべてこちらへ置く（`markdownLite` と同じ理由）。
 */
export interface SettingsListItem {
  id: string;
  name: string;
  /** 名前の下に出す補足。空なら出さない */
  sub: string;
  /**
   * 集団名詞・汎用役職名か。
   * 画面はこの印を見て、モブを畳んだ区画へ回す。
   */
  isMob: boolean;
}

/**
 * 登場人物の一覧を作る。
 *
 * **モブは末尾へ回す。** ネームドキャラを探しているときに
 * 「兵士たち」「冒険者」が間に挟まると目当ての名前を見つけにくい。
 * 消さずに末尾へ置くのは、モブも作者が中身を直せる対象だからである
 * （AIの判定が外れていれば、詳細欄のチェックで戻せる）。
 *
 * 並び順は元の順（＝ID順）を保つ。名前で並べ替えると、
 * 抽出のたびに一覧の位置が変わって作者が場所を覚えられない。
 */
export function buildCharacterListItems(
  characters: Character[]
): SettingsListItem[] {
  const items = characters.map((character) => ({
    id: character.id,
    name: character.name,
    sub: joinSub([
      character.summary ?? character.role ?? "",
      character.affiliation ?? "",
      noteCount(character.aiNotes.length),
    ]),
    isMob: character.isMob,
  }));

  // モブかどうかだけで分ける。それ以外の順序は入れ替えない
  return [...items.filter((item) => !item.isMob), ...items.filter((item) => item.isMob)];
}

export function buildAbilityListItems(abilities: Ability[]): SettingsListItem[] {
  return abilities.map((ability) => ({
    id: ability.id,
    name: ability.name,
    sub: joinSub([ability.category ?? "", noteCount(ability.aiNotes.length)]),
    // 能力と場所にモブの区別は無い
    isMob: false,
  }));
}

/**
 * 組織の一覧。名前の下に種別と所属人数を出す。
 *
 * 人数を出すのは、人物の所属から作られただけの
 * 中身が空の組織でも「誰がいるか」で見当が付くようにするため。
 */
export function buildOrganizationListItems(
  organizations: Organization[],
  characters: Array<{ name: string; affiliation: string | null }> = []
): SettingsListItem[] {
  return organizations.map((organization) => {
    const memberCount = membersOf(organization, characters).length;
    return {
      id: organization.id,
      name: organization.name,
      sub: joinSub([
        organization.summary ?? organization.category ?? "",
        memberCount > 0 ? `${memberCount}人` : "",
        noteCount(organization.aiNotes.length),
      ]),
      isMob: false,
    };
  });
}

/**
 * 世界観の一覧。名前の下に分類を出す。
 *
 * 見出しだけでは「詠唱の制約」が世界の法則の話か用語の説明か分からない。
 * 分類は資料の節の分かれ目でもあるので、一覧でも見えるようにする。
 */
export function buildWorldListItems(items: WorldItem[]): SettingsListItem[] {
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    sub: joinSub([
      WORLD_CATEGORY_LABELS[item.category] ?? "",
      noteCount(item.aiNotes.length),
    ]),
    isMob: false,
  }));
}

export function buildLocationListItems(locations: Location[]): SettingsListItem[] {
  return locations.map((location) => ({
    id: location.id,
    name: location.name,
    sub: joinSub([location.region ?? "", noteCount(location.aiNotes.length)]),
    isMob: false,
  }));
}

/** 一覧に出すモブの件数。0 なら区画そのものを出さない */
export function countMobs(items: SettingsListItem[]): number {
  return items.filter((item) => item.isMob).length;
}

function noteCount(count: number): string {
  return count > 0 ? `掘り下げ${count}` : "";
}

function joinSub(parts: string[]): string {
  return parts.filter((part) => part.trim()).join(" / ");
}
