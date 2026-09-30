import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

/**
 * 画面へ本文を送る便の追い越し（ノートPCの観測、2026-09-30）。
 *
 * 組んで書くで「！」」と打つと「」！」と入った。記録には同じ秒に
 * 「届いた1328字／画面1329字」→「届いた1329字／画面1328字」の組み直しが
 * 並んでいた——**画面より1字古い本文が、あとから届いている。**
 *
 * `send` は本文を控えてから、用語の索引・作品の形式・傍点の書き方の
 * 3つを待って `postMessage` していた。`scheduleSend` は前の便が待ちの途中でも
 * 次の便を始めるので、**先の便（古い本文）が待ちで遅れ、後の便を追い越される。**
 * 画面は古い本文を「外からの変更」と見て組み直し、カーソルと字がずれる。
 *
 * **本文は、待ちが全部済んでから読む。** 読んでから `postMessage` までに
 * 待ちが無ければ、あとから画面へ届く便ほど本文が新しい（同じ本文が2度届くのは
 * 画面の `isOwnEcho` が受ける）。
 */
describe("画面へ本文を送る便", () => {
  const source = readFileSync("src/features/manuscriptEditor.ts", "utf8");
  const start = source.indexOf("const send = async (): Promise<void> => {");
  const post = source.indexOf("await panel.webview.postMessage({", start);
  const body = source.slice(start, post);

  test("send が見つかる（形が変わったらこのテストを直す）", () => {
    expect(start).toBeGreaterThan(-1);
    expect(post).toBeGreaterThan(start);
  });

  test("本文は、最後の待ちより後ろで読む", () => {
    const readAt = body.indexOf("document.getText()");
    const lastAwait = body.lastIndexOf("await ");
    expect(readAt).toBeGreaterThan(-1);
    expect(readAt).toBeGreaterThan(lastAwait);
  });

  test("送る中身を組むあいだにも待たない", () => {
    const end = source.indexOf("});", post);
    const message = source.slice(post + "await panel.webview.postMessage({".length, end);
    expect(message).not.toContain("await ");
  });
});
