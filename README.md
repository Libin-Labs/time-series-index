# @lp-labs/time-series-index

A bounded in-memory index for numeric time series with sorted range retrieval and fixed-width
aggregates. Timestamps are safe integer epoch units chosen consistently by the caller.

## Install

```bash
npm install @lp-labs/time-series-index
```

Includes ES2022 ESM and CommonJS builds with TypeScript declarations. CommonJS:
`const { createTimeSeriesIndex } = require('@lp-labs/time-series-index')`.

## Quickstart

```js
import { createTimeSeriesIndex } from '@lp-labs/time-series-index';

const index = createTimeSeriesIndex();
index.upsert('temperature', { timestamp: 1000, value: 18.5 });
index.upsert('temperature', { timestamp: 2000, value: 19 });
console.log(index.query('temperature', { from: 1000, to: 1500 }));
console.log(index.aggregate('temperature', 1000));
```

## API

- `createTimeSeriesIndex({ maxSeries?, maxPoints? })` defaults to 1,000 series and 1,000,000
  total points. `maxSeries` is capped at 100,000; `maxPoints` at 10,000,000.
- `upsert(series, { timestamp, value })` inserts in timestamp order. Re-inserting a timestamp
  replaces its value without consuming capacity. Timestamps are safe integers; values must be
  finite numbers.
- `query(series, { from?, to?, limit? })` returns detached, ascending points in the inclusive
  range. The default limit is the total point capacity.
- `aggregate(series, width, { from?, to? })` returns occupied, epoch-aligned buckets containing
  `[start, end)` boundaries, count, sum, min, max and average. `width` is a positive safe integer.
- `removeSeries`, `clear`, `seriesCount`, and `pointCount` manage and report state.

Unknown series throw `TimeSeriesIndexError` with code `unknown-series`; capacity failures use
code `capacity`. Validate timestamps and units at your application boundary (milliseconds,
seconds and other epochs are not inferred).

## Customization and limitations

The index is process-local, single-threaded, and stores raw points in JavaScript arrays. Insert
and query are O(log n) lookup plus O(n) array movement/copying for a series; queries and bucket
aggregation are linear in returned/scanned points. There is no retention policy, persistence,
interpolation, gap filling, timezone/calendar bucketing, counter-rate logic, distributed
replication, or arbitrary dimensional metrics. Aggregation uses ordinary floating-point sums and
includes only observed buckets.

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
