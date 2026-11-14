import QRCode from 'qrcode';

/** A real QR code for `value`, drawn as SVG rectangles (no HTML injected). */
export function Qr({
  value,
  size,
  label,
  ink = '#0D0A10',
}: {
  value: string;
  size?: number;
  label: string;
  ink?: string;
}) {
  const qr = QRCode.create(value, { errorCorrectionLevel: 'L' });
  const n = qr.modules.size;
  const cells: string[] = [];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) if (qr.modules.get(x, y)) cells.push(`M${x} ${y}h1v1h-1z`);
  return (
    <svg
      width={size}
      height={size}
      viewBox={`-2 -2 ${n + 4} ${n + 4}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <path d={cells.join('')} fill={ink} />
    </svg>
  );
}
