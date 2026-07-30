/**
 * fino:data/frame - bounded lazy DataFrame plans over Arrow record batches.
 *
 * A `DataFrame<Row>` is an immutable plan, not a table wrapper. Operators add
 * filter, projection, computed-column, aggregation, join, sort, or limit nodes;
 * `batches()` executes the plan lazily and `collect()` asynchronously gathers
 * its Arrow batches into a `Table`. Streaming operators preserve input batch
 * boundaries. Aggregation, joins, and sort are deliberately blocking because
 * their bounded first version needs the complete input.
 *
 * Expressions are reusable and columnar. `frame.col('name')` preserves the
 * caller's `Row` type, while `col<T>('name')` is convenient for reusable plans.
 * Comparisons, boolean logic, and arithmetic use SQL-like null semantics:
 * null propagates, filters retain only literal `true`, and aggregates ignore
 * null inputs. Joins never overwrite colliding right fields; they suffix them.
 *
 * `scanParquet()` inspects footer metadata at plan time. Named projections are
 * pushed into selective column decoding, and simple comparisons/null checks
 * conservatively select row groups from statistics. The filter still executes
 * after decoding, so missing or unsupported statistics can only reduce
 * optimization, never change results.
 *
 * This is intentionally not a general query engine. The operator set serves
 * evaluation, memory ingestion, batch inference, classical ML preprocessing,
 * and display. A future SQL surface should parse into this same plan.
 *
 * ```ts no_run
 * import { DataFrame, col, count } from 'fino:data/frame';
 *
 * const report = DataFrame.scanParquet<{ team: string; score: number }>(bytes)
 *   .filter(col<number>('score').gte(0.8))
 *   .groupBy('team')
 *   .agg({ rows: count(), meanScore: col<number>('score').mean() })
 *   .sort(col<string>('team').asc());
 *
 * const table = await report.collect();
 * ```
 */
import {
  Field,
  RecordBatch,
  Schema,
  Table,
  Vector,
  bool,
  float64,
  vectorFromArray,
  type DataType,
} from 'fino:data/arrow';
import { readParquet } from 'fino:data/parquet';
import {
  inspectParquet,
  type ParquetColumnStatistics,
  type ParquetFileInfo,
} from 'internal:data/parquet/reader';

/** Plain object shape tracked by a typed DataFrame. */
export type DataFrameRow = object;
type RowKey<Row> = Extract<keyof Row, string>;
type Nullable<T> = T | null;
type ExprValue<E> = E extends Expr<infer T> ? T : never;
type AggValue<E> = E extends AggregateExpr<infer T> ? T : never;

/** Named scalar expressions accepted by projection and computed-column APIs. */
export type ExpressionSelection = Readonly<Record<string, Expr<unknown>>>;
/** Named aggregate expressions accepted by `aggregate()` and `GroupBy.agg()`. */
export type AggregateSelection = Readonly<Record<string, AggregateExpr<unknown>>>;
/** Infer a row shape from a named scalar-expression object. */
export type SelectionRow<S extends ExpressionSelection> = {
  [K in keyof S]: ExprValue<S[K]>;
};
/** Infer a row shape from a named aggregate-expression object. */
export type AggregationRow<S extends AggregateSelection> = {
  [K in keyof S]: AggValue<S[K]>;
};

type BinaryOp =
  | 'eq'
  | 'ne'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'and'
  | 'or'
  | 'add'
  | 'sub'
  | 'mul'
  | 'div';
type UnaryOp = 'not' | 'isNull' | 'isNotNull';
type ExprNode =
  | { kind: 'column'; name: string }
  | { kind: 'literal'; value: unknown; dataType?: DataType }
  | { kind: 'binary'; op: BinaryOp; left: ExprNode; right: ExprNode }
  | { kind: 'unary'; op: UnaryOp; input: ExprNode };
type AggregateOp = 'countRows' | 'count' | 'sum' | 'mean' | 'min' | 'max';

function expression<T>(node: ExprNode): Expr<T> {
  return new Expr<T>(node);
}
function asExpression<T>(value: Expr<T> | T): Expr<T> {
  return value instanceof Expr ? value : lit(value);
}
function isNullish(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}
function equal(left: unknown, right: unknown): boolean {
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    if (left.byteLength !== right.byteLength) return false;
    for (let index = 0; index < left.byteLength; index++)
      if (left[index] !== right[index]) return false;
    return true;
  }
  return Object.is(left, right);
}
function compare(left: unknown, right: unknown): number {
  if (equal(left, right)) return 0;
  return (left as never) < (right as never) ? -1 : 1;
}
function evaluateBinary(op: BinaryOp, left: unknown, right: unknown): unknown {
  if (op === 'and') {
    if (left === false || right === false) return false;
    if (isNullish(left) || isNullish(right)) return null;
    return Boolean(left && right);
  }
  if (op === 'or') {
    if (left === true || right === true) return true;
    if (isNullish(left) || isNullish(right)) return null;
    return Boolean(left || right);
  }
  if (isNullish(left) || isNullish(right)) return null;
  switch (op) {
    case 'eq':
      return equal(left, right);
    case 'ne':
      return !equal(left, right);
    case 'lt':
      return compare(left, right) < 0;
    case 'lte':
      return compare(left, right) <= 0;
    case 'gt':
      return compare(left, right) > 0;
    case 'gte':
      return compare(left, right) >= 0;
    case 'add':
      return (left as number) + (right as number);
    case 'sub':
      return (left as number) - (right as number);
    case 'mul':
      return (left as number) * (right as number);
    case 'div':
      return Number(left) / Number(right);
  }
}
function evaluateNode(node: ExprNode, batch: RecordBatch): unknown[] {
  if (node.kind === 'column') {
    const column = batch.getChild(node.name);
    if (!column) throw new DataFrameError(`unknown column "${node.name}"`);
    return column.toArray();
  }
  if (node.kind === 'literal') return Array(batch.numRows).fill(node.value);
  if (node.kind === 'unary') {
    const values = evaluateNode(node.input, batch);
    return values.map((value) => {
      if (node.op === 'isNull') return isNullish(value);
      if (node.op === 'isNotNull') return !isNullish(value);
      return isNullish(value) ? null : !value;
    });
  }
  const left = evaluateNode(node.left, batch);
  const right = evaluateNode(node.right, batch);
  return left.map((value, index) => evaluateBinary(node.op, value, right[index]));
}
function nodeColumns(node: ExprNode, output = new Set<string>()): Set<string> {
  if (node.kind === 'column') output.add(node.name);
  else if (node.kind === 'unary') nodeColumns(node.input, output);
  else if (node.kind === 'binary') {
    nodeColumns(node.left, output);
    nodeColumns(node.right, output);
  }
  return output;
}
function nodeType(node: ExprNode, schema: Schema | undefined): DataType | undefined {
  if (node.kind === 'column') return schema?.fields.find((field) => field.name === node.name)?.type;
  if (node.kind === 'literal') {
    if (node.dataType) return node.dataType;
    if (isNullish(node.value)) return undefined;
    return vectorFromArray([node.value]).type;
  }
  if (node.kind === 'unary') return bool();
  if (['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'and', 'or'].includes(node.op)) return bool();
  if (node.op === 'div') return float64();
  return nodeType(node.left, schema) ?? nodeType(node.right, schema);
}
function describeNode(node: ExprNode): string {
  if (node.kind === 'column') return node.name;
  if (node.kind === 'literal')
    return typeof node.value === 'string' ? JSON.stringify(node.value) : String(node.value);
  if (node.kind === 'unary') return `${node.op}(${describeNode(node.input)})`;
  return `${node.op}(${describeNode(node.left)}, ${describeNode(node.right)})`;
}

/**
 * Reusable scalar or column expression.
 *
 * Construct with `frame.col()`, `col()`, or `lit()`. Expression objects are
 * immutable and may be reused across plans.
 */
export class Expr<T = unknown> {
  declare private readonly _valueType: T;
  /**
   * Expression tree used by the planner and vector evaluator.
   *
   * @internal
   */
  readonly node: ExprNode;
  /** @internal */
  constructor(node: ExprNode) {
    this.node = node;
  }
  /** Equality comparison. Null on either side produces null. */
  eq<U>(other: Expr<U> | U): Expr<boolean | null> {
    return expression({
      kind: 'binary',
      op: 'eq',
      left: this.node,
      right: asExpression(other).node,
    });
  }
  /** Inequality comparison. Null on either side produces null. */
  ne<U>(other: Expr<U> | U): Expr<boolean | null> {
    return expression({
      kind: 'binary',
      op: 'ne',
      left: this.node,
      right: asExpression(other).node,
    });
  }
  /** Strict less-than comparison with null propagation. */
  lt<U>(other: Expr<U> | U): Expr<boolean | null> {
    return expression({
      kind: 'binary',
      op: 'lt',
      left: this.node,
      right: asExpression(other).node,
    });
  }
  /** Less-than-or-equal comparison with null propagation. */
  lte<U>(other: Expr<U> | U): Expr<boolean | null> {
    return expression({
      kind: 'binary',
      op: 'lte',
      left: this.node,
      right: asExpression(other).node,
    });
  }
  /** Strict greater-than comparison with null propagation. */
  gt<U>(other: Expr<U> | U): Expr<boolean | null> {
    return expression({
      kind: 'binary',
      op: 'gt',
      left: this.node,
      right: asExpression(other).node,
    });
  }
  /** Greater-than-or-equal comparison with null propagation. */
  gte<U>(other: Expr<U> | U): Expr<boolean | null> {
    return expression({
      kind: 'binary',
      op: 'gte',
      left: this.node,
      right: asExpression(other).node,
    });
  }
  /** Three-valued boolean AND. */
  and(
    this: Expr<boolean | null>,
    other: Expr<boolean | null> | boolean | null,
  ): Expr<boolean | null> {
    return expression({
      kind: 'binary',
      op: 'and',
      left: this.node,
      right: asExpression(other).node,
    });
  }
  /** Three-valued boolean OR. */
  or(
    this: Expr<boolean | null>,
    other: Expr<boolean | null> | boolean | null,
  ): Expr<boolean | null> {
    return expression({
      kind: 'binary',
      op: 'or',
      left: this.node,
      right: asExpression(other).node,
    });
  }
  /** Three-valued boolean negation. */
  not(this: Expr<boolean | null>): Expr<boolean | null> {
    return expression({ kind: 'unary', op: 'not', input: this.node });
  }
  /** True exactly when the value is null or undefined. */
  isNull(): Expr<boolean> {
    return expression({ kind: 'unary', op: 'isNull', input: this.node });
  }
  /** True exactly when the value is present. */
  isNotNull(): Expr<boolean> {
    return expression({ kind: 'unary', op: 'isNotNull', input: this.node });
  }
  /** Numeric addition with null propagation. */
  add<U extends number | bigint | null>(
    this: Expr<number | bigint | null>,
    other: Expr<U> | U,
  ): Expr<number | bigint | null> {
    return expression({
      kind: 'binary',
      op: 'add',
      left: this.node,
      right: asExpression(other).node,
    });
  }
  /** Numeric subtraction with null propagation. */
  sub<U extends number | bigint | null>(
    this: Expr<number | bigint | null>,
    other: Expr<U> | U,
  ): Expr<number | bigint | null> {
    return expression({
      kind: 'binary',
      op: 'sub',
      left: this.node,
      right: asExpression(other).node,
    });
  }
  /** Numeric multiplication with null propagation. */
  mul<U extends number | bigint | null>(
    this: Expr<number | bigint | null>,
    other: Expr<U> | U,
  ): Expr<number | bigint | null> {
    return expression({
      kind: 'binary',
      op: 'mul',
      left: this.node,
      right: asExpression(other).node,
    });
  }
  /** Numeric division as a JavaScript number, with null propagation. */
  div<U extends number | bigint | null>(
    this: Expr<number | bigint | null>,
    other: Expr<U> | U,
  ): Expr<number | null> {
    return expression({
      kind: 'binary',
      op: 'div',
      left: this.node,
      right: asExpression(other).node,
    });
  }
  /** Count non-null values in this expression. */
  count(): AggregateExpr<number> {
    return new AggregateExpr('count', this);
  }
  /** Sum non-null values, returning null when none are present. */
  sum(
    this: Expr<number | bigint | null | undefined>,
  ): AggregateExpr<Nullable<Exclude<T, null | undefined>>> {
    return new AggregateExpr('sum', this);
  }
  /** Average non-null values as a number, returning null when none are present. */
  mean(this: Expr<number | bigint | null | undefined>): AggregateExpr<number | null> {
    return new AggregateExpr('mean', this);
  }
  /** Minimum non-null value, returning null when none are present. */
  min(): AggregateExpr<Nullable<Exclude<T, null | undefined>>> {
    return new AggregateExpr('min', this);
  }
  /** Maximum non-null value, returning null when none are present. */
  max(): AggregateExpr<Nullable<Exclude<T, null | undefined>>> {
    return new AggregateExpr('max', this);
  }
  /** Ascending stable sort key. Nulls default to last. */
  asc(options: SortOptions = {}): SortExpr<T> {
    return new SortExpr(this, 'asc', options.nulls ?? 'last');
  }
  /** Descending stable sort key. Nulls default to last. */
  desc(options: SortOptions = {}): SortExpr<T> {
    return new SortExpr(this, 'desc', options.nulls ?? 'last');
  }
}

/** Create a reusable named-column expression. */
export function col<T = unknown>(name: string): Expr<T> {
  if (!name) throw new DataFrameError('column name must not be empty');
  return expression({ kind: 'column', name });
}
/** Create a scalar literal expression. Pass `dataType` for a projected null literal. */
export function lit<T>(value: T, dataType?: DataType): Expr<T> {
  return expression({
    kind: 'literal',
    value,
    ...(dataType ? { dataType } : {}),
  });
}

/** Aggregate expression produced by `count()` or an `Expr` aggregate method. */
export class AggregateExpr<T = unknown> {
  declare private readonly _aggregateType: T;
  /**
   * Aggregate operation.
   *
   * @internal
   */
  readonly op: AggregateOp;
  /**
   * Input expression, absent only for row count.
   *
   * @internal
   */
  readonly expr: Expr<unknown> | undefined;
  /** @internal */
  constructor(op: AggregateOp, expr?: Expr<unknown>) {
    this.op = op;
    this.expr = expr;
  }
}
/** Count input rows, including rows whose fields are all null. */
export function count(): AggregateExpr<number> {
  return new AggregateExpr('countRows');
}

/** Null placement for a sort key. */
export type NullPlacement = 'first' | 'last';
/** Sort-key construction options. */
export interface SortOptions {
  /** Where nulls sort, independent of direction. Defaults to `'last'`. */
  nulls?: NullPlacement;
}
/** Immutable expression plus direction/null placement used by `DataFrame.sort()`. */
export class SortExpr<T = unknown> {
  /** Expression to evaluate. */
  readonly expr: Expr<T>;
  /** Sort direction. */
  readonly direction: 'asc' | 'desc';
  /** Null placement. */
  readonly nulls: NullPlacement;
  /** Create a sort key. Prefer `expr.asc()` or `expr.desc()`. */
  constructor(expr: Expr<T>, direction: 'asc' | 'desc', nulls: NullPlacement) {
    this.expr = expr;
    this.direction = direction;
    this.nulls = nulls;
  }
}

/** Error thrown for invalid plans, missing columns, or unsupported values. */
export class DataFrameError extends Error {
  /** Error name, always `'DataFrameError'`. */
  name = 'DataFrameError';
}

/** Sources accepted by `DataFrame.from()`. */
export type DataFrameSource =
  | RecordBatch
  | Table
  | Iterable<RecordBatch>
  | AsyncIterable<RecordBatch>;
/** Source options for streaming inputs whose first batch may never arrive. */
export interface DataFrameSourceOptions {
  /** Known schema; required to collect an empty arbitrary stream. */
  schema?: Schema;
}
/** Supported relational join behavior. */
export type JoinHow = 'inner' | 'left' | 'right' | 'full';
type SameJoinKeys<Left, Right> = Extract<RowKey<Left>, RowKey<Right>>;
/** Explicit join keys and collision behavior. */
export type JoinOptions<Left extends object, Right extends object> = {
  /** Join type. Defaults to `'inner'`. */
  how?: JoinHow;
  /** Suffix for colliding non-key right fields. Defaults to `'_right'`. */
  suffix?: string;
} & (
  | {
      /** Same-named key or keys on both inputs. */
      on: SameJoinKeys<Left, Right> | readonly SameJoinKeys<Left, Right>[];
      leftOn?: never;
      rightOn?: never;
    }
  | {
      on?: never;
      /** Left key or keys, paired positionally with `rightOn`. */
      leftOn: RowKey<Left> | readonly RowKey<Left>[];
      /** Right key or keys, paired positionally with `leftOn`. */
      rightOn: RowKey<Right> | readonly RowKey<Right>[];
    }
);

interface ArrowScanPlan {
  kind: 'arrow';
  source: () => AsyncIterable<RecordBatch>;
  schema?: Schema;
}
interface ParquetScanPlan {
  kind: 'parquet';
  bytes: Uint8Array;
  info: ParquetFileInfo;
  columns?: string[];
  rowGroups?: number[];
  predicate?: Expr<boolean | null>;
}
interface FilterPlan {
  kind: 'filter';
  input: Plan;
  predicate: Expr<boolean | null>;
}
interface ProjectPlan {
  kind: 'project';
  input: Plan;
  selection: Record<string, Expr<unknown>>;
}
interface WithColumnsPlan {
  kind: 'withColumns';
  input: Plan;
  selection: Record<string, Expr<unknown>>;
}
interface AggregatePlan {
  kind: 'aggregate';
  input: Plan;
  keys: string[];
  selection: Record<string, AggregateExpr<unknown>>;
}
interface JoinPlan {
  kind: 'join';
  left: Plan;
  right: Plan;
  options: NormalizedJoinOptions;
}
interface SortPlan {
  kind: 'sort';
  input: Plan;
  keys: SortExpr<unknown>[];
}
interface LimitPlan {
  kind: 'limit';
  input: Plan;
  count: number;
}
type Plan =
  | ArrowScanPlan
  | ParquetScanPlan
  | FilterPlan
  | ProjectPlan
  | WithColumnsPlan
  | AggregatePlan
  | JoinPlan
  | SortPlan
  | LimitPlan;
interface NormalizedJoinOptions {
  how: JoinHow;
  suffix: string;
  leftOn: string[];
  rightOn: string[];
}

function safeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${name} must be a non-negative integer`);
  return value;
}
async function* sourceBatches(source: DataFrameSource): AsyncIterableIterator<RecordBatch> {
  if (source instanceof RecordBatch) {
    yield source;
  } else if (source instanceof Table) {
    yield* source.batches;
  } else {
    yield* source;
  }
}
function projectSchema(
  input: Schema | undefined,
  selection: Record<string, Expr<unknown>>,
): Schema | undefined {
  const fields: Field[] = [];
  for (const [name, expr] of Object.entries(selection)) {
    const type = nodeType(expr.node, input);
    if (!type) return undefined;
    fields.push(new Field(name, type, true));
  }
  return new Schema(fields);
}
function planSchema(plan: Plan): Schema | undefined {
  if (plan.kind === 'arrow') return plan.schema;
  if (plan.kind === 'parquet') {
    if (!plan.columns) return plan.info.schema;
    return new Schema(
      plan.columns.map((name) => {
        const field = plan.info.schema.fields.find((candidate) => candidate.name === name);
        if (!field) throw new DataFrameError(`unknown column "${name}"`);
        return field;
      }),
    );
  }
  if (plan.kind === 'filter' || plan.kind === 'sort' || plan.kind === 'limit')
    return planSchema(plan.input);
  if (plan.kind === 'project') return projectSchema(planSchema(plan.input), plan.selection);
  if (plan.kind === 'withColumns') {
    const input = planSchema(plan.input);
    if (!input) return undefined;
    const computed = projectSchema(input, plan.selection);
    if (!computed) return undefined;
    const byName = new Map(computed.fields.map((field) => [field.name, field]));
    const fields = input.fields.map((field) => {
      const replacement = byName.get(field.name);
      if (replacement) byName.delete(field.name);
      return replacement ?? field;
    });
    fields.push(...byName.values());
    return new Schema(fields);
  }
  if (plan.kind === 'aggregate') {
    const input = planSchema(plan.input);
    if (!input) return undefined;
    const fields = plan.keys.map((key) => {
      const field = input.fields.find((candidate) => candidate.name === key);
      if (!field) throw new DataFrameError(`unknown group key "${key}"`);
      return field;
    });
    for (const [name, aggregate] of Object.entries(plan.selection)) {
      const type =
        aggregate.op === 'countRows' || aggregate.op === 'count' || aggregate.op === 'mean'
          ? float64()
          : aggregate.expr
            ? nodeType(aggregate.expr.node, input)
            : undefined;
      if (!type) return undefined;
      fields.push(new Field(name, type, aggregate.op !== 'countRows' && aggregate.op !== 'count'));
    }
    return new Schema(fields);
  }
  if (plan.kind === 'join') {
    const left = planSchema(plan.left);
    const right = planSchema(plan.right);
    if (!left || !right) return undefined;
    return joinSchema(left, right, plan.options);
  }
}
function selectionColumns(selection: Record<string, Expr<unknown>>): Set<string> {
  const columns = new Set<string>();
  for (const expr of Object.values(selection)) nodeColumns(expr.node, columns);
  return columns;
}
function pushProjection(plan: Plan, required: Set<string>): Plan {
  if (plan.kind === 'parquet') {
    const columns = plan.info.schema.fields
      .map((field) => field.name)
      .filter((name) => required.has(name));
    return { ...plan, columns };
  }
  if (plan.kind === 'filter') {
    const all = new Set(required);
    nodeColumns(plan.predicate.node, all);
    return { ...plan, input: pushProjection(plan.input, all) };
  }
  if (plan.kind === 'limit' || plan.kind === 'sort')
    return { ...plan, input: pushProjection(plan.input, required) };
  return plan;
}
function statisticComparison(
  op: BinaryOp,
  statistics: ParquetColumnStatistics | undefined,
  value: unknown,
): boolean {
  if (!statistics || isNullish(value)) return true;
  const min = statistics.min;
  const max = statistics.max;
  if (min === undefined || max === undefined) return true;
  if (op === 'eq') return compare(value, min) >= 0 && compare(value, max) <= 0;
  if (op === 'ne') return !(equal(min, value) && equal(max, value) && statistics.nullCount === 0n);
  if (op === 'gt') return compare(max, value) > 0;
  if (op === 'gte') return compare(max, value) >= 0;
  if (op === 'lt') return compare(min, value) < 0;
  if (op === 'lte') return compare(min, value) <= 0;
  return true;
}
function mayMatch(node: ExprNode, group: ParquetFileInfo['rowGroups'][number]): boolean {
  if (node.kind === 'binary' && node.op === 'and')
    return mayMatch(node.left, group) && mayMatch(node.right, group);
  if (node.kind === 'binary' && node.op === 'or')
    return mayMatch(node.left, group) || mayMatch(node.right, group);
  if (node.kind === 'binary') {
    if (node.left.kind === 'column' && node.right.kind === 'literal')
      return statisticComparison(node.op, group.columns[node.left.name], node.right.value);
    if (node.right.kind === 'column' && node.left.kind === 'literal') {
      const reverse: Partial<Record<BinaryOp, BinaryOp>> = {
        lt: 'gt',
        lte: 'gte',
        gt: 'lt',
        gte: 'lte',
        eq: 'eq',
        ne: 'ne',
      };
      return statisticComparison(
        reverse[node.op] ?? node.op,
        group.columns[node.right.name],
        node.left.value,
      );
    }
  }
  if (node.kind === 'unary' && node.input.kind === 'column') {
    const stats = group.columns[node.input.name];
    if (node.op === 'isNull' && stats?.nullCount === 0n) return false;
    if (node.op === 'isNotNull' && stats?.nullCount === BigInt(group.numRows)) return false;
  }
  return true;
}
function pushPredicate(plan: Plan, predicate: Expr<boolean | null>): Plan {
  if (plan.kind !== 'parquet') return plan;
  const rowGroups = plan.info.rowGroups
    .filter((group) => mayMatch(predicate.node, group))
    .map((group) => group.index);
  return { ...plan, predicate, rowGroups };
}
function makeVector(values: unknown[], type: DataType | undefined): Vector {
  if (type) return vectorFromArray(values, type);
  if (values.length === 0 || values.every(isNullish))
    throw new DataFrameError('cannot infer the type of an empty or all-null expression');
  return vectorFromArray(values);
}
function projectBatch(batch: RecordBatch, selection: Record<string, Expr<unknown>>): RecordBatch {
  const fields: Field[] = [];
  const vectors: Vector[] = [];
  for (const [name, expr] of Object.entries(selection)) {
    const values = evaluateNode(expr.node, batch);
    const vector = makeVector(values, nodeType(expr.node, batch.schema));
    fields.push(new Field(name, vector.type, values.some(isNullish)));
    vectors.push(vector);
  }
  return new RecordBatch(new Schema(fields), vectors);
}
function withColumnsBatch(
  batch: RecordBatch,
  selection: Record<string, Expr<unknown>>,
): RecordBatch {
  const computed = projectBatch(batch, selection);
  const computedByName = new Map(
    computed.schema.fields.map((field, index) => [
      field.name,
      { field, vector: computed.columns[index]! },
    ]),
  );
  const fields: Field[] = [];
  const vectors: Vector[] = [];
  for (let index = 0; index < batch.schema.fields.length; index++) {
    const field = batch.schema.fields[index]!;
    const replacement = computedByName.get(field.name);
    fields.push(replacement?.field ?? field);
    vectors.push(replacement?.vector ?? batch.columns[index]!);
    computedByName.delete(field.name);
  }
  for (const { field, vector } of computedByName.values()) {
    fields.push(field);
    vectors.push(vector);
  }
  return new RecordBatch(new Schema(fields), vectors);
}
function filterBatch(batch: RecordBatch, predicate: Expr<boolean | null>): RecordBatch {
  const mask = evaluateNode(predicate.node, batch);
  const indices: number[] = [];
  for (let index = 0; index < mask.length; index++) if (mask[index] === true) indices.push(index);
  return takeRows(batch, indices);
}
function takeRows(batch: RecordBatch, indices: readonly number[]): RecordBatch {
  return new RecordBatch(
    batch.schema,
    batch.columns.map((column) =>
      vectorFromArray(
        indices.map((index) => column.get(index)),
        column.type,
      ),
    ),
  );
}
function concatBatches(schema: Schema, batches: RecordBatch[]): RecordBatch {
  return new RecordBatch(
    schema,
    schema.fields.map((field, columnIndex) =>
      vectorFromArray(
        batches.flatMap((batch) => batch.columns[columnIndex]!.toArray()),
        field.type,
      ),
    ),
  );
}
function keyPart(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'bigint') return `bigint:${value}`;
  if (value instanceof Uint8Array)
    return `bytes:${Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  return `${typeof value}:${JSON.stringify(value)}`;
}
function rowKey(batch: RecordBatch, keys: string[], index: number): string | null {
  const values = keys.map((key) => {
    const column = batch.getChild(key);
    if (!column) throw new DataFrameError(`unknown key column "${key}"`);
    return column.get(index);
  });
  if (values.some(isNullish)) return null;
  return values.map(keyPart).join('|');
}
function aggregateValue(
  aggregate: AggregateExpr<unknown>,
  values: unknown[] | undefined,
  indices: number[],
): unknown {
  if (aggregate.op === 'countRows') return indices.length;
  const present = indices.map((index) => values![index]).filter((value) => !isNullish(value));
  if (aggregate.op === 'count') return present.length;
  if (present.length === 0) return null;
  if (aggregate.op === 'sum') {
    let total = present[0] as number;
    for (let index = 1; index < present.length; index++)
      total = (total as number) + (present[index] as number);
    return total;
  }
  if (aggregate.op === 'mean')
    return present.reduce<number>((total, value) => total + Number(value), 0) / present.length;
  if (aggregate.op === 'min')
    return present.reduce((best, value) => (compare(value, best) < 0 ? value : best));
  return present.reduce((best, value) => (compare(value, best) > 0 ? value : best));
}
async function aggregatePlan(plan: AggregatePlan): Promise<RecordBatch> {
  const inputSchema = planSchema(plan.input);
  if (!inputSchema) throw new DataFrameError('aggregation requires a known input schema');
  const batches: RecordBatch[] = [];
  for await (const batch of execute(plan.input)) batches.push(batch);
  const input = concatBatches(inputSchema, batches);
  const groups = new Map<string, { keys: unknown[]; indices: number[] }>();
  if (plan.keys.length === 0) groups.set('', { keys: [], indices: [] });
  for (let index = 0; index < input.numRows; index++) {
    const values = plan.keys.map((key) => input.getChild(key)!.get(index));
    const key = values.map(keyPart).join('|');
    const group = groups.get(key) ?? { keys: values, indices: [] };
    group.indices.push(index);
    groups.set(key, group);
  }
  const aggregateValues = new Map<string, unknown[]>();
  for (const [name, aggregate] of Object.entries(plan.selection))
    aggregateValues.set(name, aggregate.expr ? evaluateNode(aggregate.expr.node, input) : []);
  const fields: Field[] = [];
  const columns: Vector[] = [];
  for (let keyIndex = 0; keyIndex < plan.keys.length; keyIndex++) {
    const field = inputSchema.fields.find((candidate) => candidate.name === plan.keys[keyIndex])!;
    const values = [...groups.values()].map((group) => group.keys[keyIndex]);
    fields.push(field);
    columns.push(vectorFromArray(values, field.type));
  }
  for (const [name, aggregate] of Object.entries(plan.selection)) {
    const values = [...groups.values()].map((group) =>
      aggregateValue(aggregate, aggregateValues.get(name), group.indices),
    );
    const type =
      aggregate.op === 'countRows' || aggregate.op === 'count' || aggregate.op === 'mean'
        ? float64()
        : aggregate.expr
          ? nodeType(aggregate.expr.node, inputSchema)
          : undefined;
    const vector = makeVector(values, type);
    fields.push(new Field(name, vector.type, values.some(isNullish)));
    columns.push(vector);
  }
  return new RecordBatch(new Schema(fields), columns);
}
async function sortPlan(plan: SortPlan): Promise<RecordBatch> {
  const schema = planSchema(plan.input);
  if (!schema) throw new DataFrameError('sort requires a known input schema');
  const batches: RecordBatch[] = [];
  for await (const batch of execute(plan.input)) batches.push(batch);
  const input = concatBatches(schema, batches);
  const values = plan.keys.map((key) => evaluateNode(key.expr.node, input));
  const indices = Array.from({ length: input.numRows }, (_, index) => index);
  indices.sort((left, right) => {
    for (let keyIndex = 0; keyIndex < plan.keys.length; keyIndex++) {
      const key = plan.keys[keyIndex]!;
      const a = values[keyIndex]![left];
      const b = values[keyIndex]![right];
      if (isNullish(a) || isNullish(b)) {
        if (isNullish(a) && isNullish(b)) continue;
        return isNullish(a) === (key.nulls === 'first') ? -1 : 1;
      }
      const result = compare(a, b);
      if (result !== 0) return key.direction === 'asc' ? result : -result;
    }
    return left - right;
  });
  return takeRows(input, indices);
}
function joinSchema(left: Schema, right: Schema, options: NormalizedJoinOptions): Schema {
  const leftNames = new Set(left.fields.map((field) => field.name));
  const rightKeys = new Set(options.rightOn);
  const leftNullable = options.how === 'right' || options.how === 'full';
  const rightNullable = options.how === 'left' || options.how === 'full';
  const fields = left.fields.map((field) =>
    leftNullable ? new Field(field.name, field.type, true) : field,
  );
  for (const field of right.fields) {
    if (rightKeys.has(field.name)) continue;
    const name = leftNames.has(field.name) ? `${field.name}${options.suffix}` : field.name;
    fields.push(
      rightNullable
        ? new Field(name, field.type, true)
        : new Field(name, field.type, field.nullable),
    );
  }
  return new Schema(fields);
}
async function joinPlan(plan: JoinPlan): Promise<RecordBatch> {
  const leftSchema = planSchema(plan.left);
  const rightSchema = planSchema(plan.right);
  if (!leftSchema || !rightSchema) throw new DataFrameError('join requires known input schemas');
  const leftBatches: RecordBatch[] = [];
  const rightBatches: RecordBatch[] = [];
  for await (const batch of execute(plan.left)) leftBatches.push(batch);
  for await (const batch of execute(plan.right)) rightBatches.push(batch);
  const left = concatBatches(leftSchema, leftBatches);
  const right = concatBatches(rightSchema, rightBatches);
  const index = new Map<string, number[]>();
  for (let row = 0; row < right.numRows; row++) {
    const key = rowKey(right, plan.options.rightOn, row);
    if (key === null) continue;
    const rows = index.get(key) ?? [];
    rows.push(row);
    index.set(key, rows);
  }
  const pairs: Array<[number | null, number | null]> = [];
  const matchedRight = new Set<number>();
  for (let row = 0; row < left.numRows; row++) {
    const key = rowKey(left, plan.options.leftOn, row);
    const matches = key === null ? undefined : index.get(key);
    if (matches?.length) {
      for (const rightRow of matches) {
        pairs.push([row, rightRow]);
        matchedRight.add(rightRow);
      }
    } else if (plan.options.how === 'left' || plan.options.how === 'full') {
      pairs.push([row, null]);
    }
  }
  if (plan.options.how === 'right' || plan.options.how === 'full')
    for (let row = 0; row < right.numRows; row++)
      if (!matchedRight.has(row)) pairs.push([null, row]);
  const outputSchema = joinSchema(leftSchema, rightSchema, plan.options);
  const values: unknown[][] = outputSchema.fields.map(() => []);
  const rightKeys = new Set(plan.options.rightOn);
  for (const [leftRow, rightRow] of pairs) {
    let output = 0;
    for (let column = 0; column < leftSchema.fields.length; column++) {
      let value = leftRow === null ? null : left.columns[column]!.get(leftRow);
      if (leftRow === null) {
        const leftKey = plan.options.leftOn.indexOf(leftSchema.fields[column]!.name);
        if (leftKey >= 0 && rightRow !== null)
          value = right.getChild(plan.options.rightOn[leftKey]!)!.get(rightRow);
      }
      values[output++]!.push(value);
    }
    for (let column = 0; column < rightSchema.fields.length; column++) {
      if (rightKeys.has(rightSchema.fields[column]!.name)) continue;
      values[output++]!.push(rightRow === null ? null : right.columns[column]!.get(rightRow));
    }
  }
  return new RecordBatch(
    outputSchema,
    outputSchema.fields.map((field, column) => vectorFromArray(values[column]!, field.type)),
  );
}
async function* execute(plan: Plan): AsyncIterableIterator<RecordBatch> {
  if (plan.kind === 'arrow') {
    yield* plan.source();
    return;
  }
  if (plan.kind === 'parquet') {
    const table = readParquet(plan.bytes, {
      ...(plan.columns ? { columns: plan.columns } : {}),
      ...(plan.rowGroups ? { rowGroups: plan.rowGroups } : {}),
    });
    yield* table.batches;
    return;
  }
  if (plan.kind === 'filter') {
    for await (const batch of execute(plan.input)) yield filterBatch(batch, plan.predicate);
    return;
  }
  if (plan.kind === 'project') {
    for await (const batch of execute(plan.input)) yield projectBatch(batch, plan.selection);
    return;
  }
  if (plan.kind === 'withColumns') {
    for await (const batch of execute(plan.input)) yield withColumnsBatch(batch, plan.selection);
    return;
  }
  if (plan.kind === 'aggregate') {
    yield await aggregatePlan(plan);
    return;
  }
  if (plan.kind === 'sort') {
    yield await sortPlan(plan);
    return;
  }
  if (plan.kind === 'join') {
    yield await joinPlan(plan);
    return;
  }
  let remaining = plan.count;
  if (remaining === 0) return;
  for await (const batch of execute(plan.input)) {
    if (batch.numRows <= remaining) {
      yield batch;
      remaining -= batch.numRows;
    } else {
      yield batch.slice(0, remaining);
      return;
    }
    if (remaining === 0) return;
  }
}
function describePlan(plan: Plan): string {
  if (plan.kind === 'arrow') return 'ArrowScan';
  if (plan.kind === 'parquet') {
    const columns = plan.columns ?? plan.info.schema.fields.map((field) => field.name);
    const groups = plan.rowGroups ?? plan.info.rowGroups.map((group) => group.index);
    return `ParquetScan(columns=[${columns.join(', ')}], rowGroups=[${groups.join(', ')}])`;
  }
  if (plan.kind === 'filter')
    return `${describePlan(plan.input)} |> Filter(${describeNode(plan.predicate.node)})`;
  if (plan.kind === 'project')
    return `${describePlan(plan.input)} |> Project(${Object.keys(plan.selection).join(', ')})`;
  if (plan.kind === 'withColumns')
    return `${describePlan(plan.input)} |> WithColumns(${Object.keys(plan.selection).join(', ')})`;
  if (plan.kind === 'aggregate')
    return `${describePlan(plan.input)} |> Aggregate(keys=[${plan.keys.join(', ')}], values=[${Object.keys(plan.selection).join(', ')}])`;
  if (plan.kind === 'sort') return `${describePlan(plan.input)} |> Sort`;
  if (plan.kind === 'limit') return `${describePlan(plan.input)} |> Limit(${plan.count})`;
  return `${describePlan(plan.left)} |> Join(${plan.options.how}) <| ${describePlan(plan.right)}`;
}

/**
 * Immutable lazy plan over Arrow record batches.
 *
 * The `Row` parameter is compile-time guidance for column names and common
 * projections; the runtime Arrow schema remains authoritative.
 */
export class DataFrame<Row extends object = Record<string, unknown>> {
  readonly #plan: Plan;
  /** @internal */
  constructor(plan: Plan) {
    this.#plan = plan;
  }
  /** Wrap Arrow batches or a table. Supply `schema` for a possibly empty stream. */
  static from<Row extends object = Record<string, unknown>>(
    source: DataFrameSource,
    options: DataFrameSourceOptions = {},
  ): DataFrame<Row> {
    const schema =
      options.schema ??
      (source instanceof RecordBatch || source instanceof Table ? source.schema : undefined);
    return new DataFrame({
      kind: 'arrow',
      source: () => sourceBatches(source),
      ...(schema ? { schema } : {}),
    });
  }
  /** Plan a selective scan over complete Parquet bytes. */
  static scanParquet<Row extends object = Record<string, unknown>>(
    input: Uint8Array | ArrayBuffer,
  ): DataFrame<Row> {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    return new DataFrame({ kind: 'parquet', bytes, info: inspectParquet(bytes) });
  }
  /** Build a typed expression for one row key. */
  col<Key extends RowKey<Row>>(name: Key): Expr<Row[Key]> {
    return col<Row[Key]>(name);
  }
  /** Add a filter. Only values equal to `true` pass; false and null are removed. */
  filter(predicate: Expr<boolean | null>): DataFrame<Row> {
    return new DataFrame({
      kind: 'filter',
      input: pushPredicate(this.#plan, predicate),
      predicate,
    });
  }
  /** Select named columns while preserving their TypeScript keys. */
  select<Key extends RowKey<Row>>(...columns: Key[]): DataFrame<Pick<Row, Key>>;
  /** Select and name arbitrary expressions, inferring the output row shape. */
  select<Selection extends ExpressionSelection>(
    selection: Selection,
  ): DataFrame<SelectionRow<Selection>>;
  /** @internal */
  select(
    first: string | ExpressionSelection,
    ...rest: string[]
  ): DataFrame<Record<string, unknown>> {
    const selection: Record<string, Expr<unknown>> = typeof first === 'string'
      ? Object.fromEntries([first, ...rest].map((name) => [name, col(name)]))
      : { ...first };
    const input = pushProjection(this.#plan, selectionColumns(selection));
    return new DataFrame({ kind: 'project', input, selection });
  }
  /**
   * Add or replace named columns.
   *
   * Expressions are evaluated against the input schema simultaneously; one
   * expression in the same call cannot refer to another newly named column.
   */
  withColumns<Selection extends ExpressionSelection>(
    selection: Selection,
  ): DataFrame<Omit<Row, keyof Selection> & SelectionRow<Selection>> {
    return new DataFrame({ kind: 'withColumns', input: this.#plan, selection: { ...selection } });
  }
  /** Group by one or more existing keys before calling `agg()`. */
  groupBy<Key extends RowKey<Row>>(...keys: Key[]): GroupedDataFrame<Row, Key> {
    if (keys.length === 0) throw new DataFrameError('groupBy requires at least one key');
    return new GroupedDataFrame(this.#plan, keys);
  }
  /** Aggregate the complete input into one row. */
  aggregate<Selection extends AggregateSelection>(
    selection: Selection,
  ): DataFrame<AggregationRow<Selection>> {
    return new DataFrame({
      kind: 'aggregate',
      input: this.#plan,
      keys: [],
      selection: { ...selection },
    });
  }
  /** Hash-join another frame with explicit keys and collision suffixing. */
  join<Right extends object>(
    other: DataFrame<Right>,
    options: JoinOptions<Row, Right>,
  ): DataFrame<Row & Omit<Right, keyof Row>> {
    const normalized = normalizeJoinOptions(options);
    return new DataFrame({
      kind: 'join',
      left: this.#plan,
      right: other.#plan,
      options: normalized,
    });
  }
  /** Stable sort by one or more expressions. A bare column name sorts ascending. */
  sort(...keys: Array<RowKey<Row> | SortExpr<unknown>>): DataFrame<Row> {
    if (keys.length === 0) throw new DataFrameError('sort requires at least one key');
    return new DataFrame({
      kind: 'sort',
      input: this.#plan,
      keys: keys.map((key) => (typeof key === 'string' ? col(key).asc() : key)),
    });
  }
  /** Keep at most `count` rows and stop pulling upstream once satisfied. */
  limit(count: number): DataFrame<Row> {
    return new DataFrame({ kind: 'limit', input: this.#plan, count: safeInteger(count, 'count') });
  }
  /** Execute and stream Arrow record batches. */
  batches(): AsyncIterableIterator<RecordBatch> {
    return execute(this.#plan);
  }
  /** Execute and collect the result as an Arrow table. */
  async collect(): Promise<Table> {
    const batches: RecordBatch[] = [];
    for await (const batch of this.batches()) batches.push(batch);
    if (batches.length > 0) return new Table(batches[0]!.schema, batches);
    const schema = planSchema(this.#plan);
    if (!schema) throw new DataFrameError('cannot collect an empty stream without a known schema');
    const empty = new RecordBatch(
      schema,
      schema.fields.map((field) => vectorFromArray([], field.type)),
    );
    return new Table(schema, [empty]);
  }
  /** Render the optimized plan, including Parquet projections and row groups. */
  explain(): string {
    return describePlan(this.#plan);
  }
}

function normalizeJoinOptions<Left extends object, Right extends object>(
  options: JoinOptions<Left, Right>,
): NormalizedJoinOptions {
  const leftOn =
    'on' in options && options.on !== undefined
      ? Array.isArray(options.on)
        ? [...options.on]
        : [options.on]
      : Array.isArray(options.leftOn)
        ? [...options.leftOn]
        : [options.leftOn];
  const rightOn =
    'on' in options && options.on !== undefined
      ? [...leftOn]
      : Array.isArray(options.rightOn)
        ? [...options.rightOn]
        : [options.rightOn];
  if (leftOn.length === 0 || leftOn.length !== rightOn.length)
    throw new DataFrameError('join key lists must be non-empty and have equal length');
  return {
    how: options.how ?? 'inner',
    suffix: options.suffix ?? '_right',
    leftOn: leftOn as string[],
    rightOn: rightOn as string[],
  };
}

/**
 * Grouped frame returned by `DataFrame.groupBy()`.
 *
 * Call `agg()` to finish the plan; grouped frames do not execute directly.
 */
export class GroupedDataFrame<Row extends object, Key extends RowKey<Row>> {
  readonly #input: Plan;
  readonly #keys: Key[];
  /** @internal */
  constructor(input: Plan, keys: Key[]) {
    this.#input = input;
    this.#keys = [...keys];
  }
  /** Aggregate each distinct key tuple, preserving key fields in the output. */
  agg<Selection extends AggregateSelection>(
    selection: Selection,
  ): DataFrame<Pick<Row, Key> & AggregationRow<Selection>> {
    return new DataFrame<Pick<Row, Key> & AggregationRow<Selection>>({
      kind: 'aggregate',
      input: this.#input,
      keys: this.#keys,
      selection: { ...selection },
    });
  }
}
