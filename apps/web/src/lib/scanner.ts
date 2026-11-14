import jsQR from 'jsqr';

interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
declare global {
  interface Window {
    BarcodeDetector?: new (opts: { formats: string[] }) => BarcodeDetectorLike;
  }
}

export interface Scanner {
  stop(): void;
}

/**
 * Reads QR codes from the camera. Uses the browser's own BarcodeDetector where there is one
 * (fast, native) and falls back to jsQR on a canvas. Calls `onToken` for every code it sees; the
 * caller decides what to do about repeats. Rejects if the camera cannot be used (no camera, or
 * permission refused), so the page can offer typing the code instead.
 */
export async function startScanner(
  video: HTMLVideoElement,
  onToken: (token: string) => void,
): Promise<Scanner> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('no camera');
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' } },
    audio: false,
  });
  video.srcObject = stream;
  video.setAttribute('playsinline', 'true');
  await video.play();

  const detector = window.BarcodeDetector
    ? new window.BarcodeDetector({ formats: ['qr_code'] })
    : null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    if (video.readyState >= 2 && video.videoWidth > 0) {
      try {
        if (detector) {
          const found = await detector.detect(video);
          if (found[0]?.rawValue) onToken(found[0].rawValue);
        } else if (ctx) {
          const scale = Math.min(1, 640 / video.videoWidth);
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
          if (code?.data) onToken(code.data);
        }
      } catch {
        /* a frame that cannot be read is skipped */
      }
    }
    setTimeout(tick, 125);
  };
  void tick();

  return {
    stop() {
      stopped = true;
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
  };
}
