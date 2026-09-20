import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ROUTING_WEIGHT_KEYS,
  defaultRoutingWeightsPercent,
  parseRoutingWeightPercent,
  parseRoutingWeightsInput,
  routingWeightsFromPercent,
  routingWeightsToPercent,
} from '../src/renderer/routing-weights-settings.js';

test('a missing override resolves to the defaults', () => {
  assert.deepEqual(routingWeightsToPercent(undefined), defaultRoutingWeightsPercent());
  assert.deepEqual(routingWeightsToPercent(null), defaultRoutingWeightsPercent());
});

test('a stored fraction override round-trips through percent form', () => {
  const stored = { price: 0.5, speed: 0.25, quota: 0.15, intelligence: 0.1 };
  assert.deepEqual(routingWeightsToPercent(stored), {
    price: 50,
    speed: 25,
    quota: 15,
    intelligence: 10,
  });
  assert.deepEqual(routingWeightsFromPercent({ price: 50, speed: 25, quota: 15, intelligence: 10 }), stored);
});

test('percent parse accepts valid integers and decimals', () => {
  assert.equal(parseRoutingWeightPercent('40'), 40);
  assert.equal(parseRoutingWeightPercent(' 7.5 '), 7.5);
  assert.equal(parseRoutingWeightPercent('0'), 0);
  assert.equal(parseRoutingWeightPercent('100'), 100);
});

test('percent parse rejects empty, malformed, non-finite, and out-of-range values', () => {
  assert.throws(() => parseRoutingWeightPercent(''), /百分比/);
  assert.throws(() => parseRoutingWeightPercent('   '), /百分比/);
  assert.throws(() => parseRoutingWeightPercent('abc'), /有效数值/);
  assert.throws(() => parseRoutingWeightPercent('NaN'), /有效数值/);
  assert.throws(() => parseRoutingWeightPercent('Infinity'), /有效数值/);
  assert.throws(() => parseRoutingWeightPercent('-1'), /0 到 100/);
  assert.throws(() => parseRoutingWeightPercent('101'), /0 到 100/);
});

test('full input parse requires all four fields to sum to 100', () => {
  assert.deepEqual(
    parseRoutingWeightsInput({ price: '40', speed: '30', quota: '20', intelligence: '10' }),
    { price: 40, speed: 30, quota: 20, intelligence: 10 },
  );
  assert.throws(
    () => parseRoutingWeightsInput({ price: '40', speed: '30', quota: '20', intelligence: '11' }),
    /之和必须为 100/,
  );
  assert.throws(
    () => parseRoutingWeightsInput({ price: '40', speed: '30', quota: '20', intelligence: '' }),
    /百分比/,
  );
  assert.throws(
    () => parseRoutingWeightsInput({ price: 'x', speed: '30', quota: '20', intelligence: '10' }),
    /有效数值/,
  );
});
