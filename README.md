# legalone-timesheet

Work your Legal One timesheet from a conversation. Ask where last month's hours went,
log a week from your notes, look up a matter, register a new one — and have the
answers come from the system your firm already files in, not from a copy of it.

Legal One (NovaJus) has no public API, so this drives the same server-rendered forms
your browser drives. It is not officially supported by Thomson Reuters, and it will
break if Legal One changes its markup. Every write reads itself back and raises when
the result does not match, because these forms fail quietly: **a rejected save returns
HTTP 200 with the page re-rendered**, which is byte-for-byte the shape of a success.

**Two doors.** To use this from Claude, the next four sections are everything. To
integrate it into your own code, or to maintain it, skip to
[For developers](#for-developers).

---

## Setting it up

This part needs a terminal, once. After it you should not see one again.

You need a **Mac** with **Google Chrome** installed (Edge or Chromium also work),
[**Bun**](https://bun.sh) or **Node**, and your ordinary Legal One login — the same one
you type in the browser, second factor and all. You do not need an API key, because
there is no API to key.

Windows and Linux are written and typechecked but have never been run; see
[Limits](#limits).

```bash
git clone https://github.com/oscaromsn/legalone-timesheet
cd legalone-timesheet
bun install          # also puts the two config files in place
bun run setup        # opens a browser window for you to sign in
```

The first run always ends by asking you to sign in. That is not a failure — it has no
session yet, and only you can create one:

```
[  0s] no browser profile yet, so there is no sign-on to renew — going straight to a window
[  0s] starting Google Chrome in a visible window — first run on a new profile, which takes longer
[  1s] window open — loading the sign-on page
Sign in required.
A browser window is open at https://signon.thomsonreuters.com/?productId=L1NJ. Sign in there, then run this again.
```

Sign in on that window, then run `bun run setup` again. This time it finds your
tenant, checks that this client's assumptions actually hold against your firm's
install, and reads a proposed configuration off records your firm has already filed —
which escritório, which responsável, which natureza your matters really carry. It
shows you the evidence and changes nothing.

Read the proposal. When it looks right:

```bash
bun run setup --write
```

That saves the configuration, then proves it: it files one probe timesheet entry,
reads it back field by field — date, times, description, executante, área and rate
table — and deletes it. Entries can be deleted; matters cannot, which is why the
proof is an entry.

**Most of that can happen in conversation instead.** Once the connector is wired to
Claude, asking for *Configurar o Legal One* does the same discovery, shows you the
evidence behind every value, asks about what your records do not settle, and writes
the configuration — no terminal. What it will not do is file the probe: a
conversation should not write to production on its own. So a configuration written
that way is marked **provisional**, and booking hours stays refused until you run
`bun run setup --write` once. Reading, searching, planning and dry runs work
meanwhile.

### Connecting it to Claude

Add this to `claude_desktop_config.json` — on a Mac,
`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "legalone": {
      "command": "/usr/local/bin/node",
      "args": ["/absolute/path/to/legalone-timesheet/mcp.ts"]
    }
  }
}
```

Two details that cost people an afternoon:

**Use the absolute path to `node`** (`which node` prints yours). Applications launched
from the macOS Dock do not inherit your shell's `PATH`, so a bare `"node"` fails with
nothing useful in the logs.

**Node, not Bun.** The MCP SDK imports `zod/v3`; Node resolves that subpath and Bun
1.4 does not. Everything else here runs under either.

Restart Claude Desktop — the config is read at launch — and ask it something.

---

## What you can ask

Plain requests. The agent picks the tools; you do not have to know their names.

**Looking at your hours**

> Export my timesheet for last month and tell me where the hours went.

> How many hours did I log to Acme in the second quarter, and on what?

> Which of my entries are still pending?

Analysis runs off a real `.xlsx` that Legal One generates — one row per entry,
thirteen columns — so an agent with data tooling can pivot it, chart it, and compare
periods. It takes about twenty seconds and lands as a file, not as a wall of rows in
the conversation.

**Logging time**

> Here are my notes from Tuesday. Plan the entries but do not file anything yet.

> File the three you classified as linked. Hold the rest.

> Change yesterday's 14:00 entry to end at 15:30.

Planning is always separate from filing. The plan tells you, for every line, whether
it found the matter, found several, found the client but no matter, or found nothing
at all — before a single hour is written.

**Matters and contacts**

> Is Acme registered? What matters do we have for them?

> Find the matter for CNJ 0000000-00.0000.0.00.0000.

> Draft a new matter for that inquiry — ask me whatever you need.

**Checking the install**

> Run the doctor against our tenant.

Nine checks against your firm's own Legal One, each reporting what it observed. On
the install this was built against it returns *8 ok, 1 warning, 0 failures* — the
warning being values the firm's own records disagree on, which is a thing to read
rather than a thing to fix.

<details>
<summary>The nineteen tools, if you want to see the surface</summary>

| group | tools |
|---|---|
| session | `authenticate`, `session_status` |
| reading | `list_entries`, `search_matters`, `search_contacts`, `resolve_matter_by_cnj`, `read_matter`, `lookup` |
| analysis | `export_timesheet` |
| time | `plan_entries`, `log_entries`, `update_entry`, `delete_entry`, `set_entry_status` |
| matters | `propose_matter`, `create_matter` |
| setup | `propose_config`, `apply_config` |
| diagnostics | `doctor` |

</details>

---

## What it will not do without you

The point of this design is that the expensive mistakes are unavailable, not merely
discouraged.

**It never books the same hour twice.** Entries are matched by their exact time span,
never by their description — descriptions come back from Legal One with whitespace
collapsed, so comparing text would miss, and a miss files a duplicate. If it cannot
read the timestamps already in your tenant, it refuses to write anything at all
rather than assume the range is empty.

**It never guesses which client.** A line that matches several matters, or matches a
registered client with no matter, comes back as a question. Hours booked against the
wrong client are invisible afterwards — nothing in Legal One surfaces them — so
guessing is worse than stopping.

**Registering a matter needs your explicit approval.** Matters cannot be deleted with
a normal user's permissions, so `propose_matter` shows you the answers and issues a
token for exactly those answers; `create_matter` refuses any other. An agent cannot
show you one set of answers and file a different one, by mistake or by reconsidering
halfway.

**Hours it could not file are reported as hours, not as a footnote.** A held entry is
time that will go unbilled unless a person sees it, so the total is stated in hours
every run.

**Being asked to sign in is an answer.** When your single sign-on lapses, the tools
return *sign-in required* with the URL of a window that is already open. The right
response is to sign in — retrying changes nothing, and the agent is told so.

**Approving entries toward invoicing is a separate call** that this has deliberately
never made against a live system. See [Limits](#limits).

---

## Your firm's data

A short answer to the question a partner will ask.

**Nothing is sent anywhere except Legal One.** There is no server in the middle, no
telemetry, no third-party service. The only network traffic is between your machine
and your own tenant.

**Your sign-on lives in a browser profile this tool owns**, in the per-OS application
directory — never in the repository. It holds a renewable Thomson Reuters single
sign-on session, it survives reboots, and it is not scoped to timesheets. Treat that
directory as a secret:

```bash
# macOS; %LOCALAPPDATA%\legalone-timesheet\browser on Windows
chmod 700 ~/Library/Application\ Support/legalone-timesheet/browser
```

Deleting it revokes everything and costs one sign-in.

**Three kinds of file are never committed**, and `.gitignore` enforces it: the
configuration, which lives outside the clone entirely because it carries client
names, internal ids and your billing rate; captured traffic under `fixtures/` because
a captured request is client data plus a live credential; and any run scripts, because
they name real clients.

**Exporting leaves a row in your firm's Legal One.** A `.xlsx` export is a report job
queued on the server, and it appears in the generated-reports list your colleagues can
see. It is not private to you, and each export adds one. Worth knowing before you ask
an agent to try five variations of a question.

**What you can see is what your account can see.** Timesheet reads and exports come
back scoped to the signed-in user; this tenant does not return other people's entries
whatever filter is applied. Firm-wide figures need a different permission, not
different software.

---

## When something goes wrong

| what you see | what it means | what to do |
|---|---|---|
| `Sign in required` on a first run | normal — there is no session yet | sign in on the open window, run it again |
| `no Legal One tenant configured` | something ran before `setup` did | run `bun run setup`, then `--write` |
| a value reading `<placeholder>` | `setup` proposed a configuration you never adopted | run `bun run setup --write` |
| `browser started but wrote nothing into …` | the browser cannot write its profile directory — a sandbox or an endpoint policy, not Legal One | point `LEGALONE_PROFILE_DIR` somewhere writable, or run outside the sandbox |
| `browser did not open a debugging port … another instance` | a second copy is holding that profile | close it, or set `LEGALONE_PROFILE_DIR` |
| `refusing to write: N of M existing entries carry timestamps this client cannot read` | your tenant renders dates or times differently, so the duplicate check would fail open | run the doctor and read what it says about time format |
| Claude Desktop shows the server as failed | almost always `"command": "node"` without a full path | use the output of `which node` |

The connector writes its progress to stderr, which Claude Desktop keeps in its logs —
that is the first place to look when a tool seems to hang rather than answer.

---

# For developers

## Why the design looks like this

Legal One's forms fail *quietly*. A rejected save returns **HTTP 200 with the form
re-rendered** — byte-for-byte the shape of a success. A field the parser misreads is
submitted as empty and the server treats that as "clear it". Nothing throws.

Eight parser bugs were found while building this. Every one was silent; not one
produced an error. They were found because writes verify themselves, and for no
other reason. That single decision is why the rest of the code is shaped the way it
is, and it is the thing to preserve if you change anything here.

---

## Layers

```
setup.ts            command  — sign in, check the tenant, configure, prove it.
mcp.ts              command  — the MCP server, over stdio.
src/mcp/            surface  — nineteen tools wrapping the library. No new rules.
src/mcp/prompts.ts  surface  — the procedures a person starts on purpose.
src/config.ts       config   — the firm's configuration, loaded at runtime.
src/client.ts       mechanism — the HTTP surface. No policy, no auth decisions.
src/cdp.ts          mechanism — a dependency-free DevTools Protocol client.
src/session.ts      policy   — where a credential comes from, and when to ask a human.
src/auth.ts         policy   — what to do when a session expires mid-operation.
src/resolver.ts     policy   — what a timesheet line should be booked against.
src/execute.ts      policy   — running a plan without booking an hour twice.
src/interview.ts    policy   — 273 form fields → the ~5 a lawyer must answer.
src/doctor.ts       setup    — checks this client's assumptions against a tenant.
src/setup.ts        setup    — reads a firm's own records to propose its config.
src/template.ts     setup    — proposes a create template from the tenant's form.
src/export.ts       data     — pulls the timesheet out as an analysable table.
src/xlsx.ts         mechanism — just enough of the xlsx format to read a report.
config/aliases.json          — name drift and firm constants, outside the clone.
config/template.json         — invariant create fields, per tenant.
verify.ts           gate     — regenerates captured payloads and diffs them.
mcp-check.ts        gate     — the agent-facing contract, offline.
config-check.ts     gate     — configuration and the alias refusals, offline.
session-check.ts    gate     — expiry detection and renewal, offline.
execute-check.ts    gate     — never book the same hour twice, offline.
```

The split matters: `client` knows *how* to talk to Legal One, `resolver` knows
*what your firm means*. Swapping firms means rewriting `aliases.json` and the
resolver, not the client.

---

## Working on it

The quick start above is the whole install. What it does not cover is the gates,
which are the reason any of this can be changed safely.

```bash
bun run typecheck         # must be clean
bun run session-check.ts  # 39 passed — expiry detection and renewal, offline
bun run execute-check.ts  # 8 passed  — never book the same hour twice, offline
bun run mcp-check.ts      # 10 passed — the agent-facing contract, offline
bun run verify.ts         # once you have captured a fixture
node <each of the above>  # runtime parity; all four run under either
```

The first three need no fixtures and no tenant, so they run on a fresh clone.
`verify.ts` rebuilds your captured requests from the current code and diffs them
field by field. **If it does not pass, do not write anything to Legal One** — it means
the client no longer reproduces a request Legal One is known to have accepted.
Fixtures are your own captured traffic and are not distributed; see *Maintenance*.

Installing runs `seed.mjs`, which copies `src/aliases.example.json` and
`src/template.example.json` into place if they are missing. That is seeding, not
configuration: `client.ts` imports both statically, so a clone without them does not
typecheck and says so as four `TS2307`s naming a file the reader has never heard of.
They arrive full of `<placeholder>` values that make the client fail loudly and by
name. Seeding never overwrites — the files it would clobber hold a firm's real client
names, ids and billing rate.

---

### Credentials

```ts
const session = browserSession();
const client = new LegalOneTimesheet({ cookie: session.cookie, baseUrl: session.tenant()! });
```

Legal One authenticates through Thomson Reuters OnePass, which federates to an
external identity provider over OIDC. The login form carries an anti-forgery token
and captcha flags, and your firm may require a second factor — so this drives a real
browser rather than replaying credentials, and you sign in the way you already do.

The first run opens a window. After that it is silent: `.ASPXAUTH`, which is the
entire credential for the application, is a session cookie that dies with the browser
process and never reaches disk. The identity provider's session does persist, in a
profile directory this tool owns, and a fresh `.ASPXAUTH` is minted from it in about
four seconds across thirteen redirects with no interaction — headless, so you see
nothing. Once the IdP's own window closes (24 hours on the tenant this was built
against), you sign in again.

**The profile is the credential now, and it is a bigger one than the dotfile was.**
A `.env` held a cookie that died when you closed your browser. The profile holds a
renewable single sign-on session for your Thomson Reuters account, it survives
reboots, and it is not scoped to timesheets. Locking the directory down is covered
in [Your firm's data](#your-firms-data); deleting it revokes everything and costs one
sign-in.

`LEGALONE_PROFILE_DIR` moves it, and it is the only sane way to exercise a cold start.
The alternative is moving `HOME` — which moves the macOS keychain with it, so Chrome
cannot reach its own safe storage, raises a modal, and blocks the window for thirty
seconds. A cold start measured that way took ninety-two seconds; measured properly it
takes two. Both numbers were of the same code, and one of them was of a dialog box.

`ClientOptions.cookie` still takes a plain string, which is the way to run this
somewhere without a browser — CI, a container, a server. Put the `Cookie` header from
DevTools in `LEGALONE_COOKIE`, `chmod 600 .env`, and expect it to expire when that
browser session does. Every call detects expiry and raises `SessionExpiredError`
naming the request that hit it, so a dead cookie stops the run instead of being read
as data.

---

### Configure for your firm

The firm configuration has two halves:

- **`aliases`** — the name a timesheet line uses → the name Legal One files it under.
  `Acme → ACME PARTICIPAÇÕES LTDA`; `Fintech Co → Carlos Andrade Lima` (that one
  points person-ward, the reverse of the first). This is **billing-relevant**: a wrong entry books hours
  against the wrong entity and nothing surfaces the error. It lives in version
  control so it is reviewed like code. Do not infer aliases at runtime.
- **`defaults`** — firm constants (escritório, responsável, natureza). Never asked in
  the interview because they are the same on every matter this practice files.

You do not have to find these by hand. `discover(client)` in `src/setup.ts` reads
them off records your firm has already filed — your timesheet entries name the
matters you actually book to, and those matters carry the escritório, responsável,
natureza and posição. It writes nothing: it proposes, shows how many records agreed,
and lists what else it saw.

That last part is the point. Run against a real tenant with a small sample, seven of
nine values came out exactly right and the two that did not were both reported as
disagreements with the correct answer among the alternatives — the mode had elected
the running user as responsável, because he is responsável on his own matters, while
the firm default is someone else. Read the evidence before adopting any of it.

`generateTemplate(client, installed)` in `src/template.ts` does the same for
`template.json`, and is equally explicit about its limits: three fields are written
by JavaScript at submit time and appear in no html, and a blank create form carries
no rate block until a link is chosen — so it names them and points you at
`discover()`, which reads those off entries that already have one.

`aliases` are never discovered. A wrong alias books hours against the wrong client
and nothing surfaces it, so that half stays empty until written by hand.

---

### Running on another tenant

Every parsing rule in this client was derived from one Legal One install, and when
one does not hold the result is usually not an error. It is a plausible wrong answer:
a renamed grid column yields `null` where a CNJ should be, the resolver concludes the
matter does not exist, and offers to create one — and matters cannot be deleted.

`diagnose(client)` in `src/doctor.ts` holds those assumptions up against the tenant
in front of it. Nine checks, ordered by how silent the failure would be: that the
grid parses at all, that the columns the parsers key on are present, that the pager
advances, that dates are day-first and times 24-hour, that the status ids exist, that
the form declares the lookup endpoints the interview calls, that the entry form has
one row of each collection, and that the firm's own records agree on the ids.

`setup` runs it first and refuses to configure a tenant where a check fails —
configuring one anyway produces a setup that looks right and files hours wrong.

Some of it is only observable, not provable. Date order is settled by finding a day
above 12 in the firm's own entries; if none exists in range, the check says so rather
than guessing. And it covers the assumptions that could be enumerated, which is not
the same as all of them.

For anything the two miss, `client.lookup(...)` and `parseLookups(html)` — see
*Lookups* below.

---

## Use

```ts
import { LegalOneTimesheet } from './src/client.ts';
import { planEntries } from './src/resolver.ts';

import { browserSession } from './src/session.ts';

const session = browserSession();
const client = new LegalOneTimesheet({ cookie: session.cookie, baseUrl: session.tenant()! });

const planned = await planEntries(client, entries);   // reads only, writes nothing
```

**Always plan before writing.** Every entry comes back as one of five states:

| state | meaning | action |
|---|---|---|
| `internal` | firm-internal work | log against the firm contact |
| `linked` | matter found | log it |
| `matter-missing` | client registered, matter is not | interview → create matter → log |
| `ambiguous` | several matters match | ask; never pick |
| `escalate` | client unregistered or unresolvable | stop and report |

On the first week this ran against, the dry run caught a registered client being
reported as missing — before anything was written. That is what the plan step buys.

Then log what resolved:

```ts
for (const p of planned) {
  if (p.resolution.kind !== 'linked' && p.resolution.kind !== 'internal') continue;
  await client.create({ ...p, link: p.resolution.link });
}
```

`cookie` takes a function as readily as a string, and passing `session.cookie`
is what makes renewal silent: every request asks the session for a credential, and a
lapsed one is re-minted before the call rather than after it fails. A plain string
still works, and is the way to run somewhere without a browser.

---

## Interview

For `matter-missing`, `proposeMatter` sorts the matter form's 273 fields into what it
knows and what it must ask:

```ts
const proposal = await proposeMatter(client, resolution.contato, resolution.cnj, {
  acao: 'Inquérito', orgao: 'Justiça do Estado de São Paulo',
  shortName: 'ACME', titleDescription: 'IP 12º DP',
});
// → ~15 derived fields, 3 choices, 2 must-ask questions
await createFromProposal(client, proposal, answers);
```

Ask only `proposal.choices` and `proposal.mustAsk`. Everything in `derived` is a firm
constant or fixed by the CNJ standard — asking about those wastes the lawyer's
attention, which is the entire point.

---

## Rules that are not obvious

**Search by CNJ first, by name second.** A name search misses any matter whose
registered *Cliente* isn't the party the work is about — a criminal case is filed
under its individual defendant, so searching the company name never returns it.

**Never auto-pick from a fuzzy match.** `term=Inquérito` returns four distinct action
types; three different ids all render as `1º Grau`. Wrong picks are invisible after
the fact.

**Derive jurisdiction from the CNJ, never from sibling matters.** Twice in this data a
sibling's recorded UF/vara contradicted its own CNJ, and the CNJ was right both times.
Siblings are a guide to *conventions* — title format, posição, responsável — not to
jurisdiction.

**Descriptions cap at 500 characters.** Over that, the whole form is rejected and
returns 200. Put overflow in `observations`, which has no limit. Do not truncate
silently.

**Matters cannot be deleted** with a normal user's permissions — Legal One reports
that as a 405, not a 403. Creating one is effectively permanent, so confirm before
`createMatter`. Timesheet entries *can* be deleted.

**HTTP 405 means one of two unrelated things:** a required `int` failed to bind
(`Id`, `EscritorioOrigemId`, `isdeleteiManage`), or the user lacks permission. The
client distinguishes them by reading the body; the status alone cannot.

**Check for an existing entry before creating one.** Duplicates here come from
retrying a request whose outcome was unclear.

---

## Lookups

Every picker is a JSON endpoint taking `term`:

```ts
await client.lookup('/contatos/Contatos/LookupGridContato', 'ACME');
await client.lookup('/config/orgaos/LookupOrgao', 'Federal do Rio', { tipo: '0' });
```

`parseLookups(html)` reads the `contentUrl` values off a rendered form, which is
how a tenant's own ids are found without any of them being written down first.
The count varies with the record — three matters on one tenant declared 42, 48 and
36 lookups, since each envolvido row brings its own — so read the form rather than
trusting a number. Four hierarchical ones were constant across all three. Pair it
with `readFormPairs(path)`, which returns the form's ordered pairs and its html.

---

## Maintenance

When Legal One changes its markup, `verify.ts` fails first. To re-derive:

1. Capture the real request from a browser session (`browse network on` or DevTools).
2. Save it under `fixtures/`.
3. Diff your generated body against it field by field — that diff located every bug
   in this codebase.

[`fixtures/README.md`](fixtures/README.md) has the capture steps, the file shape,
and what a captured request carries — it is client data and a live credential, so
it never leaves your machine.

Known parser hazards, all previously silent:

- Result grids **alternate row classes** (`webgrid-row-style` / `webgrid-alternating-row`)
  — matching one returns exactly half the records.
- Grids **paginate at 18 rows**.
- Lookup widgets have **no markup**; their values live in `.lookup({…})` /
  `.lookupTree({…})` configs, in three different value shapes.
- Forms post **duplicate keys** (`Id` twice, checkbox + hidden). ASP.NET binds the
  **first**; a `Record` keeps the last and inverts the truth. The same rule bites on
  the **write** side: appending a field the template already carries loses to the
  template's value. `Observacoes` was lost this way — the entry saved, returned 200,
  and only the observations were blank. Set caller fields via `setField`, never push.
- `disabled` may appear **anywhere** in a tag, and browsers never submit those.
- Textarea content drops **one leading newline** per the HTML spec.
- Some `*Hidden` companions are populated by JS at submit time, not rendered.

---

## The agent-facing contract

`mcp.ts` exposes the library as an MCP server — nineteen tools, so an agent composes
rather than being handed one blessed workflow. Wiring it up is in
[Connecting it to Claude](#connecting-it-to-claude); what follows is what a tool
author needs to know.

The contract is the surface itself, in three layers. The server's `instructions` are
always in the model's context and carry only what must hold when nothing was invoked:
the two gates, plan-before-log, and that sign-in is a handoff rather than a retry.
The prompts in `src/mcp/prompts.ts` are the long procedures a person starts on
purpose, and appear in the client under Portuguese names. Tool descriptions say what
each does *and when not to use it*, because nineteen tools means an agent can reach
for the wrong one.

There used to be a fourth copy, `SKILL.md`, and it had already drifted — it taught
`planEntries(client, entries)` while the instructions said to run `plan_entries`, one
of which is a library call no MCP client can make. `mcp-check.ts` now asserts that
every name these surfaces use is a tool that exists and that none of them speaks in
function calls.

Three parts of the contract are worth knowing before wiring an agent to this.

**Needing a person is a result, not a failure.** When a session has lapsed the tools
return `sign-in required` with the URL of a window that is already open. An agent
should say so and wait, never retry — nothing it can do alone will change the state.

**Registering a matter is gated.** Matters cannot be deleted, and `createMatter`
verifies only that one matter now matches the number, never what is inside it. So
`propose_matter` issues a token for exactly the answers a person approved, and
`create_matter` refuses any other — an agent cannot show one set of answers and file
a different one, by mistake or by reconsidering mid-conversation.

**Payloads are bounded.** `export_timesheet` returns a summary and a file path, never
the rows. Searches fetch only the pages needed to answer, so their `total` is what was
seen rather than what exists. `read_matter` returns the fields that have values, out
of roughly four hundred.

Exports land in `~/Library/Application Support/legalone-timesheet/exports`, or
wherever `LEGALONE_EXPORT_DIR` points.

---

## Getting the data out

`exportTimesheet(client)` in `src/export.ts` asks Legal One for a real `.xlsx` of
every timesheet entry and returns it parsed — one record per entry, thirteen
columns, durations as day fractions (`0.125` is three hours). Measured end to end at
about twenty seconds.

```ts
const { records, bytes, totalBeforeFilter } = await exportTimesheet(client, {
  from: '01/07/2026', to: '31/07/2026',
});
```

Three things worth knowing before building on it.

**It is not a form round-trip.** Everywhere else here, writing means read the form,
change fields, post it back. That fails on this endpoint: the browser sends about
twenty parameters and it rejects the eighty a form read produces — silently, by
queueing a job that never produces a file.

**The server ignores the date filters,** so the range is applied after parsing.
Asking Legal One for one month returns every entry there is; `totalBeforeFilter`
says how many came back before the local filter.

**The export is scoped to the signed-in user.** The report models carry an
executante filter and the lookup does find other people, but the rows come back as
your own regardless — confirmed by driving the real UI and capturing what it sends.
Firm-wide figures need a different permission, not different code.

---

## Limits

- **Untested paths:** `createIncidente`, `setEntryStatus`, `createFromProposal`, and
  the `ambiguous` branch of the resolver. Written, typechecked, never run against
  production.
- **`deleteMatter`** is correct but permission-blocked for normal users.
- Approval transitions (`setEntryStatus`) move entries toward invoicing. Deliberately
  a separate call from `update`, and deliberately never exercised here.
- Everything is derived from one tenant's forms. Another Legal One instance may
  differ in field names, ids, and required fields — which is what `doctor` is for.
- **Only exercised on macOS.** The Windows and Linux paths are written and typechecked
  — `defaultProfileDir` and `findBrowser` handle both, and cookies are read over the
  DevTools protocol rather than out of Chrome's encrypted store, so neither Keychain
  nor DPAPI is involved — but neither has been run.

---

## License

[GNU Affero General Public License v3.0 or later](LICENSE). Copyright (C) 2026
Oscar Neto; the notice is in [`COPYRIGHT`](COPYRIGHT).

AGPL §13 is the clause to know: if you modify this and let others use it over a
network, they are entitled to your modified source. Running it unmodified, or
modifying it for your own firm's internal use, triggers nothing.
