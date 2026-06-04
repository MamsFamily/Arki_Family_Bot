const { createCanvas } = require('canvas');
const GIFEncoder = require('gif-encoder-2');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '../web/public/img/birthday');
fs.mkdirSync(OUT_DIR, { recursive: true });

const GIFS = [
  {
    filename: 'hb1.gif',
    text: 'Happy Birthday!',
    emoji: '🎂',
    bgColors: ['#1a0533', '#2d0b5e'],
    textColor: '#FFD700',
    glowColor: '#FF69B4',
    starColor: '#FFD700',
  },
  {
    filename: 'hb2.gif',
    text: 'Happy Birthday!',
    emoji: '🎉',
    bgColors: ['#001f3f', '#003366'],
    textColor: '#00FFFF',
    glowColor: '#7FFFD4',
    starColor: '#00FFFF',
  },
  {
    filename: 'hb3.gif',
    text: 'Happy Birthday!',
    emoji: '🌟',
    bgColors: ['#1a0000', '#3d0000'],
    textColor: '#FF6B6B',
    glowColor: '#FFA500',
    starColor: '#FF6B6B',
  },
  {
    filename: 'hb4.gif',
    text: 'Happy Birthday!',
    emoji: '🎊',
    bgColors: ['#003300', '#004d00'],
    textColor: '#00FF7F',
    glowColor: '#7FFF00',
    starColor: '#00FF7F',
  },
  {
    filename: 'ja1.gif',
    text: 'Joyeux Anniversaire!',
    emoji: '🎂',
    bgColors: ['#2d0050', '#1a003a'],
    textColor: '#FFD700',
    glowColor: '#FF1493',
    starColor: '#FF69B4',
  },
  {
    filename: 'ja2.gif',
    text: 'Joyeux Anniversaire!',
    emoji: '🎉',
    bgColors: ['#001a33', '#002a4d'],
    textColor: '#87CEEB',
    glowColor: '#4169E1',
    starColor: '#87CEEB',
  },
  {
    filename: 'ja3.gif',
    text: 'Joyeux Anniversaire!',
    emoji: '🎁',
    bgColors: ['#330011', '#4d0019'],
    textColor: '#FF69B4',
    glowColor: '#FF1493',
    starColor: '#FFD700',
  },
  {
    filename: 'ja4.gif',
    text: 'Joyeux Anniversaire!',
    emoji: '🌈',
    bgColors: ['#002200', '#003300'],
    textColor: '#ADFF2F',
    glowColor: '#32CD32',
    starColor: '#7FFF00',
  },
];

const W = 480;
const H = 270;
const FRAMES = 30;
const DELAY = 80;

function lerp(a, b, t) { return a + (b - a) * t; }

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b];
}

function lerpColor(c1, c2, t) {
  const [r1, g1, b1] = hexToRgb(c1);
  const [r2, g2, b2] = hexToRgb(c2);
  const r = Math.round(lerp(r1, r2, t));
  const g = Math.round(lerp(g1, g2, t));
  const b = Math.round(lerp(b1, b2, t));
  return `rgb(${r},${g},${b})`;
}

function generateStars(seed, count) {
  const stars = [];
  let s = seed;
  for (let i = 0; i < count; i++) {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    const x = ((s >>> 0) % W);
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    const y = ((s >>> 0) % H);
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    const size = 0.5 + ((s >>> 0) % 3);
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    const speed = 0.2 + ((s >>> 0) % 100) / 200;
    stars.push({ x, y, size, speed });
  }
  return stars;
}

async function generateGif(config) {
  const encoder = new GIFEncoder(W, H, 'neuquant', true);
  encoder.setDelay(DELAY);
  encoder.setRepeat(0);
  encoder.setQuality(10);
  encoder.start();

  const stars = generateStars(config.filename.charCodeAt(0) * 31 + config.filename.charCodeAt(1), 40);
  const isLong = config.text.length > 15;
  const fontSize = isLong ? 32 : 40;
  const subSize = 22;

  for (let f = 0; f < FRAMES; f++) {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const t = f / FRAMES;

    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, lerpColor(config.bgColors[0], config.bgColors[1], (Math.sin(t * Math.PI * 2) + 1) / 2));
    bg.addColorStop(1, lerpColor(config.bgColors[1], config.bgColors[0], (Math.sin(t * Math.PI * 2) + 1) / 2));
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    for (const star of stars) {
      const brightness = 0.4 + 0.6 * Math.abs(Math.sin(t * Math.PI * 2 * star.speed + star.x));
      const [r, g, b] = hexToRgb(config.starColor);
      ctx.fillStyle = `rgba(${r},${g},${b},${brightness})`;
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
      ctx.fill();
    }

    const confettiColors = ['#FFD700', '#FF69B4', '#00FFFF', '#FF6B6B', '#ADFF2F', '#FF1493'];
    for (let i = 0; i < 12; i++) {
      const cx = ((i * 73 + f * 7) % W);
      const cy = (((i * 47 + f * 5) % H) + H) % H;
      ctx.fillStyle = confettiColors[i % confettiColors.length];
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(t * Math.PI * 2 + i);
      ctx.fillRect(-3, -3, 6, 6);
      ctx.restore();
    }

    const pulse = 1 + 0.06 * Math.sin(t * Math.PI * 4);
    const glowAlpha = 0.5 + 0.5 * Math.abs(Math.sin(t * Math.PI * 2));

    ctx.save();
    ctx.translate(W / 2, H / 2 - 10);
    ctx.scale(pulse, pulse);

    const [gr, gg, gb] = hexToRgb(config.glowColor);
    ctx.shadowColor = `rgba(${gr},${gg},${gb},${glowAlpha})`;
    ctx.shadowBlur = 20;
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = config.textColor;
    ctx.fillText(config.text, 0, 0);
    ctx.restore();

    ctx.font = `${subSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.fillText(config.emoji, W / 2, H / 2 + fontSize / 2 + 18);

    const sparklePositions = [
      { x: 40, y: 40 }, { x: W - 40, y: 40 },
      { x: 40, y: H - 40 }, { x: W - 40, y: H - 40 },
    ];
    for (let i = 0; i < sparklePositions.length; i++) {
      const sp = sparklePositions[i];
      const phase = t * Math.PI * 4 + (i * Math.PI / 2);
      const scale2 = 0.5 + 0.5 * Math.abs(Math.sin(phase));
      const [sr, sg, sb] = hexToRgb(config.glowColor);
      ctx.save();
      ctx.translate(sp.x, sp.y);
      ctx.rotate(phase);
      ctx.fillStyle = `rgba(${sr},${sg},${sb},${scale2})`;
      ctx.font = `${12 + 8 * scale2}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('✨', 0, 0);
      ctx.restore();
    }

    encoder.addFrame(ctx);
  }

  encoder.finish();
  const buffer = encoder.out.getData();
  const outPath = path.join(OUT_DIR, config.filename);
  fs.writeFileSync(outPath, buffer);
  console.log(`✅ Généré : ${config.filename} (${buffer.length} octets)`);
}

async function main() {
  console.log(`🎂 Génération de ${GIFS.length} GIFs d'anniversaire...`);
  for (const gif of GIFS) {
    await generateGif(gif);
  }
  console.log('🎉 Tous les GIFs ont été générés dans web/public/img/birthday/');
}

main().catch(console.error);
