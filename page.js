import { check, cannotCheckLayer, firstBlocking, waitsForPhoneRead, GRAPH_ORIGIN, GRAPH_VERSION } from './engine.js';
import { RECORDED_EXAMPLE } from './example.js';

const ISSUES_URL = 'https://github.com/CyberNative-AI/whatsapp-webhook-check/issues/new';
const PAGE_VERSION = '1.0.0';
const PHONE_FIELDS = 'display_phone_number,verified_name,status,platform_type,code_verification_status,webhook_configuration';

const byId = id => document.getElementById(id);
const form = byId('check-form');
const results = byId('results');
const summary = byId('summary');
const fixBox = byId('fix');
const feedback = byId('feedback');
const repair = byId('repair');
const formError = byId('form-error');
const path = byId('path');
const idlePath = path.firstElementChild.cloneNode(true);
const SHORT_NAMES = ['Callback URL', 'WABA link', 'App webhook', 'Phone number', 'Challenge'];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Mode switch: paste is the default and never touches the network.
form.addEventListener('change', event => {
  if (event.target.name !== 'mode') return;
  const token = form.elements.mode.value === 'token';
  byId('token-fields').hidden = !token;
  byId('paste-fields').hidden = token;
});

const verifyToggle = byId('verify-toggle');
verifyToggle.addEventListener('click', () => {
  const open = verifyToggle.getAttribute('aria-expanded') !== 'true';
  verifyToggle.setAttribute('aria-expanded', String(open));
  byId('verify-block').hidden = !open;
  if (open) byId('verify-token').focus();
});

// Show each Graph read with the user's own IDs, plus a link that opens it in Graph API Explorer.
const reads = {
  waba: ids => `${ids.waba}/subscribed_apps`,
  phone: ids => `${ids.phone}?fields=${PHONE_FIELDS}`,
  phones: ids => `${ids.waba}/phone_numbers`,
  subscriptions: ids => `${ids.app}/subscriptions`,
};
const explorerLinks = [];
for (const code of document.querySelectorAll('code.read')) {
  const link = el('a', 'explorer', 'Open this read in Graph API Explorer ↗');
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  code.closest('label').after(link);
  explorerLinks.push({ code, link, read: reads[code.dataset.read] });
}
function currentIds() {
  const value = (id, placeholder) => /^\d+$/.test(byId(id).value.trim()) ? byId(id).value.trim() : placeholder;
  return { waba: value('waba-id', '{WABA_ID}'), app: value('app-id', '{APP_ID}'), phone: value('phone-id', '{PHONE_NUMBER_ID}') };
}
function updateReads() {
  const ids = currentIds();
  for (const { code, link, read } of explorerLinks) {
    const path = read(ids);
    code.textContent = `GET /${path}`;
    const url = new URL('https://developers.facebook.com/tools/explorer/');
    url.searchParams.set('method', 'GET');
    url.searchParams.set('path', path);
    url.searchParams.set('version', GRAPH_VERSION);
    link.href = url.href;
  }
}
for (const id of ['waba-id', 'app-id', 'phone-id']) byId(id).addEventListener('input', updateReads);
updateReads();

function readJson(id, label) {
  const raw = byId(id).value.trim();
  if (!raw) return undefined;
  try { return JSON.parse(raw); }
  catch { return { error: { code: 'invalid JSON', message: `Could not parse the pasted ${label} JSON. Copy the whole response from Graph API Explorer.` } }; }
}

async function graphGet(path, token) {
  const url = new URL(`${GRAPH_ORIGIN}/${path}`);
  if (url.origin !== 'https://graph.facebook.com' || !url.pathname.startsWith(`/${GRAPH_VERSION}/`)) throw new Error('Graph URL is outside the pinned version.');
  try {
    const response = await fetch(url.href, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
    return await response.json();
  } catch (error) {
    return { error: { code: 'network', message: error.message } };
  }
}

function statusOf(item) {
  if (item.status === 'pass') return ['pass', 'Pass'];
  if (item.status === 'warn') return ['warn', 'Warning'];
  if (item.status === 'fail') return ['fail', 'Broken'];
  if (cannotCheckLayer(item)) return ['cannot', 'Cannot check'];
  // Layer 5 is yours to run only once the page has a command for it; behind a broken layer it is not checked.
  if (item.id === 5) return item.evidence?.command ? ['skipped', 'You run it'] : ['skipped', 'Not checked'];
  return ['skipped', 'Not checked'];
}

function commandBlock(command) {
  const box = el('div', 'cmd');
  const pre = el('pre', '', command);
  const copy = el('button', 'copy', 'Copy');
  copy.type = 'button';
  copy.setAttribute('aria-label', 'Copy command');
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(command); copy.textContent = 'Copied'; }
    catch { copy.textContent = 'Select it'; }
  });
  box.append(pre, copy);
  return box;
}

// Split "… or run: curl …" so the command can be copied on its own.
function fixParts(fix) {
  const match = fix.match(/^(.*?),? or run: (curl .*)$/s);
  return match ? { text: `${match[1]}.`, command: match[2] } : { text: fix, command: null };
}

function verdictFor(layers) {
  const blocking = firstBlocking(layers);
  if (blocking?.status === 'fail') return { blocking, title: `Broken at layer ${blocking.id}: ${blocking.name}`, short: `layer ${blocking.id} broken` };
  if (blocking) return { blocking, title: `Cannot check layer ${blocking.id}: ${blocking.name}`, short: `layer ${blocking.id} cannot check` };
  return { blocking: null, title: 'No broken layer found in what could be checked', short: 'no broken layer found' };
}

function feedbackUrl(found, layers, verdict) {
  const statuses = layers.map(item => `${item.id} ${statusOf(item)[1].toLowerCase()}`).join(' · ');
  const body = [
    `**Did the check find your problem?** ${found ? 'Yes' : 'No'}`,
    `**Result:** ${verdict.title}`,
    `**Layers:** ${statuses}`,
    '',
    '**What fixed it, or what was really wrong (optional):**',
    '',
    '',
    '**n8n Cloud or self-hosted (optional):**',
    '',
    '',
    '_This issue is public. Please do not paste tokens, app secrets, or IDs you want to keep private._',
    `_Page version ${PAGE_VERSION}_`,
  ].join('\n');
  const url = new URL(ISSUES_URL);
  url.searchParams.set('title', `Check result: ${found ? 'found' : 'did not find'} my problem (${verdict.short})`);
  url.searchParams.set('body', body);
  return url.href;
}

// The signal path: one machined segment per layer, marked with the engine's status. Each segment links to its row.
function openLayer(id) {
  const row = byId(`layer-${id}`);
  if (!row) return;
  const details = row.querySelector('details');
  if (details) details.open = true;
  row.focus();
}

function renderPath(layers, verdict) {
  const list = el('ol', 'assembly');
  list.setAttribute('aria-label', 'Layer results');
  for (const item of layers) {
    const [kind, word] = statusOf(item);
    const lamp = word === 'You run it' ? 'manual' : kind;
    const segment = el('li', `seg seg-${item.id} is-${lamp}${item === verdict.blocking ? ' is-first' : ''}`);
    segment.dataset.seg = item.id;
    const link = el('a', 'seg-link');
    link.href = `#layer-${item.id}`;
    const body = el('span', 'seg-body');
    body.append(el('span', 'lamp'));
    const num = el('span', 'seg-num');
    num.append(el('span', 'sr', 'Layer '), document.createTextNode(String(item.id)));
    const name = el('span', 'seg-name', SHORT_NAMES[item.id - 1]);
    const state = el('span', 'seg-state', word);
    state.prepend(el('span', 'sr', ': '));
    link.append(body, num, name, state);
    link.addEventListener('click', event => { event.preventDefault(); openLayer(item.id); });
    segment.append(link);
    list.append(segment);
  }
  path.replaceChildren(list);
}

function render(layers, recorded = false) {
  results.replaceChildren();
  fixBox.replaceChildren();
  const verdict = verdictFor(layers);
  renderPath(layers, verdict);
  summary.closest('.result').dataset.state = verdict.blocking ? (verdict.blocking.status === 'fail' ? 'broken' : 'cannot') : 'clear';
  byId('recorded-tag').hidden = !recorded;
  summary.classList.remove('empty');
  summary.replaceChildren(document.createTextNode(verdict.title));
  const detail = verdict.blocking ? verdict.blocking.message :
    layers.some(item => cannotCheckLayer(item) || item.status === 'warn' || (item.id < 5 && item.status === 'not checked'))
      ? 'Some layers were not fully checked; see their rows. Then run the layer 5 challenge yourself.'
      : 'Layers 1 to 4 pass. Run the layer 5 challenge yourself before treating the webhook as reachable.';
  summary.append(el('span', 'of', detail));

  if (verdict.blocking) {
    const { text, command } = fixParts(verdict.blocking.fix);
    const box = el('div', 'one-fix');
    box.append(el('p', 'label', 'One fix'), el('p', '', text));
    if (command) box.append(commandBlock(command));
    // The tempting wrong repair for layers 2 and 3 sits next to the right one.
    if (verdict.blocking.status === 'fail' && (verdict.blocking.id === 2 || verdict.blocking.id === 3)) {
      const warning = el('p', 'fix-warning');
      warning.append(el('span', 'label-limit', 'Do not'), 'DELETE ', el('code', '', '/{WABA_ID}/subscribed_apps'), ' to clear this. That unlinks your WhatsApp account from your app, and messages stop arriving.');
      box.append(warning);
    }
    fixBox.append(box);
  }

  for (const item of layers) {
    const [kind, word] = statusOf(item);
    const row = el('li', `row${kind === 'skipped' && item.id !== 5 ? ' dim' : ''}${item === verdict.blocking ? ' first' : ''}`);
    row.dataset.layer = item.id;
    row.id = `layer-${item.id}`;
    row.tabIndex = -1;
    const head = el('div', 'row-head');
    head.append(el('span', 'row-name', item.name), el('span', `status ${kind}`, word));
    row.append(el('span', 'num', String(item.id)), head, el('p', 'row-msg', item.message));
    if (item.id === 5 && item.evidence?.command) {
      row.append(commandBlock(item.evidence.command), el('p', 'hint block', `Expect ${item.evidence.expected}. ${item.fix}`));
    } else if (item.evidence !== null && item.evidence !== undefined && kind !== 'skipped') {
      const details = el('details');
      details.open = item === verdict.blocking;
      details.append(el('summary', '', 'Evidence'), el('pre', '', typeof item.evidence === 'string' ? item.evidence : JSON.stringify(item.evidence, null, 2)));
      if (item !== verdict.blocking && item.status !== 'pass') details.append(el('p', 'hint block', `Fix: ${item.fix}`));
      row.append(details);
    }
    results.append(row);
  }

  byId('feedback-yes').href = feedbackUrl(true, layers, verdict);
  byId('feedback-no').href = feedbackUrl(false, layers, verdict);
  feedback.hidden = false;
  repair.hidden = false;
  // A recorded example is not the visitor's setup: no feedback issue or repair offer for it.
  if (recorded) { feedback.hidden = true; repair.hidden = true; }
}

function showError(message, field) {
  formError.textContent = message;
  formError.hidden = false;
  if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
}

function validate(input) {
  for (const input of form.querySelectorAll('[aria-invalid]')) input.removeAttribute('aria-invalid');
  formError.hidden = true;
  for (const [key, id, label] of [['wabaId', 'waba-id', 'WhatsApp Business Account ID'], ['appId', 'app-id', 'App ID'], ['phoneNumberId', 'phone-id', 'Phone number ID']]) {
    if (!/^\d+$/.test(input[key])) { showError(`${label} must contain digits only.`, byId(id)); return false; }
  }
  if (!input.callbackUrl) { showError('Paste the n8n Production URL from the WhatsApp Trigger node.', byId('callback-url')); return false; }
  return true;
}

function showResult() {
  const box = summary.closest('.result');
  if (box.getBoundingClientRect().top > window.innerHeight * 0.6 || box.getBoundingClientRect().top < 0) box.scrollIntoView({ block: 'start' });
}

// Recorded example: fills the form with synthetic fixture data and runs the same paste-mode check.
// It replaces what the visitor typed only after an explicit choice.
let exampleInForm = false;
const exampleConfirm = byId('example-confirm');
const recordedNote = byId('recorded-note');
const entryFields = () => [...form.querySelectorAll('input:not([type="radio"]), textarea')];

function loadExample() {
  exampleConfirm.hidden = true;
  form.elements.mode.value = 'paste';
  byId('token-fields').hidden = true;
  byId('paste-fields').hidden = false;
  for (const field of entryFields()) field.value = '';
  const { wabaId, appId, phoneNumberId, callbackUrl, responses } = RECORDED_EXAMPLE;
  const json = value => JSON.stringify(value, null, 2);
  Object.entries({ 'waba-id': wabaId, 'app-id': appId, 'phone-id': phoneNumberId, 'callback-url': callbackUrl,
    'waba-json': json(responses.wabaApps), 'phone-json': json(responses.phone), 'waba-phones-json': json(responses.wabaPhones),
    'subscriptions-json': json(responses.appSubscriptions) }).forEach(([id, value]) => { byId(id).value = value; });
  updateReads();
  exampleInForm = true;
  recordedNote.hidden = false;
  form.requestSubmit();
}

function askForExample() {
  if (!exampleInForm && entryFields().some(field => field.value.trim())) {
    exampleConfirm.hidden = false;
    byId('example-replace').focus();
    return;
  }
  loadExample();
}

for (const button of document.querySelectorAll('.load-example')) {
  button.hidden = false;
  button.addEventListener('click', askForExample);
}
byId('example-bar').hidden = false;
byId('example-replace').addEventListener('click', loadExample);
byId('example-keep').addEventListener('click', () => { exampleConfirm.hidden = true; byId('waba-id').focus(); });
byId('example-clear').addEventListener('click', () => {
  form.reset();
  byId('token-fields').hidden = true;
  byId('paste-fields').hidden = false;
  exampleInForm = false;
  recordedNote.hidden = true;
  updateReads();
  byId('waba-id').focus();
});
form.addEventListener('input', () => {
  if (!exampleInForm) return;
  exampleInForm = false;
  recordedNote.hidden = true;
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  const recorded = exampleInForm;
  const input = {
    wabaId: byId('waba-id').value.trim(), appId: byId('app-id').value.trim(), phoneNumberId: byId('phone-id').value.trim(),
    callbackUrl: byId('callback-url').value.trim(), verifyToken: byId('verify-token').value.trim(),
    responses: { appSubscriptions: readJson('subscriptions-json', 'app subscriptions') },
  };
  const tokenMode = form.elements.mode.value === 'token';
  // Remove the token from the form control at once; the local variable dies after the run.
  let userToken = tokenMode ? byId('user-token').value.trim() : '';
  if (tokenMode) byId('user-token').value = '';
  if (!validate(input)) return;
  summary.classList.add('empty');
  summary.textContent = 'Checking…';
  results.replaceChildren();
  fixBox.replaceChildren();
  // A new check starts from an unmarked path: no old statuses or links while it runs or if it stops early.
  path.replaceChildren(idlePath.cloneNode(true));
  delete summary.closest('.result').dataset.state;
  byId('recorded-tag').hidden = true;
  feedback.hidden = true;
  repair.hidden = true;
  try {
    if (!tokenMode) {
      Object.assign(input.responses, {
        wabaApps: readJson('waba-json', 'subscribed_apps'),
        phone: readJson('phone-json', 'phone number'),
        wabaPhones: readJson('waba-phones-json', 'WABA phone_numbers'),
      });
    } else {
      if (firstBlocking(check(input))?.id === 1) { render(check(input)); showResult(); return; }
      if (!userToken) { summary.textContent = 'Enter an access token, or switch to Paste JSON.'; return; }
      input.responses.wabaApps = await graphGet(`${input.wabaId}/subscribed_apps`, userToken);
      const blocking = firstBlocking(check(input));
      // A WABA override is judged only after the phone read, because a phone override comes first.
      if (blocking?.id <= 3 && !waitsForPhoneRead(blocking)) { userToken = ''; render(check(input)); showResult(); return; }
      input.responses.phone = await graphGet(`${input.phoneNumberId}?fields=${PHONE_FIELDS}`, userToken);
      if (!input.responses.phone?.error) input.responses.wabaPhones = await graphGet(`${input.wabaId}/phone_numbers`, userToken);
      userToken = '';
    }
    render(check(input), recorded);
    showResult();
    if (recorded) summary.focus({ preventScroll: true });
  } catch (error) {
    userToken = '';
    summary.textContent = `Cannot check: ${error.message}`;
  }
});
