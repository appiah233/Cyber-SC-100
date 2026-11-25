/** Resolved only by the protected localhost release build, never by the Pages entry. */
declare module 'virtual:local-release-display' {
  const display: {
    readonly scope: 'PRIVATE_RELEASE_CANDIDATE_ONLY'
    readonly bankVersion: string
    readonly inventory: import('../domain/batch-engine').BatchBank
    readonly questions: Readonly<Record<string, import('../app/App').FoundationQuestion>>
    readonly contexts: Readonly<Record<string, NonNullable<import('../app/App').FoundationPreview['context']>>>
    readonly contentCounts: {
      readonly sourceRecords: number
      readonly eligible: number
      readonly standardEligible: number
      readonly eligibleWithSourceLimitation: number
      readonly reviewHold: number
      readonly excluded: number
      readonly publicEligible: number
      readonly caseFamilies: number
      readonly caseChildren: number
      readonly interactions: Readonly<Record<string, number>>
      readonly sourceInteractions: Readonly<Record<string, number>>
    }
    readonly examTiming: { readonly examDurationMinutes: number; readonly timerWarningMinutes: readonly number[] }
    readonly scoringPolicy: import('../domain/scoring').ScoringPolicy
  }
  export default display
}
