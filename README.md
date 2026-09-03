# legalone-timesheet

Log timesheet entries and manage matters in **Legal One (NovaJus)** from a script or
an agent, without touching the web UI.

Legal One has no public API. This drives the same server-rendered ASP.NET forms the
browser drives, reconstructed from captured traffic. It works, it is not officially
supported, and it will break if Legal One changes its markup — so every write reads
itself back and raises when the result doesn't match.

---

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
seed.mjs            install  — puts the two config files in place, once, if missing.
setup.ts            command  — sign in, check the tenant, configure, prove it.
mcp.ts              command  — the MCP server, over stdio.
src/mcp/            surface  — eighteen tools wrapping the library. No new rules.
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
src/aliases.json    config   — name drift and firm constants.
src/template.json   config   — invariant create fields, per tenant.
verify.ts           gate     — regenerates captured payloads and diffs them.
mcp-check.ts        gate     — the agent-facing contract, offline.
session-check.ts    gate     — expiry detection and renewal, offline.
execute-check.ts    gate     — never book the same hour twice, offline.
SKILL.md            the agent-facing contract.
```

The split matters: `client` knows *how* to talk to Legal One, `resolver` knows
*what your firm means*. Swapping firms means rewriting `aliases.json` and the
resolver, not the client.

---

## Install

Runs on [Bun](https://bun.sh) or Node. Both gates and the whole client work under
either; the commands below say `bun`, and `node` does the same thing.

```bash
cd legalone-timesheet
bun install              # also seeds the two config files, if they aren't there
bun run typecheck        # must be clean
bun run setup            # signs in, checks the tenant, proposes a configuration
```

Installing runs `seed.mjs`, which copies `src/aliases.example.json` and
`src/template.example.json` into place if they are missing. That is seeding, not
configuration: `client.ts` imports both files statically, so they have to exist
before anything runs — a clone without them does not typecheck, and says so as four
`TS2307`s naming a file the reader has never heard of. They arrive full of
`<placeholder>` values that make the client fail loudly and by name, and `setup` is
what fills them. Seeding never overwrites: the files it would clobber hold a firm's
real client names, ids and billing rate.

`setup` changes nothing on its own. It opens a browser for you to sign in, runs the
doctor, reads a configuration off records your firm has already filed, and shows you
the evidence for every value. Adopting it is a second, explicit step:

```bash
bun run setup --write    # commits the configuration, then proves it
```

`--write` files one probe entry, reads it back field by field and deletes it. On a
tenant with no captured fixture that probe is the only gate there is, and entries —
unlike matters — can be deleted, which is why it is an entry.

The two config files are gitignored: they carry firm and client identity, so they are
never something this repo ships filled. `setup` never overwrites the parts it cannot
derive — your alias table, your internal prefixes, your title convention — because a
wrong alias books hours against the wrong client and nothing surfaces it.

```bash
bun run session-check.ts  # no fixtures needed — must print "36 passed"
bun run execute-check.ts  # no fixtures needed — must print "8 passed"
bun run mcp-check.ts      # no fixtures needed — must print "10 passed"
bun run verify.ts         # once you have captured a fixture
```

`verify.ts` rebuilds your captured requests from the current code and diffs them
field by field. **If it doesn't pass, don't write anything to Legal One** — it means
the client no longer reproduces a request that Legal One is known to have accepted.
Fixtures are your own captured traffic and are not distributed; see *Maintenance*
for how to capture one.

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
reboots, and it is not scoped to timesheets. Treat the directory as a secret:

```bash
# macOS; ~/.local/share/legalone-timesheet/browser on Linux,
# %LOCALAPPDATA%\legalone-timesheet\browser on Windows
chmod 700 ~/Library/Application\ Support/legalone-timesheet/browser
```

Deleting that directory revokes everything and costs one sign-in.
`LEGALONE_PROFILE_DIR` moves it, which is also the only sane way to exercise a cold
start: the alternative is moving `HOME`, and that moves the macOS keychain with it,
so Chrome cannot reach its own safe storage and raises a modal that blocks the
window. Measurements taken that way are of the modal.

If a launch fails with *"browser started but wrote nothing into …"*, the browser is
running but cannot write the profile directory it was handed. On a developer machine
that is a sandbox — this reproduces under agent sandboxes and under corporate
endpoint policy. Point `LEGALONE_PROFILE_DIR` somewhere writable, or run outside the
sandbox. It is not a Legal One problem and no amount of retrying fixes it.

`ClientOptions.cookie` still takes a plain string, which is the way to run this
somewhere without a browser — CI, a container, a server. Put the `Cookie` header from
DevTools in `LEGALONE_COOKIE`, `chmod 600 .env`, and expect it to expire when that
browser session does. Every call detects expiry and raises `SessionExpiredError`
naming the request that hit it, so a dead cookie stops the run instead of being read
as data.

### Configure for your firm

`src/aliases.json` has two halves:

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

const client = new LegalOneTimesheet({ cookie: process.env.LEGALONE_COOKIE! });

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

Keep per-week run scripts in `scripts/`. It is gitignored — those scripts name real
clients — so nothing there ships with the repo.

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

## Using it from an agent

`mcp.ts` exposes the library as an MCP server — eighteen tools, so an agent can
compose rather than being handed one blessed workflow. Add it to
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "legalone": {
      "command": "node",
      "args": ["/absolute/path/to/legalone-timesheet/mcp.ts"]
    }
  }
}
```

**Node, not Bun.** The MCP SDK imports `zod/v3`; zod 4 exports that subpath and Node
resolves it, but Bun 1.4's resolver does not. The library and all four gates run
under either.

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

## Limits

- **Untested paths:** `createIncidente`, `setEntryStatus`, `createFromProposal`, and
  the `ambiguous` branch of the resolver. Written, typechecked, never run against
  production.
- **`deleteMatter`** is correct but permission-blocked for normal users.
- Approval transitions (`setEntryStatus`) move entries toward invoicing. Deliberately
  a separate call from `update`, and deliberately never exercised here.
- Everything is derived from one tenant's forms. Another Legal One instance may
  differ in field names, ids, and required fields.

---

## License

[GNU Affero General Public License v3.0 or later](LICENSE). Copyright (C) 2026
Oscar Neto; the notice is in [`COPYRIGHT`](COPYRIGHT).

AGPL §13 is the clause to know: if you modify this and let others use it over a
network, they are entitled to your modified source. Running it unmodified, or
modifying it for your own firm's internal use, triggers nothing.
