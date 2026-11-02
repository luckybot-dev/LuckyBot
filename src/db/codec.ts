import sharp, { type Sharp } from 'sharp';

import { createCodec } from '../unified-api/codec';

interface SharpEncoded {
  base64: string;
  format: string;
}

const isSharp = (v: unknown): v is Sharp =>
  typeof v === 'object' && v !== null
  && typeof (v as { toBuffer?: unknown }).toBuffer === 'function'
  && typeof (v as { metadata?: unknown }).metadata === 'function';

export const codec = createCodec();

// Stored images are bounded the same way sent ones are. `sharpToEncoded`
// (src/unified-api/shared.ts) already downscales and JPEG-encodes at the wire
// boundary, but that happens on the way *out*; without this, `toBuffer()`
// persisted the untouched source. A `read_image(detail="high")` result is a
// 1024px PNG, so single turn responses reached 2.6 MB — 38 such rows were 41 MB
// of a 47 MB table, re-read and re-serialized on every wake-up that kept one in
// context.
const STORED_MAX_EDGE = 1024;
const STORED_JPEG_QUALITY = 80;

codec.register<Sharp, SharpEncoded>({
  tag: 'sharp',
  isApplicable: isSharp,
  serialize: async img => {
    // Flatten alpha onto white because JPEG has no transparency; without it
    // sharp rejects the encode rather than silently dropping the channel.
    const buf = await img
      .clone()
      .resize({ width: STORED_MAX_EDGE, height: STORED_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: STORED_JPEG_QUALITY })
      .toBuffer();
    return { base64: buf.toString('base64'), format: 'jpeg' };
  },
  deserialize: async v => sharp(Buffer.from(v.base64, 'base64')),
});
