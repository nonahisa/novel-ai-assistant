import * as crypto from "crypto";
import * as os from "os";

/**
 * 端末（執筆環境）の識別子。
 *
 * 同一人物が複数の環境を渡り歩いて執筆するため、
 * 「どの環境で書いたか」を区別できる必要がある（設計書3.5.2・3.5.6）。
 *
 * **端末IDはGitへ同期しない。** 各環境のローカル設定に持たせる。
 * 同期してしまうと、全環境が同じIDを名乗って区別が付かなくなる。
 */

/** 端末IDの保存先キー（globalState。作品をまたいで共通） */
export const DEVICE_ID_KEY = "novelai.deviceId";

/** 端末IDを覚えておく場所。VS Codeの globalState を想定 */
export interface DeviceIdStorage {
  get(key: string): string | undefined;
  update(key: string, value: string): Promise<void> | Thenable<void>;
}

/**
 * 端末IDを取り出す。無ければ作って覚える。
 *
 * 機械名を頭に付けるのは、`.aiwriter/sessions/` に並んだファイル名を
 * 作者が見たときに、どれが自分の環境か分かるようにするため。
 * 「desktop-a1b2」のように、機械名だけでは重なる場合に備えて
 * ランダムな接尾辞を足す。
 */
export async function resolveDeviceId(
  storage: DeviceIdStorage,
  hostname: string = os.hostname()
): Promise<string> {
  const existing = storage.get(DEVICE_ID_KEY);
  if (existing && isValidDeviceId(existing)) return existing;

  const created = `${sanitizeHostname(hostname)}-${crypto
    .randomBytes(2)
    .toString("hex")}`;
  await storage.update(DEVICE_ID_KEY, created);
  return created;
}

/**
 * 端末IDとして使える形か。
 *
 * この値は**ファイル名の一部になる**ため、パス区切りや
 * ファイル名に使えない文字が混ざっていないことを必ず確かめる。
 * 覚えていた値が壊れていたら作り直す。
 */
export function isValidDeviceId(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
}

/**
 * 機械名をファイル名に使える形へ均す。
 *
 * 日本語の機械名は珍しくない（「太郎のPC」など）。
 * そのまま使うと環境によって扱いが変わるため、英数字だけに落とす。
 * 何も残らなければ "device" とする。
 */
export function sanitizeHostname(hostname: string): string {
  const normalized = hostname
    .toLowerCase()
    // ドメイン部分は不要（machine.local → machine）
    .split(".")[0]
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return normalized || "device";
}
