import type { Chunk } from "./chunker";
import type { CharacterExtractResult } from "../prompts/characterExtract";
import {
  normalizeExtractedAbilitySystem,
  validateExtractedAbilities,
  validateExtractedLocations,
  validateExtractedOrganizations,
  validateExtractedWorldItems,
  type AcceptedAbilityCandidate,
  type AcceptedLocationCandidate,
  type AcceptedOrganizationCandidate,
  type AcceptedWorldCandidate,
  type RejectedSettingCandidate,
} from "./settingsExtractionValidation";
import type { Ability } from "../models/ability";
import type { Location } from "../models/location";
import type { Organization } from "../models/organization";
import type { WorldItem } from "../models/world";

/**
 * 設定資料の抽出で、**集めるところだけ**（設計書6.5）。
 *
 * **保存は `features/extractSettings.ts` の側に残してある。** 台帳
 * （`createAbilityStore` など）が `workRegistry` 経由で `vscode` を
 * 引き込むので、集める部分まで巻き込むと**MCPの束（設計書6.87.8）から
 * 届かなくなる**——実際 `mcpReach.test.ts` が捕まえた（0.64.3）。
 *
 * **継承で分けた。** 保存する側がこれを継ぐので、**使う側の既定は
 * 今までどおり**である（`textDecode`・`workStyleFacts` と同じ考え）。
 *
 * VS Code APIに依存しない。
 */
export class SettingsExtractionCollector {
  protected readonly abilities: AcceptedAbilityCandidate[] = [];
  protected readonly locations: AcceptedLocationCandidate[] = [];
  protected readonly organizations: AcceptedOrganizationCandidate[] = [];
  protected readonly worldItems: AcceptedWorldCandidate[] = [];
  /**
   * 人物側で読み取れた所属。
   * AIは affiliation に組織名を入れておきながら organizations には
   * 出さないことがあるため、名前だけでも組織を作れるよう控えておく。
   */
  protected readonly affiliations = new Set<string>();
  protected readonly rejected: RejectedSettingCandidate[] = [];
  protected abilityTerm: string | null = null;
  protected readonly rules = new Set<string>();
  protected abilityDescription: string | null = null;

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

  /**
   * いま集まっているものを、読むだけで返す（0.64.3）。
   *
   * **書き込みを伴わない道が要る。** MCP（設計書6.87.8）は「読む・測る・
   * 提案する」までで、`persist` を呼ばない。集めた結果を見るには
   * ここが無いと、`validateExtracted*` を外で呼び直すことになり、
   * **`collect` の順そのものが写しになる**（総称を先に読む・所属を拾う、
   * といった順序が意味を持っている）。
   *
   * **控えを返す。** 呼んだ側が配列を触っても、集約の中身は動かない。
   */
  candidates(): {
    abilities: readonly AcceptedAbilityCandidate[];
    locations: readonly AcceptedLocationCandidate[];
    organizations: readonly AcceptedOrganizationCandidate[];
    worldItems: readonly AcceptedWorldCandidate[];
    affiliations: string[];
    rejected: readonly RejectedSettingCandidate[];
    abilityTerm: string | null;
  } {
    return {
      abilities: [...this.abilities],
      locations: [...this.locations],
      organizations: [...this.organizations],
      worldItems: [...this.worldItems],
      affiliations: [...this.affiliations],
      rejected: [...this.rejected],
      abilityTerm: this.abilityTerm,
    };
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

}
