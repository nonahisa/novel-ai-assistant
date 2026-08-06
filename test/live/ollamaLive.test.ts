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
