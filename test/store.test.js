import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Le magasin résout son répertoire au chargement du module : la variable
// d'environnement doit être posée avant l'import.
const DIR = await mkdtemp(path.join(tmpdir(), 'snapshots-'));
process.env.SNAPSHOT_DIR = DIR;
const { appendSnapshot, readSnapshots, readCycleSnapshots, safeFileName } = await import('../server/core/store.js');

test.after(() => rm(DIR, { recursive: true, force: true }));

test('une observation écrite se relit', async () => {
  assert.equal(await appendSnapshot('TEST', { earningsDate: '2026-09-15', impliedMovePercent: 5 }), true);

  const lues = await readSnapshots('TEST');
  assert.equal(lues.length, 1);
  assert.equal(lues[0].impliedMovePercent, 5);
  assert.match(lues[0].at, /^\d{4}-\d{2}-\d{2}T/, "l'horodatage est ajouté automatiquement");
});

test('les observations reviennent dans l ordre chronologique', async () => {
  for (const move of [6, 7, 8]) {
    await appendSnapshot('ORDRE', { earningsDate: '2026-09-15', impliedMovePercent: move });
  }
  const lues = await readSnapshots('ORDRE');
  assert.deepEqual(lues.map((s) => s.impliedMovePercent), [6, 7, 8]);
});

test('readCycleSnapshots isole une échéance donnée', async () => {
  // Comparer le mouvement implicite d'un trimestre à celui du précédent
  // n'aurait aucun sens : ce ne sont pas les mêmes événements.
  await appendSnapshot('CYCLE', { earningsDate: '2026-06-15', impliedMovePercent: 3 });
  await appendSnapshot('CYCLE', { earningsDate: '2026-09-15', impliedMovePercent: 8 });
  await appendSnapshot('CYCLE', { earningsDate: '2026-09-15', impliedMovePercent: 9 });

  const cycle = await readCycleSnapshots('CYCLE', '2026-09-15');
  assert.equal(cycle.length, 2);
  assert.deepEqual(cycle.map((s) => s.impliedMovePercent), [8, 9]);

  assert.deepEqual(await readCycleSnapshots('CYCLE', null), []);
});

test('une ligne corrompue n empêche pas de lire les autres', async () => {
  await appendSnapshot('ABIME', { earningsDate: '2026-09-15', impliedMovePercent: 4 });
  const { appendFile } = await import('node:fs/promises');
  await appendFile(path.join(DIR, 'ABIME.jsonl'), 'ceci n est pas du JSON\n', 'utf8');
  await appendSnapshot('ABIME', { earningsDate: '2026-09-15', impliedMovePercent: 5 });

  const lues = await readSnapshots('ABIME');
  assert.deepEqual(lues.map((s) => s.impliedMovePercent), [4, 5]);
});

test('un ticker jamais observé renvoie une liste vide, pas une erreur', async () => {
  assert.deepEqual(await readSnapshots('INEXISTANT'), []);
});

test('un ticker ne peut jamais désigner un fichier hors du répertoire', async () => {
  // Propriété qui compte : quelle que soit la saisie, le chemin résolu reste
  // sous le répertoire des observations.
  for (const hostile of ['../evasion', '../../etc/passwd', '/absolu', '..', './.', 'a/b']) {
    const resolu = path.resolve(DIR, safeFileName(hostile));
    assert.ok(
      resolu.startsWith(path.resolve(DIR) + path.sep),
      `${JSON.stringify(hostile)} sort du répertoire : ${resolu}`,
    );
  }
});

test('un ticker légitime garde son point', () => {
  assert.equal(safeFileName('brk.b'), 'BRK.B.jsonl');
  assert.equal(safeFileName('AAPL'), 'AAPL.jsonl');
  // Une saisie qui ne laisse rien d'exploitable reste un nom valide.
  assert.equal(safeFileName('///'), 'INCONNU.jsonl');
});

test('une écriture avec un ticker hostile reste lisible', async () => {
  await appendSnapshot('../evasion', { earningsDate: '2026-09-15', impliedMovePercent: 1 });
  const lues = await readSnapshots('../evasion');
  assert.equal(lues.length, 1);
  assert.equal(lues[0].impliedMovePercent, 1);
});
