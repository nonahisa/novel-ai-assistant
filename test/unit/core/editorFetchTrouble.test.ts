import { describe, expect, test, vi } from "vitest";
import {
  AUTO_PROBE_INTERVAL_MS,
  END_WORK_BUTTON,
  fetchTroubleMessage,
  fetchTroubleOf,
  githubHttpsRef,
  OFFLINE_RECEIVE_MESSAGE,
  shouldProbeNow,
} from "../../../src/core/editorFetchTrouble";
import {
  deleteRepository,
  probeRepository,
} from "../../../src/core/githubCollaboration";

/**
 * 編集者の側で、受け取れなかった理由を分ける（設計書5.7.5.4。作者の決定 2026-11-07「分けて知らせる」）。
 *
 * **見分けは git の文で当てず、GitHub の API の返事の番号で決める**（実装ルール5）。
 * 確かめた出力（2026-11-07、作者の機械）：無い／権利の無い非公開のリポジトリは API が 404、
 * 名前が引けないときは通信そのものが失敗する。
 */

function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ref = { owner: "hisa", repo: "ice-editing" };

describe("リポジトリが見えるか（GET /repos/{owner}/{repo}）", () => {
  test("404 は notFound、通信の失敗は network、200 は visible", async () => {
    expect(await probeRepository("t", ref, async () => json(404, { message: "Not Found" }))).toBe(
      "notFound"
    );
    expect(
      await probeRepository("t", ref, (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch)
    ).toBe("network");
    expect(await probeRepository("t", ref, async () => json(200, { private: true }))).toBe(
      "visible"
    );
  });

  test("鍵が無い・401・403 は unknown（判定に使わない）。鍵が無ければ引かない", async () => {
    const fetchImpl = vi.fn(async () => json(404));
    expect(await probeRepository(undefined, ref, fetchImpl)).toBe("unknown");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await probeRepository("t", ref, async () => json(401, { message: "Bad credentials" }))).toBe(
      "unknown"
    );
    expect(await probeRepository("t", ref, async () => json(403, { message: "x" }))).toBe("unknown");
  });

  test("引く先は GET /repos/{owner}/{repo}", async () => {
    const fetchImpl = vi.fn(async () => json(200, {}));
    await probeRepository("t", ref, fetchImpl);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/hisa/ice-editing");
    expect(init.method).toBe("GET");
  });
});

describe("判定：API の返事から理由へ", () => {
  test("404→解除か置き場が無い、通信失敗→回線、200→分からない、そのほか→分からない", () => {
    expect(fetchTroubleOf("notFound")).toBe("revoked");
    expect(fetchTroubleOf("network")).toBe("offline");
    expect(fetchTroubleOf("visible")).toBe("unknown");
    expect(fetchTroubleOf("unknown")).toBe("unknown");
  });

  test("知らせの文：解除は題を入れ、回線はもう一度押すよう言う。分からないときは今までの文へ任せる", () => {
    expect(fetchTroubleMessage("revoked", "氷の街")).toBe(
      "「氷の街」の置き場に届きませんでした。作者が連携を解除したか、置き場が無くなった見込みです。"
    );
    expect(fetchTroubleMessage("offline", "氷の街")).toBe(OFFLINE_RECEIVE_MESSAGE);
    expect(OFFLINE_RECEIVE_MESSAGE).toContain("もう一度押してください");
    expect(fetchTroubleMessage("unknown", "氷の街")).toBeUndefined();
    expect(END_WORK_BUTTON).toBe("この作品の編集を終える");
  });
});

describe("送り先が github.com の https か", () => {
  test("https は読む（.git・認証の名前つきも）", () => {
    expect(githubHttpsRef("https://github.com/hisa/ice-editing.git\n")).toEqual(ref);
    expect(githubHttpsRef("https://hisa@github.com/hisa/ice-editing")).toEqual(ref);
  });

  test("ssh・ほかの置き場は見分けに使わない", () => {
    expect(githubHttpsRef("git@github.com:hisa/ice-editing.git")).toBeUndefined();
    expect(githubHttpsRef("https://gitlab.com/hisa/ice-editing.git")).toBeUndefined();
    expect(githubHttpsRef("https://github.com.evil.example/hisa/ice-editing")).toBeUndefined();
  });
});

describe("自動の取りに行きの間引き", () => {
  test("初回は引く。10分たつまでは引かない", () => {
    expect(shouldProbeNow(undefined, 1000)).toBe(true);
    expect(shouldProbeNow(1000, 1000 + AUTO_PROBE_INTERVAL_MS - 1)).toBe(false);
    expect(shouldProbeNow(1000, 1000 + AUTO_PROBE_INTERVAL_MS)).toBe(true);
    expect(AUTO_PROBE_INTERVAL_MS).toBe(10 * 60 * 1000);
  });
});

describe("編集用リポジトリを消す（DELETE /repos/{owner}/{repo}）", () => {
  test("204 は消せた", async () => {
    const fetchImpl = vi.fn(async () => json(204));
    expect(await deleteRepository("t", ref, fetchImpl)).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/hisa/ice-editing");
    expect(init.method).toBe("DELETE");
  });

  test("403＝権限が無い（delete_repo が足りない）、404＝見つからない、通信の失敗、401（番号で分ける）", async () => {
    const forbidden = await deleteRepository("t", ref, async () =>
      json(403, { message: "Must have admin rights to Repository." })
    );
    const missing = await deleteRepository("t", ref, async () => json(404, { message: "Not Found" }));
    const offline = await deleteRepository("t", ref, (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);
    const unauthorized = await deleteRepository("t", ref, async () => json(401, { message: "x" }));
    expect(forbidden.ok === false && forbidden.reason).toBe("noPermission");
    // 404 は消せたとみなさない（別のアカウントでも 404 が返る）
    expect(missing.ok === false && missing.reason).toBe("notFound");
    expect(offline.ok === false && offline.reason).toBe("network");
    expect(unauthorized.ok === false && unauthorized.reason).toBe("unauthorized");
  });
});
