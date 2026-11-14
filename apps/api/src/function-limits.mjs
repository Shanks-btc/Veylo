// The API function's time limits, in one place (slice W7). apps/api/build-vercel.mjs writes
// FUNCTION_MAX_DURATION_SECONDS into the deployment's .vc-config.json, and apps/api/src/hosted.ts
// stops starting work at CRON_CUTOFF_SECONDS. A test fails if the two cannot work together.
//
// Why 120 and not the 60 it was: one settlement row can make two 1Click calls (a status read, then a
// balance read that may refresh a token first), each with a 15 s timeout, so the worst a single row
// takes is about 45 s. A sweep checks the clock before every row, never inside one, so the cutoff
// plus that worst row plus a margin must fit inside the limit: 60 + 45 + 15 = 120. 120 s is well
// inside the Hobby plan's limit of 300 s (https://vercel.com/docs/functions/limitations, read
// 2026-11-13), and a larger limit also costs more if a request ever hangs, so it is not raised further.
export const FUNCTION_MAX_DURATION_SECONDS = 120;
/** The longest one sweep row can run: two 1Click calls at a 15 s timeout, plus a token refresh. */
export const SWEEP_ROW_WORST_CASE_SECONDS = 45;
/** Room for the response, the database close and a slow start. */
export const SAFETY_MARGIN_SECONDS = 15;
/** The settlement cron starts no new row after this long. */
export const CRON_CUTOFF_SECONDS = 60;
