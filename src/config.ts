/*
 * The firm's configuration, as runtime state rather than a compile-time import.
 *
 * It used to be `import firm from './aliases.json' with { type: 'json' }`, which tied
 * three things together: the configuration had to live inside `src/`, it had to exist
 * before anything typechecked, and — the one that matters here — it could not change
 * without restarting the process. That last one is what kept a lawyer's setup behind
 * a terminal: an agent could propose a configuration and never apply one.
 *
 * So it moves out of the repository, next to the browser profile, and it is read.
 * Two consequences worth stating:
 *
 *   A clone carries no configuration at all. That is correct — client names, the
 *   firm's contact id, a lawyer's user id and hourly rate are not source code, and
 *   they should survive deleting the clone rather than being deleted with it.
 *
 *   When there is no file, this returns an EMPTY configuration and reports itself
 *   unconfigured. It deliberately does not fall back to `aliases.example.json`: that
 *   file's three fictional aliases would silently rewrite a real client name, and a
 *   `<placeholder>` guard cannot see the string `Acme`.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/** A value the setup never filled. `<escritorio-id>` and friends. */
export const isPlaceholder = (value: string): boolean => /^<.*>$/.test(value);

const DefaultsSchema = z.looseObject({
  escritorioOrigemId: z.string(),
  escritorioOrigemText: z.string(),
  escritorioResponsavelId: z.string(),
  escritorioResponsavelText: z.string(),
  responsavelId: z.string(),
  responsavelText: z.string(),
  responsavelPosicaoId: z.string(),
  responsavelPosicaoText: z.string(),
  naturezaId: z.string(),
  naturezaText: z.string(),
  contatoEscritorioId: z.string(),
  contatoEscritorioText: z.string(),
});

const FirmSchema = z.looseObject({
  aliases: z.record(z.string(), z.string()),
  internal: z.looseObject({ prefixes: z.array(z.string()) }),
  defaults: DefaultsSchema,
  titleFormat: z.string().nullable(),
  /*
   * True while a configuration has been written but never proved against Legal One.
   *
   * A configuration written from a conversation is unverified in a way the terminal
   * path is not: `doctor` runs with no installed template, so its template checks
   * cannot fire, and a conversationally-written configuration passes it clean. The
   * only real proof is the probe entry `setup --write` files and deletes, and that
   * writes to production, which the conversational flow deliberately does not.
   *
   * So it is marked instead, and booking hours refuses while the mark is there.
   */
  provisional: z.boolean().optional(),
});

const TemplateSchema = z.array(z.tuple([z.string(), z.string()]));

export type FirmConfig = z.infer<typeof FirmSchema>;
export type EntryTemplate = z.infer<typeof TemplateSchema>;

/** Every id this firm files under, with the placeholder that means "not set". */
const EMPTY_DEFAULTS: z.infer<typeof DefaultsSchema> = {
  escritorioOrigemId: '<escritorio-id>',
  escritorioOrigemText: '<escritorio>',
  escritorioResponsavelId: '<escritorio-responsavel-id>',
  escritorioResponsavelText: '<escritorio-responsavel>',
  responsavelId: '<responsavel-id>',
  responsavelText: '<responsavel>',
  responsavelPosicaoId: '<posicao-id>',
  responsavelPosicaoText: '<posicao>',
  naturezaId: '<natureza-id>',
  naturezaText: '<natureza>',
  contatoEscritorioId: '<firm-contact-id>',
  contatoEscritorioText: '<contato-escritorio>',
};

const EMPTY_FIRM: FirmConfig = {
  aliases: {},
  internal: { prefixes: [] },
  defaults: { ...EMPTY_DEFAULTS },
  titleFormat: null,
};

/** Whether the configuration in force has ever been proved against Legal One. */
export const configProvisional = (): boolean => firmConfig().provisional === true;

/**
 * Where a firm's configuration lives. Beside the browser profile and the exports,
 * because all three are this installation's data rather than its source.
 */
export const configDir = (): string => {
  const override = process.env['LEGALONE_CONFIG_DIR'];
  if (override) return override;
  const home = homedir();
  if (platform() === 'darwin') return join(home, 'Library', 'Application Support', 'legalone-timesheet', 'config');
  if (platform() === 'win32') return join(process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), 'legalone-timesheet', 'config');
  return join(process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share'), 'legalone-timesheet', 'config');
};

export const firmPath = (): string => join(configDir(), 'aliases.json');
export const templatePath = (): string => join(configDir(), 'template.json');

/** The create form as captured, shipped so the shape exists before a firm has one. */
const exampleTemplate = (): EntryTemplate =>
  TemplateSchema.parse(JSON.parse(readFileSync(new URL('./template.example.json', import.meta.url), 'utf8')));

interface Loaded {
  firm: FirmConfig;
  template: EntryTemplate;
  /** Identifies exactly these bytes, so a caller can tell that they changed. */
  version: string;
  firmOnDisk: boolean;
  templateOnDisk: boolean;
}

let loaded: Loaded | null = null;

/** Parses one file, naming the file when it does not hold what it should. */
const readJson = <T>(path: string, schema: z.ZodType<T>): T => {
  const raw = readFileSync(path, 'utf8');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    // A truncated write reaches here, and `JSON Parse error: Expected '}'` names
    // nothing a person can act on — not the file, not that it is configuration.
    throw new Error(
      `${path} is not valid JSON (${(error as Error).message}). A backup of the last good one is beside it.`,
    );
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(
      `${path} is not a valid configuration: ${first?.path.join('.') || '(root)'} ${first?.message ?? 'failed validation'}. ` +
        'Re-run configuration rather than editing it by hand.',
    );
  }
  return parsed.data;
};

const load = (): Loaded => {
  if (loaded) return loaded;
  const fPath = firmPath();
  const tPath = templatePath();
  const firmOnDisk = existsSync(fPath);
  const templateOnDisk = existsSync(tPath);
  const firm = firmOnDisk ? readJson(fPath, FirmSchema) : { ...EMPTY_FIRM };
  const template = templateOnDisk ? readJson(tPath, TemplateSchema) : exampleTemplate();
  const version = createHash('sha256')
    .update(JSON.stringify(firm))
    .update(JSON.stringify(template))
    .digest('hex')
    .slice(0, 12);
  loaded = { firm, template, version, firmOnDisk, templateOnDisk };
  return loaded;
};

/** Forgets what was loaded, so the next read sees what is now on disk. */
export const reloadConfig = (): void => { loaded = null; };

export const firmConfig = (): FirmConfig => load().firm;
export const entryTemplate = (): EntryTemplate => load().template;

/**
 * Identifies the configuration in force.
 *
 * `log_entries` re-plans internally, so a configuration applied between the plan a
 * person approved and the write that follows would execute a different plan than the
 * one they saw — silently, because both steps succeed. Stamping this into a plan and
 * checking it before writing is what makes that impossible.
 */
export const configVersion = (): string => load().version;

export interface ConfigState {
  configured: boolean;
  /** Why not, in the words a person can act on. Empty when configured. */
  reasons: string[];
}

/**
 * Whether this installation has been configured, and what is missing.
 *
 * Unfilled values are not a subtle failure elsewhere: a `<placeholder>` posted to
 * Legal One comes back 405 with a message about int binding, naming neither the file
 * nor the field. Answering the question here, by name, is what keeps that from being
 * diagnosed as a client bug.
 */
export const configState = (): ConfigState => {
  const { firm, template, firmOnDisk } = load();
  const reasons: string[] = [];
  if (!firmOnDisk) reasons.push(`no configuration at ${firmPath()} — this installation has never been set up`);
  const unset = Object.entries(firm.defaults)
    .filter(([key, value]) => !key.startsWith('_') && typeof value === 'string' && isPlaceholder(value))
    .map(([key]) => key);
  if (firmOnDisk && unset.length > 0) reasons.push(`defaults still unset: ${unset.join(', ')}`);
  const templateHoles = template.filter(([, value]) => isPlaceholder(value)).map(([key]) => key);
  if (templateHoles.length > 0) {
    reasons.push(`the entry template still carries ${templateHoles.length} unset value(s): ${templateHoles.slice(0, 4).join(', ')}`);
  }
  return { configured: reasons.length === 0, reasons };
};

/** Raises unless this installation is configured. Call before anything writes. */
export const assertConfigured = (): void => {
  const state = configState();
  if (state.configured) return;
  throw new Error(`aliases.json: this installation is not configured — ${state.reasons.join('; ')}`);
};

export interface ClassifyState {
  /** Whether classification can reach every verdict it is capable of. */
  configured: boolean;
  /** Whether an alias table exists. Empty is a decision; absent is not. */
  aliasTable: boolean;
  /** Whether internal lines can be linked — needs a real contatoEscritorioId. */
  internal: boolean;
  reasons: string[];
}

/**
 * What classification can and cannot decide here — a narrower question than
 * `configState`, and the reason the two exist separately.
 *
 * Resolving a line to a matter reads the alias table, the internal prefixes and the
 * firm's own contact id. It never reads the entry template: the seven values there are
 * bound once, in `bindTemplate`, at POST time. So a template that still carries
 * placeholders is no reason to refuse a plan, and refusing one cost a real session the
 * only report that would have made its alias decisions legible.
 *
 * This does not raise. An unconfigured installation still classifies; what changes is
 * that a name it cannot find comes back `unconfigured` rather than `not registered`,
 * because with no alias table the search never had a chance to find it.
 */
export const classifyState = (): ClassifyState => {
  const { firm, firmOnDisk } = load();
  const reasons: string[] = [];
  if (!firmOnDisk) {
    reasons.push(`no configuration at ${firmPath()} — names are searched literally, with no alias table`);
  }
  const internal = !isPlaceholder(firm.defaults.contatoEscritorioId);
  if (!internal) reasons.push('defaults.contatoEscritorioId is unset, so internal lines cannot be linked');
  return { configured: firmOnDisk && internal, aliasTable: firmOnDisk, internal, reasons };
};

/**
 * Replaces the configuration, atomically and recoverably.
 *
 * Temp-then-rename because a half-written file is worse than no file: the reader
 * fails inside JSON.parse before any curated message runs, and an MCP client reports
 * only that the server would not start. The dated backup exists because this is the
 * artefact that misbills in silence, and it should never be the unrecoverable one.
 */
export const writeConfig = (next: { firm?: unknown; template?: unknown }): string[] => {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const written: string[] = [];
  const put = (path: string, value: unknown) => {
    if (existsSync(path)) copyFileSync(path, `${path}.backup-${stamp}`);
    const temp = `${path}.writing`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temp, path);
    written.push(path);
  };
  if (next.firm !== undefined) put(firmPath(), FirmSchema.parse(next.firm));
  if (next.template !== undefined) put(templatePath(), TemplateSchema.parse(next.template));
  reloadConfig();
  return written;
};
