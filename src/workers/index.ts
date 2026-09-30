/**
 * Worker Registry — `src/workers/index.ts`
 *
 * Singleton worker pools for each worker type. Import the typed pools from
 * here rather than constructing workers directly in components.
 *
 * Graceful degradation
 * --------------------
 * If `Worker` is not available in the current environment (e.g. some legacy
 * browsers, test environments) the pools are not created and callers should
 * use the synchronous fallback functions exported alongside each pool.
 *
 * Usage
 * -----
 * ```ts
 * import { useWorkerExport } from '../workers'
 *
 * const { exportHistory } = useWorkerExport()
 * const output = await exportHistory({ taskId, format: 'csv', pair, history })
 * ```
 */

import { WorkerPool } from './workerPool'
import type { DataParserWorker } from './dataParser.worker'
import type { ExportWorker } from './export.worker'
import type { ChartAggregationWorker } from './chartAggregation.worker'
import type { SearchWorker } from './search.worker'
import type { SortWorker } from './sort.worker'
import type { FormatWorker } from './format.worker'
import type { CorrelationWorker } from './correlation.worker'

// Re-export pool utilities for callers that need fine-grained control
export { WorkerPool, withWorker, getAdaptivePoolSize, getWorkerPoolDiagnostics } from './workerPool'
export type { WorkerPoolOptions, WorkerPoolDiagnostics } from './workerPool'

// Re-export all worker types
export type { DataParserWorker } from './dataParser.worker'
export type { ExportWorker } from './export.worker'
export type { ChartAggregationWorker } from './chartAggregation.worker'
export type { SearchWorker } from './search.worker'
export type { SortWorker } from './sort.worker'
export type { FormatWorker } from './format.worker'
export type { CorrelationWorker } from './correlation.worker'
export * from './types'

// ── Singleton pools ───────────────────────────────────────────────────────────

/**
 * Pool of data parser workers.
 * Null when the environment does not support Web Workers.
 */
export const dataParserPool: WorkerPool<DataParserWorker> | null =
  WorkerPool.supported
    ? new WorkerPool<DataParserWorker>(
        () =>
          new Worker(new URL('./dataParser.worker.ts', import.meta.url), { type: 'module' }),
        { label: 'dataParser' },
      )
    : null

/**
 * Pool of export workers (CSV / JSON / XLSX generation).
 * Null when the environment does not support Web Workers.
 */
export const exportPool: WorkerPool<ExportWorker> | null =
  WorkerPool.supported
    ? new WorkerPool<ExportWorker>(
        () =>
          new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' }),
        { label: 'export' },
      )
    : null

/**
 * Pool of chart aggregation workers (OHLC candles, LTTB downsampling).
 * Null when the environment does not support Web Workers.
 */
export const chartPool: WorkerPool<ChartAggregationWorker> | null =
  WorkerPool.supported
    ? new WorkerPool<ChartAggregationWorker>(
        () =>
          new Worker(new URL('./chartAggregation.worker.ts', import.meta.url), {
            type: 'module',
          }),
        { label: 'chartAggregation' },
      )
    : null

/**
 * Pool of search workers (full-text / predicate matching over feed rows).
 *
 * Queue policy: `drop-oldest` — under the 200 msg/s feed, stale search
 * requests are superseded by newer queries, so the oldest pending task is
 * discarded when the adaptive pool is saturated. Results are deterministic
 * and structured-clone transferable (no closures cross the boundary).
 * Null when the environment does not support Web Workers.
 */
export const searchPool: WorkerPool<SearchWorker> | null =
  WorkerPool.supported
    ? new WorkerPool<SearchWorker>(
        () =>
          new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' }),
        { label: 'search', queuePolicy: 'drop-oldest' },
      )
    : null

/**
 * Pool of sort workers (stable multi-key ordering of feed rows).
 *
 * Queue policy: `drop-oldest` — only the latest sort order matters for the
 * visible viewport; superseded sorts are discarded under load. Results are
 * deterministic (stable sort) and structured-clone transferable.
 * Null when the environment does not support Web Workers.
 */
export const sortPool: WorkerPool<SortWorker> | null =
  WorkerPool.supported
    ? new WorkerPool<SortWorker>(
        () =>
          new Worker(new URL('./sort.worker.ts', import.meta.url), { type: 'module' }),
        { label: 'sort', queuePolicy: 'drop-oldest' },
      )
    : null

/**
 * Pool of bulk format workers (number / date / currency formatting).
 *
 * Queue policy: `fifo` — formatting is idempotent per row and every batch
 * must be rendered, so tasks are processed in submission order. Results are
 * deterministic and structured-clone transferable.
 * Null when the environment does not support Web Workers.
 */
export const formatPool: WorkerPool<FormatWorker> | null =
  WorkerPool.supported
    ? new WorkerPool<FormatWorker>(
        () =>
          new Worker(new URL('./format.worker.ts', import.meta.url), { type: 'module' }),
        { label: 'format', queuePolicy: 'fifo' },
      )
    : null

/**
 * Pool of correlation workers (pairwise correlation matrices).
 *
 * Queue policy: `fifo` — correlation runs are expensive and each result is
 * consumed; tasks are processed in submission order. Results are
 * deterministic and structured-clone transferable.
 * Null when the environment does not support Web Workers.
 */
export const correlationPool: WorkerPool<CorrelationWorker> | null =
  WorkerPool.supported
    ? new WorkerPool<CorrelationWorker>(
        () =>
          new Worker(new URL('./correlation.worker.ts', import.meta.url), {
            type: 'module',
          }),
        { label: 'correlation', queuePolicy: 'fifo' },
      )
    : null

/**
 * Terminates all worker pools. Call during app teardown or in tests to prevent
 * dangling worker threads.
 */
export function terminateAllPools(): void {
  dataParserPool?.terminate()
  exportPool?.terminate()
  chartPool?.terminate()
  searchPool?.terminate()
  sortPool?.terminate()
  formatPool?.terminate()
  correlationPool?.terminate()
}
