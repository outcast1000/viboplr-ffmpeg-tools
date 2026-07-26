// FFmpeg Tools — bulk-convert local tracks with ffmpeg, and surface a deep
// Media Info tab (container/stream/tag probe + loudness) on Track Detail.
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

  // ---- probe + loudness (Media Info tab) ----------------------------------

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

      var inputM = /^Input #\d+,\s*([^,]+),\s*from/.exec(line);
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

  // ffmpeg's loudnorm filter (single-pass analysis, no output file) prints a
  // real JSON object to stderr — unlike the -i banner, this part IS reliably
  // parseable.
  function parseLoudnorm(stderr) {
    var s = String(stderr || "");
    var start = s.lastIndexOf("{");
    var end = s.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) return null;
    var json;
    try { json = JSON.parse(s.slice(start, end + 1)); } catch (e) { return null; }
    var i = parseFloat(json.input_i);
    if (isNaN(i)) return null;
    var tp = parseFloat(json.input_tp);
    var gainDb = -18.0 - i; // ReplayGain 2.0 reference is -18 LUFS
    return {
      integratedLufs: i,
      truePeakDb: isNaN(tp) ? null : tp,
      suggestedGainLabel: (gainDb >= 0 ? "+" : "") + gainDb.toFixed(2) + " dB",
    };
  }

  var SKIP_TAG_KEYS = { title: 1, artist: 1, album: 1, album_artist: 1, albumartist: 1, date: 1, year: 1, track: 1, genre: 1 };

  function toKeyValueItems(probe, loud) {
    var items = [];
    items.push({ key: "Format", value: probe.format || "Unknown" });
    if (probe.durationSecs != null) items.push({ key: "Duration", value: fmtHms(probe.durationSecs) });
    if (probe.overallBitrateKbps != null) items.push({ key: "Overall bitrate", value: probe.overallBitrateKbps + " kb/s" });

    probe.streams.forEach(function (st, idx) {
      var prefix = probe.streams.length > 1 ? ("Stream " + (idx + 1) + " · ") : "";
      if (st.codec) items.push({ key: prefix + "Codec", value: st.codec });
      if (st.sampleRateHz) items.push({ key: prefix + "Sample rate", value: st.sampleRateHz + " Hz" });
      if (st.channelLayout) items.push({ key: prefix + "Channels", value: st.channelLayout });
      if (st.sampleFmt) items.push({ key: prefix + "Sample format", value: st.sampleFmt });
      if (st.bitrateKbps) items.push({ key: prefix + "Bitrate", value: st.bitrateKbps + " kb/s" });
    });

    var extraCount = 0;
    for (var key in probe.tags) {
      if (!probe.tags.hasOwnProperty(key)) continue;
      if (extraCount >= 8) break;
      if (SKIP_TAG_KEYS[key.toLowerCase()]) continue;
      items.push({ key: key, value: probe.tags[key] });
      extraCount++;
    }

    if (loud) {
      items.push({ key: "Measured loudness", value: loud.integratedLufs.toFixed(1) + " LUFS" });
      if (loud.truePeakDb != null) items.push({ key: "True peak", value: loud.truePeakDb.toFixed(1) + " dBTP" });
      items.push({ key: "Suggested track gain (informational)", value: loud.suggestedGainLabel });
    }

    return items;
  }

  api.informationTypes.onFetch("ffmpeg-probe", function (entity) {
    // Never prompt the install modal from a passive info fetch — only the
    // explicit Convert action does that. Silently hide the tab instead.
    return api.system.getDependency("ffmpeg").then(function (dep) {
      if (!dep || !dep.installed) return { status: "not_found" };
      return api.library.getTrackById(entity.id).then(function (track) {
        var path = track && isLocalUri(track.path) ? localPathFromUri(track.path) : null;
        if (!path) return { status: "not_found" };
        return Promise.all([
          api.system.exec("ffmpeg", ["-hide_banner", "-i", path]),
          api.system.exec("ffmpeg", ["-hide_banner", "-i", path, "-af", "loudnorm=I=-18:print_format=json", "-f", "null", "-"]),
        ]).then(function (results) {
          var probe = parseFfmpegProbe(results[0].stderr);
          if (!probe.format) return { status: "error" };
          var loud = parseLoudnorm(results[1].stderr);
          return { status: "ok", value: { items: toKeyValueItems(probe, loud) } };
        });
      });
    }).catch(function (e) {
      console.error("ffmpeg-tools: probe fetch failed:", e);
      return { status: "error" };
    });
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

  function render() {
    var counts = { queued: 0, running: 0, done: 0, error: 0 };
    state.jobs.forEach(function (j) { counts[j.status]++; });

    var depLabel = !state.dep ? "Checking ffmpeg…" : (state.dep.installed ? "ffmpeg ready" : "ffmpeg not installed");
    var status = depLabel;
    if (state.jobs.length) {
      status += " · " + counts.queued + " queued · " + counts.running + " running · " + counts.done + " done · " + counts.error + " failed";
    }

    var children = [];
    children.push({
      type: "toolbar",
      title: "FFmpeg Jobs",
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

    api.ui.setViewData(VIEW, { type: "layout", direction: "vertical", children: children }, { scrollKey: "main" });
    var active = counts.queued + counts.running;
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

function deactivate() {
  // no-op: the host clears registered handlers/unsubscribers on deactivate.
}

return { activate: activate, deactivate: deactivate };
