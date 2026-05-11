/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Generates `cretif/arena_Certificate.jpg` — the background template used by
 * CertificateService.generateImage(). Run once with:
 *
 *   npx ts-node scripts/generate-cert-template.ts
 *
 * The SVG below mirrors the "Certificate of Achievement" reference design:
 * white center, navy/gold geometric corners + waves, gold inner border,
 * heavy serif title, and a gold rosette medal at the bottom.
 */

import * as fs from 'fs';
import * as path from 'path';

const sharp = require('sharp') as (input: Buffer | string) => import('sharp').Sharp;

const W = 1360;
const H = 960;

// Palette
const NAVY = '#1f2a5a';
const NAVY_DEEP = '#152043';
const GOLD = '#d4a341';
const GOLD_LIGHT = '#e8c673';
const GOLD_DARK = '#a37e23';
const INK = '#1a2856';
const SUBTLE = '#5a5e74';

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="navyG" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${NAVY_DEEP}"/>
      <stop offset="100%" stop-color="${NAVY}"/>
    </linearGradient>
    <linearGradient id="goldG" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${GOLD_DARK}"/>
      <stop offset="50%" stop-color="${GOLD_LIGHT}"/>
      <stop offset="100%" stop-color="${GOLD}"/>
    </linearGradient>
    <linearGradient id="rosette" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${GOLD_LIGHT}"/>
      <stop offset="100%" stop-color="${GOLD_DARK}"/>
    </linearGradient>
  </defs>

  <!-- Page -->
  <rect width="${W}" height="${H}" fill="#ffffff"/>

  <!-- ── Top decorative band: gold strip + navy triangles ── -->
  <rect x="0" y="0" width="${W}" height="56" fill="url(#goldG)"/>

  <!-- Top-left navy triangle wedge -->
  <polygon points="0,0 0,210 540,0" fill="url(#navyG)"/>
  <!-- Top-left gold edge accent -->
  <polygon points="60,56 540,56 60,228" fill="url(#goldG)" opacity="0.85"/>

  <!-- Top-right navy triangle wedge -->
  <polygon points="${W},0 ${W},210 ${W - 540},0" fill="url(#navyG)"/>
  <polygon points="${W - 60},56 ${W - 540},56 ${W - 60},228" fill="url(#goldG)" opacity="0.85"/>

  <!-- ── Bottom decorative waves ── -->
  <!-- Bottom-left navy wave -->
  <path d="M0,${H - 240} Q210,${H - 320} 360,${H - 240} T720,${H - 180} L720,${H} L0,${H} Z"
        fill="url(#navyG)"/>
  <!-- Bottom-left gold wave overlay -->
  <path d="M0,${H - 180} Q210,${H - 260} 360,${H - 180} T720,${H - 120} L720,${H} L0,${H} Z"
        fill="url(#goldG)" opacity="0.9"/>
  <!-- Bottom-left navy wave on top of gold (for ribbon effect) -->
  <path d="M0,${H - 120} Q210,${H - 200} 360,${H - 120} T720,${H - 60} L720,${H} L0,${H} Z"
        fill="url(#navyG)"/>

  <!-- Bottom-right (mirror) -->
  <path d="M${W},${H - 240} Q${W - 210},${H - 320} ${W - 360},${H - 240} T${W - 720},${H - 180} L${W - 720},${H} L${W},${H} Z"
        fill="url(#navyG)"/>
  <path d="M${W},${H - 180} Q${W - 210},${H - 260} ${W - 360},${H - 180} T${W - 720},${H - 120} L${W - 720},${H} L${W},${H} Z"
        fill="url(#goldG)" opacity="0.9"/>
  <path d="M${W},${H - 120} Q${W - 210},${H - 200} ${W - 360},${H - 120} T${W - 720},${H - 60} L${W - 720},${H} L${W},${H} Z"
        fill="url(#navyG)"/>

  <!-- ── Inner thin gold border with corner ornaments ── -->
  <rect x="64" y="64" width="${W - 128}" height="${H - 128}"
        fill="none" stroke="${GOLD}" stroke-width="2.5"/>
  <!-- Corner ornaments -->
  <g stroke="${GOLD}" stroke-width="3" fill="none">
    <path d="M 64,120 L 64,64 L 120,64"/>
    <path d="M ${W - 64},120 L ${W - 64},64 L ${W - 120},64"/>
    <path d="M 64,${H - 120} L 64,${H - 64} L 120,${H - 64}"/>
    <path d="M ${W - 64},${H - 120} L ${W - 64},${H - 64} L ${W - 120},${H - 64}"/>
  </g>

  <!-- ── Title: CERTIFICATE ── -->
  <text x="${W / 2}" y="240"
        text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="92" font-weight="900"
        fill="${INK}" letter-spacing="8">CERTIFICATE</text>

  <!-- Subtitle: Of Achievement -->
  <text x="${W / 2}" y="296"
        text-anchor="middle"
        font-family="Arial, sans-serif"
        font-size="26" font-weight="700"
        fill="${INK}" letter-spacing="14">OF ACHIEVEMENT</text>

  <!-- Decorative gold rule under subtitle -->
  <line x1="${W / 2 - 90}" y1="324" x2="${W / 2 + 90}" y2="324" stroke="${GOLD}" stroke-width="2"/>

  <!-- Presented-to line -->
  <text x="${W / 2}" y="380"
        text-anchor="middle"
        font-family="Arial, sans-serif"
        font-size="22" font-weight="400"
        fill="${SUBTLE}">This Certificate is Proudly Presented To</text>

  <!-- Name underline (the backend overlays the full name above this line at y=H*0.5=480) -->
  <line x1="${W / 2 - 320}" y1="510" x2="${W / 2 + 320}" y2="510" stroke="${INK}" stroke-width="2"/>

  <!-- ── Gold rosette medal at the bottom ── -->
  <g transform="translate(${W / 2}, 770)">
    <!-- Ribbons -->
    <polygon points="-22,30 -42,110 -10,86" fill="${GOLD_DARK}"/>
    <polygon points="-22,30 -10,86 12,30" fill="${GOLD}"/>
    <polygon points="22,30 42,110 10,86" fill="${GOLD_DARK}"/>
    <polygon points="22,30 10,86 -12,30" fill="${GOLD}"/>
    <!-- Spike halo -->
    <g fill="${GOLD_DARK}">
      ${Array.from({ length: 24 })
        .map((_, i) => {
          const a = (i / 24) * Math.PI * 2;
          const x1 = Math.cos(a) * 44;
          const y1 = Math.sin(a) * 44;
          const x2 = Math.cos(a) * 58;
          const y2 = Math.sin(a) * 58;
          return `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${GOLD_DARK}" stroke-width="6"/>`;
        })
        .join('\n      ')}
    </g>
    <circle r="48" fill="url(#rosette)"/>
    <circle r="36" fill="${GOLD_LIGHT}" stroke="${GOLD_DARK}" stroke-width="2"/>
    <circle r="22" fill="${GOLD}"/>
    <circle r="22" fill="none" stroke="${GOLD_DARK}" stroke-width="1.5"/>
  </g>
</svg>`;

const outDir = path.join(process.cwd(), 'cretif');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'arena_Certificate.jpg');

sharp(Buffer.from(svg))
  .jpeg({ quality: 95 })
  .toFile(outPath)
  .then((info) => {
    console.log(`✓ Template generated: ${outPath} (${info.width}x${info.height}, ${(info.size / 1024).toFixed(1)} KB)`);
  })
  .catch((err: Error) => {
    console.error('✗ Failed to render template:', err.message);
    process.exit(1);
  });
