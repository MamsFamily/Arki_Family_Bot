'use strict';

const { createCanvas } = require('canvas');
const GIFEncoder = require('gif-encoder-2');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '../web/public/img/birthday');
fs.mkdirSync(OUT_DIR, { recursive: true });

const W = 500;
const H = 300;
const FRAMES = 40;
const DELAY = 60;

// ── Utilitaires couleurs ────────────────────────────────────────────────────

function hexToRgb(hex) {
  return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
}
function lerp(a, b, t) { return a + (b - a) * t; }
function lerpColor(c1, c2, t) {
  const [r1,g1,b1] = hexToRgb(c1);
  const [r2,g2,b2] = hexToRgb(c2);
  return `rgb(${Math.round(lerp(r1,r2,t))},${Math.round(lerp(g1,g2,t))},${Math.round(lerp(b1,b2,t))})`;
}
function easeInOut(t) { return t < 0.5 ? 2*t*t : -1+(4-2*t)*t; }

// ── Formes décoratives ──────────────────────────────────────────────────────

function drawBalloon(ctx, x, y, rx, ry, color, stringLen = 40) {
  ctx.save();
  const grad = ctx.createRadialGradient(x - rx*0.3, y - ry*0.3, rx*0.05, x, y, rx*1.1);
  grad.addColorStop(0, lighten(color, 0.5));
  grad.addColorStop(0.5, color);
  grad.addColorStop(1, darken(color, 0.3));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI*2);
  ctx.fill();
  ctx.strokeStyle = darken(color, 0.2);
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.strokeStyle = darken(color, 0.25);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y + ry);
  ctx.bezierCurveTo(x + 8, y + ry + stringLen*0.4, x - 6, y + ry + stringLen*0.7, x, y + ry + stringLen);
  ctx.stroke();
  ctx.restore();
}

function lighten(hex, amount) {
  const [r,g,b] = hexToRgb(hex);
  return `rgb(${Math.min(255,Math.round(r + (255-r)*amount))},${Math.min(255,Math.round(g + (255-g)*amount))},${Math.min(255,Math.round(b + (255-b)*amount))})`;
}
function darken(hex, amount) {
  const [r,g,b] = hexToRgb(hex);
  return `rgb(${Math.round(r*(1-amount))},${Math.round(g*(1-amount))},${Math.round(b*(1-amount))})`;
}

function drawCake(ctx, cx, cy, theme) {
  const cw = 130, layer1H = 36, layer2H = 28, base = cy;

  ctx.save();

  // Plateau
  ctx.fillStyle = '#8B4513';
  ctx.beginPath();
  ctx.ellipse(cx, base + 6, cw/2 + 10, 8, 0, 0, Math.PI*2);
  ctx.fill();

  // Couche basse
  const grad1 = ctx.createLinearGradient(cx - cw/2, base - layer1H, cx + cw/2, base);
  grad1.addColorStop(0, theme.cake1Light);
  grad1.addColorStop(1, theme.cake1);
  ctx.fillStyle = grad1;
  ctx.beginPath();
  ctx.ellipse(cx, base - layer1H, cw/2, 9, 0, 0, Math.PI*2);
  ctx.fill();
  ctx.fillStyle = grad1;
  ctx.fillRect(cx - cw/2, base - layer1H, cw, layer1H);
  ctx.beginPath();
  ctx.ellipse(cx, base, cw/2, 9, 0, 0, Math.PI*2);
  ctx.fill();

  // Glaçage couche basse
  ctx.fillStyle = theme.frosting;
  ctx.beginPath();
  ctx.ellipse(cx, base - layer1H, cw/2, 9, 0, 0, Math.PI*2);
  ctx.fill();
  // Dribbles glaçage
  for (let i = 0; i < 7; i++) {
    const dx = (cx - cw/2 + 12) + i * 17;
    const dh = 6 + (i % 3) * 4;
    ctx.fillStyle = theme.frosting;
    ctx.beginPath();
    ctx.moveTo(dx - 5, base - layer1H + 5);
    ctx.quadraticCurveTo(dx, base - layer1H + dh, dx + 5, base - layer1H + 5);
    ctx.fill();
  }

  // Couche haute (plus petite)
  const cw2 = cw * 0.68;
  const midY = base - layer1H;
  const grad2 = ctx.createLinearGradient(cx - cw2/2, midY - layer2H, cx + cw2/2, midY);
  grad2.addColorStop(0, theme.cake2Light);
  grad2.addColorStop(1, theme.cake2);
  ctx.fillStyle = grad2;
  ctx.beginPath();
  ctx.ellipse(cx, midY - layer2H, cw2/2, 7, 0, 0, Math.PI*2);
  ctx.fill();
  ctx.fillStyle = grad2;
  ctx.fillRect(cx - cw2/2, midY - layer2H, cw2, layer2H);
  ctx.beginPath();
  ctx.ellipse(cx, midY, cw2/2, 7, 0, 0, Math.PI*2);
  ctx.fill();

  // Glaçage couche haute
  ctx.fillStyle = theme.frosting2;
  ctx.beginPath();
  ctx.ellipse(cx, midY - layer2H, cw2/2, 7, 0, 0, Math.PI*2);
  ctx.fill();
  for (let i = 0; i < 5; i++) {
    const dx = (cx - cw2/2 + 10) + i * 14;
    const dh = 5 + (i % 2) * 3;
    ctx.fillStyle = theme.frosting2;
    ctx.beginPath();
    ctx.moveTo(dx - 4, midY - layer2H + 4);
    ctx.quadraticCurveTo(dx, midY - layer2H + dh, dx + 4, midY - layer2H + 4);
    ctx.fill();
  }

  // Décorations (petits ronds colorés)
  const decoColors = [theme.deco1, theme.deco2, theme.deco3];
  for (let i = 0; i < 5; i++) {
    const dx = (cx - cw/2 + 20) + i * 21;
    ctx.fillStyle = decoColors[i % decoColors.length];
    ctx.beginPath();
    ctx.arc(dx, base - layer1H/2, 5, 0, Math.PI*2);
    ctx.fill();
  }
  for (let i = 0; i < 3; i++) {
    const dx = (cx - cw2/2 + 18) + i * 24;
    ctx.fillStyle = decoColors[(i+1) % decoColors.length];
    ctx.beginPath();
    ctx.arc(dx, midY - layer2H/2, 4, 0, Math.PI*2);
    ctx.fill();
  }

  // Bougies
  const topY = midY - layer2H;
  const candleColors = [theme.deco1, theme.deco2, theme.deco3, theme.deco1];
  const candleXs = [cx - 30, cx - 10, cx + 10, cx + 30];
  for (let i = 0; i < 4; i++) {
    const cx2 = candleXs[i];
    const cy2 = topY - 7;
    ctx.fillStyle = candleColors[i];
    ctx.fillRect(cx2 - 4, cy2 - 18, 8, 18);
    ctx.fillStyle = '#FFF';
    ctx.fillRect(cx2 - 3, cy2 - 16, 6, 4);
  }

  ctx.restore();

  return { candleXs, topY: midY - layer2H - 7 - 18 };
}

function drawFlame(ctx, x, y, t, i) {
  const flicker = 0.7 + 0.3 * Math.sin(t * Math.PI * 8 + i * 1.2);
  ctx.save();
  ctx.translate(x, y);

  const grad = ctx.createRadialGradient(0, 2, 0, 0, 0, 8 * flicker);
  grad.addColorStop(0, 'rgba(255,255,200,0.95)');
  grad.addColorStop(0.4, 'rgba(255,160,0,0.8)');
  grad.addColorStop(1, 'rgba(255,50,0,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(0, 0, 5 * flicker, 9 * flicker, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawConfetti(ctx, confetti, t) {
  confetti.forEach(c => {
    const y = ((c.y + t * c.speed * H * 1.2) % (H + 30)) - 15;
    const angle = t * Math.PI * 4 * c.rotSpeed + c.rotOffset;
    ctx.save();
    ctx.translate(c.x, y);
    ctx.rotate(angle);
    ctx.fillStyle = c.color;
    ctx.globalAlpha = 0.85;
    if (c.shape === 0) {
      ctx.fillRect(-c.size/2, -c.size/2, c.size, c.size * 0.5);
    } else if (c.shape === 1) {
      ctx.beginPath();
      ctx.arc(0, 0, c.size/2, 0, Math.PI*2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(0, -c.size/2);
      ctx.lineTo(c.size/2, c.size/2);
      ctx.lineTo(-c.size/2, c.size/2);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  });
}

function drawBanner(ctx, text, cx, cy, t, colors) {
  const pulse = 1 + 0.03 * Math.sin(t * Math.PI * 4);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(pulse, pulse);

  const fontSize = text.length > 17 ? 28 : 32;
  ctx.font = `bold ${fontSize}px serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.shadowColor = 'rgba(0,0,0,0.4)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;

  const metrics = ctx.measureText(text);
  const tw = metrics.width + 40;
  const th = fontSize + 24;

  // Fond banderole
  const bgGrad = ctx.createLinearGradient(-tw/2, -th/2, tw/2, th/2);
  bgGrad.addColorStop(0, colors.banner1);
  bgGrad.addColorStop(0.5, colors.banner2);
  bgGrad.addColorStop(1, colors.banner1);
  ctx.fillStyle = bgGrad;
  ctx.shadowBlur = 12;

  roundRect(ctx, -tw/2, -th/2, tw, th, 12);
  ctx.fill();

  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  ctx.strokeStyle = colors.bannerBorder;
  ctx.lineWidth = 2.5;
  roundRect(ctx, -tw/2, -th/2, tw, th, 12);
  ctx.stroke();

  // Étoiles décoratives dans la banderole
  ctx.font = '14px serif';
  ctx.fillStyle = colors.bannerStar;
  ctx.fillText('✦', -tw/2 + 14, 0);
  ctx.fillText('✦', tw/2 - 14, 0);

  ctx.font = `bold ${fontSize}px serif`;

  // Ombre du texte
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillText(text, 2, 2);

  // Texte coloré lettre par lettre
  const letters = text.split('');
  let totalWidth = 0;
  const widths = letters.map(l => {
    const w = ctx.measureText(l).width;
    totalWidth += w;
    return w;
  });
  let curX = -totalWidth/2;
  letters.forEach((l, i) => {
    const hue = (i / letters.length) * 360;
    ctx.fillStyle = colors.textGradient
      ? `hsl(${(hue + t*120) % 360}, 90%, 62%)`
      : colors.textColor;
    ctx.fillText(l, curX + widths[i]/2, 0);
    curX += widths[i];
  });

  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function makePseudoRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

function makeConfetti(rand, colors) {
  return Array.from({ length: 55 }, () => ({
    x: rand() * W,
    y: rand() * H,
    size: 5 + rand() * 8,
    speed: 0.15 + rand() * 0.35,
    rotSpeed: 0.4 + rand() * 0.8,
    rotOffset: rand() * Math.PI * 2,
    shape: Math.floor(rand() * 3),
    color: colors[Math.floor(rand() * colors.length)],
  }));
}

// ── Définitions des 8 GIFs ──────────────────────────────────────────────────

const THEMES = [
  {
    filename: 'hb1.gif',
    text: 'Happy Birthday!',
    bg1: '#1a0040', bg2: '#3d0080',
    balloon: ['#FF6B9D','#FFD700','#00CFFF','#FF8C42','#A8DADC'],
    confettiColors: ['#FFD700','#FF6B9D','#00CFFF','#FF8C42','#ADFF2F','#FF1493'],
    cakeTheme: { cake1:'#C0392B', cake1Light:'#E74C3C', cake2:'#E91E8C', cake2Light:'#F06292', frosting:'#FFF9C4', frosting2:'#FFFDE7', deco1:'#FFD700', deco2:'#FF69B4', deco3:'#00BFFF' },
    banner: { banner1:'#9B59B6', banner2:'#8E44AD', bannerBorder:'#FFD700', bannerStar:'#FFD700', textGradient:true },
  },
  {
    filename: 'hb2.gif',
    text: 'Happy Birthday!',
    bg1: '#001a3d', bg2: '#003d80',
    balloon: ['#FF4081','#40C4FF','#69F0AE','#FFEA00','#EA80FC'],
    confettiColors: ['#40C4FF','#FF4081','#69F0AE','#FFEA00','#EA80FC','#FF6E40'],
    cakeTheme: { cake1:'#1565C0', cake1Light:'#1E88E5', cake2:'#00838F', cake2Light:'#00ACC1', frosting:'#E3F2FD', frosting2:'#E0F7FA', deco1:'#FF4081', deco2:'#FFEA00', deco3:'#69F0AE' },
    banner: { banner1:'#1565C0', banner2:'#0D47A1', bannerBorder:'#40C4FF', bannerStar:'#40C4FF', textGradient:true },
  },
  {
    filename: 'hb3.gif',
    text: 'Happy Birthday!',
    bg1: '#1a2a00', bg2: '#2d4a00',
    balloon: ['#FF6B35','#F7C59F','#EFEFD0','#4ECDC4','#FF6B6B'],
    confettiColors: ['#FF6B35','#4ECDC4','#45B7D1','#FED766','#2AB7CA','#FF6B6B'],
    cakeTheme: { cake1:'#2E7D32', cake1Light:'#43A047', cake2:'#558B2F', cake2Light:'#7CB342', frosting:'#F1F8E9', frosting2:'#F9FBE7', deco1:'#FF6B35', deco2:'#FED766', deco3:'#4ECDC4' },
    banner: { banner1:'#2E7D32', banner2:'#1B5E20', bannerBorder:'#FED766', bannerStar:'#FED766', textColor:'#FED766', textGradient:false },
  },
  {
    filename: 'hb4.gif',
    text: 'Happy Birthday!',
    bg1: '#2a001a', bg2: '#4d0033',
    balloon: ['#F72585','#7209B7','#3A0CA3','#4CC9F0','#4361EE'],
    confettiColors: ['#F72585','#7209B7','#4CC9F0','#4361EE','#F4D35E','#EE4266'],
    cakeTheme: { cake1:'#7B1FA2', cake1Light:'#9C27B0', cake2:'#AD1457', cake2Light:'#E91E63', frosting:'#F3E5F5', frosting2:'#FCE4EC', deco1:'#F72585', deco2:'#4CC9F0', deco3:'#F4D35E' },
    banner: { banner1:'#7B1FA2', banner2:'#6A1B9A', bannerBorder:'#F72585', bannerStar:'#F72585', textGradient:true },
  },
  {
    filename: 'ja1.gif',
    text: 'Joyeux Anniversaire !',
    bg1: '#2a1500', bg2: '#5c3000',
    balloon: ['#FF9500','#FF3D00','#FFD600','#F50057','#00BCD4'],
    confettiColors: ['#FF9500','#FF3D00','#FFD600','#F50057','#00BCD4','#76FF03'],
    cakeTheme: { cake1:'#E65100', cake1Light:'#F57C00', cake2:'#BF360C', cake2Light:'#D84315', frosting:'#FFF8E1', frosting2:'#FFF3E0', deco1:'#FFD600', deco2:'#FF3D00', deco3:'#00BCD4' },
    banner: { banner1:'#E65100', banner2:'#BF360C', bannerBorder:'#FFD600', bannerStar:'#FFD600', textGradient:true },
  },
  {
    filename: 'ja2.gif',
    text: 'Joyeux Anniversaire !',
    bg1: '#001430', bg2: '#002860',
    balloon: ['#E040FB','#448AFF','#1DE9B6','#FF6D00','#EEFF41'],
    confettiColors: ['#E040FB','#448AFF','#1DE9B6','#FF6D00','#EEFF41','#FF4081'],
    cakeTheme: { cake1:'#283593', cake1Light:'#3949AB', cake2:'#1565C0', cake2Light:'#1976D2', frosting:'#EDE7F6', frosting2:'#E8EAF6', deco1:'#E040FB', deco2:'#EEFF41', deco3:'#1DE9B6' },
    banner: { banner1:'#283593', banner2:'#1A237E', bannerBorder:'#E040FB', bannerStar:'#E040FB', textGradient:true },
  },
  {
    filename: 'ja3.gif',
    text: 'Joyeux Anniversaire !',
    bg1: '#1a0020', bg2: '#38004a',
    balloon: ['#FF80AB','#EA80FC','#B388FF','#82B1FF','#CCFF90'],
    confettiColors: ['#FF80AB','#EA80FC','#B388FF','#82B1FF','#CCFF90','#FFCC80'],
    cakeTheme: { cake1:'#6A1B9A', cake1Light:'#8E24AA', cake2:'#4A148C', cake2Light:'#6A1B9A', frosting:'#F3E5F5', frosting2:'#EDE7F6', deco1:'#FF80AB', deco2:'#CCFF90', deco3:'#82B1FF' },
    banner: { banner1:'#6A1B9A', banner2:'#4A148C', bannerBorder:'#FF80AB', bannerStar:'#FF80AB', textGradient:true },
  },
  {
    filename: 'ja4.gif',
    text: 'Joyeux Anniversaire !',
    bg1: '#001a00', bg2: '#003000',
    balloon: ['#00E676','#FFEA00','#FF6E40','#40C4FF','#FF4081'],
    confettiColors: ['#00E676','#FFEA00','#FF6E40','#40C4FF','#FF4081','#E040FB'],
    cakeTheme: { cake1:'#2E7D32', cake1Light:'#388E3C', cake2:'#1B5E20', cake2Light:'#2E7D32', frosting:'#F9FBE7', frosting2:'#F1F8E9', deco1:'#00E676', deco2:'#FFEA00', deco3:'#FF4081' },
    banner: { banner1:'#1B5E20', banner2:'#33691E', bannerBorder:'#00E676', bannerStar:'#00E676', textColor:'#FFEA00', textGradient:false },
  },
];

// ── Positions des ballons ───────────────────────────────────────────────────

const BALLOON_DEFS = [
  { bx: 0.08, bOff: 0,    rx: 22, ry: 28 },
  { bx: 0.16, bOff: 0.12, rx: 18, ry: 24 },
  { bx: 0.80, bOff: 0.05, rx: 22, ry: 28 },
  { bx: 0.89, bOff: 0.18, rx: 18, ry: 24 },
  { bx: 0.50, bOff: 0.08, rx: 16, ry: 21 },
];

// ── Générer un GIF ──────────────────────────────────────────────────────────

async function generateGif(theme) {
  const rand = makePseudoRandom(theme.filename.charCodeAt(0) * 31 + theme.filename.charCodeAt(2));
  const confetti = makeConfetti(rand, theme.confettiColors);

  const encoder = new GIFEncoder(W, H, 'neuquant', true);
  encoder.setDelay(DELAY);
  encoder.setRepeat(0);
  encoder.setQuality(8);
  encoder.start();

  for (let f = 0; f < FRAMES; f++) {
    const t = f / FRAMES;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    // ── Fond dégradé ──
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, theme.bg1);
    bg.addColorStop(1, theme.bg2);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // ── Étoiles de fond ──
    const starRand = makePseudoRandom(42);
    for (let i = 0; i < 30; i++) {
      const sx = starRand() * W;
      const sy = starRand() * H;
      const br = 0.3 + 0.7 * Math.abs(Math.sin(t * Math.PI * 3 + i * 0.7));
      ctx.fillStyle = `rgba(255,255,255,${br * 0.6})`;
      ctx.beginPath();
      ctx.arc(sx, sy, starRand() * 1.5 + 0.5, 0, Math.PI*2);
      ctx.fill();
    }

    // ── Confettis ──
    drawConfetti(ctx, confetti, t);

    // ── Ballons ──
    BALLOON_DEFS.forEach((bd, i) => {
      const by = 0.35 + 0.04 * Math.sin(t * Math.PI * 2 * 1.3 + bd.bOff * Math.PI * 2);
      const bx = bd.bx;
      drawBalloon(ctx, bx * W, by * H, bd.rx, bd.ry, theme.balloon[i % theme.balloon.length], 35);
    });

    // ── Gâteau ──
    const cakeY = H - 35;
    const { candleXs, topY } = drawCake(ctx, W/2, cakeY, theme.cakeTheme);

    // ── Flammes des bougies ──
    candleXs.forEach((cx, i) => {
      drawFlame(ctx, cx, topY, t, i);
    });

    // ── Banderole en haut ──
    drawBanner(ctx, theme.text, W/2, 48, t, theme.banner);

    // ── Guirlande de petits drapeaux ──
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(30, 80);
    ctx.quadraticCurveTo(W/2, 70, W - 30, 80);
    ctx.stroke();
    const flagColors = theme.confettiColors;
    for (let i = 0; i < 10; i++) {
      const px = 30 + i * (W - 60) / 9;
      const py = 80 + 5 * Math.sin(i * 0.7);
      const fc = flagColors[i % flagColors.length];
      ctx.fillStyle = fc;
      ctx.beginPath();
      ctx.moveTo(px - 6, py - 2);
      ctx.lineTo(px + 6, py - 2);
      ctx.lineTo(px + 3, py + 10);
      ctx.lineTo(px - 3, py + 10);
      ctx.closePath();
      ctx.fill();
    }

    encoder.addFrame(ctx);
  }

  encoder.finish();
  const buffer = encoder.out.getData();
  const outPath = path.join(OUT_DIR, theme.filename);
  fs.writeFileSync(outPath, buffer);
  console.log(`✅ ${theme.filename} — ${(buffer.length/1024).toFixed(0)} Ko`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`🎂 Génération de ${THEMES.length} GIFs d'anniversaire améliorés...\n`);
  for (const theme of THEMES) {
    await generateGif(theme);
  }
  console.log('\n🎉 Terminé ! GIFs dans web/public/img/birthday/');
}

main().catch(console.error);
