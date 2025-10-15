const { createCanvas } = require('canvas');
const GIFEncoder = require('gif-encoder-2');

class RouletteWheel {
  constructor(choices) {
    this.choices = choices;
    this.width = 900;
    this.height = 900;
    this.centerX = this.width / 2;
    this.centerY = this.height / 2;
    this.radius = 380;
  }

  generateFrame(rotationAngle, winningSectorIndex = null) {
    const canvas = createCanvas(this.width, this.height);
    const ctx = canvas.getContext('2d');

    const bgGradient = ctx.createRadialGradient(
      this.centerX, this.centerY, 0,
      this.centerX, this.centerY, this.width / 2
    );
    bgGradient.addColorStop(0, '#1a1d29');
    bgGradient.addColorStop(1, '#0a0c14');
    ctx.fillStyle = bgGradient;
    ctx.fillRect(0, 0, this.width, this.height);

    const numChoices = this.choices.length;
    const anglePerChoice = (2 * Math.PI) / numChoices;

    ctx.save();
    ctx.translate(this.centerX, this.centerY);

    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = 30;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 15;

    ctx.beginPath();
    ctx.arc(0, 0, this.radius + 5, 0, 2 * Math.PI);
    ctx.fillStyle = '#1a1d29';
    ctx.fill();

    ctx.shadowColor = 'transparent';

    ctx.rotate(rotationAngle);

    const colors = [
      ['#FF6B9D', '#C44569'],
      ['#4FACFE', '#00F2FE'],
      ['#43E97B', '#38F9D7'],
      ['#FA709A', '#FEE140'],
      ['#30CFD0', '#330867'],
      ['#A8EDEA', '#FED6E3'],
      ['#FF9A56', '#FF6A88'],
      ['#667EEA', '#764BA2'],
      ['#F093FB', '#F5576C'],
      ['#4FACFE', '#00F2FE'],
      ['#43E97B', '#38F9D7'],
      ['#FAD961', '#F76B1C']
    ];

    for (let i = 0; i < numChoices; i++) {
      const startAngle = i * anglePerChoice;
      const endAngle = (i + 1) * anglePerChoice;

      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, this.radius, startAngle, endAngle);
      ctx.closePath();

      if (winningSectorIndex !== null && i === winningSectorIndex) {
        const winGradient = ctx.createRadialGradient(0, 0, 0, 0, 0, this.radius);
        winGradient.addColorStop(0, '#FFD700');
        winGradient.addColorStop(0.5, '#FFA500');
        winGradient.addColorStop(1, '#FF8C00');
        ctx.fillStyle = winGradient;
        
        ctx.shadowColor = '#FFD700';
        ctx.shadowBlur = 25;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
      } else {
        const colorSet = colors[i % colors.length];
        const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, this.radius);
        gradient.addColorStop(0, colorSet[0]);
        gradient.addColorStop(1, colorSet[1]);
        ctx.fillStyle = gradient;
        
        ctx.shadowColor = 'transparent';
      }

      ctx.fill();

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.save();
      ctx.rotate(startAngle + anglePerChoice / 2);
      
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      
      const text = this.choices[i];
      const maxWidth = this.radius * 0.5;
      const fontSize = Math.min(28, Math.max(16, 400 / text.length));
      ctx.font = `bold ${fontSize}px "Arial Black", "Arial", sans-serif`;
      
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
      ctx.lineWidth = 4;
      ctx.lineJoin = 'round';
      ctx.strokeText(text, this.radius * 0.65, 0);
      
      ctx.fillStyle = '#FFFFFF';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
      ctx.shadowBlur = 6;
      ctx.shadowOffsetX = 2;
      ctx.shadowOffsetY = 2;
      ctx.fillText(text, this.radius * 0.65, 0);

      ctx.shadowColor = 'transparent';
      ctx.restore();
    }

    ctx.restore();

    ctx.save();
    ctx.shadowColor = 'rgba(255, 0, 0, 0.6)';
    ctx.shadowBlur = 15;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 5;

    ctx.beginPath();
    ctx.moveTo(this.centerX, 110);
    ctx.lineTo(this.centerX - 25, 40);
    ctx.lineTo(this.centerX, 55);
    ctx.lineTo(this.centerX + 25, 40);
    ctx.closePath();
    
    const arrowGradient = ctx.createLinearGradient(this.centerX - 25, 40, this.centerX + 25, 110);
    arrowGradient.addColorStop(0, '#FF0000');
    arrowGradient.addColorStop(1, '#AA0000');
    ctx.fillStyle = arrowGradient;
    ctx.fill();
    
    ctx.strokeStyle = '#FFD700';
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.shadowColor = 'transparent';
    ctx.restore();

    ctx.save();
    ctx.shadowColor = 'rgba(255, 215, 0, 0.8)';
    ctx.shadowBlur = 25;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    const centerGradient = ctx.createRadialGradient(
      this.centerX, this.centerY - 10, 0,
      this.centerX, this.centerY, 70
    );
    centerGradient.addColorStop(0, '#FFD700');
    centerGradient.addColorStop(0.5, '#FFA500');
    centerGradient.addColorStop(1, '#FF8C00');

    ctx.beginPath();
    ctx.arc(this.centerX, this.centerY, 70, 0, 2 * Math.PI);
    ctx.fillStyle = centerGradient;
    ctx.fill();
    
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 6;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(this.centerX, this.centerY, 60, 0, 2 * Math.PI);
    ctx.strokeStyle = '#8B4513';
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.shadowColor = 'transparent';

    const highlightGradient = ctx.createRadialGradient(
      this.centerX - 15, this.centerY - 15, 0,
      this.centerX, this.centerY, 50
    );
    highlightGradient.addColorStop(0, 'rgba(255, 255, 255, 0.4)');
    highlightGradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    
    ctx.beginPath();
    ctx.arc(this.centerX, this.centerY, 60, 0, 2 * Math.PI);
    ctx.fillStyle = highlightGradient;
    ctx.fill();

    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 36px "Arial Black", "Arial", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.lineWidth = 3;
    ctx.strokeText('ARKI', this.centerX, this.centerY);
    
    ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;
    ctx.fillText('ARKI', this.centerX, this.centerY);

    ctx.restore();

    return canvas.getContext('2d');
  }

  async generateAnimatedGif(winningIndex) {
    const encoder = new GIFEncoder(this.width, this.height);
    
    encoder.start();
    encoder.setRepeat(-1);
    encoder.setDelay(30);
    encoder.setQuality(10);

    const totalRotations = 3;
    const anglePerChoice = (2 * Math.PI) / this.choices.length;
    
    const topPosition = -Math.PI / 2;
    const winningAngle = winningIndex * anglePerChoice;
    const targetAngle = (2 * Math.PI * totalRotations) + (topPosition - winningAngle);

    const numFrames = 60;

    for (let i = 0; i <= numFrames; i++) {
      const progress = i / numFrames;
      const easeProgress = this.easeOutQuart(progress);
      const currentAngle = targetAngle * easeProgress;

      const ctx = this.generateFrame(currentAngle, i === numFrames ? winningIndex : null);
      encoder.addFrame(ctx);
    }

    for (let i = 0; i < 30; i++) {
      const ctx = this.generateFrame(targetAngle, winningIndex);
      encoder.addFrame(ctx);
    }

    encoder.finish();
    
    return encoder.out.getData();
  }

  easeOutQuart(t) {
    return 1 - Math.pow(1 - t, 4);
  }

  getWinningChoice(winningIndex) {
    return this.choices[winningIndex];
  }
}

module.exports = RouletteWheel;
