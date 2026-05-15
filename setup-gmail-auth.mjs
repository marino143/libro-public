// libro Gmail OAuth setup wizard
//
// Pokreće OAuth flow s Google-om:
//   1. Učita Client ID/Secret (iz .env ili pita kroz prompt)
//   2. Otvori authorize URL u browseru
//   3. Pokrene local HTTP listener da uhvati callback
//   4. Razmijeni code za refresh token
//   5. Spremi u .env
//
// Pokreni: node setup-gmail-auth.mjs

import http from 'http';
import { exec } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(ROOT, '.env');
const CALLBACK_PORT = 8766;
const CALLBACK_URL = `http://localhost:${CALLBACK_PORT}/callback`;
// gmail.modify = read + send + manage labels (potrebno za forward + auto-archive HPB izvoda)
// gmail.send je subset, ali modify pokriva i archive (label INBOX remove)
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
];

// Drugi Gmail account? --secondary
const IS_SECONDARY = process.argv.includes('--secondary') || process.argv.includes('--account=secondary');
const ENV_PREFIX = IS_SECONDARY ? 'GMAIL2_' : 'GMAIL_';

// Optional --hint=email forsira specifičan Google account u OAuth login screenu
// (sprječava da Google auto-akceptira s krivim account-om koji je trenutno aktivan u browseru)
const HINT_ARG = process.argv.find(a => a.startsWith('--hint='));
const LOGIN_HINT = HINT_ARG ? HINT_ARG.split('=')[1] : '';

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

function openUrl(url) {
  exec(`open "${url.replace(/"/g, '\\"')}"`);
}

function loadEnv() {
  if (!existsSync(ENV_PATH)) return {};
  const env = {};
  readFileSync(ENV_PATH, 'utf8').split('\n').forEach((line) => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const eq = line.indexOf('=');
    if (eq < 0) return;
    env[line.substring(0, eq).trim()] = line.substring(eq + 1).trim().replace(/^['"]|['"]$/g, '');
  });
  return env;
}

function saveEnvVars(updates) {
  let content = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  for (const [key, value] of Object.entries(updates)) {
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(content)) {
      content = content.replace(re, `${key}=${value}`);
    } else {
      if (content && !content.endsWith('\n')) content += '\n';
      content += `${key}=${value}\n`;
    }
  }
  writeFileSync(ENV_PATH, content);
}

async function main() {
  console.log('');
  console.log('==================================================');
  console.log('  libro Gmail OAuth Setup' + (IS_SECONDARY ? ' (DRUGI account)' : ''));
  console.log('==================================================');
  console.log('');
  if (IS_SECONDARY) {
    console.log('Setupiramo DRUGI Gmail account (npr. radni email pored osobnog).');
    console.log('Spremit ce se u .env kao GMAIL2_CLIENT_ID/SECRET/REFRESH_TOKEN.\n');
  }

  const env = loadEnv();
  let clientId = env[ENV_PREFIX + 'CLIENT_ID'];
  let clientSecret = env[ENV_PREFIX + 'CLIENT_SECRET'];

  // Za secondary, mozemo reuse-at primary OAuth client (samo refresh_token mora biti drugi)
  if (IS_SECONDARY && (!clientId || !clientSecret) && env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET) {
    console.log('→ Reuse primary OAuth client (GMAIL_CLIENT_ID/SECRET) za drugi account.\n');
    clientId = env.GMAIL_CLIENT_ID;
    clientSecret = env.GMAIL_CLIENT_SECRET;
  }

  if (!clientId || !clientSecret) {
    console.log('Treba OAuth client iz Google Cloud Console.\n');
    console.log('Koraci (jednokratno, ~5 min):');
    console.log('');
    console.log('1. Otvori: https://console.cloud.google.com/projectcreate');
    console.log('   - Project name: "libro-gmail" (ili koristi postojeci)');
    console.log('');
    console.log('2. Otvori: https://console.cloud.google.com/apis/library/gmail.googleapis.com');
    console.log('   - Klik ENABLE');
    console.log('');
    console.log('3. Otvori: https://console.cloud.google.com/apis/credentials/consent');
    console.log('   - User Type: External -> Create');
    console.log('   - App name: libro');
    console.log('   - User support email: tvoj email');
    console.log('   - Developer contact: tvoj email');
    console.log('   - Save and Continue');
    console.log('   - Scopes -> Add or remove scopes -> manually paste:');
    console.log('       https://www.googleapis.com/auth/gmail.readonly');
    console.log('     -> Update -> Save and Continue');
    console.log('   - Test users -> Add Users -> tvoj email -> Save and Continue');
    console.log('   - Back to Dashboard');
    console.log('');
    console.log('4. Otvori: https://console.cloud.google.com/apis/credentials');
    console.log('   - + Create Credentials -> OAuth client ID');
    console.log('   - Application type: Desktop app');
    console.log('   - Name: libro-cli');
    console.log('   - Create -> kopira ti se Client ID i Client Secret');
    console.log('');

    const goOpen = await prompt('Otvoriti console.cloud.google.com? [Y/n] ');
    if (goOpen.toLowerCase() !== 'n') {
      openUrl('https://console.cloud.google.com/apis/credentials');
    }

    console.log('');
    console.log('Kad imas client_id i client_secret, paste ovdje:');
    console.log('');
    clientId = await prompt('Client ID:     ');
    clientSecret = await prompt('Client Secret: ');

    if (!clientId || !clientSecret) {
      console.error('\n✗ Treba i Client ID i Client Secret');
      process.exit(1);
    }
  } else {
    console.log('→ Client ID/Secret vec u .env, koristim njih.');
    console.log(`  Ako zelis nove: obrisi GMAIL_CLIENT_ID i GMAIL_CLIENT_SECRET iz .env\n`);
  }

  console.log('\n→ Pokrecem OAuth flow...');

  const codePromise = new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url.startsWith('/callback')) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const url = new URL(req.url, CALLBACK_URL);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body style="font-family:sans-serif;padding:40px;"><h1>✗ Authorization error</h1><p>${error}</p></body></html>`);
        server.close();
        reject(new Error(error));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html><body style="font-family:sans-serif;padding:40px;text-align:center;">
<h1 style="color:#3e6a42;">✓ Authorized!</h1>
<p>Mozes zatvoriti ovaj tab i vratiti se u terminal.</p>
</body></html>`);
      server.close();
      resolve(code);
    });
    server.on('error', reject);
    server.listen(CALLBACK_PORT, () => {
      console.log(`→ Local callback server: ${CALLBACK_URL}`);
    });
  });

  const authParams = {
    client_id: clientId,
    redirect_uri: CALLBACK_URL,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent select_account',  // select_account = forsira account chooser
  };
  if (LOGIN_HINT) authParams.login_hint = LOGIN_HINT;
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` + new URLSearchParams(authParams).toString();

  console.log('→ Otvaram authorize URL u browseru...');
  console.log(`  Ako se ne otvori sam: ${authUrl}\n`);
  openUrl(authUrl);

  console.log('→ Cekam authorization (klik "Allow" u browseru)...');
  const code = await codePromise;
  console.log('✓ Authorization code primljen');

  console.log('→ Razmjenjujem za refresh token...');
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: CALLBACK_URL,
      grant_type: 'authorization_code',
    }).toString(),
  });

  const tokens = await tokenRes.json();
  if (!tokens.refresh_token) {
    console.error('\n✗ Greska — nema refresh_token u response:');
    console.error(JSON.stringify(tokens, null, 2));
    console.error('\nTip: ako si vec autorizirao prije, idi na https://myaccount.google.com/permissions,');
    console.error('     ukloni "libro" pristup, pa pokreni opet.');
    process.exit(1);
  }

  console.log('→ Test poziv...');
  const profileRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const profile = await profileRes.json();

  if (!profile.emailAddress) {
    console.error('\n✗ Profile call failed:');
    console.error(JSON.stringify(profile, null, 2));
    process.exit(1);
  }

  console.log(`✓ Connected to Gmail as ${profile.emailAddress}`);
  console.log(`  Total messages: ${profile.messagesTotal}`);

  saveEnvVars({
    [ENV_PREFIX + 'CLIENT_ID']: clientId,
    [ENV_PREFIX + 'CLIENT_SECRET']: clientSecret,
    [ENV_PREFIX + 'REFRESH_TOKEN']: tokens.refresh_token,
  });

  console.log('✓ .env updated');
  console.log('');
  console.log('==================================================');
  console.log('  Done! Restart libro-server:');
  console.log('    lsof -ti:8765 | xargs kill && node libro-server.mjs &');
  console.log('  Onda klik "🔄 Sync iz Gmaila" u dashboardu.');
  console.log('==================================================');
  process.exit(0);
}

main().catch((err) => {
  console.error('\n✗ Setup failed:', err.message);
  process.exit(1);
});
