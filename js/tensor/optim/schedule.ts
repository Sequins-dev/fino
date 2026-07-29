/**
 * Learning-rate schedules.
 *
 * Plain functions of the step count, wrapped in small objects a loop can query.
 * They deliberately do not hold a reference to an optimizer: coupling the two
 * makes it awkward to log a rate before applying it, or to drive two optimizers
 * from one schedule.
 *
 * @internal
 *
 * This module is re-exported through `fino:tensor/optim`; import from there.
 */

/** A learning-rate schedule. */
export interface Schedule {
  /** The rate for a zero-based step index. */
  at(step: number): number;
}

/** A constant rate. */
export class ConstantSchedule implements Schedule {
  constructor(private readonly value: number) {}

  at(): number {
    return this.value;
  }
}

/**
 * Linear warmup followed by a constant rate.
 *
 * Warmup exists because adaptive optimizers have poorly conditioned moment
 * estimates in their first steps, and a full-rate update against them can move
 * parameters somewhere training never recovers from.
 */
export class LinearWarmup implements Schedule {
  constructor(
    private readonly peak: number,
    private readonly warmupSteps: number,
  ) {
    if (warmupSteps < 0) throw new Error('warmupSteps must not be negative');
  }

  at(step: number): number {
    if (step >= this.warmupSteps || this.warmupSteps === 0) return this.peak;
    return (this.peak * (step + 1)) / this.warmupSteps;
  }
}

/**
 * Cosine decay from `peak` to `floor` over `totalSteps`, with optional warmup.
 */
export class CosineSchedule implements Schedule {
  constructor(
    private readonly peak: number,
    private readonly totalSteps: number,
    private readonly options: { warmupSteps?: number; floor?: number } = {},
  ) {
    if (totalSteps <= 0) throw new Error('totalSteps must be positive');
  }

  at(step: number): number {
    const warmup = this.options.warmupSteps ?? 0;
    const floor = this.options.floor ?? 0;
    if (step < warmup) return (this.peak * (step + 1)) / warmup;
    const span = Math.max(this.totalSteps - warmup, 1);
    const progress = Math.min((step - warmup) / span, 1);
    return floor + 0.5 * (this.peak - floor) * (1 + Math.cos(Math.PI * progress));
  }
}

/** Multiply the rate by `gamma` every `stepSize` steps. */
export class StepSchedule implements Schedule {
  constructor(
    private readonly peak: number,
    private readonly stepSize: number,
    private readonly gamma = 0.1,
  ) {
    if (stepSize <= 0) throw new Error('stepSize must be positive');
  }

  at(step: number): number {
    return this.peak * this.gamma ** Math.floor(step / this.stepSize);
  }
}
