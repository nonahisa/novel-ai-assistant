import { WorkEntry } from "../models/types";
import type { Chunk } from "../core/chunker";
import type { CharacterExtractResult } from "../prompts/characterExtract";
import {
  normalizeExtractedAbilitySystem,
  validateExtractedAbilities,
  validateExtractedLocations,
  type RejectedSettingCandidate,
  type AcceptedAbilityCandidate,
  type AcceptedLocationCandidate,
} from "../core/settingsExtractionValidation";
import {
  mergeExtractedAbilities,
  mergeExtractedLocations,
  type SettingMergeCandidate,
} from "../core/settingsMerge";
import {
  AbilitySystemStore,
  createAbilityStore,
  createLocationStore,
} from "../core/abilityStore";
import type { Ability, AbilitySystem } from "../models/ability";
import type { Location } from "../models/location";

/**
 * 人物抽出と同じAI応答から、能力と場所を取り出して保存する。
 *
 * 種別ごとにAIを呼ばず1回の応答を使い回すため、
 * 収集はチャンクごと、保存は最後に一括で行う。
 */

export interface SettingsExtractionCounts {
  abilitiesAdded: number;
  abilitiesUpdated: number;
  locationsAdded: number;
  locationsUpdated: number;
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
}

export class SettingsExtractionAccumulator {
  private readonly abilities: AcceptedAbilityCandidate[] = [];
  private readonly locations: AcceptedLocationCandidate[] = [];
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
  }

  /**
   * 抽出結果を保存する。
   *
   * 該当が1件も無い種別は保存しない。
   * 能力体系の無い作品に空のファイルを作っても、
   * 作者にとって意味のない項目が増えるだけであるため。
   */
  async persist(work: WorkEntry): Promise<SettingsPersistResult> {
    const abilityStore = createAbilityStore(work);
    const locationStore = createLocationStore(work);

    const existingAbilities =
      this.abilities.length > 0
        ? (await abilityStore.loadAll()).records
        : [];
    const existingLocations =
      this.locations.length > 0
        ? (await locationStore.loadAll()).records
        : [];

    const abilityMerge = mergeExtractedAbilities(
      existingAbilities,
      this.abilities
    );
    const locationMerge = mergeExtractedLocations(
      existingLocations,
      this.locations
    );

    const changedAbilities = abilityMerge.abilities.filter((ability) =>
      abilityMerge.changedIds.includes(ability.id)
    );
    const changedLocations = locationMerge.locations.filter((location) =>
      locationMerge.changedIds.includes(location.id)
    );

    if (changedAbilities.length > 0) {
      await abilityStore.saveAll(changedAbilities);
    }
    if (changedLocations.length > 0) {
      await locationStore.saveAll(changedLocations);
    }

    // 総称や規則が読み取れた場合だけ体系の設定を書く
    if (this.abilityTerm || this.abilityDescription || this.rules.size > 0) {
      await this.persistAbilitySystem(work);
    }

    return {
      counts: {
        abilitiesAdded: abilityMerge.added.length,
        abilitiesUpdated: abilityMerge.updated.length,
        locationsAdded: locationMerge.added.length,
        locationsUpdated: locationMerge.updated.length,
        rejected: this.rejected,
        conflicts:
          abilityMerge.conflicts.length + locationMerge.conflicts.length,
        mergeCandidates: abilityMerge.mergeCandidates,
        abilityTerm: this.abilityTerm,
      },
      savedAbilities: changedAbilities.length,
      savedLocations: changedLocations.length,
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
