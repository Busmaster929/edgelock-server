// ════════════════════════════════════════════════════════════
// EdgeLock Scheduler — runs daily at 7am ET
// Fetches live odds + props, generates AI insights via Claude,
// writes data/slate.json which the app loads on startup
// ════════════════════════════════════════════════════════════

import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.join(__dirname, 'data');
const SLATE_FILE = path.join(DATA_DIR, 'slate.json');

const ODDS_KEY  = process.env.ODDS_API_KEY;
const ANTH_KEY  = process.env.ANTHROPIC_API_KEY;
const ODDS_BASE = 'https://api.the-odds-api.com/v4';

// ── Sport configs — active seasons only ──
// Edit this object each season as sports go in/out
const ACTIVE_SPORTS = {
  nba:  { key: 'basketball_nba',    label: 'NBA',  emoji: '🏀', active: true  },
  nhl:  { key: 'icehockey_nhl',     label: 'NHL',  emoji: '🏒', active: true  },
  wnba: { key: 'basketball_wnba',   label: 'WNBA', emoji: '🏀', active: true  },
  mlb:  { key: 'baseball_mlb',      label: 'MLB',  emoji: '⚾', active: true  },
  nfl:  { key: 'americanfootball_nfl', label: 'NFL', emoji: '🏈', active: false },
};

// ── Team emoji map ──
const TEAM_EMOJI = {
  'New York Knicks':'🗽','Cleveland Cavaliers':'🏀','OKC Thunder':'⚡','San Antonio Spurs':'🤠',
  'Carolina Hurricanes':'🌀','Montreal Canadiens':'🔴','Colorado Avalanche':'🏔️','Vegas Golden Knights':'⚔️',
  'Las Vegas Aces':'♠️','Indiana Fever':'🌡️','Minnesota Lynx':'🐾','Atlanta Dream':'🍑',
  'Dallas Wings':'🦋','Golden State Valkyries':'⚔️',
  'New York Yankees':'⚾','Toronto Blue Jays':'🔵','New York Mets':'🔵',
  'Washington Nationals':'⭐','Atlanta Braves':'🗡️','Miami Marlins':'🐟',
  'Oakland Athletics':'🌳','Los Angeles Angels':'👼',
  'Arizona Diamondbacks':'🐍','Colorado Rockies':'🏔️',
  'Pittsburgh Pirates':'⚓','St. Louis Cardinals':'🦅',
};

function teamEmoji(name) {
  for (const [k, v] of Object.entries(TEAM_EMOJI)) {
    if (name.includes(k) || k.includes(name)) return v;
  }
  return '🏟️';
}

function fmtOdds(n) {
  n = Math.round(n);
  return n > 0 ? '+' + n : String(n);
}

function toET(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
  }) + ' ET';
}

function winProbFromML(homeML) {
  const ml = parseFloat(homeML);
  if (isNaN(ml)) return 50;
  const implied = ml < 0 ? (-ml / (-ml + 100)) * 100 : (100 / (ml + 100)) * 100;
  return Math.round(implied);
}

// ── Fetch odds for one sport ──
async function fetchSportOdds(sportKey) {
  const params = new URLSearchParams({
    apiKey:     ODDS_KEY,
    regions:    'us',
    markets:    'h2h,spreads,totals',
    oddsFormat: 'american',
    dateFormat: 'iso',
  });
  const url = `${ODDS_BASE}/sports/${sportKey}/odds?${params}`;
  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Odds API (${sportKey}): ${err.message || res.status}`);
  }
  const remaining = res.headers.get('x-requests-remaining');
  const used      = res.headers.get('x-requests-used');
  const games     = await res.json();
  return { games, credits: { remaining: parseInt(remaining), used: parseInt(used) } };
}

// ── Fetch player props for one sport ──
async function fetchProps(sportKey, markets) {
  const params = new URLSearchParams({
    apiKey:     ODDS_KEY,
    regions:    'us',
    markets:    markets.join(','),
    oddsFormat: 'american',
    dateFormat: 'iso',
  });
  const url = `${ODDS_BASE}/sports/${sportKey}/odds?${params}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  return res.json();
}

// ── Parse one game into EdgeLock shape ──
function parseGame(game, sport, label, emoji) {
  const bm   = game.bookmakers?.find(b => b.key === 'draftkings') ||
               game.bookmakers?.find(b => b.key === 'fanduel')    ||
               game.bookmakers?.[0];

  const spread  = bm?.markets?.find(m => m.key === 'spreads');
  const h2h     = bm?.markets?.find(m => m.key === 'h2h');
  const totals  = bm?.markets?.find(m => m.key === 'totals');

  const homeSpread = spread?.outcomes?.find(o => o.name === game.home_team);
  const awaySpread = spread?.outcomes?.find(o => o.name === game.away_team);
  const homeML     = h2h?.outcomes?.find(o => o.name === game.home_team);
  const awayML     = h2h?.outcomes?.find(o => o.name === game.away_team);
  const over       = totals?.outcomes?.find(o => o.name === 'Over');

  const spreadStr = homeSpread?.point != null
    ? (homeSpread.point > 0 ? '+' : '') + homeSpread.point : 'N/A';
  const mlStr     = homeML?.price != null ? fmtOdds(homeML.price) : 'N/A';
  const ouStr     = over?.point != null ? String(over.point) : 'N/A';
  const homeMLNum = homeML?.price ?? 0;
  const homePred  = winProbFromML(homeMLNum);

  const now       = new Date();
  const commence  = new Date(game.commence_time);
  const live      = commence < now && now - commence < 4 * 60 * 60 * 1000; // within 4h of start

  return {
    league:   label,
    live,
    time:     live ? 'In Progress' : toET(game.commence_time),
    home: {
      name:   game.home_team,
      emoji:  teamEmoji(game.home_team),
      record: '',
    },
    away: {
      name:   game.away_team,
      emoji:  teamEmoji(game.away_team),
      record: '',
    },
    homePred,
    feat:     false,
    odds:     { spread: spreadStr, ml: mlStr, ou: ouStr },
    // Full odds for Live Odds view
    spreadFull: {
      home:     spreadStr,
      away:     awaySpread?.point != null ? (awaySpread.point > 0 ? '+' : '') + awaySpread.point : 'N/A',
      homeOdds: homeSpread?.price != null ? fmtOdds(homeSpread.price) : '-110',
      awayOdds: awaySpread?.price != null ? fmtOdds(awaySpread.price) : '-110',
    },
    mlFull: {
      home: mlStr,
      away: awayML?.price != null ? fmtOdds(awayML.price) : 'N/A',
    },
    totalsFull: {
      line:      ouStr,
      overOdds:  over?.price != null ? fmtOdds(over.price) : '-110',
      underOdds: totals?.outcomes?.find(o => o.name === 'Under')?.price != null
        ? fmtOdds(totals.outcomes.find(o => o.name === 'Under').price) : '-110',
    },
    books: game.bookmakers?.map(b => b.title).slice(0, 5) || [],
    sport: label,
  };
}

// ── Parse props from odds API into EdgeLock prop card shape ──
function parsePropsFromOdds(games, sport) {
  const props = [];
  const propTypeMap = {
    player_points:                  { label: 'Points',      key: 'pts'   },
    player_rebounds:                { label: 'Rebounds',    key: 'reb'   },
    player_assists:                 { label: 'Assists',     key: 'ast'   },
    player_threes:                  { label: '3-Pointers',  key: '3pm'   },
    player_points_rebounds_assists: { label: 'Pts+Reb+Ast', key: 'pra'   },
    player_points_assists:          { label: 'Pts+Ast',     key: 'pra'   },
    player_points_rebounds:         { label: 'Pts+Reb',     key: 'pra'   },
    player_steals:                  { label: 'Steals',      key: 'stl'   },
    player_blocks:                  { label: 'Blocks',      key: 'blk'   },
    player_pass_yds:                { label: 'Pass Yards',  key: 'pass'  },
    player_rush_yds:                { label: 'Rush Yards',  key: 'rush'  },
    player_shots_on_goal:           { label: 'Shots on Goal', key: 'sog' },
    player_goal_scorer:             { label: 'Goals',       key: 'sog'   },
    batter_total_bases:             { label: 'Total Bases', key: 'rec'   },
    batter_hits:                    { label: 'Hits',        key: 'rec'   },
    batter_rbis:                    { label: 'RBI',         key: 'rec'   },
    pitcher_strikeouts:             { label: 'Strikeouts',  key: 'k'     },
    pitcher_outs:                   { label: 'Pitcher Outs',key: 'k'     },
  };

  let propId = 9000;
  for (const game of games) {
    for (const bm of (game.bookmakers || [])) {
      if (bm.key !== 'draftkings' && bm.key !== 'fanduel') continue;
      for (const mkt of (bm.markets || [])) {
        const typeInfo = propTypeMap[mkt.key];
        if (!typeInfo) continue;
        // Group outcomes by player description
        const byPlayer = {};
        for (const outcome of (mkt.outcomes || [])) {
          const player = outcome.description || outcome.name;
          if (!player) continue;
          if (!byPlayer[player]) byPlayer[player] = { over: null, under: null };
          if (outcome.name === 'Over')  byPlayer[player].over  = outcome;
          if (outcome.name === 'Under') byPlayer[player].under = outcome;
        }
        for (const [player, sides] of Object.entries(byPlayer)) {
          if (!sides.over && !sides.under) continue;
          const line     = sides.over?.point ?? sides.under?.point ?? 0;
          const overOdds = sides.over?.price  != null ? fmtOdds(sides.over.price)  : '-110';
          const underOdds= sides.under?.price != null ? fmtOdds(sides.under.price) : '-110';
          // Simple EV estimate based on juice
          const overJuice  = sides.over?.price  ?? -110;
          const underJuice = sides.under?.price ?? -110;
          const overImplied  = overJuice  < 0 ? (-overJuice  / (-overJuice  + 100)) : 100 / (overJuice  + 100);
          const underImplied = underJuice < 0 ? (-underJuice / (-underJuice + 100)) : 100 / (underJuice + 100);
          const vig     = (overImplied + underImplied) - 1;
          const ev      = parseFloat(((-vig / 2) * 100).toFixed(1));
          const conf    = Math.min(95, Math.max(40, Math.round(75 + ev)));
          const proj    = parseFloat((line * 1.08).toFixed(1)); // estimate projection 8% above line

          props.push({
            id:         propId++,
            sport,
            player,
            team:       game.home_team,
            pos:        'N/A',
            emoji:      teamEmoji(game.home_team),
            game:       `${game.away_team} @ ${game.home_team} · ${toET(game.commence_time)}`,
            statType:   typeInfo.label,
            statKey:    typeInfo.key,
            line,
            proj,
            conf,
            ev,
            overOdds,
            underOdds,
            overEV:     ev,
            underEV:    -ev,
            stats: [
              { lbl: 'Line',     val: String(line),        delta: '',    up: true  },
              { lbl: 'Proj',     val: String(proj),        delta: '+' + (proj - line).toFixed(1), up: proj > line },
              { lbl: 'Edge',     val: ev + '%',            delta: '',    up: ev > 0 },
              { lbl: 'Book',     val: bm.title,            delta: '',    up: true  },
            ],
            trend:       [1,1,0,1,1,0,1],
            trendHits:   5,
            books: [{
              name:  bm.title === 'DraftKings' ? 'DK' : bm.title === 'FanDuel' ? 'FD' : bm.title.slice(0,4),
              line:  String(line),
              odds:  overOdds,
              best:  true,
            }],
            matchupNote: `Live line from ${bm.title}. Auto-generated by EdgeLock scheduler.`,
          });
        }
      }
    }
  }
  return props;
}

// ── Ask Claude to generate today's AI insights ──
async function generateInsights(slate) {
  if (!ANTH_KEY) return getDefaultInsights(slate);

  const today    = new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric', timeZone:'America/New_York' });
  const gameList = slate.allGames.slice(0, 10).map(g =>
    `${g.league}: ${g.away.name} @ ${g.home.name} (${g.time}) — spread ${g.odds.spread}, O/U ${g.odds.ou}`
  ).join('\n');

  const prompt = `Today is ${today}. Here are today's DFS games:\n\n${gameList}\n\nGenerate exactly 3 DFS insights as a JSON array. Each must have: title (short, punchy), sub (1-2 sentence analysis), val (stat or percentage), color ("g"=green, "a"=amber, "r"=red, "p"=pink), icon (single emoji). Focus on stack opportunities, value plays, and fades. Return ONLY valid JSON array, no markdown.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'x-api-key':     ANTH_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-5',
        max_tokens: 800,
        system:     'You are a DFS expert analyst. Return only valid JSON arrays, no markdown, no explanation.',
        messages:   [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
    const data = await res.json();
    const text = data.content?.map(c => c.text || '').join('').trim();
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.warn('Claude insights failed, using defaults:', e.message);
    return getDefaultInsights(slate);
  }
}

function getDefaultInsights(slate) {
  const topGame = slate.allGames[0];
  return [
    {
      icon: '🏆',
      title: `Today: ${topGame?.league || 'Multi-sport'} slate`,
      sub:   `${slate.allGames.length} games across ${slate.activeSports.join(', ')}. Check Live Odds for current lines.`,
      val:   slate.allGames.length + ' games',
      color: 'g',
    },
    {
      icon: '💰',
      title: 'Value scan running',
      sub:   'Live props loaded from The Odds API. Filter by confidence score for best edges today.',
      val:   slate.props.length + ' props',
      color: 'a',
    },
    {
      icon: '⚠️',
      title: 'Check injury reports',
      sub:   'Always verify game-time decisions before locking lineups. Scratches can shift ownership significantly.',
      val:   'Monitor',
      color: 'r',
    },
  ];
}

// ── Determine which sports are playing today ──
function classifyDate() {
  const now   = new Date();
  const month = now.getMonth() + 1; // 1-12
  const day   = now.getDate();

  // Simple seasonal calendar (adjust each year)
  return {
    nba:  month >= 4  && month <= 6,    // Apr–Jun (playoffs)
    nhl:  month >= 4  && month <= 6,    // Apr–Jun (playoffs)
    wnba: month >= 5  && month <= 10,   // May–Oct
    mlb:  month >= 4  && month <= 10,   // Apr–Oct
    nfl:  month >= 9  || month <= 1,    // Sep–Jan
    ncaafb: month >= 8 || month <= 1,   // Aug–Jan
  };
}

// ── Main fetch + build function ──
export async function runScheduler() {
  console.log('\n══════════════════════════════════════');
  console.log(' EdgeLock Scheduler —', new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }), 'ET');
  console.log('══════════════════════════════════════');

  if (!ODDS_KEY) {
    console.error('❌  ODDS_API_KEY not set in .env — skipping fetch');
    return;
  }

  await fs.mkdir(DATA_DIR, { recursive: true });

  const season      = classifyDate();
  const activeSports = Object.entries(ACTIVE_SPORTS)
    .filter(([k]) => season[k] && ACTIVE_SPORTS[k].active)
    .map(([k, v]) => ({ id: k, ...v }));

  console.log('📅  Active sports today:', activeSports.map(s => s.label).join(', '));

  const allGames  = [];
  const propGames = [];
  let   lastCredits = null;

  // ── Fetch odds for each sport ──
  for (const sport of activeSports) {
    try {
      console.log(`\n  Fetching ${sport.label} odds…`);
      const { games, credits } = await fetchSportOdds(sport.key);
      lastCredits = credits;

      const today    = new Date();
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(6, 0, 0, 0);

      // Only keep today's games
      const todaysGames = games.filter(g => {
        const d = new Date(g.commence_time);
        return d >= new Date(today.setHours(0,0,0,0)) && d < tomorrow;
      });

      console.log(`  ✓ ${todaysGames.length} games today (${credits.remaining} credits remaining)`);

      for (const game of todaysGames) {
        allGames.push(parseGame(game, sport.id, sport.label, sport.emoji));
      }
      propGames.push(...todaysGames.map(g => ({ ...g, _sport: sport.label })));
    } catch (e) {
      console.warn(`  ⚠️  ${sport.label} failed:`, e.message);
    }

    // Rate limit protection
    await new Promise(r => setTimeout(r, 300));
  }

  // ── Fetch player props (NBA + NHL + WNBA + MLB) ──
  console.log('\n  Fetching player props…');
  const propMarketsMap = {
    nba:  ['player_points','player_rebounds','player_assists','player_threes',
           'player_points_rebounds_assists','player_points_assists','player_points_rebounds','player_steals','player_blocks'],
    nhl:  ['player_shots_on_goal','player_goal_scorer'],
    wnba: ['player_points','player_rebounds','player_assists',
           'player_points_rebounds_assists','player_points_assists','player_points_rebounds'],
    mlb:  ['batter_total_bases','batter_hits','batter_rbis','pitcher_strikeouts','pitcher_outs'],
    nfl:  ['player_pass_yds','player_rush_yds','player_reception_yds'],
  };

  const rawProps = [];
  for (const sport of activeSports) {
    const markets = propMarketsMap[sport.id];
    if (!markets) continue;
    try {
      const games = await fetchProps(sport.key, markets);
      const parsed = parsePropsFromOdds(games, sport.label);
      rawProps.push(...parsed);
      console.log(`  ✓ ${parsed.length} ${sport.label} props`);
    } catch (e) {
      console.warn(`  ⚠️  ${sport.label} props failed:`, e.message);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // ── Deduplicate props (same player + stat type, keep best EV) ──
  const propMap = {};
  for (const p of rawProps) {
    const key = `${p.player}|${p.statType}`;
    if (!propMap[key] || p.ev > propMap[key].ev) propMap[key] = p;
  }
  const props = Object.values(propMap);

  // Sort by confidence desc
  props.sort((a, b) => b.conf - a.conf);

  // ── Build sport-specific game arrays ──
  const byLeague = {};
  for (const g of allGames) {
    const k = g.league;
    if (!byLeague[k]) byLeague[k] = [];
    byLeague[k].push(g);
  }

  // ── Mark featured games (highest O/U per sport) ──
  for (const games of Object.values(byLeague)) {
    if (!games.length) continue;
    const top = games.reduce((a, b) =>
      parseFloat(a.odds.ou) > parseFloat(b.odds.ou) ? a : b
    );
    top.feat = true;
  }

  // ── Generate AI insights ──
  console.log('\n  Generating AI insights via Claude…');
  const slate = { allGames, activeSports: activeSports.map(s => s.label), props };
  const insights = await generateInsights(slate);
  console.log(`  ✓ ${insights.length} insights generated`);

  // ── Build ticker items ──
  const tickerItems = [];
  for (const g of allGames.slice(0, 12)) {
    if (g.odds.ml !== 'N/A') {
      tickerItems.push({ team: g.away.name.split(' ').slice(-1)[0] + ' @ ' + g.home.name.split(' ').slice(-1)[0], odd: g.odds.ml, neg: g.odds.ml.startsWith('-') });
    }
    if (g.odds.ou !== 'N/A') {
      tickerItems.push({ team: 'O/U ' + g.away.name.split(' ').slice(-1)[0], odd: g.odds.ou, neg: false });
    }
  }

  // ── Build active slates label ──
  const activeLabels = activeSports.map(s => s.label).join(' · ');

  // ── Assemble final slate object ──
  const output = {
    generated:    new Date().toISOString(),
    date:         new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric', timeZone:'America/New_York' }),
    activeSports: activeSports.map(s => s.label),
    activeLabels,
    credits:      lastCredits,
    tickerItems,
    allGames,
    dashGames:    allGames.slice(0, 6),
    nbaGames:     byLeague['NBA']  || [],
    nhlGames:     byLeague['NHL']  || [],
    wnbaGames:    byLeague['WNBA'] || [],
    mlbGames:     byLeague['MLB']  || [],
    nflGames:     byLeague['NFL']  || [],
    props,
    insights,
    summary: {
      totalGames:    allGames.length,
      totalProps:    props.length,
      highConfProps: props.filter(p => p.conf >= 80).length,
      avgEV:         props.length ? (props.reduce((a,b) => a + b.ev, 0) / props.length).toFixed(1) : '0',
    },
  };

  // ── Write to disk ──
  await fs.writeFile(SLATE_FILE, JSON.stringify(output, null, 2));
  console.log(`\n✅  Slate written → data/slate.json`);
  console.log(`   ${allGames.length} games · ${props.length} props · ${insights.length} insights`);
  console.log(`   Credits remaining: ${lastCredits?.remaining ?? 'unknown'}`);
  console.log('══════════════════════════════════════\n');

  return output;
}

// Run directly if called as main
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runScheduler().catch(e => { console.error('Scheduler failed:', e); process.exit(1); });
}
