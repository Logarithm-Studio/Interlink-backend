# Physical Android QA - 2026-11-05

## Device and release

- Samsung Galaxy A52 (SM-A525F), Android 14, ARM64, density 420.
- Existing phone font scale is 1.3; retained throughout testing.
- App source baseline: `a65091d`. API live health: `5fbfb2f`, with worker origin
  `https://interlink-backend.vercel.app`.
- A current signed ARM64 release APK built successfully with JDK 17 and
  `:app:assembleRelease -PreactNativeArchitectures=arm64-v8a`.
- Installed package and replacement certificate matched. The existing APK was
  backed up privately, and `adb install -r` updated the app without clearing data.
  The baseline replacement APK SHA-256 was
  `9296d5e188a10a8d65257a609fca5e3b2249644d22415d30303ba61086785ded`.

## Observed on the physical phone

| Check | Result |
| --- | --- |
| USB authorization | Initially unauthorized; authorized by the user after resetting phone-side debugging authorization |
| Release installation | Passed, existing signing certificate retained |
| Session preservation | Passed; signed-in profile remained available after the update |
| Personal Dashboard / Autolink labels | Present; Dashboard label truncates at the existing 130% font scale |
| Switch to Professional mode | Passed |
| Marketing Dashboard | Three primary workflows visible: Lead Generation, Email Marketing, Campaigns |
| Marketing connected-app workspace | Opened; provider authorization and account state are not signed off |
| Dashboard label correction | Source fix added to fit the full label within the available tab width; physical recheck pending |

Public evidence is cropped to exclude personal account details and unrelated
overlays: [Marketing Dashboard](2026-11-05-phone/marketing-dashboard.png) and
[truncated Dashboard tab](2026-11-05-phone/tab-label-before.png). These images are
actual physical-device screenshots; the cropped regions are otherwise unchanged.

The phone repeatedly switched to other foreground apps during the walkthrough,
then disconnected from USB. Further phone actions await an uninterrupted device
connection. No external email, signature request or public post was initiated.

## Independent backend checks

- Read-only readiness confirms all 96 migrations recorded and all four outreach
  tables present with RLS and without direct anon/authenticated CRUD privileges.
- Both Marketing QStash schedules exist and remain paused.
- Valid locally signed malformed probes to both new production worker routes
  return `401 Invalid QStash signature`. These probes cannot run a workflow or
  call an external provider. Production signature configuration is still a blocker.
- DocuSign client credentials remain absent from local configuration. This check
  does not establish the values configured remotely in Vercel.

## Label-correction candidate

The shared tab label now uses native text fitting while retaining its complete
accessibility label and existing font-scale limit. Lint passed with zero errors
and 70 existing warnings; TypeScript and `git diff --check` passed. A replacement
signed ARM64 release built successfully. The source correction is pushed as app
commit `6eb93651b87d49580ef3a063002bd7a0c47ff4cc`. Its APK SHA-256 is
`14f4f89d4100b4e777679d14163cc26932784baea774a490d08b7b9c95082cbc`.
The candidate is preserved as `interlink-arm64-label-fix.apk` in the private
device artifact directory. It has not yet been installed or visually accepted
because the phone disconnected.

## Acceptance still required

Install and inspect the label-correction build, then exercise native lead research
and reviewed import, Notion/Todoist exports and read-back, Gmail drafting and
reviewed test delivery/replies, follow-up cancellation, and the DocuSign sandbox
lifecycle. Campaign publishing needs an explicitly reviewed test destination.
Record connected provider IDs and verify effects independently. Background jobs
require passing signed transport before the schedules can be resumed.

Private screenshots, UI trees, APK backups and logs are in the workspace's
`.scratch/physical-device-qa-2026-11-05/`; they are not committed because they may
contain personal account information and unrelated phone overlays. The stay-awake
setting was temporarily changed from 0 to USB charging for QA; restore it to 0
when the device reconnects and testing finishes.
