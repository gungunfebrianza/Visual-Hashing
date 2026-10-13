/*
 * Minimal 3MF writer (no dependencies).
 *
 *   VH3MF.build({ positions, indices }, { title, designer, description, metadata })
 *     -> Uint8Array (a .3mf file)
 *   VH3MF.zip([{ name, data }])  -> Uint8Array (store-only ZIP, UTF-8 names)
 *   VH3MF.crc32(bytes)           -> unsigned 32-bit CRC
 *
 * positions are millimetres (3MF keeps units, unlike STL). Degenerate triangles
 * (a repeated vertex) are dropped because the 3MF core spec forbids them.
 *
 * Plain script (no modules) so the page also works when opened from file://.
 */
(function (root) {
  "use strict";

  var CORE_NS = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";
  var VH_NS = "https://github.com/gungunfebrianza/Visual-Hashing";

  // ---------------------------------------------------------------- CRC-32

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ---------------------------------------------------------------- ZIP (store)

  function utf8(str) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
    var s = unescape(encodeURIComponent(str)), out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  // files: [{ name, data: Uint8Array | string }]. No compression keeps this tiny
  // and still valid; 3MF readers accept stored entries.
  function zip(files) {
    var DOS_TIME = 0, DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01, reproducible
    var entries = files.map(function (f) {
      var data = typeof f.data === "string" ? utf8(f.data) : f.data;
      return { name: utf8(f.name), data: data, crc: crc32(data) };
    });
    var size = 22;
    entries.forEach(function (e) {
      size += 30 + e.name.length + e.data.length + 46 + e.name.length;
    });
    var out = new Uint8Array(size);
    var dv = new DataView(out.buffer);
    var p = 0;

    function u16(v) { dv.setUint16(p, v, true); p += 2; }
    function u32(v) { dv.setUint32(p, v >>> 0, true); p += 4; }

    entries.forEach(function (e) {
      e.offset = p;
      u32(0x04034b50);
      u16(20); // version needed
      u16(0x0800); // UTF-8 names
      u16(0); // stored
      u16(DOS_TIME);
      u16(DOS_DATE);
      u32(e.crc);
      u32(e.data.length);
      u32(e.data.length);
      u16(e.name.length);
      u16(0);
      out.set(e.name, p); p += e.name.length;
      out.set(e.data, p); p += e.data.length;
    });

    var cdStart = p;
    entries.forEach(function (e) {
      u32(0x02014b50);
      u16(20); // made by
      u16(20); // needed
      u16(0x0800);
      u16(0);
      u16(DOS_TIME);
      u16(DOS_DATE);
      u32(e.crc);
      u32(e.data.length);
      u32(e.data.length);
      u16(e.name.length);
      u16(0); // extra
      u16(0); // comment
      u16(0); // disk
      u16(0); // internal attributes
      u32(0); // external attributes
      u32(e.offset);
      out.set(e.name, p); p += e.name.length;
    });
    var cdSize = p - cdStart;

    u32(0x06054b50);
    u16(0);
    u16(0);
    u16(entries.length);
    u16(entries.length);
    u32(cdSize);
    u32(cdStart);
    u16(0);
    return out;
  }

  // ---------------------------------------------------------------- 3MF

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")
      // Characters XML 1.0 cannot carry at all.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "");
  }

  function num(v) {
    var r = Math.round(v * 10000) / 10000;
    return r === 0 ? "0" : String(r);
  }

  function metaName(key) {
    // Custom metadata must be namespace qualified; keep it a valid XML name.
    var local = String(key).replace(/[^A-Za-z0-9_.-]/g, "_");
    if (!/^[A-Za-z_]/.test(local)) local = "_" + local;
    return "vh:" + local;
  }

  function modelXml(mesh, opts) {
    var pos = mesh.positions, idx = mesh.indices;
    var parts = [];
    parts.push(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<model unit="millimeter" xml:lang="en-US" xmlns="' + CORE_NS + '" xmlns:vh="' + VH_NS + '">\n'
    );
    var std = [["Title", opts.title], ["Designer", opts.designer], ["Description", opts.description], ["Application", opts.application]];
    std.forEach(function (m) {
      if (m[1] != null && m[1] !== "") parts.push(' <metadata name="' + m[0] + '">' + esc(m[1]) + "</metadata>\n");
    });
    var custom = opts.metadata || {};
    Object.keys(custom).forEach(function (k) {
      parts.push(' <metadata name="' + metaName(k) + '">' + esc(custom[k]) + "</metadata>\n");
    });

    parts.push(' <resources>\n  <object id="1" type="model"' + (opts.title ? ' name="' + esc(opts.title) + '"' : "") + ">\n   <mesh>\n    <vertices>\n");
    var chunk = [];
    for (var i = 0; i < pos.length; i += 3) {
      chunk.push('<vertex x="' + num(pos[i]) + '" y="' + num(pos[i + 1]) + '" z="' + num(pos[i + 2]) + '"/>');
      if (chunk.length === 4096) {
        parts.push(chunk.join("\n") + "\n");
        chunk = [];
      }
    }
    if (chunk.length) parts.push(chunk.join("\n") + "\n");
    parts.push("    </vertices>\n    <triangles>\n");

    chunk = [];
    var tris = 0;
    for (var t = 0; t + 2 < idx.length; t += 3) {
      var a = idx[t], b = idx[t + 1], c = idx[t + 2];
      if (a === b || b === c || a === c) continue;
      chunk.push('<triangle v1="' + a + '" v2="' + b + '" v3="' + c + '"/>');
      tris++;
      if (chunk.length === 4096) {
        parts.push(chunk.join("\n") + "\n");
        chunk = [];
      }
    }
    if (chunk.length) parts.push(chunk.join("\n") + "\n");
    parts.push('    </triangles>\n   </mesh>\n  </object>\n </resources>\n <build>\n  <item objectid="1"/>\n </build>\n</model>\n');
    return { xml: parts.join(""), triangles: tris };
  }

  function build(mesh, opts) {
    opts = opts || {};
    if (!mesh || !mesh.positions || !mesh.indices) throw new Error("VH3MF: mesh needs positions and indices");
    var model = modelXml(mesh, opts);
    var types =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
      "</Types>\n";
    var rels =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
      "</Relationships>\n";
    return zip([
      { name: "[Content_Types].xml", data: types },
      { name: "_rels/.rels", data: rels },
      { name: "3D/3dmodel.model", data: model.xml },
    ]);
  }

  var api = { build: build, zip: zip, crc32: crc32 };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VH3MF = api;
})(this);
