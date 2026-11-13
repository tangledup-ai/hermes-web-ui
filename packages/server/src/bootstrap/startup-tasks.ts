import { runStartupTasks, type StartupTask } from '../modules/studio/services/startup-tasks'

/** Ordered, append-only list of one-time startup operations. See docs/harness/startup-tasks.md. */
export function getStartupTasks(): StartupTask[] {
  return []
}

export function runRegisteredStartupTasks() {
  return runStartupTasks(getStartupTasks())
}
