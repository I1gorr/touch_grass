// Minimal in-memory stand-in for a mongodb Db (from the data track), extended for
// this server: bulkWrite of guarded upserts (with Mongo-style duplicate-key
// errors), countDocuments with $in/$ne, and db.command({ping}) for /healthz.
export function createFakeDb() {
  const data = new Map();
  const get = (name) => data.get(name) ?? data.set(name, new Map()).get(name);
  return {
    data,
    async command() {
      return { ok: 1 };
    },
    collection(name) {
      const docs = get(name);
      return {
        async createIndex() {},
        async insertOne(doc) {
          if (docs.has(doc._id)) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
          docs.set(doc._id, { ...doc });
          return { insertedId: doc._id };
        },
        // Supports the filters the API uses: equality, $gte/$lte and $in.
        find(filter) {
          const ok = (doc) =>
            Object.entries(filter).every(([k, cond]) => {
              const v = doc[k];
              if (cond !== null && typeof cond === 'object') {
                if ('$in' in cond && !cond.$in.includes(v)) return false;
                if ('$gte' in cond && !(v >= cond.$gte)) return false;
                if ('$lte' in cond && !(v <= cond.$lte)) return false;
                return true;
              }
              return v === cond;
            });
          return { toArray: async () => [...docs.values()].filter(ok).map((d) => ({ ...d })) };
        },
        async countDocuments(filter) {
          return [...docs.values()].filter((doc) =>
            Object.entries(filter).every(([k, cond]) => {
              const v = doc[k];
              if (cond !== null && typeof cond === 'object') {
                if ('$in' in cond && !cond.$in.includes(v)) return false;
                if ('$ne' in cond && v === cond.$ne) return false;
                return true;
              }
              return v === cond;
            }),
          ).length;
        },
        async deleteMany(filter) {
          const matches = [...docs.entries()].filter(([, doc]) =>
            Object.entries(filter).every(([k, cond]) => {
              const v = doc[k];
              if (cond !== null && typeof cond === 'object') {
                if ('$in' in cond && !cond.$in.includes(v)) return false;
                return true;
              }
              return v === cond;
            }),
          );
          for (const [id] of matches) docs.delete(id);
          return { deletedCount: matches.length };
        },
        // Unordered bulk of guarded upserts; duplicate keys reported like the driver does.
        async bulkWrite(ops) {
          let upsertedCount = 0;
          let modifiedCount = 0;
          const writeErrors = [];
          for (const [index, op] of ops.entries()) {
            try {
              const r = await this.updateOne(op.updateOne.filter, op.updateOne.update);
              upsertedCount += r.upsertedCount;
              modifiedCount += r.modifiedCount;
            } catch (e) {
              if (e.code !== 11000) throw e;
              writeErrors.push({ code: 11000, index });
            }
          }
          const result = { upsertedCount, modifiedCount, matchedCount: modifiedCount };
          if (writeErrors.length) throw Object.assign(new Error('E11000 duplicate key'), { writeErrors, result });
          return result;
        },
        async updateOne(filter, update) {
          const existing = docs.get(filter._id);
          const matches = existing && existing.deviceId === filter.deviceId && existing.updated_at < filter.updated_at.$lt;
          if (matches) {
            Object.assign(existing, update.$set);
            return { modifiedCount: 1, upsertedCount: 0 };
          }
          if (existing) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
          docs.set(filter._id, { _id: filter._id, ...update.$set });
          return { modifiedCount: 0, upsertedCount: 1 };
        },
      };
    },
  };
}
