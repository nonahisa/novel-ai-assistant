import { ollamaEndpoint } from "../features/aiConnectivity";
import { lmstudioEndpoint } from "./lmstudioProvider";
import type { ProviderId } from "./types";

/**
 * **もう一方の手元AIが動いていないか**を確かめる（設計書6.62.2）。
 *
 * 作者のログ（2026-09-01）で、LM Studio が `gemma-4-12b-qat` を文脈131,072で
 * 保持している最中に、Ollama が18GBの `gemma4:26b` を載せにいって
 * llama-server ごと落ちた（CUDAエラー＋スタック破壊）。原因は作者の言葉で
 * 「OllamaとLM Studioを同時起動していたようです」。
 *
 * **この拡張機能は、両方を同時に使う作り**である（機能別割当。6.28.9）。
 * 誤字脱字は LM Studio、抽出は Ollama、という割り当てができるので、
 * **2つの推論エンジンが同じメモリを取り合う状況は、こちらが作っている。**
 *
 * それなのに、読み込みに失敗したときの案内は「より小さいモデルを選ぶか、
 * 文脈を短く」だけだった。**いちばん効く一手（もう一方を終了する）を
 * 言っていなかった。**
 *
 * ## 失敗したときだけ確かめる
 *
 * 常に見張らない。**1回のHTTPで済むが、それでも「動いている間ずっと
 * 相手を突く」理由は無い。** 読み込みに失敗した瞬間だけ、相手が応答するかを
 * 見て、案内へ一言足す。
 */

/** 手元で動く（＝メモリを取り合う）プロバイダ */
const LOCAL_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>([
  "ollama",
  "lmstudio",
]);

export function isLocalProvider(id: ProviderId): boolean {
  return LOCAL_PROVIDERS.has(id);
}

/**
 * 失敗した側から見た「もう一方」。手元AI以外なら undefined。
 *
 * **名前と接続先を対で返す。** 案内に名前を出さないと、作者は
 * どちらを終了すればよいのか分からない。
 */
export function otherLocalAi(
  failed: ProviderId
): { name: string; endpoint: string } | undefined {
  if (failed === "ollama") {
    return { name: "LM Studio", endpoint: lmstudioEndpoint() };
  }
  if (failed === "lmstudio") {
    return { name: "Ollama", endpoint: ollamaEndpoint() };
  }
  return undefined;
}

/**
 * 案内へ足す一文。もう一方が動いていなければ空文字。
 *
 * **動いていないときは何も言わない。** 心当たりの無い助言を並べると、
 * 本当に効く助言まで読み飛ばされる。
 */
export async function noteOtherLocalAiRunning(
  failed: ProviderId,
  probe: (endpoint: string) => Promise<boolean> = defaultProbe
): Promise<string> {
  const other = otherLocalAi(failed);
  if (!other) return "";
  let running = false;
  try {
    running = await probe(other.endpoint);
  } catch {
    // 確かめられないなら黙る。**ここで失敗しても、元の失敗の報告は続ける**
    return "";
  }
  if (!running) return "";
  // 通知にそのまま出るので、Markdownの記号は使わない（`plainTextUi.test.ts`）
  return (
    `${other.name}も動いています。` +
    "2つのAIが同じメモリを取り合うため、" +
    `使わないほうの${other.name}を終了すると載ることがあります。`
  );
}

async function defaultProbe(endpoint: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    // 生きているかだけを見る。どの道を叩いても、応答が返れば動いている
    const response = await fetch(new URL("/", endpoint).toString(), {
      signal: controller.signal,
    });
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
