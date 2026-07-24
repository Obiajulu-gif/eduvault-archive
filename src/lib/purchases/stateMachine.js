export const PURCHASE_STATES = {
  PENDING: "pending",
  CONFIRMED: "confirmed",
};

export const PURCHASE_TRANSITIONS = {
  [PURCHASE_STATES.PENDING]: [PURCHASE_STATES.CONFIRMED],
  [PURCHASE_STATES.CONFIRMED]: [], // Terminal state
};

export function canTransition(currentState, targetState) {
  const allowed = PURCHASE_TRANSITIONS[currentState];
  if (!allowed) return false;
  return allowed.includes(targetState);
}

export function assertTransition(currentState, targetState) {
  if (!canTransition(currentState, targetState)) {
    throw new Error(`Invalid purchase state transition from '${currentState}' to '${targetState}'`);
  }
}
