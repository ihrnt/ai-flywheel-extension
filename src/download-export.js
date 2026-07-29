// Shared pure helpers for Instagram media filenames and CSV snapshots.
(function (root) {
  "use strict";

  function safeFilePart(value, fallback) {
    var s = String(value || fallback || "").replace(/^@+/, "").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
    return s || fallback || "Instagram";
  }

  function mediaLeafName(asset) {
    var ext = asset.type === "video" ? "mp4" : "jpg";
    var match = String(asset.label || "").match(/(\d+)/);
    if (match) return "slide " + (+match[1]) + "." + ext;
    if (asset.type === "video") return "reel." + ext;
    if (/cover/i.test(asset.label || "")) return "cover." + ext;
    return "image." + ext;
  }

  function mediaFileName(handle, record, asset) {
    return "aiflywheel-downloads/" + safeFilePart(handle, "instagram") + "/" +
      safeFilePart(record && (record.code || record.pk), "post") + "/" + mediaLeafName(asset || {});
  }

  function exportTimestamp(d) {
    d = d || new Date();
    function part(n) { return ("0" + n).slice(-2); }
    return d.getFullYear() + "-" + part(d.getMonth() + 1) + "-" + part(d.getDate()) + " " +
      part(d.getHours()) + "-" + part(d.getMinutes()) + "-" + part(d.getSeconds());
  }

  function csvFileName(handle, d) {
    var cleanHandle = safeFilePart(handle, "Instagram");
    return "aiflywheel-downloads/" + cleanHandle + "/" + cleanHandle + " " + exportTimestamp(d) + ".csv";
  }

  function csvCell(v) {
    if (v == null) return "";
    var s = String(v);
    if (s.indexOf('"') !== -1) s = s.replace(/"/g, '""');
    return /[",\n\r]/.test(s) ? '"' + s + '"' : s;
  }

  var CSV_HEADER = ["Channel", "Post ID", "Shortcode", "Type", "Posted at", "Views", "Likes", "Comments", "URL", "Caption",
    "Paid partnership", "Collaborators", "Tagged accounts", "Hashtags", "Location", "Instagram product type",
    "Width", "Height", "Aspect ratio", "Carousel slide count", "Has audio", "Video duration (seconds)",
    "Accessibility description", "External link", "External link text", "Downloadable asset count"];

  function csvRow(record, channel, dateIso) {
    return [
      channel,
      record.pk,
      record.code || "",
      record.kind || "",
      dateIso(record.takenAt),
      record.plays == null ? "" : record.plays,
      record.likes == null ? "" : record.likes,
      record.comments == null ? "" : record.comments,
      record.url || (record.code ? "https://www.instagram.com/reel/" + record.code + "/" : ""),
      record.caption || "",
      record.paidPartnership ? "Yes" : "No",
      (record.collaborators || []).join(" | "),
      (record.taggedUsers || []).join(" | "),
      (record.hashtags || []).join(" | "),
      record.location || "",
      record.productType || "",
      record.width == null ? "" : record.width,
      record.height == null ? "" : record.height,
      record.width && record.height ? (+record.width / +record.height).toFixed(4) : "",
      record.carouselMediaCount == null ? "" : record.carouselMediaCount,
      record.hasAudio == null ? "" : (record.hasAudio ? "Yes" : "No"),
      record.videoDuration == null ? "" : record.videoDuration,
      record.accessibilityCaption || "",
      record.externalLink || "",
      record.externalLinkText || "",
      (record.assets || []).length
    ];
  }

  function csvText(records, channelForRecord, dateIso) {
    var rows = [CSV_HEADER].concat(records.map(function (record) {
      return csvRow(record, channelForRecord(record), dateIso);
    }));
    return rows.map(function (row) { return row.map(csvCell).join(","); }).join("\n");
  }

  var api = { safeFilePart: safeFilePart, mediaLeafName: mediaLeafName, mediaFileName: mediaFileName, exportTimestamp: exportTimestamp, csvFileName: csvFileName, CSV_HEADER: CSV_HEADER, csvRow: csvRow, csvText: csvText };
  root.AFWDownloadExport = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
