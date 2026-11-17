import React from "react";
import { Box, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { fmtScore } from './ui';

// Line chart of average score per bucket on a fixed -10..10 scale (zoomed to the data's range).
export function ScoreTrendChart({ points, height = 220 }) {
  const theme = useTheme();
  const values = points.map(p => p.value).filter(v => v !== null && v !== undefined);
  if (!values.length) {
    return <Box sx={{ height, display: 'grid', placeItems: 'center' }}><Typography color="text.secondary">No scored calls in this period yet.</Typography></Box>;
  }
  const W = 420;
  const H = height;
  const L = 30; const R = 12; const T = 12; const B = 26;
  const lo = Math.max(-10, Math.floor(Math.min(0, ...values) / 2) * 2);
  const hi = Math.min(10, Math.ceil(Math.max(...values) / 2) * 2 || 2);
  const x = i => L + (W - L - R) * (points.length === 1 ? 0.5 : i / (points.length - 1));
  const y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo || 1));
  const ticks = [];
  for (let t = lo; t <= hi; t += 2) ticks.push(t);
  const drawn = points.map((p, i) => ({ ...p, i })).filter(p => p.value !== null && p.value !== undefined);
  const line = drawn.map(p => `${x(p.i)},${y(p.value)}`).join(' ');
  const base = y(Math.max(lo, 0));
  const area = drawn.length > 1 ? `M${x(drawn[0].i)},${base} L${line.split(' ').join(' L')} L${x(drawn[drawn.length - 1].i)},${base} Z` : null;
  const step = Math.ceil(points.length / 7);
  const text = { fill: theme.palette.text.secondary, fontSize: 11, fontFamily: theme.typography.fontFamily };
  const last = drawn[drawn.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Average score trend">
      {ticks.map(t => (
        <g key={t}>
          <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke={theme.palette.divider} strokeDasharray={t === 0 ? undefined : '3 4'} strokeWidth={t === 0 ? 1.5 : 1} />
          <text x={L - 6} y={y(t) + 4} textAnchor="end" style={text}>{t}</text>
        </g>
      ))}
      {area && <path d={area} fill={theme.palette.primary.main} opacity={0.1} />}
      <polyline points={line} fill="none" stroke={theme.palette.primary.main} strokeWidth={2.5} strokeLinejoin="round" />
      {drawn.map(p => (
        <circle key={p.i} cx={x(p.i)} cy={y(p.value)} r={p === last ? 5 : 3} fill={p === last ? theme.palette.primary.main : theme.palette.background.paper} stroke={theme.palette.primary.main} strokeWidth={2}>
          <title>{`${p.label}: ${fmtScore(p.value)}`}</title>
        </circle>
      ))}
      {points.map((p, i) => (i % step === 0 || i === points.length - 1) && (
        <text key={i} x={x(i)} y={H - 6} textAnchor="middle" style={text}>{p.label}</text>
      ))}
    </svg>
  );
}

// Simple horizontal bars for counts (e.g. dispositions, topics).
export function CountBar({ value, max }) {
  return (
    <Box sx={{ position: 'relative', height: 10, borderRadius: 999, bgcolor: 'background.default', border: 1, borderColor: 'divider', overflow: 'hidden' }}>
      <Box sx={{ position: 'absolute', inset: 0, width: `${max ? (value / max) * 100 : 0}%`, bgcolor: 'primary.main', opacity: 0.8, borderRadius: 999 }} />
    </Box>
  );
}

// Customer sentiment over the call: one bar per point, from -1 to +1, labelled with its time.
export function SentimentChart({ points, height = 160 }) {
  const theme = useTheme();
  if (!points?.length) return <Typography color="text.secondary">No sentiment data for this call.</Typography>;
  const W = 900; const H = height; const L = 34; const B = 22; const mid = (H - B) / 2; const amp = mid - 8;
  const slot = (W - L) / points.length;
  const bw = Math.min(64, slot * 0.7);
  const color = s => (s >= 0.1 ? theme.palette.success.main : s <= -0.1 ? theme.palette.error.main : theme.palette.text.secondary);
  const text = { fill: theme.palette.text.secondary, fontSize: 12, fontFamily: theme.typography.fontFamily };
  const label = ms => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Customer sentiment over the call">
      <line x1={L} x2={W} y1={mid} y2={mid} stroke={theme.palette.divider} strokeWidth={1.5} />
      <text x={L - 8} y={14} textAnchor="end" style={text}>+1</text>
      <text x={L - 8} y={mid + 4} textAnchor="end" style={text}>0</text>
      <text x={L - 8} y={H - B} textAnchor="end" style={text}>−1</text>
      {points.map((p, i) => {
        const cx = L + slot * i + (slot - bw) / 2;
        const h = Math.max(2, Math.abs(p.score) * amp);
        return (
          <g key={i}>
            <rect x={cx} y={p.score >= 0 ? mid - h : mid} width={bw} height={h} rx={5} fill={color(p.score)} opacity={0.85}>
              <title>{`${label(p.atMs)} · ${p.score > 0 ? '+' : ''}${p.score.toFixed(1)}`}</title>
            </rect>
            <text x={cx + bw / 2} y={H - 4} textAnchor="middle" style={text}>{label(p.atMs)}</text>
          </g>
        );
      })}
    </svg>
  );
}

// Donut for talk share percentages.
export function TalkShareDonut({ agent, customer, size = 96 }) {
  const theme = useTheme();
  const silence = Math.max(0, 100 - (agent || 0) - (customer || 0));
  const r = 15.9;
  const seg = (pct, offset, color) => (
    <circle cx="21" cy="21" r={r} fill="none" stroke={color} strokeWidth="6" strokeDasharray={`${pct} ${100 - pct}`} strokeDashoffset={offset} />
  );
  return (
    <svg viewBox="0 0 42 42" width={size} height={size} role="img" aria-label={`Agent ${agent}%, customer ${customer}%`}>
      {seg(100, 0, theme.palette.divider)}
      {seg(customer || 0, 25 - (agent || 0), theme.palette.warning.main)}
      {seg(agent || 0, 25, theme.palette.primary.main)}
      <title>{`Agent ${agent}% · Customer ${customer}% · Silence ${silence}%`}</title>
    </svg>
  );
}
