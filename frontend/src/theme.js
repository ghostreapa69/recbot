import { createTheme, alpha } from "@mui/material/styles";

// Score colors are semantic (good / mixed / poor), separate from the brand blue.
const PALETTE = {
  light: {
    background: '#eef3fb', paper: '#ffffff', subtle: '#f5f8fd', line: '#dfe6f1',
    text: '#16213a', muted: '#5d6b85', brand: '#0b4fc4',
    good: '#1f8a52', warn: '#b26b00', bad: '#c43b3b'
  },
  dark: {
    background: '#0e1422', paper: '#161e30', subtle: '#1c2639', line: '#2a3650',
    text: '#e6ecf7', muted: '#95a3bd', brand: '#6f9dff',
    good: '#4cc47f', warn: '#f0b04b', bad: '#f07272'
  }
};

export function buildTheme(darkMode) {
  const p = darkMode ? PALETTE.dark : PALETTE.light;
  return createTheme({
    palette: {
      mode: darkMode ? 'dark' : 'light',
      primary: { main: p.brand },
      success: { main: p.good },
      warning: { main: p.warn },
      error: { main: p.bad },
      background: { default: p.background, paper: p.paper },
      text: { primary: p.text, secondary: p.muted },
      divider: p.line,
      subtle: p.subtle
    },
    shape: { borderRadius: 12 },
    typography: {
      fontFamily: '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
      h4: { fontFamily: '"Manrope", "Inter", sans-serif', fontWeight: 800, letterSpacing: '-0.01em' },
      h5: { fontFamily: '"Manrope", "Inter", sans-serif', fontWeight: 800 },
      h6: { fontFamily: '"Manrope", "Inter", sans-serif', fontWeight: 700, fontSize: '1rem' },
      button: { textTransform: 'none', fontWeight: 600 }
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: { body: { backgroundColor: p.background } }
      },
      MuiPaper: {
        defaultProps: { elevation: 0 },
        styleOverrides: { rounded: { borderRadius: 16 }, outlined: { borderColor: p.line } }
      },
      MuiButton: { styleOverrides: { root: { borderRadius: 999 } } },
      MuiChip: { styleOverrides: { root: { fontWeight: 600 } } },
      MuiTableCell: { styleOverrides: { head: { fontWeight: 600, color: p.muted, backgroundColor: p.subtle } } },
      MuiToggleButton: { styleOverrides: { root: { textTransform: 'none' } } },
      MuiTab: { styleOverrides: { root: { textTransform: 'none', fontWeight: 600, minWidth: 0, paddingLeft: 0, paddingRight: 0, marginRight: 24 } } }
    }
  });
}

// Tone for a -10..+10 score.
export function scoreTone(score) {
  if (score === null || score === undefined) return 'default';
  if (score >= 4) return 'success';
  if (score >= -2) return 'warning';
  return 'error';
}

export const softBg = (theme, tone) => alpha(theme.palette[tone]?.main || theme.palette.text.secondary, theme.palette.mode === 'dark' ? 0.18 : 0.12);
