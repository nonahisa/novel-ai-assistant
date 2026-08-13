import { describe, expect, test } from "vitest";
import {
  SelfWriteTracker,
  isWatchedSettingsFile,
  kindOfSettingsFile,
} from "../../src/core/externalChanges";
import {
  createAbilityStore,
  createLocationStore,
  createOrganizationStore,
  createWorldStore,
} from "../../src/core/abilityStore";

/**
 * 外部のAI・ツールが設定資料を書き換えたことを見分ける。
 * 拡張機能自身の書き込みと区別できないと、保存のたびに
 * 「外部で変更されました」と出て使い物にならない。
 */

describe("自分の書き込みと区別する", () => {
  test("書き込む直前に控えたパスは自分のものとみなす", () => {
    const tracker = new SelfWriteTracker();
    tracker.markWriting("C:/work/設定/characters/char_001_灯.json");

    expect(
      tracker.isSelfWrite("C:/work/設定/characters/char_001_灯.json")
    ).toBe(true);
  });

  test("控えていないパスは外部の変更とみなす", () => {
    const tracker = new SelfWriteTracker();

    expect(
      tracker.isSelfWrite("C:/work/設定/characters/char_002_澪.json")
    ).toBe(false);
  });

  test("猶予を過ぎたら外部の変更とみなす", () => {
    // 自分の書き込みをいつまでも自分のものと扱うと、
    // そのファイルへの外部変更を永久に見落とす
    let now = 1000;
    const tracker = new SelfWriteTracker(() => now);
    tracker.markWriting("/work/設定/characters/char_001.json");

    now = 1000 + 3001;

    expect(tracker.isSelfWrite("/work/設定/characters/char_001.json")).toBe(
      false
    );
  });

  test("区切り文字が違っても同じパスとみなす", () => {
    const tracker = new SelfWriteTracker();
    tracker.markWriting("C:\\work\\設定\\characters\\char_001.json");

    expect(
      tracker.isSelfWrite("C:/work/設定/characters/char_001.json")
    ).toBe(true);
  });

  test("溜まった記録を掃除する", () => {
    let now = 1000;
    const tracker = new SelfWriteTracker(() => now);
    tracker.markWriting("/work/設定/characters/char_001.json");

    now = 1000 + 5000;
    tracker.prune();
    now = 1000 + 5001;

    // 掃除済みなので、控えていない扱いになる
    expect(tracker.isSelfWrite("/work/設定/characters/char_001.json")).toBe(
      false
    );
  });
});

describe("監視の対象を絞る", () => {
  test("設定のJSONは対象にする", () => {
    expect(
      isWatchedSettingsFile("/work/設定/characters/char_001_灯.json")
    ).toBe(true);
    expect(isWatchedSettingsFile("/work/設定/custom_fields.json")).toBe(true);
  });

  test("生成物と作業場所は対象にしない", () => {
    // AI向けの定義は生成物。承認を求める意味がない
    expect(
      isWatchedSettingsFile("/work/設定/_schema/character.schema.json")
    ).toBe(false);
    expect(
      isWatchedSettingsFile("/work/.aiwriter/pending-characters/char_001.json")
    ).toBe(false);
    expect(
      isWatchedSettingsFile("/work/.novelai-recovery/char_001.json")
    ).toBe(false);
  });

  test("JSON以外は対象にしない", () => {
    // characters.md は生成物で、直しても次の生成で消える
    expect(isWatchedSettingsFile("/work/設定/characters.md")).toBe(false);
    expect(isWatchedSettingsFile("/work/本文/001.txt")).toBe(false);
  });
});

describe("種別を見分ける", () => {
  test("置き場所から決める", () => {
    expect(kindOfSettingsFile("/work/設定/characters/char_001.json")).toBe(
      "character"
    );
    expect(kindOfSettingsFile("/work/設定/abilities/abil_001.json")).toBe(
      "ability"
    );
    expect(kindOfSettingsFile("/work/設定/organizations/org_001.json")).toBe(
      "organization"
    );
    expect(kindOfSettingsFile("/work/設定/locations/loc_001.json")).toBe(
      "location"
    );
    // 世界観だけ登録し忘れていた。ここが漏れると、外部のAIが
    // 世界観のJSONを書き換えても作者に何も知らせないまま進む
    expect(kindOfSettingsFile("/work/設定/world/world_001.json")).toBe("world");
    expect(kindOfSettingsFile("/work/設定/custom_fields.json")).toBe(
      "customFields"
    );
  });

  test("実際の保存先フォルダを全て見分けられる", () => {
    // 種類を増やしたときの足し忘れを機械的に見つける。
    // 世界観が抜けていて、外部の変更に気づけない状態になっていた
    const work = {
      id: "work_test",
      title: "作品",
      folderPath: "/work",
      registeredAt: "2026-08-06T00:00:00.000Z",
    };
    const stores = [
      createAbilityStore(work),
      createLocationStore(work),
      createWorldStore(work),
      createOrganizationStore(work),
    ];

    for (const store of stores) {
      const directory = store.directoryName;
      expect(
        kindOfSettingsFile(`/work/設定/${directory}/x_001.json`),
        `${directory} の種別が決まらない`
      ).toBeDefined();
    }
  });

  test("知らない場所は種別なしにする", () => {
    expect(kindOfSettingsFile("/work/設定/ability_system.json")).toBeUndefined();
    expect(kindOfSettingsFile("/work/設定/なにか.json")).toBeUndefined();
  });
});
