const { createCanvas } = require('canvas');

class RouletteWheel {
  constructor(choices) {
    this.choices = choices;
    this.width = 800;
    this.height = 800;
    this.centerX = this.width / 2;
    this.centerY = this.height / 2;
    this.radius = 350;
  }

  generateFrame(rotationAngle, winningSectorIndex = null) {
    const canvas = createCanvas(this.width, this.height);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#2C2F33';
    ctx.fillRect(0, 0, this.width, this.height);

    const numChoices = this.choices.length;
    const anglePerChoice = (2 * Math.PI) / numChoices;

    ctx.save();
    ctx.translate(this.centerX, this.centerY);
    ctx.rotate(rotationAngle);

    const colors = [
      '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A',
      '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2'
    ];

    for (let i = 0; i < numChoices; i++) {
      const startAngle = i * anglePerChoice;
      const endAngle = (i + 1) * anglePerChoice;

      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, this.radius, startAngle, endAngle);
      ctx.closePath();

      if (winningSectorIndex !== null && i === winningSectorIndex) {
        ctx.fillStyle = '#FFD700';
        ctx.strokeStyle = '#FFA500';
        ctx.lineWidth = 6;
      } else {
        ctx.fillStyle = colors[i % colors.length];
        ctx.strokeStyle = '#23272A';
        ctx.lineWidth = 3;
      }

      ctx.fill();
      ctx.stroke();

      ctx.save();
      ctx.rotate(startAngle + anglePerChoice / 2);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 24px Arial';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
      ctx.shadowBlur = 4;

      const text = this.choices[i];
      ctx.fillText(text, this.radius * 0.65, 0);

      ctx.restore();
    }

    ctx.restore();

    ctx.beginPath();
    ctx.moveTo(this.centerX, 50);
    ctx.lineTo(this.centerX - 20, 100);
    ctx.lineTo(this.centerX + 20, 100);
    ctx.closePath();
    ctx.fillStyle = '#FF0000';
    ctx.fill();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(this.centerX, this.centerY, 50, 0, 2 * Math.PI);
    ctx.fillStyle = '#23272A';
    ctx.fill();
    ctx.strokeStyle = '#FFD700';
    ctx.lineWidth = 5;
    ctx.stroke();

    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 30px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('ARKI', this.centerX, this.centerY);

    return canvas.toBuffer('image/png');
  }

  async generateAnimation(winningIndex) {
    const frames = [];
    const totalRotations = 5;
    const anglePerChoice = (2 * Math.PI) / this.choices.length;
    const targetAngle = (2 * Math.PI * totalRotations) + (winningIndex * anglePerChoice) + (anglePerChoice / 2);

    const numFrames = 30;

    for (let i = 0; i <= numFrames; i++) {
      const progress = i / numFrames;
      const easeProgress = this.easeOutCubic(progress);
      const currentAngle = targetAngle * easeProgress;

      const frame = this.generateFrame(currentAngle);
      frames.push(frame);
    }

    const finalFrame = this.generateFrame(targetAngle, winningIndex);
    frames.push(finalFrame);

    return frames;
  }

  easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  getWinningChoice(winningIndex) {
    return this.choices[winningIndex];
  }
}

module.exports = RouletteWheel;
