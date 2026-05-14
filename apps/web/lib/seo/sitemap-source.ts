/**
 * Cookieless anon enumerators for the chunked /sitemap.xml.
 *
 * PostgREST defaults max-rows to 1000, so each 50k-URL sitemap chunk
 * pages internally with 50 sub-queries of 1000 rows. Sorted by `id` for
 * a stable cursor. Mirrors the anon-client pattern in lib/index-stats.ts.
 */
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { toPlayerSlug } from './slug';

export const CHUNK_SIZE = 50_000;
const PAGE_SIZE = 1_000;

type FedRow = {
  id: string;
  federation_id: string;
  federation_player_id: string;
  name: string;
  last_updated_at: string;
};

type PlatRow = {
  platform: 'lichess' | 'chess.com';
  handle: string;
  last_seen_at: string;
};

export type SitemapEntry = {
  url: string;
  lastModified: Date;
};

function anon() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createSupabaseClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function countFederation(): Promise<number> {
  const sb = anon();
  if (!sb) return 0;
  const { count } = await sb.from('federation_players').select('*', { count: 'exact', head: true });
  return count ?? 0;
}

async function countPlatform(): Promise<number> {
  const sb = anon();
  if (!sb) return 0;
  const { count } = await sb.from('platform_players').select('*', { count: 'exact', head: true });
  return count ?? 0;
}

export async function getChunkCounts(): Promise<{
  federation: number;
  platform: number;
  fedChunks: number;
  platChunks: number;
}> {
  const [federation, platform] = await Promise.all([countFederation(), countPlatform()]);
  return {
    federation,
    platform,
    fedChunks: Math.max(1, Math.ceil(federation / CHUNK_SIZE)),
    platChunks: Math.max(1, Math.ceil(platform / CHUNK_SIZE)),
  };
}

export async function federationChunk(chunkIndex: number, origin: string): Promise<SitemapEntry[]> {
  const sb = anon();
  if (!sb) return [];

  const out: SitemapEntry[] = [];
  const baseOffset = chunkIndex * CHUNK_SIZE;

  for (let i = 0; i < CHUNK_SIZE; i += PAGE_SIZE) {
    const from = baseOffset + i;
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await sb
      .from('federation_players')
      .select('id, federation_id, federation_player_id, name, last_updated_at')
      .order('id', { ascending: true })
      .range(from, to);

    if (error || !data || data.length === 0) break;

    for (const row of data as FedRow[]) {
      out.push({
        url: `${origin}/p/${toPlayerSlug(row)}`,
        lastModified: new Date(row.last_updated_at),
      });
    }

    if (data.length < PAGE_SIZE) break;
  }

  return out;
}

export async function platformChunk(chunkIndex: number, origin: string): Promise<SitemapEntry[]> {
  const sb = anon();
  if (!sb) return [];

  const out: SitemapEntry[] = [];
  const baseOffset = chunkIndex * CHUNK_SIZE;

  for (let i = 0; i < CHUNK_SIZE; i += PAGE_SIZE) {
    const from = baseOffset + i;
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await sb
      .from('platform_players')
      .select('platform, handle, last_seen_at')
      .order('id', { ascending: true })
      .range(from, to);

    if (error || !data || data.length === 0) break;

    for (const row of data as PlatRow[]) {
      const slug = row.platform === 'lichess' ? 'lichess' : 'chesscom';
      out.push({
        url: `${origin}/prepare/${slug}/${encodeURIComponent(row.handle)}`,
        lastModified: new Date(row.last_seen_at),
      });
    }

    if (data.length < PAGE_SIZE) break;
  }

  return out;
}
