// Pure, dependency-free classification of recorded or fetched Graph responses.
export const GRAPH_VERSION = 'v25.0';
export const GRAPH_ORIGIN = `https://graph.facebook.com/${GRAPH_VERSION}`;

const NAMES = [
  'Callback URL',
  'WABA app link',
  'App webhook subscription',
  'Phone number',
  'Verification reachability',
];

function layer(index, status, message, evidence, fix) {
  return { id: index + 1, name: NAMES[index], status, message, evidence, fix };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function cannotCheck(index, detail, fix) {
  return layer(index, 'not checked', `Cannot check: ${detail}`, detail, fix);
}

function graphProblem(index, response, label) {
  if (response === undefined || response === null) {
    return cannotCheck(index, `${label} response was not supplied.`, `Paste the ${label} JSON or run this read with the required token.`);
  }
  if (typeof response !== 'object' || Array.isArray(response)) {
    return cannotCheck(index, `${label} response is not a JSON object.`, `Paste the complete ${label} JSON response.`);
  }
  if (response.error) {
    const code = Number(response.error.code);
    const explanation = code === 190 ? 'token expired or invalid' : code === 100 ? 'ID or request is invalid' : 'Graph request failed';
    const fix = code === 190
      ? 'Use a valid token with the required read permissions, then retry the read.'
      : code === 100
        ? 'Check the WABA, app, and phone IDs against Meta, then retry the read.'
        : 'Resolve the Graph error and retry this read.';
    return cannotCheck(index, `${label} returned Graph error ${response.error.code ?? 'unknown'} (${explanation}): ${response.error.message ?? 'no message'}.`, fix);
  }
  return null;
}

function callbackCheck(callbackUrl) {
  let url;
  try { url = new URL(callbackUrl); } catch {
    return layer(0, 'fail', 'Enter a complete n8n production webhook URL.', String(callbackUrl ?? ''), 'Copy the Production URL from the active n8n workflow.');
  }
  const host = url.hostname.toLowerCase();
  const octets = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)?.slice(1).map(Number);
  const privateIp = octets && (octets.some(n => n > 255) || octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] >= 224 ||
    (octets[0] === 169 && octets[1] === 254) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168));
  if (url.protocol !== 'https:' || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '[::1]' || privateIp) {
    return layer(0, 'fail', 'Callback URL must be public HTTPS, not HTTP or localhost/private network.', url.href, 'Set n8n WEBHOOK_URL to a public HTTPS base URL, restart n8n, and copy its Production URL.');
  }
  if (url.pathname.includes('/webhook-test/')) {
    return layer(0, 'fail', 'Callback URL uses /webhook-test/ instead of /webhook/.', url.href, 'Publish the n8n workflow and use its Production URL under /webhook/.');
  }
  if (!url.pathname.includes('/webhook/')) {
    return layer(0, 'fail', 'Callback URL does not contain /webhook/.', url.href, 'Copy the Production URL from the n8n webhook or trigger node.');
  }
  if (url.username || url.password || url.search || url.hash) {
    return layer(0, 'fail', 'Callback URL has credentials, a query, or a fragment.', url.href, 'Use the plain n8n Production URL without credentials, query, or fragment.');
  }
  return layer(0, 'pass', 'Public HTTPS production callback URL has the expected path.', url.href, 'No change needed.');
}

function wabaCheck(response, appId, wabaId) {
  const problem = graphProblem(1, response, 'subscribed_apps');
  if (problem) return problem;
  if (!Array.isArray(response.data)) return cannotCheck(1, 'subscribed_apps has no data array.', 'Paste the complete GET subscribed_apps response.');
  const apps = response.data.map(item => item?.whatsapp_business_api_data ?? item).filter(item => item && typeof item === 'object');
  if (apps.some(item => String(item.id) === String(appId))) {
    return layer(1, 'pass', 'The WABA lists this app.', apps.map(({ id, name }) => ({ id, name })), 'No change needed.');
  }
  if (response.paging?.next) return cannotCheck(1, 'The app was not on this page of subscribed_apps; more pages exist.', 'Get all pages of subscribed_apps before concluding the app is absent.');
  const post = `curl -X POST ${shellQuote(`${GRAPH_ORIGIN}/${wabaId}/subscribed_apps`)} -H 'Authorization: Bearer <USER_ACCESS_TOKEN>'`;
  return layer(1, 'fail', `WABA does not list app ${appId} in subscribed_apps.`, apps.map(({ id, name }) => ({ id, name })), `In Graph API Explorer select your app and POST /${wabaId}/subscribed_apps, or run: ${post}`);
}

function subscriptionCheck(response, callbackUrl) {
  if (response === undefined || response === null) {
    return layer(2, 'not checked', 'Optional app subscription was not checked because no app-token response was supplied.', null, 'Use an app token for this read, or paste its JSON from Graph API Explorer.');
  }
  const problem = graphProblem(2, response, 'app subscriptions');
  if (problem) return problem;
  if (!Array.isArray(response.data)) return cannotCheck(2, 'app subscriptions has no data array.', 'Paste the complete GET app subscriptions response.');
  const subs = response.data.filter(item => item?.object === 'whatsapp_business_account');
  if (!subs.length) {
    if (response.paging?.next) return cannotCheck(2, 'No WhatsApp subscription is on this page; more pages exist.', 'Get all subscription pages.');
    return layer(2, 'fail', 'App has no whatsapp_business_account webhook subscription.', response.data, 'Stop test listening, publish the n8n workflow, then recheck app subscriptions.');
  }
  const matching = subs.find(item => item.callback_url === callbackUrl);
  if (!matching) return layer(2, 'fail', 'App callback_url differs from the pasted n8n Production URL.', subs.map(({ callback_url }) => ({ callback_url })), 'Stop test listening and republish the n8n workflow so its one app subscription points to the Production URL.');
  const fields = Array.isArray(matching.fields) ? matching.fields.map(field => typeof field === 'string' ? field : field?.name) :
    typeof matching.fields === 'string' ? matching.fields.split(',').map(field => field.trim()) : null;
  if (!fields) return cannotCheck(2, 'Subscription fields are absent or have an unknown shape.', 'Paste the complete GET app subscriptions response, including fields.');
  if (!fields.includes('messages')) return layer(2, 'fail', 'App subscription is missing the messages field.', fields, 'Subscribe the messages field in Meta Webhooks for whatsapp_business_account, then republish the n8n workflow.');
  if (matching.active === false) return layer(2, 'fail', 'App webhook subscription is inactive.', matching.active, 'Activate the app webhook subscription and republish the n8n workflow.');
  return layer(2, 'pass', 'App subscription has the Production URL and messages field.', { callback_url: matching.callback_url, fields, active: matching.active }, 'No change needed.');
}

function phoneCheck(phone, wabaPhones, phoneNumberId) {
  const detailProblem = graphProblem(3, phone, 'phone number');
  if (detailProblem) return detailProblem;
  if (String(phone.id) !== String(phoneNumberId)) return cannotCheck(3, 'Phone response ID does not match the supplied phone number ID.', 'Paste the response for the supplied phone number ID.');
  const listProblem = graphProblem(3, wabaPhones, 'WABA phone_numbers');
  if (listProblem) return listProblem;
  if (!Array.isArray(wabaPhones.data)) return cannotCheck(3, 'WABA phone_numbers has no data array.', 'Paste the complete GET WABA phone_numbers response.');
  if (!wabaPhones.data.some(item => String(item?.id) === String(phoneNumberId))) {
    if (wabaPhones.paging?.next) return cannotCheck(3, 'Phone ID was not on this WABA phone_numbers page; more pages exist.', 'Get all WABA phone_numbers pages.');
    return layer(3, 'fail', 'Phone number is not in the supplied WABA.', { phoneId: phone.id, wabaPhoneIds: wabaPhones.data.map(item => item?.id) }, 'Use the phone number ID listed under this WABA in Meta WhatsApp Manager.');
  }
  if (!phone.platform_type) return cannotCheck(3, 'Phone response has no platform_type.', 'Request the phone number with platform_type in fields.');
  if (phone.platform_type !== 'CLOUD_API') return layer(3, 'fail', 'Phone number is not on the Cloud API.', phone.platform_type, 'Use a Cloud API phone number in this WABA.');
  return layer(3, 'pass', 'Phone number belongs to this WABA and uses Cloud API.', { id: phone.id, display_phone_number: phone.display_phone_number, verified_name: phone.verified_name, status: phone.status, platform_type: phone.platform_type, code_verification_status: phone.code_verification_status }, 'No change needed.');
}

function challengeCheck(callbackUrl, verifyToken) {
  const value = new URL(callbackUrl);
  value.searchParams.set('hub.mode', 'subscribe');
  value.searchParams.set('hub.verify_token', verifyToken || '<VERIFY_TOKEN>');
  value.searchParams.set('hub.challenge', 'webhook-check-123');
  const command = `curl -i ${shellQuote(value.href)}`;
  return layer(4, 'not checked', 'Run this GET yourself; the page does not contact the callback.', { command, expected: 'HTTP 200 with body exactly webhook-check-123' }, 'If it does not echo the challenge, check the active n8n production webhook and reverse proxy GET route.');
}

export function check(input) {
  const { wabaId, appId, phoneNumberId, callbackUrl, verifyToken = '', responses = {} } = input;
  const ids = [wabaId, appId, phoneNumberId];
  if (ids.some(id => !/^\d+$/.test(String(id ?? '')))) throw new Error('WABA, app, and phone number IDs must contain digits only.');
  const checks = [
    () => callbackCheck(callbackUrl),
    () => wabaCheck(responses.wabaApps, appId, wabaId),
    () => subscriptionCheck(responses.appSubscriptions, callbackUrl),
    () => phoneCheck(responses.phone, responses.wabaPhones, phoneNumberId),
    () => challengeCheck(callbackUrl, verifyToken),
  ];
  const layers = [];
  for (let i = 0; i < checks.length; i++) {
    if (layers.some(previous => previous.status === 'fail' ||
      (previous.status === 'not checked' && previous.message.startsWith('Cannot check:')))) {
      layers.push(layer(i, 'not checked', 'Not checked because an earlier layer needs attention.', null, 'Resolve the earlier layer first.'));
      continue;
    }
    layers.push(checks[i]());
  }
  return layers;
}
