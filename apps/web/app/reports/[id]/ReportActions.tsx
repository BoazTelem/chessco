'use client';

import { useState, useTransition } from 'react';

interface Props {
  reportId: string;
  isOwner: boolean;
  hasShareToken: boolean;
  shareToken?: string | null;
}

export function ReportActions({ reportId, isOwner, hasShareToken, shareToken }: Props) {
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [tokenLive, setTokenLive] = useState(hasShareToken);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const tokenQuery = shareToken ? `?t=${encodeURIComponent(shareToken)}` : '';
  const downloadPgn = `/api/prepare/reports/${reportId}/pgn${tokenQuery}`;
  const downloadPdf = `/api/prepare/reports/${reportId}/pdf${tokenQuery}`;

  function rotateShare() {
    startTransition(async () => {
      setError(null);
      try {
        const res = await fetch(`/api/prepare/reports/${reportId}/share`, { method: 'POST' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { share_token: string; share_path: string };
        setShareUrl(`${window.location.origin}${data.share_path}`);
        setTokenLive(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  function revokeShare() {
    startTransition(async () => {
      setError(null);
      try {
        const res = await fetch(`/api/prepare/reports/${reportId}/share`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setShareUrl(null);
        setTokenLive(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={downloadPgn}
          className="rounded-md border border-border bg-card px-3 py-1.5 text-xs hover:bg-muted"
        >
          Download PGN
        </a>
        <a
          href={downloadPdf}
          className="rounded-md border border-border bg-card px-3 py-1.5 text-xs hover:bg-muted"
        >
          Download PDF
        </a>
        {isOwner ? (
          <button
            type="button"
            onClick={tokenLive ? revokeShare : rotateShare}
            disabled={pending}
            className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-500/20 disabled:opacity-50"
          >
            {pending ? '…' : tokenLive ? 'Revoke share link' : 'Create share link'}
          </button>
        ) : null}
      </div>
      {shareUrl ? (
        <p className="max-w-md break-all text-right text-xs text-muted-foreground">
          Share URL: <code>{shareUrl}</code>
        </p>
      ) : null}
      {error ? (
        <p className="text-right text-xs text-red-300">Share action failed: {error}</p>
      ) : null}
    </div>
  );
}
