import { describe, expect, test } from "vitest";
import {
  parseGoogleClientJson,
  parseStoredGoogleClient,
  readGoogleClientInput,
  serializeGoogleClient,
} from "../../../src/core/googleClientConfig";

/** クライアント（作者が Google Cloud で作るもの）の読み書き（設計書5.10.9） */

const ID = "123456789-abcdefg.apps.googleusercontent.com";

describe("Google Cloud でダウンロードした JSON", () => {
  test("デスクトップ アプリ（installed）を読む", () => {
    const text = JSON.stringify({
      installed: {
        client_id: ID,
        project_id: "p",
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        client_secret: "GOCSPX-xyz",
        redirect_uris: ["http://localhost"],
      },
    });
    expect(parseGoogleClientJson(text)).toEqual({ ok: true, client: { clientId: ID, clientSecret: "GOCSPX-xyz" } });
    // BOM 付きでも読む（Windows の写しで付くことがある）
    expect(parseGoogleClientJson(String.fromCharCode(0xfeff) + text).ok).toBe(true);
  });

  test("ウェブ アプリケーション（web）は種類を伝えて断る。壊れた JSON・形の違う ID も断る", () => {
    const web = parseGoogleClientJson(JSON.stringify({ web: { client_id: ID } }));
    expect(web).toMatchObject({ ok: false });
    expect(web.ok ? "" : web.reason).toContain("デスクトップ アプリ");
    expect(parseGoogleClientJson("{").ok).toBe(false);
    expect(parseGoogleClientJson(JSON.stringify({ installed: { client_id: "abc" } })).ok).toBe(false);
  });
});

describe("入力の窓で入れた値", () => {
  test("前後の空白を落とす。シークレットは省ける。中に空白のあるものは断る", () => {
    expect(readGoogleClientInput({ clientId: `  ${ID} ` })).toEqual({ ok: true, client: { clientId: ID } });
    expect(readGoogleClientInput({ clientId: ID, clientSecret: "" })).toEqual({ ok: true, client: { clientId: ID } });
    expect(readGoogleClientInput({ clientId: ID, clientSecret: "a b" }).ok).toBe(false);
    expect(readGoogleClientInput({ clientId: "foo.apps.googleusercontent.com.evil" }).ok).toBe(false);
  });

  test("置き場の文字にして読み戻すと同じ。壊れていれば読めない", () => {
    const client = { clientId: ID, clientSecret: "GOCSPX-xyz" };
    expect(parseStoredGoogleClient(serializeGoogleClient(client))).toEqual({ ok: true, client });
    expect(parseStoredGoogleClient(undefined).ok).toBe(false);
    expect(parseStoredGoogleClient("[]").ok).toBe(false);
  });
});
