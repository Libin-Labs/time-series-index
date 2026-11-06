export interface DataPoint {
  timestamp: number;
  value: number;
}

export interface TimeSeriesOptions {
  maxSeries?: number;
  maxPoints?: number;
}

export interface QueryRange {
  from?: number;
  to?: number;
  limit?: number;
}

export interface Bucket {
  start: number;
  end: number;
  count: number;
  sum: number;
  min: number;
  max: number;
  average: number;
}

export interface TimeSeriesIndex {
  readonly seriesCount: number;
  readonly pointCount: number;
  upsert(series: string, point: DataPoint): void;
  removeSeries(series: string): boolean;
  query(series: string, range?: QueryRange): DataPoint[];
  aggregate(series: string, width: number, range?: QueryRange): Bucket[];
  clear(): void;
}

export class TimeSeriesIndexError extends Error {
  constructor(
    readonly code: 'capacity' | 'unknown-series',
    message: string,
  ) {
    super(message);
    this.name = 'TimeSeriesIndexError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

function assertPlainObject(value: unknown, name: string): void {
  if (!isRecord(value)) throw new TypeError(`${name} must be a plain object.`);
}

function bounded(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function validateSeries(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new TypeError('Series name must be a non-empty string of at most 256 characters.');
  }
}

function validateTime(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be a safe integer timestamp.`);
  }
}

export function createTimeSeriesIndex(options: TimeSeriesOptions = {}): TimeSeriesIndex {
  assertPlainObject(options, 'Options');
  const maxSeries = bounded(options.maxSeries ?? 1000, 'maxSeries', 1, 100_000);
  const maxPoints = bounded(options.maxPoints ?? 1_000_000, 'maxPoints', 1, 10_000_000);
  const seriesMap = new Map<string, DataPoint[]>();
  let pointCount = 0;
  const requireSeries = (name: string) => {
    validateSeries(name);
    const points = seriesMap.get(name);
    if (!points) throw new TimeSeriesIndexError('unknown-series', `Unknown series: ${name}`);
    return points;
  };
  const rangeValues = (range: QueryRange = {}) => {
    assertPlainObject(range, 'Range');
    const from = range.from;
    const to = range.to;
    if (from !== undefined) validateTime(from, 'from');
    if (to !== undefined) validateTime(to, 'to');
    if (from !== undefined && to !== undefined && from > to)
      throw new RangeError('from must not exceed to.');
    const limit = bounded(range.limit ?? maxPoints, 'limit', 0, maxPoints);
    return { from: from ?? Number.MIN_SAFE_INTEGER, to: to ?? Number.MAX_SAFE_INTEGER, limit };
  };

  return {
    get seriesCount() {
      return seriesMap.size;
    },
    get pointCount() {
      return pointCount;
    },
    upsert(name, input) {
      validateSeries(name);
      if (!isRecord(input)) throw new TypeError('Point must be a plain object.');
      validateTime(input.timestamp, 'timestamp');
      if (typeof input.value !== 'number' || !Number.isFinite(input.value)) {
        throw new TypeError('Point value must be finite.');
      }
      let points = seriesMap.get(name);
      if (!points) {
        if (seriesMap.size >= maxSeries)
          throw new TimeSeriesIndexError('capacity', 'Series capacity reached.');
        points = [];
        seriesMap.set(name, points);
      }
      let low = 0;
      let high = points.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (points[middle]!.timestamp < input.timestamp) low = middle + 1;
        else high = middle;
      }
      const replacing = points[low]?.timestamp === input.timestamp;
      if (!replacing && pointCount >= maxPoints)
        throw new TimeSeriesIndexError('capacity', 'Point capacity reached.');
      const point = Object.freeze({ timestamp: input.timestamp, value: input.value });
      if (replacing) points[low] = point;
      else {
        points.splice(low, 0, point);
        pointCount++;
      }
    },
    removeSeries(name) {
      validateSeries(name);
      const points = seriesMap.get(name);
      if (!points) return false;
      pointCount -= points.length;
      return seriesMap.delete(name);
    },
    query(name, range = {}) {
      const points = requireSeries(name);
      const { from, to, limit } = rangeValues(range);
      let low = 0;
      let high = points.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (points[middle]!.timestamp < from) low = middle + 1;
        else high = middle;
      }
      const output: DataPoint[] = [];
      for (let index = low; index < points.length && output.length < limit; index++) {
        if (points[index]!.timestamp > to) break;
        output.push({ ...points[index]! });
      }
      return output;
    },
    aggregate(name, width, range = {}) {
      const points = requireSeries(name);
      if (!Number.isSafeInteger(width) || width <= 0)
        throw new RangeError('width must be a positive safe integer.');
      const { from, to, limit } = rangeValues(range);
      const buckets = new Map<number, { count: number; sum: number; min: number; max: number }>();
      let considered = 0;
      for (const point of points) {
        if (point.timestamp < from) continue;
        if (point.timestamp > to) break;
        if (considered >= limit) break;
        considered++;
        const start = Math.floor(point.timestamp / width) * width;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(start + width)) {
          throw new RangeError('Bucket boundaries exceed the safe integer timestamp range.');
        }
        let bucket = buckets.get(start);
        if (!bucket)
          buckets.set(start, (bucket = { count: 0, sum: 0, min: Infinity, max: -Infinity }));
        bucket.count++;
        bucket.sum += point.value;
        if (!Number.isFinite(bucket.sum))
          throw new RangeError('Bucket sum exceeds finite number range.');
        bucket.min = Math.min(bucket.min, point.value);
        bucket.max = Math.max(bucket.max, point.value);
      }
      return [...buckets]
        .sort(([a], [b]) => a - b)
        .map(([start, bucket]) => ({
          start,
          end: start + width,
          count: bucket.count,
          sum: bucket.sum,
          min: bucket.min,
          max: bucket.max,
          average: bucket.sum / bucket.count,
        }));
    },
    clear() {
      seriesMap.clear();
      pointCount = 0;
    },
  };
}
