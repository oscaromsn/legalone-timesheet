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
src/client.ts      mechanism — 20 methods over the HTTP surface. No policy.
src/resolver.ts    policy   — what a timesheet line should be booked against.
src/interview.ts   policy   — 273 form fields → the ~5 a lawyer must answer.
src/aliases.json   config   — name drift and firm constants.
src/template.json  data     — invariant create fields, captured from a real request.
verify.ts          test     — regenerates two captured payloads and diffs them.
SKILL.md           the agent-facing contract.
```

The split matters: `client` knows *how* to talk to Legal One, `resolver` knows
*what your firm means*. Swapping firms means rewriting `aliases.json` and the
resolver, not the client.

---

## Install

Requires [Bun](https://bun.sh).

```bash
cd legalone-timesheet
bun install
cp src/aliases.example.json  src/aliases.json    # then fill in — see below
cp src/template.example.json src/template.json   # then fill in — see below
bun run typecheck        # must be clean
```

Both copied files are gitignored. They carry firm and client identity, so they are
configuration you fill in, never something this repo ships filled.

```bash
bun run verify.ts        # once you have captured a fixture
```

`verify.ts` rebuilds your captured requests from the current code and diffs them
field by field. **If it doesn't pass, don't write anything to Legal One** — it means
the client no longer reproduces a request that Legal One is known to have accepted.
Fixtures are your own captured traffic and are not distributed; see *Maintenance*
for how to capture one.

### Credentials

Auth is a browser session cookie. There is no anti-forgery token, so **that cookie is
the entire credential** — full authority over the account, not scoped to timesheets.

Create `.env`:

```
LEGALONE_BASE_URL=https://<your-tenant>.novajus.com.br
LEGALONE_COOKIE="cookie_login_method=…; .ASPXAUTH=…; …"
```

Get it from DevTools → Network → any request to your tenant → copy the whole
`Cookie` request header.

```bash
chmod 600 .env
echo .env >> .gitignore
```

It expires when that browser session ends. If calls suddenly return login pages,
refresh it. For anything beyond experimentation, move it to the keychain
(`security add-generic-password`) and read it at runtime instead of keeping a dotfile.

### Configure for your firm

`src/aliases.json` has two halves:

- **`aliases`** — the name a timesheet line uses → the name Legal One files it under.
  `Acme → ACME PARTICIPAÇÕES LTDA`; `Fintech Co → Carlos Andrade Lima` (that one
  points person-ward, the reverse of the first). This is **billing-relevant**: a wrong entry books hours
  against the wrong entity and nothing surfaces the error. It lives in version
  control so it is reviewed like code. Do not infer aliases at runtime.
- **`defaults`** — firm constants (escritório, responsável, natureza). Never asked in
  the interview because they are the same on every matter this practice files.

Find your own ids with `client.lookup(...)` — see *Lookups* below.

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

Discover the full set by reading the `contentUrl` values on a rendered form —
33 of them on the matter form. That is how the ids in `aliases.json` were found.

---

## Maintenance

When Legal One changes its markup, `verify.ts` fails first. To re-derive:

1. Capture the real request from a browser session (`browse network on` or DevTools).
2. Save it under `fixtures/`.
3. Diff your generated body against it field by field — that diff located every bug
   in this codebase.

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

## Limits

- **Untested paths:** `createIncidente`, `setEntryStatus`, `createFromProposal`, and
  the `ambiguous` branch of the resolver. Written, typechecked, never run against
  production.
- **`deleteMatter`** is correct but permission-blocked for normal users.
- Approval transitions (`setEntryStatus`) move entries toward invoicing. Deliberately
  a separate call from `update`, and deliberately never exercised here.
- Everything is derived from one tenant's forms. Another Legal One instance may
  differ in field names, ids, and required fields.
