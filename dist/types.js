/**
 * Shared types for the Compat Guard check pipeline.
 *
 * Level ordering matters: aggregate() takes the maximum over all findings.
 * UNKNOWN is deliberately NOT part of the ordering — it is tracked separately so a
 * single "could not verify" never inflates a PASS into a risk, and never hides one.
 */
/** Severity used for ordering/aggregation only. */
export const LEVEL_ORDER = {
    LOW: 0,
    MEDIUM: 1,
    HIGH: 2,
    BLOCKER: 3,
};
