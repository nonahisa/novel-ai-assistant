import { WorkEntry } from "../models/types";
import type { Chunk } from "../core/chunker";
import type { CharacterExtractResult } from "../prompts/characterExtract";
import {
  normalizeExtractedAbilitySystem,
  validateExtractedAbilities,
  validateExtractedLocations,
  validateExtractedOrganizations,
  validateExtractedWorldItems,
  type RejectedSettingCandidate,
  type AcceptedAbilityCandidate,
  type AcceptedLocationCandidate,
  type AcceptedOrganizationCandidate,
  type AcceptedWorldCandidate,
} from "../core/settingsExtractionValidation";
import {
  mergeExtractedAbilities,
  mergeExtractedLocations,
  mergeExtractedOrganizations,
  mergeExtractedWorldItems,
  organizationsFromAffiliations,
  type SettingMergeCandidate,
} from "../core/settingsMerge";
import {
  AbilitySystemStore,
  createAbilityStore,
  createLocationStore,
  createOrganizationStore,
  createWorldStore,
} from "../core/abilityStore";
import type { Ability, AbilitySystem } from "../models/ability";
import type { Location } from "../models/location";
import type { Organization } from "../models/organization";
import type { WorldItem } from "../models/world";

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
}

export interface SettingsPersistResult {
  counts: SettingsExtractionCounts;
  /** 保存した件数。0なら書き込みは発生していない */
  savedAbilities: number;
  savedLocations: number;
  savedOrganizations: number;
  savedWorld: number;
}

export class SettingsExtractionAccumulator {
  private readonly abilities: AcceptedAbilityCandidate[] = [];
  private readonly locations: AcceptedLocationCandidate[] = [];
  private readonly organizations: AcceptedOrganizationCandidate[] = [];
  private readonly worldItems: AcceptedWorldCandidate[] = [];
  /**
   * 人物側で読み取れた所属。
   * AIは affiliation に組織名を入れておきながら organizations には
   * 出さないことがあるため、名前だけでも組織を作れるよう控えておく。
   */
  private readonly affiliations = new Set<string>();
  private readonly rejected: RejectedSettingCandidate[] = [];
  private abilityTerm: string | null = null;
  private readonly rules = new Set<string>();
  private abilityDescription: string | null = null;

  constructor(
    /** 既に確定している総称。無ければ本文から読み取る */
    initialAbilityTerm: string | null = null
  ) {
    this.abilityTerm = initialAbilityTerm;
  }

  /** 既知の能力名。次のチャンクへ渡して同一能力の判定を助ける */
  knownAbilityNames(existing: Ability[]): string[] {
    const names = [
      ...existing.flatMap((ability) => [ability.name, ...ability.aliases]),
      ...this.abilities.flatMap((item) => [
        item.data.name,
        ...(item.data.aliases ?? []),
      ]),
    ]
      .map((name) => name.trim())
      .filter(Boolean);
    return [...new Set(names)];
  }

  /** 既知の場所名 */
  knownLocationNames(existing: Location[]): string[] {
    const names = [
      ...existing.flatMap((location) => [location.name, ...location.aliases]),
      ...this.locations.flatMap((item) => [
        item.data.name,
        ...(item.data.aliases ?? []),
      ]),
    ]
      .map((name) => name.trim())
      .filter(Boolean);
    return [...new Set(names)];
  }

  /** 既知の組織名 */
  knownOrganizationNames(existing: Organization[]): string[] {
    const names = [
      ...existing.flatMap((organization) => [
        organization.name,
        ...organization.aliases,
      ]),
      ...this.organizations.flatMap((item) => [
        item.data.name,
        ...(item.data.aliases ?? []),
      ]),
    ]
      .map((name) => name.trim())
      .filter(Boolean);
    return [...new Set(names)];
  }

  /**
   * 既知の世界観の見出し。
   *
   * 渡さないと、モデルは同じ事柄を毎チャンク書いてくる。
   * 見出しが揃えばマージで1件にまとまるが、揃わなければ
   * 「通貨の単位」「お金の単位」のように別項目として増え続ける。
   */
  knownWorldNames(existing: WorldItem[]): string[] {
    const names = [
      ...existing.flatMap((item) => [item.name, ...item.aliases]),
      ...this.worldItems.map((item) => item.data.name),
    ]
      .map((name) => name.trim())
      .filter(Boolean);
    return [...new Set(names)];
  }

  currentAbilityTerm(): string | null {
    return this.abilityTerm;
  }

  /** 1チャンク分の応答から能力・場所を取り出す */
  collect(result: CharacterExtractResult, chunk: Chunk): void {
    const raw = result as unknown as Record<string, unknown>;

    // 総称は最初に読み取れたものを使う。
    // チャンクごとに揺れるため、確定後は上書きしない。
    const system = normalizeExtractedAbilitySystem(raw.abilitySystem);
    if (system) {
      if (!this.abilityTerm && system.abilityTerm) {
        this.abilityTerm = system.abilityTerm;
      }
      if (!this.abilityDescription && system.description) {
        this.abilityDescription = system.description;
      }
      for (const rule of system.rules ?? []) this.rules.add(rule);
    }

    const abilities = validateExtractedAbilities(
      raw.abilities,
      chunk,
      this.abilityTerm
    );
    this.abilities.push(...abilities.accepted);
    this.rejected.push(...abilities.rejected);

    const locations = validateExtractedLocations(raw.locations, chunk);
    this.locations.push(...locations.accepted);
    this.rejected.push(...locations.rejected);

    const organizations = validateExtractedOrganizations(
      raw.organizations,
      chunk
    );
    this.organizations.push(...organizations.accepted);
    this.rejected.push(...organizations.rejected);

    const worldItems = validateExtractedWorldItems(raw.worldview, chunk);
    this.worldItems.push(...worldItems.accepted);
    this.rejected.push(...worldItems.rejected);

    for (const character of result.characters ?? []) {
      const affiliation = character.affiliation?.trim();
      if (affiliation) this.affiliations.add(affiliation);
    }
  }

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

    const abilityMerge = mergeExtractedAbilities(
      existingAbilities,
      this.abilities
    );
    const locationMerge = mergeExtractedLocations(
      existingLocations,
      this.locations
    );
    const organizationMerge = mergeExtractedOrganizations(
      existingOrganizations,
      this.organizations
    );
    // 所属から作る分は、抽出できた組織を足したあとに見る。
    // 先に見ると、AIが説明付きで返した組織を名前だけで作ってしまう
    const fromAffiliations = organizationsFromAffiliations(
      organizationMerge.organizations,
      [...this.affiliations],
      // 地名を所属に書かれても組織を作らないよう、場所の一覧を渡す
      locationMerge.locations
    );

    const worldMerge = mergeExtractedWorldItems(existingWorld, this.worldItems);

    const changedAbilities = abilityMerge.abilities.filter((ability) =>
      abilityMerge.changedIds.includes(ability.id)
    );
    const changedLocations = locationMerge.locations.filter((location) =>
      locationMerge.changedIds.includes(location.id)
    );
    const changedOrganizationIds = new Set([
      ...organizationMerge.changedIds,
      ...fromAffiliations.changedIds,
    ]);
    const changedOrganizations = fromAffiliations.organizations.filter(
      (organization) => changedOrganizationIds.has(organization.id)
    );

    const changedWorldItems = worldMerge.items.filter((item) =>
      worldMerge.changedIds.includes(item.id)
    );

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
    if (
      saves("abilities") &&
      (this.abilityTerm || this.abilityDescription || this.rules.size > 0)
    ) {
      await this.persistAbilitySystem(work);
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
      },
      savedAbilities: saves("abilities") ? changedAbilities.length : 0,
      savedLocations: saves("locations") ? changedLocations.length : 0,
      savedOrganizations: saves("organizations")
        ? changedOrganizations.length
        : 0,
      savedWorld: saves("world") ? changedWorldItems.length : 0,
    };
  }

  private async persistAbilitySystem(work: WorkEntry): Promise<void> {
    const store = new AbilitySystemStore(work);
    const current = await store.load();

    // 作者が書いた総称・メモは上書きしない
    const next: AbilitySystem = {
      ...current,
      abilityTerm:
        current.autoGenerated && this.abilityTerm
          ? this.abilityTerm
          : current.abilityTerm,
      description: current.description ?? this.abilityDescription,
      rules: [...new Set([...current.rules, ...this.rules])],
    };
    await store.save(next);
  }
}
