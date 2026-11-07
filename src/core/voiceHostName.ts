import { isWebRuntime } from "./runtime";

/**
 * 人物の声で本文を外へ送る前の確認の窓に出す、送り先の名前（設計書6.42.3。実機確認リスト 24行、
 * 作者の答え 2026-11-07 A）。
 *
 * 設定（`novelai.readAloud.voiceEngineUrl`）に番地で書くと、窓には「192.168.3.15:10101」としか
 * 出ず、作者にはどの機械か分からない。そこで OS に名前を問い合わせ、**名前を先に、番地とポートを
 * 括弧で添える**（「書斎のPC（192.168.3.15:10101）」）。
 *
 * - 番地（IPv4・IPv6）で書いてあれば、名前を引く（逆引き。`dns.lookupService`）。引けなければ番地だけ
 * - 名前で書いてあれば、その名前を出し、番地を引けたら添える（`dns.lookup`）。引けなければ書いたまま
 * - **2秒で返事が無ければ打ち切る**（窓が出るのを待たせ続けない）。打ち切ったら書いたまま
 * - **ブラウザ版では引かない**（Node の `dns` が無い。書いたまま）
 *
 * **名前を引けなくても止めない**（実装ルール5）。結果の種別を返し、ログは呼ぶ側が書く
 * （`core` をログに依存させない）。`node:dns` は**動的 import**（静的に置くとブラウザ版が
 * 起動した瞬間に落ちる。`browserReach.test.ts`）。
 *
 * 「以降は訊かない」の覚えの鍵は、ここで作る名前ではなく**設定に書いた宛先**のまま
 * （`voiceRemoteHostConfirmId`）。名前が変わっても訊き直さない。
 */

/** 名前・番地を引く口。テストで差し替える */
export interface HostNameResolver {
  /** 番地から名前（引けなければ undefined か、番地そのものを返してよい） */
  reverse(address: string, port: number): Promise<string | undefined>;
  /** 名前から番地（引けなければ undefined） */
  forward(name: string): Promise<string | undefined>;
}

export type VoiceHostLabelOutcome =
  /** 名前と番地の両方が分かった */
  | "resolved"
  /** 引いたが分からなかった（書いたまま出す） */
  | "notFound"
  /** 2秒で返事が無かった（書いたまま出す） */
  | "timeout"
  /** 引けなかった（引く口が投げた。書いたまま出す） */
  | "failed"
  /** 引かなかった（ブラウザ版・読めない宛先） */
  | "skipped";

export interface VoiceHostLabel {
  /** 窓に出す送り先（「書斎のPC（192.168.3.15:10101）」か、書いたままの宛先） */
  label: string;
  outcome: VoiceHostLabelOutcome;
  /** 失敗の中身（ログへ）。outcome が failed のときだけ */
  error?: string;
}

/** 名前を引くのを打ち切るまでの時間 */
export const HOST_NAME_TIMEOUT_MS = 2_000;

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * 送り先の名前を作る。
 *
 * @param host `URL.host` の形（`192.168.3.15:10101`・`[fe80::1]:10101`・`studio-pc:10101`）
 */
export async function describeVoiceHost(
  host: string,
  options: { resolver?: HostNameResolver; timeoutMs?: number; isWeb?: boolean } = {}
): Promise<VoiceHostLabel> {
  if (options.isWeb ?? isWebRuntime()) return { label: host, outcome: "skipped" };
  let url: URL;
  try {
    url = new URL(`http://${host}`);
  } catch {
    return { label: host, outcome: "skipped" };
  }
  // IPv6 は `[fe80::1]` と括弧つきで来る。OS へ渡すときは括弧を外す
  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const isAddress = IPV4.test(hostname) || hostname.includes(":");
  // http の既定（80）は URL.host から落ちる。逆引きにはポートが要るので補う
  const port = url.port === "" ? 80 : Number(url.port);
  const resolver = options.resolver ?? nodeResolver;
  const timeoutMs = options.timeoutMs ?? HOST_NAME_TIMEOUT_MS;

  let found: string | undefined;
  try {
    const answer = await withTimeout(
      isAddress ? resolver.reverse(hostname, port) : resolver.forward(hostname),
      timeoutMs
    );
    if (answer === TIMED_OUT) return { label: host, outcome: "timeout" };
    found = answer?.trim().replace(/\.$/, "");
  } catch (error) {
    return {
      label: host,
      outcome: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  /*
    逆引きの記録（PTR）が無いと、OS は例外でなく**番地そのもの**を名前として返すことがある。
    それを名前として出すと「192.168.3.15（192.168.3.15:10101）」になるので、引けなかったと見る
  */
  if (!found || found.toLowerCase() === hostname.toLowerCase()) {
    return { label: host, outcome: "notFound" };
  }
  if (isAddress) return { label: `${found}（${host}）`, outcome: "resolved" };
  const address = found.includes(":") ? `[${found}]` : found;
  const withPort = url.port === "" ? address : `${address}:${url.port}`;
  return { label: `${hostname}（${withPort}）`, outcome: "resolved" };
}

const TIMED_OUT = Symbol("timedOut");

/**
 * 決まった時間で打ち切る。待ちのせいで VS Code（や試験）の終わりを引き止めないよう、
 * Node では `unref` する（`verifiedMemento.ts` の `defaultWait` と同じ）
 */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: unknown;
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  }
}

/** 本物の口。**呼ばれたときだけ** `node:dns` を読む（ブラウザ版の束に静的に入れない） */
const nodeResolver: HostNameResolver = {
  async reverse(address, port) {
    const dns = await import("node:dns");
    const { hostname } = await dns.promises.lookupService(address, port);
    return hostname;
  },
  async forward(name) {
    const dns = await import("node:dns");
    const { address } = await dns.promises.lookup(name);
    return address;
  },
};
