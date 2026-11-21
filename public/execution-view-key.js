export const isExecutionViewKey = value => typeof value === 'string' && /^[a-zA-Z0-9_.:#@-]{1,320}$/.test(value);

export function executionLivePreferenceKey(scope, sequence) {
  const values = scope?.kind === 'classic'
    ? [scope.bridgeInstance, scope.bridgeRun, scope.workspaceGeneration, scope.branchEpoch, sequence]
    : [scope?.owner?.runtimeId, scope?.owner?.runtimeGeneration, scope?.branchEpoch, sequence];
  if (!Number.isSafeInteger(sequence) || values.some(value => !isExecutionViewKey(String(value)) || value == null)) return null;
  return 'live:' + values.join(':');
}
