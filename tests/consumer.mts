import { createTimeSeriesIndex, type DataPoint } from '@lp-labs/time-series-index';
const index = createTimeSeriesIndex();
const point: DataPoint = { timestamp: 100, value: 2 };
index.upsert('metric', point);
void index.query('metric');
