import { check, GRAPH_ORIGIN } from './engine.js';

const byId = id => document.getElementById(id);
const form = byId('check-form');
const results = byId('results');
const summary = byId('summary');

form.addEventListener('change', event => {
  if (event.target.name !== 'mode') return;
  const token = form.elements.mode.value === 'token';
  byId('token-fields').hidden = !token;
  byId('paste-fields').hidden = token;
});

function readJson(id) {
  const raw = byId(id).value.trim();
  if (!raw) return undefined;
  try { return JSON.parse(raw); }
  catch { return { error: { code: 'invalid JSON', message: `Could not parse ${id}.` } }; }
}

async function graphGet(path, token) {
  const url = new URL(`${GRAPH_ORIGIN}/${path}`);
  if (url.origin !== 'https://graph.facebook.com' || !url.pathname.startsWith('/v25.0/')) throw new Error('Graph URL is outside the pinned version.');
  try {
    const response = await fetch(url.href, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
    const data = await response.json();
    return data;
  } catch (error) {
    return { error: { code: 'network', message: error.message } };
  }
}

function stopAfter(layers, id) {
  const current = layers[id - 1];
  return current.status === 'fail' || current.message.startsWith('Cannot check:');
}

function render(layers) {
  results.replaceChildren();
  const first = layers.find(layer => layer.status === 'fail' || layer.message.startsWith('Cannot check:'));
  summary.textContent = first ? `First layer needing attention: ${first.id}. ${first.name}. ${first.message}` :
    layers.some(layer => layer.id < 5 && layer.status === 'not checked') ? 'No failure found in checked layers; some layers remain unverified.' :
      'No failure found in checked layers. Run the manual challenge check before treating reachability as verified.';
  for (const item of layers) {
    const article = document.createElement('article');
    article.className = item.status.replace(' ', '-');
    const heading = document.createElement('h3');
    heading.textContent = `${item.id}. ${item.name} — ${item.status}`;
    const message = document.createElement('p');
    message.textContent = item.message;
    const evidence = document.createElement('pre');
    evidence.textContent = `Evidence: ${typeof item.evidence === 'string' ? item.evidence : JSON.stringify(item.evidence, null, 2)}`;
    const fix = document.createElement('p');
    fix.textContent = `One fix: ${item.fix}`;
    article.append(heading, message, evidence, fix);
    results.append(article);
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const input = {
    wabaId: byId('waba-id').value.trim(), appId: byId('app-id').value.trim(), phoneNumberId: byId('phone-id').value.trim(),
    callbackUrl: byId('callback-url').value.trim(), verifyToken: byId('verify-token').value.trim(), responses: {},
  };
  summary.textContent = 'Checking…';
  results.replaceChildren();
  try {
    if (form.elements.mode.value === 'paste') {
      input.responses = {
        wabaApps: readJson('waba-json'), appSubscriptions: readJson('subscriptions-json'),
        phone: readJson('phone-json'), wabaPhones: readJson('waba-phones-json'),
      };
    } else {
      // Remove tokens from form controls immediately; these local variables die after the run.
      let userToken = byId('user-token').value.trim();
      let appToken = byId('app-token').value.trim();
      byId('user-token').value = '';
      byId('app-token').value = '';
      const initial = check(input);
      if (stopAfter(initial, 1)) { render(initial); return; }
      if (!userToken) { summary.textContent = 'Enter a user or system access token for Graph reads.'; return; }
      input.responses.wabaApps = await graphGet(`${input.wabaId}/subscribed_apps`, userToken);
      if (stopAfter(check(input), 2)) { render(check(input)); return; }
      if (appToken) {
        input.responses.appSubscriptions = await graphGet(`${input.appId}/subscriptions`, appToken);
        if (stopAfter(check(input), 3)) { render(check(input)); return; }
      }
      input.responses.phone = await graphGet(`${input.phoneNumberId}?fields=display_phone_number,verified_name,status,platform_type,code_verification_status`, userToken);
      if (input.responses.phone?.error) { render(check(input)); return; }
      input.responses.wabaPhones = await graphGet(`${input.wabaId}/phone_numbers`, userToken);
      userToken = '';
      appToken = '';
    }
    render(check(input));
  } catch (error) {
    summary.textContent = `Cannot check: ${error.message}`;
  }
});
