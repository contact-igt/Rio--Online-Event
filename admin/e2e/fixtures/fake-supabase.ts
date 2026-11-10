// A tiny stand-in for the Supabase query builder in the offline staff-page tests. Tables come from window.__staffData; eq() filters by
// equality; everything else (select, order, limit) is ignored. Nothing here is part of the app.
type Row = Record<string, unknown>;

declare global {
  interface Window {
    __staffData?: Record<string, Row[]>;
  }
}

export function fakeSupabase(data: Record<string, Row[]>) {
  return {
    from(table: string) {
      let rows = [...(data[table] ?? [])];
      const b = {
        select: () => b,
        order: () => b,
        limit: () => b,
        eq: (key: string, value: unknown) => {
          rows = rows.filter((r) => r[key] === value);
          return b;
        },
        maybeSingle: () => Promise.resolve({ data: rows[0] ?? null }),
        then: (ok: (v: { data: Row[] }) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve({ data: rows }).then(ok, bad),
      };
      return b;
    },
  };
}
