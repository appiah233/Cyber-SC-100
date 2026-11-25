/** Exact bipartite assignment. A source ID has capacity one, no matter how many roles it can fill. */
export interface RoleCandidate {
  readonly id: string
  readonly quota: number
  readonly questionIds: readonly string[]
  /** Non-negative integer costs. Used only to prefer one feasible assignment over another. */
  readonly costByQuestion?: ReadonlyMap<string, number>
}

interface Edge { readonly to: number; readonly reverse: number; capacity: number; readonly cost: number }
type Graph = Edge[][]

function addEdge(graph: Graph, from: number, to: number, capacity: number, cost = 0): Edge {
  const forward: Edge = { to, reverse: graph[to]!.length, capacity, cost }
  graph[to]!.push({ to: from, reverse: graph[from]!.length, capacity: 0, cost: -cost })
  graph[from]!.push(forward)
  return forward
}

function applyFlow(graph: Graph, edge: Edge, amount: number): void {
  edge.capacity -= amount
  graph[edge.to]![edge.reverse]!.capacity += amount
}

function maxFlow(graph: Graph, sink: number, required: number): number {
  let flow = 0
  while (flow < required) {
    const level = Array<number>(graph.length).fill(-1)
    const queue = [0]
    level[0] = 0
    for (let head = 0; head < queue.length; head += 1) {
      const at = queue[head]!
      for (const edge of graph[at]!) {
        if (edge.capacity > 0 && level[edge.to] === -1) {
          level[edge.to] = level[at]! + 1
          queue.push(edge.to)
        }
      }
    }
    if (level[sink] === -1) break
    const cursor = Array<number>(graph.length).fill(0)
    function send(at: number, requested: number): number {
      if (at === sink) return requested
      const edges = graph[at]!
      while (cursor[at]! < edges.length) {
        const edge = edges[cursor[at]!]!
        if (edge.capacity > 0 && level[edge.to] === level[at]! + 1) {
          const pushed = send(edge.to, Math.min(requested, edge.capacity))
          if (pushed > 0) {
            applyFlow(graph, edge, pushed)
            return pushed
          }
        }
        cursor[at] = cursor[at]! + 1
      }
      return 0
    }
    for (let pushed = send(0, required - flow); pushed > 0; pushed = send(0, required - flow)) {
      flow += pushed
      if (flow === required) return flow
    }
  }
  return flow
}

/** Residual shortest paths; only normal-batch preference uses this (≤59 units). */
function minCostFlow(graph: Graph, sink: number, required: number): number {
  let flow = 0
  while (flow < required) {
    const distance = Array<number>(graph.length).fill(Infinity)
    const predecessors = Array<{ from: number; edge: Edge } | undefined>(graph.length)
    const queued = Array<boolean>(graph.length).fill(false)
    const queue = [0]
    distance[0] = 0
    queued[0] = true
    for (let head = 0; head < queue.length; head += 1) {
      const at = queue[head]!
      queued[at] = false
      for (const edge of graph[at]!) {
        const candidate = distance[at]! + edge.cost
        if (edge.capacity > 0 && candidate < distance[edge.to]!) {
          distance[edge.to] = candidate
          predecessors[edge.to] = { from: at, edge }
          if (!queued[edge.to]) {
            queued[edge.to] = true
            queue.push(edge.to)
          }
        }
      }
    }
    if (!predecessors[sink]) break
    let at = sink
    while (at !== 0) {
      const { from, edge } = predecessors[at]!
      applyFlow(graph, edge, 1)
      at = from
    }
    flow += 1
  }
  return flow
}

export function allocateRoles(roleCandidates: readonly RoleCandidate[]): ReadonlyMap<string, readonly string[]> | null {
  const questions = new Map<string, number>()
  const roleIds = new Set<string>()
  let required = 0
  for (const { id, quota, questionIds } of roleCandidates) {
    if (roleIds.has(id) || !Number.isSafeInteger(quota) || quota < 0 || quota > new Set(questionIds).size) return null
    roleIds.add(id)
    required += quota
    for (const questionId of questionIds) {
      if (!questions.has(questionId)) questions.set(questionId, 1 + roleCandidates.length + questions.size)
    }
  }
  if (required > questions.size) return null

  const sink = 1 + roleCandidates.length + questions.size
  const graph = Array.from({ length: sink + 1 }, (): Edge[] => [])
  const matches = new Map<string, { questionId: string; edge: Edge }[]>()
  let hasCosts = false
  for (const [index, role] of roleCandidates.entries()) {
    const roleNode = 1 + index
    addEdge(graph, 0, roleNode, role.quota)
    const tracking: { questionId: string; edge: Edge }[] = []
    for (const questionId of new Set(role.questionIds)) {
      const cost = role.costByQuestion?.get(questionId) ?? 0
      if (!Number.isSafeInteger(cost) || cost < 0 || !Number.isSafeInteger(cost * Math.max(required, 1))) return null
      if (cost > 0) hasCosts = true
      tracking.push({ questionId, edge: addEdge(graph, roleNode, questions.get(questionId)!, 1, cost) })
    }
    matches.set(role.id, tracking)
  }
  for (const questionNode of questions.values()) addEdge(graph, questionNode, sink, 1)
  const result = hasCosts ? minCostFlow(graph, sink, required) : maxFlow(graph, sink, required)
  if (result !== required) return null
  return new Map([...matches].map(([key, entries]) => [
    key, Object.freeze(entries.filter(({ edge }) => edge.capacity === 0).map(({ questionId }) => questionId)),
  ]))
}
