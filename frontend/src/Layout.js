import React, { useState } from "react";
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useLogto } from '@logto/react';
import {
  Box, IconButton, InputBase, Tooltip, Typography, Avatar, useMediaQuery
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import dayjs from "dayjs";
import DashboardOutlinedIcon from "@mui/icons-material/DashboardOutlined";
import GraphicEqIcon from "@mui/icons-material/GraphicEq";
import TrendingUpIcon from "@mui/icons-material/TrendingUp";
import SchoolOutlinedIcon from "@mui/icons-material/SchoolOutlined";
import BarChartIcon from "@mui/icons-material/BarChart";
import AdminPanelSettingsOutlinedIcon from "@mui/icons-material/AdminPanelSettingsOutlined";
import LogoutIcon from "@mui/icons-material/Logout";
import SearchIcon from "@mui/icons-material/Search";
import DarkModeOutlinedIcon from "@mui/icons-material/DarkModeOutlined";
import LightModeOutlinedIcon from "@mui/icons-material/LightModeOutlined";
import NotificationBell from './NotificationBell';
import { useUser, useAuth } from './auth';

export const SIDEBAR_WIDTH = 232;

function NavItem({ to, icon, label, end = false, compact }) {
  return (
    <Box
      component={NavLink}
      to={to}
      end={end}
      sx={{
        display: 'flex', alignItems: 'center', gap: 1.5, textDecoration: 'none', color: 'text.secondary', fontWeight: 500,
        py: 1.1, whiteSpace: 'nowrap',
        ...(compact
          ? { px: 1.5, borderRadius: 999 }
          : { pl: 3, pr: 1.5, ml: -1.5, borderRadius: '0 999px 999px 0' }),
        '&:hover': { bgcolor: 'subtle', color: 'text.primary' },
        '&.active': { bgcolor: theme => theme.palette.mode === 'dark' ? 'rgba(111,157,255,.16)' : '#e3ecfc', color: 'primary.main', fontWeight: 600 },
        '& svg': { fontSize: 20 }
      }}
    >
      {icon}
      {label}
    </Box>
  );
}

// Phone numbers and call IDs go to the Recordings filter; words search transcripts.
function routeForSearch(raw) {
  const value = raw.trim();
  if (!value) return null;
  const digits = value.replace(/[^\d]/g, '');
  const looksNumeric = /^[\d\s()+.-]+$/.test(value);
  const range = `dateStart=${dayjs().subtract(90, 'day').format('M_D_YYYY')}&dateEnd=${dayjs().format('M_D_YYYY')}`;
  if (looksNumeric && (digits.length === 10 || (digits.length === 11 && digits.startsWith('1')))) {
    return `/recordings?phone=${digits.slice(-10)}&${range}`;
  }
  if (looksNumeric && digits.length >= 5) return `/recordings?callId=${digits}&${range}`;
  return `/search?q=${encodeURIComponent(value)}`;
}

export default function Layout({ darkMode, setDarkMode, children }) {
  const theme = useTheme();
  const compact = useMediaQuery(theme.breakpoints.down('md'));
  const navigate = useNavigate();
  const { user } = useUser();
  const { signOut } = useLogto();
  const { getToken } = useAuth();
  const [query, setQuery] = useState('');
  const role = user?.publicMetadata?.role;
  const isAdmin = role === 'admin';
  const isManager = role === 'manager';
  const email = user?.primaryEmailAddress?.emailAddress || user?.emailAddresses?.[0]?.emailAddress || '';
  const name = [user?.firstName, user?.lastName && !user?.firstName?.endsWith(user.lastName) ? user.lastName : null].filter(Boolean).join(' ') || email;
  const initials = (name || '?').split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(s => s[0].toUpperCase()).join('');

  const handleLogout = async () => {
    try {
      const token = await getToken();
      await fetch('/api/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
      });
    } catch (e) {
      console.error('Failed to record logout', e);
    } finally {
      signOut(`${window.location.origin}/`);
    }
  };

  const onSearch = (event) => {
    event.preventDefault();
    const target = routeForSearch(query);
    if (target) navigate(target);
  };

  const nav = [
    { to: '/', label: 'Home', icon: <DashboardOutlinedIcon />, end: true },
    { to: '/recordings', label: 'Recordings', icon: <GraphicEqIcon /> },
    { to: '/trends', label: 'Trends', icon: <TrendingUpIcon /> },
    ...(isAdmin || isManager ? [{ to: '/coaching', label: 'Coaching', icon: <SchoolOutlinedIcon /> }] : []),
    { to: '/reports', label: 'Reports', icon: <BarChartIcon /> },
    ...(isAdmin || isManager ? [{ to: '/admin', label: isAdmin ? 'Admin' : 'Reporting', icon: <AdminPanelSettingsOutlinedIcon /> }] : [])
  ];

  return (
    <Box sx={{ display: 'flex', flexDirection: compact ? 'column' : 'row', minHeight: '100vh', bgcolor: 'background.default' }}>
      <Box
        component="nav"
        aria-label="Main navigation"
        sx={compact ? {
          position: 'sticky', top: 0, zIndex: 1100, display: 'flex', alignItems: 'center', gap: 0.5, overflowX: 'auto',
          bgcolor: 'background.paper', borderBottom: 1, borderColor: 'divider', px: 1, py: 1
        } : {
          width: SIDEBAR_WIDTH, flexShrink: 0, position: 'sticky', top: 0, height: '100vh', display: 'flex', flexDirection: 'column', gap: 0.5,
          bgcolor: 'background.paper', borderRight: 1, borderColor: 'divider', px: 1.5, py: 2.5
        }}
      >
        <Typography
          component={Link}
          to="/"
          sx={{ fontFamily: '"Manrope", sans-serif', fontWeight: 800, fontSize: compact ? 18 : 22, color: 'primary.main', textDecoration: 'none', px: 1.5, pb: compact ? 0 : 2.5, letterSpacing: '-0.02em', whiteSpace: 'nowrap' }}
        >
          rec<Box component="span" sx={{ color: 'text.primary' }}>bot</Box>
        </Typography>
        {nav.map(item => <NavItem key={item.to} {...item} compact={compact} />)}
        {!compact && <Box sx={{ flex: 1 }} />}
        {!compact && (
          <Box component="button" type="button" onClick={handleLogout}
            sx={{ display: 'flex', alignItems: 'center', gap: 1.5, border: 0, bgcolor: 'transparent', color: 'text.secondary', font: 'inherit', fontWeight: 500, pl: 1.5, py: 1.1, cursor: 'pointer', '&:hover': { color: 'error.main' }, '& svg': { fontSize: 20 } }}>
            <LogoutIcon /> Log out
          </Box>
        )}
      </Box>

      <Box component="main" sx={{ flex: 1, minWidth: 0, px: { xs: 2, md: 3 }, pb: 14 }}>
        <Box sx={{ maxWidth: 1280, mx: 'auto' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 2, flexWrap: 'wrap' }}>
            <Box component="form" onSubmit={onSearch} role="search"
              sx={{ flex: '1 1 260px', display: 'flex', alignItems: 'center', gap: 1, bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 999, px: 2, py: 0.75, minWidth: 0 }}>
              <SearchIcon fontSize="small" sx={{ color: 'text.secondary' }} />
              <InputBase
                fullWidth
                placeholder="Search transcripts, a phone number or a call ID"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                inputProps={{ 'aria-label': 'Search transcripts, a phone number or a call ID' }}
              />
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 999 }}>
                <NotificationBell />
              </Box>
              <Tooltip title={darkMode ? 'Light mode' : 'Dark mode'}>
                <IconButton onClick={() => setDarkMode(!darkMode)} sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider' }} aria-label="Toggle dark mode">
                  {darkMode ? <LightModeOutlinedIcon fontSize="small" /> : <DarkModeOutlinedIcon fontSize="small" />}
                </IconButton>
              </Tooltip>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 999, pl: 0.5, pr: { xs: 0.5, sm: 1.75 }, py: 0.5 }}>
                <Avatar sx={{ width: 30, height: 30, fontSize: 12, fontWeight: 700, bgcolor: 'primary.main' }}>{initials}</Avatar>
                <Box sx={{ display: { xs: 'none', sm: 'block' }, lineHeight: 1.2 }}>
                  <Typography variant="body2" fontWeight={600} noWrap sx={{ maxWidth: 200 }}>{name}</Typography>
                  {role && <Typography variant="caption" color="text.secondary">{role[0].toUpperCase() + role.slice(1)}</Typography>}
                </Box>
              </Box>
              {compact && (
                <Tooltip title="Log out">
                  <IconButton onClick={handleLogout} aria-label="Log out"><LogoutIcon fontSize="small" /></IconButton>
                </Tooltip>
              )}
            </Box>
          </Box>
          {children}
        </Box>
      </Box>
    </Box>
  );
}

export function PageHeader({ title, subtitle, actions }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap', mb: 2.5 }}>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="h4" component="h1" sx={{ fontSize: { xs: 22, md: 26 } }}>{title}</Typography>
        {subtitle && <Typography color="text.secondary" sx={{ mt: 0.5 }}>{subtitle}</Typography>}
      </Box>
      {actions && <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>{actions}</Box>}
    </Box>
  );
}

