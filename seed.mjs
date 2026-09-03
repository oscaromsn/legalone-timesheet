/*
 * Creates the two config files the code imports statically, if they aren't there.
 *
 * `client.ts` does `import firm from './aliases.json'`, which is resolved at compile
 * time — so a fresh clone does not typecheck, does not run, and does not report
 * anything more useful than four TS2307s naming a file the reader has never heard
 * of. The fix used to be two `cp` lines in the README, which is a step a person
 * discovers only by reading the README in order and in full.
 *
 * Plain JavaScript on purpose: this runs from `postinstall`, before anything has
 * established that the toolchain can strip types, and a throwing postinstall fails
 * the whole install. It has no dependencies and no syntax that needs a transform.
 *
 * Never overwrites. The files it seeds are placeholders; the ones it would clobber
 * are a firm's real client names, ids and billing rate.
 */
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = join(dirname(fileURLToPath(import.meta.url)), 'src');

for (const name of ['aliases', 'template']) {
  const target = join(src, `${name}.json`);
  if (existsSync(target)) continue;
  copyFileSync(join(src, `${name}.example.json`), target);
  console.log(`seeded src/${name}.json from the example — placeholders, filled by \`setup\`.`);
}
