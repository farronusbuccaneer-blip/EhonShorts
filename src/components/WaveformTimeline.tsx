import React, { useRef, useEffect, useState, useMemo } from 'react';
import { AlertCircle } from 'lucide-react';
import type { SilenceGap } from '../utils/audioAnalyzer';

interface WaveformTimelineProps {
  narrationBuffer: AudioBuffer | null;
  timestamps: number[];
  onChangeTimestamps: (newTimestamps: number[]) => void;
  currentTime: number;
  onSeek: (time: number) => void;
  silenceGaps: SilenceGap[];
  slideCount: number;
}

export const WaveformTimeline: React.FC<WaveformTimelineProps> = ({
  narrationBuffer,
  timestamps,
  onChangeTimestamps,
  currentTime,
  onSeek,
  silenceGaps,
  slideCount
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  
  const [draggedMarkerIdx, setDraggedMarkerIdx] = useState<number | null>(null);
  const [hoveredMarkerIdx, setHoveredMarkerIdx] = useState<number | null>(null);

  const duration = narrationBuffer?.duration || 10;

  // Downsample waveform data for rendering
  const peaks = useMemo(() => {
    if (!narrationBuffer) return [];
    
    const channelData = narrationBuffer.getChannelData(0);
    const width = 1000; // Fixed width resolution for sampling
    const step = Math.floor(channelData.length / width);
    const result: number[] = [];

    for (let i = 0; i < width; i++) {
      let max = 0;
      const start = i * step;
      const end = Math.min(start + step, channelData.length);
      for (let j = start; j < end; j++) {
        const val = Math.abs(channelData[j]);
        if (val > max) max = val;
      }
      result.push(max);
    }
    return result;
  }, [narrationBuffer]);

  // Convert mouse X to time offset
  const getTimeFromX = (x: number, rect: DOMRect) => {
    const fraction = x / rect.width;
    return Math.max(0, Math.min(duration, fraction * duration));
  };

  // Convert time offset to canvas X
  const getXFromTime = (time: number, width: number) => {
    return (time / duration) * width;
  };

  // Render the timeline canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Handle high DPI screens
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = rect.height * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    const width = rect.width;
    const height = rect.height;

    ctx.clearRect(0, 0, width, height);

    // 1. Draw Silence Gaps (Subtle red background strips)
    ctx.fillStyle = 'rgba(239, 68, 68, 0.08)'; // Light soft red/pink
    for (const gap of silenceGaps) {
      const startX = getXFromTime(gap.start, width);
      const endX = getXFromTime(gap.end, width);
      ctx.fillRect(startX, 0, endX - startX, height);
      
      // Draw faint dotted boundary for silence
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.25)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(startX, 0);
      ctx.lineTo(startX, height);
      ctx.moveTo(endX, 0);
      ctx.lineTo(endX, height);
      ctx.stroke();
      ctx.setLineDash([]); // reset
    }

    // 2. Draw Waveform Peaks
    if (peaks.length > 0) {
      ctx.fillStyle = 'rgba(99, 102, 241, 0.45)'; // Semi-trans indigo
      const barWidth = width / peaks.length;
      
      for (let i = 0; i < peaks.length; i++) {
        const x = i * barWidth;
        const peakHeight = peaks[i] * (height - 30); // Leave padding for text
        const y = (height - peakHeight) / 2;
        
        ctx.fillRect(x, y, barWidth - 0.5, peakHeight);
      }
    } else {
      // Draw placeholder timeline grid
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 10; i++) {
        const x = (i / 10) * width;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
    }

    // 3. Draw Slide Boundaries (pink markers)
    // Timestamps represent starts of slides. Slide 1 starts at 0, Slide 2 at timestamps[1], etc.
    for (let i = 1; i < slideCount; i++) {
      const time = timestamps[i] !== undefined ? timestamps[i] : (i / slideCount) * duration;
      const x = getXFromTime(time, width);
      const isHovered = hoveredMarkerIdx === i;
      const isDragged = draggedMarkerIdx === i;

      // Draw Marker Line
      ctx.strokeStyle = isDragged 
        ? '#f43f5e' // Bright pink
        : isHovered 
          ? '#fb7185' // Lighter pink
          : 'rgba(244, 63, 94, 0.7)'; // Default pink

      ctx.lineWidth = isHovered || isDragged ? 3 : 2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();

      // Draw Handle Tab at the top
      ctx.fillStyle = ctx.strokeStyle;
      drawRoundedRectTab(ctx, x - 25, 0, 50, 18, 4);
      
      ctx.font = 'bold 9px "Outfit", sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.fillText(`SLIDE ${i + 1}`, x, 12);
    }

    // 4. Draw Current Playhead (neon green)
    const playheadX = getXFromTime(currentTime, width);
    ctx.strokeStyle = '#22c55e'; // Green playhead
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();

    // Playhead handle
    ctx.fillStyle = '#22c55e';
    ctx.beginPath();
    ctx.moveTo(playheadX - 6, 0);
    ctx.lineTo(playheadX + 6, 0);
    ctx.lineTo(playheadX, 8);
    ctx.closePath();
    ctx.fill();

  }, [peaks, timestamps, slideCount, currentTime, duration, silenceGaps, draggedMarkerIdx, hoveredMarkerIdx]);

  // Helper to draw a tab with rounded bottom corners
  const drawRoundedRectTab = (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number
  ) => {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.closePath();
    ctx.fill();
  };

  // Mouse Handlers for Dragging Markers & Seeking
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const clickTime = getTimeFromX(x, rect);

    // Check if clicked close to any slide boundary marker (excluding slide 1 which starts at 0)
    let clickedMarkerIdx = -1;
    let minDistance = 12; // pixels

    for (let i = 1; i < slideCount; i++) {
      const markerTime = timestamps[i] !== undefined ? timestamps[i] : (i / slideCount) * duration;
      const markerX = getXFromTime(markerTime, rect.width);
      const dist = Math.abs(x - markerX);
      if (dist < minDistance) {
        minDistance = dist;
        clickedMarkerIdx = i;
      }
    }

    if (clickedMarkerIdx !== -1) {
      setDraggedMarkerIdx(clickedMarkerIdx);
    } else {
      // Seek to playhead
      onSeek(clickTime);
      setDraggedMarkerIdx(null);
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;

    if (draggedMarkerIdx !== null) {
      // Handle dragging
      const newTime = getTimeFromX(x, rect);

      // Boundaries: cannot cross previous or next slide timestamps
      const prevTime = draggedMarkerIdx > 1 ? timestamps[draggedMarkerIdx - 1] : 0;
      const nextTime = draggedMarkerIdx < slideCount - 1 ? timestamps[draggedMarkerIdx + 1] : duration;

      // Keep minimum gap of 0.2s
      const minBound = prevTime + 0.2;
      const maxBound = nextTime - 0.2;

      const clampedTime = Math.max(minBound, Math.min(maxBound, newTime));

      const updatedTimestamps = [...timestamps];
      updatedTimestamps[draggedMarkerIdx] = clampedTime;
      onChangeTimestamps(updatedTimestamps);
    } else {
      // Check for hover
      let foundHoverIdx = -1;
      const minDistance = 10;

      for (let i = 1; i < slideCount; i++) {
        const markerTime = timestamps[i] !== undefined ? timestamps[i] : (i / slideCount) * duration;
        const markerX = getXFromTime(markerTime, rect.width);
        const dist = Math.abs(x - markerX);
        if (dist < minDistance) {
          foundHoverIdx = i;
          break;
        }
      }
      setHoveredMarkerIdx(foundHoverIdx !== -1 ? foundHoverIdx : null);
    }
  };

  const handleMouseUp = () => {
    setDraggedMarkerIdx(null);
  };

  const formatTime = (time: number) => {
    const min = Math.floor(time / 60);
    const sec = Math.floor(time % 60);
    const ms = Math.floor((time % 1) * 10);
    return `${min}:${sec.toString().padStart(2, '0')}.${ms}`;
  };

  return (
    <div ref={containerRef} className="timeline-container">
      <div className="timeline-header">
        <div className="timeline-title-group">
          <span className="timeline-title">Timeline / Waveform</span>
          {silenceGaps.length > 0 && (
            <div className="timeline-gaps-badge">
              <AlertCircle size={10} />
              <span>{silenceGaps.length} Silence Gaps Detected</span>
            </div>
          )}
        </div>
        <div className="timeline-stats">
          <div>Position: <span className="timeline-stat-val emerald">{formatTime(currentTime)}</span></div>
          <div>Duration: <span className="timeline-stat-val">{formatTime(duration)}</span></div>
        </div>
      </div>

      <div className="timeline-canvas-wrapper">
        <canvas
          ref={canvasRef}
          className={`timeline-canvas ${hoveredMarkerIdx !== null ? 'marker-hover' : ''}`}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        />
      </div>

      <div className="timeline-labels">
        <span>0.0s</span>
        <span>{(duration * 0.25).toFixed(1)}s</span>
        <span>{(duration * 0.5).toFixed(1)}s</span>
        <span>{(duration * 0.75).toFixed(1)}s</span>
        <span>{duration.toFixed(1)}s</span>
      </div>
    </div>
  );
};
export default WaveformTimeline;
