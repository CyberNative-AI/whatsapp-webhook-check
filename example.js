// Recorded example: synthetic IDs and Graph responses from fixtures/cases.json, the "healthy" case with the
// "different registered callback" app subscription (the app webhook still points to the n8n test URL).
// test/ui.test.js checks that these values match the fixtures. Loading it sends nothing and stores nothing.
export const RECORDED_EXAMPLE = {
  "wabaId": "1001",
  "appId": "2002",
  "phoneNumberId": "3003",
  "callbackUrl": "https://n8n.example.com/webhook/abc",
  "responses": {
    "wabaApps": {
      "data": [
        {
          "whatsapp_business_api_data": {
            "id": "2002",
            "name": "Example App"
          }
        }
      ]
    },
    "appSubscriptions": {
      "data": [
        {
          "object": "whatsapp_business_account",
          "callback_url": "https://n8n.example.com/webhook-test/abc",
          "fields": [
            "messages"
          ],
          "active": true
        }
      ]
    },
    "phone": {
      "id": "3003",
      "display_phone_number": "+1 555 0100",
      "verified_name": "Example",
      "status": "CONNECTED",
      "platform_type": "CLOUD_API",
      "code_verification_status": "VERIFIED"
    },
    "wabaPhones": {
      "data": [
        {
          "id": "3003",
          "display_phone_number": "+1 555 0100"
        }
      ]
    }
  }
};
