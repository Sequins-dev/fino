/**
 * `fino:tensor/optim` — optimizers, gradient clipping, and schedules.
 *
 * ```ts no_run
 * import { AdamW, CosineSchedule, clipGradNorm } from 'fino:tensor/optim';
 *
 * const optimizer = new AdamW(model.parameters(), { lr: 3e-4 });
 * const schedule = new CosineSchedule(3e-4, 1000, { warmupSteps: 50 });
 *
 * loss.backward();
 * await clipGradNorm(model.parameters(), 1);
 * optimizer.lr = schedule.at(optimizer.steps);
 * optimizer.step();
 * optimizer.zeroGrad();
 * ```
 *
 * **Experimental**, alongside the rest of the tensor engine.
 */
export { Optimizer, SGD, Adam, AdamW, clipGradNorm } from './optim.ts';
export type { ParamGroup } from './optim.ts';
export {
  ConstantSchedule,
  LinearWarmup,
  CosineSchedule,
  StepSchedule,
} from './schedule.ts';
export type { Schedule } from './schedule.ts';
