// ════════════════════════════════════════════════════════════
// EdgeLock Server — Express API + cron scheduler
// Serves slate.json to the app and runs daily refresh
// ════════════════════════════════════════════════════════════

import express  from 'express';
import cors     from 'cors';
import cron     from 'node-cron';
import fs       from 'fs/promises';
import path     from 'path';
import { fileURLToPath } from 'url';
import { runScheduler } from './scheduler.js';
import 'dotenv/config';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const SLATE_FILE = path.join(__dirname, 'data', 'slate.json');
const PORT       = process.env.PORT || 3001;
const SCHEDULE   = process.env.CRON_SCHEDULE || '0 7 * * *'; // 7am ET daily

const app = express();
app.use(cors());
app.use(express.json());

// ── Health check ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), schedule: SCHEDULE });
});

// ── Main slate endpoint — the app calls this on load ──
app.get('/api/slate', async (req, res) => {
  try {
    const raw   = await fs.readFile(SLATE_FILE, 'utf8');
    const slate = JSON.parse(raw);

    // Check if slate is stale (older than 26 hours)
    const generated = new Date(slate.generated);
    const ageHours  = (Date.now() - generated) / (1000 * 60 * 60);
    const stale     = ageHours > 26;

    res.json({ ...slate, stale, ageHours: Math.round(ageHours) });
  } catch (e) {
    // No slate yet — trigger a fresh fetch
    console.log('No slate.json found, fetching now…');
    try {
      const slate = await runScheduler();
      res.json({ ...slate, stale: false, ageHours: 0 });
    } catch (err) {
      res.status(503).json({ error: 'Slate not available', message: err.message });
    }
  }
});

// ── Force refresh endpoint ──
app.post('/api/refresh', async (req, res) => {
  console.log('Manual refresh triggered');
  try {
    const slate = await runScheduler();
    res.json({ success: true, generated: slate.generated, games: slate.allGames.length, props: slate.props.length });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Props filtered endpoint ──
app.get('/api/props', async (req, res) => {
  try {
    const raw   = await fs.readFile(SLATE_FILE, 'utf8');
    const slate = JSON.parse(raw);
    let   props = slate.props || [];

    const { sport, conf, sort = 'conf', limit = '50' } = req.query;
    if (sport && sport !== 'ALL') props = props.filter(p => p.sport === sport);
    if (conf  === 'HIGH') props = props.filter(p => p.conf >= 80);
    if (conf  === 'MED')  props = props.filter(p => p.conf >= 60 && p.conf < 80);
    if (conf  === 'LOW')  props = props.filter(p => p.conf < 60);

    if (sort === 'ev')   props.sort((a,b) => b.ev - a.ev);
    if (sort === 'conf') props.sort((a,b) => b.conf - a.conf);
    if (sort === 'proj') props.sort((a,b) => b.proj - a.proj);

    res.json(props.slice(0, parseInt(limit)));
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

// ── Cron schedule ──
console.log(`\n⏰  Cron scheduled: "${SCHEDULE}" (TZ=${process.env.TZ || 'system'})`);
cron.schedule(SCHEDULE, async () => {
  console.log('\n🔄  Cron triggered — running scheduler…');
  try {
    await runScheduler();
  } catch (e) {
    console.error('Cron fetch failed:', e.message);
  }
}, { timezone: 'America/New_York' });

// ── Start server ──
app.listen(PORT, async () => {
  console.log(`\n🚀  EdgeLock server running on http://localhost:${PORT}`);
  console.log(`   GET  /api/slate    — today's full slate`);
  console.log(`   POST /api/refresh  — force immediate refresh`);
  console.log(`   GET  /api/props    — filtered props`);
  console.log(`   GET  /health       — status\n`);

  // On startup: fetch if no slate or slate is older than 12 hours
  try {
    const raw  = await fs.readFile(SLATE_FILE, 'utf8');
    const data = JSON.parse(raw);
    const age  = (Date.now() - new Date(data.generated)) / (1000 * 60 * 60);
    if (age > 12) {
      console.log(`Slate is ${Math.round(age)}h old — refreshing on startup…`);
      runScheduler().catch(console.error);
    } else {
      console.log(`✅  Slate is ${Math.round(age)}h old — fresh enough, skipping startup fetch`);
    }
  } catch {
    console.log('No slate found — fetching on startup…');
    runScheduler().catch(console.error);
  }
});
