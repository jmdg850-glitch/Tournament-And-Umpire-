export function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

export function createBatch() {
  const upserts = {};
  const deletes = {};
  return {
    upsert(table, row) {
      if (!row?.id) throw httpError(500, "INTERNAL", `upsert ${table} requires id`);
      (upserts[table] ||= []).push(row);
    },
    delete(table, id) {
      (deletes[table] ||= []).push(id);
    },
    payload() {
      const body = { upserts };
      if (Object.keys(deletes).length) body.deletes = deletes;
      return body;
    },
  };
}

export async function applyBatch(admin, batch) {
  const payload = batch.payload();
  const { data, error } = await admin.rpc("apply_official_writes", { payload });
  if (error) {
    throw httpError(500, "WRITE_FAILED", error.message);
  }
  return data;
}

export function nowIso() {
  return new Date().toISOString();
}

export function uuid() {
  return crypto.randomUUID();
}
