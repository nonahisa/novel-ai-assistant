import { describe, expect, test } from "vitest";
import { hashText } from "../../../src/core/hash";
import {
  describeCharacter,
  describeLocation,
  describeWorldItem,
  settingsFingerprint,
} from "../../../src/core/settingsSummary";
import { emptyCharacter, type Character } from "../../../src/models/character";
import { emptyAbility } from "../../../src/models/ability";
import { emptyLocation } from "../../../src/models/location";
import { emptyOrganization } from "../../../src/models/organization";
import { emptyWorldItem } from "../../../src/models/world";

function character(overrides: Partial<Character> = {}): Character {
  return { ...emptyCharacter("char_001", "灯"), ...overrides };
}

function fingerprintWith(person: Character): string {
  return settingsFingerprint({
    people: [person],
    places: [emptyLocation("loc_001", "月見坂")],
    worldItems: [emptyWorldItem("world_001", "灯火の儀")],
  });
}

describe("設定の指紋（矛盾検知のキャッシュ鍵）", () => {
  test("updatedAt だけが違っても、指紋は変わらない", () => {
    // 抽出は中身が同じでも updatedAt を書き換える。指紋に時刻が混ざると、
    // 抽出を回すたびに矛盾検知の全チャンクのキャッシュが飛ぶ（設計書6.27.6）
    const before = fingerprintWith(
      character({ updatedAt: "2026-08-01T00:00:00.000Z" })
    );
    const after = fingerprintWith(
      character({ updatedAt: "2026-08-27T12:34:56.000Z" })
    );

    expect(after).toBe(before);
  });

  test("人物の中身が変われば、指紋は変わる", () => {
    const village = fingerprintWith(character({ role: "村人" }));
    const hero = fingerprintWith(character({ role: "主人公" }));

    expect(hero).not.toBe(village);
  });

  test("作中での変化（changes）が変われば、指紋は変わる", () => {
    // 過去話の時点の設定（recordAsOf）は changes から巻き戻して作る。
    // changes の中身が指紋に効かないと、古い答えがキャッシュから返る。
    // 変化は同じ項目に2件以上（前と後）あって初めて描かれる（changedFields）
    const none = fingerprintWith(character());
    const cut = fingerprintWith(
      character({
        changes: [
          {
            field: "appearance",
            value: "長い黒髪",
            chapters: [1],
            timepointId: null,
            note: null,
            evidence: null,
            source: "author",
          },
          {
            field: "appearance",
            value: "髪を短く切った",
            chapters: [7],
            timepointId: null,
            note: null,
            evidence: null,
            source: "author",
          },
        ],
      })
    );

    expect(cut).not.toBe(none);
  });

  test("場所や世界観の中身が変われば、指紋は変わる", () => {
    const base = fingerprintWith(character());
    const moved = settingsFingerprint({
      people: [character()],
      places: [
        { ...emptyLocation("loc_001", "月見坂"), description: "坂の上の神社" },
      ],
      worldItems: [emptyWorldItem("world_001", "灯火の儀")],
    });

    expect(moved).not.toBe(base);
  });

  test("組織や能力の中身が変われば、指紋は変わる（2026-11-15 から材料に載る）", () => {
    const of = (description: string | null, limitation: string | null) =>
      settingsFingerprint({
        people: [character()],
        places: [],
        worldItems: [],
        organizations: [
          { ...emptyOrganization("org_001", "冒険者ギルド"), description },
        ],
        abilities: [{ ...emptyAbility("abil_001", "回復魔法"), limitation }],
      });

    const base = of(null, null);
    expect(of("依頼の仲介料を取る", null)).not.toBe(base);
    expect(of(null, "自分には使えない")).not.toBe(base);
  });

  test("組織・能力を渡さない呼び手の指紋は、直す前の式と同じ", () => {
    // 渡さない呼び手のキャッシュを、この変更で飛ばさない。直す前（1.0.7）の
    // 式をここに写して比べる
    const person = character();
    const place = emptyLocation("loc_001", "月見坂");
    const item = emptyWorldItem("world_001", "灯火の儀");
    const before = hashText(
      JSON.stringify([
        [[person.id, describeCharacter(person, [])]],
        [[place.id, describeLocation(place)]],
        [[item.id, describeWorldItem(item)]],
      ])
    ).slice(0, 16);

    expect(
      settingsFingerprint({ people: [person], places: [place], worldItems: [item] })
    ).toBe(before);
    // 渡したときは（空の並びでも）別の指紋になる
    expect(
      settingsFingerprint({
        people: [person],
        places: [place],
        worldItems: [item],
        organizations: [],
        abilities: [],
      })
    ).not.toBe(before);
  });
});
