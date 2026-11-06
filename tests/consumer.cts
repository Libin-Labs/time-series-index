import { createTimeSeriesIndex } from '@lp-labs/time-series-index';
const index = createTimeSeriesIndex();
index.upsert('metric', { timestamp: 100, value: 2 });
const count: number = index.pointCount;
void count;
