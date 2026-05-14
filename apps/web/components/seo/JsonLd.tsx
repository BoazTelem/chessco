/**
 * Renders a schema.org JSON-LD payload as a `<script type="application/ld+json">`
 * tag. Server component — payload is built on the server and sent to the
 * client as inert text (no JS execution). Use with builders from
 * lib/seo/jsonld.ts.
 */
export function JsonLd({ data }: { data: Record<string, unknown> | Record<string, unknown>[] }) {
  return (
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }} />
  );
}
