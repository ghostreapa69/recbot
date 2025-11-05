import React, { useEffect, useState } from "react";
import { useUser, useAuth } from '@clerk/clerk-react';
import {
  Container,
  Typography,
  IconButton,
  Paper,
  Box,
  Pagination,
  TextField,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Grid,
  TableSortLabel,
  InputAdornment,
  Switch,
  FormControlLabel,
  CssBaseline,
  Select,
  MenuItem,
  CircularProgress,
  LinearProgress,
  FormControl,
  InputLabel,
  Button,
  Alert,
  Slider,
} from "@mui/material";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import PauseIcon from "@mui/icons-material/Pause";
import StopIcon from "@mui/icons-material/Stop";
import VolumeUpIcon from "@mui/icons-material/VolumeUp";
import FastForwardIcon from "@mui/icons-material/FastForward";
import FastRewindIcon from "@mui/icons-material/FastRewind";
import DownloadIcon from "@mui/icons-material/Download";
import RefreshIcon from "@mui/icons-material/Refresh";
import { LocalizationProvider } from "@mui/x-date-pickers/LocalizationProvider";
import { AdapterDayjs } from "@mui/x-date-pickers/AdapterDayjs";
import { DatePicker } from "@mui/x-date-pickers/DatePicker";
import { TimePicker } from "@mui/x-date-pickers/TimePicker";
import { useLocation } from 'react-router-dom';
import dayjs from "dayjs";
import customParseFormat from 'dayjs/plugin/customParseFormat';

dayjs.extend(customParseFormat);

// Backend now returns structured file objects; this is a passthrough mapper for safety/future
function normalizeFile(rec) {
  return {
    file: rec.path,
    date: rec.date?.replace(/-/g, '/') || '',
    phone: rec.phone || '',
    email: rec.email || '',
    time: rec.time || '',
    callId: rec.callId || '',
    durationMs: rec.durationMs || 0,
    size: rec.size || 0
  };
}

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

const DATE_PARAM_FORMATS = ['M_D_YYYY', 'M-D-YYYY', 'MM-DD-YYYY', 'YYYY-MM-DD', 'M/D/YYYY', 'MM/DD/YYYY'];
const TIME_PARAM_FORMATS = ['h:mm A', 'hh:mm A', 'H:mm', 'HH:mm'];
const ALLOWED_SORT_COLUMNS = new Set(['date', 'time', 'phone', 'email', 'durationMs', 'size', 'callId']);

// Normalize phone filters so pasted formatting characters do not affect matching
const stripPhoneFormatting = (input) => {
  if (input == null) return '';
  return String(input).replace(/[^\d]/g, '');
};

function parseDateParam(value) {
  if (!value) return null;
  const trimmed = value.trim();
  for (const format of DATE_PARAM_FORMATS) {
    const parsed = dayjs(trimmed, format, true);
    if (parsed.isValid()) {
      return parsed;
    }
  }
  const fallback = dayjs(trimmed);
  return fallback.isValid() ? fallback : null;
}

function parseTimeParam(value) {
  if (!value) return null;
  const trimmed = value.trim();
  for (const format of TIME_PARAM_FORMATS) {
    const parsed = dayjs(trimmed, format, true);
    if (parsed.isValid()) {
      return parsed;
    }
  }
  return null;
}

function FileViewer({ darkMode }) {
  const { user, isLoaded } = useUser();
  const { getToken } = useAuth();
  const location = useLocation();
  const [files, setFiles] = useState([]);
  const [playing, setPlaying] = useState(null);
  const [currentTrack, setCurrentTrack] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.5); // Default volume 50%
  const [waveformData, setWaveformData] = useState(null); // Audio waveform data
  const [isGeneratingWaveform, setIsGeneratingWaveform] = useState(false);

  const [calendarDateStart, setCalendarDateStart] = useState(null);
  const [calendarDateEnd, setCalendarDateEnd] = useState(null);
  const [timePickerStart, setTimePickerStart] = useState(null);
  const [timePickerEnd, setTimePickerEnd] = useState(null);
  const [phoneFilter, setPhoneFilter] = useState("");
  const [emailFilter, setEmailFilter] = useState("");
  const [sortColumn, setSortColumn] = useState("date");
  const [sortDirection, setSortDirection] = useState("asc");
  const [durationMin, setDurationMin] = useState("");
  // Removed durationMode; durationMin now always interpreted as minutes
  const [timeMode, setTimeMode] = useState("range");
  const [callIdFilter, setCallIdFilter] = useState("");
  const callIdDebounceRef = React.useRef(null);
  const applyingUrlParamsRef = React.useRef(false);
  const [error500, setError500] = useState(false);
  const [loading, setLoading] = useState(false);
  const [filesPerPage, setFilesPerPage] = useState(25);
  const [totalCount, setTotalCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [currentOffset, setCurrentOffset] = useState(0);

  // Get user role for admin features
  const userRole = user?.publicMetadata?.role;
  const isAdmin = userRole === 'admin';
  const isManager = userRole === 'manager';
  const canDownload = isAdmin || isManager;
  const userEmail = user?.primaryEmailAddress?.emailAddress || user?.emailAddresses?.[0]?.emailAddress || '';

  // Fetch files only when a date is selected or changed
  const fetchFiles = (start, end, offset = 0, limit = filesPerPage, customSortColumn = null, customSortDirection = null, customDurationMin = null, customPhoneFilter = null, customEmailFilter = null, customTimePickerStart = null, customTimePickerEnd = null, customTimeMode = null, customCallId = null) => {
    if (!start) return;
    setLoading(true);
    setError500(false);
    
    let url = `/api/wav-files?dateStart=${encodeURIComponent(dayjs(start).format("M_D_YYYY"))}`;
    if (end) url += `&dateEnd=${encodeURIComponent(dayjs(end).format("M_D_YYYY"))}`;
    
    // Add role-based email filtering
    // Only members are restricted to their own files
    // Admins, managers, and users with no role can see all files
    const emailValue = customEmailFilter !== null ? customEmailFilter : emailFilter;
    const effectiveEmailFilter = isAdmin || userRole === undefined
      ? emailValue
      : userEmail; // Only members are restricted to their own files

  const durationValue = customDurationMin !== null ? customDurationMin : durationMin;
  const phoneValueRaw = customPhoneFilter !== null ? customPhoneFilter : phoneFilter;
  const normalizedPhoneValue = stripPhoneFormatting(phoneValueRaw);
    const currentTimeMode = customTimeMode !== null ? customTimeMode : timeMode;
    const startTime = customTimePickerStart !== null ? customTimePickerStart : timePickerStart;
    const endTime = customTimePickerEnd !== null ? customTimePickerEnd : timePickerEnd;
    const callIdValue = customCallId !== null ? customCallId : callIdFilter;

    url += `&offset=${offset}&limit=${limit}`;
    if (callIdValue && callIdValue.trim() !== '') {
      url += `&callId=${encodeURIComponent(callIdValue.trim())}`;
    }
    url += `&sortColumn=${customSortColumn || sortColumn}&sortDirection=${customSortDirection || sortDirection}`;
    
    if (durationValue !== null && durationValue !== "") {
      url += `&durationMin=${encodeURIComponent(durationValue)}`;
    }
    
    if (normalizedPhoneValue) {
      url += `&phone=${encodeURIComponent(normalizedPhoneValue)}`;
    }
    
    if (effectiveEmailFilter !== "") {
      url += `&email=${encodeURIComponent(effectiveEmailFilter)}`;
    }
    
    if (currentTimeMode === "range") {
      if (startTime) url += `&timeStart=${encodeURIComponent(dayjs(startTime).format("h:mm A"))}`;
      if (endTime) url += `&timeEnd=${encodeURIComponent(dayjs(endTime).format("h:mm A"))}`;
    }

    const makeRequest = async () => {
      const token = await getToken();
      return fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
    };

    makeRequest()
      .then((res) => {
        if (res.status === 500) {
          setError500(true);
          return { files: [], totalCount: 0, hasMore: false };
        }
        return res.json();
      })
      .then((data) => {
        setFiles((data.files || []).map(normalizeFile));
        setTotalCount(data.totalCount);
        setHasMore(data.hasMore);
        setCurrentOffset(offset);
      })
      .catch((err) => {
        console.error("Error fetching files:", err);
        setError500(true);
      })
      .finally(() => setLoading(false));
  };

  const refreshFiles = (reset = false) => {
    const newOffset = reset ? 0 : currentOffset;
    fetchFiles(calendarDateStart, calendarDateEnd, newOffset);
  };

  // Debounced fetch when callIdFilter changes (consistent auto behavior)
  useEffect(() => {
    if (applyingUrlParamsRef.current) return;
    if (!calendarDateStart) return; // need a start date selected
    if (callIdDebounceRef.current) clearTimeout(callIdDebounceRef.current);
    callIdDebounceRef.current = setTimeout(() => {
      // Only trigger automatically when empty or at least 2 chars (reduce noise)
      if (callIdFilter.trim() === '' || callIdFilter.trim().length >= 2) {
        refreshFiles(true);
      }
    }, 350);
    return () => clearTimeout(callIdDebounceRef.current);
  }, [callIdFilter]);

  useEffect(() => {
    if (!isLoaded) return;

    const params = new URLSearchParams(location.search || '');
    applyingUrlParamsRef.current = true;
    const timerId = setTimeout(() => {
      applyingUrlParamsRef.current = false;
    }, 0);

    const startParamRaw = params.get('dateStart');
    const endParamRaw = params.get('dateEnd');
    let startFromQuery = parseDateParam(startParamRaw);
    let endFromQuery = endParamRaw !== null ? parseDateParam(endParamRaw) : null;
    let historyNeedsUpdate = false;

    if (!startFromQuery) {
      startFromQuery = dayjs();
      params.set('dateStart', startFromQuery.format('M_D_YYYY'));
      historyNeedsUpdate = true;
    }
    setCalendarDateStart(startFromQuery);

    if (endParamRaw !== null) {
      if (endParamRaw && !endFromQuery) {
        params.delete('dateEnd');
        historyNeedsUpdate = true;
      }
      setCalendarDateEnd(endFromQuery);
    } else {
      setCalendarDateEnd(null);
    }

    let limitValue = filesPerPage;
    if (params.has('limit')) {
      const parsedLimit = parseInt(params.get('limit'), 10);
      if (!Number.isNaN(parsedLimit) && parsedLimit > 0) {
        limitValue = parsedLimit;
        setFilesPerPage(parsedLimit);
      } else {
        params.delete('limit');
        historyNeedsUpdate = true;
      }
    }

    let offsetValue = 0;
    if (params.has('offset')) {
      const parsedOffset = parseInt(params.get('offset'), 10);
      if (!Number.isNaN(parsedOffset) && parsedOffset >= 0) {
        offsetValue = parsedOffset;
      } else {
        params.delete('offset');
        historyNeedsUpdate = true;
      }
    }

    let sortColumnValue = sortColumn;
    if (params.has('sortColumn')) {
      const candidate = (params.get('sortColumn') || '').trim();
      if (ALLOWED_SORT_COLUMNS.has(candidate)) {
        sortColumnValue = candidate;
        setSortColumn(candidate);
      } else {
        params.delete('sortColumn');
        historyNeedsUpdate = true;
      }
    }

    let sortDirectionValue = sortDirection;
    if (params.has('sortDirection')) {
      const candidate = (params.get('sortDirection') || '').toLowerCase();
      if (candidate === 'desc' || candidate === 'asc') {
        sortDirectionValue = candidate;
        setSortDirection(candidate);
      } else {
        params.delete('sortDirection');
        historyNeedsUpdate = true;
      }
    }

    let durationValue = durationMin;
    if (params.has('durationMin')) {
      durationValue = params.get('durationMin') || '';
      setDurationMin(durationValue);
    }

    let phoneValue = phoneFilter;
    if (params.has('phone')) {
      const rawPhoneParam = params.get('phone') || '';
      const normalizedPhoneParam = stripPhoneFormatting(rawPhoneParam);
      phoneValue = normalizedPhoneParam;
      setPhoneFilter(normalizedPhoneParam);
      if (rawPhoneParam !== normalizedPhoneParam) {
        if (normalizedPhoneParam) {
          params.set('phone', normalizedPhoneParam);
        } else {
          params.delete('phone');
        }
        historyNeedsUpdate = true;
      }
    }

    let emailValue = emailFilter;
    if (params.has('email')) {
      emailValue = params.get('email') || '';
      setEmailFilter(emailValue);
    }

    let callIdValue = callIdFilter;
    if (params.has('callId')) {
      callIdValue = params.get('callId') || '';
      setCallIdFilter(callIdValue);
    }

    let timeModeValue = timeMode;
    if (params.has('timeMode')) {
      const candidate = (params.get('timeMode') || '').toLowerCase();
      if (candidate === 'none' || candidate === 'range') {
        timeModeValue = candidate;
        setTimeMode(candidate);
      } else {
        params.delete('timeMode');
        historyNeedsUpdate = true;
      }
    }

    let timeStartValue = timePickerStart;
    let timeEndValue = timePickerEnd;
    if (timeModeValue === 'range') {
      if (params.has('timeStart')) {
        timeStartValue = parseTimeParam(params.get('timeStart'));
        setTimePickerStart(timeStartValue);
      }
      if (params.has('timeEnd')) {
        timeEndValue = parseTimeParam(params.get('timeEnd'));
        setTimePickerEnd(timeEndValue);
      }
    } else {
      timeStartValue = null;
      timeEndValue = null;
      setTimePickerStart(null);
      setTimePickerEnd(null);
    }

    if (historyNeedsUpdate) {
      const newSearch = params.toString();
      const newUrl = newSearch ? `${location.pathname}?${newSearch}` : location.pathname;
      window.history.replaceState(null, '', newUrl);
    }

    fetchFiles(
      startFromQuery,
      endFromQuery,
      offsetValue,
      limitValue,
      sortColumnValue,
      sortDirectionValue,
      durationValue,
      phoneValue,
      emailValue,
      timeModeValue === 'range' ? timeStartValue : null,
      timeModeValue === 'range' ? timeEndValue : null,
      timeModeValue,
      callIdValue
    );

    return () => {
      clearTimeout(timerId);
      applyingUrlParamsRef.current = false;
    };
  }, [location.pathname, location.search, isLoaded]);

  const handleSort = (column) => {
    const normalized = column === 'duration' ? 'durationMs' : column;
    const isAsc = sortColumn === normalized && sortDirection === "asc";
    const newDirection = isAsc ? "desc" : "asc";
    setSortColumn(normalized);
    setSortDirection(newDirection);
    fetchFiles(calendarDateStart, calendarDateEnd, 0, filesPerPage, normalized, newDirection);
  };

  const handlePageChange = (event, value) => {
    const newOffset = (value - 1) * filesPerPage;
    fetchFiles(calendarDateStart, calendarDateEnd, newOffset);
  };

  // Optimized waveform generation with chunked processing
  // Legacy waveform generation function (deprecated - now using backend API)
  const generateWaveformDataOptimized = async (audioBlob, filename) => {
    console.log('⚠️ Legacy waveform function called - now using backend API');
    return; // Skip legacy processing
    try {
      setIsGeneratingWaveform(true);
      
      // Create audio context for analysis
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const arrayBuffer = await audioBlob.arrayBuffer();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      
      // Get channel data
      const channelData = audioBuffer.getChannelData(0);
      const sampleRate = audioBuffer.sampleRate;
      const duration = audioBuffer.duration;
      
      // Reduce resolution for faster processing on long files
      const maxWaveformWidth = 600; // Fewer points for better performance
      const waveformWidth = Math.min(maxWaveformWidth, Math.floor(duration * 10)); // 10 points per second max
      const samplesPerPixel = Math.floor(channelData.length / waveformWidth);
      const waveform = [];
      
      // Process in chunks to avoid blocking the UI
      const chunkSize = 50; // Process 50 points at a time
      
      const processChunk = async (startIndex) => {
        const endIndex = Math.min(startIndex + chunkSize, waveformWidth);
        
        for (let i = startIndex; i < endIndex; i++) {
          const startSample = i * samplesPerPixel;
          const endSample = Math.min(startSample + samplesPerPixel, channelData.length);
          
          // Calculate RMS for this pixel (simplified for speed)
          let sum = 0;
          let count = 0;
          const step = Math.max(1, Math.floor((endSample - startSample) / 100)); // Sample every nth point for speed
          
          for (let j = startSample; j < endSample; j += step) {
            sum += channelData[j] * channelData[j];
            count++;
          }
          
          const rms = count > 0 ? Math.sqrt(sum / count) : 0;
          const amplitude = Math.min(1, rms * 4); // Amplify for visibility
          waveform.push(amplitude);
        }
        
        // Update UI with partial waveform
        if (waveform.length > 0) {
          setWaveformData({
            data: [...waveform], // Copy array to trigger re-render
            duration: duration,
            filename: filename,
            sampleRate: sampleRate,
            isPartial: endIndex < waveformWidth
          });
        }
        
        // Continue processing if not done
        if (endIndex < waveformWidth) {
          // Yield control back to browser
          setTimeout(() => processChunk(endIndex), 5);
        } else {
          // Final update
          setWaveformData({
            data: waveform,
            duration: duration,
            filename: filename,
            sampleRate: sampleRate,
            isPartial: false
          });
          
          console.log('Optimized waveform generated:', {
            filename,
            duration,
            dataPoints: waveform.length,
            maxAmplitude: Math.max(...waveform),
            avgAmplitude: waveform.reduce((a, b) => a + b, 0) / waveform.length
          });
          
          setIsGeneratingWaveform(false);
          audioContext.close();
        }
      };
      
      // Start processing
      processChunk(0);
      
    } catch (error) {
      console.error('Failed to generate optimized waveform:', error);
      setIsGeneratingWaveform(false);
    }
  };

  // Generate waveform data asynchronously in background
  // Legacy waveform generation function (deprecated - now using backend API)
  const generateWaveformDataAsync = async (token, filename) => {
    console.log('⚠️ Legacy waveform function called - now using backend API');
    return; // Skip legacy processing
    try {
      setIsGeneratingWaveform(true);
      
      // Fetch audio data for waveform analysis
      const response = await fetch(`/api/audio/${encodeURIComponent(filename)}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (!response.ok) {
        console.error('Failed to fetch audio for waveform:', response.status);
        return;
      }
      
      const audioBlob = await response.blob();
      await generateWaveformData(audioBlob, filename);
      
    } catch (error) {
      console.error('Failed to generate waveform asynchronously:', error);
    } finally {
      setIsGeneratingWaveform(false);
    }
  };

  // Generate waveform data from audio blob
  // Legacy waveform generation function (deprecated - now using backend API)
  const generateWaveformData = async (audioBlob, filename) => {
    console.log('⚠️ Legacy waveform function called - now using backend API');
    return; // Skip legacy processing
    try {
      setIsGeneratingWaveform(true);
      
      // Create audio context for analysis
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const arrayBuffer = await audioBlob.arrayBuffer();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      
      // Get channel data (use first channel for mono, or mix channels for stereo)
      const channelData = audioBuffer.getChannelData(0);
      const sampleRate = audioBuffer.sampleRate;
      const duration = audioBuffer.duration;
      
      // Create waveform with desired resolution (pixels wide)
      const waveformWidth = 800; // Match our player width
      const samplesPerPixel = Math.floor(channelData.length / waveformWidth);
      const waveform = [];
      
      for (let i = 0; i < waveformWidth; i++) {
        const startSample = i * samplesPerPixel;
        const endSample = Math.min(startSample + samplesPerPixel, channelData.length);
        
        // Calculate RMS (Root Mean Square) for this pixel
        let sum = 0;
        let count = 0;
        for (let j = startSample; j < endSample; j++) {
          sum += channelData[j] * channelData[j];
          count++;
        }
        
        const rms = count > 0 ? Math.sqrt(sum / count) : 0;
        // Normalize and apply some smoothing
        const amplitude = Math.min(1, rms * 3); // Amplify quiet sounds
        waveform.push(amplitude);
      }
      
      // Store waveform data with metadata
      setWaveformData({
        data: waveform,
        duration: duration,
        filename: filename,
        sampleRate: sampleRate
      });
      
      console.log('Waveform generated:', {
        filename,
        duration,
        dataPoints: waveform.length,
        maxAmplitude: Math.max(...waveform),
        avgAmplitude: waveform.reduce((a, b) => a + b, 0) / waveform.length
      });
      
      // Clean up audio context
      audioContext.close();
      
    } catch (error) {
      console.error('Failed to generate waveform:', error);
    } finally {
      setIsGeneratingWaveform(false);
    }
  };

  const playAudio = async (filename) => {
    // Stop current audio if playing
    if (playing) {
      playing.pause();
      setPlaying(null);
      setIsPlaying(false);
      setCurrentTrack(null);
    }

    // Clear old waveform data when starting new track
    setWaveformData(null);

    try {
      // Get authentication token
      const token = await getToken();
      
      // Create new audio element
      const audio = new Audio();
      
      // OPTIMIZATION 1: Set up event listeners FIRST
      audio.addEventListener('loadedmetadata', () => {
        setDuration(audio.duration);
      });
      
      audio.addEventListener('timeupdate', () => {
        setCurrentTime(audio.currentTime);
      });
      
      audio.addEventListener('ended', () => {
        setPlaying(null);
        setIsPlaying(false);
        setCurrentTrack(null);
        setCurrentTime(0);
        setWaveformData(null);
      });
      
      audio.addEventListener('error', (e) => {
        console.error('Audio playback error:', e);
        setPlaying(null);
        setIsPlaying(false);
        setCurrentTrack(null);
        setWaveformData(null);
      });

      // OPTIMIZATION 2: Set volume immediately
      audio.volume = volume;
      
      // OPTIMIZATION 3: Start UI updates immediately (optimistic)
      setCurrentTrack(filename);
      
      console.log('🎵 Streaming audio for:', filename);
      const startTime = performance.now();
      
      // Set the audio source to stream directly from the server
      // No blob creation - direct streaming!
      const streamUrl = `/api/audio/${encodeURIComponent(filename)}`;
      
      // For direct streaming, we need to handle auth differently
      // Create a fetch request but don't await the blob - use the URL directly
      const authResponse = await fetch(streamUrl, {
        method: 'HEAD', // Just check auth
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (!authResponse.ok) {
        console.error('Failed to authenticate for audio stream:', authResponse.status);
        setCurrentTrack(null);
        return;
      }
      
      // Now set the audio source to stream directly
      // Note: This won't work with auth headers, so we need a different approach
      // Let's create a signed URL or use a session-based approach
      audio.src = `${streamUrl}?auth=${encodeURIComponent(token)}`;
      
      console.log('🔗 Audio streaming URL set:', streamUrl);
      
      const loadTime = performance.now() - startTime;
      console.log(`⚡ Audio stream URL set in ${loadTime.toFixed(2)}ms`);
      
      // OPTIMIZATION 4: Start playback as soon as audio is ready
      const playStartTime = performance.now();
      
      try {
        await audio.play();
        const playTime = performance.now() - playStartTime;
        console.log(`🚀 Playback started in ${playTime.toFixed(0)}ms (Total: ${(performance.now() - startTime).toFixed(0)}ms)`);
        
        setPlaying(audio);
        setIsPlaying(true);
        
      } catch (playError) {
        console.error('Failed to start playback:', playError);
        setCurrentTrack(null);
        cleanup();
        return;
      }
      
      // OPTIMIZATION 6: Generate waveform from backend API
      setTimeout(async () => {
        console.log('🌊 Starting backend waveform generation...');
        try {
          const waveformResponse = await fetch(`/api/waveform/${encodeURIComponent(filename)}`, {
            headers: {
              'Authorization': `Bearer ${token}`
            }
          });
          
          if (waveformResponse.ok) {
            const waveformResult = await waveformResponse.json();
            setWaveformData(waveformResult.waveform);
            console.log(`📊 Waveform loaded: ${waveformResult.waveform.length} points (${waveformResult.cached ? 'cached' : 'generated'})`);
            if (!waveformResult.cached && waveformResult.generationTime) {
              console.log(`⏱️ Waveform generation took: ${waveformResult.generationTime}ms`);
              if (waveformResult.duration) {
                console.log(`🎵 Audio duration: ${waveformResult.duration.toFixed(1)}s, Sample rate: ${waveformResult.sampleRate}Hz`);
                console.log(`🎯 Time per waveform point: ${(waveformResult.duration / waveformResult.waveform.length).toFixed(3)}s`);
                console.log(`📄 Waveform source: ${waveformResult.source || 'unknown'}`);
              }
            }
          } else {
            console.error('Failed to load waveform:', waveformResponse.status);
          }
        } catch (waveformError) {
          console.error('Error loading waveform:', waveformError);
        }
      }, 25); // Minimal delay to ensure playback takes priority
      
    } catch (error) {
      console.error('Error playing audio:', error);
    }
  };

  const pauseAudio = () => {
    if (playing) {
      playing.pause();
      setIsPlaying(false);
    }
  };

  const resumeAudio = () => {
    if (playing) {
      playing.play();
      setIsPlaying(true);
    }
  };

  const stopAudio = () => {
    if (playing) {
      playing.pause();
      playing.currentTime = 0;
      setPlaying(null);
      setIsPlaying(false);
      setCurrentTrack(null);
      setCurrentTime(0);
      setWaveformData(null); // Clear waveform data
    }
  };

  const seekTo = (time) => {
    if (playing && duration > 0) {
      const newTime = Math.max(0, Math.min(time, duration));
      playing.currentTime = newTime;
      setCurrentTime(newTime);
    }
  };

  const handleVolumeChange = (newVolume) => {
    setVolume(newVolume);
    if (playing) {
      playing.volume = newVolume;
    }
  };

  const seekForward = () => {
    if (playing) {
      seekTo(playing.currentTime + 10); // Seek forward 10 seconds
    }
  };

  const seekBackward = () => {
    if (playing) {
      seekTo(playing.currentTime - 10); // Seek backward 10 seconds
    }
  };

  const handleProgressClick = (event) => {
    if (playing && duration > 0) {
      const progressBar = event.currentTarget;
      const rect = progressBar.getBoundingClientRect();
      const clickX = event.clientX - rect.left;
      const progressWidth = rect.width;
      const newTime = (clickX / progressWidth) * duration;
      const clampedTime = Math.max(0, Math.min(newTime, duration));
      playing.currentTime = clampedTime;
      setCurrentTime(clampedTime);
    }
  };

  const downloadFile = async (filename) => {
    if (!canDownload) {
      return;
    }

    try {
      const token = await getToken();
      const response = await fetch(`/api/download/${encodeURIComponent(filename)}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        if (response.status === 403) {
          return;
        } else {
          alert('Failed to download file. Please try again.');
        }
        return;
      }

      // Create download link
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename.split('/').pop();
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error('Download error:', error);
      alert('Failed to download file. Please try again.');
    }
  };

  const handleFilesPerPageChange = (event) => {
    const newLimit = event.target.value;
    setFilesPerPage(newLimit);
    fetchFiles(calendarDateStart, calendarDateEnd, 0, newLimit);
  };

  const handleFilterChange = () => {
    fetchFiles(calendarDateStart, calendarDateEnd, 0, filesPerPage, null, null, durationMin, phoneFilter, emailFilter, timePickerStart, timePickerEnd, timeMode);
  };

  useEffect(() => {
    if (applyingUrlParamsRef.current) return;
    const delayedFilterChange = setTimeout(() => {
      if (calendarDateStart) {
        handleFilterChange();
      }
    }, 300);
    return () => clearTimeout(delayedFilterChange);
  }, [phoneFilter, emailFilter, durationMin, timePickerStart, timePickerEnd, timeMode]);

  // Keyboard controls for audio player
  useEffect(() => {
    const handleKeyDown = (event) => {
      // Only handle keyboard events when audio is playing and not typing in input fields
      if (!playing || event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') {
        return;
      }

      console.log('Key pressed:', event.key, 'Playing:', !!playing); // Debug log

      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault();
          if (playing && duration > 0) {
            const newTime = Math.max(0, playing.currentTime - 5);
            playing.currentTime = newTime;
            setCurrentTime(newTime);
          }
          break;
        case 'ArrowRight':
          event.preventDefault();
          if (playing && duration > 0) {
            const newTime = Math.min(duration, playing.currentTime + 5);
            playing.currentTime = newTime;
            setCurrentTime(newTime);
          }
          break;
        case ' ': // Spacebar for play/pause
          event.preventDefault();
          if (playing) {
            if (isPlaying) {
              playing.pause();
              setIsPlaying(false);
            } else {
              playing.play();
              setIsPlaying(true);
            }
          }
          break;
        default:
          break;
      }
    };

    // Add event listener
    document.addEventListener('keydown', handleKeyDown);

    // Cleanup
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [playing, isPlaying]); // Dependencies: re-setup when playing state changes

  if (!isLoaded) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="200px">
        <CircularProgress />
      </Box>
    );
  }

  if (!user) {
    return (
      <Box sx={{ p: 3, maxWidth: 600, mx: 'auto', mt: 4 }}>
        <Alert severity="info">
          <Typography variant="h6">Please Sign In</Typography>
          <Typography>You need to be signed in to view recordings.</Typography>
        </Alert>
      </Box>
    );
  }

  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <Container maxWidth="xl" sx={{ py: 4 }}>
        <Typography variant="h4" gutterBottom>
          MTGPros Five9 Recordings {isAdmin && '(Admin View)'}
        </Typography>
        
        {/* Audio Player */}
        {currentTrack && (
          <Paper 
            elevation={3} 
            sx={{ 
              position: 'fixed', 
              bottom: 20, 
              left: '50%', 
              transform: 'translateX(-50%)', 
              p: 2, 
              zIndex: 1000,
              minWidth: 600,
              maxWidth: 800,
              background: darkMode ? '#424242' : '#fff'
            }}
          >
            <Box>
              <Typography variant="subtitle2" noWrap sx={{ mb: 2 }}>
                Now Playing: {currentTrack.split('/').pop()}
                {waveformData && Array.isArray(waveformData) && (
                  <span style={{ fontSize: '0.7em', opacity: 0.7, marginLeft: '10px' }}>
                    (Waveform: {waveformData.length} points)
                  </span>
                )}
              </Typography>
              
              {/* Waveform Seek Bar Row - Full Width */}
              <Box sx={{ mb: 2 }}>
                <Box 
                  onClick={handleProgressClick}
                  sx={{ 
                    cursor: 'pointer',
                    py: 2,
                    position: 'relative',
                    height: 60, // Taller for waveform
                    backgroundColor: darkMode ? '#333' : '#f5f5f5',
                    borderRadius: 3,
                    overflow: 'hidden',
                    '&:hover': {
                      backgroundColor: darkMode ? '#404040' : '#eeeeee'
                    }
                  }}
                >
                  {/* Waveform Visualization */}
                  {waveformData && Array.isArray(waveformData) && currentTrack ? (
                    <Box sx={{ 
                      position: 'absolute', 
                      top: 0, 
                      left: 0, 
                      right: 0, 
                      bottom: 0,
                      display: 'flex',
                      alignItems: 'flex-end', // Align bars to bottom
                      justifyContent: 'space-between',
                      px: 1,
                      gap: 0.1
                    }}>
                      {/* Waveform bars */}
                      {waveformData && Array.isArray(waveformData) && waveformData.map((amplitude, index) => {
                        // Enhanced amplitude scaling for better visibility
                        const minHeight = 2;
                        const maxHeight = 45;
                        const scaledHeight = Math.max(minHeight, amplitude * maxHeight);
                        
                        // Color intensity based on amplitude
                        const intensity = Math.min(1, amplitude * 2); // Amplify for color
                        const color = darkMode 
                          ? `rgba(144, 202, 249, ${0.3 + intensity * 0.7})` 
                          : `rgba(25, 118, 210, ${0.4 + intensity * 0.6})`;
                        
                        return (
                        <Box
                          key={index}
                          sx={{
                            flex: '1 1 0px', // Equal width distribution
                            minWidth: '1px',
                            maxWidth: '2px',
                            height: scaledHeight + 'px',
                            backgroundColor: color,
                            borderRadius: '1px 1px 0 0', // Rounded top
                            opacity: 0.8
                          }}
                        />
                        );
                      })}
                      
                      {/* Progress overlay */}
                      <Box sx={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        height: '100%',
                        width: duration ? `${(currentTime / duration) * 100}%` : '0%',
                        backgroundColor: darkMode ? 'rgba(144, 202, 249, 0.3)' : 'rgba(25, 118, 210, 0.3)',
                        transition: 'width 0.1s ease'
                      }} />
                      
                      {/* Current position indicator */}
                      <Box sx={{
                        position: 'absolute',
                        top: 0,
                        left: duration ? `${(currentTime / duration) * 100}%` : '0%',
                        height: '100%',
                        width: '2px',
                        backgroundColor: darkMode ? '#fff' : '#333',
                        transform: 'translateX(-1px)',
                        transition: 'left 0.1s ease'
                      }} />
                      
                      {/* Waveform generation progress indicator */}
                      {isGeneratingWaveform && (
                        <Box sx={{
                          position: 'absolute',
                          top: 4,
                          right: 4,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 0.5,
                          backgroundColor: 'rgba(0,0,0,0.7)',
                          borderRadius: 1,
                          px: 1,
                          py: 0.5
                        }}>
                          <CircularProgress size={12} sx={{ color: '#fff' }} />
                          <Typography variant="caption" sx={{ color: '#fff', fontSize: '0.6rem' }}>
                            {waveformData?.isPartial ? 'Building...' : 'Analyzing...'}
                          </Typography>
                        </Box>
                      )}
                    </Box>
                  ) : isGeneratingWaveform ? (
                    // Loading state while generating waveform
                    <Box sx={{ 
                      display: 'flex', 
                      alignItems: 'center', 
                      justifyContent: 'center', 
                      height: '100%',
                      gap: 1
                    }}>
                      <CircularProgress size={20} />
                      <Typography variant="caption" sx={{ opacity: 0.7 }}>
                        Analyzing audio...
                      </Typography>
                    </Box>
                  ) : (
                    // Fallback to regular progress bar
                    <Box sx={{ display: 'flex', alignItems: 'center', height: '100%', px: 2 }}>
                      <LinearProgress 
                        variant="determinate" 
                        value={duration ? (currentTime / duration) * 100 : 0}
                        sx={{ 
                          width: '100%',
                          height: 8,
                          borderRadius: 4,
                          backgroundColor: darkMode ? '#555' : '#e0e0e0',
                          '& .MuiLinearProgress-bar': {
                            borderRadius: 4,
                            backgroundColor: darkMode ? '#90caf9' : '#1976d2'
                          }
                        }}
                      />
                    </Box>
                  )}
                </Box>
                
                {/* Time display under the seek bar */}
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 1 }}>
                  <Typography variant="caption" sx={{ opacity: 0.7 }}>
                    {Math.floor(currentTime / 60)}:{(Math.floor(currentTime % 60)).toString().padStart(2, '0')}
                  </Typography>
                  <Typography variant="caption" sx={{ opacity: 0.7 }}>
                    {Math.floor(duration / 60)}:{(Math.floor(duration % 60)).toString().padStart(2, '0')}
                  </Typography>
                </Box>
              </Box>
              
              {/* Controls Row */}
              <Box display="flex" alignItems="center" justifyContent="space-between">
                <Box display="flex" alignItems="center" gap={1}>
                  <IconButton onClick={seekBackward} size="small" title="Rewind 10s">
                    <FastRewindIcon />
                  </IconButton>
                  
                  <IconButton 
                    onClick={isPlaying ? pauseAudio : resumeAudio} 
                    color="primary"
                    size="medium"
                  >
                    {isPlaying ? <PauseIcon /> : <PlayArrowIcon />}
                  </IconButton>
                  
                  <IconButton onClick={seekForward} size="small" title="Forward 10s">
                    <FastForwardIcon />
                  </IconButton>
                  
                  <IconButton onClick={stopAudio} size="small">
                    <StopIcon />
                  </IconButton>
                </Box>
                
                <Box sx={{ display: 'flex', alignItems: 'center', minWidth: 120 }}>
                  <VolumeUpIcon fontSize="small" sx={{ mr: 1, opacity: 0.7 }} />
                  <Slider
                    size="small"
                    value={volume}
                    min={0}
                    max={1}
                    step={0.05}
                    onChange={(_, newValue) => handleVolumeChange(newValue)}
                    sx={{ 
                      width: 80,
                      '& .MuiSlider-thumb': {
                        width: 12,
                        height: 12,
                      }
                    }}
                  />
                </Box>
              </Box>
              
              {/* Keyboard shortcuts hint */}
              <Typography 
                variant="caption" 
                sx={{ 
                  display: 'block', 
                  textAlign: 'center', 
                  mt: 1, 
                  opacity: 0.6, 
                  fontSize: '0.65rem' 
                }}
              >
                ← → arrow keys: seek ±5s | spacebar: play/pause
              </Typography>
            </Box>
          </Paper>
        )}

        <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
          <Box display="flex" alignItems="center" gap={2}>
            <Typography variant="h6">
              {calendarDateStart
                ? `${calendarDateEnd ? `${dayjs(calendarDateStart).format("MMM D")} - ${dayjs(calendarDateEnd).format("MMM D, YYYY")}` : dayjs(calendarDateStart).format("MMM D, YYYY")}`
                : "Select dates to view recordings"}
            </Typography>
            <IconButton 
              onClick={() => refreshFiles(true)} 
              disabled={loading || !calendarDateStart}
              color="primary"
            >
              <RefreshIcon />
            </IconButton>
          </Box>
        </Box>

        {/* Date Selection */}
        <Paper elevation={1} sx={{ p: 2, mb: 2, backgroundColor: darkMode ? 'grey.900' : 'grey.50' }}>
          <Typography variant="h6" gutterBottom>
            Date Selection
          </Typography>
          <Box display="flex" gap={2} alignItems="center" flexWrap="wrap">
            <DatePicker
              label="Start Date"
              value={calendarDateStart}
              onChange={(newValue) => {
                setCalendarDateStart(newValue);
                if (newValue) {
                  fetchFiles(newValue, calendarDateEnd, 0);
                }
              }}
              slotProps={{ textField: { size: 'small' } }}
            />
            <DatePicker
              label="End Date (Optional)"
              value={calendarDateEnd}
              onChange={(newValue) => {
                setCalendarDateEnd(newValue);
                if (calendarDateStart) {
                  fetchFiles(calendarDateStart, newValue, 0);
                }
              }}
              slotProps={{ textField: { size: 'small' } }}
            />
          </Box>
        </Paper>

        {/* Column filters */}
        <Grid container spacing={2} mb={2}>
          <Grid item xs={12} md={3}>
            <TextField
              fullWidth
              size="small"
              label="Phone Number"
              value={phoneFilter}
              onChange={(e) => setPhoneFilter(stripPhoneFormatting(e.target.value))}
              InputProps={{
                startAdornment: <InputAdornment position="start">📞</InputAdornment>,
              }}
            />
          </Grid>
          <Grid item xs={12} md={3}>
            <TextField
              fullWidth
              size="small"
              label="Call ID"
              value={callIdFilter}
              onChange={(e) => setCallIdFilter(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') refreshFiles(true); }}
              InputProps={{
                startAdornment: <InputAdornment position="start">🆔</InputAdornment>,
              }}
              helperText={callIdFilter ? 'Substring match (2+ chars auto)' : 'Enter 2+ chars for auto filter'}
            />
          </Grid>
          <Grid item xs={12} md={3}>
            <TextField
              fullWidth
              size="small"
              label="Email"
              value={(isAdmin || userRole === undefined) ? emailFilter : userEmail}
              onChange={(e) => (isAdmin || userRole === undefined) && setEmailFilter(e.target.value)}
              disabled={!(isAdmin || userRole === undefined)}
              InputProps={{
                startAdornment: <InputAdornment position="start">📧</InputAdornment>,
              }}
            />
          </Grid>
          <Grid item xs={12} md={2}>
            <TextField
              fullWidth
              size="small"
              label="Min Duration"
              value={durationMin}
              onChange={(e) => setDurationMin(e.target.value)}
              InputProps={{
                startAdornment: <InputAdornment position="start">⏱️</InputAdornment>,
              }}
            />
          </Grid>
        </Grid>
        <Grid container spacing={2} mb={2}>
          <Grid item xs={6} md={3}>
            <TimePicker
              label="Start Time"
              value={timePickerStart}
              onChange={setTimePickerStart}
              disabled={timeMode !== 'range'}
              slotProps={{ textField: { size: 'small', fullWidth: true } }}
            />
          </Grid>
          <Grid item xs={6} md={3}>
            <TimePicker
              label="End Time"
              value={timePickerEnd}
              onChange={setTimePickerEnd}
              disabled={timeMode !== 'range'}
              slotProps={{ textField: { size: 'small', fullWidth: true } }}
            />
          </Grid>
          <Grid item xs={12} md={3} sx={{ display:'flex', alignItems:'center' }}>
            <FormControl fullWidth size="small">
              <InputLabel>Time Filter</InputLabel>
              <Select value={timeMode} onChange={(e) => setTimeMode(e.target.value)}>
                <MenuItem value="range">Time Range</MenuItem>
                <MenuItem value="none">No Time Filter</MenuItem>
              </Select>
            </FormControl>
          </Grid>
        </Grid>

        {/* Results and pagination controls */}
        <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
          <Typography variant="body2" color="text.secondary">
            {loading ? "Loading..." : `Showing ${files.length} of ${totalCount.toLocaleString()} files`}
          </Typography>
          <Box display="flex" alignItems="center" gap={2}>
            <FormControl size="small">
              <InputLabel>Per Page</InputLabel>
              <Select value={filesPerPage} onChange={handleFilesPerPageChange}>
                <MenuItem value={10}>10</MenuItem>
                <MenuItem value={25}>25</MenuItem>
                <MenuItem value={50}>50</MenuItem>
                <MenuItem value={100}>100</MenuItem>
              </Select>
            </FormControl>
          </Box>
        </Box>

        {error500 && (
          <Paper sx={{ p: 2, mb: 2, backgroundColor: 'error.light' }}>
            <Typography color="error.contrastText">
              ❌ Server error occurred. Please try again or contact support.
            </Typography>
          </Paper>
        )}

        {loading && (
          <Box display="flex" justifyContent="center" mb={2}>
            <CircularProgress />
          </Box>
        )}

        {files.length === 0 && !loading && calendarDateStart && (
          <Paper sx={{ p: 4, textAlign: 'center', backgroundColor: darkMode ? 'grey.900' : 'grey.50' }}>
            <Typography variant="h6" color="text.secondary">
              No recordings found for the selected criteria
            </Typography>
          </Paper>
        )}

        {files.length > 0 && (
          <>
            <TableContainer component={Paper} sx={{ mb: 2 }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>
                      <TableSortLabel
                        active={sortColumn === 'date'}
                        direction={sortColumn === 'date' ? sortDirection : 'asc'}
                        onClick={() => handleSort('date')}
                      >
                        Date
                      </TableSortLabel>
                    </TableCell>
                    <TableCell>
                      <TableSortLabel
                        active={sortColumn === 'time'}
                        direction={sortColumn === 'time' ? sortDirection : 'asc'}
                        onClick={() => handleSort('time')}
                      >
                        Time
                      </TableSortLabel>
                    </TableCell>
                    <TableCell>
                      <TableSortLabel
                        active={sortColumn === 'callId'}
                        direction={sortColumn === 'callId' ? sortDirection : 'asc'}
                        onClick={() => handleSort('callId')}
                      >
                        Call ID
                      </TableSortLabel>
                    </TableCell>
                    <TableCell>
                      <TableSortLabel
                        active={sortColumn === 'phone'}
                        direction={sortColumn === 'phone' ? sortDirection : 'asc'}
                        onClick={() => handleSort('phone')}
                      >
                        Phone
                      </TableSortLabel>
                    </TableCell>
                    <TableCell>
                      <TableSortLabel
                        active={sortColumn === 'email'}
                        direction={sortColumn === 'email' ? sortDirection : 'asc'}
                        onClick={() => handleSort('email')}
                      >
                        Email
                      </TableSortLabel>
                    </TableCell>
                    <TableCell>
                      <TableSortLabel
                        active={sortColumn === 'durationMs'}
                        direction={sortColumn === 'durationMs' ? sortDirection : 'asc'}
                        onClick={() => handleSort('durationMs')}
                      >
                        Duration
                      </TableSortLabel>
                    </TableCell>
                    <TableCell align="center">Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {files.map((fileInfo, index) => (
                    <TableRow key={index} hover>
                      <TableCell>{fileInfo.date}</TableCell>
                      <TableCell>{fileInfo.time}</TableCell>
                      <TableCell>{fileInfo.callId || '-'}</TableCell>
                      <TableCell>{fileInfo.phone}</TableCell>
                      <TableCell>{fileInfo.email}</TableCell>
                      <TableCell>{formatDuration(fileInfo.durationMs)}</TableCell>
                      <TableCell align="center">
                        <IconButton 
                          color="primary" 
                          onClick={() => playAudio(fileInfo.file)}
                          size="small"
                          title="Play"
                        >
                          <PlayArrowIcon />
                        </IconButton>
                        {canDownload && (
                          <IconButton 
                            color="secondary" 
                            onClick={() => downloadFile(fileInfo.file)}
                            size="small"
                            title="Download"
                            sx={{ ml: 1 }}
                          >
                            <DownloadIcon />
                          </IconButton>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>

            <Box display="flex" justifyContent="center">
              <Pagination
                count={Math.ceil(totalCount / filesPerPage)}
                page={Math.floor(currentOffset / filesPerPage) + 1}
                onChange={handlePageChange}
                color="primary"
                showFirstButton
                showLastButton
              />
            </Box>
          </>
        )}
      </Container>
    </LocalizationProvider>
  );
}

export default FileViewer;