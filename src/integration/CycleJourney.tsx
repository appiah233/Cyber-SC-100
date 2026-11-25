import { useEffect, useState } from 'react'
import App from '../app/App'
import { isAttemptSnapshot } from '../domain'
import { isCycleLifecycle } from '../domain/cycle-lifecycle'
import { createExamRepository, StorageError } from '../storage'
import type { CandidateCycle, CandidateSnapshot, FoundationSource } from './candidate-attempt'
import { createCandidateJourney } from './candidate-journey'
import type { CandidateJourneyOptions } from './candidate-journey'
import { Foundation } from './Foundation'

export type { CandidateJourneyOptions } from './candidate-journey'

/** Fresh browser or reload resolves the durable journey pointer, not a route
 * parameter. The candidate editor remains under its single IndexedDB fence. */
export function CycleJourney({ configuration }: { readonly configuration: CandidateJourneyOptions }) {
  const [source, setSource] = useState<FoundationSource | null>(null)
  const [error, setError] = useState<{ title: string; description: string } | undefined>()
  useEffect(() => {
    let stopped = false
    let reading = false
    let readAgain = false
    let hasRecord = false
    let previousId: string | undefined
    let focusNext = false
    const repo = createExamRepository<CandidateSnapshot, CandidateCycle>({
      databaseName: configuration.idbName,
      validateAttempt: isAttemptSnapshot,
      validateCycle: value => isCycleLifecycle(value.lifecycle),
    })
    let journey: ReturnType<typeof createCandidateJourney>
    try { journey = createCandidateJourney(configuration) }
    catch {
      const report = window.requestAnimationFrame(() => setError({
        title: 'No verified examination inventory',
        description: 'No validated cycle can be started with the loaded bank. Saved data was not reset.',
      }))
      return () => { window.cancelAnimationFrame(report); repo.close() }
    }
    const read = async () => {
      if (stopped) return
      if (reading) { readAgain = true; return }
      reading = true
      try {
        const record = await repo.loadJourney(configuration.id, configuration.bank.version)
        if (!record && hasRecord) throw new StorageError('CORRUPT')
        if (stopped) return
        if (record) hasRecord = true
        if (record && record.attempt.id === previousId) return
        if (!record && previousId) return
        const selected = record ? journey.sourceForRecord(record) : journey.initial()
        previousId = selected.attemptId
        const focusOnMount = focusNext
        focusNext = false
        setSource({ ...selected, focusOnMount, journey: {
          id: configuration.id,
          advance: journey.advance,
          onAdvanced: () => { focusNext = true; void read() },
          onStale: () => { void read() },
        } })
      } catch (cause) {
        if (!stopped) setError(cause instanceof StorageError && cause.code === 'CONTENT_VERSION_MISMATCH'
          ? { title: 'Saved examination uses another content version', description: 'Open the original verified content to resume. Nothing was reset.' }
          : { title: 'Saved examination could not be opened', description: 'The local examination or cycle could not be validated. Nothing was reset.' })
      } finally {
        reading = false
        if (readAgain) { readAgain = false; void read() }
      }
    }
    void read()
    const poll = window.setInterval(() => void read(), 1_500)
    window.addEventListener('focus', read)
    return () => {
      stopped = true
      window.clearInterval(poll)
      window.removeEventListener('focus', read)
      repo.close()
    }
  }, [configuration])

  if (error) return <App preview={{ sections: [], activeSectionId: '', questions: [], position: 0, view: 'error',
    readOnly: true, error, status: { label: error.title, tone: 'error' } }} />
  if (!source) return <App preview={{ sections: [], activeSectionId: '', questions: [], position: 0, view: 'loading',
    readOnly: true, status: { label: 'Opening browser storage…' } }} />
  return <Foundation source={source} />
}
