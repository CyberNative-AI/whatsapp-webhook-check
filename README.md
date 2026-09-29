Tested on recorded response shapes, not a live WhatsApp account.

# WhatsApp Trigger not receiving messages in n8n? Find the first broken layer

A free check that runs in your browser. It is for an n8n **WhatsApp Trigger not receiving messages** while Meta shows the event, and for this n8n error:

> The WhatsApp App ID … already has a webhook subscription. Delete it or use another App before executing the trigger.

Paste the JSON that Meta's Graph API Explorer returns. The page reads five layers in order and names the first broken one, with one fix. It stores nothing, has no analytics or backend, and never writes to Meta.

## What it checks

1. **Callback URL.** Your n8n Production URL must be public HTTPS: not HTTP, localhost, a private IPv4 or IPv6 address, or a host without a public domain. It must not be the `/webhook-test/` URL. A path other than `/webhook/` gets a warning, because that is expected only when `N8N_ENDPOINT_WEBHOOK` is set.
2. **WABA → app link.** `GET /{WABA_ID}/subscribed_apps` must list your app. If it does not, the page shows the `POST /{WABA_ID}/subscribed_apps` for you to run. The page never sends it.
3. **App webhook, optional.** `GET /{APP_ID}/subscriptions` must hold a `whatsapp_business_account` subscription with the `messages` field and your Production URL. If this read errors or is missing, the layer is marked "cannot check" and layer 4 still runs.
4. **Phone number.** The phone number ID must be in `GET /{WABA_ID}/phone_numbers` and on the Cloud API.
5. **Challenge.** The page prints a `hub.challenge` curl for you to run. It never contacts your n8n.

## “already has a webhook subscription”

n8n raises this error when your Meta app's `whatsapp_business_account` webhook points to a different URL than the workflow you are activating. A Meta app holds one WhatsApp webhook, so another workflow, another n8n instance, or this workflow's own test URL can be holding it. "Delete it" refers to that app webhook: deactivate the workflow that owns it, or remove the subscription in App Dashboard › Webhooks. Layer 3 shows which URL your app holds.

**Do not DELETE `/{WABA_ID}/subscribed_apps` to clear this error.** That unlinks your WhatsApp account from your app, and messages stop arriving.

After this error, n8n may remove the app webhook itself. An empty `/{APP_ID}/subscriptions` read taken afterwards does not prove there was no conflict.

## Paste mode or token mode

- **Paste mode** is the default. You run each read in Graph API Explorer and paste the response. The page handles no token and makes no network requests.
- **Token mode** is optional. Your token goes only to `https://graph.facebook.com/v25.0/`, in the Authorization header of three GET reads. It is not stored, not put in any URL, and the field is cleared when the check runs.
- The layer 3 read needs an app token. Run it in Graph API Explorer and paste the JSON. The page never asks for an app secret or an app token.

## Run locally

```sh
npm install
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Verify

```sh
node --test
node --test negative-control.mjs
```

`node --test` runs the fixture cases, the engine edge cases and the browser tests. The browser tests use headless Chrome with stubbed Graph responses. They check that:

- token mode sends only GETs to the pinned Graph host, with the token only in the Authorization header;
- paste mode sends no requests after the page loads;
- neither mode writes to localStorage, sessionStorage or cookies;
- the feedback links carry no IDs, URLs or tokens.

The second command must fail with `empty subscribed_apps must fail at layer 2`. It disables layer 2 in an in-memory copy of the engine to show that the normal suite would catch a missing check.

## Limits

This page has not been run against a live WhatsApp account. Each fixture in `fixtures/cases.json` cites its source: Meta's published response shapes, or a public n8n community thread. Example IDs and hostnames are synthetic.

It cannot see:

- whether your Meta app is in Development or Live mode;
- the test-recipient allowlist;
- whether the App Secret in your n8n WhatsApp credential matches your Meta app (n8n drops events whose signature does not match, without an error);
- whether a proxy or tunnel accepts the GET challenge but blocks webhook POSTs;
- Instagram settings.

A clean result does not prove that webhook POSTs reach n8n.

## Did it find your problem?

After a check, the page offers **Yes / No**. Each opens a pre-filled public GitHub issue that contains only the layer result, and you decide whether to submit it.

Not affiliated with Meta, WhatsApp or n8n. Made by CyberNative AI LLC.
