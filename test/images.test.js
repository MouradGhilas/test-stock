import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// Le module résout son répertoire au chargement : la variable d'environnement
// doit être posée avant l'import.
const DIR = await mkdtemp(path.join(tmpdir(), 'captures-'));
process.env.TRADES_DIR = DIR;
const images = await import('../server/portfolio/images.js');

test.after(() => rm(DIR, { recursive: true, force: true }));

/** Un PNG minimal mais valide : en-tête, dimensions, données compressées. */
function png(width = 2, height = 2) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : 0);
    return Buffer.concat([length, body, crc]);
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;

  const rows = Buffer.concat(
    Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 120)])),
  );

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const gif = () => Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(32, 3)]);
const webp = () =>
  Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(32, 9)]);

/* --- Reconnaissance du format --- */

test('les quatre formats acceptés sont reconnus à leurs octets', () => {
  assert.equal(images.detectType(png()).type, 'image/png');
  assert.equal(images.detectType(jpeg()).type, 'image/jpeg');
  assert.equal(images.detectType(gif()).type, 'image/gif');
  assert.equal(images.detectType(webp()).type, 'image/webp');
});

test('ce qui n est pas une image est refusé, quoi qu annonce l envoyeur', async () => {
  // Le cas qui compte : un fichier HTML resservi depuis notre origine serait
  // une faille, pas une capture.
  const html = Buffer.from('<html><script>alert(1)</script></html>');
  assert.equal(images.detectType(html), null);
  await assert.rejects(images.saveImage(html), /Format non reconnu/);

  await assert.rejects(images.saveImage(Buffer.alloc(0)), /vide/i);
  await assert.rejects(
    images.saveImage(Buffer.concat([png(), Buffer.alloc(images.MAX_BYTES)])),
    (error) => error.status === 413,
  );
});

/* --- Cycle de vie --- */

test('une capture écrite se relit avec son vrai type', async () => {
  const saved = await images.saveImage(png());
  assert.match(saved.id, /^[0-9a-f]{32}$/);
  assert.equal(saved.type, 'image/png');

  const relue = await images.readImage(saved.id);
  assert.equal(relue.type, 'image/png');
  assert.ok(relue.buffer.equals(png()), 'les octets rendus sont ceux reçus');
});

test('une capture supprimée ne se relit plus', async () => {
  const saved = await images.saveImage(jpeg());
  assert.ok(await images.imageExists(saved.id));

  await images.deleteImages([saved.id]);
  assert.equal(await images.readImage(saved.id), null);
  assert.equal(await images.imageExists(saved.id), false);
});

test('une suppression de capture inexistante ne lève pas', async () => {
  await images.deleteImages(['ffffffffffffffffffffffffffffffff', 'pas-un-identifiant']);
});

/* --- L'identifiant ne peut désigner qu'une capture --- */

test('un identifiant hostile ne lit jamais un autre fichier', async () => {
  for (const hostile of [
    '../../../etc/passwd',
    '..%2f..%2fetc%2fpasswd',
    'trades',
    '/absolu',
    '',
    'ABCDEF0123456789abcdef0123456789',
    'a'.repeat(31),
  ]) {
    assert.equal(images.isImageId(hostile), false, `${JSON.stringify(hostile)} accepté à tort`);
    assert.equal(await images.readImage(hostile), null);
  }
});

/* --- Ménage --- */

test('une capture orpheline et ancienne est purgée, une récente est épargnée', async () => {
  const gardee = await images.saveImage(png(3, 3));
  const orpheline = await images.saveImage(gif());
  const recente = await images.saveImage(webp());

  // On vieillit artificiellement les deux premières.
  const vieux = new Date(Date.now() - 3 * 86_400_000);
  for (const file of await readdir(images.IMAGES_DIR)) {
    if (file.startsWith(gardee.id) || file.startsWith(orpheline.id)) {
      await utimes(path.join(images.IMAGES_DIR, file), vieux, vieux);
    }
  }

  const removed = await images.pruneOrphans([gardee.id]);
  assert.equal(removed, 1, 'seule l orpheline ancienne part');
  assert.ok(await images.imageExists(gardee.id), 'une capture référencée reste');
  assert.equal(await images.imageExists(orpheline.id), false);
  assert.ok(await images.imageExists(recente.id), 'une capture récente peut appartenir à un formulaire ouvert');
});
