/**
 * Prometheus Obfuscator Microservice
 * Wraps the Prometheus Lua CLI (https://github.com/wcrddn/Prometheus) behind a small HTTP API.
 *
 * POST /obfuscate
 *   body: { code: string, preset?: "Minify" | "Weak" | "Medium" | "Strong" }
 *   returns: { result: string }
 */

const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 4000;

// Lock this down to your actual Vercel domain before going live.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: '2mb' }));

const VALID_PRESETS = ['Minify', 'Weak', 'Medium', 'Strong'];
const PROMETHEUS_DIR = path.join(__dirname, 'Prometheus');
const CLI_PATH = path.join(PROMETHEUS_DIR, 'cli.lua');

// Simple per-IP rate limiting (in-memory; fine for a single instance)
const rateMap = new Map();
const RATE_LIMIT = 10;          // requests
const RATE_WINDOW_MS = 60_000;  // per minute

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > RATE_WINDOW_MS) {
    entry.count = 0;
    entry.start = now;
  }
  entry.count += 1;
  rateMap.set(ip, entry);
  return entry.count > RATE_LIMIT;
}

app.post('/obfuscate', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
  }

  const { code, preset } = req.body || {};

  if (typeof code !== 'string' || !code.trim()) {
    return res.status(400).json({ error: 'No code provided.' });
  }
  if (code.length > 200_000) {
    return res.status(400).json({ error: 'Script too large (max ~200KB).' });
  }

  const chosenPreset = VALID_PRESETS.includes(preset) ? preset : 'Medium';

  const id = crypto.randomUUID();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prom-'));
  const inputFile = path.join(tmpDir, `${id}_input.lua`);
  const outputFile = path.join(tmpDir, `${id}_output.lua`);

  const cleanup = () => {
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  };

  try {
    fs.writeFileSync(inputFile, code, 'utf-8');
  } catch (e) {
    cleanup();
    return res.status(500).json({ error: 'Failed to write input file.' });
  }

  // lua ./cli.lua --preset <preset> <input> --out <output>
  const args = [CLI_PATH, '--preset', chosenPreset, inputFile, '--out', outputFile];

  const luaBin = process.env.LUA_BIN || 'lua5.1';
  const child = spawn(luaBin, args, { cwd: PROMETHEUS_DIR, timeout: 20_000 });

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  child.on('error', (err) => {
    cleanup();
    return res.status(500).json({ error: 'Failed to start obfuscation process.', detail: err.message });
  });

  child.on('close', (codeExit) => {
    if (codeExit !== 0) {
      cleanup();
      return res.status(422).json({
        error: 'Obfuscation failed. Check that your script is valid Luau/Lua.',
        detail: stderr.slice(0, 2000)
      });
    }

    fs.readFile(outputFile, 'utf-8', (err, data) => {
      cleanup();
      if (err) {
        return res.status(500).json({ error: 'Obfuscation produced no output.' });
      }
      res.json({ result: data, preset: chosenPreset });
    });
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Prometheus obfuscator service running on port ${PORT}`);
});
