import {
  BRIDGE_PROTOCOL,
  type Bridge,
  BridgeCallError,
  type DetectedExtension,
  type HttpRequest,
  type HttpResponse,
  type ParamsOf,
  type ResultOf,
  type BridgeMethod,
} from '@bitchord/shared/bridge';

/**
 * The iPhone app's stand-in for the browser extension.
 *
 * Inside the Capacitor wrapper (web/ios) the page runs in a WKWebView, which
 * has no extension. What the extension gives the site is HTTP without CORS and
 * with YouTube's own Origin/Referer, and the Capacitor HTTP plugin does that
 * natively: its requests are made by URLSession, so CORS never applies and any
 * header can be set. This file offers that through the same `Bridge` contract,
 * so nothing else in the app has to know it isn't an extension.
 *
 * Served: `ping`, `yt.fetch`, `lyrics.*`. Everything else (YouTube sign-in,
 * Spotify, Discord) answers `unsupported` and is left out of `capabilities`,
 * so the UI shows it as unavailable.
 */

interface CapacitorHttpResponse {
  status: number;
  headers?: Record<string, string>;
  url?: string;
  data?: unknown;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: {
    CapacitorHttp?: {
      request(options: Record<string, unknown>): Promise<CapacitorHttpResponse>;
    };
  };
}

function capacitor(): CapacitorGlobal | null {
  return (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor ?? null;
}

/** True inside the iPhone app. */
export function isNativeApp(): boolean {
  return capacitor()?.isNativePlatform?.() === true;
}

// ---- Headers: what declarativeNetRequest does in the extension (extension/lib/rules.ts) ----

const YT = 'https://www.youtube.com';
const MUSIC = 'https://music.youtube.com';

/** Origin and Referer for a request, or null when it should go out untouched. */
function impersonation(url: string): Record<string, string> | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const { hostname, pathname, search } = parsed;
  const as = (origin: string) => ({ Origin: origin, Referer: `${origin}/`, 'X-Origin': origin });
  const asNoXOrigin = (origin: string) => ({ Origin: origin, Referer: `${origin}/` });

  if (hostname === 'music.youtube.com' && pathname.startsWith('/youtubei/')) return as(MUSIC);
  if (hostname === 'www.youtube.com' && pathname.startsWith('/youtubei/')) return as(YT);
  // Other www.youtube.com calls made by the extension itself (BotGuard's GenerateIT, rule 100).
  if (hostname === 'www.youtube.com' && pathname.startsWith('/api/jnn/')) return asNoXOrigin(YT);
  if (hostname === 's.youtube.com') return asNoXOrigin(MUSIC);
  // Media: VISIONOS direct URLs carry no Origin or Referer at all (rule 7); the rest are YouTube's.
  if (hostname.endsWith('googlevideo.com')) return /[?&]c=VISIONOS(&|$)/.test(search) ? null : asNoXOrigin(YT);
  return null;
}

/** Hosts whose own web client sends something a plain request lacks (extension/lib/lyricsFetch.ts). */
function lyricHeaders(url: string): Record<string, string> {
  const { hostname } = new URL(url);
  if (hostname === 'amp-api.music.apple.com') {
    return { Origin: 'https://music.apple.com', Referer: 'https://music.apple.com/' };
  }
  if (hostname.endsWith('musixmatch.com')) return { Cookie: 'mxm_bab=AB' };
  return {};
}

// ---- Native HTTP ---------------------------------------------------------------------------

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function nativeRequest(request: HttpRequest, extraHeaders: Record<string, string>): Promise<HttpResponse> {
  const http = capacitor()?.Plugins?.CapacitorHttp;
  if (!http) throw new BridgeCallError('unavailable', 'Native HTTP isn’t available.');
  const response = await http.request({
    url: request.url,
    method: request.method ?? 'GET',
    headers: { ...(request.headers ?? {}), ...extraHeaders },
    ...(request.body !== undefined && {
      data: request.body,
      ...(request.bodyEncoding === 'base64' && { dataType: 'file' }),
    }),
    // Binary-safe: the body comes back base64, and is decoded to text below when it is text.
    responseType: 'arraybuffer',
    connectTimeout: 15_000,
    readTimeout: 30_000,
  });

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(response.headers ?? {})) headers[key.toLowerCase()] = String(value);
  const type = headers['content-type'] ?? '';
  const textual = /json|text|javascript|xml|html/.test(type) || !type;
  const raw = typeof response.data === 'string' ? response.data : '';
  return {
    status: response.status,
    headers,
    url: response.url ?? request.url,
    bodyEncoding: textual ? 'text' : 'base64',
    body: textual ? new TextDecoder().decode(base64ToBytes(raw)) : raw,
  };
}

// ---- The bridge ------------------------------------------------------------------------------

const PING: ResultOf<'ping'> = {
  version: '1.0.0-ios',
  protocol: BRIDGE_PROTOCOL,
  browser: 'chromium',
  // No 'yt.auth', 'spotify' or 'discord': they need a browser's cookie jar.
  capabilities: ['yt', 'lyrics'],
};

async function call<M extends BridgeMethod>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
  const answer = async (): Promise<unknown> => {
    switch (method) {
      case 'ping':
        return PING;
      case 'yt.fetch': {
        const request = params as ParamsOf<'yt.fetch'>;
        if (request.auth) throw new BridgeCallError('unsupported', 'Signing in to YouTube isn’t available in the iPhone app yet.');
        if (!/^https:\/\/(www|music|s)\.youtube\.com\//.test(request.url)) {
          throw new BridgeCallError('forbidden', `yt.fetch doesn't serve ${request.url}`);
        }
        return nativeRequest(request, impersonation(request.url) ?? {});
      }
      case 'lyrics.fetch': {
        const request = params as ParamsOf<'lyrics.fetch'>;
        if (!/^https:\/\//.test(request.url)) throw new BridgeCallError('forbidden', 'Only https lyric hosts are served.');
        return nativeRequest(request, lyricHeaders(request.url));
      }
      // No per-host prompts on iOS: the app may reach every lyric host.
      case 'lyrics.permissions':
        return { granted: (params as ParamsOf<'lyrics.permissions'>).origins ?? [] };
      case 'lyrics.requestPermissions':
        return {};
      case 'yt.authState':
      case 'yt.selectChannel':
      case 'yt.setConnected':
        return {
          browserSignedIn: false,
          connected: false,
          signedIn: false,
          accounts: [],
          active: null,
          problem: null,
        };
      default:
        throw new BridgeCallError('unsupported', `${method} isn’t available in the iPhone app.`);
    }
  };
  return (await answer()) as ResultOf<M>;
}

export const nativeBridge: Bridge = {
  // The page treats the transport as informational only.
  transport: 'external',
  call: (method, params) => call(method, params),
  subscribe: () => () => {},
};

/** What `detectExtension` resolves to in the app, or null in a browser. */
export function detectNative(): DetectedExtension | null {
  return isNativeApp() ? { bridge: nativeBridge, info: PING } : null;
}

// ---- fetch: YouTube headers on the page's own requests ---------------------------------------

let fetchPatched = false;

/**
 * The page calls InnerTube and googlevideo with plain `fetch`, and in a
 * browser the extension's rules dress those requests as YouTube's. Here the
 * Capacitor HTTP plugin already routes `fetch` through URLSession (CORS-free);
 * this adds the same headers on the way. Must run after Capacitor's own patch,
 * which happens before any page script.
 */
export function installNativeFetch(): void {
  if (fetchPatched || !isNativeApp()) return;
  fetchPatched = true;
  const original = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const extra = impersonation(url);
    if (!extra) return original(input, init);

    // Request objects silently drop Origin/Referer (forbidden headers), so unpack to plain values.
    const headers: Record<string, string> = {};
    const collect = (source?: HeadersInit) => new Headers(source).forEach((value, key) => (headers[key] = value));
    let method = init?.method;
    let body = init?.body;
    let signal = init?.signal;
    if (typeof input !== 'string' && !(input instanceof URL)) {
      collect(input.headers);
      method ??= input.method;
      signal ??= input.signal;
      if (body === undefined && method !== 'GET' && method !== 'HEAD') body = await input.clone().arrayBuffer();
    }
    collect(init?.headers);
    Object.assign(headers, extra);
    return original(url, { ...init, method, body, signal, headers });
  };
}
