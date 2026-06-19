import { API_BASE_URL } from "./constants";

export type Page<T> = { data: T[]; cursor: string | null };
type Row = Record<string, unknown>;

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `REST ${res.status}`);
  }
  return (await res.json()) as T;
}

const q = (cursor?: string) => (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
const enc = encodeURIComponent;

export const listConfigs = (owner: string, cursor?: string) =>
  get<Page<Row>>(`/configs?owner=${enc(owner)}${q(cursor)}`);
export const getConfigSummary = (id: string) => get<Row>(`/configs/${enc(id)}/summary`);
export const listSplits = (id: string, cursor?: string) =>
  get<Page<Row>>(`/configs/${enc(id)}/splits?${q(cursor).slice(1)}`);
export const listMutations = (id: string, cursor?: string) =>
  get<Page<Row>>(`/configs/${enc(id)}/mutations?${q(cursor).slice(1)}`);
export const listEarnings = (addr: string, cursor?: string) =>
  get<Page<Row>>(`/collaborators/${enc(addr)}/earnings?${q(cursor).slice(1)}`);
export const listWithdrawals = (vaultId: string, cursor?: string) =>
  get<Page<Row>>(`/vaults/${enc(vaultId)}/withdrawals?${q(cursor).slice(1)}`);
