import { describe, expect, it } from 'vitest';
import { ifNoneMatchSatisfied } from '../../src/controllers/media.controller.js';
import { detectImageMime, sanitizeMediaFilename } from '../../src/services/media.service.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0x00, 0x00, 0x00]), Buffer.from('WEBPVP8 ')]);

describe('detectImageMime', () => {
  it('recognises the three whitelisted signatures', () => {
    expect(detectImageMime(PNG)).toBe('image/png');
    expect(detectImageMime(JPEG)).toBe('image/jpeg');
    expect(detectImageMime(WEBP)).toBe('image/webp');
  });

  it('rejects SVG, HTML and truncated signatures', () => {
    expect(detectImageMime(Buffer.from('<svg onload="alert(1)"></svg>'))).toBeNull();
    expect(detectImageMime(Buffer.from('<!doctype html><p>x'))).toBeNull();
    expect(detectImageMime(PNG.subarray(0, 7))).toBeNull();
    expect(detectImageMime(Buffer.alloc(0))).toBeNull();
    expect(detectImageMime('not a buffer')).toBeNull();
  });

  it('does not accept a RIFF container that is not WebP', () => {
    const riffWave = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVEfmt ')]);
    expect(detectImageMime(riffWave)).toBeNull();
  });
});

describe('sanitizeMediaFilename', () => {
  it('keeps only the basename and strips control characters', () => {
    expect(sanitizeMediaFilename('../../etc/passwd', 'image/png')).toBe('passwd');
    expect(sanitizeMediaFilename('C:\\photos\\avatar.png', 'image/png')).toBe('avatar.png');
    expect(sanitizeMediaFilename('bad\u0000name\u001f.png', 'image/png')).toBe('badname.png');
  });

  it('falls back to a type-specific name when nothing usable remains', () => {
    expect(sanitizeMediaFilename('', 'image/png')).toBe('image.png');
    expect(sanitizeMediaFilename('   ', 'image/jpeg')).toBe('image.jpg');
    expect(sanitizeMediaFilename('../../', 'image/webp')).toBe('image.webp');
  });

  it('caps the display name at 120 characters', () => {
    const cleaned = sanitizeMediaFilename(`${'a'.repeat(150)}.png`, 'image/png');
    expect(cleaned).toHaveLength(120);
  });
});

describe('ifNoneMatchSatisfied', () => {
  const etag = '"abc123"';

  it('matches the exact tag and a weak form of it', () => {
    expect(ifNoneMatchSatisfied(etag, etag)).toBe(true);
    expect(ifNoneMatchSatisfied(`W/${etag}`, etag)).toBe(true);
  });

  it('matches an entry in a comma-separated list and the wildcard', () => {
    expect(ifNoneMatchSatisfied(`"other", ${etag}`, etag)).toBe(true);
    expect(ifNoneMatchSatisfied('*', etag)).toBe(true);
  });

  it('rejects a missing or different validator', () => {
    expect(ifNoneMatchSatisfied(undefined, etag)).toBe(false);
    expect(ifNoneMatchSatisfied('"other"', etag)).toBe(false);
    expect(ifNoneMatchSatisfied('', etag)).toBe(false);
  });
});
