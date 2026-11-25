import React, { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/** A QR code drawn as SVG in the browser (nothing is sent anywhere). Always dark on white, so phones can scan it. */
export function QrCode({ value, label, size = 184 }: { value: string; label: string; size?: number }) {
  const { total, path } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    const margin = 4;
    let d = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
    return { total: n + margin * 2, path: d };
  }, [value]);
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${total} ${total}`} width={size} height={size} shapeRendering="crispEdges" className="rounded-lg border border-border">
      <rect width={total} height={total} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
