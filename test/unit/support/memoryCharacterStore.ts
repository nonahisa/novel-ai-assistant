import type { Character } from "../../../src/models/character";
import type { PendingUpdate } from "../../../src/core/pendingReview";

/**
 * 人物の保存先と反映待ちを、ディスクの代わりに記憶で持つ部品（重複の候補の［戻す］の単体テスト用）。
 *
 * `CharacterStore` の約束だけを写す——既にあるファイルは上書きしない（書き換えは
 * 退避 → 新規作成）、退避したファイルは回復用の場所に残る、読み込んだときの控え
 * （保存先とハッシュ）で書き換えを確かめる。ハッシュはファイルの中身そのもので代える。
 */
export function memoryCharacterStore(initial: Character[]) {
  const files = new Map<string, string>();
  const snapshots = new Map<string, { filePath: string; hash: string }>();
  const calls: string[] = [];
  let recoveries = 0;
  let broken: string[] = [];
  /** 次の restoreRetired を何回目で失敗させるか（0 なら失敗させない） */
  let failRestoreAt = 0;
  let restores = 0;

  const pathOf = (character: Character): string => `chars/${character.id}.json`;
  const write = (character: Character): void => {
    const filePath = pathOf(character);
    const body = JSON.stringify(character);
    files.set(filePath, body);
    snapshots.set(character.id, { filePath, hash: body });
  };
  for (const character of initial) write(character);

  const filesOfId = (id: string): string[] =>
    [...files.keys()].filter((filePath) => filePath === `chars/${id}.json`);

  const store = {
    calls,
    files,
    /** 読み込めないファイルがある、を作る */
    breakFile(name: string) {
      broken = [name];
    },
    failRestore(nth: number) {
      failRestoreAt = nth;
      restores = 0;
    },
    /** 作者がパネルの外で書き換えた、を作る（控えは古いまま） */
    tamper(id: string, change: Partial<Character>) {
      const filePath = `chars/${id}.json`;
      const current = files.get(filePath);
      if (!current) throw new Error(`${id} がありません`);
      files.set(filePath, JSON.stringify({ ...(JSON.parse(current) as Character), ...change }));
    },
    /** いまのファイルを人物として読む */
    read(id: string): Character | undefined {
      const body = files.get(`chars/${id}.json`);
      return body ? (JSON.parse(body) as Character) : undefined;
    },
    async loadAll() {
      snapshots.clear();
      const characters: Character[] = [];
      for (const [filePath, body] of files) {
        // 回復用の場所は読まない（製品の `loadAll` も `.json` だけを読む）
        if (!filePath.startsWith("chars/") || !filePath.endsWith(".json")) continue;
        const character = JSON.parse(body) as Character;
        characters.push(character);
        snapshots.set(character.id, { filePath, hash: body });
      }
      characters.sort((a, b) => a.id.localeCompare(b.id));
      return { characters, errors: broken.map((file) => ({ file, message: "壊れています" })) };
    },
    snapshotOf(id: string) {
      const snapshot = snapshots.get(id);
      return snapshot ? { ...snapshot } : undefined;
    },
    async fileHash(filePath: string) {
      return files.get(filePath);
    },
    async retire(id: string): Promise<string> {
      const snapshot = snapshots.get(id);
      if (!snapshot || files.get(snapshot.filePath) !== snapshot.hash) {
        throw new Error(`人物「${id}」は読み込み後に変更されています。`);
      }
      recoveries++;
      const recoveryPath = `chars/.novelai-recovery/${id}-${recoveries}.bak`;
      files.set(recoveryPath, snapshot.hash);
      files.delete(snapshot.filePath);
      snapshots.delete(id);
      calls.push(`retire:${id}`);
      return recoveryPath;
    },
    async save(character: Character): Promise<void> {
      if (filesOfId(character.id).length > 0 || snapshots.has(character.id)) {
        throw new Error(`人物「${character.id}」の保存先はすでに存在します。`);
      }
      write(character);
      calls.push(`save:${character.id}`);
    },
    async saveOrUpdate(character: Character): Promise<void> {
      if (snapshots.has(character.id)) await store.retire(character.id);
      await store.save(character);
    },
    async restoreRetired(recoveryPath: string, destinationPath: string, expectedHash: string) {
      restores++;
      if (failRestoreAt > 0 && restores === failRestoreAt) {
        throw new Error("書けません");
      }
      const body = files.get(recoveryPath);
      if (body !== expectedHash) throw new Error("回復用の場所のファイルが変わっています");
      if (files.has(destinationPath)) throw new Error("保存先はすでに存在します");
      files.set(destinationPath, body);
      const character = JSON.parse(body) as Character;
      snapshots.set(character.id, { filePath: destinationPath, hash: body });
      calls.push(`restore:${character.id}`);
    },
  };
  return store;
}

/** 反映待ちをディスクの代わりに記憶で持つ部品。読むたびに写しを返す（ファイルを読み直すのと同じ） */
export function memoryPendingStore(initial: PendingUpdate[] = []) {
  const files = new Map(initial.map((update) => [update.filePath, structuredClone(update)]));
  return {
    files,
    async loadAll() {
      return {
        updates: [...files.values()].map((update) => structuredClone(update)),
        errors: [] as Array<{ file: string; message: string }>,
      };
    },
    async stage(
      characters: Character[],
      options: { source?: PendingUpdate["source"]; kind?: PendingUpdate["kind"]; reason?: string } = {}
    ) {
      for (const character of characters) {
        const filePath = `pending/${character.id}.json`;
        files.set(filePath, structuredClone({ character, filePath, ...options }));
      }
    },
    async discard(filePath: string) {
      files.delete(filePath);
    },
  };
}
