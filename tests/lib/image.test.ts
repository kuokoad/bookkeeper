import { describe, expect, it } from 'vitest';

import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  inspectImage,
} from '@/lib/image';
import { ValidationError } from '@/domain/errors';

/**
 * Real encoded images, not hand-waved bytes: a 1x1 PNG, JPEG and WebP produced
 * by actual encoders. Testing the parser against something an encoder did not
 * write would prove nothing about a file a shop owner uploads.
 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);
// RIFF/WEBP lossy (VP8 ), 1x1.
const WEBP_1X1 = Buffer.from(
  'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==',
  'base64',
);

const bytes = (buffer: Buffer): Uint8Array => new Uint8Array(buffer);

describe('recognising real images', () => {
  it('reads a PNG', () => {
    const result = inspectImage(bytes(PNG_1X1));
    expect(result.mime).toBe('image/png');
    expect(result.width).toBe(1);
    expect(result.height).toBe(1);
  });

  it('reads a JPEG', () => {
    const result = inspectImage(bytes(JPEG_1X1));
    expect(result.mime).toBe('image/jpeg');
    expect(result.width).toBe(1);
    expect(result.height).toBe(1);
  });

  it('reads a WebP', () => {
    const result = inspectImage(bytes(WEBP_1X1));
    expect(result.mime).toBe('image/webp');
    expect(result.width).toBe(1);
    expect(result.height).toBe(1);
  });

  it('reports the byte length it actually received', () => {
    expect(inspectImage(bytes(PNG_1X1)).bytes).toBe(PNG_1X1.length);
  });
});

describe('refusing what is not an image', () => {
  it('REFUSES an SVG, and says why', () => {
    // The one that matters: an SVG served from the shop's own origin runs
    // script with the viewer's session.
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    expect(() => inspectImage(bytes(svg))).toThrow(/SVG images are not accepted/i);
  });

  it('REFUSES an SVG that opens with an XML declaration', () => {
    const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(() => inspectImage(bytes(svg))).toThrow(/SVG/i);
  });

  it('REFUSES HTML dressed up as an image', () => {
    const html = Buffer.from('<html><script>alert(document.cookie)</script></html>');
    expect(() => inspectImage(bytes(html))).toThrow(ValidationError);
  });

  it('REFUSES a script whatever it is called', () => {
    // The filename and the browser's Content-Type never reach this function.
    expect(() => inspectImage(bytes(Buffer.from('#!/bin/sh\nrm -rf /')))).toThrow(ValidationError);
  });

  it('REFUSES a GIF, which is not on the accepted list', () => {
    const gif = Buffer.from('R0lGODlhAQABAAAAACw=', 'base64');
    expect(() => inspectImage(bytes(gif))).toThrow(/PNG, JPEG or WebP/i);
  });

  it('REFUSES an empty file', () => {
    expect(() => inspectImage(new Uint8Array())).toThrow(/empty/i);
  });

  it('REFUSES a PNG header with nothing behind it', () => {
    // Correct magic bytes, truncated body — the size cannot be read.
    const truncated = bytes(PNG_1X1).slice(0, 12);
    expect(() => inspectImage(truncated)).toThrow(/damaged/i);
  });
});

describe('limits', () => {
  it('REFUSES a file over the size cap', () => {
    const huge = new Uint8Array(MAX_IMAGE_BYTES + 1);
    huge.set(bytes(PNG_1X1));
    expect(() => inspectImage(huge)).toThrow(/under 1 MB/i);
  });

  it('accepts a file just under the cap', () => {
    // Padding after a complete PNG: the parser reads the header, not the tail.
    const padded = new Uint8Array(MAX_IMAGE_BYTES - 1);
    padded.set(bytes(PNG_1X1));
    expect(() => inspectImage(padded)).not.toThrow();
  });

  it('REFUSES an image with absurd dimensions', () => {
    // A handcrafted PNG header claiming to be enormous. Small file, huge
    // picture — the shape of a decompression bomb.
    const header = Buffer.from(bytes(PNG_1X1));
    header.writeUInt32BE(MAX_IMAGE_DIMENSION + 1, 16);
    header.writeUInt32BE(MAX_IMAGE_DIMENSION + 1, 20);
    expect(() => inspectImage(bytes(header))).toThrow(/pixels/i);
  });

  it('states the actual size in the refusal, so it can be acted on', () => {
    const header = Buffer.from(bytes(PNG_1X1));
    header.writeUInt32BE(9000, 16);
    header.writeUInt32BE(7000, 20);
    expect(() => inspectImage(bytes(header))).toThrow(/9000x7000/);
  });
});
