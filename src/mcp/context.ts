/*
 * What every tool needs, and the rules they all obey.
 *
 * The MCP layer adds no capability. It wraps what the library already does in a
 * surface an agent can choose from — so anything here that starts to look like a
 * rule about Legal One belongs in the library instead.
 */
import { LegalOneTimesheet } from '../client.ts';
import { browserSession, LoginRequiredError, type BrowserSession } from '../session.ts';
import type { Renew } from '../auth.ts';

/** Everything a tool is handed. One session per process, reused. */
export interface Context {
  client: LegalOneTimesheet;
  session: BrowserSession;
  renew: Renew;
  /** Where exported files land. */
  exportDir: string;
}

let sharedSession: BrowserSession | null = null;
let sharedClient: LegalOneTimesheet | null = null;
let clientTenant: string | null = null;

/**
 * The process's session handle, without touching the network.
 *
 * For tools that report state rather than use it — asking "is there a session?"
 * should not create one.
 */
export function sessionHandle(): BrowserSession {
  sharedSession ??= browserSession({
    // stderr, never stdout: stdout is the MCP transport, and a progress line on it
    // is a protocol violation that presents as the server going silent. Claude
    // Desktop keeps stderr in its logs, which is where someone debugging looks.
    onProgress: (m) => process.stderr.write(`[legalone] ${m}\n`),
  });
  return sharedSession;
}

/**
 * A session and a client bound to the tenant that session found.
 *
 * The client is built here rather than up front because it cannot exist correctly
 * before the session does: the tenant is *discovered* during sign-in, and a client
 * constructed ahead of that has no base URL and fails every call with a
 * configuration error that has nothing to do with the real cause.
 *
 * The session itself is created once and reused — signing in again appears to
 * invalidate the previous `.ASPXAUTH` on this tenant, so a second login mid-run
 * would pull the credential out from under requests already using it.
 */
export async function context(): Promise<Context> {
  const session = sessionHandle();
  await session.cookie();
  const tenant = session.tenant();
  if (!tenant) throw new Error('signed in, but the tenant could not be determined');
  if (!sharedClient || clientTenant !== tenant) {
    sharedClient = new LegalOneTimesheet({ cookie: () => session.cookie(), baseUrl: tenant });
    clientTenant = tenant;
  }
  return { client: sharedClient, session, renew: () => session.renew(), exportDir: exportDir() };
}

const exportDir = (): string => {
  if (process.env['LEGALONE_EXPORT_DIR']) return process.env['LEGALONE_EXPORT_DIR']!;
  const home = process.env['HOME'] ?? '.';
  if (process.platform === 'darwin') return `${home}/Library/Application Support/legalone-timesheet/exports`;
  if (process.platform === 'win32') return `${process.env['LOCALAPPDATA'] ?? home}\\legalone-timesheet\\exports`;
  return `${process.env['XDG_DATA_HOME'] ?? `${home}/.local/share`}/legalone-timesheet/exports`;
};

/** What a tool returns. Structured, so an agent can branch on it. */
export type ToolResult =
  | { ok: true; [key: string]: unknown }
  | { ok: false; error: string; hint: string; [key: string]: unknown };

/**
 * Runs a tool body and turns every failure into something an agent can act on.
 *
 * `LoginRequiredError` is the one that matters most: it is not a failure, it is a
 * handoff. A tool that reported it as an error would have the agent apologise when
 * the right move is to tell the person a window is open and wait for them to say
 * they are done.
 */
export async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof LoginRequiredError) {
      return {
        ok: false,
        error: 'sign-in required',
        hint: `A browser window is open at ${error.url}. Ask the person to sign in there, then call this again. Do not retry on your own.`,
        loginUrl: error.url,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/aliases\.json/.test(message)) {
      /*
       * This used to say "run `bun run setup` in the repository", which named
       * something most installations do not have: the bundle a lawyer installs
       * carries the compiled server and no scripts, and there is no clone to be in.
       * propose_config reads the same records and is reachable from here.
       */
      return {
        ok: false,
        error: message,
        hint:
          'The firm configuration is missing or still holds placeholders. Call propose_config — it reads the ' +
          'firm\'s own records and proposes the ids — then apply_config. Do not guess ids. plan_entries works ' +
          'meanwhile and will show what it could not decide.',
      };
    }
    if (/no Legal One tenant configured/.test(message)) {
      return { ok: false, error: message, hint: 'Call authenticate first — the tenant is discovered during sign-in.' };
    }
    if (/SessionExpired|login page/i.test(message)) {
      return { ok: false, error: message, hint: 'Renewing did not help. Stop, and treat no result from this run as real.' };
    }
    return { ok: false, error: message, hint: 'Report this rather than retrying; a repeat is unlikely to behave differently.' };
  }
}

/** Trims a list to a page, and says how much was left. */
export function page<T>(items: T[], limit = 25, offset = 0): { items: T[]; total: number; offset: number; more: boolean } {
  const slice = items.slice(offset, offset + limit);
  return { items: slice, total: items.length, offset, more: offset + slice.length < items.length };
}
