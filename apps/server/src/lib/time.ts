/** Current time as an ISO 8601 string (what Burrow stores and returns). */
export const nowIso = (): string => new Date().toISOString();

/** Promise-based sleep. */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
