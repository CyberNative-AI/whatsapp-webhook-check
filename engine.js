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
    return cannotCheck(index, `${label} returned Graph error ${response.error.code ?? 'unknown'} (${explanation}): ${String(response.error.message ?? 'no message').replace(/\.+$/, '')}.`, fix);
  }
  return null;
}

function ipv4Private(octets) {
  return octets.some(n => n > 255) || octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] >= 224 ||
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) || (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168);
}

// URL() serialises IPv6 hosts compressed and lower-case inside brackets, e.g. "[fd00::1]".
function ipv6Private(host) {
  if (!host.startsWith('[') || !host.endsWith(']')) return false;
  const [head, tail = ''] = host.slice(1, -1).split('::');
  const part = text => text ? text.split(':') : [];
  const left = part(head);
  const right = part(tail);
  const words = host.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  const n = words.map(word => parseInt(word, 16));
  if (n.length !== 8 || n.some(Number.isNaN)) return true;
  if (n.every(word => word === 0) || (n.slice(0, 7).every(word => word === 0) && n[7] === 1)) return true; // :: and ::1
  if (n.slice(0, 5).every(word => word === 0) && n[5] === 0xffff) return ipv4Private([n[6] >> 8, n[6] & 255, n[7] >> 8, n[7] & 255]); // IPv4-mapped
  return (n[0] & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (n[0] & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (n[0] & 0xffc0) === 0xfec0 || // fec0::/10 old site-local
    (n[0] & 0xff00) === 0xff00 || // ff00::/8 multicast
    (n[0] === 0x2001 && n[1] === 0x0db8); // 2001:db8::/32 documentation
}

function privateHost(host) {
  const octets = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)?.slice(1).map(Number);
  if (octets) return ipv4Private(octets);
  if (host.startsWith('[')) return ipv6Private(host);
  return host === 'localhost' || !host.includes('.') || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host);
}

function callbackCheck(callbackUrl) {
  let url;
  try { url = new URL(callbackUrl); } catch {
    return layer(0, 'fail', 'Enter a complete n8n production webhook URL.', String(callbackUrl ?? ''), 'Copy the Production URL from the active n8n workflow.');
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || privateHost(host)) {
    return layer(0, 'fail', 'Callback URL must be public HTTPS, not HTTP or localhost/private network.', url.href, 'Set n8n WEBHOOK_URL to a public HTTPS base URL, restart n8n, and copy its Production URL.');
  }
  if (url.pathname.includes('/webhook-test/')) {
    return layer(0, 'fail', 'Callback URL uses /webhook-test/ instead of /webhook/.', url.href, 'Publish the n8n workflow and use its Production URL under /webhook/.');
  }
  if (url.username || url.password || url.search || url.hash) {
    return layer(0, 'fail', 'Callback URL has credentials, a query, or a fragment.', url.href, 'Use the plain n8n Production URL without credentials, query, or fragment.');
  }
  if (!url.pathname.includes('/webhook/')) {
    return layer(0, 'warn', 'Callback path is not the n8n default /webhook/. That is expected only if N8N_ENDPOINT_WEBHOOK is set to a custom path.', url.href, 'If you did not set N8N_ENDPOINT_WEBHOOK, copy the Production URL (not the Test URL) from the WhatsApp Trigger node.');
  }
  return layer(0, 'pass', 'Public HTTPS production callback URL has the expected path.', url.href, 'No change needed.');
}

// Meta routes messages to the phone number's override URL, then the WABA's override for this app, then the app callback.
function wabaCheck(response, appId, wabaId, callbackUrl) {
  const problem = graphProblem(1, response, 'subscribed_apps');
  if (problem) return problem;
  if (!Array.isArray(response.data)) return cannotCheck(1, 'subscribed_apps has no data array.', 'Paste the complete GET subscribed_apps response.');
  const entries = response.data.filter(item => item && typeof item === 'object');
  const apps = entries.map(item => item.whatsapp_business_api_data ?? item).filter(item => item && typeof item === 'object');
  const listed = apps.map(({ id, name }) => ({ id, name }));
  const own = entries.find(item => String((item.whatsapp_business_api_data ?? item)?.id) === String(appId));
  const post = `curl -X POST ${shellQuote(`${GRAPH_ORIGIN}/${wabaId}/subscribed_apps`)} -H 'Authorization: Bearer <USER_ACCESS_TOKEN>'`;
  if (own) {
    const override = own.override_callback_uri;
    if (override && override !== callbackUrl) {
      return layer(1, 'fail', `The WABA sends this app's messages to an override URL, ${override}, not to your n8n Production URL.`, { apps: listed, override_callback_uri: override },
        `Removing the override moves messages away from whatever set it, back to your app's webhook (layer 3). If you want them in n8n, POST /${wabaId}/subscribed_apps with no body in Graph API Explorer, or run: ${post}`);
    }
    return layer(1, 'pass', override ? 'The WABA lists this app, and its override URL is your n8n Production URL.' : 'The WABA lists this app, with no override URL.', override ? { apps: listed, override_callback_uri: override } : listed, 'No change needed.');
  }
  if (response.paging?.next) return cannotCheck(1, 'The app was not on this page of subscribed_apps; more pages exist.', 'Get all pages of subscribed_apps before concluding the app is absent.');
  return layer(1, 'fail', `WABA does not list app ${appId} in subscribed_apps.`, listed, `In Graph API Explorer select your app and POST /${wabaId}/subscribed_apps, or run: ${post}`);
}

function subscriptionCheck(response, callbackUrl) {
  if (response === undefined || response === null) {
    return layer(2, 'not checked', 'Optional app subscription was not checked because its JSON was not pasted.', null, 'Run GET /{APP_ID}/subscriptions in Graph API Explorer with an app token and paste the JSON here. Never paste an app secret into this page.');
  }
  const problem = graphProblem(2, response, 'app subscriptions');
  if (problem) return problem;
  if (!Array.isArray(response.data)) return cannotCheck(2, 'app subscriptions has no data array.', 'Paste the complete GET app subscriptions response.');
  const subs = response.data.filter(item => item?.object === 'whatsapp_business_account');
  if (!subs.length) {
    if (response.paging?.next) return cannotCheck(2, 'No WhatsApp subscription is on this page; more pages exist.', 'Get all subscription pages.');
    return layer(2, 'fail', 'App has no whatsapp_business_account webhook subscription.', response.data, 'Publish the n8n workflow; n8n creates this subscription when the trigger activates. If you just saw the conflict error, n8n may have removed the subscription, so read again after publishing.');
  }
  const matching = subs.find(item => item.callback_url === callbackUrl);
  if (!matching) {
    const registered = subs.map(({ callback_url }) => ({ callback_url }));
    const ownTestUrl = subs.some(item => typeof item.callback_url === 'string' && item.callback_url.replace('/webhook-test/', '/webhook/') === callbackUrl);
    if (ownTestUrl) return layer(2, 'fail', 'App callback_url differs from the pasted n8n Production URL: it is this workflow\'s test URL.', registered, 'In the n8n editor stop test listening, then publish the workflow so n8n registers the Production URL.');
    const held = subs.map(item => item.callback_url).filter(Boolean).join(', ') || 'no URL';
    return layer(2, 'fail', `App callback_url differs from the pasted n8n Production URL: your app's webhook points to ${held}. n8n reports this as "already has a webhook subscription".`, registered, 'A Meta app holds one WhatsApp webhook. Deactivate the workflow or n8n instance that owns the URL shown (n8n then removes its subscription), or delete the app\'s whatsapp_business_account subscription in App Dashboard > Webhooks. Then publish this workflow. Do not DELETE /{WABA_ID}/subscribed_apps.');
  }
  const fields = Array.isArray(matching.fields) ? matching.fields.map(field => typeof field === 'string' ? field : field?.name) :
    typeof matching.fields === 'string' ? matching.fields.split(',').map(field => field.trim()) : null;
  if (!fields) return cannotCheck(2, 'Subscription fields are absent or have an unknown shape.', 'Paste the complete GET app subscriptions response, including fields.');
  if (!fields.includes('messages')) return layer(2, 'fail', 'App subscription is missing the messages field.', fields, 'Subscribe the messages field in Meta Webhooks for whatsapp_business_account, then republish the n8n workflow.');
  if (matching.active === false) return layer(2, 'fail', 'App webhook subscription is inactive.', matching.active, 'Activate the app webhook subscription and republish the n8n workflow.');
  return layer(2, 'pass', 'App subscription has the Production URL and messages field.', { callback_url: matching.callback_url, fields, active: matching.active }, 'No change needed.');
}

function phoneCheck(phone, wabaPhones, phoneNumberId, callbackUrl) {
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
  const config = phone.webhook_configuration;
  const override = config && typeof config === 'object' ? config.phone_number : undefined;
  if (override && override !== callbackUrl) {
    const body = '{"webhook_configuration":{"override_callback_uri":""}}';
    const post = `curl -X POST ${shellQuote(`${GRAPH_ORIGIN}/${phoneNumberId}`)} -H 'Authorization: Bearer <USER_ACCESS_TOKEN>' -H 'Content-Type: application/json' -d ${shellQuote(body)}`;
    return layer(3, 'fail', `This phone number sends its messages to an override URL, ${override}, not to your n8n Production URL.`, { id: phone.id, webhook_configuration: config },
      `Removing the override moves messages away from whatever set it, to the WABA override or your app's webhook. If you want them in n8n, POST /${phoneNumberId} with ${body} in Graph API Explorer, or run: ${post}`);
  }
  const overrideNote = !config ? ' The pasted JSON has no webhook_configuration, so the phone override was not read.' :
    override ? ' Its override URL is your n8n Production URL.' : ' It has no override URL.';
  return layer(3, 'pass', `Phone number belongs to this WABA and uses Cloud API.${overrideNote}`, { id: phone.id, display_phone_number: phone.display_phone_number, verified_name: phone.verified_name, status: phone.status, platform_type: phone.platform_type, code_verification_status: phone.code_verification_status, ...(config ? { webhook_configuration: config } : {}) }, 'No change needed.');
}

function challengeCheck(callbackUrl, verifyToken) {
  const value = new URL(callbackUrl);
  value.searchParams.set('hub.mode', 'subscribe');
  value.searchParams.set('hub.verify_token', verifyToken || '<VERIFY_TOKEN>');
  value.searchParams.set('hub.challenge', 'webhook-check-123');
  const command = `curl -i ${shellQuote(value.href)}`;
  const note = verifyToken ? 'Run this GET yourself; the page does not contact the callback.' :
    'Run this GET yourself after replacing <VERIFY_TOKEN>; the page does not contact the callback.';
  return layer(4, 'not checked', note, { command, expected: 'HTTP 200 with body exactly webhook-check-123' }, 'The WhatsApp Trigger answers only when hub.verify_token equals its node ID, so a wrong token also gets no echo. With the right token and no echo, check that the workflow is published and that your reverse proxy passes GET requests to /webhook/.');
}

export function cannotCheckLayer(item) {
  return item.status === 'not checked' && item.message.startsWith('Cannot check:');
}

// Layer 3 is optional: when it cannot be read, the phone check still runs.
function blocks(item) {
  return item.status === 'fail' || (cannotCheckLayer(item) && item.id !== 3);
}

// The first layer that needs attention: a failure, or a read that could not be checked.
export function firstProblem(layers) {
  return layers.find(item => item.status === 'fail' || cannotCheckLayer(item)) ?? null;
}

export function firstBlocking(layers) {
  return layers.find(blocks) ?? null;
}

export function check(input) {
  const { wabaId, appId, phoneNumberId, callbackUrl, verifyToken = '', responses = {} } = input;
  const ids = [wabaId, appId, phoneNumberId];
  if (ids.some(id => !/^\d+$/.test(String(id ?? '')))) throw new Error('WABA, app, and phone number IDs must contain digits only.');
  const checks = [
    () => callbackCheck(callbackUrl),
    () => wabaCheck(responses.wabaApps, appId, wabaId, callbackUrl),
    () => subscriptionCheck(responses.appSubscriptions, callbackUrl),
    () => phoneCheck(responses.phone, responses.wabaPhones, phoneNumberId, callbackUrl),
    () => challengeCheck(callbackUrl, verifyToken),
  ];
  const layers = [];
  for (let i = 0; i < checks.length; i++) {
    if (layers.some(blocks)) {
      layers.push(layer(i, 'not checked', 'Not checked because an earlier layer needs attention.', null, 'Resolve the earlier layer first.'));
      continue;
    }
    layers.push(checks[i]());
  }
  return layers;
}
