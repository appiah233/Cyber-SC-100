/** Resolved only by the opt-in, local candidate build. */
declare module 'virtual:local-candidate-display' {
  const display: Omit<import('../data/candidate-reference').CandidateReferencePackage, 'assetFiles'> & {
    readonly scoringPolicy?: import('../domain/scoring').ScoringPolicy
    readonly examTiming?: { readonly examDurationMinutes: number; readonly timerWarningMinutes: readonly number[] }
  }
  export default display
}
