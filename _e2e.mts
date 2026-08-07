// 本番の extractCharacters を実データで通して動かす。実行後は削除する。
import { extractCharacters } from "./src/features/extractCharacters.ts";
import type { WorkEntry } from "./src/models/types.ts";
import type { AIRegistry } from "./src/ai/registry.ts";
import { OllamaProvider } from "./src/ai/ollamaProvider.ts";

const WORK: WorkEntry = {
  id: "work_verify",
  title: "教科書チート(検証用)",
  folderPath: process.env.WORK_DIR!,
  registeredAt: new Date().toISOString(),
};

const provider = new OllamaProvider();

// 本番の registry と同じ形を返す。モデル情報は実際にOllamaから取る。
const registry = {
  resolve: () => ({ provider, model: "gemma4:e4b" }),
  resolveModelInfo: async () => provider.getModel("gemma4:e4b"),
} as unknown as AIRegistry;

// ensureConfigured は registry.resolve() を使う
async function main() {
  const t0 = Date.now();
  await extractCharacters(WORK, registry);
  const vs = require("vscode");
  console.log("=== UIログ ===");
  for (const [kind, msg] of vs.__log) console.log(`[${kind}] ${String(msg).slice(0, 600)}`);
  console.log(`完了: ${((Date.now() - t0) / 1000).toFixed(1)}秒`);
}
main().catch((e) => { console.error("致命的エラー:", e); process.exit(1); });
