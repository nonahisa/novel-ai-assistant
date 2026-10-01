import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { createHash } from "node:crypto";
import { extractCommit } from "../../../src/mcp/tools/extractCommit";
import {
  extractStashFileOf,
  readExtractStash,
} from "../../../src/mcp/tools/extractStash";
import { settingsPrompt, settingsValidate } from "../../../src/mcp/tools/settings";
import { novelValidate } from "../../../src/mcp/tools/features";
import { exposureOf } from "../../../src/mcp/tools/accessLog";
import {
  emptyCharacter,
  nextCharacterId,
  parseCharacter,
} from "../../../src/models/character";
import { emptyLocation, nextLocationId, parseLocation } from "../../../src/models/location";
import {
  readSource,
  unwrapPendingCharacter,
} from "../../../src/core/pendingUpdateFormat";
import { parsePendingSettingsPayload } from "../../../src/core/pendingSettingsMerge";

/**
 * 外部AIの設定資料の抽出を、資料へ保存する道（`novel.extract.commit`。
 * 作者の裁定 2026-10-02「何もない状態からであれば承認は不要」）。
 *
 * **いちばん見張りたいのは、既存のファイルが1バイトも変わらないこと。**
 * 設計書6.87.7「MCP は資料を書き換えない」の例外として資料へ書く道なので、
 * 例外の幅が「新しいファイルを作る」より広がっていないことを、置く前と
 * 置いた後の指紋で確かめる。
 */

const NUM_CTX = 32768;
const temporary: string[] = [];
/** 台帳にいる人物「灯」のID（製品の採番で決める。桁を決め打ちしない） */
const FIRST_CHARACTER_ID = nextCharacterId([]);

const EPISODE_1 = "001_出会い.txt";
const EPISODE_2 = "002_嵐.txt";
const TEXT_1 =
  "　港町に灯という娘がいた。\n" +
  "　灯は毎晩、灯台に火をともした。\n" +
  "「わたしが守るの」と灯は言った。\n";
const TEXT_2 =
  "　嵐の夜、漁師の岩男が港町へ戻ってきた。\n" +
  "　岩男は灯に礼を言った。\n";

/** 作り物の作品。人物「灯」と場所「港町」が台帳に既にある */
function makeWork(): string {
  const folder = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-extract-commit-"));
  temporary.push(folder);
  fs.mkdirSync(nodePath.join(folder, "本文"), { recursive: true });
  fs.writeFileSync(nodePath.join(folder, "本文", EPISODE_1), TEXT_1, "utf8");
  fs.writeFileSync(nodePath.join(folder, "本文", EPISODE_2), TEXT_2, "utf8");

  const character = emptyCharacter(FIRST_CHARACTER_ID, "灯");
  fs.mkdirSync(nodePath.join(folder, "設定", "characters"), { recursive: true });
  fs.writeFileSync(
    nodePath.join(folder, "設定", "characters", `${character.id}_灯.json`),
    `${JSON.stringify({ ...character, updatedAt: "2026-09-01T00:00:00.000Z" }, null, 2)}\n`,
    "utf8"
  );
  const location = emptyLocation(nextLocationId([]), "港町");
  fs.mkdirSync(nodePath.join(folder, "設定", "locations"), { recursive: true });
  fs.writeFileSync(
    nodePath.join(folder, "設定", "locations", `${location.id}_港町.json`),
    // **CRLF の既存ファイル**。書き換えれば改行が変わるので、1バイトの比較で必ず分かる
    `${JSON.stringify({ ...location, updatedAt: "2026-09-01T00:00:00.000Z" }, null, 2)}\n`.replace(
      /\n/g,
      "\r\n"
    ),
    "utf8"
  );
  return folder;
}

const ANSWER_1 = {
  characters: [
    {
      name: "灯",
      aliases: [],
      entityType: "person",
      summary: "毎晩、灯台に火をともす娘",
      evidence: "灯は毎晩、灯台に火をともした",
    },
  ],
  locations: [
    {
      name: "港町",
      description: "灯の暮らす海辺の町",
      evidence: "港町に灯という娘がいた",
    },
    {
      name: "灯台",
      description: "灯が毎晩火をともす塔",
      evidence: "灯台に火をともした",
    },
  ],
};

const ANSWER_2 = {
  characters: [
    {
      name: "岩男",
      aliases: [],
      entityType: "person",
      role: "漁師",
      evidence: "漁師の岩男が港町へ戻ってきた",
    },
  ],
};

function chunkIdOf(folder: string, episode: string): string {
  return settingsPrompt({ folder, filePath: `本文/${episode}`, numCtx: NUM_CTX })
    .chunks[0].chunkId;
}

/** 2話ぶんの答えを貯める（話の順と逆に貯めて、並べ直しも試す） */
function stashBoth(folder: string): void {
  settingsValidate({
    folder,
    chunkId: chunkIdOf(folder, EPISODE_2),
    response: JSON.stringify(ANSWER_2),
    stash: true,
  });
  settingsValidate({
    folder,
    chunkId: chunkIdOf(folder, EPISODE_1),
    response: JSON.stringify(ANSWER_1),
    stash: true,
  });
}

/** `設定/` の下の全ファイルの指紋（名前と中身）。**1バイトでも変われば変わる** */
function fingerprints(folder: string): Map<string, string> {
  const result = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        result.set(
          nodePath.relative(folder, full),
          createHash("sha256").update(fs.readFileSync(full)).digest("hex")
        );
      }
    }
  };
  walk(nodePath.join(folder, "設定"));
  return result;
}

function filesIn(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

afterEach(() => {
  for (const folder of temporary.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

describe("novel.extract.commit——新しい記録の保存", () => {
  it("新しい記録は wx で作られ、既存の台帳のファイルは1バイトも変わらない", () => {
    const folder = makeWork();
    stashBoth(folder);
    const before = fingerprints(folder);

    const result = extractCommit({ folder });

    // **ここが本丸。** 既存のファイルはどれも変わっていない
    const after = fingerprints(folder);
    for (const [file, hash] of before) {
      expect(after.get(file), file).toBe(hash);
    }

    expect(result.created.character).toEqual(["岩男"]);
    expect(result.created.location).toEqual(["灯台"]);
    expect(result.createdCount).toBe(2);

    // 製品と同じファイル名・同じ形（字下げ2つ・LF・末尾改行）で作られている
    const characterFiles = filesIn(nodePath.join(folder, "設定", "characters"));
    const created = characterFiles.find((name) => name.endsWith("_岩男.json"));
    expect(created).toBeDefined();
    const text = fs.readFileSync(
      nodePath.join(folder, "設定", "characters", created as string),
      "utf8"
    );
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).not.toContain("\r\n");
    const saved = parseCharacter(JSON.parse(text));
    expect(saved.name).toBe("岩男");
    expect(saved.role).toBe("漁師");
    expect(saved.autoGenerated).toBe(true);

    const locationFiles = filesIn(nodePath.join(folder, "設定", "locations"));
    const lighthouse = locationFiles.find((name) => name.endsWith("_灯台.json"));
    expect(lighthouse).toBeDefined();
    expect(
      parseLocation(
        JSON.parse(
          fs.readFileSync(
            nodePath.join(folder, "設定", "locations", lighthouse as string),
            "utf8"
          )
        )
      ).description
    ).toBe("灯が毎晩火をともす塔");

    // 保存が済んだので、貯め場所は消えている
    expect(result.stashCleared).toBe(true);
    expect(fs.existsSync(extractStashFileOf(folder))).toBe(false);
  });

  it("既存の人物への変更は pending-characters へ（出どころは外部AI、理由付き）", () => {
    const folder = makeWork();
    stashBoth(folder);

    const result = extractCommit({ folder });

    expect(result.pending.character).toEqual(["灯"]);
    const pendingDir = nodePath.join(folder, ".aiwriter", "pending-characters");
    expect(filesIn(pendingDir)).toEqual([`${FIRST_CHARACTER_ID}.json`]);
    const payload: unknown = JSON.parse(
      fs.readFileSync(nodePath.join(pendingDir, `${FIRST_CHARACTER_ID}.json`), "utf8")
    );
    expect(readSource(payload)).toBe("external");
    expect((payload as { reason?: string }).reason).toContain("外部AI");
    const proposed = parseCharacter(unwrapPendingCharacter(payload));
    expect(proposed.summary).toBe("毎晩、灯台に火をともす娘");
  });

  it("既存の人物以外（場所）への変更は pending-settings へ", () => {
    const folder = makeWork();
    stashBoth(folder);

    const result = extractCommit({ folder });

    expect(result.pending.location).toEqual(["港町"]);
    const pendingDir = nodePath.join(folder, ".aiwriter", "pending-settings");
    const files = filesIn(pendingDir);
    expect(files).toHaveLength(1);
    const payload = parsePendingSettingsPayload(
      JSON.parse(fs.readFileSync(nodePath.join(pendingDir, files[0]), "utf8"))
    );
    expect(payload.recordKind).toBe("location");
    expect(payload.source).toBe("external");
    expect(payload.record.name).toBe("港町");
    expect(payload.record.description).toBe("灯の暮らす海辺の町");
  });

  it("dryRun では何も書かず、貯め場所も残す", () => {
    const folder = makeWork();
    stashBoth(folder);
    const before = fingerprints(folder);

    const result = extractCommit({ folder, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.createdCount).toBe(2);
    expect(result.pendingCount).toBe(2);
    expect(fingerprints(folder)).toEqual(before);
    expect(fs.existsSync(nodePath.join(folder, ".aiwriter", "pending-characters"))).toBe(
      false
    );
    expect(result.stashCleared).toBe(false);
    expect(readExtractStash(folder)).toHaveLength(2);
  });

  it("作者がまだ判断していない案があれば、その件だけ断って続ける", () => {
    const folder = makeWork();
    stashBoth(folder);
    const pendingDir = nodePath.join(folder, ".aiwriter", "pending-characters");
    fs.mkdirSync(pendingDir, { recursive: true });
    const earlier = '{"note":"作者がまだ見ていない案"}\n';
    fs.writeFileSync(nodePath.join(pendingDir, `${FIRST_CHARACTER_ID}.json`), earlier, "utf8");

    const result = extractCommit({ folder });

    expect(result.refused.map((item) => item.name)).toEqual(["灯"]);
    // 先の案は上書きされていない
    expect(fs.readFileSync(nodePath.join(pendingDir, `${FIRST_CHARACTER_ID}.json`), "utf8")).toBe(
      earlier
    );
    // ほかの件は保存されている
    expect(result.created.character).toEqual(["岩男"]);
    expect(result.pending.location).toEqual(["港町"]);
  });
});

describe("novel.extract.commit——何もない作品", () => {
  it("設定/ がまだ無い作品でも、新しい記録として保存する（承認待ちは0件）", () => {
    const folder = makeWork();
    fs.rmSync(nodePath.join(folder, "設定"), { recursive: true, force: true });
    stashBoth(folder);

    const result = extractCommit({ folder });

    expect(result.created.character.sort()).toEqual(["岩男", "灯"].sort());
    expect(result.created.location.sort()).toEqual(["港町", "灯台"].sort());
    expect(result.pendingCount).toBe(0);
    expect(
      filesIn(nodePath.join(folder, "設定", "characters")).filter((name) =>
        name.endsWith(".json")
      )
    ).toHaveLength(2);
    expect(fs.existsSync(nodePath.join(folder, ".aiwriter", "pending-characters"))).toBe(
      false
    );
  });
});

describe("novel.extract.commit——止まるところ・捨てるところ", () => {
  it("本文が変わったチャンクの貯めは捨てる（その話から作るはずの記録は作らない）", () => {
    const folder = makeWork();
    stashBoth(folder);
    // 第1話を書き足す（答えたあとに本文が変わった）
    fs.writeFileSync(
      nodePath.join(folder, "本文", EPISODE_1),
      `${TEXT_1}　灯は眠った。\n`,
      "utf8"
    );

    const result = extractCommit({ folder });

    expect(result.discardedChunks).toHaveLength(1);
    expect(result.discardedChunks[0].chunkId).toContain(EPISODE_1);
    expect(result.replayedChunks).toBe(1);
    // 第1話の答え（灯台・灯の紹介）は使っていない
    expect(result.created.location).toEqual([]);
    expect(result.pending.character).toEqual([]);
    expect(result.created.character).toEqual(["岩男"]);
  });

  it("設定/ に読めない JSON があれば、何も書かずに止まる（貯め場所も残す）", () => {
    const folder = makeWork();
    stashBoth(folder);
    fs.writeFileSync(
      nodePath.join(folder, "設定", "characters", "char_0009_壊れ.json"),
      "{ これは壊れている",
      "utf8"
    );
    const before = fingerprints(folder);

    expect(() => extractCommit({ folder })).toThrow(/読めない設定ファイル/);

    expect(fingerprints(folder)).toEqual(before);
    expect(fs.existsSync(nodePath.join(folder, ".aiwriter", "pending-characters"))).toBe(
      false
    );
    expect(readExtractStash(folder)).toHaveLength(2);
  });

  it("貯めたものが無ければ、どう貯めるかを添えて断る", () => {
    const folder = makeWork();
    expect(() => extractCommit({ folder })).toThrow(/stash: true/);
  });
});

describe("貯める口", () => {
  it("prompt は、貯めた分の人物を既知の名前として渡す", () => {
    const folder = makeWork();
    const before = settingsPrompt({
      folder,
      filePath: `本文/${EPISODE_1}`,
      numCtx: NUM_CTX,
    }).chunks[0];
    expect(before.userPrompt).not.toContain("岩男");

    settingsValidate({
      folder,
      chunkId: chunkIdOf(folder, EPISODE_2),
      response: JSON.stringify(ANSWER_2),
      stash: true,
    });

    const after = settingsPrompt({
      folder,
      filePath: `本文/${EPISODE_1}`,
      numCtx: NUM_CTX,
    }).chunks[0];
    expect(after.userPrompt).toContain("岩男");
    expect(after.knownCounts.characters).toBe(before.knownCounts.characters + 1);
  });

  it("stash を付けなければ貯めない", () => {
    const folder = makeWork();
    settingsValidate({
      folder,
      chunkId: chunkIdOf(folder, EPISODE_2),
      response: JSON.stringify(ANSWER_2),
    });
    expect(fs.existsSync(extractStashFileOf(folder))).toBe(false);
  });

  it("設定資料の抽出のほかで stash を付けたら、黙って無視せずに断る", () => {
    const folder = makeWork();
    expect(() =>
      novelValidate({
        folder,
        feature: "typo",
        chunkId: chunkIdOf(folder, EPISODE_2),
        response: "{}",
        stash: true,
      })
    ).toThrow(/feature: settings/);
  });

  it("原稿を外へ出さない道具として記録する", () => {
    expect(exposureOf("novel.extract.commit", { folder: "x" })).toBe("none");
  });
});
