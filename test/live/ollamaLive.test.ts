import { expect, test } from "vitest";
import { OllamaProvider } from "../../src/ai/ollamaProvider";
import { workspace } from "../unit/support/vscodeStub";

test("ローカルOllamaへ接続し、実モデル情報を取得する", async () => {
  workspace.getConfiguration = () => ({
    get: <T>(_key: string, defaultValue: T): T => defaultValue,
  });
  const provider = new OllamaProvider();

  const connection = await provider.testConnection();
  expect(connection.ok).toBe(true);
  expect(connection.modelCount).toBeGreaterThan(0);

  const models = await provider.listModels();
  expect(models.length).toBe(connection.modelCount);
  expect(models.every((model) => model.id && model.contextWindow > 0)).toBe(true);
});

/**
 * 「大きいけれど速い型」を、実物のOllamaから取れるか（作者の指示、2026-09-19）。
 *
 * **項目名が変わったら、ここで気づく。** 単体テストは2026-09-19の応答を
 * 写したものなので、Ollamaが `expert_count` の名前や前置きを変えても落ちない。
 *
 * **手元にどのモデルがあるかは決め打ちしない。** `gemma4:26b` があるときだけ
 * 実測（128個中8個）と突き合わせ、無ければ「どの行も筋が通っている」ことだけ
 * を確かめる。
 */
test("実モデルから部品の内訳を取れる", async () => {
  workspace.getConfiguration = () => ({
    get: <T>(_key: string, defaultValue: T): T => defaultValue,
  });
  const provider = new OllamaProvider();

  const models = await provider.listModels();
  for (const model of models) {
    if (model.experts === undefined) continue;
    // 一部だけを使うから速い。全部使うなら札を出す意味が無い
    expect(model.experts.used).toBeGreaterThan(0);
    expect(model.experts.total).toBeGreaterThan(model.experts.used);
  }

  const moe = models.find((model) => model.id === "gemma4:26b");
  if (moe) {
    // 2026-09-19 に作者の機械で測った値そのもの
    expect(moe.experts).toEqual({ total: 128, used: 8 });
  }
  // 部品を分けていないモデルは、項目そのものが返らない（分からないまま）
  const dense = models.find((model) => model.id === "gemma4:12b");
  if (dense) expect(dense.experts).toBeUndefined();
});
