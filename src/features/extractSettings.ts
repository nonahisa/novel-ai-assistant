import { WorkEntry } from "../models/types";
import {
  mergeAbilitySystemRules,
  type RejectedSettingCandidate,
} from "../core/settingsExtractionValidation";
import type { SettingMergeCandidate } from "../core/settingsMerge";
import { planSettingsMerge } from "../core/externalExtractMerge";
import {
  AbilitySystemStore,
  createAbilityStore,
  createLocationStore,
  createOrganizationStore,
  createWorldStore,
} from "../core/abilityStore";
import type { AbilitySystem } from "../models/ability";
import { SettingsExtractionCollector } from "../core/settingsExtractionCollect";

/**
 * 人物抽出と同じAI応答から、能力と場所を取り出して保存する。
 *
 * 種別ごとにAIを呼ばず1回の応答を使い回すため、
 * 収集はチャンクごと、保存は最後に一括で行う。
 */

/**
 * `persist` が書き込みを絞れる種別。
 *
 * 人物（characters）はこのクラスの担当ではない（`extractCharacters.ts` が
 * 承認待ちの仕組みを含めて別に扱う）ため、ここには含めない。
 */
export type SettingsPersistKind =
  | "locations"
  | "abilities"
  | "organizations"
  | "world";

export interface SettingsExtractionCounts {
  abilitiesAdded: number;
  abilitiesUpdated: number;
  locationsAdded: number;
  locationsUpdated: number;
  organizationsAdded: number;
  organizationsUpdated: number;
  worldAdded: number;
  worldUpdated: number;
  rejected: RejectedSettingCandidate[];
  conflicts: number;
  mergeCandidates: SettingMergeCandidate[];
  /** 読み取れた能力の総称。読み取れなければ null */
  abilityTerm: string | null;
  /**
   * **以前の抽出で `設定/ability_system.json` へ入っていた指示文**のうち、
   * 今回の保存で外したもの。
   *
   * `rejected` の `instruction_echo`（今回のAIの答えから落とした分）とは
   * 分けて出す。混ぜると、掃除が済んだ回も同じ件数が出ているように見える。
   */
  staleRules: string[];
}

export interface SettingsPersistResult {
  counts: SettingsExtractionCounts;
  /** 保存した件数。0なら書き込みは発生していない */
  savedAbilities: number;
  savedLocations: number;
  savedOrganizations: number;
  savedWorld: number;
}

/*
  **集めるところは `core/settingsExtractionCollect.ts` にある**（0.64.3で分けた）。
  保存（`persist`）だけが台帳を触るので、そこだけをここに残してある。
  分けたのは、MCPの束から集める部分へ届くようにするためである（設計書6.87.8）。
*/
export { SettingsExtractionCollector };

export class SettingsExtractionAccumulator extends SettingsExtractionCollector {
  /**
   * 抽出結果を保存する。
   *
   * 該当が1件も無い種別は保存しない。
   * 能力体系の無い作品に空のファイルを作っても、
   * 作者にとって意味のない項目が増えるだけであるため。
   */
  /**
   * @param kinds 保存する種別。省略すると人物以外のすべて。
   *   **統合の計算は絞らない。** 組織は場所の一覧を見て「地名を組織にしない」
   *   判断をするなど、種別をまたいで参照するため。絞るのは書き込みと件数だけ。
   */
  async persist(
    work: WorkEntry,
    // 呼び出し側は人物を含む集合をそのまま渡せる（人物はここでは見ない）。
    // 種別名の綴りは saves() の引数側で型に守られる
    kinds?: ReadonlySet<string>
  ): Promise<SettingsPersistResult> {
    const saves = (kind: SettingsPersistKind): boolean =>
      kinds === undefined || kinds.has(kind);
    const abilityStore = createAbilityStore(work);
    const locationStore = createLocationStore(work);
    const organizationStore = createOrganizationStore(work);
    const worldStore = createWorldStore(work);

    const existingAbilities =
      this.abilities.length > 0
        ? (await abilityStore.loadAll()).records
        : [];
    const existingLocations =
      this.locations.length > 0
        ? (await locationStore.loadAll()).records
        : [];
    const hasOrganizations =
      this.organizations.length > 0 || this.affiliations.size > 0;
    const existingOrganizations = hasOrganizations
      ? (await organizationStore.loadAll()).records
      : [];

    const existingWorld =
      this.worldItems.length > 0 ? (await worldStore.loadAll()).records : [];

    /*
      **マージの並びは core にある**（`planSettingsMerge`。2026-10-02）。
      外部AIの抽出を資料へ保存する道（MCP `novel.extract.commit`）が
      同じ並びを通るので、ここに写しを持たない。
    */
    const plan = planSettingsMerge(this.candidates(), {
      abilities: existingAbilities,
      locations: existingLocations,
      organizations: existingOrganizations,
      world: existingWorld,
    });
    const {
      abilityMerge,
      locationMerge,
      organizationMerge,
      fromAffiliations,
      worldMerge,
    } = plan;
    const changedAbilities = plan.changed.abilities;
    const changedLocations = plan.changed.locations;
    const changedOrganizations = plan.changed.organizations;
    const changedWorldItems = plan.changed.world;

    if (saves("abilities") && changedAbilities.length > 0) {
      await abilityStore.saveAll(changedAbilities);
    }
    if (saves("locations") && changedLocations.length > 0) {
      await locationStore.saveAll(changedLocations);
    }
    if (saves("organizations") && changedOrganizations.length > 0) {
      await organizationStore.saveAll(changedOrganizations);
    }
    if (saves("world") && changedWorldItems.length > 0) {
      await worldStore.saveAll(changedWorldItems);
    }

    // 総称や規則が読み取れた場合だけ体系の設定を書く
    let staleRules: string[] = [];
    if (
      saves("abilities") &&
      (this.abilityTerm || this.abilityDescription || this.rules.size > 0)
    ) {
      staleRules = await this.persistAbilitySystem(work);
    }

    // 保存しなかった種別は、件数も0で返す。
    // 数えたものと書いたものが食い違うと、要約が嘘になる
    const zeroUnless = (kind: SettingsPersistKind, value: number): number =>
      saves(kind) ? value : 0;

    return {
      counts: {
        abilitiesAdded: zeroUnless("abilities", abilityMerge.added.length),
        abilitiesUpdated: zeroUnless("abilities", abilityMerge.updated.length),
        locationsAdded: zeroUnless("locations", locationMerge.added.length),
        locationsUpdated: zeroUnless("locations", locationMerge.updated.length),
        organizationsAdded: zeroUnless(
          "organizations",
          organizationMerge.added.length + fromAffiliations.added.length
        ),
        organizationsUpdated: zeroUnless(
          "organizations",
          organizationMerge.updated.length
        ),
        worldAdded: zeroUnless("world", worldMerge.added.length),
        worldUpdated: zeroUnless("world", worldMerge.updated.length),
        rejected: this.rejected,
        conflicts:
          zeroUnless("abilities", abilityMerge.conflicts.length) +
          zeroUnless("locations", locationMerge.conflicts.length) +
          zeroUnless("organizations", organizationMerge.conflicts.length) +
          zeroUnless("world", worldMerge.conflicts.length),
        mergeCandidates: [
          ...(saves("abilities") ? abilityMerge.mergeCandidates : []),
          ...(saves("world") ? worldMerge.mergeCandidates : []),
        ],
        abilityTerm: this.abilityTerm,
        staleRules,
      },
      savedAbilities: saves("abilities") ? changedAbilities.length : 0,
      savedLocations: saves("locations") ? changedLocations.length : 0,
      savedOrganizations: saves("organizations")
        ? changedOrganizations.length
        : 0,
      savedWorld: saves("world") ? changedWorldItems.length : 0,
    };
  }

  /**
   * 能力体系を保存する。
   *
   * @returns 既に保存されていた決まりから外した指示文（黙って捨てないので
   *   呼び出し側が件数を出せる）
   */
  private async persistAbilitySystem(work: WorkEntry): Promise<string[]> {
    const store = new AbilitySystemStore(work);
    const current = await store.load();

    /*
      **保存済みの決まりも、同じ物差しに通す**（作者の裁定、2026-09-19）。
      積み増すだけだと、実機で既に入ってしまった指示文6文は再実行しても
      残り続ける。総称は今回読み取ったものを優先する——プロンプトの文面は
      総称で差し替わるので、送ったときの語に近いほうが当たる。
    */
    const merged = mergeAbilitySystemRules(
      current.rules,
      [...this.rules],
      this.abilityTerm ?? current.abilityTerm
    );

    // 作者が書いた総称・メモは上書きしない
    const next: AbilitySystem = {
      ...current,
      abilityTerm:
        current.autoGenerated && this.abilityTerm
          ? this.abilityTerm
          : current.abilityTerm,
      description: current.description ?? this.abilityDescription,
      rules: merged.rules,
    };
    await store.save(next);
    return merged.droppedFromSaved;
  }
}
