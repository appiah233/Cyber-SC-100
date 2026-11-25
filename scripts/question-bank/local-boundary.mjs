import { spawnSync } from 'node:child_process'

/** No protected input/output belongs inside any recognized git checkout. */
export function assertOutsideWorktree(directory) {
  const probe = spawnSync('git', ['-C', directory, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (probe.error || probe.signal || (probe.status !== 0 && (!probe.stderr.includes('not a git repository') || probe.status !== 128))
    || (probe.status === 0 && probe.stdout.trim() !== 'false')) {
    throw new Error('Protected files must be outside Git worktrees. Git is required to verify the location.')
  }
}
