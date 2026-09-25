"""Decode C4 engine .tex files (resource header, texture header, mipmaps; RLE or DXT) to PNG."""
import struct, sys, zlib

def fourcc(v): return struct.pack('>I', v).decode('latin1')

def read_tex(path):
    d = open(path, 'rb').read()
    endian, header_size, count = struct.unpack_from('<iIi', d, 0)
    th = 12
    f = struct.unpack_from('<15I', d, th)
    ttype, flags, csem, asem, fmt, w, h, depth, w0, w1, w2, mipcount, mipoff, auxsize, auxoff = f
    info = dict(type=fourcc(ttype), format=fourcc(fmt), w=w, h=h, depth=depth, mips=mipcount, flags=hex(flags))
    md = th + mipoff
    img_off, img_size, chain, comp = struct.unpack_from('<iIII', d, md)
    info['compression'] = fourcc(comp) if comp else 'none'
    data = d[md + img_off: md + img_off + img_size]
    n = w * h * depth
    if fourcc(fmt) == 'S3TC':
        if comp != 0: raise SystemExit(f'RLE-compressed S3TC not supported: {info}')
        dxt5 = img_size >= w * h  # DXT1 is 0.5 byte/pixel, DXT5 is 1 byte/pixel
        info['s3tc'] = 'DXT5' if dxt5 else 'DXT1'
        return info, w, h, decode_dxt(data, w, h, dxt5)
    if fourcc(fmt) not in ('RGBA', 'BGRA', 'ARGB'):
        raise SystemExit(f'unsupported format {info}')
    out = bytearray(n * 4)
    if comp == 0:
        for i in range(n):
            b, g, r, a = data[i*4:i*4+4]; out[i*4:i*4+4] = bytes((r, g, b, a))
    else:
        a_i, p = 0, 0
        while a_i < n:
            c = data[p]; p += 1
            count = (c & 0x7F) + 1
            if c & 0x80:
                b, g, r, al = data[p:p+4]; p += 4
                px = bytes((r, g, b, al))
                for _ in range(count):
                    out[a_i*4:a_i*4+4] = px; a_i += 1
            else:
                for _ in range(count):
                    b, g, r, al = data[p:p+4]; p += 4
                    out[a_i*4:a_i*4+4] = bytes((r, g, b, al)); a_i += 1
    return info, w, h, out

def _565(c):
    r, g, b = (c >> 11) & 31, (c >> 5) & 63, c & 31
    return (r << 3 | r >> 2, g << 2 | g >> 4, b << 3 | b >> 2)

def decode_dxt(data, w, h, dxt5):
    out = bytearray(w * h * 4)
    bs = 16 if dxt5 else 8
    p = 0
    for by in range(0, h, 4):
        for bx in range(0, w, 4):
            alpha = [255] * 16
            if dxt5:
                a0, a1 = data[p], data[p + 1]
                bits = int.from_bytes(data[p + 2:p + 8], 'little')
                pal = [a0, a1] + ([((6 - i) * a0 + (i + 1) * a1) // 7 for i in range(6)] if a0 > a1 else [((4 - i) * a0 + (i + 1) * a1) // 5 for i in range(4)] + [0, 255])
                alpha = [pal[(bits >> (3 * i)) & 7] for i in range(16)]
                q = p + 8
            else:
                q = p
            c0, c1 = int.from_bytes(data[q:q + 2], 'little'), int.from_bytes(data[q + 2:q + 4], 'little')
            idx = int.from_bytes(data[q + 4:q + 8], 'little')
            k0, k1 = _565(c0), _565(c1)
            if c0 > c1 or dxt5:
                cols = [k0, k1, tuple((2 * a + b) // 3 for a, b in zip(k0, k1)), tuple((a + 2 * b) // 3 for a, b in zip(k0, k1))]
            else:
                cols = [k0, k1, tuple((a + b) // 2 for a, b in zip(k0, k1)), (0, 0, 0)]
            for i in range(16):
                x, y = bx + (i & 3), by + (i >> 2)
                if x < w and y < h:
                    o = (y * w + x) * 4
                    out[o:o + 4] = bytes(cols[(idx >> (2 * i)) & 3] + (alpha[i],))
            p += bs
    return out

def write_png(path, w, h, rgba, keep_alpha=False):
    ch = 4 if keep_alpha else 3
    rows = b''.join(b'\x00' + (bytes(rgba[y*w*4:(y+1)*w*4]) if keep_alpha else bytes(b for i, b in enumerate(rgba[y*w*4:(y+1)*w*4]) if i % 4 != 3)) for y in range(h))
    def chunk(t, x): return struct.pack('>I', len(x)) + t + x + struct.pack('>I', zlib.crc32(t + x) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6 if keep_alpha else 2, 0, 0, 0)
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(rows, 9)) + chunk(b'IEND', b''))

if __name__ == '__main__':
    for src, dst in zip(sys.argv[1::2], sys.argv[2::2]):
        info, w, h, px = read_tex(src)
        alpha = sorted(set(px[3::4]))
        info['alpha'] = f'{alpha[0]}..{alpha[-1]}' if len(alpha) > 1 else alpha[0]
        write_png(dst, w, h, px)
        print(src.split('/')[-1], info)
