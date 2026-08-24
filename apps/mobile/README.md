# Cooper2Talk native operator app

The app is an operator companion, not a softphone. Telnyx and Dograh continue
to answer calls; the app provides secure live oversight, interventions, call
reports, and push notifications.

## Local development

1. Copy `.env.example` to `.env` and set the API base URL if it differs.
2. Run `npm install` from the repository root.
3. Run `npm run start --workspace=@cooper2talk/mobile`.
4. Scan the Expo QR code with Expo Go for UI development. Use a signed EAS build
   for real iOS/Android push notifications and microphone testing.

## Private pilot prerequisites

- Apple Developer Program membership and APNs key for TestFlight.
- Google Play Console account and Firebase Cloud Messaging configuration for
  Android internal testing.
- An Expo account plus an EAS project ID. Do not commit its signing material.

The mobile app stores only its own short-lived login credentials in the iOS
Keychain or Android Keystore. It never stores call audio or provider API keys.

## EAS pilot build

After `npx eas-cli@latest login`, run `npx eas-cli@latest init` from this
directory. Put the generated EAS project ID in `EXPO_PUBLIC_EAS_PROJECT_ID`
locally and in the EAS environment, then configure APNs and FCM through EAS.

Create private builds with:

```sh
npx eas-cli@latest build --profile preview --platform all
```

Use the `production` profile only after the privacy policy, custom domain, and
store listing requirements are complete.
