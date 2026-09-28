export function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

export function createBatch() {
  const upserts = {};
  const deletes = {};
  const expect = [];
  const precondition = [];
  return {
    upsert(table, row) {
      if (!row?.id) throw httpError(500, "INTERNAL", `upsert ${table} requires id`);
      (upserts[table] ||= []).push(row);
    },
    delete(table, id) {
      (deletes[table] ||= []).push(id);
    },
    // The `matches` row this batch rewrites must still be the version the
    // handler read (checked under a row lock in apply_official_writes,
    // migration 0018). A mismatch means another command changed it in
    // between: STALE_WRITE, and the command is re-run on fresh state.
    expectMatch(match) {
      if (match?.id && match.updated_at) expect.push({ table: "matches", id: match.id, updated_at: match.updated_at });
    },
    // A client-supplied "I last saw this version" check: STALE_STATE (409).
    preconditionMatch(id, updatedAt) {
      if (id && updatedAt) precondition.push({ table: "matches", id, updated_at: updatedAt });
    },
    payload() {
      const body = { upserts };
      if (Object.keys(deletes).length) body.deletes = deletes;
      if (expect.length) body.expect = expect;
      if (precondition.length) body.precondition = precondition;
      return body;
    },
  };
}

const SEQ_UNIQUE_CONSTRAINT = "score_events_match_id_seq_key";

// The unique constraint/index named in a Postgres unique-violation message.
function violatedConstraint(error) {
  const m = /unique constraint "([^"]+)"/i.exec(String(error?.message || ""));
  return m ? m[1] : null;
}

// Maps an apply_official_writes failure to the command API's error contract.
// Public messages never contain SQL text, constraint names or values; the
// details the handlers need are kept on non-serialized properties
// (`constraint`, `dbCode`, `current`).
export function writeError(error) {
  const dbCode = String(error?.code || "");
  const constraint = violatedConstraint(error);
  const make = (status, code, message) => Object.assign(httpError(status, code, message), { dbCode, constraint, current: error?.details || null });
  if (dbCode === "TC001") return make(409, "COMMAND_ALREADY_APPLIED", "This command was already applied.");
  if (dbCode === "TC412") return make(409, "STALE_WRITE", "The data changed while this command was running.");
  if (dbCode === "TC409") return make(409, "STALE_STATE", "This was changed on another device since you last loaded it. Reload and try again.");
  if (dbCode === "23505" || (!dbCode && constraint)) {
    if (constraint === SEQ_UNIQUE_CONSTRAINT) return make(409, "SEQ_CONFLICT", "Another score was recorded at the same point. Reload the match.");
    return make(409, "CONFLICT", "This conflicts with a change that was just made. Reload and try again.");
  }
  if (dbCode === "23503") return make(409, "CONFLICT", "Something this change refers to was changed or removed. Reload and try again.");
  if (["23502", "23514", "22P02", "22023", "22003", "22007", "22008"].includes(dbCode)) {
    return make(400, "INVALID_COMMAND", "The request contained an invalid value.");
  }
  if (["40001", "40P01", "55P03", "57014", "53300", "08000", "08003", "08006"].includes(dbCode)) {
    return make(503, "RETRY_LATER", "The server is busy. Please retry.");
  }
  return make(500, "WRITE_FAILED", "The change could not be saved. Please retry.");
}

export function isUniqueViolation(err) {
  return err?.dbCode === "23505" || (err?.status === 409 && Boolean(err?.constraint));
}

export async function applyBatch(admin, batch) {
  const payload = batch.payload();
  const { data, error } = await admin.rpc("apply_official_writes", { payload });
  if (error) throw writeError(error);
  return data;
}

export function nowIso() {
  return new Date().toISOString();
}

export function uuid() {
  return crypto.randomUUID();
}
