import type { MetadataRoute } from 'next';
import { brand } from '@chessco/ui';
import { federationChunk, getChunkCounts, platformChunk } from '@/lib/seo/sitemap-source';
import { getFederations } from '@/lib/scout/federations';

const ORIGIN = (process.env.NEXT_PUBLIC_APP_URL ?? `https://${brand.domain}`).replace(/\/$/, '');

// Each chunk is up to 50k URLs. FIDE+ICF ~762k -> ~16 chunks; platform
// ~106k -> ~3 chunks. Numeric `id` ranges (0=static, 100+=fed, 200+=plat)
// keep the chunk-class identifiable in URLs (/sitemap/100.xml).
export const revalidate = 86400;
export const maxDuration = 60;

const STATIC_PATHS = [
  { path: '/', priority: 1.0, changeFrequency: 'daily' as const },
  { path: '/scout', priority: 0.9, changeFrequency: 'daily' as const },
  { path: '/prepare', priority: 0.9, changeFrequency: 'daily' as const },
  { path: '/practice', priority: 0.7, changeFrequency: 'daily' as const },
  { path: '/benchmarks', priority: 0.4, changeFrequency: 'weekly' as const },
  { path: '/trust', priority: 0.3, changeFrequency: 'monthly' as const },
  { path: '/privacy', priority: 0.3, changeFrequency: 'monthly' as const },
  { path: '/terms', priority: 0.3, changeFrequency: 'monthly' as const },
];

export async function generateSitemaps(): Promise<Array<{ id: number }>> {
  const { fedChunks, platChunks } = await getChunkCounts();
  const ids: number[] = [0];
  for (let i = 0; i < fedChunks; i++) ids.push(100 + i);
  for (let i = 0; i < platChunks; i++) ids.push(200 + i);
  return ids.map((id) => ({ id }));
}

export default async function sitemap({ id }: { id: number }): Promise<MetadataRoute.Sitemap> {
  if (id === 0) {
    const now = new Date();
    const feds = await getFederations();
    const staticEntries: MetadataRoute.Sitemap = STATIC_PATHS.map((p) => ({
      url: `${ORIGIN}${p.path}`,
      lastModified: now,
      changeFrequency: p.changeFrequency,
      priority: p.priority,
    }));
    // Per-federation roster pages (~207 entries as of Phase 0 W7 expansion).
    // Active federations get higher priority; inactive ones still index because
    // their FIDE-slice page contains real player data.
    const federationEntries: MetadataRoute.Sitemap = feds.map((f) => ({
      url: `${ORIGIN}/scout/federation/${f.code}`,
      lastModified: now,
      changeFrequency: 'monthly' as const,
      priority: f.active ? 0.8 : 0.5,
    }));
    return [...staticEntries, ...federationEntries];
  }

  if (id >= 200) {
    const entries = await platformChunk(id - 200, ORIGIN);
    return entries.map((e) => ({
      url: e.url,
      lastModified: e.lastModified,
      changeFrequency: 'weekly',
      priority: 0.6,
    }));
  }

  const entries = await federationChunk(id - 100, ORIGIN);
  return entries.map((e) => ({
    url: e.url,
    lastModified: e.lastModified,
    changeFrequency: 'monthly',
    priority: 0.5,
  }));
}
