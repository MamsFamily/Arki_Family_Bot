// utils/canvasTable.js
const { createCanvas, loadImage } = require('canvas')
const path                       = require('path')

/**
 * Génère l’image du tableau de poker avec :
 * - un background
 * - 10 emplacements joueurs (pseudo, argent, 2 cartes hole)
 * - 5 cartes communautaires + affichage du pot
 */
async function generateTableImage(players, pot, communityCards = []) {
  // tailles des cartes
  const communityW = 300
  const communityH = 400
  const holeW      = 150
  const holeH      = 200

  // espacement et nombre fixe de cartes communautaires
  const spacing   = 15
  const cardCount = 5

  // 1) charger les images
  const bgPath   = path.join(__dirname, '..', 'assets', 'poker', 'backgrounds', 'background.png')
  const backPath = path.join(__dirname, '..', 'assets', 'poker', 'cards', 'back.png')
  const [bgImg, backImg] = await Promise.all([
    loadImage(bgPath),
    loadImage(backPath)
  ])

  // 2) créer le canvas
  const width  = bgImg.width
  const height = bgImg.height
  const canvas = createCanvas(width, height)
  const ctx    = canvas.getContext('2d')

  // 3) dessiner le background
  ctx.drawImage(bgImg, 0, 0, width, height)

  // 4) cartes communautaires centrées sur 5 emplacements
  const centerX = width / 2
  const centerY = height / 2
  const totalW  = cardCount * communityW + (cardCount - 1) * spacing
  let startX    = centerX - totalW / 2
  const yComm   = centerY - communityH / 2

  for (let i = 0; i < cardCount; i++) {
    const code = communityCards[i] || 'back'
    const x    = startX + i * (communityW + spacing)
    if (code === 'back') {
      ctx.drawImage(backImg, x, yComm, communityW, communityH)
    } else {
      const img = await loadImage(
        path.join(__dirname, '..', 'assets', 'poker', 'cards', `${code}.png`)
      )
      ctx.drawImage(img, x, yComm, communityW, communityH)
    }
  }

  // 5) afficher le pot
  ctx.font      = 'bold 60px sans-serif'
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.fillText(`Pot : ${pot}`, centerX, yComm - 20)

  // 6) placer jusqu’à 10 joueurs en cercle
  const radius = Math.min(width, height) / 2 - 100
  for (let i = 0; i < players.length; i++) {
    const p     = players[i]
    const angle = -Math.PI / 2 + (2 * Math.PI / 10) * i
    const px    = centerX + Math.cos(angle) * radius
    const py    = centerY + Math.sin(angle) * radius

    // 6a) deux cartes hole
    const [c1, c2] = p.holeCards || ['back','back']
    const x1        = px - holeW - 5
    const x2        = px + 5
    const yCards    = py - holeH / 2

    for (const [idx, code] of [[0, c1], [1, c2]]) {
      const x = idx === 0 ? x1 : x2
      if (code === 'back') {
        ctx.drawImage(backImg, x, yCards, holeW, holeH)
      } else {
        const img = await loadImage(
          path.join(__dirname, '..', 'assets', 'poker', 'cards', `${code}.png`)
        )
        ctx.drawImage(img, x, yCards, holeW, holeH)
      }
    }

    // 6b) pseudo et argent
    ctx.font      = '40px sans-serif'
    ctx.fillStyle = '#ffffff'
    ctx.textAlign = 'center'
    const textY1  = py + holeH / 2 + 30
    const textY2  = py + holeH / 2 + 70
    ctx.fillText(p.name, px, textY1)
    ctx.fillText(p.money, px, textY2)
  }

  // 7) retourner le buffer PNG
  return canvas.toBuffer()
}

module.exports = { generateTableImage }
