import React, { useState, useRef, useEffect, useCallback } from 'react';
import { parseMarkdown, DEFAULT_MARKDOWN } from './utils/markdownParser';
import type { Slide } from './utils/markdownParser';
import { decodeAudio, detectSilenceGaps, alignSlidesHeuristically, generateTtsNarration } from './utils/audioAnalyzer';
import type { SilenceGap } from './utils/audioAnalyzer';
import { calculateDuckingEnvelope, scheduleDucking } from './utils/audioMixer';
import type { DuckingParams } from './utils/audioMixer';
import { exportVideo } from './utils/videoExporter';
import { VideoPreview } from './components/VideoPreview';
import { WaveformTimeline } from './components/WaveformTimeline';
import { 
  Film, Music, FileText, Download, 
  AlertTriangle, Check, Sparkles, 
  Waves, Sliders, Mic, Copy
} from 'lucide-react';
import confetti from 'canvas-confetti';

interface AudioPlaybackState {
  audioCtx: AudioContext | null;
  narrationSource: AudioBufferSourceNode | null;
  bgmSource: AudioBufferSourceNode | null;
  narrationGain: GainNode | null;
  bgmGain: GainNode | null;
  startTime: number;
  offset: number;
  timerId: number | null;
}

export default function App() {
  // 1. Assets State
  const [activeTab, setActiveTab] = useState<'script' | 'notes' | 'assets' | 'settings'>('script');
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoFileName, setVideoFileName] = useState<string>('');
  const [narrationFileName, setNarrationFileName] = useState<string>('');
  const [narrationBuffer, setNarrationBuffer] = useState<AudioBuffer | null>(null);
  const [bgmFile, setBgmFile] = useState<File | null>(null);
  const [bgmFileName, setBgmFileName] = useState<string>('');
  const [bgmBuffer, setBgmBuffer] = useState<AudioBuffer | null>(null);

  // 2. Markdown & Slide State
  const [markdownText, setMarkdownText] = useState<string>(DEFAULT_MARKDOWN);
  const [parsedData, setParsedData] = useState(() => parseMarkdown(DEFAULT_MARKDOWN));
  const [timestamps, setTimestamps] = useState<number[]>([]);

  // 3. Audio Silence / Ducking Parameters
  const [silenceThresholdDb, setSilenceThresholdDb] = useState<number>(-38);
  const [minSilenceDuration, setMinSilenceDuration] = useState<number>(0.55);
  const [silenceGaps, setSilenceGaps] = useState<SilenceGap[]>([]);

  const [duckingParams, setDuckingParams] = useState<DuckingParams>({
    bgmVolume: 0.3,
    duckedVolume: 0.05,
    thresholdDb: -32,
    duckSpeed: 0.12,
    restoreSpeed: 0.35,
    holdTime: 0.45
  });

  // 4. Playback State
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isTapSyncMode, setIsTapSyncMode] = useState<boolean>(false);
  const [useVoiceVox, setUseVoiceVox] = useState<boolean>(false);

  // API Key States (persisted in browser localStorage)
  const [openAiApiKey, setOpenAiApiKey] = useState<string>(() => localStorage.getItem('ehon_openai_key') || '');
  const [openAiVoice, setOpenAiVoice] = useState<string>(() => localStorage.getItem('ehon_openai_voice') || 'alloy');
  const [voiceRssApiKey, setVoiceRssApiKey] = useState<string>(() => localStorage.getItem('ehon_voicerss_key') || '');

  useEffect(() => {
    localStorage.setItem('ehon_openai_key', openAiApiKey);
  }, [openAiApiKey]);

  useEffect(() => {
    localStorage.setItem('ehon_openai_voice', openAiVoice);
  }, [openAiVoice]);

  useEffect(() => {
    localStorage.setItem('ehon_voicerss_key', voiceRssApiKey);
  }, [voiceRssApiKey]);

  // 5. Exporter & Loader State
  const [loadingText, setLoadingText] = useState<string>('');
  const [exportProgress, setExportProgress] = useState<number>(0);
  const [exportedBlob, setExportedBlob] = useState<Blob | null>(null);
  const [exportMimeType, setExportMimeType] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // References for playback
  const playbackRef = useRef<AudioPlaybackState>({
    audioCtx: null,
    narrationSource: null,
    bgmSource: null,
    narrationGain: null,
    bgmGain: null,
    startTime: 0,
    offset: 0,
    timerId: null
  });

  // Track the total duration of the narration track or default proportional slides duration
  const narrationDuration = narrationBuffer?.duration || Math.max(parsedData.slides.length * 3.0, 10.0);

  // 6. Handle Markdown text parsing
  useEffect(() => {
    try {
      const data = parseMarkdown(markdownText);
      setParsedData(data);
      setErrorMessage(null);
    } catch (e: any) {
      setErrorMessage(`Markdown parsing error: ${e.message}`);
    }
  }, [markdownText]);

  // If slides count changes, ensure timestamps array matches slide count
  useEffect(() => {
    const slideCount = parsedData.slides.length;
    if (slideCount === 0) return;

    setTimestamps(prev => {
      // If same length, keep
      if (prev.length === slideCount) return prev;

      // If different length, generate proportional markers as default
      const newTimestamps = [0];
      for (let i = 1; i < slideCount; i++) {
        newTimestamps.push((i / slideCount) * narrationDuration);
      }
      return newTimestamps;
    });
  }, [parsedData.slides.length, narrationDuration]);

  // 7. Auto-detect Silence gaps from Narration
  const runSilenceDetection = useCallback((buffer: AudioBuffer) => {
    try {
      const gaps = detectSilenceGaps(buffer, silenceThresholdDb, minSilenceDuration);
      setSilenceGaps(gaps);
      return gaps;
    } catch (e: any) {
      setErrorMessage(`Silence detection failed: ${e.message}`);
      return [];
    }
  }, [silenceThresholdDb, minSilenceDuration]);

  // 8. Auto-align slides heuristically and snap to silence
  const runAutoAlignment = useCallback((
    slides: Slide[],
    duration: number,
    gaps: SilenceGap[]
  ) => {
    if (slides.length <= 1) {
      setTimestamps([0]);
      return;
    }
    const aligned = alignSlidesHeuristically(slides, duration, gaps);
    setTimestamps(aligned);
  }, []);

  // 9. Narration Upload & Decoding
  const handleNarrationUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setNarrationFileName(file.name);
    setLoadingText('Decoding narration audio...');
    stopAudioPlayback();

    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const tempCtx = playbackRef.current.audioCtx || new AudioContextClass();
      playbackRef.current.audioCtx = tempCtx;

      const buffer = await decodeAudio(file, tempCtx);
      setNarrationBuffer(buffer);

      // Auto-detect silence and perform slide synchronization
      setLoadingText('Detecting silences and syncing slides...');
      const gaps = detectSilenceGaps(buffer, silenceThresholdDb, minSilenceDuration);
      setSilenceGaps(gaps);

      if (parsedData.slides.length > 0) {
        const aligned = alignSlidesHeuristically(parsedData.slides, buffer.duration, gaps);
        setTimestamps(aligned);
      }

      setErrorMessage(null);
    } catch (err: any) {
      setErrorMessage(`Failed to decode narration file: ${err.message}`);
      setNarrationFileName('');
    } finally {
      setLoadingText('');
    }
  };

  // Automated TTS Narration Generation
  const handleGenerateTts = async () => {
    if (parsedData.slides.length === 0) return;

    setLoadingText('Generating automated AI TTS narration...');
    stopAudioPlayback();

    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = playbackRef.current.audioCtx || new AudioContextClass();
      playbackRef.current.audioCtx = ctx;

      const { buffer, timestamps: ttsTimestamps } = await generateTtsNarration(
        parsedData.slides, 
        ctx, 
        useVoiceVox,
        {
          openAiKey: openAiApiKey,
          voiceRssKey: voiceRssApiKey,
          openAiVoice: openAiVoice
        }
      );
      
      setNarrationBuffer(buffer);
      setNarrationFileName('Generated AI Narration (TTS)');
      setTimestamps(ttsTimestamps);
      setCurrentTime(0);
      setErrorMessage(null);
    } catch (err: any) {
      setErrorMessage(
        `音声合成の生成に失敗しました: ${err.message}\n\n` +
        `【解決策】\n` +
        `本番環境（GitHub Pages）で直接音声ファイルを生成し、動画に含めてダウンロードするにはAPIキーの設定が必要です。\n` +
        `「Settings」タブを開き、以下のいずれかのAPIキーを設定して再度お試しください：\n` +
        `① OpenAI API Key（極めて高品質なAI音声になります）\n` +
        `② VoiceRSS API Key（無料で即座に取得できる無料キーです）`
      );
    } finally {
      setLoadingText('');
    }
  };

  // 10. BGM Upload & Decoding
  const handleBgmUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setBgmFileName(file.name);
    setLoadingText('Decoding BGM audio...');
    stopAudioPlayback();

    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const tempCtx = playbackRef.current.audioCtx || new AudioContextClass();
      playbackRef.current.audioCtx = tempCtx;

      const buffer = await decodeAudio(file, tempCtx);
      setBgmBuffer(buffer);
      setBgmFile(file);
      setErrorMessage(null);
    } catch (err: any) {
      setErrorMessage(`Failed to decode BGM file: ${err.message}`);
      setBgmFile(null);
      setBgmFileName('');
    } finally {
      setLoadingText('');
    }
  };

  // 11. Audio Playback Control Loop
  const stopAudioPlayback = useCallback((resetToZero = false) => {
    if (playbackRef.current.timerId) {
      clearInterval(playbackRef.current.timerId);
      playbackRef.current.timerId = null;
    }

    try {
      if (playbackRef.current.narrationSource) {
        playbackRef.current.narrationSource.stop();
        playbackRef.current.narrationSource.disconnect();
        playbackRef.current.narrationSource = null;
      }
      if (playbackRef.current.bgmSource) {
        playbackRef.current.bgmSource.stop();
        playbackRef.current.bgmSource.disconnect();
        playbackRef.current.bgmSource = null;
      }
    } catch (e) {
      // Audio source already stopped
    }

    setIsPlaying(false);
    if (resetToZero) {
      setCurrentTime(0);
    }
  }, []);

  const startAudioPlayback = useCallback((startFrom: number) => {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = playbackRef.current.audioCtx || new AudioContextClass();
    playbackRef.current.audioCtx = ctx;

    // Ensure we start fresh
    stopAudioPlayback(false);

    if (ctx.state === 'suspended') {
      ctx.resume();
    }

    const startTime = ctx.currentTime;
    const totalDuration = narrationBuffer?.duration || Math.max(parsedData.slides.length * 3.0, 10.0);

    // Narration configuration
    let nSource = null;
    let nGain = null;
    if (narrationBuffer) {
      nSource = ctx.createBufferSource();
      nSource.buffer = narrationBuffer;
      nGain = ctx.createGain();
      nGain.gain.value = 1.0;
      
      nSource.connect(nGain);
      nGain.connect(ctx.destination);
      
      playbackRef.current.narrationSource = nSource;
      playbackRef.current.narrationGain = nGain;
      nSource.start(0, startFrom);
    }

    // BGM configuration
    let bSource = null;
    const bGain = ctx.createGain();
    
    if (bgmBuffer) {
      bSource = ctx.createBufferSource();
      bSource.buffer = bgmBuffer;
      bSource.loop = true;

      // BGM Gain node setup
      bGain.gain.value = duckingParams.bgmVolume;
      bSource.connect(bGain);
      bGain.connect(ctx.destination);

      if (narrationBuffer) {
        // Generate ducking schedule
        const volumeEnvelope = calculateDuckingEnvelope(narrationBuffer, duckingParams);
        // Schedule BGM ducking envelope
        scheduleDucking(bGain, volumeEnvelope, startTime, startFrom, duckingParams);
      } else {
        bGain.gain.setValueAtTime(duckingParams.bgmVolume, 0);
      }
      
      playbackRef.current.bgmSource = bSource;
      playbackRef.current.bgmGain = bGain;
      bSource.start(0, startFrom);
    }

    playbackRef.current.startTime = startTime;
    playbackRef.current.offset = startFrom;

    setIsPlaying(true);

    const playTimerStart = performance.now();

    const intervalId = window.setInterval(() => {
      let elapsed = 0;
      if (narrationBuffer) {
        elapsed = ctx.currentTime - playbackRef.current.startTime + playbackRef.current.offset;
      } else {
        elapsed = ((performance.now() - playTimerStart) / 1000) + startFrom;
      }

      if (elapsed >= totalDuration) {
        stopAudioPlayback(true);
      } else {
        setCurrentTime(elapsed);
      }
    }, 33);
    playbackRef.current.timerId = intervalId;

  }, [narrationBuffer, bgmBuffer, duckingParams, stopAudioPlayback, parsedData.slides.length]);

  const handleTogglePlay = () => {
    if (isPlaying) {
      stopAudioPlayback();
    } else {
      startAudioPlayback(currentTime);
    }
  };

  const handleSeek = (time: number) => {
    const clamped = Math.max(0, Math.min(narrationDuration, time));
    setCurrentTime(clamped);
    if (isPlaying) {
      startAudioPlayback(clamped);
    }
  };

  const handleRestart = () => {
    setCurrentTime(0);
    if (isPlaying) {
      startAudioPlayback(0);
    }
  };

  // 12. Tap Sync Mode (Spacebar or Button advancement)
  const handleMarkNextSlide = useCallback(() => {
    // Find what slide is current based on timestamps
    let activeIdx = 0;
    for (let i = 0; i < parsedData.slides.length; i++) {
      if (timestamps[i] <= currentTime) {
        activeIdx = i;
      } else {
        break;
      }
    }

    // Advance to next slide if possible
    if (activeIdx < parsedData.slides.length - 1) {
      const updated = [...timestamps];
      updated[activeIdx + 1] = currentTime;
      setTimestamps(updated);
    }
  }, [parsedData.slides.length, timestamps, currentTime]);

  // Listen for Spacebar in Tap Sync Mode
  useEffect(() => {
    if (!isTapSyncMode) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault();
        handleMarkNextSlide();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isTapSyncMode, handleMarkNextSlide]);

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      if (playbackRef.current.timerId) {
        clearInterval(playbackRef.current.timerId);
      }
    };
  }, []);

  // 13. Re-run analysis commands manually
  const triggerRecalculateGaps = () => {
    if (!narrationBuffer) return;
    const gaps = runSilenceDetection(narrationBuffer);
    runAutoAlignment(parsedData.slides, narrationBuffer.duration, gaps);
  };

  // 14. Export Video Implementation
  const handleExportVideo = async () => {
    if (!narrationBuffer) {
      setErrorMessage("Narration voice file is required to export video.");
      return;
    }

    stopAudioPlayback();
    setExportProgress(0);
    setExportedBlob(null);
    setLoadingText('Compiling and exporting video...');

    try {
      const blob = await exportVideo({
        videoFile,
        narrationBuffer,
        bgmBuffer,
        slides: parsedData.slides,
        timestamps,
        duckingParams,
        title: parsedData.title,
        hook: parsedData.hook,
        onProgress: (p) => setExportProgress(p)
      });

      setExportedBlob(blob);
      setExportMimeType(blob.type);
      setErrorMessage(null);

      // Fire confetti blast!
      confetti({
        particleCount: 150,
        spread: 80,
        origin: { y: 0.6 }
      });
    } catch (err: any) {
      setErrorMessage(`Export failed: ${err.message}`);
    } finally {
      setLoadingText('');
    }
  };

  const handleDownloadFile = () => {
    if (!exportedBlob) return;
    const ext = exportMimeType.includes('mp4') ? 'mp4' : 'webm';
    const link = document.createElement('a');
    link.href = URL.createObjectURL(exportedBlob);
    link.download = `ehon_short_${Date.now()}.${ext}`;
    link.click();
  };

  return (
    <div className="app-container">
      {/* 1. Header */}
      <header className="app-header">
        <div className="header-brand">
          <div className="brand-icon">
            <Sparkles size={18} />
          </div>
          <div className="brand-title-group">
            <h1>EHON SHORTS STUDIO</h1>
            <p>Idiom & Quiz Video Generator v2</p>
          </div>
        </div>

        {/* Global Export & Download Buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {exportedBlob && (
            <button 
              onClick={handleDownloadFile} 
              className="btn-primary" 
              style={{ background: '#10b981', border: '1px solid #059669', display: 'flex', alignItems: 'center', gap: '0.375rem' }}
            >
              <Download size={16} />
              <span>Download Video</span>
            </button>
          )}
          {narrationBuffer ? (
            <button onClick={handleExportVideo} className="btn-primary">
              <Sparkles size={14} />
              <span>{exportedBlob ? 'Re-Export MP4' : 'Export MP4'}</span>
            </button>
          ) : (
            <div style={{ color: '#f87171', display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '11px', fontWeight: 600 }}>
              <AlertTriangle size={12} />
              <span>Upload narration to export</span>
            </div>
          )}
        </div>
      </header>

      {/* Main Workspace */}
      <main className="workspace">
        <div className="editor-grid">
          {/* Player column */}
          <div className="player-column">
            <VideoPreview
              videoFile={videoFile}
              slides={parsedData.slides}
              timestamps={timestamps}
              currentTime={currentTime}
              isPlaying={isPlaying}
              onTogglePlay={handleTogglePlay}
              onRestart={handleRestart}
              narrationBuffer={narrationBuffer}
              thresholdDb={duckingParams.thresholdDb}
              holdTime={duckingParams.holdTime}
              title={parsedData.title}
              hook={parsedData.hook}
            />

            {/* Interactive Tap-Sync helper */}
            <div style={{ width: '100%', maxWidth: '324px', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <button
                disabled={!narrationBuffer}
                onClick={() => {
                  setIsTapSyncMode(!isTapSyncMode);
                  if (!isTapSyncMode) {
                    setCurrentTime(0);
                    startAudioPlayback(0);
                  } else {
                    stopAudioPlayback();
                  }
                }}
                className="btn-secondary"
                style={{ width: '100%', borderColor: isTapSyncMode ? '#ef4444' : 'rgba(255,255,255,0.08)' }}
              >
                <Waves size={14} />
                <span>{isTapSyncMode ? 'Stop Tap Syncing' : 'Start Interactive Tap-Sync'}</span>
              </button>

              {isTapSyncMode && (
                <div style={{ background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.2)', padding: '1rem', borderRadius: '0.75rem' }}>
                  <div style={{ color: '#f43f5e', fontSize: '0.75rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.25rem', marginBottom: '0.5rem' }}>
                    <AlertTriangle size={12} />
                    <span>Interactive Tap Sync Active</span>
                  </div>
                  <p style={{ margin: '0 0 0.75rem 0', fontSize: '11px', color: '#94a3b8', lineHeight: 1.4 }}>
                    Play the audio and click the button below (or press <kbd style={{ background: '#1e293b', padding: '1px 3px', border: '1px solid #334155', borderRadius: '3px', fontFamily: 'monospace' }}>Spacebar</kbd>) when each slide should start.
                  </p>
                  <button
                    onClick={handleMarkNextSlide}
                    className="btn-primary"
                    style={{ width: '100%', padding: '0.5rem' }}
                  >
                    <span>Mark Next Slide →</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Simple Tab Control Panel column */}
          <div className="control-column">
            <div className="tabs-header">
              <button
                className={`tab-btn ${activeTab === 'script' ? 'active' : ''}`}
                onClick={() => setActiveTab('script')}
              >
                <FileText size={16} />
                <span>Script</span>
              </button>
              <button
                className={`tab-btn ${activeTab === 'notes' ? 'active' : ''}`}
                onClick={() => setActiveTab('notes')}
              >
                <Mic size={16} />
                <span>台本 (Voiceover)</span>
              </button>
              <button
                className={`tab-btn ${activeTab === 'assets' ? 'active' : ''}`}
                onClick={() => setActiveTab('assets')}
              >
                <Waves size={16} />
                <span>Assets</span>
              </button>
              <button
                className={`tab-btn ${activeTab === 'settings' ? 'active' : ''}`}
                onClick={() => setActiveTab('settings')}
              >
                <Sliders size={16} />
                <span>Settings</span>
              </button>
            </div>

            <div className="tab-content">
              {activeTab === 'script' && (
                <div className="editor-container">
                  <div className="textarea-wrapper">
                    <textarea
                      value={markdownText}
                      onChange={(e) => setMarkdownText(e.target.value)}
                      spellCheck={false}
                      className="markdown-textarea"
                      placeholder="Input slide markdown script..."
                    />
                  </div>
                  
                  {/* Small Slide Badge Grid */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                    {parsedData.slides.map((s, idx) => (
                      <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', background: 'rgba(255, 255, 255, 0.04)', border: '1px solid rgba(255, 255, 255, 0.05)', padding: '0.25rem 0.5rem', borderRadius: '0.375rem', fontSize: '10px' }}>
                        <span style={{ color: '#64748b', fontWeight: 'bold' }}>#{s.id}</span>
                        <span style={{ color: '#94a3b8' }}>{s.layout}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {activeTab === 'notes' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  <div style={{ background: 'rgba(59, 130, 246, 0.08)', border: '1px solid rgba(59, 130, 246, 0.2)', padding: '1rem', borderRadius: '0.75rem' }}>
                    <div style={{ color: '#60a5fa', fontSize: '0.75rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.25rem', marginBottom: '0.5rem' }}>
                      <Mic size={12} />
                      <span>読み上げ用台本 (Speaker Notes)</span>
                    </div>
                    <p style={{ margin: 0, fontSize: '11px', color: '#94a3b8', lineHeight: 1.4 }}>
                      外部の音声合成ツールやマイクを使用して録音する際は、以下の台本をご利用ください。録音した音声ファイルは「Assets」タブからアップロードできます。
                    </p>
                  </div>

                  <button
                    onClick={() => {
                      const allText = parsedData.slides.map((s, idx) => {
                        const isLast = idx === parsedData.slides.length - 1;
                        return `${s.header || ''}\n${!isLast && s.sub_header ? s.sub_header : ''}`.trim();
                      }).filter(t => t.length > 0).join('\n\n');
                      
                      navigator.clipboard.writeText(allText);
                      alert('すべてのスライドの台本を一括コピーしました！');
                    }}
                    className="btn-primary"
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', padding: '0.75rem' }}
                  >
                    <Copy size={16} />
                    <span>台本を一括コピー (Copy All)</span>
                  </button>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    {parsedData.slides.map((s, idx) => {
                      const isLast = idx === parsedData.slides.length - 1;
                      const textToRead = `${s.header || ''}\n${!isLast && s.sub_header ? s.sub_header : ''}`.trim();
                      
                      return (
                        <div key={idx} className="upload-card" style={{ padding: '1rem' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                            <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#e2e8f0' }}>
                              Slide {s.id} ({s.layout})
                            </span>
                            <button
                              onClick={() => {
                                navigator.clipboard.writeText(textToRead);
                                alert(`Slide ${s.id} の台本をコピーしました！`);
                              }}
                              className="btn-secondary"
                              style={{ padding: '0.25rem 0.5rem', fontSize: '10px', width: 'auto', display: 'flex', gap: '0.25rem', alignItems: 'center' }}
                            >
                              <Copy size={10} />
                              <span>Copy</span>
                            </button>
                          </div>
                          
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', background: 'rgba(0, 0, 0, 0.2)', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid rgba(255,255,255,0.03)' }}>
                            {s.header && (
                              <div style={{ display: 'flex', gap: '0.5rem', fontSize: '12px' }}>
                                <span style={{ color: '#38bdf8', fontWeight: 600, minWidth: '45px' }}>英語:</span>
                                <span style={{ color: '#f1f5f9', wordBreak: 'break-all' }}>{s.header}</span>
                              </div>
                            )}
                            {!isLast && s.sub_header && (
                              <div style={{ display: 'flex', gap: '0.5rem', fontSize: '12px' }}>
                                <span style={{ color: '#fb7185', fontWeight: 600, minWidth: '45px' }}>日本語:</span>
                                <span style={{ color: '#cbd5e1', wordBreak: 'break-all' }}>{s.sub_header}</span>
                              </div>
                            )}
                            {isLast && (
                              <div style={{ fontSize: '10px', color: '#64748b', fontStyle: 'italic', marginTop: '0.25rem' }}>
                                ※ 最終スライドの日本語サブヘッダーは読み上げられません。
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {activeTab === 'assets' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  {/* 1. Narration */}
                  <div className="upload-card">
                    <label className="upload-label">
                      <span>Narration Audio <span style={{ color: '#f87171' }}>*Required</span></span>
                      {narrationBuffer && <span style={{ fontFamily: 'monospace' }}>{narrationDuration.toFixed(1)}s</span>}
                    </label>
                    <div className="upload-dropzone">
                      <input
                        type="file"
                        accept="audio/mp3,audio/wav,audio/m4a,audio/mpeg"
                        onChange={handleNarrationUpload}
                        style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
                      />
                      <div className="upload-icon-box blue">
                        <Music size={16} />
                      </div>
                      <div className="upload-info">
                        <p className="upload-filename">{narrationFileName || 'Select narration file'}</p>
                        <p className="upload-desc">Controls scene timings</p>
                      </div>
                      {narrationBuffer && (
                        <span style={{ color: '#10b981', display: 'flex' }}><Check size={16} /></span>
                      )}
                    </div>
                    
                    <button
                      onClick={handleGenerateTts}
                      className="btn-secondary"
                      style={{ 
                        marginTop: '0.75rem', 
                        width: '100%', 
                        fontSize: '11px', 
                        padding: '0.45rem', 
                        display: 'flex', 
                        alignItems: 'center', 
                        justifyContent: 'center', 
                        gap: '0.375rem',
                        background: 'rgba(99, 102, 241, 0.1)',
                        border: '1px solid rgba(99, 102, 241, 0.25)',
                        color: '#818cf8',
                        borderRadius: '0.5rem',
                        cursor: 'pointer'
                      }}
                    >
                      <Sparkles size={12} />
                      <span>Generate AI Narration (TTS)</span>
                    </button>
                    
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem', fontSize: '11px', color: '#94a3b8' }}>
                      <input
                        type="checkbox"
                        id="use-voicevox-chk"
                        checked={useVoiceVox}
                        onChange={(e) => setUseVoiceVox(e.target.checked)}
                        style={{ cursor: 'pointer' }}
                      />
                      <label htmlFor="use-voicevox-chk" style={{ cursor: 'pointer', userSelect: 'none' }}>
                        Use VOICEVOX (Local app must be running)
                      </label>
                    </div>
                  </div>

                  {/* 2. Video */}
                  <div className="upload-card">
                    <label className="upload-label">Background Video (Optional)</label>
                    <div className="upload-dropzone">
                      <input
                        type="file"
                        accept="video/mp4,video/quicktime"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) {
                            setVideoFile(file);
                            setVideoFileName(file.name);
                          }
                        }}
                        style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
                      />
                      <div className="upload-icon-box pink">
                        <Film size={16} />
                      </div>
                      <div className="upload-info">
                        <p className="upload-filename">{videoFileName || 'Select background video'}</p>
                        <p className="upload-desc">Underlays overlays</p>
                      </div>
                      {videoFile && (
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            setVideoFile(null);
                            setVideoFileName('');
                          }}
                          className="upload-btn-clear"
                        >
                          Clear
                        </button>
                      )}
                    </div>
                  </div>

                  {/* 3. BGM */}
                  <div className="upload-card">
                    <label className="upload-label">BGM Track (Optional)</label>
                    <div className="upload-dropzone">
                      <input
                        type="file"
                        accept="audio/mp3,audio/wav,audio/mpeg"
                        onChange={handleBgmUpload}
                        style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
                      />
                      <div className="upload-icon-box amber">
                        <Music size={16} />
                      </div>
                      <div className="upload-info">
                        <p className="upload-filename">{bgmFileName || 'Select BGM track'}</p>
                        <p className="upload-desc">Ducks during speech</p>
                      </div>
                      {bgmFile && (
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            setBgmFile(null);
                            setBgmFileName('');
                            setBgmBuffer(null);
                            stopAudioPlayback();
                          }}
                          className="upload-btn-clear"
                        >
                          Clear
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'settings' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                  {/* Silence Settings */}
                  <div>
                    <h4 className="settings-section-title">Silence Alignment</h4>
                    <div className="settings-grid">
                      <div className="slider-group">
                        <div className="slider-header">
                          <span>Threshold</span>
                          <span className="slider-val">{silenceThresholdDb} dB</span>
                        </div>
                        <input
                          type="range"
                          min="-65"
                          max="-20"
                          step="1"
                          value={silenceThresholdDb}
                          onChange={(e) => setSilenceThresholdDb(parseInt(e.target.value, 10))}
                        />
                      </div>
                      <div className="slider-group">
                        <div className="slider-header">
                          <span>Min Gap</span>
                          <span className="slider-val">{minSilenceDuration}s</span>
                        </div>
                        <input
                          type="range"
                          min="0.2"
                          max="2.0"
                          step="0.05"
                          value={minSilenceDuration}
                          onChange={(e) => setMinSilenceDuration(parseFloat(e.target.value))}
                        />
                      </div>
                    </div>
                    <button
                      disabled={!narrationBuffer}
                      onClick={triggerRecalculateGaps}
                      className="btn-secondary"
                      style={{ width: '100%', fontSize: '11px', padding: '0.45rem', marginTop: '0.75rem' }}
                    >
                      <Sparkles size={12} />
                      <span>Re-Run Auto Silence Sync</span>
                    </button>
                  </div>

                  {/* BGM Ducking settings */}
                  <div>
                    <h4 className="settings-section-title">Smart BGM Ducking</h4>
                    <div className="settings-grid">
                      <div className="slider-group">
                        <div className="slider-header">
                          <span>Normal BGM Vol</span>
                          <span className="slider-val">{Math.round(duckingParams.bgmVolume * 100)}%</span>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.05"
                          value={duckingParams.bgmVolume}
                          onChange={(e) => setDuckingParams(prev => ({ ...prev, bgmVolume: parseFloat(e.target.value) }))}
                        />
                      </div>
                      <div className="slider-group">
                        <div className="slider-header">
                          <span>Ducked BGM Vol</span>
                          <span className="slider-val">{Math.round(duckingParams.duckedVolume * 100)}%</span>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="0.5"
                          step="0.01"
                          value={duckingParams.duckedVolume}
                          onChange={(e) => setDuckingParams(prev => ({ ...prev, duckedVolume: parseFloat(e.target.value) }))}
                        />
                      </div>
                      <div className="slider-group">
                        <div className="slider-header">
                          <span>Speech Trigger</span>
                          <span className="slider-val">{duckingParams.thresholdDb} dB</span>
                        </div>
                        <input
                          type="range"
                          min="-60"
                          max="-15"
                          step="1"
                          value={duckingParams.thresholdDb}
                          onChange={(e) => setDuckingParams(prev => ({ ...prev, thresholdDb: parseInt(e.target.value, 10) }))}
                        />
                      </div>
                      <div className="slider-group">
                        <div className="slider-header">
                          <span>Hold Delay</span>
                          <span className="slider-val">{duckingParams.holdTime}s</span>
                        </div>
                        <input
                          type="range"
                          min="0.1"
                          max="1.5"
                          step="0.05"
                          value={duckingParams.holdTime}
                          onChange={(e) => setDuckingParams(prev => ({ ...prev, holdTime: parseFloat(e.target.value) }))}
                        />
                      </div>
                    </div>
                  </div>

                  {/* API Key Configuration */}
                  <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '1.25rem' }}>
                    <h4 className="settings-section-title" style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                      <Sliders size={12} />
                      <span>TTS API Keys (For Production Video Export)</span>
                    </h4>
                    <p style={{ margin: '0 0 1rem 0', fontSize: '11px', color: '#94a3b8', lineHeight: 1.4 }}>
                      本番環境（GitHub Pages）で音声入りの動画を直接書き出すには、以下のいずれかのAPIキーを入力してください。キーはあなたのブラウザのみに安全に保存されます。
                    </p>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                      {/* OpenAI API Key */}
                      <div className="slider-group" style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', fontWeight: 600 }}>
                          <span style={{ color: '#818cf8' }}>① OpenAI API Key</span>
                          <span style={{ color: '#64748b' }}>高品質AI音声 (有料キー)</span>
                        </div>
                        <input
                          type="password"
                          value={openAiApiKey}
                          onChange={(e) => setOpenAiApiKey(e.target.value)}
                          placeholder="sk-proj-..."
                          style={{
                            background: 'rgba(0,0,0,0.2)',
                            border: '1px solid rgba(255,255,255,0.08)',
                            borderRadius: '0.375rem',
                            padding: '0.45rem 0.6rem',
                            color: '#fff',
                            fontSize: '11px',
                            width: '100%',
                            fontFamily: 'monospace'
                          }}
                        />
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.25rem' }}>
                          <span style={{ fontSize: '10px', color: '#64748b' }}>Voice:</span>
                          <select
                            value={openAiVoice}
                            onChange={(e) => setOpenAiVoice(e.target.value)}
                            style={{
                              background: '#1e293b',
                              border: '1px solid rgba(255,255,255,0.08)',
                              borderRadius: '0.25rem',
                              padding: '0.15rem 0.35rem',
                              color: '#fff',
                              fontSize: '10px'
                            }}
                          >
                            <option value="alloy">alloy (Standard)</option>
                            <option value="echo">echo</option>
                            <option value="fable">fable</option>
                            <option value="onyx">onyx (Male)</option>
                            <option value="nova">nova (Female)</option>
                            <option value="shimmer">shimmer</option>
                          </select>
                        </div>
                      </div>

                      {/* VoiceRSS API Key */}
                      <div className="slider-group" style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', fontWeight: 600 }}>
                          <span style={{ color: '#34d399' }}>② VoiceRSS API Key</span>
                          <a 
                            href="https://www.voicerss.org/" 
                            target="_blank" 
                            rel="noopener noreferrer" 
                            style={{ color: '#60a5fa', textDecoration: 'underline' }}
                          >
                            無料キーを取得 (Get Free Key)
                          </a>
                        </div>
                        <input
                          type="password"
                          value={voiceRssApiKey}
                          onChange={(e) => setVoiceRssApiKey(e.target.value)}
                          placeholder="Get free key at voicerss.org (350 reqs/day)"
                          style={{
                            background: 'rgba(0,0,0,0.2)',
                            border: '1px solid rgba(255,255,255,0.08)',
                            borderRadius: '0.375rem',
                            padding: '0.45rem 0.6rem',
                            color: '#fff',
                            fontSize: '11px',
                            width: '100%',
                            fontFamily: 'monospace'
                          }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Timeline Row */}
        <div style={{ width: '100%', marginTop: '1rem' }}>
          <WaveformTimeline
            narrationBuffer={narrationBuffer}
            timestamps={timestamps}
            onChangeTimestamps={setTimestamps}
            currentTime={currentTime}
            onSeek={handleSeek}
            silenceGaps={silenceGaps}
            slideCount={parsedData.slides.length}
          />
        </div>
      </main>

      {/* Error alert toast */}
      {errorMessage && (
        <div className="toast-container">
          <AlertTriangle style={{ flexShrink: 0, color: '#f87171', marginTop: '2px' }} size={16} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#fff' }}>Sync Error</div>
            <p style={{ margin: '0.25rem 0 0 0', fontSize: '11px', color: '#fca5a5', lineHeight: 1.3 }}>{errorMessage}</p>
          </div>
          <button
            onClick={() => setErrorMessage(null)}
            style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '10px', fontWeight: 700 }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Export & Loading Overlay Modal */}
      {(loadingText || exportedBlob) && (
        <div className="modal-overlay">
          <div className="modal-card">
            {loadingText ? (
              <>
                <div className="modal-progress-ring">
                  <div style={{ width: '80px', height: '80px', borderRadius: '50%', border: '4px solid rgba(255,255,255,0.05)', borderTopColor: '#6366f1', animation: 'spin 1s linear infinite' }} />
                  {exportProgress > 0 && (
                    <div className="modal-progress-label">
                      {exportProgress}%
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: '#fff' }}>
                    {loadingText}
                  </h3>
                  <p style={{ margin: 0, fontSize: '11px', color: '#64748b' }}>
                    Keep this tab active during encoding.
                  </p>
                </div>

                {exportProgress > 0 && (
                  <div style={{ width: '100%', height: '6px', background: 'rgba(255,255,255,0.05)', borderRadius: '3px', overflow: 'hidden' }}>
                    <div 
                      style={{ background: 'linear-gradient(to right, #6366f1, #ec4899)', height: '100%', width: `${exportProgress}%`, transition: 'all 0.3s' }}
                    />
                  </div>
                )}
              </>
            ) : (
              <>
                <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: 'rgba(16, 185, 129, 0.15)', color: '#10b981', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid rgba(16, 185, 129, 0.2)' }}>
                  <Check size={24} style={{ margin: 'auto' }} />
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  <h3 style={{ margin: 0, fontSize: '1.125rem', fontWeight: 700, color: '#fff' }}>
                    Video Compiled!
                  </h3>
                  <p style={{ margin: 0, fontSize: '11px', color: '#94a3b8' }}>
                    Your output is ready for download.
                  </p>
                </div>

                <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <button onClick={handleDownloadFile} className="btn-primary" style={{ width: '100%', padding: '0.75rem' }}>
                    <Download size={16} />
                    <span>Download Video</span>
                  </button>

                  <button
                    onClick={() => setExportedBlob(null)}
                    className="btn-secondary"
                    style={{ width: '100%', padding: '0.75rem' }}
                  >
                    Back to Studio
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
