'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAnalysis } = require('../server.js');

test('normalizes items and recomputes totals', () => {
  const result = normalizeAnalysis({
    items: [
      { name: '  Eggs ', portion: '2 large', calories: '143.4', protein_g: 12.56, carbs_g: 1, fat_g: 9.51 },
      { name: 'Toast', portion: '1 slice', calories: 90, protein_g: 3, carbs_g: 17, fat_g: 1.2 },
    ],
    total: { calories: 9999 },
  });

  assert.equal(result.items[0].name, 'Eggs');
  assert.equal(result.items[0].calories, 143);
  assert.equal(result.items[0].protein_g, 12.6);
  assert.equal(result.total.calories, 233);
  assert.equal(result.total.protein_g, 15.6);
});

test('clamps invalid values and drops nameless items', () => {
  const result = normalizeAnalysis({
    items: [
      { name: '', calories: 100 },
      { name: 'Soup', calories: -50, protein_g: 'abc', fat_g: Infinity },
    ],
  });

  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0], {
    name: 'Soup',
    portion: '',
    calories: 0,
    protein_g: 0,
    carbs_g: 0,
    fat_g: 0,
  });
});

test('caps the item count and handles missing input', () => {
  const many = Array.from({ length: 40 }, (_, index) => ({
    name: `Food ${index}`,
    calories: 10,
  }));

  assert.equal(normalizeAnalysis({ items: many }).items.length, 30);
  assert.deepEqual(normalizeAnalysis(null), {
    items: [],
    total: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
  });
});
