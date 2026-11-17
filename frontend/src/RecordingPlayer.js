import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, IconButton, Typography, ToggleButton, ToggleButtonGroup, Tooltip, CircularProgress } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import PauseIcon from "@mui/icons-material/Pause";
import Replay10Icon from "@mui/icons-material/Replay10";
import Forward10Icon from "@mui/icons-material/Forward10";
import { useAuth } from './auth';
import { formatMs } from './ui';
import { SIDEBAR_WIDTH } from './Layout';

const SPEEDS = [1, 1.25, 1.5, 2];

// Streams one recording through /api/audio (the token goes in ?auth=, as the
// Recordings page does) and loads its waveform from /api/waveform.
export function useRecordingPlayer(path) {
  const { getToken } = useAuth();
  const audioRef = useRef(null);
  // One shared promise, so quick clicks before the audio exists don't create two players.
  const audioPromiseRef = useRef(null);
  // A jump (in seconds) waiting until the audio can seek that far.
  const pendingSeekRef = useRef(null);
  const [state, setState] = useState({ ready: false, loading: false, playing: false, time: 0, duration: 0, error: null });
  const [rate, setRate] = useState(1);
  const [waveform, setWaveform] = useState(null);

  useEffect(() => {
    setState({ ready: false, loading: false, playing: false, time: 0, duration: 0, error: null });
    setWaveform(null);
    pendingSeekRef.current = null;
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
      audioPromiseRef.current = null;
    };
  }, [path]);

  // Applies a pending jump once the browser can seek to it. While the server is
  // still converting the recording, only the part loaded so far is seekable,
  // so the jump waits instead of silently landing at 0:00.
  const applyPendingSeek = useCallback((audio) => {
    const target = pendingSeekRef.current;
    if (target === null || audio.readyState < 1) return;
    const duration = Number.isFinite(audio.duration) ? audio.duration : null;
    const seekableEnd = audio.seekable.length ? audio.seekable.end(audio.seekable.length - 1) : 0;
    const goal = duration !== null ? Math.min(target, Math.max(0, duration - 0.25)) : target;
    if (seekableEnd < goal) return;
    pendingSeekRef.current = null;
    audio.currentTime = goal;
    setState(s => ({ ...s, time: goal }));
  }, []);

  const ensureAudio = useCallback(() => {
    if (audioPromiseRef.current) return audioPromiseRef.current;
    audioPromiseRef.current = (async () => {
      setState(s => ({ ...s, loading: true, error: null }));
      const token = await getToken();
      const audio = new Audio();
      audio.preload = 'auto';
      audio.playbackRate = rate;
      audio.addEventListener('loadedmetadata', () => setState(s => ({ ...s, duration: audio.duration, ready: true, loading: false })));
      audio.addEventListener('timeupdate', () => setState(s => ({ ...s, time: audio.currentTime })));
      audio.addEventListener('play', () => setState(s => ({ ...s, playing: true })));
      audio.addEventListener('pause', () => setState(s => ({ ...s, playing: false })));
      audio.addEventListener('ended', () => setState(s => ({ ...s, playing: false })));
      audio.addEventListener('error', () => setState(s => ({ ...s, loading: false, playing: false, error: 'The recording could not be played.' })));
      for (const event of ['loadedmetadata', 'durationchange', 'canplay', 'progress']) {
        audio.addEventListener(event, () => applyPendingSeek(audio));
      }
      audio.src = `/api/audio/${encodeURIComponent(path)}?auth=${encodeURIComponent(token)}`;
      audioRef.current = audio;
      fetch(`/api/waveform/${encodeURIComponent(path)}`, { headers: { Authorization: `Bearer ${token}` } })
        .then(res => (res.ok ? res.json() : null))
        .then(json => { if (json?.waveform && audioRef.current === audio) setWaveform(json.waveform); })
        .catch(() => {});
      return audio;
    })();
    return audioPromiseRef.current;
  }, [path, getToken, rate, applyPendingSeek]);

  const play = useCallback(async () => {
    const audio = await ensureAudio();
    try {
      await audio.play();
    } catch (err) {
      // A newer play/pause or a jump interrupted this one; that isn't an error.
      if (err?.name === 'AbortError') return;
      setState(s => ({ ...s, loading: false, error: 'The recording could not be played.' }));
    }
  }, [ensureAudio]);

  const pause = useCallback(() => audioRef.current?.pause(), []);

  // Jumps to a moment (in seconds) and plays from there, whether the audio is
  // not loaded yet, playing, or paused.
  const seek = useCallback(async (seconds) => {
    const target = Math.max(0, seconds);
    pendingSeekRef.current = target;
    setState(s => ({ ...s, time: target }));
    const audio = await ensureAudio();
    applyPendingSeek(audio);
    if (audio.paused) play();
  }, [ensureAudio, applyPendingSeek, play]);

  const changeRate = useCallback((value) => {
    setRate(value);
    if (audioRef.current) audioRef.current.playbackRate = value;
  }, []);

  return { ...state, rate, waveform, play, pause, seek, changeRate };
}

function Waveform({ player, durationHintMs, markers, sentiment }) {
  const theme = useTheme();
  const canvasRef = useRef(null);
  const durationSec = player.duration || (durationHintMs || 0) / 1000;
  const fraction = durationSec ? player.time / durationSec : 0;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const w = canvas.clientWidth;
      canvas.width = w * 2;
      canvas.height = 68;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const n = Math.max(1, Math.floor(w / 4));
      const data = player.waveform;
      for (let i = 0; i < n; i++) {
        let amp;
        if (data?.length) {
          const idx = Math.floor((i / n) * data.length);
          amp = Math.min(1, Math.abs(data[idx]) || 0);
        } else {
          amp = 0.15; // flat placeholder until the waveform loads
        }
        const h = Math.max(4, amp * 64);
        ctx.fillStyle = i / n <= fraction ? theme.palette.primary.main : theme.palette.divider;
        ctx.fillRect(i * 8, (68 - h) / 2, 5, h);
      }
    };
    draw();
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [player.waveform, fraction, theme]);

  const onClick = (event) => {
    if (!durationSec) return;
    const rect = event.currentTarget.getBoundingClientRect();
    player.seek(((event.clientX - rect.left) / rect.width) * durationSec);
  };

  const sentimentColor = s => (s >= 0.1 ? theme.palette.success.main : s <= -0.1 ? theme.palette.error.main : theme.palette.divider);
  const totalMs = durationSec * 1000 || 1;

  return (
    <Box
      onClick={onClick}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(durationSec)}
      aria-valuenow={Math.round(player.time)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') player.seek(player.time + 5);
        if (e.key === 'ArrowLeft') player.seek(player.time - 5);
      }}
      sx={{ flex: 1, minWidth: 0, position: 'relative', cursor: 'pointer', py: 0.5 }}
    >
      <canvas ref={canvasRef} style={{ width: '100%', height: 34, display: 'block' }} />
      {sentiment?.length > 0 && (
        <Box sx={{ position: 'relative', height: 6, mt: 0.5, borderRadius: 1, overflow: 'hidden', bgcolor: 'divider' }}>
          {sentiment.map((p, i) => {
            const nextAt = sentiment[i + 1]?.atMs ?? totalMs;
            return <Box key={i} sx={{ position: 'absolute', top: 0, bottom: 0, left: `${(p.atMs / totalMs) * 100}%`, width: `${Math.max(0, (nextAt - p.atMs) / totalMs) * 100}%`, bgcolor: sentimentColor(p.score), opacity: 0.75 }} />;
          })}
        </Box>
      )}
      {markers.map((m, i) => (
        <Tooltip key={i} title={`${formatMs(m.atMs)} · ${m.label}`}>
          <Box
            onClick={(e) => { e.stopPropagation(); player.seek(m.atMs / 1000); }}
            sx={{ position: 'absolute', top: -4, left: `${Math.min(100, (m.atMs / totalMs) * 100)}%`, width: 10, height: 10, borderRadius: '50%', transform: 'translateX(-50%)', bgcolor: m.color, border: 2, borderColor: 'background.paper' }}
          />
        </Tooltip>
      ))}
    </Box>
  );
}

// Sticky bar at the bottom of the call file page.
export function PlayerBar({ player, durationHintMs, markers = [], sentiment }) {
  const durationSec = player.duration || (durationHintMs || 0) / 1000;
  return (
    <Box sx={{
      position: 'fixed', bottom: 0, right: 0, left: { xs: 0, md: SIDEBAR_WIDTH }, zIndex: 1200,
      bgcolor: 'background.paper', borderTop: 1, borderColor: 'divider', boxShadow: '0 -6px 24px rgba(22,33,58,.08)',
      px: { xs: 2, md: 3 }, pt: 1.5, pb: 'calc(12px + env(safe-area-inset-bottom, 0px))'
    }}>
      <Box sx={{ maxWidth: 1280, mx: 'auto', display: 'flex', alignItems: 'center', gap: { xs: 1, md: 1.5 } }}>
        <IconButton aria-label="Back 10 seconds" onClick={() => player.seek(player.time - 10)} disabled={!player.ready} sx={{ display: { xs: 'none', sm: 'inline-flex' } }}><Replay10Icon /></IconButton>
        <IconButton
          aria-label={player.playing ? 'Pause' : 'Play'}
          onClick={() => (player.playing ? player.pause() : player.play())}
          sx={{ width: 44, height: 44, bgcolor: 'primary.main', color: 'primary.contrastText', '&:hover': { bgcolor: 'primary.dark' } }}
        >
          {player.loading ? <CircularProgress size={20} color="inherit" /> : player.playing ? <PauseIcon /> : <PlayArrowIcon />}
        </IconButton>
        <IconButton aria-label="Forward 10 seconds" onClick={() => player.seek(player.time + 10)} disabled={!player.ready} sx={{ display: { xs: 'none', sm: 'inline-flex' } }}><Forward10Icon /></IconButton>
        <Typography variant="caption" color={player.error ? 'error' : 'text.secondary'} sx={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
          {player.error || `${formatMs(player.time * 1000)} / ${formatMs(durationSec * 1000)}`}
        </Typography>
        <Waveform player={player} durationHintMs={durationHintMs} markers={markers} sentiment={sentiment} />
        <ToggleButtonGroup size="small" exclusive value={player.rate} onChange={(_e, v) => v && player.changeRate(v)} aria-label="Playback speed" sx={{ display: { xs: 'none', md: 'flex' } }}>
          {SPEEDS.map(s => <ToggleButton key={s} value={s} sx={{ px: 1, py: 0.25, fontSize: 12 }}>{s}x</ToggleButton>)}
        </ToggleButtonGroup>
      </Box>
    </Box>
  );
}
