import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createTimeSeriesIndex, TimeSeriesIndexError } from '../dist/esm/index.js';

const require = createRequire(import.meta.url);

test('CommonJS build retrieves indexed points', () => {
  const { createTimeSeriesIndex: createCjsIndex } = require('../dist/cjs/index.js');
  const index = createCjsIndex();
  index.upsert('cjs', { timestamp: 1, value: 2 });
  assert.deepEqual(index.query('cjs'), [{ timestamp: 1, value: 2 }]);
});

test('stores points in timestamp order regardless of insertion order', () => {
  const index = createTimeSeriesIndex();
  index.upsert('cpu', { timestamp: 30, value: 3 });
  index.upsert('cpu', { timestamp: 10, value: 1 });
  index.upsert('cpu', { timestamp: 20, value: 2 });
  assert.deepEqual(index.query('cpu'), [
    { timestamp: 10, value: 1 },
    { timestamp: 20, value: 2 },
    { timestamp: 30, value: 3 },
  ]);
});

test('same timestamp replaces rather than duplicates points', () => {
  const index = createTimeSeriesIndex();
  index.upsert('cpu', { timestamp: 10, value: 1 });
  index.upsert('cpu', { timestamp: 10, value: 9 });
  assert.equal(index.pointCount, 1);
  assert.deepEqual(index.query('cpu'), [{ timestamp: 10, value: 9 }]);
});

test('range boundaries are inclusive and ordered', () => {
  const index = createTimeSeriesIndex();
  for (let timestamp = 0; timestamp <= 5; timestamp++)
    index.upsert('s', { timestamp, value: timestamp });
  assert.deepEqual(
    index.query('s', { from: 2, to: 4 }).map(({ timestamp }) => timestamp),
    [2, 3, 4],
  );
});

test('query limit returns the earliest matching points', () => {
  const index = createTimeSeriesIndex();
  for (let timestamp = 0; timestamp < 5; timestamp++)
    index.upsert('s', { timestamp, value: timestamp });
  assert.deepEqual(
    index.query('s', { limit: 2 }).map(({ timestamp }) => timestamp),
    [0, 1],
  );
});

test('aggregates into epoch-aligned buckets with exact summaries', () => {
  const index = createTimeSeriesIndex();
  for (const [timestamp, value] of [
    [0, 2],
    [4, 4],
    [10, 8],
    [19, 10],
  ]) {
    index.upsert('s', { timestamp, value });
  }
  assert.deepEqual(index.aggregate('s', 10), [
    { start: 0, end: 10, count: 2, sum: 6, min: 2, max: 4, average: 3 },
    { start: 10, end: 20, count: 2, sum: 18, min: 8, max: 10, average: 9 },
  ]);
});

test('aggregation range clips points without filling empty buckets', () => {
  const index = createTimeSeriesIndex();
  for (const timestamp of [0, 1, 20, 40]) index.upsert('s', { timestamp, value: timestamp });
  assert.deepEqual(
    index.aggregate('s', 10, { from: 1, to: 21 }).map(({ start, count }) => [start, count]),
    [
      [0, 1],
      [20, 1],
    ],
  );
});

test('aggregation honors range limit and reports numeric overflow', () => {
  const index = createTimeSeriesIndex();
  index.upsert('limited', { timestamp: 0, value: 1 });
  index.upsert('limited', { timestamp: 1, value: 2 });
  assert.equal(index.aggregate('limited', 10, { limit: 1 })[0].sum, 1);
  index.upsert('overflow', { timestamp: 0, value: Number.MAX_VALUE });
  index.upsert('overflow', { timestamp: 1, value: Number.MAX_VALUE });
  assert.throws(() => index.aggregate('overflow', 10), RangeError);
});

test('aggregation rejects boundaries outside the safe timestamp range', () => {
  const index = createTimeSeriesIndex();
  index.upsert('s', { timestamp: Number.MIN_SAFE_INTEGER, value: 1 });
  assert.throws(() => index.aggregate('s', 1000), RangeError);
});

test('series and point capacity failures do not mutate counts', () => {
  const index = createTimeSeriesIndex({ maxSeries: 1, maxPoints: 2 });
  index.upsert('a', { timestamp: 1, value: 1 });
  index.upsert('a', { timestamp: 2, value: 2 });
  assert.throws(() => index.upsert('a', { timestamp: 3, value: 3 }), TimeSeriesIndexError);
  assert.throws(() => index.upsert('b', { timestamp: 1, value: 1 }), TimeSeriesIndexError);
  assert.equal(index.pointCount, 2);
  assert.equal(index.seriesCount, 1);
});

test('replacement remains possible at point capacity', () => {
  const index = createTimeSeriesIndex({ maxPoints: 1 });
  index.upsert('s', { timestamp: 1, value: 1 });
  index.upsert('s', { timestamp: 1, value: 2 });
  assert.equal(index.query('s')[0].value, 2);
});

test('series removal frees point and series capacity', () => {
  const index = createTimeSeriesIndex({ maxSeries: 1, maxPoints: 1 });
  index.upsert('old', { timestamp: 0, value: 0 });
  assert.equal(index.removeSeries('old'), true);
  assert.equal(index.removeSeries('old'), false);
  index.upsert('new', { timestamp: 1, value: 1 });
  assert.equal(index.pointCount, 1);
});

test('unknown series and malformed values are rejected', () => {
  const index = createTimeSeriesIndex();
  assert.throws(() => index.query('absent'), TimeSeriesIndexError);
  assert.throws(() => index.upsert('', { timestamp: 1, value: 1 }), TypeError);
  assert.throws(() => index.upsert('s', { timestamp: 1.5, value: 1 }), TypeError);
  assert.throws(() => index.upsert('s', { timestamp: 1, value: Infinity }), TypeError);
  index.upsert('s', { timestamp: 1, value: 1 });
  assert.throws(() => index.query('s', { from: 2, to: 1 }), RangeError);
});

test('validates aggregation widths and query limits', () => {
  const index = createTimeSeriesIndex();
  index.upsert('s', { timestamp: 0, value: 0 });
  assert.throws(() => index.aggregate('s', 0), RangeError);
  assert.throws(() => index.query('s', { limit: -1 }), RangeError);
});

test('generated insertion and queries match a sorted-array oracle', () => {
  const index = createTimeSeriesIndex({ maxPoints: 1000 });
  const points = [];
  for (let i = 0; i < 400; i++) {
    const point = { timestamp: (i * 127) % 521, value: (i * 31) % 101 };
    const existing = points.findIndex(({ timestamp }) => timestamp === point.timestamp);
    if (existing < 0) points.push(point);
    else points[existing] = point;
    index.upsert('s', point);
  }
  points.sort((a, b) => a.timestamp - b.timestamp);
  for (let from = 0; from < 500; from += 17) {
    const to = from + 43;
    assert.deepEqual(
      index.query('s', { from, to }),
      points.filter((point) => point.timestamp >= from && point.timestamp <= to),
    );
  }
});

test('generated aggregates equal direct per-bucket calculations', () => {
  const index = createTimeSeriesIndex({ maxPoints: 500 });
  const points = [];
  for (let i = 0; i < 300; i++) {
    const point = { timestamp: i * 7 - 500, value: ((i * 19) % 101) - 30 };
    points.push(point);
    index.upsert('s', point);
  }
  const width = 37;
  const expectedMap = new Map();
  for (const point of points) {
    const start = Math.floor(point.timestamp / width) * width;
    const bucket = expectedMap.get(start) ?? [];
    bucket.push(point.value);
    expectedMap.set(start, bucket);
  }
  const expected = [...expectedMap]
    .sort(([a], [b]) => a - b)
    .map(([start, values]) => ({
      start,
      end: start + width,
      count: values.length,
      sum: values.reduce((a, b) => a + b, 0),
      min: Math.min(...values),
      max: Math.max(...values),
      average: values.reduce((a, b) => a + b, 0) / values.length,
    }));
  assert.deepEqual(index.aggregate('s', width), expected);
});
