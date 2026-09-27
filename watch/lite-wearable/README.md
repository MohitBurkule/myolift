# MyoLift watch app (Huawei lite wearable)

Streams the watch's accelerometer (~50 Hz) and heart rate to the MyoLift phone app over Huawei
Wear Engine P2P. The phone saves them as `watch.jsonl` in the experiment or workout that's
recording. **Experimental and untested on a real watch.**

- Target: lite wearables (Watch GT / Watch D / Watch Fit series run the JS "lite wearable" stack;
  the Watch D2 is assumed to be one of these; not confirmed on the device yet).
- Language: JS + HML/CSS, FA model (`apiType: faMode`), `compatibleSdkVersion 4.0.0(10)`.
- `entry/src/main/js/default/wearengine/wearengine.js` is Huawei's lite-wearable Wear Engine SDK
  (5.0.2.306, Apache-2.0, header kept), copied from the public sample
  [sportwatch-wear-engine-lite-wearable-to-mobile](https://github.com/Explore-In-HMOS-Wearable/sportwatch-wear-engine-lite-wearable-to-mobile).
  It calls the watch's built-in `@system.wearengine`.

## Build on Linux (no DevEco Studio)

Needs Huawei's Command Line Tools in `~/src/huawei-cli/command-line-tools` (already there) and a
JDK 17 (a portable one is in `~/src/jdk`).

```sh
tools/watch_build.sh            # unsigned build: proves it compiles (verified 27 Sep 2026)
tools/watch_build.sh --sign     # signed build, after the certificate steps below
tools/watch_build.sh --sign --copy   # also copies the .hap to the phone over USB
```

## Signing (needs your developer.huawei.com account, one time)

Lite-wearable apps must be signed with a **debug certificate + debug profile** that lists your
watch's device ID (UDID). In [AppGallery Connect](https://developer.huawei.com/consumer/en/service/josp/agc/index.html):

1. **Create a key + CSR** (on this laptop, with the portable JDK's keytool or DevEco's format):
   ```sh
   J=$(ls -d ~/src/jdk/jdk-17*); mkdir -p ~/.config/myolift-watch-sign && cd ~/.config/myolift-watch-sign
   $J/bin/keytool -genkeypair -alias myoliftwatch -keyalg EC -groupname secp256r1 -sigalg SHA256withECDSA \
     -keystore debug.p12 -storetype PKCS12 -validity 3650 -dname "CN=MyoLift watch"
   $J/bin/keytool -certreq -alias myoliftwatch -keystore debug.p12 -file debug.csr -sigalg SHA256withECDSA
   ```
2. AppGallery Connect → **Users and permissions → Certificate management → New certificate**,
   type *Debug certificate*, upload `debug.csr`, download it as `debug.cer`.
3. **My projects → add a project → add an app**: platform *HarmonyOS*, device *Lite wearable*,
   package name **com.mohitburkule.myoliftwatch**.
4. **Get the watch's UDID**: on the phone, open *Huawei Health → your watch → About* (or install
   *DevEco Assistant* on the phone, which shows the connected watch's UDID). Add it under
   **Device management**.
5. **HAP provision profile → Add**, type *Debug*, choose the certificate and the device; download
   as `debug.p7b`.
6. Put `debug.p12`, `debug.cer`, `debug.p7b` in `~/.config/myolift-watch-sign/` with a `sign.env`:
   ```sh
   STORE_PASSWORD=...   # the keystore password from step 1
   KEY_ALIAS=myoliftwatch
   KEY_PASSWORD=...     # same as the store password for PKCS12
   ```
   Keep this folder private; it's not in the repo.

## Install on the watch

Lite wearables are installed from the phone, not with `hdc`:

1. On the phone, install Huawei's **DevEco Assistant** app (it pairs through Huawei Health).
2. `tools/watch_build.sh --sign --copy` puts `myolift-watch.hap` in the phone's Download/MyoLift.
3. In DevEco Assistant, pick the .hap and install it to the watch.
4. Open **MyoLift** on the watch, tap **Start**. In the phone app: Settings → Huawei watch →
   Find devices → pick the watch → Listen for data. Messages received should count up.

## Wear Engine permission on the phone

Huawei's FAQ says phone apps must **apply for the Wear Engine service** (app ID + package name +
SHA-256 signing fingerprint) before its APIs work. The phone app's test screen shows the exact
error if that's the case. MyoLift's values for the application:

- package: `com.mohitburkule.myolift`
- SHA-256 of the release certificate:
  `97CAA89A94A09460E4A4B930B715F8AD7991ED04352C5F88D3FDAD51446E8D3D`

The watch app declares the phone app in `config.json` → `metaData.supportLists`
(`package:fingerprint`) and in `index.js` (`setPeerPkgName` / `setPeerFingerPrint`). The phone app
needs the **watch app's** fingerprint in Settings → Huawei watch (field 4); it comes from the
watch app's signing certificate/profile in AppGallery Connect. The exact format Huawei expects
there is unconfirmed.

## Unknowns for the Watch D2

- Whether the D2 accepts sideloaded lite-wearable apps via DevEco Assistant.
- The real accelerometer rate (`interval: 'game'` asks for ~20 ms).
- Whether heart-rate subscription works while the D2 is in its blood-pressure-watch modes.
- Message size limits: samples are sent in batches of 10; increase `BATCH` if messages are small enough.
