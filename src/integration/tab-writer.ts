const TAB_KEY = 'examination-hub:cyber-sc-100:tab-writer'
export const LEASE_MS = 30_000

interface TabWriter {
  readonly id: string
  release(): void
}

// The label in sessionStorage allows instant reload in the same tab. SessionStorage
// may be copied into new tabs; a document-scoped Web Lock rejects duplicate labels.
export async function tabWriter(): Promise<TabWriter> {
  const fresh = () => 'tab-' + globalThis.crypto.randomUUID()
  const base = (): TabWriter => ({ id: fresh(), release() {} })
  if (!navigator.locks) return base()
  let id = fresh()
  try {
    id = sessionStorage.getItem(TAB_KEY) ?? id
  } catch {
    // Storage for the non-authoritative reload label is optional.
  }

  const hold = (candidate: string): Promise<TabWriter | null> => new Promise((resolve) => {
    void navigator.locks.request(TAB_KEY + ':' + candidate, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(null)
        return
      }
      return new Promise<void>((release) => {
        resolve({ id: candidate, release })
      })
    }).catch(() => resolve(null))
  })
  const claimed = await hold(id) ?? await hold(fresh())
  if (!claimed) return base()
  try {
    sessionStorage.setItem(TAB_KEY, claimed.id)
  } catch {
    // In this browser a reload may require explicit expired-lease takeover.
  }
  return claimed
}
