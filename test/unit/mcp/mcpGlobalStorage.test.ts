import { describe, expect, it } from "vitest";
import nodePath from "node:path";
import {
  EXTENSION_STORAGE_ID,
  defaultStorageCandidates,
  resolveStorageRoot,
  storageFallbackLine,
  withStorageNote,
  type StorageProbe,
} from "../../../src/mcp/globalStorage";

/**
 * MCP が保管庫を探す順（2026-10-05）。別の機械で環境変数が無く、
 * `dist/mcp-server.mjs` を走らせたら `dist/.aiwriter` を読んで登録簿が空だった。
 */

const WIN_APPDATA = "C:\\Users\\a\\AppData\\Roaming";
const WIN_DEFAULT = nodePath.win32.join(WIN_APPDATA, "Code", "User", "globalStorage", EXTENSION_STORAGE_ID);

function probe(overrides: Partial<StorageProbe>): StorageProbe {
  return {
    env: undefined,
    bundlePath: "C:\\repo\\dist\\mcp-server.mjs",
    platform: "win32",
    home: "C:\\Users\\a",
    appData: WIN_APPDATA,
    xdgConfigHome: undefined,
    exists: () => false,
    ...overrides,
  };
}

describe("resolveStorageRoot", () => {
  it("環境変数があれば必ずそれ", () => {
    const got = resolveStorageRoot(probe({ env: "D:\\store", exists: () => true }));
    expect(got).toEqual({ root: nodePath.resolve("D:\\store"), source: "env" });
  });

  it("dist から走らせた束は、VS Code の既定の保管庫を見つけて使う（再現：以前は dist を返した）", () => {
    const got = resolveStorageRoot(probe({ exists: (dir) => dir === WIN_DEFAULT }));
    expect(got).toEqual({ root: WIN_DEFAULT, source: "default" });
  });

  it("束が保管庫に写してあれば、既定の場所より先にそこを使う（Insiders などの取り違えを防ぐ）", () => {
    const bundleDir = "C:\\Users\\a\\AppData\\Roaming\\Code - Insiders\\User\\globalStorage\\nonahisa.novel-ai-assistant";
    const got = resolveStorageRoot(
      probe({ bundlePath: `${bundleDir}\\mcp-server.mjs`, exists: () => true })
    );
    expect(got?.source).toBe("bundle");
    expect(got?.root).toBe(nodePath.resolve(bundleDir));
  });

  it("どこにも無ければ束の親へ落ち、断りの1行が出る", () => {
    const got = resolveStorageRoot(probe({}));
    expect(got?.source).toBe("bundleFallback");
    expect(storageFallbackLine(got)).toContain("保管庫は");
    const noted = withStorageNote({ note: "元の注意" }, got) as { note: string };
    expect(noted.note.split("\n")).toHaveLength(2);
    expect(noted.note).toContain("元の注意");
  });

  it("MCP の束でない（試験の道具など）ときは既定の場所を探さない", () => {
    const got = resolveStorageRoot(
      probe({ bundlePath: "C:\\repo\\node_modules\\vitest\\vitest.mjs", exists: () => true })
    );
    expect(got?.source).toBe("bundle");
  });

  it("見つかったときは note に足さない", () => {
    expect(withStorageNote({ a: 1 }, { root: "x", source: "default" })).toEqual({ a: 1 });
  });
});

describe("defaultStorageCandidates", () => {
  it("macOS と Linux の既定", () => {
    const mac = defaultStorageCandidates({ platform: "darwin", home: "/Users/a", appData: undefined, xdgConfigHome: undefined });
    expect(mac[0]).toBe(`/Users/a/Library/Application Support/Code/User/globalStorage/${EXTENSION_STORAGE_ID}`);
    const linux = defaultStorageCandidates({ platform: "linux", home: "/home/a", appData: undefined, xdgConfigHome: "/cfg" });
    expect(linux[0]).toBe(`/cfg/Code/User/globalStorage/${EXTENSION_STORAGE_ID}`);
    expect(linux[1]).toContain("Code - Insiders");
  });
});
