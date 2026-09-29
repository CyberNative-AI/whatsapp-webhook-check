Tested on recorded response shapes, not a live WhatsApp account.

# WhatsApp → n8n webhook check

A local prototype for diagnosing why a WhatsApp Cloud API webhook does not reach an n8n production workflow. Open the page with a local static server; it has no application backend, analytics, or storage. It does not change Meta state. Do not use it to authorize a DELETE of `subscribed_apps`.

## Run locally

```sh
npm install
python3 -m http.server 8080
```

Open `http://localhost:8080`. In paste mode, copy the four read-only Graph JSON responses into the page. The app subscription read is optional and requires an app token when obtained directly. In token mode, the page sends read-only GETs to `https://graph.facebook.com/v25.0/` using Authorization headers. It clears the token inputs after submission and stores nothing.

The diagnostic reads these layers in order:

1. n8n production callback URL.
2. `GET /{WABA_ID}/subscribed_apps` for the user's app ID. Meta's response nests that ID in `whatsapp_business_api_data.id`.
3. Optional `GET /{APP_ID}/subscriptions` for the WhatsApp object, `messages` field, and exact callback URL. This requires an app token or pasted JSON.
4. `GET /{PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,status,platform_type,code_verification_status`, plus `GET /{WABA_ID}/phone_numbers` to prove the phone belongs to the WABA.
5. A generated `hub.challenge` GET command for the user to run. The page never runs it.

Only the first failing or unreadable layer is reported as the active problem. Missing optional app subscription data is marked not checked while the phone check continues. A Graph error is a cannot-check result, never a pass. A passing automated check does not establish that webhook POSTs reach n8n.

## Verify

```sh
node --test
node --test negative-control.mjs
```

The second command must fail its assertion `empty subscribed_apps must fail at layer 2`. It mutates a disposable in-memory copy of the engine to skip layer 2, then proves that the empty-WABA fixture is detected by the normal test.

The privacy tests use headless Chrome and stubbed Graph responses. They assert that token mode sends GETs only to the pinned Graph host with tokens only in Authorization headers, paste mode sends no requests after loading the static page, and neither mode writes to localStorage, sessionStorage, or cookies.

## Evidence and limits

The fixture file cites a source for each case. Meta's [published `subscribed_apps` shape](https://www.postman.com/meta/whatsapp-business-platform/documentation/3kru5r6/moved-whatsapp-business-management-api) and [WABA phone list](https://www.postman.com/meta/whatsapp-business-platform/request/86mq7mn/get-phone-numbers) support the read shapes. The failure scenarios are adapted from the cited n8n community threads. Example IDs and callback hostnames are synthetic.

This page cannot see app Development/Live mode, test-recipient allowlists, a proxy that allows challenge GETs but blocks event POSTs, or Instagram settings. It has not been tested against a live WhatsApp account.
