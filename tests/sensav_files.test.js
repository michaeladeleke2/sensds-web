import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { meta, arr, fixtureBytes } from './sensav_fixtures.js';
import { torchLoad, torchSave, OrderedDict, Tensor } from '../src/sensav/io/torch_file.js';
import { readZip, writeZip } from '../src/sensav/io/zip.js';
import { readNpz, writeNpz, npyStrings, npyFloat16 } from '../src/sensav/io/npz.js';

test('reads the model.pt SensAV saves', async () => {
  const p = await torchLoad(fixtureBytes('model.pt'));
  assert.equal(p.format, 1); assert.equal(p.mode, 'image'); assert.equal(p.embed_dim, 1024); assert.equal(p.num_classes, 3); assert.equal(p.dense_units, 100);
  const sd = p.state_dict;
  assert.deepEqual([...sd.keys()], ['hidden.weight', 'hidden.bias', 'output.weight']);
  assert.deepEqual(sd.get('hidden.weight').shape, [100, 1024]);
  assert.deepEqual([...sd.get('hidden.weight').data], [...arr('trained_hidden_w')]);
  assert.deepEqual([...sd.get('hidden.bias').data], [...arr('trained_hidden_b')]);
  assert.deepEqual([...sd.get('output.weight').data], [...arr('trained_output_w')]);
});

test('model.pt written here reads back the same', async () => {
  const w1 = arr('trained_hidden_w'), b1 = arr('trained_hidden_b'), w2 = arr('trained_output_w');
  const bytes = await torchSave({
    format: 1, mode: 'audio', embed_dim: 1024, num_classes: 3, dense_units: 100,
    state_dict: new OrderedDict([['hidden.weight', new Tensor([100, 1024], w1)], ['hidden.bias', new Tensor([100], b1)], ['output.weight', new Tensor([3, 100], w2)]],
      [['', { version: 1 }], ['hidden', { version: 1 }], ['output', { version: 1 }]]),
  });
  const p = await torchLoad(bytes);
  assert.equal(p.mode, 'audio');
  assert.deepEqual([...p.state_dict.get('output.weight').data], [...w2]);
  // Data of every storage starts on a 64-byte boundary, as torch.save writes it
  mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
  writeFileSync(new URL('./out/web_model.pt', import.meta.url), bytes);
});

test('reads the .sensavmodel and embeddings.npz SensAV writes', async () => {
  const z = await readZip(fixtureBytes('fixture.sensavmodel'));
  assert.deepEqual([...z.keys()].sort(), ['labels.json', 'model.pt', 'model_info.json', 'training.json']);
  const info = JSON.parse(new TextDecoder().decode(z.get('model_info.json')));
  assert.equal(info.format, 1); assert.equal(info.mode, 'image');
  const p = await torchLoad(z.get('model.pt'));
  assert.equal(p.num_classes, 3);
  const npz = await readNpz(fixtureBytes('embeddings.npz'));
  assert.deepEqual(npz.get('image__ids').data, meta.npz_ids);
  assert.deepEqual(npz.get('image__vectors').shape, [6, 1, 1024]);
  assert.deepEqual(npz.get('audio__vectors').shape, [0, 1, 0]);
});

test('npz written here reads back the same', async () => {
  const ids = ['20261007_120000_000000_ab12', 'x'], bits = new Uint16Array(2 * 1024).map((_, i) => i);
  const bytes = await writeNpz([['image__ids', npyStrings(ids)], ['image__vectors', npyFloat16(bits, [2, 1, 1024])], ['audio__ids', npyStrings([])], ['audio__vectors', npyFloat16(new Uint16Array(0), [0, 1, 0])]]);
  const back = await readNpz(bytes);
  assert.deepEqual(back.get('image__ids').data, ids);
  assert.deepEqual([...back.get('image__vectors').data], [...bits]);
  writeFileSync(new URL('./out/web_embeddings.npz', import.meta.url), bytes);
  const deflated = await writeZip([['a.json', new TextEncoder().encode('{"x": 1}')]], { deflate: true });
  assert.equal(new TextDecoder().decode((await readZip(deflated)).get('a.json')), '{"x": 1}');
});
