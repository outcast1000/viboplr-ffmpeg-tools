// FFmpeg Tools — bulk-convert local tracks with ffmpeg, show a deep Media
// Info readout (container/stream/tag probe + loudness) on demand from a
// track's context menu, and answer the media_info / analyze_audio assistant
// tools.
//
// Constraints that shaped this plugin (see the design plan for the full
// writeup): only `ffmpeg` is allow-listed for api.system.exec — there is no
// `ffprobe`, so probe/loudness data comes from parsing plain ffmpeg's
// human-readable stderr banner rather than a JSON API. A plugin also cannot
// rewrite a track's original file in place (api.storage.files is jailed to
// the plugin's own storage root, and ffmpeg can't safely read+write the same
// path), so Convert always writes a new sibling file next to the source, and
// loudness is surfaced as read-only info rather than written back as tags.
function activate(api) {
  var VIEW = "ffmpeg-tools-jobs";
  var SETTINGS_VIEW = "ffmpeg-tools-settings";

  var CONVERT_PRESETS = [
    { id: "mp3", label: "MP3 (256k)", ext: "mp3", args: ["-c:a", "libmp3lame", "-b:a", "256k"] },
    { id: "aac", label: "AAC (256k)", ext: "m4a", args: ["-c:a", "aac", "-b:a", "256k"] },
    { id: "flac", label: "FLAC (lossless)", ext: "flac", args: ["-c:a", "flac"] },
    { id: "ogg", label: "OGG Vorbis (q6)", ext: "ogg", args: ["-c:a", "libvorbis", "-q:a", "6"] },
    { id: "opus", label: "Opus (160k)", ext: "opus", args: ["-c:a", "libopus", "-b:a", "160k"] },
    { id: "wav", label: "WAV (PCM16)", ext: "wav", args: ["-c:a", "pcm_s16le"] },
  ];

  var state = {
    dep: null, // last api.system.getDependency("ffmpeg") result
    jobs: [],
    running: false,
    autoDeleteOriginal: false,
    tab: "info", // "info" | "jobs" — the FFmpeg Tools view's two tabs
    info: null, // the last Media Info request: { trackId, title, artistName, status, data?, message? }
  };

  var jobSeq = 1;

  // ---- path helpers -------------------------------------------------------
  // Track.path for local tracks is built host-side as the literal
  // concatenation `"file://" + <absolute path>` (see src-tauri/src/commands/
  // library.rs) — no URL-encoding, no extra slash. Strip exactly that 7-char
  // prefix, same as the app's own frontend does (src/App.tsx).

  function isLocalUri(uri) {
    return !!uri && uri.indexOf("file://") === 0;
  }

  function localPathFromUri(uri) {
    return uri.substring(7);
  }

  function splitExt(path) {
    var slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    var sep = slash >= 0 ? path.charAt(slash) : "/";
    var dir = slash >= 0 ? path.slice(0, slash) : "";
    var base = slash >= 0 ? path.slice(slash + 1) : path;
    var dot = base.lastIndexOf(".");
    var stem = dot > 0 ? base.slice(0, dot) : base;
    return { dir: dir, sep: sep, stem: stem };
  }

  function buildDestPath(srcPath, ext) {
    var p = splitExt(srcPath);
    return p.dir + p.sep + p.stem + "." + ext;
  }

  function fmtHms(secs) {
    var s = Math.round(secs);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var r = s % 60;
    var mm = (m < 10 ? "0" : "") + m;
    var rr = (r < 10 ? "0" : "") + r;
    return h > 0 ? (h + ":" + mm + ":" + rr) : (m + ":" + rr);
  }

  function lastStderrLine(stderr) {
    var lines = String(stderr || "").split(/\r?\n/).map(function (l) { return l.trim(); }).filter(function (l) { return !!l; });
    return lines.length ? lines[lines.length - 1] : "ffmpeg failed";
  }

  // ---- ffmpeg dependency gate ---------------------------------------------

  function ensureFfmpeg(feature) {
    return api.system.getDependency("ffmpeg").then(function (dep) {
      state.dep = dep;
      if (!dep || !dep.installed) {
        api.ui.requestAction("require-dependency", { name: "ffmpeg", feature: feature });
        return false;
      }
      return true;
    });
  }

  // ---- convert: context menu + job queue ----------------------------------

  function presetById(id) {
    for (var i = 0; i < CONVERT_PRESETS.length; i++) {
      if (CONVERT_PRESETS[i].id === id) return CONVERT_PRESETS[i];
    }
    return null;
  }

  function enqueueConvert(target, preset) {
    ensureFfmpeg("Convert with FFmpeg").then(function (ok) {
      if (!ok) return;
      var ids = target && target.trackId != null ? [target.trackId] : ((target && target.trackIds) || []);
      if (!ids.length) return;
      Promise.all(ids.map(function (id) { return api.library.getTrackById(id); })).then(function (tracks) {
        var queued = 0;
        var skipped = 0;
        for (var i = 0; i < tracks.length; i++) {
          var t = tracks[i];
          var srcPath = t && isLocalUri(t.path) ? localPathFromUri(t.path) : null;
          if (!srcPath) { skipped++; continue; }
          state.jobs.push({
            id: "job-" + jobSeq++,
            trackId: t.id,
            title: t.title,
            artistName: t.artist_name,
            srcPath: srcPath,
            destPath: buildDestPath(srcPath, preset.ext),
            presetId: preset.id,
            presetLabel: preset.label,
            status: "queued",
            message: "",
          });
          queued++;
        }
        if (queued) {
          state.tab = "jobs";
          api.ui.navigateToView(VIEW);
          runQueue();
        }
        if (skipped) {
          api.ui.showNotification(skipped + " track" + (skipped === 1 ? "" : "s") + " skipped (not a local file)");
        }
        render();
      }, function (e) {
        console.error("ffmpeg-tools: failed to resolve tracks for convert:", e);
      });
    });
  }

  function runQueue() {
    if (state.running) return;
    var job = null;
    for (var i = 0; i < state.jobs.length; i++) {
      if (state.jobs[i].status === "queued") { job = state.jobs[i]; break; }
    }
    if (!job) return;

    state.running = true;
    job.status = "running";
    render();

    var preset = presetById(job.presetId);
    var args = ["-i", job.srcPath, "-vn"].concat(preset.args, ["-y", job.destPath]);

    api.system.exec("ffmpeg", args).then(function (res) {
      if (res.exitCode === 0) {
        job.status = "done";
        job.message = "";
        if (state.autoDeleteOriginal) {
          api.ui.requestAction("delete-tracks", { trackIds: [job.trackId] });
        }
      } else {
        job.status = "error";
        job.message = lastStderrLine(res.stderr);
      }
    }, function (e) {
      job.status = "error";
      job.message = String((e && e.message) || e);
    }).then(function () {
      state.running = false;
      render();
      runQueue();
    });
  }

  // ---- probe + loudness parsers (Media Info) -------------------------------

  function hmsToSecs(s) {
    var p = s.split(":");
    if (p.length !== 3) return null;
    return (+p[0]) * 3600 + (+p[1]) * 60 + parseFloat(p[2]);
  }

  function parseStreamRest(rest, stream) {
    stream.codec = (rest.split(",")[0] || "").trim() || null;
    var hz = /(\d+)\s*Hz/.exec(rest);
    stream.sampleRateHz = hz ? parseInt(hz[1], 10) : null;
    var brMatches = rest.match(/(\d+)\s*kb\/s/g);
    stream.bitrateKbps = brMatches ? parseInt(brMatches[brMatches.length - 1], 10) : null;
    var fmt = /\b(u8|s16|s32|s64|flt|dbl)p?\b/.exec(rest);
    stream.sampleFmt = fmt ? fmt[0] : null;
    var ch = /\b(mono|stereo|\d+(\.\d+)?\s*channels?)\b/i.exec(rest);
    stream.channelLayout = ch ? ch[0] : null;
  }

  // ffmpeg (not ffprobe — not allow-listed) dumps container/stream/tag info to
  // stderr as a human-readable banner, not JSON. This is a best-effort line
  // scanner over that banner; unrecognized lines are silently skipped rather
  // than treated as fatal — format/locale drift across ffmpeg builds is an
  // accepted limitation, not a bug to chase down.
  function parseFfmpegProbe(stderr) {
    var out = { format: null, durationSecs: null, overallBitrateKbps: null, tags: {}, streams: [] };
    var lines = String(stderr || "").split(/\r?\n/);
    var mode = "top"; // top | input-meta | stream | stream-meta
    var curStream = null;

    function tryMetaLine(line) {
      if (/^\s*(Duration|Stream #|Input #)/.test(line)) return false;
      var m = /^\s+([^:]+?)\s*:\s?(.*)$/.exec(line);
      if (!m) return false;
      var key = m[1].trim();
      var val = m[2].trim();
      if (mode === "stream-meta" && curStream) curStream.tags[key] = val;
      else out.tags[key] = val;
      return true;
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      var inputM = /^Input #\d+,\s*(.+?),\s*from\s/.exec(line);
      if (inputM) { out.format = inputM[1].trim(); mode = "top"; curStream = null; continue; }

      if (/Metadata:\s*$/.test(line)) {
        mode = (mode === "stream") ? "stream-meta" : "input-meta";
        continue;
      }

      if (mode === "input-meta" || mode === "stream-meta") {
        if (tryMetaLine(line)) continue;
        mode = curStream ? "stream" : "top"; // fall through, re-check this line below
      }

      var durM = /^\s*Duration:\s*([\d:.]+|N\/A)\s*,.*?bitrate:\s*(\d+\s*kb\/s|N\/A)/.exec(line);
      if (durM) {
        out.durationSecs = durM[1] !== "N/A" ? hmsToSecs(durM[1]) : null;
        var brM = /(\d+)\s*kb\/s/.exec(durM[2]);
        out.overallBitrateKbps = brM ? parseInt(brM[1], 10) : null;
        mode = "top";
        continue;
      }

      var streamM = /^\s*Stream #\d+:\d+.*?:\s*Audio:\s*(.+)$/.exec(line);
      if (streamM) {
        curStream = { codec: null, sampleRateHz: null, channelLayout: null, sampleFmt: null, bitrateKbps: null, tags: {} };
        parseStreamRest(streamM[1], curStream);
        out.streams.push(curStream);
        mode = "stream";
        continue;
      }
    }

    return out;
  }

  // Loudness comes from ebur128's end-of-run summary (parsed by the shared
  // parseAnalysisStderr). It replaced a loudnorm pass: same integrated LUFS and
  // true peak to 0.1 dB, ~6× faster (1.2 s vs 7–8 s on a 4-minute song), and
  // it adds loudness range.
  function loudnessFromEbur128(stderr) {
    var l = parseAnalysisStderr(stderr).loudness;
    if (!l || l.integratedLufs == null) return null;
    return {
      integratedLufs: l.integratedLufs,
      truePeakDb: l.peakDb,
      rangeLu: l.rangeLu,
      suggestedGainDb: Math.round((-18.0 - l.integratedLufs) * 100) / 100, // ReplayGain 2.0 reference is -18 LUFS
    };
  }

  // ---- Media Info: on demand only ----------------------------------------
  // Runs when the user picks "Media Info" on a track, or an assistant calls
  // the media_info tool — never on a page load. It used to be a Track Detail
  // information type, which ran a full-file loudness decode every time a
  // detail page opened, and then served a 30-day cache keyed on the track
  // rather than the file.

  // The structured result both surfaces share.
  function probeMediaInfo(path) {
    return Promise.all([
      api.system.exec("ffmpeg", ["-hide_banner", "-i", path]),
      api.system.exec("ffmpeg", ["-hide_banner", "-nostats", "-vn", "-i", path, "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"]),
    ]).then(function (results) {
      var stderr = String(results[0].stderr || "");
      if (/No such file or directory/i.test(stderr)) throw new Error("The file for this track is missing on disk: " + path);
      var probe = parseFfmpegProbe(stderr);
      if (!probe.format) throw new Error("ffmpeg could not read this file: " + lastStderrLine(stderr));
      return {
        format: probe.format,
        durationSecs: probe.durationSecs != null ? Math.round(probe.durationSecs * 100) / 100 : null,
        overallBitrateKbps: probe.overallBitrateKbps,
        streams: probe.streams.map(function (st) {
          return {
            codec: st.codec,
            sampleRateHz: st.sampleRateHz,
            channels: st.channelLayout,
            sampleFormat: st.sampleFmt,
            bitrateKbps: st.bitrateKbps,
            tags: st.tags,
          };
        }),
        tags: probe.tags,
        loudness: loudnessFromEbur128(results[1].stderr),
      };
    });
  }

  function requireFfmpegForTool() {
    return api.system.getDependency("ffmpeg").then(function (dep) {
      state.dep = dep;
      if (!dep || !dep.installed) throw new Error("ffmpeg is not installed — install it from Extensions → Tools");
    });
  }

  var infoGen = 0;

  function showMediaInfo(target) {
    var trackId = target && target.trackId;
    var gen = ++infoGen;
    state.tab = "info";
    state.info = {
      trackId: trackId,
      title: (target && target.title) || "",
      artistName: (target && target.artistName) || "",
      status: "loading",
    };
    api.ui.navigateToView(VIEW);
    render();
    function done(patch) {
      if (gen !== infoGen) return; // a newer request owns the view
      for (var k in patch) state.info[k] = patch[k];
      render();
    }
    if (trackId == null) {
      done({ status: "error", message: "Media Info works on library tracks with a local file." });
      return;
    }
    ensureFfmpeg("Media Info").then(function (ok) {
      if (!ok) { done({ status: "error", message: "Install ffmpeg to see Media Info." }); return; }
      return api.library.getTrackById(trackId).then(function (t) {
        if (!t) throw new Error("This track is no longer in the library.");
        if (!isLocalUri(t.path)) throw new Error("Media Info needs a local file; this track plays from " + (t.path ? String(t.path).split("://")[0] : "no file at all") + ".");
        done({ title: t.title, artistName: t.artist_name || "", path: localPathFromUri(t.path) });
        return probeMediaInfo(localPathFromUri(t.path));
      }).then(function (info) {
        done({ status: "ok", data: info, measuredAt: Date.now() });
      });
    }).then(null, function (e) {
      console.error("ffmpeg-tools: media info failed:", e);
      done({ status: "error", message: String((e && e.message) || e) });
    });
  }

  api.contextMenu.registerItem({ id: "ffmpeg-media-info", label: "Media Info (FFmpeg)", targets: ["track"] });
  api.contextMenu.onAction("ffmpeg-media-info", showMediaInfo);

  api.ui.onAction("refresh-media-info", function () {
    if (state.info) showMediaInfo({ trackId: state.info.trackId, title: state.info.title, artistName: state.info.artistName });
  });

  api.ui.onAction("switch-tab", function (d) {
    var id = d && d.tabId;
    if (id !== "info" && id !== "jobs") return;
    state.tab = id;
    render();
  });

  // ---- context menu (runtime "Convert to…" submenu) -----------------------

  CONVERT_PRESETS.forEach(function (preset, i) {
    var actionId = "ffmpeg-convert-" + preset.id;
    api.contextMenu.registerItem({
      id: actionId,
      label: preset.label,
      targets: ["track", "multi-track"],
      submenuLabel: "Convert to…",
      order: i,
    });
    api.contextMenu.onAction(actionId, function (target) { enqueueConvert(target, preset); });
  });

  api.ui.onAction("delete-original", function (d) {
    var trackId = d && d.trackId;
    if (trackId == null) return;
    api.ui.requestAction("delete-tracks", { trackIds: [trackId] });
  });

  api.ui.onAction("clear-finished", function () {
    state.jobs = state.jobs.filter(function (j) { return j.status === "queued" || j.status === "running"; });
    render();
  });

  // ---- jobs sidebar view ---------------------------------------------------

  function jobStatusLabel(job) {
    if (job.status === "queued") return "Queued";
    if (job.status === "running") return "Converting…";
    if (job.status === "done") return "Done";
    return "Failed";
  }

  function jobSection(job) {
    var children = [{ type: "text", content: jobStatusLabel(job) + " — " + job.presetLabel }];
    if (job.status === "done") {
      children.push({ type: "text", content: "→ " + job.destPath, className: "plugin-hint" });
      children.push({ type: "button", label: "Delete original", action: "delete-original", variant: "secondary", data: { trackId: job.trackId } });
    } else if (job.status === "error") {
      children.push({ type: "text", content: job.message || "Conversion failed", className: "plugin-error" });
    }
    var titleArtist = (job.artistName ? job.artistName + " — " : "") + job.title;
    return { type: "section", title: titleArtist, children: children };
  }

  function grid(pairs) {
    return { type: "stats-grid", items: pairs.filter(function (p) { return p[1] != null && p[1] !== ""; }).map(function (p) { return { label: p[0], value: p[1] }; }) };
  }

  function clip(v) {
    var s = String(v);
    return s.length > 160 ? s.slice(0, 157) + "…" : s;
  }

  function mediaInfoChildren() {
    var info = state.info;
    var children = [];
    children.push({
      type: "toolbar",
      title: "Media Info",
      buttons: info ? [{ label: "Refresh", action: "refresh-media-info", variant: "secondary", disabled: info.status === "loading" }] : [],
      status: info ? ((info.artistName ? info.artistName + " — " : "") + info.title) : "",
      statusVariant: info && info.status === "error" ? "error" : "default",
    });
    children.push({ type: "spacer" });
    if (!info) {
      children.push({ type: "text", content: "Right-click a local track and choose Media Info (FFmpeg) to see its container, streams, tags and measured loudness here.", className: "plugin-hint" });
      return children;
    }
    if (info.status === "loading") {
      children.push({ type: "loading", message: "Reading the file and measuring loudness…" });
      return children;
    }
    if (info.status === "error") {
      children.push({ type: "text", content: info.message || "Media Info failed.", className: "plugin-error" });
      return children;
    }
    var d = info.data;
    children.push({ type: "section", title: "File", children: [grid([
      ["Format", d.format],
      ["Duration", d.durationSecs != null ? fmtHms(d.durationSecs) : null],
      ["Overall bitrate", d.overallBitrateKbps != null ? d.overallBitrateKbps + " kb/s" : null],
    ])] });
    d.streams.forEach(function (st, i) {
      children.push({ type: "section", title: d.streams.length > 1 ? "Audio stream " + (i + 1) : "Audio stream", children: [grid([
        ["Codec", st.codec],
        ["Sample rate", st.sampleRateHz ? st.sampleRateHz + " Hz" : null],
        ["Channels", st.channels],
        ["Sample format", st.sampleFormat],
        ["Bitrate", st.bitrateKbps ? st.bitrateKbps + " kb/s" : null],
      ])] });
    });
    if (d.loudness) {
      var g = d.loudness.suggestedGainDb;
      children.push({ type: "section", title: "Loudness", children: [
        grid([
          ["Integrated", d.loudness.integratedLufs.toFixed(1) + " LUFS"],
          ["True peak", d.loudness.truePeakDb != null ? d.loudness.truePeakDb.toFixed(1) + " dBTP" : null],
          ["Loudness range", d.loudness.rangeLu != null ? d.loudness.rangeLu.toFixed(1) + " LU" : null],
          ["Suggested track gain", (g >= 0 ? "+" : "") + g.toFixed(2) + " dB"],
        ]),
        { type: "text", content: "Measured, not written: nothing is changed in the file.", className: "plugin-hint" },
      ] });
    }
    var tagPairs = Object.keys(d.tags).map(function (k) { return [k, clip(d.tags[k])]; });
    if (tagPairs.length) children.push({ type: "section", title: "Tags", children: [grid(tagPairs)] });
    return children;
  }

  function render() {
    var counts = { queued: 0, running: 0, done: 0, error: 0 };
    state.jobs.forEach(function (j) { counts[j.status]++; });
    var active = counts.queued + counts.running;

    var tabs = {
      type: "tabs",
      tabs: [{ id: "info", label: "Media Info" }, { id: "jobs", label: "Convert jobs", count: active || undefined }],
      activeTab: state.tab,
      action: "switch-tab",
    };
    if (state.tab === "info") {
      api.ui.setViewData(VIEW, { type: "layout", direction: "vertical", children: [tabs].concat(mediaInfoChildren()) }, { scrollKey: "info" });
      api.ui.setBadge(VIEW, active > 0 ? { type: "count", value: active, variant: "accent" } : null);
      return;
    }

    var depLabel = !state.dep ? "Checking ffmpeg…" : (state.dep.installed ? "ffmpeg ready" : "ffmpeg not installed");
    var status = depLabel;
    if (state.jobs.length) {
      status += " · " + counts.queued + " queued · " + counts.running + " running · " + counts.done + " done · " + counts.error + " failed";
    }

    var children = [tabs];
    children.push({
      type: "toolbar",
      title: "Convert jobs",
      buttons: [{ label: "Clear finished", action: "clear-finished", variant: "secondary", disabled: counts.done + counts.error === 0 }],
      status: status,
      statusVariant: counts.error > 0 || (state.dep && !state.dep.installed) ? "error" : "default",
    });
    children.push({ type: "spacer" });

    if (!state.dep || !state.dep.installed) {
      children.push({
        type: "text",
        content: "Install ffmpeg to use Convert with FFmpeg. Right-click a local track → Convert to… once it's installed.",
        className: "plugin-hint",
      });
    } else if (state.jobs.length === 0) {
      children.push({
        type: "text",
        content: "Right-click a local track (or a multi-track selection) and choose Convert to… to queue a conversion here.",
        className: "plugin-hint",
      });
    } else {
      if (counts.done + counts.error > 0) {
        children.push({
          type: "text",
          content: "Converted files are written next to the originals. Go to Collections → Rescan to add them to your library.",
          className: "plugin-hint",
        });
      }
      var shown = state.jobs.slice().reverse();
      for (var i = 0; i < shown.length; i++) children.push(jobSection(shown[i]));
    }

    api.ui.setViewData(VIEW, { type: "layout", direction: "vertical", children: children }, { scrollKey: "jobs" });
    api.ui.setBadge(VIEW, active > 0 ? { type: "count", value: active, variant: "accent" } : null);
  }

  // ---- settings panel -------------------------------------------------------

  function persistPrefs() {
    api.storage.set("prefs", { autoDeleteOriginal: state.autoDeleteOriginal })
      .then(null, function (e) { console.error("ffmpeg-tools: persist prefs failed:", e); });
  }

  function renderSettings() {
    var depText = !state.dep
      ? "Checking…"
      : (state.dep.installed ? ("ffmpeg " + (state.dep.version || "") + " (" + (state.dep.origin || "system") + ")") : "Not installed");

    var depChildren = [{ type: "settings-row", label: "Status", description: depText, control: { type: "button", label: "Refresh", action: "refresh-dep" } }];
    if (!state.dep || !state.dep.installed) {
      depChildren.push({ type: "button", label: "Install ffmpeg", action: "install-ffmpeg", variant: "accent" });
    }

    api.ui.setViewData(SETTINGS_VIEW, {
      type: "layout",
      direction: "vertical",
      children: [
        { type: "section", title: "FFmpeg", children: depChildren },
        {
          type: "section",
          title: "Conversion",
          children: [
            {
              type: "settings-row",
              label: "Delete original after successful conversion",
              description: "Off by default. When on, a successful convert routes the original through the app's normal delete-with-confirmation flow.",
              control: { type: "toggle", checked: state.autoDeleteOriginal, action: "toggle-auto-delete" },
            },
          ],
        },
        {
          type: "section",
          title: "About & limitations",
          children: [
            {
              type: "text",
              content:
                "Converted files are written next to the original and are not automatically added to your library — rescan the collection from Collections to pick them up. " +
                "Media Info's loudness numbers are informational only: a plugin cannot safely rewrite tags into the original file, so nothing is ever written back. " +
                "Probe data comes from parsing plain ffmpeg output (there's no ffprobe access), so some fields may be missing on unusual files.",
              className: "plugin-hint",
            },
          ],
        },
      ],
    }, { scrollKey: "main" });
  }

  api.ui.onAction("toggle-auto-delete", function (d) {
    state.autoDeleteOriginal = !!(d && d.value);
    persistPrefs();
    renderSettings();
  });

  api.ui.onAction("refresh-dep", function () {
    api.system.getDependency("ffmpeg").then(function (dep) {
      state.dep = dep;
      renderSettings();
      render();
    });
  });

  api.ui.onAction("install-ffmpeg", function () {
    api.ui.requestAction("require-dependency", { name: "ffmpeg", feature: "FFmpeg Tools" });
  });

  // ---- analyze_audio assistant tool ------------------------------------------
  // Runs only when an assistant calls it — no background analysis, no prefetch.

  var CACHE_DIR = "audio-analysis";
  var CACHE_MAX_ENTRIES = 2000;
  var CACHE_MAX_AGE_MS = 180 * 24 * 3600 * 1000;
  var MAX_CONCURRENT_ANALYSES = 2;

  // Resolve the file to analyse. Never from a raw path in the input: only a
  // library track id or the playing track, so the tool can't be aimed at
  // arbitrary files.
  function resolveAnalysisTarget(trackId, toolName) {
    var tool = toolName || "analyze_audio";
    var p;
    if (trackId != null) {
      p = api.library.getTrackById(trackId).then(function (t) {
        if (!t) throw new Error("No library track with id " + trackId);
        return t;
      });
    } else {
      p = Promise.resolve(api.playback.getCurrentTrack()).then(function (cur) {
        if (!cur) throw new Error("Nothing is playing — pass trackId to analyse a library track");
        // The queue entry is metadata-only; its library row (when known) has
        // the file size + mtime the cache key needs.
        if (cur.libraryId == null) return cur;
        return api.library.getTrackById(cur.libraryId).then(function (row) { return row || cur; }, function () { return cur; });
      });
    }
    return p.then(function (t) {
      if (!isLocalUri(t.path)) {
        var scheme = t.path ? (String(t.path).split("://")[0] || "an unknown source") : "no file at all";
        throw new Error(tool + " needs a local file; this track plays from " + scheme);
      }
      return {
        track: { title: t.title, artistName: t.artist_name || null, path: t.path, durationSecs: t.duration_secs != null ? round2(t.duration_secs) : null },
        path: localPathFromUri(t.path),
        cacheKey: [t.path, t.file_size != null ? t.file_size : "?", t.modified_at != null ? t.modified_at : "?", ANALYSIS_VERSION].join("|"),
      };
    });
  }

  // -- cache: one JSON file per analysis + an LRU index ----------------------

  var cacheIndex = null; // promise of { entries: { [hash]: { key, lastUsed } } }
  var indexWrite = Promise.resolve();

  function loadCacheIndex() {
    if (!cacheIndex) {
      var p = [CACHE_DIR, "index.json"];
      cacheIndex = api.storage.files.exists(p).then(function (ok) {
        return ok ? api.storage.files.readJson(p) : null;
      }).then(function (idx) {
        return idx && idx.entries ? idx : { entries: {} };
      }, function (e) {
        console.error("ffmpeg-tools: analysis cache index unreadable, starting fresh:", e);
        return { entries: {} };
      });
    }
    return cacheIndex;
  }

  function saveCacheIndex(idx) {
    indexWrite = indexWrite.then(function () {
      return api.storage.files.writeJson([CACHE_DIR, "index.json"], idx);
    }).then(null, function (e) { console.error("ffmpeg-tools: saving analysis cache index failed:", e); });
    return indexWrite;
  }

  // Both cache paths start from a resolved promise so that any throw — even a
  // synchronous one from a missing storage API — lands in the caller's catch.
  function cacheGet(key) {
    var hash = hashKey(key);
    return Promise.resolve().then(loadCacheIndex).then(function (idx) {
      var meta = idx.entries[hash];
      if (!meta || meta.key !== key) return null;
      return api.storage.files.readJson([CACHE_DIR, hash + ".json"]).then(function (entry) {
        if (!entry || entry.key !== key || !entry.result) return null;
        meta.lastUsed = Date.now();
        saveCacheIndex(idx);
        return entry.result;
      }, function (e) {
        console.error("ffmpeg-tools: analysis cache entry unreadable:", e);
        delete idx.entries[hash];
        return null;
      });
    });
  }

  function cachePut(key, result) {
    var hash = hashKey(key);
    return Promise.resolve().then(function () {
      return api.storage.files.writeJson([CACHE_DIR, hash + ".json"], { key: key, result: result });
    }).then(function () {
      return loadCacheIndex();
    }).then(function (idx) {
      var now = Date.now();
      idx.entries[hash] = { key: key, lastUsed: now };
      var hashes = Object.keys(idx.entries);
      var evict = hashes.filter(function (h) { return now - idx.entries[h].lastUsed > CACHE_MAX_AGE_MS; });
      var live = hashes.filter(function (h) { return evict.indexOf(h) === -1; });
      if (live.length > CACHE_MAX_ENTRIES) {
        live.sort(function (a, b) { return idx.entries[a].lastUsed - idx.entries[b].lastUsed; });
        evict = evict.concat(live.slice(0, live.length - CACHE_MAX_ENTRIES));
      }
      evict.forEach(function (h) {
        delete idx.entries[h];
        api.storage.files.remove([CACHE_DIR, h + ".json"]).then(null, function (e) {
          console.error("ffmpeg-tools: evicting analysis cache entry failed:", e);
        });
      });
      return saveCacheIndex(idx);
    }).then(null, function (e) {
      // The analysis itself succeeded; a cache that can't be written only costs a re-run.
      console.error("ffmpeg-tools: caching analysis failed:", e);
    });
  }

  // -- concurrency: two analyses at a time, one per file ---------------------

  var slotsInUse = 0;
  var slotWaiters = [];
  var inFlight = {}; // cacheKey → promise of the full analysis

  function withSlot(fn) {
    return new Promise(function (resolve) {
      if (slotsInUse < MAX_CONCURRENT_ANALYSES) { slotsInUse++; resolve(); } else slotWaiters.push(resolve);
    }).then(function () {
      function release() {
        var next = slotWaiters.shift();
        if (next) next(); else slotsInUse--;
      }
      return Promise.resolve().then(fn).then(function (v) { release(); return v; }, function (e) { release(); throw e; });
    });
  }

  function runAnalysis(target) {
    var path = target.path;
    return api.system.exec("ffmpeg", ["-hide_banner", "-i", path]).then(function (res) {
      var stderr = String(res.stderr || "");
      if (/No such file or directory/i.test(stderr)) throw new Error("The file for this track is missing on disk: " + path);
      var probe = parseFfmpegProbe(stderr);
      if (!probe.format) throw new Error("ffmpeg could not read this file: " + lastStderrLine(stderr));
      if (!probe.streams.length) throw new Error("This file has no audio stream to analyse");
      var layout = probe.streams[0].channelLayout || "";
      var channels = /mono|^1 channel/i.test(layout) ? 1 : 2;
      var duration = probe.durationSecs || target.track.durationSecs || 0;
      var plan = analysisPlan(duration, channels);
      return api.system.exec("ffmpeg", buildAnalysisArgs(path, plan)).then(function (run) {
        if (run.exitCode !== 0) throw new Error("ffmpeg analysis failed: " + lastStderrLine(run.stderr));
        var parsed = parseAnalysisStderr(run.stderr);
        var full = analyzeParsed(parsed, {
          durationSecs: probe.durationSecs,
          envHz: plan.envHz,
          onsetHz: plan.onsetHz,
          channels: channels,
        });
        full.track = target.track;
        if (full.track.durationSecs == null) full.track.durationSecs = full.durationSecs;
        else full.track.durationSecs = full.durationSecs || full.track.durationSecs;
        delete full.durationSecs;
        return full;
      });
    });
  }

  function analyzeAudio(args) {
    var opts = validateAnalyzeArgs(args);
    return api.system.getDependency("ffmpeg").then(function (dep) {
      state.dep = dep;
      if (!dep || !dep.installed) throw new Error("ffmpeg is not installed — install it from Extensions → Tools");
      return resolveAnalysisTarget(opts.trackId);
    }).then(function (target) {
      return cacheGet(target.cacheKey).then(null, function (e) {
        console.error("ffmpeg-tools: analysis cache read failed:", e);
        return null;
      }).then(function (hit) {
        if (hit) return { full: hit, cached: true };
        var key = target.cacheKey;
        if (!inFlight[key]) {
          inFlight[key] = withSlot(function () { return runAnalysis(target); }).then(function (full) {
            delete inFlight[key];
            // Not awaited: the caller gets the answer now. If the host's 60 s
            // budget ran out mid-analysis, this write still lands, so a retry
            // is served from the cache.
            cachePut(key, full);
            return full;
          }, function (e) {
            delete inFlight[key];
            throw e;
          });
        }
        return inFlight[key].then(function (full) { return { full: full, cached: false }; });
      });
    }).then(function (r) {
      var out = shapeAnalysis(r.full, opts.include, opts.envelopeHz);
      out.cached = r.cached;
      return out;
    });
  }

  // media_info: the Media Info view's data, as JSON. No cache — it's asked for
  // explicitly, and a stale answer about a file is worse than a second decode.
  function mediaInfoTool(args) {
    var a = args || {};
    if (typeof a !== "object" || Array.isArray(a)) throw new Error("media_info takes an object: { trackId? }");
    if (a.trackId != null && (typeof a.trackId !== "number" || !isFinite(a.trackId) || a.trackId <= 0 || Math.floor(a.trackId) !== a.trackId)) {
      throw new Error("trackId must be a positive integer library track id (omit it for the playing track)");
    }
    return requireFfmpegForTool().then(function () {
      return resolveAnalysisTarget(a.trackId != null ? a.trackId : null, "media_info");
    }).then(function (target) {
      return probeMediaInfo(target.path).then(function (info) {
        return {
          track: { title: target.track.title, artistName: target.track.artistName, path: target.track.path },
          format: info.format,
          durationSecs: info.durationSecs,
          overallBitrateKbps: info.overallBitrateKbps,
          streams: info.streams,
          tags: info.tags,
          loudness: info.loudness,
        };
      });
    });
  }

  if (api.assistant) {
    api.assistant.onTool("analyze_audio", analyzeAudio);
    api.assistant.onTool("media_info", mediaInfoTool);
  }

  // ---- boot -----------------------------------------------------------------

  api.storage.get("prefs").then(function (p) {
    if (p) state.autoDeleteOriginal = !!p.autoDeleteOriginal;
    return api.system.getDependency("ffmpeg");
  }, function (e) {
    console.error("ffmpeg-tools: load prefs failed:", e);
    return api.system.getDependency("ffmpeg");
  }).then(function (dep) {
    state.dep = dep;
    if (!dep || !dep.installed) {
      api.ui.showNotification("FFmpeg Tools needs ffmpeg installed to convert tracks or show media info — see Settings > FFmpeg Tools.");
    }
    render();
    renderSettings();
  });
}

// ---- analyze_audio: musical structure from ffmpeg alone --------------------
//
// One ffmpeg decode, split (`asplit`) into named meters: each branch ends in an
// `ametadata@<name>=print` whose log prefix (`[ametadata@env @ 0x…]`) tells the
// branches apart in the shared stderr. Everything after that — regions,
// sections, tempo, beats — is plain JS over those per-frame RMS series.
// These live at module scope (not inside activate) so the tests can drive the
// parsers and the analysis directly; see `__test` at the bottom.

var ANALYSIS_VERSION = 1;
var DB_FLOOR = -90; // what `-inf` (digital silence) reads as
var SILENCE_DB = -50; // below this RMS a frame is silence, for region edges
var LONG_FILE_SECS = 1800; // past 30 min: 1 Hz envelope, no beat tracking
var MID_FILE_SECS = 480; // past 8 min: onsets at 50 Hz instead of 100 Hz (keeps stderr small)
var ENVELOPE_MAX_POINTS = 1200;
var MAX_BEATS = 20000;
var HIDDEN_GAP_SECS = 15; // a silence this long ends the song; music after it is another region
var MIN_SECTION_SECS = 8;
// Section features are weighted z-scores (see sectionFeatures): a boundary
// needs novelty of at least NOVELTY_MIN, and two sections whose mean feature
// vectors are closer than LABEL_MAX_DISTANCE share a label.
var NOVELTY_MIN = 0.35;
var LABEL_MAX_DISTANCE = 0.5;
var BEAT_MIN_CONFIDENCE = 0.3; // below this, report bpm but no beat grid
// Onset bands (8 kHz mono): kick, low-mid, mid, upper-mid, top. Log-energy
// flux summed over five bands separates a real pulse from noise far better
// than the full band does; band 1 (kick) also picks the downbeat.
var ONSET_BANDS = [
  "lowpass=f=150",
  "bandpass=f=300:width_type=o:w=1",
  "bandpass=f=700:width_type=o:w=1.2",
  "bandpass=f=1600:width_type=o:w=1.2",
  "highpass=f=2800",
];
var ANALYSIS_INCLUDES = ["sections", "envelope", "beats", "bands", "vocals"];
var DEFAULT_INCLUDES = ["sections", "envelope", "beats"];

function round2(x) { return Math.round(x * 100) / 100; }
function round1(x) { return Math.round(x * 10) / 10; }
function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

function dbValue(s) {
  var v = parseFloat(s); // "-inf" / "nan" parse to NaN
  if (!isFinite(v)) return DB_FLOOR;
  return v < DB_FLOOR ? DB_FLOOR : v;
}

// Power mean of dB values: averaging loudness has to happen on energy, or a
// silent second drags a loud one down far more than it should.
function dbMean(values, from, to) {
  var a = from == null ? 0 : Math.max(0, from);
  var b = to == null ? values.length : Math.min(values.length, to);
  if (b <= a) return DB_FLOOR;
  var sum = 0;
  for (var i = a; i < b; i++) sum += Math.pow(10, values[i] / 10);
  return Math.max(DB_FLOOR, 10 * Math.log10(sum / (b - a)));
}

function downsampleDb(values, factor) {
  if (factor <= 1) return values.slice();
  var out = [];
  for (var i = 0; i < values.length; i += factor) out.push(dbMean(values, i, i + factor));
  return out;
}

function percentile(values, p) {
  if (!values.length) return null;
  var s = values.slice().sort(function (a, b) { return a - b; });
  var idx = Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))));
  return s[idx];
}

function median(values) { return percentile(values, 0.5); }

// ---- the ffmpeg pass -------------------------------------------------------

function analysisPlan(durationSecs, channels) {
  var d = durationSecs || 0;
  var long = d > LONG_FILE_SECS;
  return {
    envHz: long ? 1 : 4,
    onsetHz: long ? 0 : (d > MID_FILE_SECS ? 50 : 100),
    vocals: channels !== 1,
    truePeak: !long, // true peak oversamples ~4x; on a 2 h concert that alone blows the budget
  };
}

function buildAnalysisArgs(path, plan) {
  var stats = "astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level";
  var key = "key=lavfi.astats.Overall.RMS_level";
  function meter(name, samples) {
    return "asetnsamples=n=" + samples + "," + stats + ",ametadata@" + name + "=print:" + key;
  }
  var MONO = "aformat=sample_fmts=flt:channel_layouts=mono";

  // 8 kHz mono feeds everything below 4 kHz. The high band can't live there —
  // 4 kHz is the Nyquist limit at 8 kHz — so it gets its own 16 kHz branch.
  var mono = [
    meter("env", 8000 / plan.envHz),
    "lowpass=f=200," + meter("low", 8000),
    "bandpass=f=1000:width_type=o:w=2," + meter("mid", 8000),
  ];
  if (plan.onsetHz) {
    // All onset bands ride one multichannel stream (amerge), so each frame
    // costs one `frame:` line plus a value per band, not a pair per band.
    mono.push("asplit=" + ONSET_BANDS.length + ONSET_BANDS.map(function (_, i) { return "[ob" + i + "]"; }).join(""));
  }

  var roots = ["s", "h", "e"];
  if (plan.vocals) roots.push("v");
  var g = [];
  g.push("[0:a:0]asplit=" + roots.length + roots.map(function (r) { return "[" + r + "]"; }).join(""));
  g.push("[s]aresample=8000," + MONO + ",silencedetect=noise=" + SILENCE_DB + "dB:d=1,asplit=" + mono.length +
    mono.map(function (_, i) { return "[m" + i + "]"; }).join(""));
  mono.forEach(function (chain, i) {
    // The first branch is the one real output (ffmpeg needs one); the rest sink.
    var feedsOnsets = plan.onsetHz && i === mono.length - 1;
    g.push("[m" + i + "]" + chain + (i === 0 ? "[out]" : (feedsOnsets ? "" : ",anullsink")));
  });
  if (plan.onsetHz) {
    ONSET_BANDS.forEach(function (f, i) { g.push("[ob" + i + "]" + f + "[oc" + i + "]"); });
    g.push(ONSET_BANDS.map(function (_, i) { return "[oc" + i + "]"; }).join("") +
      "amerge=inputs=" + ONSET_BANDS.length + ",asetnsamples=n=" + (8000 / plan.onsetHz) +
      ",astats=metadata=1:reset=1:measure_overall=none:measure_perchannel=RMS_level,ametadata@ons=print,anullsink");
  }
  g.push("[h]aresample=16000," + MONO + ",highpass=f=4000," + meter("high", 16000) + ",anullsink");
  g.push("[e]ebur128=peak=" + (plan.truePeak ? "true" : "sample") + ":framelog=quiet,anullsink");
  if (plan.vocals) {
    // Vocals are usually panned centre: compare mid (L+R) with side (L−R) in
    // the speech band. A hint, not lyric timing.
    var band = "bandpass=f=1850:width_type=h:w=3100,";
    g.push("[v]aresample=8000,aformat=sample_fmts=flt:channel_layouts=stereo,asplit=2[va][vb]");
    g.push("[va]pan=mono|c0=0.5*c0+0.5*c1," + band + meter("vmid", 8000) + ",anullsink");
    g.push("[vb]pan=mono|c0=0.5*c0-0.5*c1," + band + meter("vside", 8000) + ",anullsink");
  }
  return ["-hide_banner", "-nostats", "-vn", "-i", path, "-filter_complex", g.join(";"), "-map", "[out]", "-f", "null", "-"];
}

// Parses the analysis pass's stderr. Tolerant by design: a truncated run or an
// empty string yields whatever series got through, never a throw.
function parseAnalysisStderr(stderr) {
  var out = { series: {}, silences: [], openSilenceStart: null, loudness: null };
  var lines = String(stderr || "").split(/\r?\n/);
  var pending = {};
  var inSummary = false;
  var block = null;
  var I = null, lra = null, peak = null;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var m = /^\[ametadata@(\w+) @ [^\]]*\]\s*(.*)$/.exec(line);
    if (m) {
      var tag = m[1];
      var rest = m[2];
      var fm = /^frame:\s*\d+\s+pts:\s*\S+\s+pts_time:\s*(-?[\d.]+)/.exec(rest);
      if (fm) { pending[tag] = parseFloat(fm[1]); continue; }
      // Overall → series "<tag>"; channel N of a multichannel meter → "<tag>.N".
      var vm = /^lavfi\.astats\.(Overall|\d+)\.RMS_level=(.*)$/.exec(rest);
      if (vm && pending[tag] != null) {
        var name = vm[1] === "Overall" ? tag : tag + "." + vm[1];
        var s = out.series[name] || (out.series[name] = { t: [], v: [] });
        s.t.push(pending[tag]);
        s.v.push(dbValue(vm[2]));
      }
      continue;
    }
    var ss = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (ss) { out.openSilenceStart = Math.max(0, parseFloat(ss[1])); continue; }
    var se = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (se) {
      var start = out.openSilenceStart != null ? out.openSilenceStart : 0;
      out.silences.push({ start: start, end: Math.max(start, parseFloat(se[1])) });
      out.openSilenceStart = null;
      continue;
    }
    if (/ebur128.*Summary:\s*$/.test(line)) { inSummary = true; continue; }
    if (!inSummary) continue;
    if (/Integrated loudness:/.test(line)) block = "i";
    else if (/Loudness range:/.test(line)) block = "lra";
    else if (/(True|Sample) peak:/.test(line)) block = "peak";
    var im = /^\s*I:\s*(\S+)\s*LUFS/.exec(line);
    if (im && block === "i") I = parseFloat(im[1]);
    var lm = /^\s*LRA:\s*(\S+)\s*LU\b/.exec(line);
    if (lm && block === "lra") lra = parseFloat(lm[1]);
    var pm = /^\s*Peak:\s*(\S+)\s*dBFS/.exec(line);
    if (pm && block === "peak") peak = parseFloat(pm[1]);
  }

  if (I != null || lra != null || peak != null) {
    out.loudness = {
      integratedLufs: isFinite(I) ? round1(I) : null,
      peakDb: isFinite(peak) ? round1(peak) : null,
      rangeLu: isFinite(lra) ? round1(lra) : null,
    };
  }
  return out;
}

// ---- regions: where the music is -------------------------------------------

// Silences from silencedetect, complemented into music regions, with each
// region's edges then refined on the finest envelope available (silencedetect
// works in 1 s minimum stretches; the edges should be as sharp as the data).
function findMusicRegions(silences, openSilenceStart, durationSecs, fine) {
  var sil = silences.slice();
  if (openSilenceStart != null) sil.push({ start: openSilenceStart, end: durationSecs });
  sil.sort(function (a, b) { return a.start - b.start; });

  var regions = [];
  var cursor = 0;
  sil.forEach(function (s) {
    var a = Math.min(Math.max(0, s.start), durationSecs);
    var b = Math.min(Math.max(a, s.end), durationSecs);
    if (a > cursor) regions.push({ at: cursor, until: a });
    cursor = Math.max(cursor, b);
  });
  if (cursor < durationSecs) regions.push({ at: cursor, until: durationSecs });

  var refined = [];
  regions.forEach(function (r) {
    var a = r.at;
    var b = r.until;
    if (fine && fine.v.length) {
      var hz = fine.hz;
      var i0 = Math.max(0, Math.floor(a * hz));
      var i1 = Math.min(fine.v.length, Math.ceil(b * hz));
      var first = -1, last = -1;
      for (var i = i0; i < i1; i++) {
        if (fine.v[i] > SILENCE_DB) { if (first < 0) first = i; last = i; }
      }
      if (first < 0) return; // nothing above the floor after all
      a = Math.max(a, first / hz);
      b = Math.min(b, (last + 1) / hz);
    }
    if (b - a >= 1) refined.push({ at: a, until: b }); // a lone click in a long silence is not music
  });
  return refined;
}

// Regions closer than HIDDEN_GAP_SECS belong to one song (a dramatic pause is
// not the end); a later span after a long silence is a hidden track.
function groupSpans(regions) {
  var spans = [];
  regions.forEach(function (r) {
    var last = spans[spans.length - 1];
    if (last && r.at - last.until < HIDDEN_GAP_SECS) {
      last.until = r.until;
      last.regions.push(r);
    } else {
      spans.push({ at: r.at, until: r.until, regions: [r] });
    }
  });
  return spans;
}

// ---- tempo + beats -----------------------------------------------------------

// Onset strength: half-wave-rectified rise in log energy, summed across bands
// (a coarse spectral flux). The rise is taken over two frames, not one: a
// smoother curve, and on real mixes a markedly cleaner pulse.
function onsetStrength(bands, hz) {
  var n = Infinity;
  bands.forEach(function (b) { n = Math.min(n, b.length); });
  if (!isFinite(n) || n < 3) return [];
  var floor = -70;
  var o = new Array(n);
  for (var t = 0; t < n; t++) {
    var v = 0;
    for (var bi = 0; bi < bands.length; bi++) {
      // Before the first frames, compare against the floor: a hit right at 0 s counts.
      var prev = t >= 2 ? bands[bi][t - 2] : floor;
      var d = Math.max(floor, bands[bi][t]) - Math.max(floor, prev);
      if (d > 0) v += d;
    }
    o[t] = v;
  }
  // Subtract a local mean (~0.5 s) so a slow swell doesn't read as a pulse.
  var w = Math.max(1, Math.round(hz * 0.25));
  var pref = [0];
  for (var i = 0; i < n; i++) pref.push(pref[i] + o[i]);
  var hp = new Array(n);
  var sq = 0;
  for (var j = 0; j < n; j++) {
    var a = Math.max(0, j - w), b = Math.min(n, j + w + 1);
    var local = (pref[b] - pref[a]) / (b - a);
    hp[j] = Math.max(0, o[j] - local);
    sq += hp[j] * hp[j];
  }
  var std = Math.sqrt(sq / Math.max(1, n)) || 1;
  for (var k = 0; k < n; k++) hp[k] /= std;
  return hp;
}

// Autocorrelation tempo over 60–200 BPM with a log-Gaussian prior centred on
// 120 BPM (one octave wide), which is what settles half/double-time ties.
function estimateTempo(o, hz) {
  var n = o.length;
  var minLag = Math.max(2, Math.floor(60 * hz / 200));
  var maxLag = Math.min(n - 2, Math.ceil(60 * hz / 60));
  if (maxLag <= minLag + 2) return null;

  var mean = 0;
  for (var i = 0; i < n; i++) mean += o[i];
  mean /= n;
  var x = o.map(function (v) { return v - mean; });
  var r0 = 0;
  for (var j = 0; j < n; j++) r0 += x[j] * x[j];
  if (!(r0 > 0)) return null;

  var r = {};
  var s = {};
  for (var lag = minLag - 1; lag <= maxLag + 1; lag++) {
    var acc = 0;
    for (var t = lag; t < n; t++) acc += x[t] * x[t - lag];
    r[lag] = (acc / (n - lag)) / (r0 / n); // normalized autocorrelation, -1..1
    var bpm = 60 * hz / lag;
    var w = Math.exp(-0.5 * Math.pow(Math.log(bpm / 120) / Math.LN2, 2));
    s[lag] = r[lag] * w;
  }

  var best = minLag;
  for (var l = minLag; l <= maxLag; l++) if (s[l] > s[best]) best = l;
  // The prior can tip the pick a lag off the correlation's own peak: climb to it.
  while (best > minLag && r[best - 1] > r[best]) best--;
  while (best < maxLag && r[best + 1] > r[best]) best++;
  // Only a local maximum of r is a period; a range edge isn't.
  if (!(r[best] >= r[best - 1] && r[best] >= r[best + 1]) || r[best] <= 0) {
    return { period: best, bpm: 60 * hz / best, confidence: 0 };
  }
  var a = r[best - 1], b = r[best], c = r[best + 1];
  var denom = a - 2 * b + c;
  var delta = denom !== 0 ? 0.5 * (a - c) / denom : 0;
  if (Math.abs(delta) > 1) delta = 0;
  var period = best + delta;

  // A real pulse keeps repeating: correlation stays up at 2, 3 and 4 periods.
  // Noise (and the luck of picking the best of ~70 lags) doesn't.
  function corrAt(lag) {
    if (lag >= n - 1) return 0;
    var acc = 0;
    for (var t = lag; t < n; t++) acc += x[t] * x[t - lag];
    return (acc / (n - lag)) / (r0 / n);
  }
  var comb = 0;
  for (var k = 1; k <= 4; k++) {
    var c0 = Math.round(k * period);
    comb += Math.max(corrAt(c0 - 1), corrAt(c0), corrAt(c0 + 1));
  }
  comb /= 4;

  // Confidence: how far the peak rises above the typical lag (sharpness),
  // times how strongly the pulse repeats (comb: noise sits near 0.03, real
  // music measured 0.09–0.24, a click track ~0.8), then cut when the
  // double/half tempo is almost as plausible.
  var vals = [];
  for (var q = minLag; q <= maxLag; q++) vals.push(s[q]);
  var med = median(vals);
  var sharp = clamp01((s[best] - med) / Math.max(1e-9, Math.abs(s[best])));
  var strength = clamp01((comb - 0.04) / 0.15);
  var conf = sharp * strength;
  var rivals = [best * 2, best / 2, best * 1.5, best / 1.5];
  var worst = 0;
  rivals.forEach(function (lagF) {
    var L = Math.round(lagF);
    if (L < minLag || L > maxLag || L === best) return;
    var peakAt = Math.max(s[L - 1] || 0, s[L], s[L + 1] || 0);
    worst = Math.max(worst, peakAt / s[best]);
  });
  conf *= 1 - 0.5 * clamp01((worst - 0.6) / 0.4);
  return { period: period, bpm: 60 * hz / period, confidence: clamp01(conf) };
}

// Dynamic-programming beat tracking (Ellis 2007): each frame's score is its
// onset strength plus the best predecessor about one period back, penalised by
// how far that gap strays from the period (log-ratio squared).
function trackBeats(o, period, active) {
  var n = o.length;
  var alpha = 100;
  var score = new Array(n);
  var back = new Array(n);
  var lo = Math.round(period * 2);
  var hi = Math.max(1, Math.round(period / 2));
  for (var t = 0; t < n; t++) {
    var best = -Infinity, bi = -1;
    for (var p = Math.max(0, t - lo); p <= t - hi; p++) {
      var g = Math.log((t - p) / period);
      var v = score[p] - alpha * g * g;
      if (v > best) { best = v; bi = p; }
    }
    var local = active(t) ? o[t] : 0;
    if (bi >= 0 && best > 0) { score[t] = local + best; back[t] = bi; }
    else { score[t] = local; back[t] = -1; }
  }
  var end = -1;
  for (var e = n - 1; e >= 0; e--) if (active(e)) { end = e; break; }
  if (end < 0) return [];
  var last = end;
  for (var f = Math.max(0, end - Math.round(period)); f <= end; f++) if (score[f] > score[last]) last = f;
  var beats = [];
  for (var cur = last; cur >= 0; cur = back[cur]) beats.push(cur);
  beats.reverse();

  // Trim the grid's run-in/run-out where nothing is actually hitting.
  var rms = 0, cnt = 0;
  for (var k = 0; k < n; k++) if (active(k)) { rms += o[k] * o[k]; cnt++; }
  rms = Math.sqrt(rms / Math.max(1, cnt));
  function hit(b) {
    var m = 0;
    for (var d = -2; d <= 2; d++) if (b + d >= 0 && b + d < n) m = Math.max(m, o[b + d]);
    return m >= 0.5 * rms;
  }
  while (beats.length && (!active(beats[0]) || !hit(beats[0]))) beats.shift();
  while (beats.length && (!active(beats[beats.length - 1]) || !hit(beats[beats.length - 1]))) beats.pop();
  return beats.filter(function (b) { return active(b); });
}

// bands: the onset meter's per-band dB series, kick band first.
function analyzeBeats(bands, hz, regions) {
  if (!bands || !bands.length || !bands[0].length) return null;
  function active(t) {
    var sec = t / hz;
    for (var i = 0; i < regions.length; i++) if (sec >= regions[i].at && sec < regions[i].until) return true;
    return false;
  }
  var raw = onsetStrength(bands, hz);
  if (!raw.length) return null;
  var o = raw.map(function (v, t) { return active(t) ? v : 0; });
  var tempo = estimateTempo(o, hz);
  if (!tempo) return { bpm: null, confidence: 0, times: [], downbeats: [], downbeatConfidence: 0 };

  var frames = trackBeats(o, tempo.period, active);
  var bpm = tempo.bpm;
  if (frames.length >= 8) {
    // Least-squares slope of beat time vs index: the grid's own tempo, far
    // finer than one autocorrelation lag.
    var nb = frames.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (var i = 0; i < nb; i++) { var y = frames[i] / hz; sx += i; sy += y; sxx += i * i; sxy += i * y; }
    var slope = (nb * sxy - sx * sy) / (nb * sxx - sx * sx);
    if (slope > 0) {
      var refined = 60 / slope;
      if (Math.abs(refined - bpm) / bpm < 0.08) bpm = refined;
    }
  }
  var out = { bpm: round1(bpm), confidence: round2(tempo.confidence), times: [], downbeats: [], downbeatConfidence: 0 };
  if (tempo.confidence < BEAT_MIN_CONFIDENCE || frames.length < 4) return out;

  if (frames.length > MAX_BEATS) frames = frames.slice(0, MAX_BEATS);
  out.times = frames.map(function (f) { return round2(f / hz); });

  // Downbeats assume 4/4: the beat phase with the most kick (low-band onset).
  var lowOnset = onsetStrength([bands[0]], hz);
  var phase = [0, 0, 0, 0];
  frames.forEach(function (f, k) {
    var m = 0;
    for (var d = -2; d <= 2; d++) if (lowOnset[f + d] > m) m = lowOnset[f + d];
    phase[k % 4] += m;
  });
  var order = [0, 1, 2, 3].sort(function (a, b) { return phase[b] - phase[a]; });
  var bestPhase = order[0];
  out.downbeats = frames.filter(function (_, k) { return k % 4 === bestPhase; }).map(function (f) { return round2(f / hz); });
  out.downbeatConfidence = phase[bestPhase] > 0
    ? round2(Math.min(0.5, (phase[bestPhase] - phase[order[1]]) / phase[bestPhase]))
    : 0;
  return out;
}

// ---- sections ------------------------------------------------------------------

// Novelty at second t: the distance between the mean feature vector of the
// window before t and the window after it. Equivalent to correlating a
// checkerboard kernel along the diagonal of a self-similarity matrix (Foote)
// with a Euclidean distance, without building the matrix.
// Per-second feature rows for segmentation and labelling. Each column is
// standardised over the song's music seconds and scaled by sqrt(weight/Σw), so
// a plain Euclidean distance between rows is a weighted RMS of z-scores.
// Columns: loudness (double weight); band shape relative to loudness (the
// five onset bands when present, else low/mid; plus >4 kHz); rhythmic
// activity; centre-vs-side in the voice band. Shape is taken relative to
// loudness so that a level change counts once, not once per band.
function sectionFeatures(src, regions) {
  var env1 = src.env1;
  var n1 = env1.length;
  var cols = [];
  function at(arr, i) { return arr && i < arr.length ? arr[i] : DB_FLOOR; }
  function rel(arr) {
    var out = [];
    for (var i = 0; i < n1; i++) out.push(at(arr, i) - env1[i]);
    return out;
  }
  cols.push({ v: env1, w: 2, minSd: 1 });
  if (src.onsetBands.length) {
    src.onsetBands.forEach(function (b) { cols.push({ v: rel(downsampleDb(b, src.onsetHz)), w: 1, minSd: 1 }); });
    var on = onsetStrength(src.onsetBands, src.onsetHz);
    var act = [];
    for (var s = 0; s < n1; s++) {
      var acc = 0, cnt = 0;
      for (var t = s * src.onsetHz; t < (s + 1) * src.onsetHz && t < on.length; t++) { acc += on[t]; cnt++; }
      act.push(cnt ? acc / cnt : 0);
    }
    cols.push({ v: act, w: 1, minSd: 0.1 });
  } else {
    cols.push({ v: rel(src.low), w: 1, minSd: 1 });
    cols.push({ v: rel(src.mid), w: 1, minSd: 1 });
  }
  cols.push({ v: rel(src.high), w: 1, minSd: 1 });
  if (src.vmid && src.vside && src.vmid.length) {
    var vd = [];
    for (var vi = 0; vi < n1; vi++) vd.push(at(src.vmid, vi) - at(src.vside, vi));
    cols.push({ v: vd, w: 0.5, minSd: 1 });
  }

  var music = [];
  regions.forEach(function (r) {
    for (var i = Math.floor(r.at); i < Math.min(n1, Math.ceil(r.until)); i++) music.push(i);
  });
  var totalW = cols.reduce(function (a, c) { return a + c.w; }, 0);
  cols.forEach(function (c) {
    var m = 0;
    music.forEach(function (i) { m += c.v[i]; });
    m /= Math.max(1, music.length);
    var sd = 0;
    music.forEach(function (i) { sd += (c.v[i] - m) * (c.v[i] - m); });
    sd = Math.max(c.minSd, Math.sqrt(sd / Math.max(1, music.length)));
    c.mean = m;
    c.scale = Math.sqrt(c.w / totalW) / sd;
  });
  var rows = [];
  for (var r = 0; r < n1; r++) rows.push(cols.map(function (c) { return (c.v[r] - c.mean) * c.scale; }));
  return { rows: rows, dims: cols.length };
}

function noveltyCurve(features, from, to, half) {
  var nov = {};
  var dims = features[0] ? features[0].length : 0;
  for (var t = from + 3; t <= to - 3; t++) {
    var L = Math.min(half, t - from, to - t);
    var d2 = 0;
    for (var k = 0; k < dims; k++) {
      var a = 0, b = 0;
      for (var i = t - L; i < t; i++) a += features[i][k];
      for (var j = t; j < t + L; j++) b += features[j][k];
      var diff = a / L - b / L;
      d2 += diff * diff;
    }
    nov[t] = Math.sqrt(d2);
  }
  return nov;
}

function pickBoundaries(nov, from, to) {
  var keys = Object.keys(nov).map(Number);
  if (!keys.length) return [];
  var vals = keys.map(function (k) { return nov[k]; });
  var mean = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
  var sd = Math.sqrt(vals.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / vals.length);
  var threshold = Math.max(NOVELTY_MIN, mean + 0.5 * sd);
  var cands = keys.filter(function (t) {
    if (nov[t] < threshold) return false;
    for (var d = -4; d <= 4; d++) if (d !== 0 && nov[t + d] != null && nov[t + d] > nov[t]) return false;
    return true;
  }).sort(function (a, b) { return nov[b] - nov[a]; });
  var maxCount = Math.max(1, Math.round((to - from) / 20));
  var chosen = [];
  cands.forEach(function (t) {
    if (chosen.length >= maxCount) return;
    if (t - from < MIN_SECTION_SECS || to - t < MIN_SECTION_SECS) return;
    for (var i = 0; i < chosen.length; i++) if (Math.abs(chosen[i].t - t) < MIN_SECTION_SECS) return;
    chosen.push({ t: t, strength: nov[t] });
  });
  return chosen.sort(function (a, b) { return a.t - b.t; });
}

// Sharpen a 1 s boundary on the finer envelope: the frame inside ±1.5 s where
// the level changes most between the quarter-second either side.
function refineBoundary(t, env, envHz) {
  if (!env || envHz <= 1) return t;
  var w = Math.max(1, Math.round(envHz / 2));
  var i0 = Math.round((t - 1.5) * envHz), i1 = Math.round((t + 1.5) * envHz);
  var best = t, bestD = -1;
  for (var i = Math.max(w, i0); i <= Math.min(env.length - w, i1); i++) {
    var d = Math.abs(dbMean(env, i, i + w) - dbMean(env, i - w, i));
    if (d > bestD) { bestD = d; best = i / envHz; }
  }
  return best;
}

function snapToBeat(t, beats, period) {
  if (!beats || !beats.length) return t;
  var best = null;
  for (var i = 0; i < beats.length; i++) {
    if (best == null || Math.abs(beats[i] - t) < Math.abs(best - t)) best = beats[i];
    if (beats[i] > t + period) break;
  }
  return best != null && Math.abs(best - t) <= 0.6 * period ? best : t;
}

function slopeOf(values) {
  var n = values.length;
  if (n < 3) return 0;
  var sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (var i = 0; i < n; i++) { sx += i; sy += values[i]; sxx += i * i; sxy += i * values[i]; }
  var den = n * sxx - sx * sx;
  return den ? (n * sxy - sx * sy) / den : 0;
}

function classifyRegionSections(secs) {
  var n = secs.length;
  var weighted = [];
  secs.forEach(function (s) { for (var k = 0; k < Math.max(1, Math.round(s.until - s.at)); k++) weighted.push(s.mean); });
  var ref = median(weighted);
  secs.forEach(function (s, i) {
    var prev = i > 0 ? secs[i - 1] : null;
    var next = i < n - 1 ? secs[i + 1] : null;
    var len = s.until - s.at;
    var rise = s.slope * len;
    var kind = "main";
    var kindConf = 0.55;
    if (prev && next && len >= MIN_SECTION_SECS && s.mean <= Math.min(prev.mean, next.mean) - 6) {
      kind = "breakdown";
      kindConf = 0.6 + (Math.min(prev.mean, next.mean) - s.mean - 6) / 20;
    } else if (!prev && next && s.mean <= next.mean - 3) {
      kind = "intro";
      kindConf = 0.55 + (next.mean - s.mean - 3) / 15;
    } else if (!next && prev && (s.mean <= prev.mean - 3 || s.slope <= -0.3)) {
      kind = "outro";
      kindConf = 0.5 + Math.max(prev.mean - s.mean - 3, -s.slope * 10) / 15;
    } else if (s.slope >= 0.25 && rise >= 5 && (!next || next.mean >= s.mean)) {
      kind = "build";
      kindConf = 0.45 + (rise - 5) / 20;
    } else if (prev && s.mean >= ref + 2.5) {
      kind = "peak";
      kindConf = 0.45 + (s.mean - ref - 2.5) / 10;
    }
    s.kind = kind;
    s.kindConf = Math.min(0.9, kindConf);
  });
}

function assignLabels(secs) {
  var clusters = [];
  function letter(i) {
    var s = "";
    do { s = String.fromCharCode(65 + (i % 26)) + s; i = Math.floor(i / 26) - 1; } while (i >= 0);
    return s;
  }
  secs.forEach(function (s) {
    if (s.kind === "silence") return;
    var bestI = -1, bestD = Infinity;
    clusters.forEach(function (c, i) {
      var d2 = 0;
      for (var k = 0; k < c.length; k++) d2 += (c[k] - s.vec[k]) * (c[k] - s.vec[k]);
      var d = Math.sqrt(d2);
      if (d < bestD) { bestD = d; bestI = i; }
    });
    if (bestI >= 0 && bestD < LABEL_MAX_DISTANCE) { s.label = letter(bestI); return; }
    clusters.push(s.vec);
    s.label = letter(clusters.length - 1);
  });
}

// ---- the whole analysis --------------------------------------------------------

function seriesValues(parsed, name) {
  var s = parsed.series[name];
  return s ? s.v : null;
}

function analyzeParsed(parsed, info) {
  var envHz = info.envHz;
  var onsetHz = info.onsetHz;
  var env = seriesValues(parsed, "env") || [];
  var durationSecs = info.durationSecs || (env.length / envHz);
  if (!env.length) throw new Error("ffmpeg produced no audio to analyse");

  var env1 = downsampleDb(env, envHz);
  var low = seriesValues(parsed, "low") || [];
  var mid = seriesValues(parsed, "mid") || [];
  var high = seriesValues(parsed, "high") || [];
  var n1 = env1.length;
  function at(arr, i) { return i < arr.length ? arr[i] : DB_FLOOR; }

  // Onset bands; their power sum doubles as a fine (10–20 ms) envelope for
  // sharp music start/end edges.
  var onsetBands = [];
  if (onsetHz) {
    for (var bi = 1; bi <= ONSET_BANDS.length; bi++) {
      var bv = seriesValues(parsed, "ons." + bi);
      if (!bv || !bv.length) { onsetBands = []; break; }
      onsetBands.push(bv);
    }
  }
  var fine = { v: env, hz: envHz };
  if (onsetBands.length) {
    var nf = Infinity;
    onsetBands.forEach(function (b) { nf = Math.min(nf, b.length); });
    var fv = [];
    for (var ft = 0; ft < nf; ft++) {
      var pw = 0;
      for (var fb = 0; fb < onsetBands.length; fb++) pw += Math.pow(10, onsetBands[fb][ft] / 10);
      fv.push(Math.max(DB_FLOOR, 10 * Math.log10(pw)));
    }
    fine = { v: fv, hz: onsetHz };
  }

  var regions = findMusicRegions(parsed.silences, parsed.openSilenceStart, durationSecs, fine);
  var spans = groupSpans(regions);

  // Level 0..1 relative to this song: the quiet end is the 5th percentile of
  // its music seconds, the loud end its loudest smoothed second.
  var musicSecs = [];
  regions.forEach(function (r) { for (var i = Math.floor(r.at); i < Math.min(n1, Math.ceil(r.until)); i++) musicSecs.push(env1[i]); });
  var smooth = [];
  for (var si = 0; si < env.length; si++) smooth.push(dbMean(env, si - Math.floor(envHz / 2), si + Math.ceil(envHz / 2)));
  var loudest = DB_FLOOR;
  regions.forEach(function (r) {
    for (var i = Math.floor(r.at * envHz); i < Math.min(smooth.length, Math.ceil(r.until * envHz)); i++) if (smooth[i] > loudest) loudest = smooth[i];
  });
  var lo = musicSecs.length ? percentile(musicSecs, 0.05) - 3 : DB_FLOOR;
  var hi = Math.max(loudest, lo + 6);
  function level(db) { return round2(clamp01((db - lo) / (hi - lo))); }

  var beats = null;
  if (onsetBands.length) beats = analyzeBeats(onsetBands, onsetHz, regions);
  var beatPeriod = beats && beats.bpm ? 60 / beats.bpm : 0.5;
  var beatTimes = beats && beats.times.length ? beats.times : null;

  var features = sectionFeatures({
    env1: env1,
    low: low,
    mid: mid,
    high: high,
    onsetBands: onsetBands,
    onsetHz: onsetHz,
    vmid: seriesValues(parsed, "vmid"),
    vside: seriesValues(parsed, "vside"),
  }, regions);

  var sections = [];
  function pushSilence(a, b) {
    if (b - a <= 0) return;
    sections.push({ at: a, until: b, kind: "silence", level: 0, confidence: 0.95 });
  }
  var cursor = 0;
  regions.forEach(function (r, ri) {
    var a = r.at, b = r.until;
    // A leading/trailing stretch under a second isn't worth its own section.
    if (ri === 0 && a < 1) a = 0;
    if (ri === regions.length - 1 && durationSecs - b < 1) b = durationSecs;
    pushSilence(cursor, a);

    var from = Math.floor(a), to = Math.min(n1, Math.ceil(b));
    var bounds = to - from >= 2 * MIN_SECTION_SECS ? pickBoundaries(noveltyCurve(features.rows, from, to, 8), from, to) : [];
    var edges = [{ t: a, strength: null }];
    bounds.forEach(function (bd) {
      var t = snapToBeat(refineBoundary(bd.t, env, envHz), beatTimes, beatPeriod);
      if (t - edges[edges.length - 1].t >= MIN_SECTION_SECS * 0.75 && b - t >= MIN_SECTION_SECS * 0.75) edges.push({ t: t, strength: bd.strength });
    });
    edges.push({ t: b, strength: null });

    var secs = [];
    for (var k = 0; k + 1 < edges.length; k++) {
      var s0 = edges[k].t, s1 = edges[k + 1].t;
      var e0 = Math.floor(s0 * envHz), e1 = Math.max(e0 + 1, Math.ceil(s1 * envHz));
      var i0 = Math.floor(s0), i1 = Math.max(i0 + 1, Math.min(n1, Math.ceil(s1)));
      var vec = [];
      for (var d = 0; d < features.dims; d++) {
        var acc = 0;
        for (var fi = i0; fi < i1; fi++) acc += features.rows[fi][d];
        vec.push(acc / (i1 - i0));
      }
      function bconf(edge) { return edge.strength == null ? 0.9 : edge.strength / (edge.strength + 0.5); }
      secs.push({
        at: s0,
        until: s1,
        mean: dbMean(env, e0, e1),
        slope: slopeOf(env1.slice(i0, i1)),
        vec: vec,
        boundaryConf: (bconf(edges[k]) + bconf(edges[k + 1])) / 2,
      });
    }
    classifyRegionSections(secs);
    secs.forEach(function (s) { sections.push(s); });
    cursor = b;
  });
  pushSilence(cursor, durationSecs);
  if (!sections.length) pushSilence(0, durationSecs);
  assignLabels(sections);
  // Two neighbours that sound alike and play the same role are one section:
  // the boundary between them was noise in the novelty curve.
  sections = sections.reduce(function (acc, s) {
    var prev = acc[acc.length - 1];
    if (prev && s.kind !== "silence" && prev.kind === s.kind && prev.label === s.label && prev.until === s.at) {
      var lp = prev.until - prev.at, ls = s.until - s.at;
      prev.mean = 10 * Math.log10((lp * Math.pow(10, prev.mean / 10) + ls * Math.pow(10, s.mean / 10)) / (lp + ls));
      prev.boundaryConf = Math.min(prev.boundaryConf, s.boundaryConf);
      prev.until = s.until;
      return acc;
    }
    acc.push(s);
    return acc;
  }, []);

  var outSections = sections.map(function (s) {
    if (s.kind === "silence") return { at: round2(s.at), until: round2(s.until), kind: "silence", level: 0, confidence: 0.95 };
    return {
      at: round2(s.at),
      until: round2(s.until),
      kind: s.kind,
      level: level(s.mean),
      label: s.label,
      confidence: round2(clamp01(0.5 * s.boundaryConf + 0.5 * s.kindConf)),
    };
  });

  // Loud moments: maxima of the 1 s-smoothed envelope within 3 dB of the
  // loudest, at least 20 s apart, at most five.
  var cands = [];
  regions.forEach(function (r) {
    var a = Math.floor(r.at * envHz), b = Math.min(smooth.length, Math.ceil(r.until * envHz));
    for (var i = a; i < b; i++) {
      if (smooth[i] < loudest - 3) continue;
      if ((i > a && smooth[i - 1] > smooth[i]) || (i + 1 < b && smooth[i + 1] >= smooth[i])) continue;
      cands.push(i);
    }
  });
  cands.sort(function (x, y) { return smooth[y] - smooth[x]; });
  var peaks = [];
  cands.forEach(function (i) {
    if (peaks.length >= 5) return;
    for (var p = 0; p < peaks.length; p++) if (Math.abs(peaks[p] - i) < 20 * envHz) return;
    peaks.push(i);
  });
  peaks.sort(function (x, y) { return x - y; });

  var vocals = null;
  var vmid = seriesValues(parsed, "vmid");
  var vside = seriesValues(parsed, "vside");
  if (info.channels !== 1 && vmid && vside && vmid.length) {
    var nv = Math.min(vmid.length, vside.length);
    var diffs = [];
    for (var vi = 0; vi < nv; vi++) diffs.push(vmid[vi] - vside[vi]);
    // Identical channels (dual mono) leave no side signal to compare against.
    if (median(vside.slice(0, nv)) > median(vmid.slice(0, nv)) - 40) {
      var d20 = percentile(diffs, 0.2), d90 = percentile(diffs, 0.9);
      var span = Math.max(3, d90 - d20);
      vocals = {
        hz: 1,
        presence: diffs.map(function (d, i) {
          return at(env1, i) <= SILENCE_DB ? 0 : round2(clamp01((d - d20) / span));
        }),
        confidence: 0.3,
        note: "Centre-panned energy in the voice band. A hint at where singing is likely, not lyric timing.",
      };
    }
  }

  var songSpan = spans[0] || null;
  return {
    durationSecs: round2(durationSecs),
    musicStartSecs: songSpan ? round2(songSpan.at) : null,
    musicEndSecs: songSpan ? round2(songSpan.until) : null,
    musicRegions: spans.map(function (s) { return { at: round2(s.at), until: round2(s.until) }; }),
    loudness: parsed.loudness || { integratedLufs: null, peakDb: null, rangeLu: null },
    sections: outSections,
    peaks: peaks.map(function (i) { return { at: round2(i / envHz), level: level(smooth[i]) }; }),
    envelope: { hz: envHz, unit: "dBFS", values: env.map(round1) },
    beats: beats,
    bands: { hz: 1, unit: "dBFS", low: low.map(round1), mid: mid.map(round1), high: high.map(round1) },
    vocals: vocals,
  };
}

// Cut a full (cached) analysis down to what the caller asked for. The cache
// holds the envelope at its native rate; the requested rate and the point cap
// are applied here, so one cache entry serves every envelopeHz.
function shapeAnalysis(full, include, envelopeHz) {
  var want = {};
  include.forEach(function (k) { want[k] = true; });
  function capped(values, srcHz, wantHz) {
    var factor = Math.max(1, Math.round(srcHz / Math.min(wantHz, srcHz)));
    while (values.length / factor > ENVELOPE_MAX_POINTS) factor *= 2;
    return { hz: srcHz / factor, values: downsampleDb(values, factor).map(round1) };
  }
  var out = {
    track: full.track,
    musicStartSecs: full.musicStartSecs,
    musicEndSecs: full.musicEndSecs,
    musicRegions: full.musicRegions,
    loudness: full.loudness,
  };
  if (want.sections) {
    out.sections = full.sections;
    out.peaks = full.peaks;
  }
  if (want.envelope) {
    var e = capped(full.envelope.values, full.envelope.hz, envelopeHz);
    out.envelope = { hz: e.hz, unit: "dBFS", values: e.values };
  }
  if (want.beats) {
    out.beats = full.beats || { bpm: null, confidence: 0, times: [], downbeats: [], downbeatConfidence: 0, note: "Beat tracking is skipped for files longer than 30 minutes." };
  }
  if (want.bands) {
    var lo = capped(full.bands.low, 1, 1), mi = capped(full.bands.mid, 1, 1), hi = capped(full.bands.high, 1, 1);
    out.bands = { hz: lo.hz, unit: "dBFS", low: lo.values, mid: mi.values, high: hi.values };
  }
  if (want.vocals) out.vocals = full.vocals;
  out.analysisVersion = ANALYSIS_VERSION;
  return out;
}

function validateAnalyzeArgs(args) {
  var a = args || {};
  if (typeof a !== "object" || Array.isArray(a)) throw new Error("analyze_audio takes an object: { trackId?, include?, envelopeHz? }");
  var trackId = null;
  if (a.trackId != null) {
    if (typeof a.trackId !== "number" || !isFinite(a.trackId) || a.trackId <= 0 || Math.floor(a.trackId) !== a.trackId) {
      throw new Error("trackId must be a positive integer library track id (omit it to analyse the playing track)");
    }
    trackId = a.trackId;
  }
  var include = DEFAULT_INCLUDES.slice();
  if (a.include != null) {
    if (!Array.isArray(a.include) || !a.include.length) throw new Error("include must be a non-empty array of: " + ANALYSIS_INCLUDES.join(", "));
    a.include.forEach(function (k) {
      if (ANALYSIS_INCLUDES.indexOf(k) === -1) throw new Error("Unknown include \"" + k + "\" — use any of: " + ANALYSIS_INCLUDES.join(", "));
    });
    include = a.include.slice();
  }
  var envelopeHz = 1;
  if (a.envelopeHz != null) {
    if ([1, 2, 4].indexOf(a.envelopeHz) === -1) throw new Error("envelopeHz must be 1, 2 or 4");
    envelopeHz = a.envelopeHz;
  }
  return { trackId: trackId, include: include, envelopeHz: envelopeHz };
}

// FNV-1a, two seeds → 16 hex chars. Only names a cache file; the full key is
// stored inside the entry and compared on read, so a collision is a miss.
function hashKey(str) {
  function fnv(seed) {
    var h = seed >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return ("0000000" + h.toString(16)).slice(-8);
  }
  return fnv(2166136261) + fnv(0x9747b28c);
}

function deactivate() {
  // no-op: the host clears registered handlers/unsubscribers on deactivate.
}

return {
  activate: activate,
  deactivate: deactivate,
  // Pure helpers for the test suite; the host only reads activate/deactivate.
  __test: {
    ANALYSIS_VERSION: ANALYSIS_VERSION,
    analysisPlan: analysisPlan,
    buildAnalysisArgs: buildAnalysisArgs,
    parseAnalysisStderr: parseAnalysisStderr,
    analyzeParsed: analyzeParsed,
    shapeAnalysis: shapeAnalysis,
    validateAnalyzeArgs: validateAnalyzeArgs,
    estimateTempo: estimateTempo,
    onsetStrength: onsetStrength,
    hashKey: hashKey,
  },
};
