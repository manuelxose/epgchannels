/**
 * Job pause/resume — the state the scheduler actually consults.
 *
 * Why this exists at all: `POST /admin/operations/jobs/:name/pause` is a promise
 * to an operator that the platform stops asking third parties for data. A route
 * that only writes a flag nobody reads is a lie, so the flag lives here, it is
 * read by `jobs/scheduler.ts` before *every* run (the timer tick and the HTTP
 * trigger alike), and the scheduler skips the run entirely.
 *
 * Two things are decisions and are therefore recorded:
 *
 * 1. **The state persists in MongoDB** (`job_controls`), not in a module
 *    variable. A restart must not silently resume a job an operator paused, and
 *    a second instance must not disagree with the first. Failures to persist are
 *    surfaced, never swallowed: an unwritable pause is not a pause.
 * 2. **Every change is audited** in `audit_log`, through the editorial service
 *    that owns that collection, together with who did it and why.
 *
 * Pause is not cancellation. A run already in flight finishes; what pause
 * prevents is the *next* run. Cancelling a feed mid-write would leave half a
 * guide behind, which is worse than finishing it.
 */
import type { DatabaseHandle } from '../infrastructure/mongo.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import type { Actor } from '../modules/admin/editorial.service.js';
import type { EditorialService } from '../modules/admin/editorial.service.js';

/** The persisted control row. `_id` is the job name, which is the natural key. */
export interface JobControlDoc {
  _id: string;
  paused: boolean;
  pausedAt: Date | null;
  pausedReason: string | null;
  /** Actor id that last changed the state, for the operator view. */
  actor: string | null;
  updatedAt: Date;
}

export interface JobControlState {
  readonly paused: boolean;
  readonly pausedAt: Date | null;
  readonly pausedReason: string | null;
}

export const NOT_PAUSED: JobControlState = Object.freeze({
  paused: false,
  pausedAt: null,
  pausedReason: null,
});

export interface JobControlChange {
  readonly name: string;
  readonly state: JobControlState;
  /** False when the job was already in the requested state (idempotent call). */
  readonly changed: boolean;
}

/**
 * Owns the paused flag of every registered job.
 *
 * The scheduler holds one instance and asks it on every tick; the admin router
 * holds the same instance and writes through it. `bootstrap.ts` constructs it
 * once, so there is exactly one reader and one writer of the same state.
 */
export class JobControlService {
  /**
   * `job_controls` is not in the shared `COLLECTIONS` map yet; it is addressed
   * here so the admin milestone adds no collection name to a file another
   * specialist owns. The name is stable and documented in one place: this one.
   */
  private readonly collectionName = 'job_controls';

  constructor(
    private readonly database: DatabaseHandle,
    private readonly editorial: Pick<EditorialService, 'recordExternal'>,
  ) {}

  /** Reads one job's state. Absent row = not paused (the default is permissive on purpose). */
  async stateOf(name: string): Promise<JobControlState> {
    const doc = await this.rowOf(name);
    if (doc === null) return NOT_PAUSED;
    return {
      paused: doc.paused === true,
      pausedAt: doc.pausedAt ?? null,
      pausedReason: doc.pausedReason ?? null,
    };
  }

  /**
   * Whether the scheduler may run this job now.
   *
   * A read failure is answered with `false`: refusing to run a job for one tick
   * costs nothing, while running a job the operator paused may contact third
   * parties and is exactly what this control must prevent. Fail closed.
   */
  async mayRun(name: string): Promise<boolean> {
    try {
      return !(await this.stateOf(name)).paused;
    } catch {
      return false;
    }
  }

  /** Pauses one job. Idempotent: pausing a paused job keeps the original reason. */
  async pause(name: string, actor: Actor, reason: string, requestId: string): Promise<JobControlChange> {
    return this.set(name, true, actor, reason, requestId);
  }

  /** Resumes one job. Idempotent: resuming a running job changes nothing. */
  async resume(name: string, actor: Actor, reason: string, requestId: string): Promise<JobControlChange> {
    return this.set(name, false, actor, reason, requestId);
  }

  /** Every paused job, for the operations view. */
  async pausedJobs(): Promise<Map<string, JobControlState>> {
    const docs = await this.database
      .db.collection<JobControlDoc>(this.collectionName)
      .find({ paused: true })
      .toArray();
    return new Map(
      docs.map((doc) => [
        doc._id,
        { paused: true, pausedAt: doc.pausedAt ?? null, pausedReason: doc.pausedReason ?? null },
      ]),
    );
  }

  private async rowOf(name: string): Promise<JobControlDoc | null> {
    return this.database.db.collection<JobControlDoc>(this.collectionName).findOne({ _id: name });
  }

  private async set(
    name: string,
    paused: boolean,
    actor: Actor,
    reason: string,
    requestId: string,
  ): Promise<JobControlChange> {
    const existing = await this.stateOf(name);
    if (existing.paused === paused) {
      // Still audited: an operator who pressed the button twice should see both
      // presses, but the pause instant and its original reason do not move.
      await this.editorial.recordExternal(actor, 'job.pause.noop', 'job', name, requestId, {
        paused,
        reason,
      });
      return { name, state: existing, changed: false };
    }
    const now = new Date();
    const state: JobControlState = {
      paused,
      pausedAt: paused ? now : null,
      pausedReason: paused ? reason : null,
    };
    await this.database.db.collection<JobControlDoc>(this.collectionName).updateOne(
      { _id: name },
      {
        $set: {
          paused: state.paused,
          pausedAt: state.pausedAt,
          pausedReason: state.pausedReason,
          actor: actor.id,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
    await this.editorial.recordExternal(actor, paused ? 'job.pause' : 'job.resume', 'job', name, requestId, {
      paused,
      reason,
    });
    return { name, state, changed: true };
  }
}

/**
 * The jobs the running scheduler actually registered, published here.
 *
 * `jobs/scheduler.ts` declares its jobs and publishes them through
 * `registerScheduledJobs`, so the operations endpoint reports what exists in this
 * process instead of a list written down twice. A name that is not registered is
 * not pausable: pausing a job that does not exist would report a control that
 * never had an effect.
 */
export interface RegisteredJob {
  readonly name: string;
  /** Minutes between timer runs; `null` for a job only ever run on demand. */
  readonly intervalMinutes: number | null;
  /** Whether the job is switched on at all, independently of its pause flag. */
  readonly enabled: boolean;
}

const scheduledJobs = new Map<string, RegisteredJob>();

export function registerScheduledJobs(jobs: readonly RegisteredJob[]): void {
  scheduledJobs.clear();
  for (const job of jobs) scheduledJobs.set(job.name, job);
}

/** Clears the registry (`stopJobs`). A stopped scheduler runs nothing to pause. */
export function clearScheduledJobs(): void {
  scheduledJobs.clear();
}

export function scheduledJobList(): readonly RegisteredJob[] {
  return [...scheduledJobs.values()];
}

export function scheduledJob(name: string): RegisteredJob | undefined {
  return scheduledJobs.get(name);
}
