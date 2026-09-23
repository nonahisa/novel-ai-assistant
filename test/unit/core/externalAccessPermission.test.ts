import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import {
  ALL_TOOLS,
  ANONYMOUS_CLIENT,
  DENIED,
  clientKeyOf,
  describeExternalAccessPermission,
  externalAccessDeniedMessage,
  formatExternalAccessPermission,
  isSamplingAllowed,
  isToolAllowed,
  parseExternalAccessPermission,
  samplingNotPermittedMessage,
} from "../../../src/core/externalAccessPermission";
import {
  assertExternalAccessAllowed,
  readExternalAccessPermission,
} from "../../../src/mcp/tools/permission";
import { setExternalClientName } from "../../../src/mcp/tools/accessLog";
import { IGNORED_PATHS } from "../../../src/core/workRegistry";

/**
 * 外部AIの利用は**既定で拒否**（設計書6.87.10・6.87.14。
 * 作者の指示、2026-09-15／16）。
 *
 * **ここで守りたいのは2つ。**
 *
 * 1. 意思確認をしていない作品の原稿が、外から1文字も読めないこと
 * 2. **許可しても全開放にならないこと**——許したのは「この接続元が、
 *    この道具を」であって、「この作品を外部AIに」ではない
 *
 * **迷ったら断る**側に倒っていることを、あらゆる入り方で確かめる。
 */

const temporary: string[] = [];

afterEach(() => {
  setExternalClientName("");
  for (const folder of temporary.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

/** 印を置いた作品を、一時に作る */
function workWith(permission: unknown): string {
  const folder = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-perm-"));
  fs.mkdirSync(nodePath.join(folder, ".aiwriter"), { recursive: true });
  fs.writeFileSync(
    nodePath.join(folder, ".aiwriter", "external-access.json"),
    JSON.stringify(permission),
    "utf8"
  );
  temporary.push(folder);
  return folder;
}

function allowing(
  client: string,
  tools: string[],
  sampling = false
): Record<string, unknown> {
  return {
    clients: [
      {
        name: client,
        tools,
        sampling,
        decidedAt: "2026-09-16T00:00:00.000Z",
        decidedOn: "テスト",
        note: "",
      },
    ],
  };
}

describe("印の読み方——迷ったら断る", () => {
  it("印が無ければ拒否", () => {
    const folder = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-perm-"));
    temporary.push(folder);
    expect(readExternalAccessPermission(folder).clients).toEqual([]);
  });

  it("壊れたJSONは拒否", () => {
    expect(parseExternalAccessPermission("{壊れている")).toEqual(DENIED);
  });

  it("配列や文字列は拒否", () => {
    expect(parseExternalAccessPermission("[]")).toEqual(DENIED);
    expect(parseExternalAccessPermission('"はい"')).toEqual(DENIED);
  });

  it("**古い形（allowed: true）は許可と読まない**", () => {
    /*
      0.66.1 で、許可は接続元ごと・道具ごとになった（作者の指示）。
      古い印は**作品ぜんたいを一括で許す**もので、いまの決まりと
      噛み合わない——**黙って通さず、決め直してもらう。**
    */
    const permission = parseExternalAccessPermission(
      JSON.stringify({ allowed: true, sampling: true })
    );
    expect(permission.clients).toEqual([]);
    expect(isToolAllowed(permission, "claude-code", "typo.run")).toBe(false);
    // **古い印だと分かるようにする**（断り文句で決め直しを促すため）
    expect(permission.legacy).toBe(true);
  });

  it("名前の無い接続元は読み飛ばす", () => {
    const permission = parseExternalAccessPermission(
      JSON.stringify({ clients: [{ name: "  ", tools: [ALL_TOOLS] }] })
    );
    expect(permission.clients).toEqual([]);
  });

  it("道具に文字列でないものが混ざっていても、そこだけ落とす", () => {
    const permission = parseExternalAccessPermission(
      JSON.stringify({
        clients: [{ name: "x", tools: ["typo.run", 1, null, "work.scan"] }],
      })
    );
    expect(permission.clients[0].tools).toEqual(["typo.run", "work.scan"]);
  });

  it("sampling は true そのものでなければ拒否", () => {
    const permission = parseExternalAccessPermission(
      JSON.stringify({ clients: [{ name: "x", tools: ["a"], sampling: "yes" }] })
    );
    expect(isSamplingAllowed(permission, "x")).toBe(false);
  });

  it("書いたものが、そのまま読める", () => {
    const original = parseExternalAccessPermission(
      JSON.stringify(allowing("claude-code", ["typo.run"], true))
    );
    const again = parseExternalAccessPermission(
      formatExternalAccessPermission(original)
    );
    expect(again.clients).toEqual(original.clients);
  });
});

describe("許しても全開放にしない", () => {
  it("**許した道具だけが通る**", () => {
    const permission = parseExternalAccessPermission(
      JSON.stringify(allowing("claude-code", ["typo.run"]))
    );
    expect(isToolAllowed(permission, "claude-code", "typo.run")).toBe(true);
    // ほかの道具は別に許可が要る
    expect(isToolAllowed(permission, "claude-code", "settings.run")).toBe(false);
  });

  it("**別の接続元には効かない**", () => {
    const permission = parseExternalAccessPermission(
      JSON.stringify(allowing("claude-code", [ALL_TOOLS]))
    );
    expect(isToolAllowed(permission, "claude-code", "typo.run")).toBe(true);
    expect(isToolAllowed(permission, "別のなにか", "typo.run")).toBe(false);
  });

  it("`*` を許していれば、その接続元には全部通る", () => {
    const permission = parseExternalAccessPermission(
      JSON.stringify(allowing("claude-code", [ALL_TOOLS]))
    );
    expect(isToolAllowed(permission, "claude-code", "これから足す道具")).toBe(
      true
    );
  });

  it("名乗らなかった相手は「名乗りなし」として扱う", () => {
    const permission = parseExternalAccessPermission(
      JSON.stringify(allowing(ANONYMOUS_CLIENT, ["work.scan"]))
    );
    expect(isToolAllowed(permission, "", "work.scan")).toBe(true);
    expect(isToolAllowed(permission, undefined, "work.scan")).toBe(true);
    expect(clientKeyOf("  ")).toBe(ANONYMOUS_CLIENT);
  });

  it("**考えさせる許可は、道具の許可とは別**", () => {
    const permission = parseExternalAccessPermission(
      JSON.stringify(allowing("claude-code", [ALL_TOOLS], false))
    );
    expect(isToolAllowed(permission, "claude-code", "typo.run")).toBe(true);
    // 全部の道具を許しても、考えさせるのは閉じたまま
    expect(isSamplingAllowed(permission, "claude-code")).toBe(false);
  });
});

describe("門番——道具が動く前に断る", () => {
  it("許していない道具は断る", () => {
    setExternalClientName("claude-code");
    const folder = workWith(allowing("claude-code", ["work.scan"]));
    expect(() =>
      assertExternalAccessAllowed({ folder }, "typo.run")
    ).toThrow(/typo\.run/);
  });

  it("許した道具は通る", () => {
    setExternalClientName("claude-code");
    const folder = workWith(allowing("claude-code", ["typo.run"]));
    expect(() =>
      assertExternalAccessAllowed({ folder }, "typo.run")
    ).not.toThrow();
  });

  it("**同じ道具でも、別の接続元なら断る**", () => {
    setExternalClientName("別のなにか");
    const folder = workWith(allowing("claude-code", [ALL_TOOLS]));
    expect(() =>
      assertExternalAccessAllowed({ folder }, "typo.run")
    ).toThrow();
  });

  it("作品を指していない呼び出しは素通り（許可の対象が無い）", () => {
    expect(() => assertExternalAccessAllowed({}, "mcp.version")).not.toThrow();
  });

  it("断る返事に、**どうすれば使えるか**が書いてある", () => {
    const message = externalAccessDeniedMessage({
      client: "claude-code",
      tool: "typo.run",
      legacy: false,
    });
    // 誰が・何を
    expect(message).toContain("claude-code");
    expect(message).toContain("typo.run");
    // どうすれば
    expect(message).toContain("VS Code");
    // なぜ既定が拒否か
    expect(message).toContain("道具ごと");
  });

  it("古い印が残っていれば、決め直しが要ると書く", () => {
    const message = externalAccessDeniedMessage({
      client: "claude-code",
      tool: "typo.run",
      legacy: true,
    });
    expect(message).toContain("決め直");
  });

  it("考えさせるのを断る返事に、代わりの道が書いてある", () => {
    const message = samplingNotPermittedMessage("claude-code");
    expect(message).toContain("claude-code");
    expect(message).toContain("ollama");
  });
});

describe("画面に出す一文", () => {
  it("何も許していなければ、そう言う", () => {
    expect(describeExternalAccessPermission(DENIED)).toContain("拒否");
  });

  it("**誰に・どれだけ許したかを言う**", () => {
    const permission = parseExternalAccessPermission(
      JSON.stringify(allowing("claude-code", ["typo.run", "work.scan"]))
    );
    const text = describeExternalAccessPermission(permission);
    expect(text).toContain("claude-code");
    expect(text).toContain("2個の道具");
    // **ほかは拒否**であることも言う（許可＝全開放と読ませない）
    expect(text).toContain("拒否");
  });

  it("考えさせる許可は、別に出す", () => {
    const permission = parseExternalAccessPermission(
      JSON.stringify(allowing("claude-code", [ALL_TOOLS], true))
    );
    expect(describeExternalAccessPermission(permission)).toContain("考えさせる");
  });
});

describe("置き場所", () => {
  it("**同期しない**（許可は、その機械で作者が与えるもの）", () => {
    expect(IGNORED_PATHS).toContain(".aiwriter/external-access.json");
  });
});
