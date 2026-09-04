/*
 * Where the Legal One session comes from.
 *
 * This is policy, not mechanism: `client.ts` knows how to talk to Legal One, this
 * knows how a credential is obtained. Keeping them apart is what lets the client
 * stay a pure request builder that `verify.ts` can drive with a stubbed `fetch`.
 *
 * ## Why a browser at all
 *
 * Legal One authenticates through Thomson Reuters OnePass, which federates to an
 * external IdP over OIDC. The login form carries an anti-forgery token and captcha
 * flags, and the tenant may require a second factor — so replaying it from a script
 * means storing the user's password and fighting defences the vendor put there on
 * purpose. Driving a real browser sidesteps all of it: a person logs in the way they
 * always do, once.
 *
 * ## Why the profile is the credential
 *
 * `.ASPXAUTH` — the entire credential for the application — is a *session* cookie:
 * it dies with the browser process and never reaches disk. The IdP's cookies do
 * persist, and they live in the browser profile. So nothing here stores a secret.
 * The durable thing is a browser profile directory, protected by the OS like any
 * other, and revoked by deleting a folder. `.ASPXAUTH` is re-minted on demand.
 *
 * Measured against the real tenant: with the IdP cookies present and `.ASPXAUTH`
 * gone, navigating to the tenant re-mints it in about four seconds across thirteen
 * redirects, with no interaction — headless included.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, join } from 'node:path';
import { Cdp } from './cdp.ts';

/** The application session cookie. Everything else the browser holds is incidental. */
const SESSION_COOKIE = '.ASPXAUTH';

/** Entry point when the tenant is not yet known; the IdP routes to the user's own. */
const ONEPASS_ENTRY = 'https://signon.thomsonreuters.com/?productId=L1NJ';

/** Hosts in the auth chain that are never a firm's tenant. */
const NOT_A_TENANT = /^(login|signon|auth)\./i;

/**
 * Where the identity provider renders a prompt.
 *
 * A silent renewal passes straight through these, so their appearance proves
 * nothing — what matters is the chain coming to rest on one.
 */
const IDP_HOST = /^(signon|auth)\.thomsonreuters\.com$/i;

export type SessionResult =
  | { kind: 'ready'; cookie: string; tenant: string }
  /** A human has to sign in. A visible window is open at `url`; call again after. */
  | { kind: 'login-required'; url: string; profileDir: string };

export interface SessionOptions {
  /** Tenant base URL. Omitted on first run, when it is discovered from the chain. */
  tenant?: string;
  profileDir?: string;
  /** Explicit browser binary. Otherwise Chrome, then Edge. */
  browserPath?: string;
  /** Open a visible window straight away instead of trying headless first. */
  interactive?: boolean;
  timeoutMs?: number;
  /**
   * Called as the acquisition moves between stages, so a command can say what it is
   * waiting on. A cold profile spends over a minute here — launching a browser that
   * has never run, then a redirect chain across two identity providers — and none of
   * it prints anything, which is indistinguishable from a hang. A library must not
   * choose a stream to write to (this one is imported by an MCP server, where stdout
   * is the protocol), so it reports and the caller decides.
   */
  onProgress?: (message: string) => void;
}

/**
 * Per-OS application directory. Deliberately outside the repository.
 *
 * `LEGALONE_PROFILE_DIR` overrides it, which is what makes a cold start testable:
 * without it the only way to reach a fresh profile is to move `HOME`, and that also
 * moves the macOS keychain — so Chrome cannot reach its own safe storage, raises a
 * modal, and every measurement taken that way is of the modal rather than of this.
 */
export const defaultProfileDir = (): string => {
  const override = process.env['LEGALONE_PROFILE_DIR'];
  if (override) return override;
  const home = homedir();
  if (platform() === 'darwin') return join(home, 'Library', 'Application Support', 'legalone-timesheet', 'browser');
  if (platform() === 'win32') return join(process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), 'legalone-timesheet', 'browser');
  return join(process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share'), 'legalone-timesheet', 'browser');
};

const CANDIDATES: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'],
};

export const findBrowser = (explicit?: string): string => {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`no browser at ${explicit}`);
    return explicit;
  }
  const found = (CANDIDATES[platform()] ?? CANDIDATES['linux']!).find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      'no Chrome, Edge or Chromium found — install one, or pass browserPath. ' +
        'Without a browser, the cookie has to be supplied manually (see the README).',
    );
  }
  return found;
};

interface Browser {
  cdp: Cdp;
  /** Ends the browser — a no-op for one we found already running and did not start. */
  stop: () => void;
  reused: boolean;
}

/** Connects to a browser already listening on this profile, or reports none. */
const endpointOn = async (portFile: string, timeoutMs: number): Promise<Cdp | null> => {
  if (!existsSync(portFile)) return null;
  const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
  if (!Number.isFinite(port) || port <= 0) return null;
  try { return await Cdp.attach(port, timeoutMs); } catch { return null; }
};

/** Headless browsers say so in their user agent, which is how a stale one is spotted. */
const runningHeadless = async (cdp: Cdp): Promise<boolean> => {
  try {
    const { userAgent } = await cdp.send<{ userAgent: string }>('Browser.getVersion');
    return /headless/i.test(userAgent ?? '');
  } catch { return false; }
};

/**
 * Starts the browser on the connector's own profile and connects to it.
 *
 * `--remote-debugging-port=0` asks for an ephemeral port, which Chrome writes to
 * `DevToolsActivePort` in the profile. A fixed port would be worse than untidy: the
 * DevTools endpoint is an unauthenticated control channel over a logged-in browser,
 * so it should exist briefly and unpredictably.
 *
 * The dedicated `--user-data-dir` is not a preference. Chrome refuses a debugging
 * port on the default profile — that hole was closed deliberately — and it is also
 * what keeps this away from the user's own browsing.
 */
async function launch(
  browserPath: string,
  profileDir: string,
  headless: boolean,
  timeoutMs: number,
  onProgress: (message: string) => void = () => {},
): Promise<Browser> {
  const firstRun = !existsSync(join(profileDir, 'Local State'));
  mkdirSync(profileDir, { recursive: true });
  const portFile = join(profileDir, 'DevToolsActivePort');

  /*
   * Reuse a browser already open on this profile, rather than starting a second one.
   *
   * This path is not an optimisation, it is the login round-trip. A sign-in leaves a
   * visible window running on purpose — it is the prompt — and Chrome will not start
   * a second browser on a profile that already has one: the new process notifies the
   * existing browser and exits with code 21, having written no port. The old code
   * then deleted the port file first, so the evidence that a browser was there went
   * with it, and the failure was reported as "is another instance using this
   * profile?" — which was true, and the other instance was ours.
   *
   * Measured against Claude Desktop: every call after the one that opened the window
   * failed this way, so signing in could never complete.
   */
  const running = await endpointOn(portFile, 2_000);
  if (running) {
    if (headless || !(await runningHeadless(running))) {
      onProgress('a browser is already open on this profile — using it');
      return { cdp: running, stop: () => {}, reused: true };
    }
    // A window is wanted and what is open is headless: it is a leftover of ours, and
    // a person cannot sign in to something they cannot see.
    onProgress('a headless browser was left open — replacing it with a window');
    await running.send('Browser.close').catch(() => undefined);
    running.close();
  }

  rmSync(portFile, { force: true });
  // Announced here rather than on entry: reusing a browser is not starting one, and
  // saying both in the same breath is how a report stops being worth reading.
  onProgress(
    `starting ${basename(browserPath)}${headless ? '' : ' in a visible window'}` +
      `${firstRun ? ' — first run on a new profile, which takes longer' : ''}`,
  );

  const args = [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-features=Translate,ChromeWhatsNewUI',
  ];
  if (headless) args.push('--headless=new');

  // stderr is kept, not discarded: when a browser refuses to open a port it says why,
  // and throwing that away left the only diagnosis available to guesswork.
  const child: ChildProcess = spawn(browserPath, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: false });
  let complaint = '';
  child.stderr?.on('data', (chunk: Buffer) => { complaint = `${complaint}${chunk}`.slice(-600); });
  const stop = () => { try { child.kill(); } catch { /* already gone */ } };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cdp = await endpointOn(portFile, 5_000);
    if (cdp) return { cdp, stop, reused: false };
    /*
     * A process that has exited is not a reason to stop waiting. On macOS the
     * launched process routinely hands off to another and exits, and the browser it
     * left behind is the one that writes the port. Only the deadline ends this.
     */
    await new Promise((r) => setTimeout(r, 150));
  }
  const wrote = (() => { try { return readdirSync(profileDir).length > 0; } catch { return false; } })();
  const exited = child.exitCode;
  stop();
  throw new Error(portTimeout(profileDir, timeoutMs, wrote, exited, complaint.trim()));
}

/**
 * Says why no debugging port appeared, which the timeout alone never does.
 *
 * The two causes need opposite responses and are told apart by one observation: a
 * browser that wrote nothing at all into a directory it was handed is not slow, it
 * is confined — every sandbox that denies the write produces exactly this, an alive
 * process and an empty profile. A browser that wrote a profile and then produced no
 * port is the ordinary collision instead. Naming the wrong one costs an hour.
 */
export const portTimeout = (
  profileDir: string,
  timeoutMs: number,
  wrote: boolean,
  exitCode: number | null = null,
  complaint = '',
): string => {
  const said = complaint ? ` The browser said: ${complaint}` : '';
  const ended = exitCode === null ? '' : ` The process this started exited with ${exitCode}.`;
  return wrote
    ? `browser did not open a debugging port within ${timeoutMs}ms, though it did write to ${profileDir}.` +
      `${ended} A browser already running on this profile is normally reused rather than restarted, so this is ` +
      `one that neither answered nor started.${said}`
    : `browser started but wrote nothing into ${profileDir} within ${timeoutMs}ms, so it never opened a ` +
      `debugging port.${ended} A browser that cannot write the profile directory it was given is normally one ` +
      `confined by a sandbox or by a policy on that path; check that this process may write there, or set ` +
      `LEGALONE_PROFILE_DIR to somewhere it may write.${said}`;
};

/**
 * A tab already showing the sign-in, if there is one.
 *
 * Without this, every call that needs a person opens another tab in the same
 * window, and a person who calls twice is looking at a browser filling with
 * identical sign-on pages, unsure which one is live.
 */
const signOnTab = async (cdp: Cdp, target: string): Promise<string | null> => {
  const { targetInfos } = await cdp
    .send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>('Target.getTargets')
    .catch(() => ({ targetInfos: [] as Array<{ targetId: string; type: string; url: string }> }));
  const wanted = (() => { try { return new URL(target).host; } catch { return ''; } })();
  const hit = targetInfos.find((t) => {
    if (t.type !== 'page') return false;
    try {
      const { host } = new URL(t.url);
      return host === wanted || IDP_HOST.test(host);
    } catch { return false; }
  });
  return hit?.targetId ?? null;
};

const sessionCookie = async (cdp: Cdp): Promise<string | null> => {
  const { cookies } = await cdp.send<{ cookies: Array<{ name: string; value: string }> }>('Storage.getCookies');
  return cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? null;
};

/**
 * Drives one navigation and reports where it ended up.
 *
 * Landing on the IdP means the session is gone and a human is needed; landing
 * anywhere else with a session cookie in hand means it renewed silently. Both are
 * ordinary outcomes, so this returns them rather than throwing.
 */
async function navigate(
  cdp: Cdp,
  url: string,
  timeoutMs: number,
  onProgress: (message: string) => void = () => {},
): Promise<{ cookie: string | null; hosts: string[]; finalUrl: string }> {
  const { targetId, sessionId } = await cdp.openTab('about:blank');
  const hosts: string[] = [];
  const off = cdp.on((event) => {
    if (event.method !== 'Network.requestWillBeSent' || event.params['type'] !== 'Document') return;
    const request = event.params['request'] as { url?: string } | undefined;
    if (request?.url) {
      try {
        const { host } = new URL(request.url);
        // Only when it changes: the chain revisits hosts, and a repeated line reads
        // as a loop rather than as progress.
        if (host !== hosts[hosts.length - 1]) onProgress(`  → ${host}`);
        hosts.push(host);
      } catch { /* not a URL we can read */ }
    }
  });

  try {
    await cdp.send('Network.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Page.navigate', { url }, sessionId);

    /*
     * Poll for the cookie, but give up early once the chain has clearly stopped at
     * a sign-in page. Waiting out the full timeout meant nearly thirty seconds of
     * nothing before the window a person is supposed to type into even appeared —
     * measured on a cold profile. A silent renewal passes through the same hosts in
     * a fraction of a second, so resting there is the signal, not visiting.
     */
    let cookie: string | null = null;
    let settledOnIdp = 0;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      cookie = await sessionCookie(cdp);
      if (cookie) break;

      const here = await cdp.send<{ result: { value: string } }>(
        'Runtime.evaluate', { expression: 'location.host', returnByValue: true }, sessionId,
      ).catch(() => ({ result: { value: '' } }));
      settledOnIdp = IDP_HOST.test(here.result.value) ? settledOnIdp + 1 : 0;
      // Eight consecutive polls, so a hop through the IdP is not mistaken for a stop.
      if (settledOnIdp >= 8) break;
    }
    const final = await cdp.send<{ result: { value: string } }>(
      'Runtime.evaluate', { expression: 'location.href', returnByValue: true }, sessionId,
    ).catch(() => ({ result: { value: '' } }));
    return { cookie, hosts, finalUrl: final.result.value };
  } finally {
    off();
    await cdp.closeTab(targetId);
  }
}

/**
 * The tenant host, recovered from the redirect chain.
 *
 * The chain passes through the firm's own `<firm>.novajus.com.br` on its way to the
 * new front end, so it can be read rather than asked for. `login.` and `signon.` are
 * shared infrastructure, not anyone's tenant.
 */
const tenantFrom = (hosts: string[]): string | null => {
  const host = hosts.find((h) => h.endsWith('.novajus.com.br') && !NOT_A_TENANT.test(h));
  return host ? `https://${host}` : null;
};

/**
 * Produces a usable session, or reports that a person has to sign in.
 *
 * Tries headless first, because the common case — an IdP session still inside its
 * window — needs no window and no attention. Only when that lands on the sign-in
 * page does a visible one open, and then this returns rather than blocking: a tool
 * call cannot sit and wait while someone types a password.
 */
export async function ensureSession(options: SessionOptions = {}): Promise<SessionResult> {
  const profileDir = options.profileDir ?? defaultProfileDir();
  const browserPath = findBrowser(options.browserPath);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const target = options.tenant ? `${options.tenant.replace(/\/+$/, '')}/` : ONEPASS_ENTRY;
  const say = options.onProgress ?? (() => {});

  /*
   * A profile that has never existed cannot hold a sign-on, so trying headless first
   * is twenty seconds spent proving something already known — a browser launched, a
   * redirect chain followed to the identity provider, and a timeout waited out, all
   * to discover that a directory that was not there a moment ago has no cookies in
   * it. That is the first twenty seconds a new user ever spends with this.
   *
   * Deliberately narrow: only a *missing* directory licenses the skip. Once the
   * profile exists it may well hold a live sign-on, and renewing without a window is
   * the whole point of the headless attempt on every run after this one.
   */
  const neverRun = !existsSync(profileDir);
  if (neverRun) say('no browser profile yet, so there is no sign-on to renew — going straight to a window');

  if (!options.interactive && !neverRun) {
    const browser = await launch(browserPath, profileDir, true, timeoutMs, say);
    try {
      say('checking whether the sign-on still holds');
      const { cookie, hosts } = await navigate(browser.cdp, target, timeoutMs, say);
      const tenant = options.tenant ?? tenantFrom(hosts);
      if (cookie && tenant) {
        say(`session renewed without asking you anything — ${tenant}`);
        return { kind: 'ready', cookie, tenant: tenant.replace(/\/+$/, '') };
      }
    } finally {
      browser.cdp.close();
      browser.stop();
    }
  }

  // Headless could not get there on its own: hand the browser to the person.
  if (!neverRun) say('the sign-on has lapsed, so this needs you');
  const visible = await launch(browserPath, profileDir, false, timeoutMs, say);
  const open = await signOnTab(visible.cdp, target);
  if (open) {
    say('the sign-on page is already open — bringing that tab to the front');
    await visible.cdp.send('Target.activateTarget', { targetId: open }).catch(() => undefined);
  } else {
    say('window open — loading the sign-on page');
    const { sessionId } = await visible.cdp.openTab('about:blank');
    await visible.cdp.send('Page.navigate', { url: target }, sessionId).catch(() => undefined);
  }
  // Left running on purpose — the window is the login prompt. It is closed by the
  // next successful `ensureSession`, or by the person.
  visible.cdp.close();
  return { kind: 'login-required', url: target, profileDir };
}

/** Raised when only a person can proceed. A window is open at `url`. */
export class LoginRequiredError extends Error {
  // Explicit fields, not constructor parameter properties: a parameter property is
  // the one TypeScript construct erasing types cannot handle, and it is what stops
  // Node running these files directly.
  readonly url: string;
  readonly profileDir: string;

  constructor(url: string, profileDir: string) {
    super(`Legal One needs someone to sign in. A browser window is open at ${url}; run again once that is done.`);
    this.name = 'LoginRequiredError';
    this.url = url;
    this.profileDir = profileDir;
  }
}

export interface BrowserSession {
  /** Pass straight to `ClientOptions.cookie`. */
  cookie: () => Promise<string>;
  /** Throws away the cached session and mints a fresh one. */
  renew: () => Promise<void>;
  /** The tenant, known once a session has been obtained. */
  tenant: () => string | null;
}

/**
 * A cached, renewable session backed by the connector's browser profile.
 *
 * Cached deliberately, not as an optimisation. Signing in again appears to
 * invalidate the previous `.ASPXAUTH` on this tenant — a second sign-in mid-run
 * would pull the credential out from under the requests already using it. So a
 * session is obtained once and reused, and only `renew()` replaces it.
 */
export function browserSession(options: SessionOptions = {}): BrowserSession {
  let cached: string | null = null;
  let tenant: string | null = options.tenant ?? null;
  /** Concurrent callers share one obtain, rather than racing to sign in twice. */
  let inFlight: Promise<string> | null = null;

  const obtain = async (): Promise<string> => {
    const result = await ensureSession({ ...options, ...(tenant ? { tenant } : {}) });
    if (result.kind === 'login-required') throw new LoginRequiredError(result.url, result.profileDir);
    cached = `.ASPXAUTH=${result.cookie}`;
    tenant = result.tenant;
    return cached;
  };

  const once = (): Promise<string> => {
    inFlight ??= obtain().finally(() => { inFlight = null; });
    return inFlight;
  };

  return {
    cookie: async () => cached ?? (await once()),
    renew: async () => { cached = null; await once(); },
    tenant: () => tenant,
  };
}
