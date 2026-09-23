import { describe, expect, test } from "vitest";
import {
  describeChatReload,
  matchReloadTarget,
  parseChatReload,
  RELOAD_KIND_LABELS,
  type ReloadCandidate,
} from "../../src/core/chatReload";
import { KIND_LABELS } from "../../src/core/settingsSummary";
import {
  parseWorkChatAnswer,
  WORK_CHAT_SCHEMA,
  WORK_CHAT_SYSTEM_PROMPT,
} from "../../src/prompts/workChat";
import { buildWorkChatPanelHtml } from "../../src/views/workChatPanelHtml";

/**
 * 相談からの「AIで再読込」（設計書6.31.3）。
 *
 * 発端は、実データで「アジャーノ」に別人（殿下）の記述が混ざっていたこと。
 * 作者が相談でそれを訴えたら、**その記録を読み直すボタン**が出るようにした。
 *
 * ここで確かめるのは2つある。
 * 1. AIの返した `reloadRecord` を、形の合うものだけ受け取ること
 * 2. **実在するレコードにだけボタンを出すこと。** AIの書いた名前を
 *    そのまま操作の対象にしない（`run` と同じ原則）
 */

describe("reloadRecord の読み取り", () => {
  test("種別・名前・留意点を受け取る", () => {
    const parsed = parseChatReload({
      kind: "character",
      name: "アジャーノ",
      notes: "他の登場人物『殿下』の情報が混入しています。",
    });

    expect(parsed).toEqual({
      kind: "character",
      name: "アジャーノ",
      notes: "他の登場人物『殿下』の情報が混入しています。",
    });
  });

  test("留意点は無くてよい（従来の「充実」と同じ動きになる）", () => {
    const parsed = parseChatReload({ kind: "location", name: "王都" });

    expect(parsed?.kind).toBe("location");
    expect(parsed?.notes).toBeUndefined();
  });

  test("知らない種別は受け付けない", () => {
    // 世界観（world）は対象外（6.31.3）。綴りの崩れも同じく捨てる
    for (const kind of ["world", "キャラクター", "", "plot", 3]) {
      expect(parseChatReload({ kind, name: "アジャーノ" }), String(kind)).toBe(
        undefined
      );
    }
  });

  test("名前が無ければ受け付けない", () => {
    expect(parseChatReload({ kind: "character", name: "   " })).toBe(undefined);
    expect(parseChatReload({ kind: "character" })).toBe(undefined);
    // 名前ではなく文章を書いてきたもの
    expect(
      parseChatReload({ kind: "character", name: "あ".repeat(61) })
    ).toBe(undefined);
  });

  test("中身の無い留意点は落とす", () => {
    // **指示の言葉がそのまま返ってくる。** 「特になし」を留意点として
    // 渡すと、読み直すAIがそれを申し送りとして読む
    for (const notes of ["特になし", "null", "変更なし", "-", "  "]) {
      const parsed = parseChatReload({
        kind: "ability",
        name: "炎の加護",
        notes,
      });
      expect(parsed?.notes, notes).toBeUndefined();
    }
  });

  test("種別以外が入っていても無視する", () => {
    expect(parseChatReload("アジャーノ")).toBe(undefined);
    expect(parseChatReload(null)).toBe(undefined);
    expect(parseChatReload([{ kind: "character", name: "アジャーノ" }])).toBe(
      undefined
    );
  });

  test("種別の見出しは設定資料パネルと同じ言葉を使う", () => {
    // ここが食い違うと、相談のボタンと資料の画面で呼び名が変わる
    for (const [kind, label] of Object.entries(RELOAD_KIND_LABELS)) {
      expect(KIND_LABELS[kind as keyof typeof KIND_LABELS]).toBe(label);
    }
  });
});

describe("実在するレコードとの照合", () => {
  const records: ReloadCandidate[] = [
    { id: "char-001", name: "アジャーノ", aliases: ["アジャン", "隊長"] },
    { id: "char-002", name: "エレナ", aliases: ["殿下"] },
    { id: "char-003", name: "シル", aliases: [] },
  ];

  test("名前が一致すれば、そのレコードを開く", () => {
    expect(matchReloadTarget(records, "アジャーノ")?.id).toBe("char-001");
  });

  test("別名でも一致する", () => {
    expect(matchReloadTarget(records, "殿下")?.id).toBe("char-002");
  });

  test("敬称や空白の違いは吸収する", () => {
    expect(matchReloadTarget(records, "アジャーノ様")?.id).toBe("char-001");
    expect(matchReloadTarget(records, " シル ")?.id).toBe("char-003");
  });

  test("名前を別名より先に見る", () => {
    // 「シル」が別人の別名でもあるとき、名前のほうを採らないと
    // 読み直す相手が入れ替わる
    const withAlias: ReloadCandidate[] = [
      { id: "char-010", name: "ミラ", aliases: ["シル"] },
      ...records,
    ];
    expect(matchReloadTarget(withAlias, "シル")?.id).toBe("char-003");
  });

  test("実在しなければ何も返さない（ボタンを出さない）", () => {
    expect(matchReloadTarget(records, "ヴァルド")).toBe(undefined);
    expect(matchReloadTarget(records, "")).toBe(undefined);
    expect(matchReloadTarget([], "アジャーノ")).toBe(undefined);
  });

  test("ボタンの言葉は、照合が通った名前で作る", () => {
    const target = matchReloadTarget(records, "アジャーノ様");
    expect(describeChatReload(target!.name)).toBe("「アジャーノ」をAIで再読込");
  });
});

describe("P-21 の応答", () => {
  test("reloadRecord を取り出せる", () => {
    const answer = parseWorkChatAnswer(
      JSON.stringify({
        reply: "混入しているようです。",
        reloadRecord: { kind: "character", name: "アジャーノ", notes: "混入" },
      })
    );

    expect(parseChatReload(answer.reloadRecord)?.name).toBe("アジャーノ");
  });

  test("無いときは undefined のまま（提案は出ない）", () => {
    const answer = parseWorkChatAnswer('{"reply":"はい。"}');
    expect(answer.reloadRecord).toBeUndefined();
  });

  test("プロンプトに reloadRecord の使い方が書いてある", () => {
    expect(WORK_CHAT_SYSTEM_PROMPT).toContain("reloadRecord");
    // 実在しない名前を書かせないこと（照合で落ちてボタンが出なくなる）
    expect(WORK_CHAT_SYSTEM_PROMPT).toContain("実在する名前");
    // 4つの種別が示されている
    for (const kind of ["character", "location", "ability", "organization"]) {
      expect(WORK_CHAT_SYSTEM_PROMPT, kind).toContain(`"${kind}"`);
    }
  });

  test("スキーマに reloadRecord がある（小さいモデルに落とさせない）", () => {
    const schema = WORK_CHAT_SCHEMA as unknown as {
      properties: Record<string, unknown>;
      required: string[];
    };

    expect(schema.properties.reloadRecord).toBeTruthy();
    expect(schema.required).toContain("reloadRecord");
  });
});

describe("相談パネルの画面", () => {
  const HTML = buildWorkChatPanelHtml("test-nonce", "vscode-resource:");

  function script(): string {
    const found = HTML.match(/<script nonce="test-nonce">([\s\S]*?)<\/script>/);
    expect(found, "スクリプトが見つからない").toBeTruthy();
    return found![1];
  }

  test("スクリプトがJavaScriptとして読める", () => {
    expect(() => new Function(script())).not.toThrow();
  });

  test("再読込のボタンを出せる", () => {
    expect(script()).toContain("appendReload");
    expect(script()).toContain("'reload'");
  });

  test("押すまで何も起きない（押したときにだけ送る）", () => {
    const code = script();
    const body = code.slice(
      code.indexOf("function appendReload"),
      code.indexOf("/** 「そこを見せて」")
    );
    // 送るのは click の中だけ
    expect(body).toContain("addEventListener('click'");
    expect(
      body.slice(0, body.indexOf("addEventListener('click'"))
    ).not.toContain("postMessage");
  });
});
