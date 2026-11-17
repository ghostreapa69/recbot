// Badge and streak rules, computed from an agent's scored calls (oldest first).
// Edit the thresholds here to tune them; nothing is stored.
import dayjs from 'dayjs';

export const HOT_STREAK_MIN = 5;

// Length of the run that ends at the newest call, and the longest run anywhere.
function runs(values, pass) {
  let current = 0;
  let best = 0;
  for (const v of values) {
    current = pass(v) ? current + 1 : 0;
    best = Math.max(best, current);
  }
  return { current, best };
}

const RULES = [
  {
    id: 'strong-opener',
    name: 'Strong opener',
    description: '10 calls in a row with Introduction at +7 or better',
    goal: 10,
    progress: ({ history }) => runs(history, c => c.intro >= 7)
  },
  {
    id: 'objection-crusher',
    name: 'Objection crusher',
    description: '5 calls in a row with an objection handled at +6 or better',
    goal: 5,
    progress: ({ history }) => runs(history.filter(c => c.objection !== null), c => c.objection >= 6)
  },
  {
    id: 'steady-hand',
    name: 'Steady hand',
    description: 'A week with at least 5 scored calls and none below 0',
    goal: 5,
    progress: ({ history }) => {
      const weeks = new Map();
      for (const c of history) {
        const key = dayjs(c.call_date).startOf('week').format('YYYY-MM-DD');
        const w = weeks.get(key) || { calls: 0, clean: true };
        w.calls++;
        if (c.overall < 0) w.clean = false;
        weeks.set(key, w);
      }
      const best = Math.max(0, ...[...weeks.values()].filter(w => w.clean).map(w => w.calls));
      const thisWeek = weeks.get(dayjs().startOf('week').format('YYYY-MM-DD'));
      return { current: thisWeek?.clean ? thisWeek.calls : 0, best };
    }
  },
  {
    id: 'most-improved',
    name: 'Most improved',
    description: 'Biggest rise in average score on the team, this week vs last week',
    goal: 1,
    progress: ({ email, teamChange }) => {
      const rises = teamChange
        .filter(t => t.current !== null && t.previous !== null)
        .map(t => ({ email: t.email, rise: t.current - t.previous }));
      const top = rises.reduce((a, b) => (b.rise > (a?.rise ?? -Infinity) ? b : a), null);
      const isTop = Boolean(top && top.email === email && top.rise > 0);
      return { current: isTop ? 1 : 0, best: isTop ? 1 : 0 };
    }
  },
  {
    id: 'century',
    name: 'Century',
    description: '100 scored calls',
    goal: 100,
    progress: ({ history }) => ({ current: history.length, best: history.length })
  }
];

export function computeBadges({ email, history, teamChange = [] }) {
  const streak = runs(history, c => c.overall >= HOT_STREAK_MIN);
  const badges = RULES.map(rule => {
    const { current, best } = rule.progress({ email, history, teamChange });
    return {
      id: rule.id,
      name: rule.name,
      description: rule.description,
      earned: best >= rule.goal,
      progress: Math.min(current, rule.goal),
      goal: rule.goal
    };
  });
  return { streak: { current: streak.current, best: streak.best, threshold: HOT_STREAK_MIN }, badges };
}
