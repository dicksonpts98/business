import { describe, expect, it } from 'vitest';
import {
  TASK_STATES, TERMINAL_TASK_STATES, assertTaskTransition, canTransitionTask,
} from './domain.js';

describe('task state machine', () => {
  it('allows the normal forward path', () => {
    expect(canTransitionTask('draft', 'queued')).toBe(true);
    expect(canTransitionTask('queued', 'running')).toBe(true);
    expect(canTransitionTask('running', 'completed')).toBe(true);
  });

  it('allows running -> queued, which lease loss and reassignment both need', () => {
    // Regression: omitting this made the lease reaper and the archive
    // cancel-and-reassign path throw at runtime.
    expect(canTransitionTask('running', 'queued')).toBe(true);
  });

  it('allows a bounded reopen from completed for explicit rework', () => {
    expect(canTransitionTask('completed', 'queued')).toBe(true);
    expect(canTransitionTask('completed', 'running')).toBe(false);
  });

  it('treats cancelled as final', () => {
    for (const state of TASK_STATES) {
      expect(canTransitionTask('cancelled', state), `cancelled -> ${state}`).toBe(false);
    }
  });

  it('releases every waiting state back to the queue', () => {
    for (const waiting of ['waiting_dependency', 'waiting_input', 'waiting_approval'] as const) {
      expect(canTransitionTask(waiting, 'queued'), waiting).toBe(true);
    }
  });

  it('never transitions straight from draft to running', () => {
    expect(canTransitionTask('draft', 'running')).toBe(false);
  });

  it('throws with both states named', () => {
    expect(() => assertTaskTransition('cancelled', 'running'))
      .toThrow('Illegal task transition cancelled -> running');
  });

  it('lists exactly the terminal states', () => {
    expect([...TERMINAL_TASK_STATES].sort()).toEqual(['cancelled', 'completed', 'failed']);
  });
});
