/**
 * 宛先がこの PC の中（localhost・127.0.0.1・::1）か（セキュリティ点検 2026-11-21）。
 *
 * クラウドのAIの http を通すか（`endpointNotice.ts`）と、手元のAIの宛先が外を指すときに
 * 確かめるか（`features/localAiHostApproval.ts`）の両方で使う。**同じ判定を2か所に書かない。**
 * 判断は `ai/ollamaLauncher.ts` の `isLocalEndpoint` と同じだが、あちらは Node 専用のファイル
 * （`node:child_process` を静的に読む）なので、ブラウザ版からも届くここに置く（実装ルール7）。
 *
 * VS Code API にも Node にも依存しない。
 */

/** URL として読めて、ホストがこの PC の中なら true */
export function isLoopbackEndpoint(endpoint: string): boolean {
  const url = parseEndpoint(endpoint);
  if (!url) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** 覚えるときの鍵（ホストと口。`192.168.1.20:11434`）。読めなければ undefined */
export function endpointHostKey(endpoint: string): string | undefined {
  const url = parseEndpoint(endpoint);
  return url ? url.host.toLowerCase() : undefined;
}

function parseEndpoint(endpoint: string): URL | undefined {
  try {
    return new URL(endpoint.trim());
  } catch {
    return undefined;
  }
}
