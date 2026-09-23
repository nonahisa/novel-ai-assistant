import { describe, expect, test } from "vitest";
import { nextEpisodeFileNameLike } from "../../src/core/episodeRenumber";

/**
 * 「最新話を書く」「話を追加」の新しいファイル名は、**既存の話の名前の流儀**で
 * 作る（実機確認 2026-09-07：`episode_0001_気がついたら幽霊に.md` の作品に
 * `019.txt` ができた。設定の既定値に従うだけで、既存の名前を見ていなかった）。
 */
const fallback = { digits: 3, extension: ".txt" };

describe("次の話のファイル名", () => {
  test("接頭辞・桁数・拡張子を、いちばん新しい話から引き継ぐ", () => {
    expect(
      nextEpisodeFileNameLike({
        latestFileName: "episode_0018_屋敷の重圧と魂の輝き.md",
        number: 19,
        fallback,
      })
    ).toBe("episode_0019.md");
  });

  test("番号だけの名前なら、桁数と拡張子だけ引き継ぐ", () => {
    expect(
      nextEpisodeFileNameLike({ latestFileName: "0018.md", number: 19, fallback })
    ).toBe("0019.md");
  });

  test("第N話の形も引き継ぐ", () => {
    expect(
      nextEpisodeFileNameLike({
        latestFileName: "第3話 再会.md",
        number: 4,
        fallback,
      })
    ).toBe("第4話.md");
  });

  test("桁があふれても切らない", () => {
    expect(
      nextEpisodeFileNameLike({ latestFileName: "099.txt", number: 100, fallback })
    ).toBe("100.txt");
  });

  test("読めない名前しか無ければ、設定から作る", () => {
    expect(
      nextEpisodeFileNameLike({ latestFileName: "プロローグ.txt", number: 1, fallback })
    ).toBe("001.txt");
    expect(nextEpisodeFileNameLike({ latestFileName: null, number: 2, fallback })).toBe(
      "002.txt"
    );
  });
});
