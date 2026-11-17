import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * ほかの機械の作品の［取り寄せる］（設計書5.5.11.1）。URL を渡せば入力を省き、
 * 置き場所・フォルダー名・既存フォルダーでの中止はこれまでどおり通る。
 */

const askText = vi.fn();
vi.mock("../../../src/views/dialogs", () => ({
  askText: (...args: unknown[]) => askText(...args),
}));
vi.mock("../../../src/core/git", () => ({ isGitAvailable: async () => true }));
const cloneRepository = vi.fn();
vi.mock("../../../src/core/gitClone", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/gitClone")>()),
  cloneRepository: (...args: unknown[]) => cloneRepository(...args),
  cloneWithGh: vi.fn(),
}));
vi.mock("../../../src/core/gitSetup", async (importOriginal) => ({
  validateRepositoryUrl: (
    await importOriginal<typeof import("../../../src/core/gitSetup")>()
  ).validateRepositoryUrl,
  ghAvailable: async () => false,
}));
const pathExists = vi.fn();
vi.mock("../../../src/core/fileSystem", () => ({
  pathExists: (...args: unknown[]) => pathExists(...args),
}));
vi.mock("../../../src/views/progress", () => ({
  withProgress: (_title: string, task: () => unknown) => task(),
}));
vi.mock("../../../src/features/addCollection", () => ({
  tryRegisterAsCollection: async () => ({ handled: false, added: [] }),
}));
vi.mock("../../../src/features/pickFolder", () => ({
  pickNewFolderParent: async () => "C:/novels",
}));
vi.mock("../../../src/views/notify", () => ({ notifyDone: vi.fn() }));

import { addWorkFromGithub } from "../../../src/features/addWorkFromGithub";
import type { WorkRegistry } from "../../../src/core/workRegistry";

const registry = {
  list: () => [],
  addExisting: async (folderPath: string, title: string) => ({
    id: "w1",
    title,
    folderPath,
    registeredAt: "2026-11-17T00:00:00.000Z",
  }),
} as unknown as WorkRegistry;

beforeEach(() => {
  askText.mockReset();
  cloneRepository.mockReset();
  pathExists.mockReset();
  pathExists.mockResolvedValue(false);
  cloneRepository.mockResolvedValue({ ok: true });
});

describe("URL を渡した取り寄せ", () => {
  test("URL の入力を聞かずに、その URL を clone へ渡す", async () => {
    // フォルダー名と作品名だけが聞かれる
    askText.mockImplementation(async (options: { value?: string }) => options.value);
    const added = await addWorkFromGithub(registry, {
      url: "https://github.com/nonahisa/hoshi.git",
    });
    expect(cloneRepository).toHaveBeenCalledWith(
      "https://github.com/nonahisa/hoshi.git",
      expect.stringContaining("hoshi")
    );
    const titles = askText.mock.calls.map(([options]) => (options as { title: string }).title);
    expect(titles).not.toContain("GitHubから作品を取り寄せる");
    expect(added.map((entry) => entry.title)).toEqual(["hoshi"]);
  });

  test("渡された URL が受け付けない形（トークン入り）なら、取り寄せない", async () => {
    const added = await addWorkFromGithub(registry, {
      url: "https://ghp_secret@github.com/nonahisa/hoshi.git",
    });
    expect(added).toEqual([]);
    expect(cloneRepository).not.toHaveBeenCalled();
  });

  test("同じ名前のフォルダーがあれば、これまでどおり中止する", async () => {
    askText.mockImplementation(async (options: { value?: string }) => options.value);
    pathExists.mockResolvedValue(true);
    const added = await addWorkFromGithub(registry, {
      url: "https://github.com/nonahisa/hoshi.git",
    });
    expect(added).toEqual([]);
    expect(cloneRepository).not.toHaveBeenCalled();
  });

  test("渡さなければ、これまでどおり URL を聞く", async () => {
    askText.mockResolvedValue(undefined);
    await addWorkFromGithub(registry);
    expect((askText.mock.calls[0][0] as { title: string }).title).toBe(
      "GitHubから作品を取り寄せる"
    );
  });
});
