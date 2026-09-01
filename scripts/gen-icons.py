#!/usr/bin/env python3
"""Generates simple flat PNG app icons (no external deps: raw PNG via zlib)."""
import struct
import zlib
import os

BG = (15, 23, 42)       # slate-900
FG = (255, 255, 255)
ACCENT = (56, 189, 248)  # sky-400

def rounded_rect_mask(w, h, r):
    def inside(x, y):
        cx = min(max(x, r), w - 1 - r)
        cy = min(max(y, r), h - 1 - r)
        dx, dy = x - cx, y - cy
        return dx * dx + dy * dy <= r * r
    return inside

def make_icon(size, corner_ratio=0.22):
    w = h = size
    r = int(size * corner_ratio)
    px = [[BG for _ in range(w)] for _ in range(h)]
    mask = rounded_rect_mask(w, h, r)

    # train body: rounded rect centered, plus two wheels + a horizon line (rail)
    body_w = int(w * 0.52)
    body_h = int(h * 0.34)
    body_x0 = (w - body_w) // 2
    body_y0 = int(h * 0.30)
    body_r = int(body_h * 0.35)
    body_mask = rounded_rect_mask(body_w, body_h, body_r)

    wheel_r = int(size * 0.05)
    wheel_y = body_y0 + body_h + wheel_r
    wheel_x1 = body_x0 + int(body_w * 0.28)
    wheel_x2 = body_x0 + int(body_w * 0.72)

    rail_y = wheel_y + int(size * 0.10)
    rail_h = max(2, int(size * 0.02))

    for y in range(h):
        for x in range(w):
            if not mask(x, y):
                continue
            color = BG
            # body
            bx, by = x - body_x0, y - body_y0
            if 0 <= bx < body_w and 0 <= by < body_h and body_mask(bx, by):
                color = FG
            # wheels
            for wx in (wheel_x1, wheel_x2):
                dx, dy = x - wx, y - wheel_y
                if dx * dx + dy * dy <= wheel_r * wheel_r:
                    color = ACCENT
            # rail line
            if rail_y <= y < rail_y + rail_h and int(w * 0.18) <= x <= int(w * 0.82):
                color = ACCENT
            px[y][x] = color
    return px

def write_png(path, px):
    h = len(px)
    w = len(px[0])
    def chunk(tag, data):
        c = tag + data
        return struct.pack('!I', len(data)) + c + struct.pack('!I', zlib.crc32(c) & 0xffffffff)

    raw = bytearray()
    for row in px:
        raw.append(0)  # no filter
        for (r, g, b) in row:
            raw += bytes((r, g, b, 255))
    compressed = zlib.compress(bytes(raw), 9)

    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('!IIBBBBB', w, h, 8, 6, 0, 0, 0)
    with open(path, 'wb') as f:
        f.write(sig)
        f.write(chunk(b'IHDR', ihdr))
        f.write(chunk(b'IDAT', compressed))
        f.write(chunk(b'IEND', b''))

if __name__ == '__main__':
    out_dir = os.path.join(os.path.dirname(__file__), '..', 'icons')
    os.makedirs(out_dir, exist_ok=True)
    for size, name in [(192, 'icon-192.png'), (512, 'icon-512.png'), (180, 'apple-touch-icon.png')]:
        write_png(os.path.join(out_dir, name), make_icon(size))
        print('wrote', name)
