# Fixtures

A fixture is one real request that Legal One accepted, saved to disk. `verify.ts`
rebuilds each one from the current code and diffs it field by field.

This directory ships empty. **Fixtures are yours and are not distributable** — see
*What a fixture contains* below.

## Why this exists

Legal One's forms fail quietly: a rejected save returns HTTP 200 with the form
re-rendered, byte-for-byte the shape of a success. A field the parser misreads is
submitted empty, and the server treats empty as "clear it". Nothing throws.

So the only trustworthy statement about a change is *this code still reproduces a
request the server is known to have accepted*. That is what a fixture makes
possible, and it is why `verify.ts` is the gate before any write.

## Capturing one

1. Open Legal One in the browser with DevTools on the **Network** tab.
2. Create a timesheet entry by hand, normally.
3. Find the `POST` to `/TimeSheet/HorasTrabalhadas/EditHoraTrabalhada` — create and
   update share one endpoint, and a create is the one with an empty `Id`.
4. Copy the **raw form body** — the urlencoded string, not the parsed key/value
   view DevTools shows by default.
5. Save it here as `<anything>.json`:

```json
{ "body": "IsHoraTrabalhadaEmLote=True&DtInicio=01%2F09%2F2026&..." }
```

`body` is the only key `verify.ts` reads. Extra keys are ignored, so a HAR entry
or a "Copy as fetch" dump can be trimmed down rather than retyped — but read
*What a fixture contains* before keeping the extras.

Capture at least two: one entry linked to a **contato** and one linked to a
**processo**. They exercise different fields — a contato link rides in
`VinculoContatoId`, a processo link in `VinculoGridId` — and `verify.ts` recovers
which from the body, so no naming convention is required.

Matter creates (`/processos/...`) can live here too. `verify.ts` skips any body
without `DtInicio` and `DescricaoHT`, so they are inert unless you write a check
for them.

## Running it

```bash
bun run verify.ts
```

One line per fixture. `0 meaningful diffs` is the only passing result:

```
ok    create-1234.json (contato):  119 vs 119 fields, 0 meaningful diffs
ok    create-5678.json (processo): 119 vs 119 fields, 0 meaningful diffs
```

With no fixtures it exits non-zero and says so. That is deliberate — "nothing was
verified" must not read like "verified".

Three fields are excluded as known noise, documented at the diff in `verify.ts`:
`ButtonSave` and `LastFieldWithFocus` are UI focus state, `ValorHoraCobranca`
differs only in server-render formatting, and `TipoRecalculoValores` is `""` in
some accepted creates and `0` in others.

## What a fixture contains

Everything the real request did. In practice that means:

- your **tenant hostname**, in `url` and in the `Origin` / `Referer` headers
- the **matter and contact ids** the entry was booked against
- the **description of real client work**, verbatim
- your **user id** and the **billing rate** applied to that entry
- your **session cookie**, if you exported the request headers — that cookie is
  full authority over the account, not scoped to timesheets

That is attorney-client information plus a live credential. `.gitignore` keeps this
directory out of the repository, and this file is the only exception. Do not commit
fixtures, do not attach one to a bug report, and do not paste one into a model
context you do not control.

If you need to share a failing diff, share the `verify.ts` output — it names fields,
not values.
