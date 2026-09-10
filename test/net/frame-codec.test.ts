import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  Direction,
  FrameDecoder,
  FrameEncoder,
  FrameError,
  MAX_PLAINTEXT_BYTES,
  ReplayError,
} from '../../src/main/net/frame-codec.js';

function pair(dir: Direction) {
  const key = new Uint8Array(randomBytes(32));
  const salt = new Uint8Array(randomBytes(4));
  return {
    enc: new FrameEncoder(key, salt, dir),
    dec: new FrameDecoder(key, salt, dir),
  };
}

describe('frame codec', () => {
  it('round-trips a sequence of messages', () => {
    const { enc, dec } = pair(Direction.ClientToServer);
    for (let i = 0; i < 5; i++) {
      const msg = Buffer.from(`frame ${i}`);
      expect(Buffer.from(dec.decode(enc.encode(msg))).toString()).toBe(
        msg.toString(),
      );
    }
  });

  it('rejects a replayed frame', () => {
    const { enc, dec } = pair(Direction.ServerToClient);
    const f0 = enc.encode(Buffer.from('a'));
    const f1 = enc.encode(Buffer.from('b'));
    dec.decode(f0);
    dec.decode(f1);
    expect(() => dec.decode(f0)).toThrow(ReplayError);
  });

  it('rejects a reordered frame', () => {
    const { enc, dec } = pair(Direction.ClientToServer);
    const f0 = enc.encode(Buffer.from('a'));
    const f1 = enc.encode(Buffer.from('b'));
    dec.decode(f1);
    expect(() => dec.decode(f0)).toThrow(ReplayError);
  });

  it('rejects a frame with the wrong direction', () => {
    const key = new Uint8Array(randomBytes(32));
    const salt = new Uint8Array(randomBytes(4));
    const enc = new FrameEncoder(key, salt, Direction.ClientToServer);
    const dec = new FrameDecoder(key, salt, Direction.ServerToClient);
    expect(() => dec.decode(enc.encode(Buffer.from('x')))).toThrow(FrameError);
  });

  it('rejects a tampered header', () => {
    const { enc, dec } = pair(Direction.ClientToServer);
    const f = enc.encode(Buffer.from('hello'));
    f[9]! ^= 0x01; // low byte of the counter
    expect(() => dec.decode(f)).toThrow();
  });

  it('rejects an oversized plaintext', () => {
    const { enc } = pair(Direction.ClientToServer);
    expect(() => enc.encode(new Uint8Array(MAX_PLAINTEXT_BYTES + 1))).toThrow(
      FrameError,
    );
  });

  it('rejects a runt frame', () => {
    const { dec } = pair(Direction.ClientToServer);
    expect(() => dec.decode(new Uint8Array(5))).toThrow(FrameError);
  });
});
