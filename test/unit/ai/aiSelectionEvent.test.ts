import { describe, expect, test } from "vitest";
import type * as vscode from "vscode";
import { AIRegistry } from "../../src/ai/registry";

/**
 * AIの選択は globalState にあり、変えても VS Code からは何の合図も出ない。
 * そのため、開きっぱなしの「AIに相談」パネルはエンジン表示を更新する
 * きっかけが無く、切り替え前の名前を出し続けていた（0.22.15）。
 * レジストリ自身が合図を出すことを確かめる。
 */

function fakeContext(): vscode.ExtensionContext {
  const store = new Map<string, unknown>();
  return {
    globalState: {
      get: (key: string) => store.get(key),
      update: async (key: string, value: unknown) => {
        if (value === undefined) store.delete(key);
        else store.set(key, value);
      },
    },
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
  } as unknown as vscode.ExtensionContext;
}

describe("AIの選択変更の合図", () => {
  test("選ぶと合図が飛ぶ（開いたままのパネルが表示を更新できる）", async () => {
    const registry = new AIRegistry(fakeContext());
    let fired = 0;
    registry.onDidChangeSelection(() => {
      fired++;
    });

    await registry.select("ollama", "gemma");

    expect(fired).toBe(1);
    expect(registry.selectedProviderId).toBe("ollama");
  });

  test("解除でも合図が飛ぶ", async () => {
    const registry = new AIRegistry(fakeContext());
    let fired = 0;
    registry.onDidChangeSelection(() => {
      fired++;
    });

    await registry.select("ollama", "gemma");
    await registry.clear();

    expect(fired).toBe(2);
    expect(registry.selectedProviderId).toBeUndefined();
  });

  test("聞くのをやめたら、それ以降は呼ばれない", async () => {
    const registry = new AIRegistry(fakeContext());
    let fired = 0;
    const listener = registry.onDidChangeSelection(() => {
      fired++;
    });

    await registry.select("ollama", "gemma");
    listener.dispose();
    await registry.select("lmstudio", "qwen");

    expect(fired).toBe(1);
  });
});
