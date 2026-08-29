export const ROLE_RULES = {
  Constable: { forceStationFilter: true },
  Inspector: { forceStationFilter: false },
  SP: { forceStationFilter: false },
};

export function getRules(role) {
  return ROLE_RULES[role] || ROLE_RULES.Constable;
}

export function applyAccessControl(filterSpec, role, stationId) {
  const rules = getRules(role);
  const merged = { ...filterSpec };
  if (rules.forceStationFilter && stationId) {
    merged.PoliceStation = stationId; 
  }
  return merged;
}
