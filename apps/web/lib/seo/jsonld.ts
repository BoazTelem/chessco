import { brand } from '@chessco/ui';
import type { FederationPlayer } from './player-fetch';
import { toPlayerSlug } from './slug';

const ORIGIN = (process.env.NEXT_PUBLIC_APP_URL ?? `https://${brand.domain}`).replace(/\/$/, '');

type JsonLdObject = Record<string, unknown>;

/**
 * Schema.org Person for a federation-rated chess player.
 * Omits null/undefined fields so the rendered payload stays clean for
 * Google's Rich Results Test.
 */
export function personJsonLd(p: FederationPlayer): JsonLdObject {
  const standardLabel = `${p.federation_id} Standard`;
  const rapidLabel = `${p.federation_id} Rapid`;
  const blitzLabel = `${p.federation_id} Blitz`;

  const additionalProperty = [
    p.rating_standard != null
      ? { '@type': 'PropertyValue', name: standardLabel, value: p.rating_standard }
      : null,
    p.rating_rapid != null
      ? { '@type': 'PropertyValue', name: rapidLabel, value: p.rating_rapid }
      : null,
    p.rating_blitz != null
      ? { '@type': 'PropertyValue', name: blitzLabel, value: p.rating_blitz }
      : null,
  ].filter(Boolean);

  const sameAs =
    p.federation_id === 'FIDE'
      ? [`https://ratings.fide.com/profile/${p.federation_player_id}`]
      : undefined;

  const obj: JsonLdObject = {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: p.name,
    identifier: `${p.federation_id}:${p.federation_player_id}`,
    url: `${ORIGIN}/p/${toPlayerSlug(p)}`,
  };
  if (p.title) obj.award = p.title;
  if (p.country) obj.nationality = p.country;
  if (p.birth_year) obj.birthDate = String(p.birth_year);
  if (sameAs) obj.sameAs = sameAs;
  if (additionalProperty.length) obj.additionalProperty = additionalProperty;

  return obj;
}

export function organizationJsonLd(): JsonLdObject {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: brand.name,
    url: ORIGIN,
    logo: `${ORIGIN}/icon.svg`,
    description: brand.description,
  };
}

export function websiteJsonLd(): JsonLdObject {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: brand.name,
    url: ORIGIN,
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${ORIGIN}/scout?q={search_term_string}`,
      },
      'query-input': 'required name=search_term_string',
    },
  };
}
