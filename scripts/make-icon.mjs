/**
 * Generates build/icon.ico for the Windows installer and taskbar.
 *
 * Written by hand with zlib rather than pulling in an image library: the icon is a
 * few simple shapes, and this keeps the dependency list at three packages.
 *
 * Run with: node scripts/make-icon.mjs
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SIZE = 256
const SS = 4 // supersample factor, downsampled at the end for smooth edges
const N = SIZE * SS

/**
 * Deliberately NOT a compass on a blue circle — that reads as Safari. The mark is a
 * lens with a rising bar chart inside it: searching, plus career progression. The
 * off-centre lens and diagonal handle break the symmetry that made the old one
 * look like a browser icon, and the indigo separates it further.
 */
const BRAND = [79, 70, 229] // #4f46e5 indigo
const WHITE = [255, 255, 255]

/** Signed distance to a rounded rectangle centred at (ox, oy). */
function roundedRectSDF(x, y, ox, oy, halfW, halfH, radius) {
  const dx = Math.abs(x - ox) - (halfW - radius)
  const dy = Math.abs(y - oy) - (halfH - radius)
  const ax = Math.max(dx, 0)
  const ay = Math.max(dy, 0)
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(dx, dy), 0) - radius
}

/** Signed distance to a thick line segment with rounded caps (the lens handle). */
function capsuleSDF(px, py, ax, ay, bx, by, radius) {
  const vx = bx - ax
  const vy = by - ay
  const wx = px - ax
  const wy = py - ay
  const len2 = vx * vx + vy * vy
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2))
  const cx = ax + vx * t
  const cy = ay + vy * t
  return Math.hypot(px - cx, py - cy) - radius
}

// --- render at N×N ---------------------------------------------------------
const buf = new Uint8Array(N * N * 4)

const cx = N / 2
const cy = N / 2

// Lens sits up and left of centre, leaving room for the handle bottom-right.
const lensX = -N * 0.05
const lensY = -N * 0.05
const ringOuter = N * 0.275
const ringInner = N * 0.213

// Handle runs out from the lens edge at 45°. It starts level with the ring's outer
// edge so its rounded cap is hidden under the ring instead of bulging into the lens.
const handleFrom = N * 0.3
const handleTo = N * 0.45
const handleR = N * 0.055
const diag = Math.SQRT1_2

// Three bars inside the lens, rising left to right.
const barHalfW = N * 0.028
const barGap = N * 0.077
const barBase = lensY + N * 0.115
const barHeights = [N * 0.08, N * 0.135, N * 0.19]
const barRadius = N * 0.012

for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const px = x - cx + 0.5
    const py = y - cy + 0.5
    const i = (y * N + x) * 4

    // Background: rounded square.
    if (roundedRectSDF(px, py, 0, 0, N * 0.5, N * 0.5, N * 0.235) > 0) {
      buf[i + 3] = 0
      continue
    }

    let [r, g, b] = BRAND

    // Handle first, so the lens ring paints over its inner end.
    const handle = capsuleSDF(
      px,
      py,
      lensX + handleFrom * diag,
      lensY + handleFrom * diag,
      lensX + handleTo * diag,
      lensY + handleTo * diag,
      handleR
    )
    if (handle <= 0) [r, g, b] = WHITE

    // Lens ring.
    const dist = Math.hypot(px - lensX, py - lensY)
    if (dist <= ringOuter && dist >= ringInner) [r, g, b] = WHITE

    // Bar chart inside the lens.
    if (dist < ringInner) {
      for (let bar = 0; bar < 3; bar++) {
        const bx = lensX + (bar - 1) * barGap
        const h = barHeights[bar]
        const by = barBase - h / 2
        if (roundedRectSDF(px, py, bx, by, barHalfW, h / 2, barRadius) <= 0) {
          ;[r, g, b] = WHITE
        }
      }
    }

    buf[i] = r
    buf[i + 1] = g
    buf[i + 2] = b
    buf[i + 3] = 255
  }
}

// --- box-downsample to SIZE×SIZE (this is where the anti-aliasing comes from)
const out = Buffer.alloc(SIZE * SIZE * 4)
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0
    let g = 0
    let b = 0
    let a = 0
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * N + (x * SS + sx)) * 4
        const alpha = buf[i + 3] / 255
        r += buf[i] * alpha
        g += buf[i + 1] * alpha
        b += buf[i + 2] * alpha
        a += buf[i + 3]
      }
    }
    const n = SS * SS
    const aAvg = a / n
    const norm = aAvg > 0 ? aAvg / 255 : 1
    const o = (y * SIZE + x) * 4
    out[o] = Math.round(r / n / norm)
    out[o + 1] = Math.round(g / n / norm)
    out[o + 2] = Math.round(b / n / norm)
    out[o + 3] = Math.round(aAvg)
  }
}

// --- encode PNG ------------------------------------------------------------
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0)
  return Buffer.concat([len, body, crc])
}

let crcTable = null
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c
    }
  }
  let c = -1
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c ^ -1
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // colour type: RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0 // filter: none
  out.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

// --- wrap in an ICO container (Vista+ accepts a PNG payload directly) -------
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(1, 4) // one image

const entry = Buffer.alloc(16)
entry[0] = 0 // width 256 is encoded as 0
entry[1] = 0 // height 256 is encoded as 0
entry[2] = 0 // palette size
entry[3] = 0 // reserved
entry.writeUInt16LE(1, 4) // colour planes
entry.writeUInt16LE(32, 6) // bits per pixel
entry.writeUInt32LE(png.length, 8)
entry.writeUInt32LE(22, 12) // offset to the image data

mkdirSync(join(root, 'build'), { recursive: true })
writeFileSync(join(root, 'build', 'icon.ico'), Buffer.concat([header, entry, png]))
console.log(`build/icon.ico written (${png.length} bytes of PNG payload)`)
