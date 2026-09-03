---
name: legalone-timesheet
description: Log timesheet entries and manage matters in Legal One (NovaJus) without the web UI. Use when asked to record hours, reconcile a timesheet against the system, look up a processo or contact, or register a new matter.
---

# Legal One timesheet

Legal One has no public API. This client drives the same server-rendered ASP.NET
forms the browser does, derived from captured traffic. It is not officially
supported and will break if Legal One changes its markup — every write therefore
verifies itself by reading back.

## Setup

The session comes from a browser profile the connector owns. Nothing to copy, and
nothing for the lawyer to do once they have signed in the first time.

```ts
const session = browserSession();
const client = new LegalOneTimesheet({ cookie: session.cookie, baseUrl: session.tenant() ?? undefined });
```

`.ASPXAUTH` is the entire credential for the application — there is no anti-forgery
token — but it is a session cookie and never reaches disk. What persists is the IdP's
session, in the profile, and a fresh `.ASPXAUTH` is minted from it in about four
seconds with no interaction.

Two errors, and they mean opposite things:

**`SessionExpiredError`** is recoverable and usually already recovered. Wrap work in
the helpers from `auth.ts` and it renews once and carries on. If one still reaches
you, the renewal did not help — stop, and do not treat any result from that run as
real. An expired session used to read as data: the searches came back empty, so a
registered client was reported as "not registered".

**`LoginRequiredError`** needs the person. A browser window is already open at the
sign-in page. Say so plainly, ask them to sign in, and stop — do not retry, and do
not wait. Once they confirm, run again.

Never retry a write on your own. `create` and `createMatter` prove nothing about
whether they landed, and a matter cannot be deleted. `executePlan` already handles
this correctly; outside it, ask whether the work is there before doing it again.

## The workflow

Always plan before writing.

```ts
const planned = await planEntries(client, entries);   // reads only
```

Every entry comes back as one of five states:

| state | meaning | what to do |
|---|---|---|
| `internal` | firm-internal work | log against the firm contact |
| `linked` | matter found | log it |
| `matter-missing` | client registered, matter is not | interview, create matter, then log |
| `ambiguous` | several matters match | ask which; never pick |
| `escalate` | client not registered, or unresolvable | stop and report |

Present the plan before acting on it. On the week this was built against, the
dry-run caught a registered client being misreported as missing — before anything
was written.

## Rules that are not obvious

**Search by CNJ first, by name second.** A name search misses any matter whose
registered *Cliente* is not the party the work is about. A company's criminal case
is filed under its individual defendant, so `searchProcessos('<company>')` never
returns it. Use `resolveProcesso(cnj)` when a number is present.

**Never auto-pick from a fuzzy match.** `term=Inquérito` returns four distinct
action types; three different ids all render as `1º Grau`. Booking against the
wrong one is invisible afterwards.

**Derive jurisdiction from the CNJ, never from sibling matters.** Twice in this
data a sibling's recorded UF/vara contradicted its own CNJ, and the CNJ was right
both times. Siblings are a guide to *conventions* — title format, posição,
responsável — not to jurisdiction.

**Descriptions cap at 500 characters.** Over that, Legal One rejects the whole
form and returns 200 with the form re-rendered, so it looks like success. Put
overflow in `observations`, which has no limit — do not silently truncate.

**Matters cannot be deleted with this user's permissions.** Creating one is
effectively permanent. Confirm with the lawyer before `createMatter`, always.
Timesheet entries *can* be deleted.

**HTTP 405 means one of two unrelated things:** a required `int` failed to bind
(`Id`, `EscritorioOrigemId`, `isdeleteiManage`), or the user lacks permission. The
client distinguishes them; the status alone does not.

**Check for an existing entry before creating one.** Duplicates here come from
retrying a request whose outcome was unclear, not from double-clicking.

## Interview

For `matter-missing`, `proposeMatter` sorts the form's 273 fields into what it
knows and what it must ask:

```ts
const proposal = await proposeMatter(client, resolution.contato, resolution.cnj, {
  acao: 'Inquérito', orgao: 'Justiça do Estado de São Paulo',
  shortName: 'ACME', titleDescription: 'IP 12º DP',
});
// → ~15 derived fields, 3 choices, 2 must-ask questions
await createFromProposal(client, proposal, answers);
```

Ask only `proposal.choices` and `proposal.mustAsk`. Everything in
`proposal.derived` is a firm constant or fixed by the CNJ standard — asking about
those wastes the lawyer's attention, which is the point of the skill.

## Configuration

`src/aliases.json` maps timesheet names to registered names — `Acme → ACME
PARTICIPAÇÕES LTDA`. This is billing-relevant: a wrong alias books hours against the
wrong entity and nothing surfaces the error, so it is reviewed like code. Do not
infer aliases at runtime.

The file is gitignored and produced by `bun run setup`, which signs in, checks the
tenant, and reads the firm's ids off its own records. If it is missing or still holds
`<placeholder>` values, say so and point at that command — never guess an id, and
never guess a name.

## Reporting back

Report ids and totals, not reassurance. `listEntries(from, to)` after a batch, and
state the total against the source. If something was held or skipped, say which
and why — a silent omission reads as success.
