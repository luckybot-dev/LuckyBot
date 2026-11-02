import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { codec } from './codec';

// A `read_image(detail="high")` result arrives as a 1024px PNG. Storing it
// untouched produced single turn responses of 2.6 MB; 38 such rows were 41 MB
// of a 47 MB table and got re-serialized on every wake-up that kept one in
// context. The stored form must be bounded like the wire form.
// A photographic gradient with fine texture: PNG cannot exploit it the way it
// exploits flat colour, and JPEG compresses it well — the shape of a real
// screenshot or photo, which is what `read_image` actually receives.
//
// Deliberately not pure noise: noise makes PNG *smaller* than JPEG (measured:
// 21 KB PNG vs 404 KB JPEG at 1024px), so it would invert the assertion
// without telling us anything about real media.
const pngFixture = async (width: number, height: number): Promise<sharp.Sharp> => {
  const channels = 3;
  const buf = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      // Smooth ramps plus a low-amplitude sine texture.
      const tex = Math.round(12 * Math.sin(x / 7) * Math.cos(y / 11));
      buf[o] = (x >> 2) + tex;
      buf[o + 1] = (y >> 2) + tex;
      buf[o + 2] = ((x + y) >> 3) + tex;
    }
  }
  return sharp(buf, { raw: { width, height, channels } }).png();
};

describe('codec image storage', () => {
  it('stores a 1024px image as bounded JPEG, not the original PNG', async () => {
    const source = await pngFixture(1024, 1024);
    const encoded = await codec.stringify({ image: source });
    const parsed = JSON.parse(encoded) as { _: { image: { base64: string; format: string } } };

    expect(parsed._.image.format).toBe('jpeg');
    // Base64 inflates by 4/3; 400 KB of base64 is ~300 KB of JPEG, far below
    // the ~1 MB a lossless 1024px PNG needed.
    expect(parsed._.image.base64.length).toBeLessThan(400_000);
    expect(encoded.length).toBeLessThan(500_000);
  });

  it('downscales images larger than the stored edge', async () => {
    const source = await pngFixture(2048, 2048);
    const encoded = await codec.stringify({ image: source });
    const parsed = JSON.parse(encoded) as { _: { image: { base64: string } } };

    const roundTripped = await codec.parse(encoded) as { image: sharp.Sharp };
    const meta = await roundTripped.image.metadata();
    expect(meta.width).toBeLessThanOrEqual(1024);
    expect(meta.height).toBeLessThanOrEqual(1024);
    expect(parsed._.image.base64.length).toBeLessThan(400_000);
  });

  it('flattens alpha so a transparent image still encodes', async () => {
    const source = sharp({
      create: { width: 512, height: 512, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).png();
    const encoded = await codec.stringify({ image: source });
    const parsed = JSON.parse(encoded) as { _: { image: { format: string } } };
    expect(parsed._.image.format).toBe('jpeg');
  });

  it('leaves a small image readable through a round trip', async () => {
    const source = await pngFixture(64, 64);
    const encoded = await codec.stringify({ image: source });
    const decoded = await codec.parse(encoded) as { image: sharp.Sharp };
    const meta = await decoded.image.metadata();
    expect(meta.width).toBe(64);
    expect(meta.height).toBe(64);
  });
});
