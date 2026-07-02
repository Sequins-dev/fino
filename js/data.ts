/**
* fino:data - data engineering and interchange formats.
*
* The `arrow` namespace is a pure-TypeScript Apache Arrow implementation
* (columnar in-memory format, IPC stream/file interchange, and the C Data
* Interface). Future data-processing surfaces (datasets, frames) will attach
* here.
*
* ```ts no_run
* import { arrow } from 'fino:data';
*
* const batch = arrow.RecordBatch.from({ x: [1, 2, 3] });
* console.log(batch.numRows); // 3
* ```
*/
export * as arrow from 'fino:data/arrow';
