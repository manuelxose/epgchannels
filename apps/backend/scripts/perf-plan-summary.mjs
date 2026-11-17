/**
 * Summarises a MongoDB `explain('executionStats')` envelope.
 *
 * Kept in its own module so the measurement script and its verification check
 * share exactly one implementation: the plan a report quotes must come from the
 * same code the report ran.
 *
 * The driver returns the server envelope unchanged — `queryPlanner.winningPlan`
 * plus `executionStats` — so both shapes are read from there, never from a
 * pre-extracted `winningPlan`.
 */
function collect(node, onNode) {
  if (!node || typeof node !== 'object') return;
  onNode(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((entry) => collect(entry, onNode));
    else if (value && typeof value === 'object') collect(value, onNode);
  }
}

export function planSummary(explained) {
  const stages = [];
  const indexes = [];
  collect(explained?.queryPlanner?.winningPlan, (node) => {
    if (node.stage) stages.push(node.stage);
    if (node.indexName) indexes.push(node.indexName);
  });
  const rejected = [];
  for (const plan of explained?.queryPlanner?.rejectedPlans ?? []) {
    collect(plan, (node) => {
      if (node.indexName) rejected.push(node.indexName);
    });
  }
  return {
    stages: [...new Set(stages)],
    indexNames: [...new Set(indexes)],
    rejectedIndexes: [...new Set(rejected)],
    docsExamined: explained?.executionStats?.totalDocsExamined ?? null,
    keysExamined: explained?.executionStats?.totalKeysExamined ?? null,
    returned: explained?.executionStats?.nReturned ?? null,
    inMemorySort: stages.includes('SORT'),
    collectionScan: stages.includes('COLLSCAN'),
    executionTimeMs: explained?.executionStats?.executionTimeMillis ?? null,
  };
}
