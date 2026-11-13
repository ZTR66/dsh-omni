# Changelog

## 0.1.11

Two bugs that made working tools look broken, and a third that was a real
inconsistency between two tools that claim the same capability.

**Every media tool rejected the obvious argument name.** The schema names the
primary argument `input` and the description reads "Path to a video file" — the
description names the value, not the key. A model reading it writes `file_path`,
`path` or `file`, and gets back `input is required`, which reads as broken
tooling.

One recorded session did exactly that. It called `video_scan` with `file_path`
twice, `audio_analyze` and `audio_transcribe` with `path`, then concluded "the
media tools have a parameter defect in this environment" and spent the rest of
its budget reimplementing frame extraction with ffmpeg and librosa by hand.
Along the way it hit a numpy error the shipped `analyze.py` already handles —
which is the argument for using the tool.

`lib/args.js` now accepts `input`, `file_path`, `filepath`, `path`, `file`,
`source`, `video` and `audio`, with `input` winning when present. Descriptions
say `Pass it as input` as well, so the correct name is legible.

**`audio_analyze` could not read a video.** Its description says "or a video
with an audio track", but the path went straight to librosa, which answers
`Format not recognised`. `audio_transcribe` had decoded with `-vn` first; this
path had not. It now decodes video input to 16 kHz mono WAV before analysis and
removes the intermediate in a `finally`.

Verified end to end: `video_scan` with `file_path` returns a 20-cell grid, and
`audio_analyze` with `path` pointed at an .mp4 returns BPM 129.2, C minor and a
full loudness/timbre report — agreeing with the numbers the session had computed
by hand.

## 0.1.10

Fixes a crash that hit every video whose duration was not a whole number of
seconds — which is almost all of them.

**`timeoutMs` was fractional.** The grid renderer sized its timeout from the
clip length:

```js
Math.max(120000, span * 2000)
```

`span` is seconds and rarely an integer, so a 104.533 s film produced
`209066.666`. Node's `execFile` requires an unsigned integer for `timeout` and
throws immediately when given a float. `Math.ceil` is the whole fix.

The same expression appeared in `compose.js` (`totalSeconds * 4000`), where it
had not been triggered yet.

**The error was invisible.** `ffmpeg()` collected `stderr` and `stdout` into its
log, but a rejected argument arrives as a bare `Error` with neither field
populated — the message lives on `error.message`, which was dropped. So the
report read `ffmpeg failed to build the grid` with an empty detail, naming
neither the cause nor the call. The message is now folded into the log, which
means this whole class of failure becomes readable instead of silent.

**How it surfaced.** A 104.5 s promo failed to produce a contact sheet; the same
ffmpeg invocation run by hand succeeded, because a shell passes the filter string
through and never assembles the timeout the plugin does. The difference was one
argument the plugin builds and a test harness does not.

## 0.1.9

Documents the image host. The README explained that a provider fetches the
reference image itself and therefore needs a public URL, but never said how a
local file becomes one — so the obvious next step, passing a path, fails with a
message that names neither the cause nor the fix.

Adds the settings fields, the two traps (a trial domain serves plain HTTP only;
the secret key field is write-only), and the 30-day limit on trial domains.

## 0.1.8

Drops the cross-plugin reference from the environment check. Its output told the
model to call the design library's `video_guide`. This package does not know
whether that plugin is installed — the two are independent, and a user may have
one, the other, or both. Naming another plugin's tool made this output wrong on
most installs.

It now says only what it can honestly say: this is a capability report, it
describes the machine rather than the film, and it is worth reading once the plan
exists.

## 0.1.7

States the redirect in the output, not only in the tool description. The
description is read before the call; the output is read after, attentively.

## 0.1.6

`omni_env_check` no longer opens with "Run it before promising anything that
touches a video". It answers "what can this machine do", not "what should this
video be", and opening the work with it lets the machine decide the content.

## 0.1.3

Image-to-video, with a working image host.

Agnes fetches reference images from its own network when a task runs, so a local
path or a `file://` URI can never work. This adds the missing half: an upload
path to a domestic object store, then image-to-video itself.

Three bugs found while making it work, each of which produced a message that
named neither the field nor the cause:

**The plugin config was a snapshot.** `settings` was built once from the object
the loader passes to `apply`. Anything saved later through the settings page
landed in the loader entry, so a freshly configured image host was invisible to
every tool call — the page said saved, the tool said unconfigured. It now reads
the current entry per call. This is why the image host appeared not to save.

**Qiniu's upload token needs padded base64.** The HMAC itself was right, but the
token concatenates a url-safe base64 of the signature, and stripping the trailing
`=` — the usual convention everywhere else — makes the server answer a bare
`401 bad token`.

**`toUpperCase()` broke the size regex.** Agnes takes a tier, not pixels, so
1920x1080 is mapped to 1080P; the mapping upper-cased its input first, which
turned the separator into `X`, which the pattern did not accept. Every request
silently fell back to 720P.

Also:

- A Qiniu trial domain serves plain HTTP only — its certificate is issued for the
  CDN's hostnames, so an https request fails TLS before reaching the file. The
  upload now probes once and returns the scheme that actually loads.
- 503 and 500 are treated as retryable alongside 429. A queue-full answer
  reported as a plain failure sends the caller off to rewrite a prompt that was
  fine.
- Media URLs are checked before a request is spent: a local path, localhost or a
  private address is named as such rather than failing later inside the provider.

Verified end to end: a local PNG uploads to Qiniu, Agnes accepts the returned
http URL, and a 5 s clip comes back at 1280x720.

## 0.1.2

Corrects provider resolution. An adapter with `match: () => true` sat second in
the array and shadowed six named adapters, so every request went to the fallback
regardless of the configured provider. The catch-all now sorts last.

Also sniffs the media type from magic bytes: Zhipu returns base64 with no media
type, and PNG bytes were being saved with a `.png` name only by coincidence —
JPEG came back as `.png` too.

## 0.1.1

Crops generated images to the requested aspect ratio. Mona ignores the ratio it
is given and returns 1408×768 for a 1024×1024 request; the `aspectRatio` field is
rejected with a 400. Post-crop instead.

## 0.1.0

First release. Twelve tools: `omni_env_check`, `omni_probe`, `video_scan`,
`video_frames`, `audio_analyze`, `audio_transcribe`, `audio_speak`, `audio_cut`,
`video_compose`, `video_extract_audio`, `image_generate`, `video_generate`.

The premise: a model cannot see video or hear audio, so both are converted into
something it can read. Video becomes a grid of timestamped cells it can zoom
into; audio becomes a transcript with second-level timestamps plus measured
numbers. The model decides where to look and how closely, rather than a fixed
sampling rate deciding for it.
