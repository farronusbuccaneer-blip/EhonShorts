import type { Slide } from './markdownParser';

/**
 * Helper to draw a rounded rectangle on Canvas.
 */
export function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  fillColor: string | CanvasGradient,
  strokeColor?: string,
  lineWidth: number = 2
) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();

  if (fillColor) {
    ctx.fillStyle = fillColor;
    ctx.fill();
  }

  if (strokeColor) {
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
}

/**
 * Helper to wrap text into multiple lines for Canvas rendering.
 */
export function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const tokens: string[] = [];
  // Tokenize English words, spaces, brackets/punctuation, or individual CJK/Japanese characters
  const regex = /([a-zA-Z0-9'’]+|\s+|[「」『』()（）<>＜＞《》【】!?,.！？，．]|[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]|[^\w\s\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef])/g;
  
  let match;
  while ((match = regex.exec(text)) !== null) {
    tokens.push(match[0]);
  }

  const lines: string[] = [];
  let currentLine = '';

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const testLine = currentLine + token;
    const testWidth = ctx.measureText(testLine.trim()).width;

    if (testWidth > maxWidth && i > 0) {
      if (currentLine.trim()) {
        lines.push(currentLine.trim());
      }
      currentLine = token;
    } else {
      currentLine = testLine;
    }
  }
  
  if (currentLine.trim()) {
    lines.push(currentLine.trim());
  }
  
  return lines.length > 0 ? lines : [''];
}

/**
 * Core drawing function shared by both the real-time player and video exporter.
 * Incorporates entrance ease animations based on slideElapsed.
 */
export function drawSlideFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  videoElement: HTMLVideoElement | null,
  slide: Slide,
  isThinkingTime: boolean,
  thinkingProgress: number,
  title: string,
  hook: string,
  slideElapsed: number
) {
  // Reassign parameters with safe defaults if NaN is passed
  const safeSlideElapsed = typeof slideElapsed === 'number' && !isNaN(slideElapsed) ? slideElapsed : 0;
  const safeThinkingProgress = typeof thinkingProgress === 'number' && !isNaN(thinkingProgress) ? thinkingProgress : 0;
  
  // Reassign variables so the rest of the function scope uses the safe copies
  slideElapsed = safeSlideElapsed;
  thinkingProgress = safeThinkingProgress;

  ctx.clearRect(0, 0, width, height);

  // 1. Draw Background Video (Aspect Cover)
  let videoDrawn = false;
  if (videoElement && videoElement.readyState >= 2 && videoElement.videoWidth > 0 && videoElement.videoHeight > 0) {
    try {
      const videoWidth = videoElement.videoWidth;
      const videoHeight = videoElement.videoHeight;
      const videoRatio = videoWidth / videoHeight;
      const canvasRatio = width / height;

      let sx = 0, sy = 0, sw = videoWidth, sh = videoHeight;

      if (videoRatio > canvasRatio) {
        sw = videoHeight * canvasRatio;
        sx = (videoWidth - sw) / 2;
      } else {
        sh = videoWidth / canvasRatio;
        sy = (videoHeight - sh) / 2;
      }

      if (sw > 0 && sh > 0) {
        ctx.drawImage(videoElement, sx, sy, sw, sh, 0, 0, width, height);
        videoDrawn = true;
      }
    } catch (e) {
      // Ignore drawing errors, fall back to gradient
    }
  }

  if (!videoDrawn) {
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, '#0f172a');
    grad.addColorStop(1, '#1e1b4b');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
  }

  // 1b. Draw Floating Background Particles/Bubbles for premium visual motion
  ctx.save();
  for (let i = 0; i < 20; i++) {
    // Deterministic position seeds based on index
    const seedX = (Math.sin(i * 742.3) + 1) / 2;
    const seedY = (Math.cos(i * 382.9) + 1) / 2;
    const size = 4 + (i % 8);
    
    // Float upwards continuously
    const pX = seedX * width;
    const pY = ((seedY * height - slideElapsed * 45) % height + height) % height;
    
    // Pulse opacity
    const alpha = 0.12 + 0.12 * Math.sin(slideElapsed * 2.5 + i);
    ctx.fillStyle = `hsla(${(i * 18) % 360}, 85%, 65%, ${alpha})`;
    ctx.beginPath();
    ctx.arc(pX, pY, size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // 2. Draw Semi-transparent Dark Overlay
  ctx.fillStyle = 'rgba(15, 23, 42, 0.45)';
  ctx.fillRect(0, 0, width, height);

  // 3. Draw Header Title (Watermark)
  ctx.font = 'bold 20px "Fredoka", sans-serif';
  ctx.fillStyle = '#6366f1';
  ctx.shadowColor = 'rgba(99, 102, 241, 0.5)';
  ctx.shadowBlur = 8;
  ctx.fillText(title.toUpperCase(), 40, 60);
  ctx.shadowBlur = 0; // reset

  // 4. Calculate Ease Animation Values (0 to 1)
  const headerT = Math.min(1, slideElapsed / 0.45);
  const headerEase = headerT * (2 - headerT); // Ease Out Quad

  const subT = Math.min(1, Math.max(0, slideElapsed - 0.15) / 0.45);
  const subEase = subT * (2 - subT);

  const layout = slide.layout || 'hook_layout';

  if (layout === 'hook_layout') {
    const cardW = width - 80;
    const cardH = 360;
    const cardX = 40;
    const cardY = (height - cardH) / 2 - 30;

    // Glowing outline
    drawRoundedRect(
      ctx,
      cardX,
      cardY,
      cardW,
      cardH,
      24,
      'rgba(15, 23, 42, 0.75)',
      'rgba(99, 102, 241, 0.4)',
      3
    );

    // Header Text Animation (Elastic entrance bounce + soft continuous breath)
    const tVal = Math.min(1, slideElapsed / 0.45);
    const spring = tVal === 1 ? 1 : Math.sin(tVal * Math.PI * 1.85) * Math.pow(2, -7 * tVal) + 1;
    const breath = 1 + 0.02 * Math.sin(slideElapsed * 6.0);
    const scaleFactor = spring * breath;

    const textCenterX = width / 2;
    const textCenterY = cardY + 95;

    ctx.save();
    ctx.globalAlpha = headerEase;
    
    // Scale from center of the header block
    ctx.translate(textCenterX, textCenterY);
    ctx.scale(scaleFactor, scaleFactor);
    ctx.translate(-textCenterX, -textCenterY);

    ctx.font = 'bold 52px "Fredoka", sans-serif';
    ctx.textAlign = 'center';
    
    // Animate gradient colors dynamically in a cycle
    const hueShift = (slideElapsed * 80) % 360;
    const textGrad = ctx.createLinearGradient(cardX, cardY, cardX + cardW, cardY);
    textGrad.addColorStop(0, `hsl(${hueShift}, 95%, 65%)`);
    textGrad.addColorStop(0.5, `hsl(${(hueShift + 120) % 360}, 95%, 65%)`);
    textGrad.addColorStop(1, `hsl(${(hueShift + 240) % 360}, 95%, 65%)`);
    ctx.fillStyle = textGrad;
    
    // Pulsing text glow effect
    ctx.shadowColor = `hsl(${hueShift}, 95%, 65%)`;
    ctx.shadowBlur = 15 + 6 * Math.sin(slideElapsed * 6.5);
    
    const headerLines = wrapText(ctx, slide.header || '', cardW - 60);
    let startY = cardY + 95 - ((headerLines.length - 1) * 28);

    // Dynamic RGB Chromatic Aberration Pop on entrance
    if (slideElapsed < 0.5) {
      const glitchAmp = 6 * (1 - slideElapsed / 0.5);
      const gx = glitchAmp * Math.sin(slideElapsed * 60);
      const gy = glitchAmp * Math.cos(slideElapsed * 50);

      // Cyan Shadow Offset
      ctx.save();
      ctx.fillStyle = 'rgba(6, 182, 212, 0.7)';
      ctx.shadowBlur = 0;
      let syCyan = startY;
      for (const line of headerLines) {
        ctx.fillText(line, width / 2 + gx, syCyan + gy);
        syCyan += 62;
      }
      ctx.restore();

      // Magenta Shadow Offset
      ctx.save();
      ctx.fillStyle = 'rgba(236, 72, 153, 0.7)';
      ctx.shadowBlur = 0;
      let syMag = startY;
      for (const line of headerLines) {
        ctx.fillText(line, width / 2 - gx, syMag - gy);
        syMag += 62;
      }
      ctx.restore();
    }

    for (const line of headerLines) {
      ctx.fillText(line, width / 2, startY);
      startY += 62;
    }
    ctx.restore();
    
    // Subtitle Animation (Fades and slides up slightly)
    ctx.save();
    ctx.globalAlpha = subEase;
    ctx.translate(0, 30 * (1 - subEase));

    ctx.shadowBlur = 0;
    ctx.font = '500 34px "Zen Maru Gothic", sans-serif';
    ctx.fillStyle = '#e2e8f0';
    ctx.textAlign = 'center';
    
    const subLines = wrapText(ctx, slide.sub_header || '', cardW - 60);
    let subY = cardY + 235;
    for (const line of subLines) {
      ctx.fillText(line, width / 2, subY);
      subY += 46;
    }
    ctx.restore();

    // Hook at bottom
    if (hook) {
      ctx.save();
      ctx.globalAlpha = subEase;
      ctx.font = '600 24px "Zen Maru Gothic", sans-serif';
      ctx.fillStyle = '#ec4899';
      ctx.textAlign = 'center';
      ctx.fillText(hook, width / 2, height - 100);
      ctx.restore();
    }

  } else if (layout === 'list_layout') {
    const headerY = 160;
    const tVal = Math.min(1, slideElapsed / 0.45);
    const spring = tVal === 1 ? 1 : Math.sin(tVal * Math.PI * 1.85) * Math.pow(2, -7 * tVal) + 1;
    const breath = 1 + 0.02 * Math.sin(slideElapsed * 6.0);
    const scaleFactor = spring * breath;

    ctx.save();
    ctx.globalAlpha = headerEase;
    
    ctx.translate(width / 2, headerY);
    ctx.scale(scaleFactor, scaleFactor);
    ctx.translate(-width / 2, -headerY);

    ctx.textAlign = 'center';
    ctx.font = 'bold 52px "Fredoka", sans-serif';
    
    const hueShift = (slideElapsed * 80) % 360;
    const grad = ctx.createLinearGradient(40, headerY, width - 40, headerY);
    grad.addColorStop(0, `hsl(${hueShift}, 95%, 65%)`);
    grad.addColorStop(0.5, `hsl(${(hueShift + 120) % 360}, 95%, 65%)`);
    grad.addColorStop(1, `hsl(${(hueShift + 240) % 360}, 95%, 65%)`);
    ctx.fillStyle = grad;
    ctx.shadowColor = `hsl(${hueShift}, 95%, 65%)`;
    ctx.shadowBlur = 12 + 5 * Math.sin(slideElapsed * 6.5);

    // Chromatic pop
    if (slideElapsed < 0.5) {
      const glitchAmp = 6 * (1 - slideElapsed / 0.5);
      const gx = glitchAmp * Math.sin(slideElapsed * 60);
      const gy = glitchAmp * Math.cos(slideElapsed * 50);

      ctx.save();
      ctx.fillStyle = 'rgba(6, 182, 212, 0.7)';
      ctx.shadowBlur = 0;
      ctx.fillText(slide.header || '', width / 2 + gx, headerY + gy);
      ctx.restore();

      ctx.save();
      ctx.fillStyle = 'rgba(236, 72, 153, 0.7)';
      ctx.shadowBlur = 0;
      ctx.fillText(slide.header || '', width / 2 - gx, headerY - gy);
      ctx.restore();
    }

    ctx.fillText(slide.header || '', width / 2, headerY);
    ctx.restore();

    // Content Card
    const cardW = width - 80;
    const cardH = 280;
    const cardX = 40;
    const cardY = 240;

    ctx.save();
    ctx.globalAlpha = subEase;
    ctx.translate(0, 30 * (1 - subEase));

    drawRoundedRect(
      ctx,
      cardX,
      cardY,
      cardW,
      cardH,
      20,
      'rgba(15, 23, 42, 0.7)',
      'rgba(255, 255, 255, 0.1)',
      1.5
    );

    // Subheader text
    ctx.font = '500 38px "Zen Maru Gothic", sans-serif';
    ctx.fillStyle = '#f1f5f9';
    ctx.textAlign = 'center';
    const subLines = wrapText(ctx, slide.sub_header || '', cardW - 65);
    let subY = cardY + 90;
    for (const line of subLines) {
      ctx.fillText(line, width / 2, subY);
      subY += 52;
    }
    ctx.restore();

  } else if (layout === 'quiz_question') {
    const headerY = 150;
    
    // Quiz Title Animation (Elastic spring + breath glow)
    const tVal = Math.min(1, slideElapsed / 0.45);
    const spring = tVal === 1 ? 1 : Math.sin(tVal * Math.PI * 1.85) * Math.pow(2, -7 * tVal) + 1;
    const breath = 1 + 0.02 * Math.sin(slideElapsed * 6.0);
    const scaleFactor = spring * breath;

    ctx.save();
    ctx.globalAlpha = headerEase;
    
    ctx.translate(width / 2, headerY);
    ctx.scale(scaleFactor, scaleFactor);
    ctx.translate(-width / 2, -headerY);
    
    ctx.textAlign = 'center';
    ctx.font = 'bold 50px "Fredoka", sans-serif';
    ctx.fillStyle = '#f59e0b';
    ctx.shadowColor = 'rgba(245, 158, 11, 0.6)';
    ctx.shadowBlur = 12 + 4 * Math.sin(slideElapsed * 6.5);
    ctx.fillText("QUIZ TIME!", width / 2, headerY);
    ctx.restore();

    // Question Text Animation (slide.header)
    ctx.save();
    ctx.globalAlpha = subEase;
    ctx.translate(0, -15 * (1 - subEase));
    ctx.font = '600 38px "Zen Maru Gothic", sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    
    const questionLines = wrapText(ctx, slide.header || '', width - 80);
    let qY = 210;
    for (const line of questionLines) {
      ctx.fillText(line, width / 2, qY);
      qY += 48;
    }
    ctx.restore();

    // Draw Sub-header Question Prompt (e.g. "very hungry より『極限の 飢え』を表す表現はどっち？")
    let promptY = qY;
    if (slide.sub_header) {
      ctx.save();
      ctx.globalAlpha = subEase;
      ctx.translate(0, 10 * (1 - subEase));
      ctx.font = '500 28px "Zen Maru Gothic", sans-serif';
      ctx.fillStyle = '#cbd5e1'; // Warm white-gray
      ctx.textAlign = 'center';
      
      // Flashy pulsing yellow-glow shadow on prompt to draw attention
      ctx.shadowColor = 'rgba(253, 224, 71, 0.3)';
      ctx.shadowBlur = 8 + 3 * Math.sin(slideElapsed * 5.0);

      const promptLines = wrapText(ctx, slide.sub_header, width - 80);
      for (const line of promptLines) {
        ctx.fillText(line, width / 2, promptY);
        promptY += 38;
      }
      ctx.restore();
    }

    // Draw choices staggered animation
    const choices = slide.choices || [];
    const buttonW = width - 100;
    const buttonH = 74;
    const buttonX = 50;
    const startButtonY = promptY + 25;

    choices.forEach((choice, idx) => {
      // Stagger calculations
      const staggerStart = 0.2 + idx * 0.12;
      const t = Math.min(1, Math.max(0, slideElapsed - staggerStart) / 0.35);
      const ease = t * (2 - t);

      ctx.save();
      ctx.globalAlpha = ease;
      ctx.translate(-40 * (1 - ease), 0); // Slide in from left

      const bY = startButtonY + idx * (buttonH + 20);
      drawRoundedRect(
        ctx,
        buttonX,
        bY,
        buttonW,
        buttonH,
        14,
        'rgba(30, 41, 59, 0.8)',
        'rgba(255, 255, 255, 0.15)',
        1.5
      );

      ctx.font = 'bold 26px "Fredoka", sans-serif';
      ctx.fillStyle = '#f59e0b';
      ctx.textAlign = 'left';
      ctx.fillText(`${idx + 1}`, buttonX + 25, bY + 46);

      ctx.font = '500 26px "Zen Maru Gothic", sans-serif';
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(choice, buttonX + 60, bY + 46);
      ctx.restore();
    });

    // Draw thinking countdown bomb and fuse
    if (isThinkingTime) {
      const barW = width - 180; // Make room for bomb on the left
      const barX = 130; // Shift fuse right
      const barY = height - 150;
      
      const bombX = 75; // Bomb is at the left
      const bombY = barY + 7; // Center vertically on the fuse line
      
      // 1. Draw the burning fuse (rope line)
      // Fuse burns from right (barX + barW) to left (barX)
      // thinkingProgress goes from 1 (full fuse) to 0 (burned out)
      const sparkX = barX + barW * thinkingProgress;
      
      ctx.save();
      ctx.shadowBlur = 0;
      
      // Draw burned fuse (thin gray dotted line)
      ctx.beginPath();
      ctx.strokeStyle = '#475569';
      ctx.lineWidth = 3;
      ctx.setLineDash([4, 4]);
      ctx.moveTo(sparkX, bombY);
      ctx.lineTo(barX + barW, bombY);
      ctx.stroke();
      ctx.setLineDash([]); // Reset
      
      // Draw remaining unburned fuse (thick wavy orange-brown rope)
      if (thinkingProgress > 0) {
        ctx.beginPath();
        ctx.strokeStyle = '#b45309';
        ctx.lineWidth = 7;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        
        ctx.moveTo(bombX + 22, bombY);
        // Draw wavy line to the spark point
        for (let x = bombX + 22; x <= sparkX; x += 10) {
          const waveY = bombY + Math.sin(x * 0.15 + slideElapsed * 15) * 4;
          ctx.lineTo(x, waveY);
        }
        ctx.stroke();
      }
      
      // 2. Draw Spark Flame at the burning point
      if (thinkingProgress > 0) {
        ctx.save();
        const sparkSize = 12 + 5 * Math.sin(slideElapsed * 45);
        ctx.shadowColor = '#ef4444';
        ctx.shadowBlur = 20;
        
        // Draw spark background glow
        const sparkGrad = ctx.createRadialGradient(sparkX, bombY, 2, sparkX, bombY, sparkSize);
        sparkGrad.addColorStop(0, '#fef08a'); // Bright yellow
        sparkGrad.addColorStop(0.4, '#f97316'); // Orange
        sparkGrad.addColorStop(1, 'rgba(239, 68, 68, 0)');
        ctx.fillStyle = sparkGrad;
        ctx.beginPath();
        ctx.arc(sparkX, bombY, sparkSize, 0, Math.PI * 2);
        ctx.fill();
        
        // Draw small yellow core spark particles
        ctx.fillStyle = '#facc15';
        ctx.beginPath();
        ctx.arc(sparkX + Math.sin(slideElapsed * 60) * 3, bombY + Math.cos(slideElapsed * 55) * 3, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      
      // 3. Draw the Metallic Bomb
      ctx.save();
      // Draw bomb nozzle
      ctx.fillStyle = '#64748b';
      ctx.fillRect(bombX - 8, bombY - 26, 16, 8);
      
      // Draw circular bomb body with metal shine gradient
      const bombGrad = ctx.createRadialGradient(bombX - 7, bombY - 7, 3, bombX, bombY, 24);
      bombGrad.addColorStop(0, '#6b7280'); // Dark gray metal shine
      bombGrad.addColorStop(0.8, '#1f2937'); // Charcoal metal
      bombGrad.addColorStop(1, '#090d16');
      ctx.fillStyle = bombGrad;
      
      // Pulse size of the bomb when getting close to explosion
      const bombPulse = (thinkingProgress < 0.3 && thinkingProgress > 0) ? (1 + 0.08 * Math.sin(slideElapsed * 25)) : 1;
      ctx.beginPath();
      ctx.arc(bombX, bombY, 24 * bombPulse, 0, Math.PI * 2);
      ctx.fill();
      
      // Draw bomb outline/highlight
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      
      // Draw cute cartoon fuse spark reflection/eyes
      ctx.fillStyle = '#f8fafc';
      ctx.beginPath();
      ctx.arc(bombX - 8, bombY - 6, 4, 0, Math.PI * 2); // Left eye/specular highlight
      ctx.arc(bombX - 2, bombY - 11, 2, 0, Math.PI * 2); // Tiny shine
      ctx.fill();
      ctx.restore();
      
      // 4. Explosion Effect! (Draw starburst splash if fuse burns down to 0)
      if (thinkingProgress <= 0.02) {
        ctx.save();
        const splashSize = 65 + 15 * Math.sin(slideElapsed * 50);
        ctx.shadowColor = '#f97316';
        ctx.shadowBlur = 40;
        
        // Starburst path
        ctx.fillStyle = '#facc15'; // Yellow core
        ctx.strokeStyle = '#ef4444'; // Red outer stroke
        ctx.lineWidth = 4;
        ctx.beginPath();
        const points = 12;
        for (let i = 0; i < points * 2; i++) {
          const angle = (i * Math.PI) / points;
          const dist = (i % 2 === 0) ? splashSize : splashSize * 0.45;
          const px = bombX + Math.cos(angle) * dist;
          const py = bombY + Math.sin(angle) * dist;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        
        // Draw "BOOM!" text
        ctx.font = 'bold 24px "Fredoka", sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.shadowBlur = 10;
        ctx.shadowColor = '#000000';
        ctx.fillText("BOOM!", bombX, bombY + 8);
        ctx.restore();
      }
      
      // Label text
      ctx.font = 'bold 18px "Fredoka", sans-serif';
      ctx.fillStyle = '#cbd5e1';
      ctx.textAlign = 'center';
      ctx.fillText("THINKING TIME...", width / 2 + 30, barY - 15);
      ctx.restore();
    }

  } else if (layout === 'quiz_answer') {
    const headerY = 150;
    
    // Header Animation (Elastic spring + breath glow)
    const tVal = Math.min(1, slideElapsed / 0.45);
    const spring = tVal === 1 ? 1 : Math.sin(tVal * Math.PI * 1.85) * Math.pow(2, -7 * tVal) + 1;
    const breath = 1 + 0.02 * Math.sin(slideElapsed * 6.0);
    const scaleFactor = spring * breath;

    ctx.save();
    ctx.globalAlpha = headerEase;
    
    ctx.translate(width / 2, headerY);
    ctx.scale(scaleFactor, scaleFactor);
    ctx.translate(-width / 2, -headerY);
    
    ctx.textAlign = 'center';
    ctx.font = 'bold 50px "Fredoka", sans-serif';
    ctx.fillStyle = '#10b981'; // Emerald Green
    ctx.shadowColor = 'rgba(16, 185, 129, 0.6)';
    ctx.shadowBlur = 12 + 4 * Math.sin(slideElapsed * 6.5);
    ctx.fillText("CORRECT ANSWER!", width / 2, headerY);
    ctx.restore();

    // Explanation Header Animation
    ctx.save();
    ctx.globalAlpha = subEase;
    ctx.translate(0, -15 * (1 - subEase));
    ctx.font = '600 38px "Zen Maru Gothic", sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    const explanationLines = wrapText(ctx, slide.header || '', width - 80);
    let eY = 210;
    for (const line of explanationLines) {
      ctx.fillText(line, width / 2, eY);
      eY += 48;
    }
    ctx.restore();

    // Draw choices staggered animation
    const choices = slide.choices || [];
    const answer = slide.answer || '';
    const buttonW = width - 100;
    const buttonH = 74;
    const buttonX = 50;
    const startButtonY = eY + 20;

    choices.forEach((choice, idx) => {
      const staggerStart = 0.2 + idx * 0.12;
      const t = Math.min(1, Math.max(0, slideElapsed - staggerStart) / 0.35);
      const ease = t * (2 - t);

      ctx.save();
      ctx.globalAlpha = ease;
      ctx.translate(-40 * (1 - ease), 0);

      const bY = startButtonY + idx * (buttonH + 20);
      const isCorrect = choice.toLowerCase().trim() === answer.toLowerCase().trim();

      const bg = isCorrect ? 'rgba(16, 185, 129, 0.25)' : 'rgba(30, 41, 59, 0.4)';
      const stroke = isCorrect ? '#10b981' : 'rgba(255, 255, 255, 0.05)';
      const widthStroke = isCorrect ? 2.5 : 1;

      drawRoundedRect(ctx, buttonX, bY, buttonW, buttonH, 14, bg, stroke, widthStroke);

      ctx.textAlign = 'left';
      if (isCorrect) {
        ctx.font = 'bold 30px "Fredoka", sans-serif';
        ctx.fillStyle = '#10b981';
        ctx.fillText("✓", buttonX + 25, bY + 46);
      } else {
        ctx.font = 'bold 26px "Fredoka", sans-serif';
        ctx.fillStyle = '#64748b';
        ctx.fillText(`${idx + 1}`, buttonX + 25, bY + 46);
      }

      ctx.font = '500 26px "Zen Maru Gothic", sans-serif';
      ctx.fillStyle = isCorrect ? '#ffffff' : '#94a3b8';
      ctx.fillText(choice, buttonX + 60, bY + 46);
      ctx.restore();
    });

    // Subheading explanation box animation (delayed entrance)
    if (slide.sub_header) {
      const tExpl = Math.min(1, Math.max(0, slideElapsed - 0.5) / 0.45);
      const easeExpl = tExpl * (2 - tExpl);

      ctx.save();
      ctx.globalAlpha = easeExpl;
      ctx.translate(0, 30 * (1 - easeExpl));

      const subCardY = startButtonY + choices.length * (buttonH + 20) + 15;
      const subW = width - 100;
      const subH = 130;
      const subX = 50;

      drawRoundedRect(
        ctx,
        subX,
        subCardY,
        subW,
        subH,
        12,
        'rgba(15, 23, 42, 0.5)',
        'rgba(16, 185, 129, 0.2)',
        1
      );

      ctx.font = '20px "Zen Maru Gothic", sans-serif';
      ctx.fillStyle = '#cbd5e1';
      ctx.textAlign = 'left';

      const descLines = wrapText(ctx, slide.sub_header, subW - 30);
      let descY = subCardY + 36;
      for (const line of descLines) {
        if (descY < subCardY + subH - 10) {
          ctx.fillText(line, subX + 15, descY);
          descY += 28;
        }
      }
      ctx.restore();
    }
  }

  // Restore textAlign default
  ctx.textAlign = 'left';
}
