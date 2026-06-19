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

const enc = encodeURIComponent;
const qs = (params: Record<string, string | undefined>): string => {
  const pairs = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`);
  return pairs.length ? `?${pairs.join("&")}` : "";
};

export const listConfigs = (owner: string, cursor?: string) =>
  get<Page<Row>>(`/configs${qs({ owner, cursor })}`);
export const getConfig = (id: string) => get<Row>(`/configs/${enc(id)}`);
export const getConfigSummary = (id: string) => get<Row>(`/configs/${enc(id)}/summary`);
export const listSplits = (id: string, cursor?: string) =>
  get<Page<Row>>(`/configs/${enc(id)}/splits${qs({ cursor })}`);
export const listMutations = (id: string, cursor?: string) =>
  get<Page<Row>>(`/configs/${enc(id)}/mutations${qs({ cursor })}`);
export const listEarnings = (addr: string, cursor?: string) =>
  get<Page<Row>>(`/collaborators/${enc(addr)}/earnings${qs({ cursor })}`);
export const listWithdrawals = (vaultId: string, cursor?: string) =>
  get<Page<Row>>(`/vaults/${enc(vaultId)}/withdrawals${qs({ cursor })}`);
